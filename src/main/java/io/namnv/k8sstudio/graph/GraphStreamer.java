package io.namnv.k8sstudio.graph;

import jakarta.annotation.PreDestroy;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Component;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.io.IOException;
import java.util.*;
import java.util.concurrent.*;

/**
 * Pushes graph snapshots to browsers over SSE.
 * Informer events only mark subscribers pending; a single thread checks every {@link #DEBOUNCE_MS}
 * (one build per subscribed namespace) and sends only to clients whose graph actually changed.
 * Live CPU / memory figures move a little on every metrics scrape: a change that touches only those is sent at most
 * every {@link #METRICS_MS}. Other changes go out as they come, but never closer together than {@link #minInterval}:
 * a big cluster in motion (hundreds of pods scaling) would otherwise push ~1 MB several times a second and freeze the
 * browser. Each subscriber has its own pending flag and earliest next send; the graph is only rebuilt for those due.
 */
@Component
public class GraphStreamer {

    private static final Logger log = LoggerFactory.getLogger(GraphStreamer.class);
    private static final long DEBOUNCE_MS = 300;
    private static final long HEARTBEAT_MS = 15_000;
    private static final long METRICS_MS = 15_000;
    /** node info keys filled from metrics-server; they don't make a change "structural" */
    private static final Set<String> METRIC_KEYS = Set.of("cpu", "memory", "cpuPct", "memPct");

    private final GraphSnapshots snapshots;
    private final ClusterCache cache;
    private final Map<SseEmitter, Subscriber> subscribers = new ConcurrentHashMap<>();
    private final ScheduledExecutorService exec = Executors.newSingleThreadScheduledExecutor(r -> {
        Thread t = new Thread(r, "graph-streamer");
        t.setDaemon(true);
        return t;
    });

    private static final class Subscriber {
        final String namespace;
        Graph lastGraph, lastShape;
        long lastSent, nextAllowed;
        volatile boolean pending = true;
        List<String> lastNamespaces;
        Subscriber(String namespace) { this.namespace = namespace; }
    }

    public GraphStreamer(GraphSnapshots snapshots, ClusterCache cache) {
        this.snapshots = snapshots;
        this.cache = cache;
        cache.addListener(() -> subscribers.values().forEach(s -> s.pending = true));
        exec.scheduleWithFixedDelay(this::flush, DEBOUNCE_MS, DEBOUNCE_MS, TimeUnit.MILLISECONDS);
        exec.scheduleWithFixedDelay(this::heartbeat, HEARTBEAT_MS, HEARTBEAT_MS, TimeUnit.MILLISECONDS);
    }

    public SseEmitter subscribe(String namespace) {
        SseEmitter emitter = new SseEmitter(0L); // no timeout
        Subscriber sub = new Subscriber(namespace);
        Runnable remove = () -> subscribers.remove(emitter);
        emitter.onCompletion(remove);
        emitter.onTimeout(remove);
        emitter.onError(t -> remove.run());
        sub.pending = false; // the initial snapshot below covers it
        subscribers.put(emitter, sub);
        exec.execute(() -> push(Map.of(emitter, sub), true)); // initial snapshot
        return emitter;
    }

    private void flush() {
        long now = System.currentTimeMillis();
        Map<SseEmitter, Subscriber> due = new HashMap<>();
        subscribers.forEach((e, sub) -> { if (sub.pending && now >= sub.nextAllowed) { sub.pending = false; due.put(e, sub); } });
        if (!due.isEmpty()) push(due, false);
    }

    /** spacing between two graph pushes to one browser, by how much was sent: ~4 ms per node, 0.3 s … 5 s */
    static long minInterval(int nodes) { return Math.max(DEBOUNCE_MS, Math.min(5_000, nodes * 4L)); }

