package io.namnv.k8sstudio.portforward;

import io.fabric8.kubernetes.api.model.*;
import io.fabric8.kubernetes.client.KubernetesClient;
import io.fabric8.kubernetes.client.LocalPortForward;
import io.namnv.k8sstudio.cluster.KubeConnection;
import io.namnv.k8sstudio.graph.ClusterCache;
import jakarta.annotation.PreDestroy;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Port-forwards from 127.0.0.1 to a pod (directly, or picked from a Service / workload), like `kubectl port-forward`.
 * Forwards live as long as the app (or until stopped) and are closed when the cluster is switched.
 */
@Service
public class PortForwardService {

    private static final Logger log = LoggerFactory.getLogger(PortForwardService.class);
    private static final Set<String> WORKLOADS = Set.of("Deployment", "StatefulSet", "DaemonSet", "ReplicaSet", "Job");

    private final KubernetesClient client;
    private final ClusterCache cache;
    private final Map<String, Entry> forwards = new ConcurrentHashMap<>();

    public record PortOption(int port, String name, String protocol, String note) {}

    public record Forward(String id, String kind, String namespace, String name, String pod, int port, int targetPort, int localPort,
                          long started, boolean alive, String error) {}

    private record Entry(Forward f, LocalPortForward lpf) {}

    public PortForwardService(KubernetesClient client, ClusterCache cache, KubeConnection connection) {
        this.client = client;
        this.cache = cache;
        connection.onSwitch(this::stopAll);
    }

    /** ports one can forward to for this object */
    public List<PortOption> ports(String kind, String ns, String name) {
        HasMetadata o = cache.find(kind, ns, name).orElseThrow(() -> new IllegalArgumentException(kind + " " + name + " không tồn tại"));
        List<PortOption> out = new ArrayList<>();
        if (o instanceof io.fabric8.kubernetes.api.model.Service s) {
            for (ServicePort p : nzl(s.getSpec().getPorts()))
                if (!"UDP".equals(p.getProtocol())) out.add(new PortOption(p.getPort(), p.getName(), p.getProtocol(), "→ targetPort " + ios(p.getTargetPort())));
        } else {
            PodSpec spec = o instanceof Pod p ? p.getSpec() : template(o);
            if (spec != null) for (Container c : nzl(spec.getContainers())) for (ContainerPort p : nzl(c.getPorts()))
                if (!"UDP".equals(p.getProtocol())) out.add(new PortOption(p.getContainerPort(), p.getName(), p.getProtocol(), "container " + c.getName()));
        }
        return out;
    }

    public synchronized Forward start(String kind, String ns, String name, int port, int localPort) {
        HasMetadata o = cache.find(kind, ns, name).orElseThrow(() -> new IllegalArgumentException(kind + " " + name + " không tồn tại"));
        int target = port;
        Pod pod;
        if (o instanceof Pod p) pod = p;
        else if (o instanceof io.fabric8.kubernetes.api.model.Service s) {
            ServicePort sp = nzl(s.getSpec().getPorts()).stream().filter(x -> x.getPort() == port).findFirst()
                    .orElseThrow(() -> new IllegalArgumentException("Service " + name + " không có port " + port));
            Map<String, String> sel = s.getSpec().getSelector();
            if (sel == null || sel.isEmpty()) throw new IllegalArgumentException("Service không có selector — không biết forward tới pod nào");
            pod = readyPod(ns, p -> nzm(p.getMetadata().getLabels()).entrySet().containsAll(sel.entrySet()));
            target = targetPort(sp, pod);
        } else if (WORKLOADS.contains(kind)) {
            Set<String> owners = ownedChain(o);
            pod = readyPod(ns, p -> nzl(p.getMetadata().getOwnerReferences()).stream().anyMatch(r -> owners.contains(r.getUid())));
        } else throw new IllegalArgumentException("Không port-forward được tới " + kind);
        int local = localPort > 0 ? localPort : freePort();
        if (local < 1024) throw new IllegalArgumentException("Cổng local phải ≥ 1024");
        for (Entry e : forwards.values()) if (e.f().localPort() == local && e.lpf().isAlive()) throw new IllegalArgumentException("Cổng " + local + " đang được dùng bởi một forward khác");
        LocalPortForward lpf;
        try {
            lpf = client.pods().inNamespace(ns).withName(pod.getMetadata().getName()).portForward(target, InetAddress.getLoopbackAddress(), local);
        } catch (RuntimeException e) {
            throw new IllegalStateException("Không mở được port-forward: " + root(e));
        }
        String id = UUID.randomUUID().toString().substring(0, 8);
        Forward f = new Forward(id, kind, ns, name, pod.getMetadata().getName(), port, target, lpf.getLocalPort(), System.currentTimeMillis(), true, null);
        forwards.put(id, new Entry(f, lpf));
        log.info("port-forward {} 127.0.0.1:{} -> {}/{}:{}", id, lpf.getLocalPort(), ns, pod.getMetadata().getName(), target);
        return f;
    }

