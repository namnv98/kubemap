package io.namnv.k8sstudio.graph;

import org.springframework.stereotype.Component;

import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicLong;

/**
 * The latest built graph per namespace, rebuilt only after the cluster changed (any informer / metrics update bumps
 * the version). Shared by the SSE stream and the paged table / timeline APIs, so a page request costs a filter and a
 * sort over the cached graph instead of a full build (~0.4 s for a thousand objects).
 */
@Component
public class GraphSnapshots {

    private final GraphService graphService;
    private final AtomicLong version = new AtomicLong();
    private final Map<String, Snapshot> byNs = new ConcurrentHashMap<>();

    private record Snapshot(long version, Graph graph) {}

    public GraphSnapshots(GraphService graphService, ClusterCache cache) {
        this.graphService = graphService;
        cache.addListener(version::incrementAndGet);
    }

    /** "*" or blank = all namespaces */
    public Graph get(String namespace) {
        String ns = namespace == null || namespace.isBlank() ? "*" : namespace;
        long v = version.get();
        Snapshot s = byNs.get(ns);
        if (s != null && s.version == v) return s.graph;
        Graph g = graphService.build(ns);
        byNs.put(ns, new Snapshot(v, g));
        if (byNs.size() > 32) byNs.keySet().removeIf(k -> !k.equals(ns) && byNs.size() > 16); // namespaces nobody looks at any more
        return g;
    }

    public long version() { return version.get(); }
}
