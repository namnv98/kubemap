package io.namnv.k8sstudio.graph;

import io.fabric8.kubernetes.api.model.*;
import io.fabric8.kubernetes.api.model.apps.DaemonSet;
import io.fabric8.kubernetes.api.model.apps.Deployment;
import io.fabric8.kubernetes.api.model.apps.ReplicaSet;
import io.fabric8.kubernetes.api.model.apps.StatefulSet;
import io.fabric8.kubernetes.api.model.batch.v1.CronJob;
import io.fabric8.kubernetes.api.model.batch.v1.Job;
import io.fabric8.kubernetes.api.model.rbac.ClusterRole;
import io.fabric8.kubernetes.api.model.rbac.PolicyRule;
import io.fabric8.kubernetes.api.model.rbac.Role;
import org.springframework.stereotype.Service;

import java.util.*;

/**
 * On-demand details for the side panel: containers, conditions, events, annotations, Helm info, node capacity…
 * Secret values are never returned (only key names and sizes).
 */
@Service
public class DetailsService {

    private static final Set<String> DROP_ANNOTATIONS = Set.of("kubectl.kubernetes.io/last-applied-configuration");
    private static final int MAX_EVENTS = 25;

    private final ClusterCache cache;
    private final MetricsCache metrics;
    private final io.namnv.k8sstudio.actions.ManagedBy managedBy;

    public DetailsService(ClusterCache cache, MetricsCache metrics, io.namnv.k8sstudio.actions.ManagedBy managedBy) {
        this.cache = cache;
        this.metrics = metrics;
        this.managedBy = managedBy;
    }

    public Optional<Map<String, Object>> details(String kind, String ns, String name) {
        return cache.find(kind, ns == null || ns.isBlank() ? null : ns, name).map(this::describe);
    }

    private Map<String, Object> describe(HasMetadata o) {
        var m = o.getMetadata();
        Map<String, Object> d = new LinkedHashMap<>();
        d.put("kind", o.getKind());
        d.put("name", m.getName());
        d.put("namespace", m.getNamespace());
        d.put("uid", m.getUid());
        d.put("created", m.getCreationTimestamp());
        d.put("labels", m.getLabels() == null ? Map.of() : new TreeMap<>(m.getLabels()));
        d.put("annotations", annotations(m.getAnnotations()));
        d.put("helm", helm(m));
        d.put("manager", managedBy.detect(o).orElse(null));
        d.put("owners", nz(m.getOwnerReferences()).stream().map(r -> Map.of("kind", r.getKind(), "name", r.getName())).toList());
        d.put("conditions", conditions(o));

        switch (o) {
            case Pod p -> d.put("containers", podContainers(p));
            case Deployment x -> d.put("containers", templateContainers(x.getSpec().getTemplate()));
            case ReplicaSet x -> d.put("containers", templateContainers(x.getSpec().getTemplate()));
            case StatefulSet x -> d.put("containers", templateContainers(x.getSpec().getTemplate()));
            case DaemonSet x -> d.put("containers", templateContainers(x.getSpec().getTemplate()));
            case Job x -> d.put("containers", templateContainers(x.getSpec().getTemplate()));
            case CronJob x -> d.put("containers", templateContainers(x.getSpec().getJobTemplate().getSpec().getTemplate()));
            case io.fabric8.kubernetes.api.model.Node n -> d.put("node", node(n));
            case ConfigMap c -> d.put("data", keys(c.getData(), c.getBinaryData()));
            case Secret s -> d.put("data", keys(s.getData(), null)); // sizes only, never values
            case Role r -> d.put("rules", rules(r.getRules()));
            case ClusterRole r -> d.put("rules", rules(r.getRules()));
            default -> { }
        }
        d.put("events", cache.eventsFor(o).stream().limit(MAX_EVENTS).map(e -> {
            Map<String, Object> ev = new LinkedHashMap<>();
            ev.put("type", e.getType());
            ev.put("reason", e.getReason());
            ev.put("message", e.getMessage());
            ev.put("count", e.getCount() != null ? e.getCount() : e.getSeries() != null ? e.getSeries().getCount() : 1);
            ev.put("last", ClusterCache.eventTime(e));
            ev.put("source", e.getSource() != null && e.getSource().getComponent() != null ? e.getSource().getComponent()
                    : e.getReportingComponent());
            return ev;
        }).toList());
        return d;
    }

    // ------------------------------------------------------------------ pieces

    private static Map<String, String> annotations(Map<String, String> a) {
        Map<String, String> out = new TreeMap<>();
        nz(a).forEach((k, v) -> {
            if (DROP_ANNOTATIONS.contains(k)) return;
            out.put(k, v != null && v.length() > 400 ? v.substring(0, 400) + "… (" + v.length() + " ký tự)" : v);
        });
        return out;
    }

