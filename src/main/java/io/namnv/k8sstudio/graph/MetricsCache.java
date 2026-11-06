package io.namnv.k8sstudio.graph;

import io.fabric8.kubernetes.api.model.GenericKubernetesResource;
import io.fabric8.kubernetes.api.model.Quantity;
import io.fabric8.kubernetes.api.model.metrics.v1beta1.NodeMetrics;
import io.fabric8.kubernetes.api.model.metrics.v1beta1.PodMetrics;
import io.fabric8.kubernetes.client.KubernetesClient;
import io.fabric8.kubernetes.client.dsl.base.ResourceDefinitionContext;
import io.namnv.k8sstudio.cluster.KubeConnection;
import jakarta.annotation.PreDestroy;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.math.BigDecimal;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentLinkedDeque;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

/**
 * Polls metrics.k8s.io (metrics-server) every 15s. If the API isn't installed, it backs off to once a minute
 * and the UI simply shows no usage numbers.
 */
@Component
public class MetricsCache {

    private static final Logger log = LoggerFactory.getLogger(MetricsCache.class);
    private static final ResourceDefinitionContext POD_METRICS = new ResourceDefinitionContext.Builder()
            .withGroup("metrics.k8s.io").withVersion("v1beta1").withKind("PodMetrics").withPlural("pods")
            .withNamespaced(true).build();

    /** cpu in millicores, memory in bytes. */
    public record Usage(long cpuMilli, long memBytes) {
        Usage plus(Usage o) { return new Usage(cpuMilli + o.cpuMilli, memBytes + o.memBytes); }
    }

    private final KubernetesClient client;
    private final ClusterCache cache;
    private final ScheduledExecutorService exec = Executors.newSingleThreadScheduledExecutor(r -> {
        Thread t = new Thread(r, "metrics-poller");
        t.setDaemon(true);
        return t;
    });
    private volatile Map<String, Usage> pods = Map.of();            // ns/name
    private volatile Map<String, Map<String, Usage>> containers = Map.of(); // ns/name -> container -> usage
    private volatile Map<String, Usage> nodes = Map.of();
    private volatile boolean available;
    /** last hour of samples (one per poll) — "pod:ns/name" or "node:name" -> [epochMillis, cpuMilli, memBytes] */
    private final Map<String, Deque<long[]>> history = new ConcurrentHashMap<>();
    private static final long HISTORY_MS = 60 * 60 * 1000;

    /** where the history is kept between restarts (one file per kube context) */
    private final java.nio.file.Path dataDir;
    /** context whose history is in memory (null = not loaded yet) */
    private volatile String loadedFor;

    public MetricsCache(KubernetesClient client, ClusterCache cache, KubeConnection connection,
                        @org.springframework.beans.factory.annotation.Value("${k8s-studio.data-dir:${user.home}/.k8s-studio}") String dataDir) {
        this.client = client;
        this.cache = cache;
        this.dataDir = java.nio.file.Path.of(dataDir);
        exec.schedule(this::poll, 3, TimeUnit.SECONDS);
        exec.scheduleAtFixedRate(this::save, 5, 5, TimeUnit.MINUTES);
        // numbers of the previous cluster must not show up on the new one; the next poll (≤ 60s) refills
        connection.onSwitch(() -> {
            exec.execute(() -> { save(); history.clear(); loadedFor = null; });
            pods = Map.of(); containers = Map.of(); nodes = Map.of(); available = false;
        });
    }

    // ------------------------------------------------------------------ persistence (survives restarts)

    private java.nio.file.Path file(String context) {
        return dataDir.resolve("metrics-" + context.replaceAll("[^A-Za-z0-9._-]", "_") + ".bin");
    }

    /** format: magic, version, key count, then per key: utf key, sample count, samples (t, cpu, mem) — gzip */
    private synchronized void save() {
        String ctx = loadedFor;
        if (ctx == null || history.isEmpty()) return;
        java.nio.file.Path f = file(ctx), tmp = f.resolveSibling(f.getFileName() + ".tmp");
        try {
            java.nio.file.Files.createDirectories(dataDir);
            try (var out = new java.io.DataOutputStream(new java.io.BufferedOutputStream(new java.util.zip.GZIPOutputStream(java.nio.file.Files.newOutputStream(tmp))))) {
                out.writeInt(0x4b53_4d31); // "KSM1"
                Map<String, List<long[]>> snap = new HashMap<>();
                history.forEach((k, d) -> snap.put(k, new ArrayList<>(d)));
                out.writeInt(snap.size());
                for (var e : snap.entrySet()) {
                    out.writeUTF(e.getKey());
                    out.writeInt(e.getValue().size());
                    for (long[] s : e.getValue()) { out.writeLong(s[0]); out.writeLong(s[1]); out.writeLong(s[2]); }
                }
            }
            java.nio.file.Files.move(tmp, f, java.nio.file.StandardCopyOption.REPLACE_EXISTING, java.nio.file.StandardCopyOption.ATOMIC_MOVE);
        } catch (IOException | RuntimeException e) {
            log.warn("could not save metrics history to {}: {}", f, e.toString());
        }
    }

