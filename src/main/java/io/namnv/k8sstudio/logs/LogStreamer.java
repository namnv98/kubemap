package io.namnv.k8sstudio.logs;

import io.fabric8.kubernetes.api.model.Status;
import io.fabric8.kubernetes.client.KubernetesClient;
import io.fabric8.kubernetes.client.KubernetesClientException;
import io.fabric8.kubernetes.client.dsl.LogWatch;
import io.fabric8.kubernetes.client.dsl.PrettyLoggable;
import io.fabric8.kubernetes.client.dsl.BytesLimitTerminateTimeTailPrettyLoggable;
import io.fabric8.kubernetes.client.dsl.TimeTailPrettyLoggable;
import jakarta.annotation.PreDestroy;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Component;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.*;

/**
 * Streams container logs to the browser over SSE.
 * Events: "lines" (JSON array of strings, batched every {@link #FLUSH_MS}), "end" (stream finished, with reason),
 * "error" (message). The client must close its EventSource on end/error, otherwise it would auto-reconnect.
 */
@Component
public class LogStreamer {

    private static final Logger log = LoggerFactory.getLogger(LogStreamer.class);
    private static final long FLUSH_MS = 100;
    private static final int MAX_BATCH = 1000;
    private static final long HEARTBEAT_MS = 15_000;

    private final KubernetesClient client;
    private final ExecutorService readers = Executors.newCachedThreadPool(r -> {
        Thread t = new Thread(r, "log-reader");
        t.setDaemon(true);
        return t;
    });
    private final ScheduledExecutorService flusher = Executors.newSingleThreadScheduledExecutor(r -> {
        Thread t = new Thread(r, "log-flusher");
        t.setDaemon(true);
        return t;
    });
    private final Set<Stream> streams = ConcurrentHashMap.newKeySet();

    public record Options(String namespace, String pod, String container, int tail,
                          boolean timestamps, boolean previous, boolean follow) {}

    /** One open log stream = one browser connection. */
    private final class Stream {
        final SseEmitter emitter = new SseEmitter(0L);
        final Queue<Object> pending = new ConcurrentLinkedQueue<>(); // String (single pod) or {p, l[, sys]} (several pods)
        final List<LogWatch> watches = new java.util.concurrent.CopyOnWriteArrayList<>();
        volatile LogWatch watch;
        volatile boolean closed;
        volatile long lastSend = System.currentTimeMillis();

        /** Runs on the flusher thread only (SseEmitter.send must not be called concurrently). */
        void flush() {
            if (closed) return;
            try {
                while (!pending.isEmpty()) {
                    List<Object> batch = new ArrayList<>(Math.min(pending.size(), MAX_BATCH));
                    Object l;
                    while (batch.size() < MAX_BATCH && (l = pending.poll()) != null) batch.add(l);
                    emitter.send(SseEmitter.event().name("lines").data(batch, MediaType.APPLICATION_JSON));
                    lastSend = System.currentTimeMillis();
                }
                if (System.currentTimeMillis() - lastSend > HEARTBEAT_MS) {
                    emitter.send(SseEmitter.event().comment("ping"));
                    lastSend = System.currentTimeMillis();
                }
            } catch (IOException | IllegalStateException e) {
                close(); // browser went away
            }
        }

        /** Called from the reader thread; hands the final event to the flusher so ordering is kept. */
        void finish(String event, String message) {
            flusher.execute(() -> {
                flush();
                if (closed) return;
                try {
                    emitter.send(SseEmitter.event().name(event).data(Map.of("message", message), MediaType.APPLICATION_JSON));
                    emitter.complete();
                } catch (IOException | IllegalStateException ignored) {
                    // client already gone
                }
                close();
            });
        }

        void close() {
            if (closed) return;
            closed = true;
            streams.remove(this);
            LogWatch w = watch;
            if (w != null) {
                try { w.close(); } catch (RuntimeException ignored) { }
            }
            for (LogWatch x : watches) {
                try { x.close(); } catch (RuntimeException ignored) { }
            }
        }
    }

    public LogStreamer(KubernetesClient client) {
        this.client = client;
        flusher.scheduleWithFixedDelay(() -> streams.forEach(Stream::flush), FLUSH_MS, FLUSH_MS, TimeUnit.MILLISECONDS);
    }

    public SseEmitter open(Options o) {
        Stream s = new Stream();
        s.emitter.onCompletion(s::close);
        s.emitter.onTimeout(s::close);
        s.emitter.onError(t -> s.close());
        streams.add(s);
        readers.execute(() -> read(s, o));
        return s.emitter;
    }