    private static Map<String, String> helm(ObjectMeta m) {
        String release = nz(m.getAnnotations()).get("meta.helm.sh/release-name");
        String managedBy = nz(m.getLabels()).get("app.kubernetes.io/managed-by");
        String chart = nz(m.getLabels()).get("helm.sh/chart");
        if (release == null && chart == null && !"Helm".equals(managedBy)) return null;
        Map<String, String> h = new LinkedHashMap<>();
        if (release != null) h.put("release", release);
        String relNs = nz(m.getAnnotations()).get("meta.helm.sh/release-namespace");
        if (relNs != null) h.put("namespace", relNs);
        if (chart != null) h.put("chart", chart);
        String instance = nz(m.getLabels()).get("app.kubernetes.io/instance");
        if (release == null && instance != null) h.put("release", instance);
        return h;
    }

    /** status.conditions of any object (built-in or custom), read generically. */
    @SuppressWarnings("unchecked")
    private List<Map<String, Object>> conditions(HasMetadata o) {
        Map<String, Object> obj = cache.client().getKubernetesSerialization().convertValue(o, Map.class);
        Object status = obj.get("status");
        if (!(status instanceof Map<?, ?> st) || !(st.get("conditions") instanceof List<?> list)) return List.of();
        List<Map<String, Object>> out = new ArrayList<>();
        for (Object c : list) {
            if (!(c instanceof Map<?, ?> cm)) continue;
            Map<String, Object> v = new LinkedHashMap<>();
            for (String k : List.of("type", "status", "reason", "message", "lastTransitionTime"))
                if (cm.get(k) != null) v.put(k, cm.get(k));
            out.add(v);
        }
        return out;
    }

    private List<Map<String, Object>> podContainers(Pod p) {
        Map<String, ContainerStatus> st = new HashMap<>();
        if (p.getStatus() != null) {
            nz(p.getStatus().getInitContainerStatuses()).forEach(s -> st.put(s.getName(), s));
            nz(p.getStatus().getContainerStatuses()).forEach(s -> st.put(s.getName(), s));
        }
        var usage = metrics.containers(p.getMetadata().getNamespace(), p.getMetadata().getName());
        List<Map<String, Object>> out = new ArrayList<>();
        List<Container> init = nz(p.getSpec().getInitContainers());
        for (Container c : init) out.add(container(c, true, st.get(c.getName()), usage.get(c.getName())));
        for (Container c : nz(p.getSpec().getContainers())) out.add(container(c, false, st.get(c.getName()), usage.get(c.getName())));
        return out;
    }

    private List<Map<String, Object>> templateContainers(PodTemplateSpec t) {
        if (t == null || t.getSpec() == null) return List.of();
        List<Map<String, Object>> out = new ArrayList<>();
        nz(t.getSpec().getInitContainers()).forEach(c -> out.add(container(c, true, null, null)));
        nz(t.getSpec().getContainers()).forEach(c -> out.add(container(c, false, null, null)));
        return out;
    }