    /**
     * What changed from {@code prev} to {@code cur}: upserted nodes, removed node ids, added / removed edges, plus the
     * small top-level fields. Null when a full snapshot is the better choice (other cluster, or most of it changed).
     */
    static Map<String, Object> delta(Graph prev, Graph cur) {
        if (!Objects.equals(prev.context(), cur.context())) return null;
        Map<String, Graph.Node> before = new HashMap<>();
        prev.nodes().forEach(n -> before.put(n.id(), n));
        List<Graph.Node> upserts = new ArrayList<>();
        Set<String> seen = new HashSet<>();
        for (Graph.Node n : cur.nodes()) {
            seen.add(n.id());
            if (!n.equals(before.get(n.id()))) upserts.add(n);
        }
        List<String> removed = before.keySet().stream().filter(id -> !seen.contains(id)).toList();
        Set<Graph.Edge> e0 = new HashSet<>(prev.edges()), e1 = new HashSet<>(cur.edges());
        List<Graph.Edge> addE = cur.edges().stream().filter(e -> !e0.contains(e)).toList();
        List<Graph.Edge> delE = prev.edges().stream().filter(e -> !e1.contains(e)).toList();
        if (upserts.size() + removed.size() > cur.nodes().size() / 2 + 50) return null;
        Map<String, Object> d = new LinkedHashMap<>();
        d.put("context", cur.context());
        d.put("warnings", cur.warnings());
        d.put("metrics", cur.metrics());
        d.put("nodes", upserts);
        d.put("removed", removed);
        d.put("edgesAdd", addE);
        d.put("edgesDel", delE);
        return d;
    }

    /** Runs on the streamer thread only. */
    private void push(Map<SseEmitter, Subscriber> targets, boolean force) {
        try {
            Map<String, Graph> byNs = new HashMap<>(), shapes = new HashMap<>();
            List<String> namespaces = cache.namespaceNames();
            targets.forEach((emitter, sub) -> {
                Graph g = byNs.computeIfAbsent(sub.namespace, snapshots::get);
                try {
                    if (force || !namespaces.equals(sub.lastNamespaces)) {
                        emitter.send(SseEmitter.event().name("namespaces").data(namespaces, MediaType.APPLICATION_JSON));
                        sub.lastNamespaces = namespaces;
                    }
                    if (force || !g.equals(sub.lastGraph)) {
                        Graph shape = shapes.computeIfAbsent(sub.namespace, ns -> withoutMetrics(g));
                        long now = System.currentTimeMillis();
                        // only live usage moved: keep it pending until METRICS_MS after the last send
                        if (!force && shape.equals(sub.lastShape) && now - sub.lastSent < METRICS_MS) {
                            sub.pending = true; sub.nextAllowed = sub.lastSent + METRICS_MS; return;
                        }
                        // after the first snapshot only what changed goes out (a few KB instead of the whole graph)
                        Map<String, Object> delta = force || sub.lastGraph == null ? null : delta(sub.lastGraph, g);
                        if (delta != null) emitter.send(SseEmitter.event().name("delta").data(delta, MediaType.APPLICATION_JSON));
                        else emitter.send(SseEmitter.event().name("graph").data(g, MediaType.APPLICATION_JSON));
                        sub.lastGraph = g;
                        sub.lastShape = shape;
                        sub.lastSent = now;
                        sub.nextAllowed = now + minInterval(delta != null ? ((List<?>) delta.get("nodes")).size() + ((List<?>) delta.get("removed")).size() : g.nodes().size());
                    }
                } catch (IOException | IllegalStateException e) {
                    subscribers.remove(emitter);
                }
            });
        } catch (RuntimeException e) {
            log.warn("graph push failed", e);
        }
    }

    /** the graph with the live usage figures taken out, to tell a real change from a metrics refresh */
    static Graph withoutMetrics(Graph g) {
        List<Graph.Node> nodes = new ArrayList<>(g.nodes().size());
        for (Graph.Node n : g.nodes()) {
            Map<String, String> info = n.info();
            if (info != null && info.keySet().stream().anyMatch(METRIC_KEYS::contains)) {
                info = new HashMap<>(info);
                info.keySet().removeAll(METRIC_KEYS);
            }
            nodes.add(new Graph.Node(n.id(), n.kind(), n.group(), n.name(), n.namespace(), n.status(), n.health(), n.reason(), n.missing(),
                    info, n.labels(), n.created()));
        }
        return new Graph(g.context(), g.warnings(), g.metrics(), nodes, g.edges());
    }

    /** SSE comment so proxies keep the connection open and dead clients get detected. */
    private void heartbeat() {
        subscribers.keySet().forEach(emitter -> {
            try {
                emitter.send(SseEmitter.event().comment("ping"));
            } catch (IOException | IllegalStateException e) {
                subscribers.remove(emitter);
            }
        });
    }

    @PreDestroy
    void stop() {
        exec.shutdownNow();
        subscribers.keySet().forEach(SseEmitter::complete);
    }
}