    /** the history saved for this context, minus samples older than an hour */
    private synchronized void load(String ctx) {
        loadedFor = ctx;
        java.nio.file.Path f = file(ctx);
        if (!java.nio.file.Files.isRegularFile(f)) return;
        long cutoff = System.currentTimeMillis() - HISTORY_MS;
        int samples = 0;
        try (var in = new java.io.DataInputStream(new java.io.BufferedInputStream(new java.util.zip.GZIPInputStream(java.nio.file.Files.newInputStream(f))))) {
            if (in.readInt() != 0x4b53_4d31) return;
            int keys = in.readInt();
            for (int i = 0; i < keys; i++) {
                String key = in.readUTF();
                int n = in.readInt();
                Deque<long[]> d = new ConcurrentLinkedDeque<>();
                for (int j = 0; j < n; j++) {
                    long[] s = {in.readLong(), in.readLong(), in.readLong()};
                    if (s[0] >= cutoff) { d.addLast(s); samples++; }
                }
                if (!d.isEmpty()) history.merge(key, d, (cur, old) -> { old.addAll(cur); return old; });
            }
            log.info("metrics history restored for {}: {} series, {} samples", ctx, history.size(), samples);
        } catch (IOException | RuntimeException e) {
            log.warn("could not read metrics history {}: {}", f, e.toString());
        }
    }

    private void poll() {
        long next = 15;
        try {
            Map<String, Usage> p = new HashMap<>();
            Map<String, Map<String, Usage>> c = new HashMap<>();
            var ser = client.getKubernetesSerialization();
            for (GenericKubernetesResource r : client.genericKubernetesResources(POD_METRICS).inAnyNamespace().list().getItems()) {
                PodMetrics pm = ser.convertValue(r, PodMetrics.class);
                String key = pm.getMetadata().getNamespace() + "/" + pm.getMetadata().getName();
                Usage total = new Usage(0, 0);
                Map<String, Usage> per = new LinkedHashMap<>();
                for (var cm : pm.getContainers()) {
                    Usage u = usage(cm.getUsage());
                    per.put(cm.getName(), u);
                    total = total.plus(u);
                }
                p.put(key, total);
                c.put(key, per);
            }
            Map<String, Usage> n = new HashMap<>();
            for (NodeMetrics nm : client.top().nodes().metrics().getItems()) n.put(nm.getMetadata().getName(), usage(nm.getUsage()));
            long now = System.currentTimeMillis();
            String ctx = cache.context();
            if (ctx != null && !ctx.equals(loadedFor)) load(ctx);
            p.forEach((k, u) -> record("pod:" + k, now, u));
            c.forEach((k, per) -> per.forEach((ctr, u) -> record("ctr:" + k + "/" + ctr, now, u)));
            n.forEach((k, u) -> record("node:" + k, now, u));
            history.entrySet().removeIf(e -> e.getValue().isEmpty() || e.getValue().peekLast()[0] < now - HISTORY_MS);
            boolean changed = !p.equals(pods) || !n.equals(nodes);
            pods = p; containers = c; nodes = n;
            if (!available) log.info("metrics-server available ({} pods)", p.size());
            available = true;
            if (changed) cache.changed();
        } catch (RuntimeException e) {
            if (available) log.warn("metrics unavailable: {}", e.getMessage());
            boolean had = available;
            available = false;
            pods = Map.of(); containers = Map.of(); nodes = Map.of();
            if (had) cache.changed();
            next = 60;
        } finally {
            if (!exec.isShutdown()) exec.schedule(this::poll, next, TimeUnit.SECONDS);
        }
    }

    private void record(String key, long now, Usage u) {
        Deque<long[]> d = history.computeIfAbsent(key, k -> new ConcurrentLinkedDeque<>());
        d.addLast(new long[]{now, u.cpuMilli(), u.memBytes()});
        while (!d.isEmpty() && d.peekFirst()[0] < now - HISTORY_MS) d.pollFirst();
    }

    /** samples of a node / pod over the last hour */
    public List<long[]> history(String key) {
        Deque<long[]> d = history.get(key);
        return d == null ? List.of() : new ArrayList<>(d);
    }

    /** sum of several pods' samples, aligned on poll time */
    public List<long[]> sum(Collection<String> podKeys) {
        TreeMap<Long, long[]> acc = new TreeMap<>();
        for (String k : podKeys) for (long[] s : history("pod:" + k))
            acc.merge(s[0], new long[]{s[0], s[1], s[2]}, (a, b) -> new long[]{a[0], a[1] + b[1], a[2] + b[2]});
        return new ArrayList<>(acc.values());
    }

    private static Usage usage(Map<String, Quantity> m) {
        if (m == null) return new Usage(0, 0);
        long cpu = m.containsKey("cpu") ? Quantity.getAmountInBytes(m.get("cpu")).multiply(BigDecimal.valueOf(1000)).longValue() : 0;
        long mem = m.containsKey("memory") ? Quantity.getAmountInBytes(m.get("memory")).longValue() : 0;
        return new Usage(cpu, mem);
    }

    public boolean available() { return available; }
    public Usage pod(String ns, String name) { return pods.get(ns + "/" + name); }
    public Map<String, Usage> containers(String ns, String name) { return containers.getOrDefault(ns + "/" + name, Map.of()); }
    public Usage node(String name) { return nodes.get(name); }

    public static String cpu(long milli) { return milli >= 1000 ? String.format(Locale.ROOT, "%.2f", milli / 1000.0) : milli + "m"; }

    public static String mem(long bytes) {
        if (bytes >= 1L << 30) return String.format(Locale.ROOT, "%.1fGi", bytes / (double) (1L << 30));
        if (bytes >= 1L << 20) return (bytes >> 20) + "Mi";
        return (bytes >> 10) + "Ki";
    }

    @PreDestroy
    void stop() {
        exec.shutdownNow();
        save();
    }
}