    public List<Forward> list() {
        List<Forward> out = new ArrayList<>();
        for (Entry e : forwards.values()) {
            String err = null;
            if (e.lpf().errorOccurred()) {
                var t = !e.lpf().getClientThrowables().isEmpty() ? e.lpf().getClientThrowables().iterator().next()
                        : !e.lpf().getServerThrowables().isEmpty() ? e.lpf().getServerThrowables().iterator().next() : null;
                err = t == null ? "lỗi" : root(t);
            }
            Forward f = e.f();
            out.add(new Forward(f.id(), f.kind(), f.namespace(), f.name(), f.pod(), f.port(), f.targetPort(), f.localPort(), f.started(), e.lpf().isAlive(), err));
        }
        out.sort(Comparator.comparingLong(Forward::started));
        return out;
    }

    public void stop(String id) {
        Entry e = forwards.remove(id);
        if (e == null) throw new IllegalArgumentException("Không có port-forward " + id);
        close(e);
    }

    @PreDestroy
    public void stopAll() {
        forwards.values().forEach(PortForwardService::close);
        forwards.clear();
    }

    private static void close(Entry e) {
        try { e.lpf().close(); } catch (IOException | RuntimeException ignored) {}
    }

    // ------------------------------------------------------------------ helpers

    private Pod readyPod(String ns, java.util.function.Predicate<Pod> match) {
        List<Pod> pods = cache.listOf(Pod.class, ns).stream().filter(match).toList();
        return pods.stream().filter(PortForwardService::ready).findFirst()
                .orElseGet(() -> pods.stream().filter(p -> p.getStatus() != null && "Running".equals(p.getStatus().getPhase())).findFirst()
                        .orElseThrow(() -> new IllegalArgumentException("Không có pod nào đang chạy để forward tới")));
    }

    private static boolean ready(Pod p) {
        return p.getStatus() != null && nzl(p.getStatus().getConditions()).stream().anyMatch(c -> "Ready".equals(c.getType()) && "True".equals(c.getStatus()));
    }

    /** the workload's uid plus the ReplicaSets it controls (pods of a Deployment are owned by its ReplicaSets) */
    private Set<String> ownedChain(HasMetadata o) {
        Set<String> uids = new HashSet<>(Set.of(o.getMetadata().getUid()));
        for (var rs : cache.listOf(io.fabric8.kubernetes.api.model.apps.ReplicaSet.class, o.getMetadata().getNamespace()))
            if (nzl(rs.getMetadata().getOwnerReferences()).stream().anyMatch(r -> uids.contains(r.getUid()))) uids.add(rs.getMetadata().getUid());
        return uids;
    }

    private static int targetPort(ServicePort sp, Pod pod) {
        IntOrString t = sp.getTargetPort();
        if (t == null) return sp.getPort();
        if (t.getIntVal() != null) return t.getIntVal();
        for (Container c : nzl(pod.getSpec().getContainers())) for (ContainerPort p : nzl(c.getPorts()))
            if (t.getStrVal().equals(p.getName())) return p.getContainerPort();
        throw new IllegalArgumentException("Pod " + pod.getMetadata().getName() + " không có port tên " + t.getStrVal());
    }

    private static PodSpec template(HasMetadata o) {
        PodTemplateSpec t = switch (o) {
            case io.fabric8.kubernetes.api.model.apps.Deployment d -> d.getSpec().getTemplate();
            case io.fabric8.kubernetes.api.model.apps.StatefulSet s -> s.getSpec().getTemplate();
            case io.fabric8.kubernetes.api.model.apps.DaemonSet d -> d.getSpec().getTemplate();
            case io.fabric8.kubernetes.api.model.apps.ReplicaSet r -> r.getSpec().getTemplate();
            case io.fabric8.kubernetes.api.model.batch.v1.Job j -> j.getSpec().getTemplate();
            default -> null;
        };
        return t == null ? null : t.getSpec();
    }

    private static int freePort() {
        try (ServerSocket s = new ServerSocket(0, 1, InetAddress.getLoopbackAddress())) { return s.getLocalPort(); }
        catch (IOException e) { throw new IllegalStateException("Không tìm được cổng trống"); }
    }

    private static String ios(IntOrString v) { return v == null ? "" : v.getIntVal() != null ? String.valueOf(v.getIntVal()) : v.getStrVal(); }
    private static String root(Throwable t) { while (t.getCause() != null && t.getCause() != t) t = t.getCause(); return String.valueOf(t.getMessage()); }
    private static <T> List<T> nzl(List<T> l) { return l == null ? List.of() : l; }
    private static <K, V> Map<K, V> nzm(Map<K, V> m) { return m == null ? Map.of() : m; }
}
