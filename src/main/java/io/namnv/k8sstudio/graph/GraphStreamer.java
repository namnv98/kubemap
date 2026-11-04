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
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Pushes graph snapshots to browsers over SSE.
 * Informer events only set a dirty flag; a single thread rebuilds at most every {@link #DEBOUNCE_MS}
 * (one build per subscribed namespace) and sends only to clients whose graph actually changed.
 */
@Component
public class GraphStreamer {

    private static final Logger log = LoggerFactory.getLogger(GraphStreamer.class);
    private static final long DEBOUNCE_MS = 300;
    private static final long HEARTBEAT_MS = 15_000;

    private final GraphService graphService;
    private final ClusterCache cache;
    private final Map<SseEmitter, Subscriber> subscribers = new ConcurrentHashMap<>();
    private final AtomicBoolean dirty = new AtomicBoolean(true);
    private final ScheduledExecutorService exec = Executors.newSingleThreadScheduledExecutor(r -> {
        Thread t = new Thread(r, "graph-streamer");
        t.setDaemon(true);
        return t;
    });

    private static final class Subscriber {
        final String namespace;
        Graph lastGraph;
        List<String> lastNamespaces;
        Subscriber(String namespace) { this.namespace = namespace; }
    }

    public GraphStreamer(GraphService graphService, ClusterCache cache) {
        this.graphService = graphService;
        this.cache = cache;
        cache.addListener(() -> dirty.set(true));
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
        subscribers.put(emitter, sub);
        exec.execute(() -> push(Map.of(emitter, sub), true)); // initial snapshot
        return emitter;
    }

    private void flush() {
        if (!dirty.getAndSet(false) || subscribers.isEmpty()) return;
        push(subscribers, false);
    }

    /** Runs on the streamer thread only. */
    private void push(Map<SseEmitter, Subscriber> targets, boolean force) {
        try {
            Map<String, Graph> byNs = new HashMap<>();
            List<String> namespaces = cache.namespaceNames();
            targets.forEach((emitter, sub) -> {
                Graph g = byNs.computeIfAbsent(sub.namespace, graphService::build);
                try {
                    if (force || !namespaces.equals(sub.lastNamespaces)) {
                        emitter.send(SseEmitter.event().name("namespaces").data(namespaces, MediaType.APPLICATION_JSON));
                        sub.lastNamespaces = namespaces;
                    }
                    if (force || !g.equals(sub.lastGraph)) {
                        emitter.send(SseEmitter.event().name("graph").data(g, MediaType.APPLICATION_JSON));
                        sub.lastGraph = g;
                    }
                } catch (IOException | IllegalStateException e) {
                    subscribers.remove(emitter);
                }
            });
        } catch (RuntimeException e) {
            log.warn("graph push failed", e);
        }
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