    private static Map<String, Object> container(Container c, boolean init, ContainerStatus s, MetricsCache.Usage u) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("name", c.getName());
        m.put("init", init);
        m.put("image", c.getImage());
        m.put("ports", nz(c.getPorts()).stream().map(pt -> (pt.getName() != null ? pt.getName() + " " : "")
                + pt.getContainerPort() + "/" + Objects.requireNonNullElse(pt.getProtocol(), "TCP")).toList());
        if (c.getResources() != null) {
            m.put("requests", quantities(c.getResources().getRequests()));
            m.put("limits", quantities(c.getResources().getLimits()));
        }
        Map<String, String> probes = new LinkedHashMap<>();
        if (c.getLivenessProbe() != null) probes.put("liveness", probe(c.getLivenessProbe()));
        if (c.getReadinessProbe() != null) probes.put("readiness", probe(c.getReadinessProbe()));
        if (c.getStartupProbe() != null) probes.put("startup", probe(c.getStartupProbe()));
        m.put("probes", probes);
        if (s != null) {
            m.put("ready", Boolean.TRUE.equals(s.getReady()));
            m.put("restarts", s.getRestartCount() == null ? 0 : s.getRestartCount());
            var cs = s.getState();
            if (cs != null && cs.getRunning() != null) { m.put("state", "running"); m.put("since", cs.getRunning().getStartedAt()); }
            else if (cs != null && cs.getWaiting() != null) { m.put("state", "waiting"); m.put("reason", cs.getWaiting().getReason()); m.put("message", cs.getWaiting().getMessage()); }
            else if (cs != null && cs.getTerminated() != null) { m.put("state", "terminated"); m.put("reason", cs.getTerminated().getReason());
                m.put("exitCode", cs.getTerminated().getExitCode()); m.put("message", cs.getTerminated().getMessage()); }
            var last = s.getLastState() == null ? null : s.getLastState().getTerminated();
            if (last != null) {
                Map<String, Object> l = new LinkedHashMap<>();
                l.put("reason", last.getReason());
                l.put("exitCode", last.getExitCode());
                l.put("finishedAt", last.getFinishedAt());
                if (last.getMessage() != null) l.put("message", last.getMessage());
                m.put("lastState", l);
            }
        }
        if (u != null) m.put("usage", Map.of("cpu", MetricsCache.cpu(u.cpuMilli()), "memory", MetricsCache.mem(u.memBytes())));
        return m;
    }

    private static String probe(Probe p) {
        String what;
        if (p.getHttpGet() != null) what = "HTTP GET :" + intOrString(p.getHttpGet().getPort()) + Objects.requireNonNullElse(p.getHttpGet().getPath(), "/");
        else if (p.getTcpSocket() != null) what = "TCP :" + intOrString(p.getTcpSocket().getPort());
        else if (p.getGrpc() != null) what = "gRPC :" + p.getGrpc().getPort();
        else if (p.getExec() != null) what = "exec " + String.join(" ", nz(p.getExec().getCommand()));
        else what = "?";
        return what + " · mỗi " + Objects.requireNonNullElse(p.getPeriodSeconds(), 10) + "s, lỗi sau "
                + Objects.requireNonNullElse(p.getFailureThreshold(), 3) + " lần";
    }

    private static String intOrString(IntOrString v) {
        return v == null ? "?" : v.getIntVal() != null ? v.getIntVal().toString() : v.getStrVal();
    }

    private Map<String, Object> node(io.fabric8.kubernetes.api.model.Node n) {
        Map<String, Object> d = new LinkedHashMap<>();
        if (n.getStatus() != null) {
            d.put("capacity", quantities(n.getStatus().getCapacity()));
            d.put("allocatable", quantities(n.getStatus().getAllocatable()));
            var ni = n.getStatus().getNodeInfo();
            if (ni != null) d.put("system", Map.of("os", ni.getOsImage(), "kernel", ni.getKernelVersion(),
                    "runtime", ni.getContainerRuntimeVersion(), "arch", ni.getArchitecture(), "kubelet", ni.getKubeletVersion()));
        }
        d.put("taints", nz(n.getSpec().getTaints()).stream().map(t -> t.getKey() + (t.getValue() != null ? "=" + t.getValue() : "")
                + ":" + t.getEffect()).toList());
        d.put("unschedulable", Boolean.TRUE.equals(n.getSpec().getUnschedulable()));
        var u = metrics.node(n.getMetadata().getName());
        if (u != null) d.put("usage", Map.of("cpu", MetricsCache.cpu(u.cpuMilli()), "memory", MetricsCache.mem(u.memBytes())));
        long pods = cache.pods.getStore().list().stream().filter(p -> n.getMetadata().getName().equals(p.getSpec().getNodeName())).count();
        d.put("pods", pods);
        return d;
    }

    private static List<Map<String, Object>> keys(Map<String, String> data, Map<String, String> binary) {
        List<Map<String, Object>> out = new ArrayList<>();
        nz(data).forEach((k, v) -> out.add(Map.of("key", k, "size", v == null ? 0 : v.length())));
        nz(binary).forEach((k, v) -> out.add(Map.of("key", k, "size", v == null ? 0 : v.length(), "binary", true)));
        out.sort(Comparator.comparing(x -> (String) x.get("key")));
        return out;
    }

    private static List<Map<String, String>> rules(List<PolicyRule> rules) {
        return nz(rules).stream().map(r -> Map.of(
                "verbs", String.join(", ", nz(r.getVerbs())),
                "resources", String.join(", ", !nz(r.getResources()).isEmpty() ? r.getResources() : nz(r.getNonResourceURLs())),
                "apiGroups", nz(r.getApiGroups()).stream().map(g -> g.isEmpty() ? "core" : g).reduce((a, b) -> a + ", " + b).orElse("")
        )).toList();
    }

    private static Map<String, String> quantities(Map<String, Quantity> q) {
        Map<String, String> out = new TreeMap<>();
        nz(q).forEach((k, v) -> out.put(k, v.toString()));
        return out;
    }

    private static <T> List<T> nz(List<T> l) { return l == null ? List.of() : l; }
    private static <K, V> Map<K, V> nz(Map<K, V> m) { return m == null ? Map.of() : m; }
}
