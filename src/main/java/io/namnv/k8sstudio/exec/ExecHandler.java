package io.namnv.k8sstudio.exec;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import io.fabric8.kubernetes.client.KubernetesClient;
import io.fabric8.kubernetes.client.dsl.ExecListener;
import io.fabric8.kubernetes.client.dsl.ExecWatch;
import io.namnv.k8sstudio.actions.AuditLog;
import io.namnv.k8sstudio.actions.WriteGuardFilter;
import io.namnv.k8sstudio.graph.ClusterCache;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.*;
import org.springframework.web.socket.handler.AbstractWebSocketHandler;
import org.springframework.web.socket.handler.ConcurrentWebSocketSessionDecorator;
import org.springframework.web.util.UriComponentsBuilder;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Interactive shell in a container over a WebSocket (/api/exec?namespace=&pod=&container=).
 * Browser → server: text frames {"t":"i","d":"<keys>"} (input) or {"t":"r","c":cols,"r":rows} (resize).
 * Server → browser: binary frames with raw terminal output.
 * Only same-origin pages may connect (Spring's default for WebSocket handshakes) and writes must be enabled.
 */
@Component
public class ExecHandler extends AbstractWebSocketHandler {

    private static final Logger log = LoggerFactory.getLogger(ExecHandler.class);
    /** bash if the image has it, otherwise sh */
    private static final String[] SHELL = {"sh", "-c", "if command -v bash >/dev/null 2>&1; then exec bash; else exec sh; fi"};
    private static final ObjectMapper JSON = new ObjectMapper();

    private final KubernetesClient client;
    private final ClusterCache cache;
    private final AuditLog audit;
    private final WriteGuardFilter guard;
    private final Map<String, ExecWatch> sessions = new ConcurrentHashMap<>();

    public ExecHandler(KubernetesClient client, ClusterCache cache, AuditLog audit, WriteGuardFilter guard) {
        this.client = client;
        this.cache = cache;
        this.audit = audit;
        this.guard = guard;
    }

    @Override
    public void afterConnectionEstablished(WebSocketSession raw) throws Exception {
        WebSocketSession session = new ConcurrentWebSocketSessionDecorator(raw, 10_000, 1 << 20);
        var q = UriComponentsBuilder.fromUri(raw.getUri()).build().getQueryParams();
        String ns = q.getFirst("namespace"), pod = q.getFirst("pod"), container = q.getFirst("container");
        if (!guard.writeEnabled()) { fail(session, "Exec bị tắt (k8s-studio.write.enabled=false)"); return; }
        if (ns == null || pod == null) { fail(session, "Thiếu namespace/pod"); return; }
        String target = "Pod " + ns + "/" + pod + (container != null ? " [" + container + "]" : "");
        try {
            var res = client.pods().inNamespace(ns).withName(pod);
            var c = container == null || container.isBlank() ? res.inContainer(res.get().getSpec().getContainers().get(0).getName()) : res.inContainer(container);
            ExecWatch w = c.redirectingInput().redirectingOutput().redirectingError().withTTY()
                    .usingListener(new ExecListener() {
                        @Override public void onFailure(Throwable t, Response r) { closeWith(session, "\r\n\u001b[31m[lỗi: " + t.getMessage() + "]\u001b[0m\r\n"); }
                        @Override public void onClose(int code, String reason) { closeWith(session, "\r\n\u001b[2m[phiên đã kết thúc]\u001b[0m\r\n"); }
                    })
                    .exec(SHELL);
            sessions.put(raw.getId(), w);
            pump(w.getOutput(), session);
            pump(w.getError(), session);
            audit.record(cache.context(), "exec", target, null, null);
        } catch (RuntimeException e) {
            audit.record(cache.context(), "exec", target, null, e);
            fail(session, "Không exec được: " + e.getMessage());
        }
    }

    private void pump(InputStream in, WebSocketSession session) {
        if (in == null) return;
        Thread t = new Thread(() -> {
            byte[] buf = new byte[8192];
            try {
                int n;
                while ((n = in.read(buf)) > 0 && session.isOpen()) session.sendMessage(new BinaryMessage(java.util.Arrays.copyOf(buf, n)));
            } catch (IOException ignored) {
                // stream closed with the session
            }
        }, "exec-pump");
        t.setDaemon(true);
        t.start();
    }

    @Override
    protected void handleTextMessage(WebSocketSession session, TextMessage message) throws Exception {
        ExecWatch w = sessions.get(session.getId());
        if (w == null) return;
        JsonNode m = JSON.readTree(message.getPayload());
        switch (m.path("t").asText()) {
            case "i" -> { w.getInput().write(m.path("d").asText().getBytes(StandardCharsets.UTF_8)); w.getInput().flush(); }
            case "r" -> w.resize(Math.max(10, m.path("c").asInt(80)), Math.max(5, m.path("r").asInt(24)));
            default -> { }
        }
    }

    @Override
    public void afterConnectionClosed(WebSocketSession session, CloseStatus status) {
        ExecWatch w = sessions.remove(session.getId());
        if (w != null) {
            try { w.close(); } catch (RuntimeException e) { log.debug("exec close: {}", e.getMessage()); }
        }
    }

    private void closeWith(WebSocketSession session, String text) {
        try {
            if (session.isOpen()) {
                session.sendMessage(new BinaryMessage(text.getBytes(StandardCharsets.UTF_8)));
                session.close(CloseStatus.NORMAL);
            }
        } catch (IOException ignored) { }
    }

    private void fail(WebSocketSession session, String msg) throws IOException {
        session.sendMessage(new BinaryMessage(("\u001b[31m" + msg + "\u001b[0m\r\n").getBytes(StandardCharsets.UTF_8)));
        session.close(CloseStatus.POLICY_VIOLATION);
    }
}