    /**
     * Several pods in one stream (all pods of a workload). Lines are {p: pod index, l: line}; a pod that fails gets a
     * {sys: true} line instead of ending the whole stream. Ends when every pod's log has ended.
     */
    public SseEmitter openMulti(String ns, List<String> pods, String container, int tail, boolean timestamps, boolean previous, boolean follow) {
        Stream s = new Stream();
        s.emitter.onCompletion(s::close);
        s.emitter.onTimeout(s::close);
        s.emitter.onError(t -> s.close());
        streams.add(s);
        java.util.concurrent.atomic.AtomicInteger left = new java.util.concurrent.atomic.AtomicInteger(pods.size());
        for (int i = 0; i < pods.size(); i++) {
            int idx = i;
            Options o = new Options(ns, pods.get(i), container, tail, timestamps, previous, follow);
            readers.execute(() -> {
                readOne(s, o, idx);
                if (left.decrementAndGet() == 0 && !s.closed) s.finish("end", previous ? "Hết log của lần chạy trước" : "Tất cả pod đã dừng ghi log");
            });
        }
        return s.emitter;
    }

    private void readOne(Stream s, Options o, int idx) {
        try {
            PrettyLoggable loggable = loggable(o);
            if (o.follow() && !o.previous()) {
                LogWatch w = loggable.watchLog();
                s.watches.add(w);
                try (BufferedReader r = new BufferedReader(new InputStreamReader(w.getOutput(), StandardCharsets.UTF_8))) {
                    String line;
                    boolean first = true;
                    while (!s.closed && (line = r.readLine()) != null) {
                        if (first) {
                            first = false;
                            String err = statusError(line);
                            if (err != null) { s.pending.add(Map.of("p", idx, "l", err, "sys", true)); return; }
                        }
                        s.pending.add(Map.of("p", idx, "l", line));
                    }
                }
            } else {
                String text = loggable.getLog();
                if (text != null) text.lines().forEach(l -> s.pending.add(Map.of("p", idx, "l", l)));
            }
        } catch (KubernetesClientException e) {
            s.pending.add(Map.of("p", idx, "l", describe(e), "sys", true));
        } catch (IOException | RuntimeException e) {
            if (!s.closed) s.pending.add(Map.of("p", idx, "l", String.valueOf(e.getMessage()), "sys", true));
        }
    }

    private void read(Stream s, Options o) {
        try {
            PrettyLoggable loggable = loggable(o);
            if (o.follow() && !o.previous()) {
                LogWatch w = loggable.watchLog();
                s.watch = w;
                try (BufferedReader r = new BufferedReader(new InputStreamReader(w.getOutput(), StandardCharsets.UTF_8))) {
                    String line;
                    boolean first = true;
                    while (!s.closed && (line = r.readLine()) != null) {
                        if (first) {
                            first = false;
                            // the API server sends errors (e.g. container waiting to start) as a Status body in the stream
                            String err = statusError(line);
                            if (err != null) {
                                s.finish("error", err);
                                return;
                            }
                        }
                        s.pending.add(line);
                    }
                }
                s.finish("end", "Container đã dừng hoặc kết nối log bị đóng");
            } else {
                String text = loggable.getLog();
                if (text != null && !text.isEmpty()) {
                    text.lines().forEach(s.pending::add);
                }
                s.finish("end", o.previous() ? "Hết log của lần chạy trước" : "Hết log");
            }
        } catch (KubernetesClientException e) {
            s.finish("error", describe(e));
        } catch (IOException e) {
            if (!s.closed) s.finish("end", "Kết nối log bị đóng: " + e.getMessage());
        } catch (RuntimeException e) {
            log.warn("log stream {}/{} failed", o.namespace(), o.pod(), e);
            s.finish("error", String.valueOf(e.getMessage()));
        }
    }

    private PrettyLoggable loggable(Options o) {
        var container = client.pods().inNamespace(o.namespace()).withName(o.pod()).inContainer(o.container());
        BytesLimitTerminateTimeTailPrettyLoggable a = o.timestamps() ? container.usingTimestamps() : container;
        TimeTailPrettyLoggable b = o.previous() ? a.terminated() : a;
        return o.tail() > 0 ? b.tailingLines(o.tail()) : b;
    }

    private String statusError(String line) {
        if (!line.startsWith("{\"kind\":\"Status\"")) return null;
        try {
            Status st = client.getKubernetesSerialization().unmarshal(line, Status.class);
            return "Failure".equals(st.getStatus()) ? st.getMessage() : null;
        } catch (RuntimeException e) {
            return null;
        }
    }

    /** API server returns useful text (e.g. 'container "x" is waiting to start: ImagePullBackOff'); surface it. */
    private static String describe(KubernetesClientException e) {
        if (e.getStatus() != null && e.getStatus().getMessage() != null) return e.getStatus().getMessage();
        Throwable c = e.getCause();
        return c != null && c.getMessage() != null ? c.getMessage() : String.valueOf(e.getMessage());
    }

    @PreDestroy
    void stop() {
        streams.forEach(Stream::close);
        flusher.shutdownNow();
        readers.shutdownNow();
    }
}
