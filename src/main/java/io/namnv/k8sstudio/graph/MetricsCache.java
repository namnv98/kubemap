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

import java.math.BigDecimal;
import java.util.*;
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

    public MetricsCache(KubernetesClient client, ClusterCache cache, KubeConnection connection) {
        this.client = client;
        this.cache = cache;
        exec.schedule(this::poll, 3, TimeUnit.SECONDS);
        // numbers of the previous cluster must not show up on the new one; the next poll (≤ 60s) refills
        connection.onSwitch(() -> { pods = Map.of(); containers = Map.of(); nodes = Map.of(); available = false; });
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
    void stop() { exec.shutdownNow(); }
}
