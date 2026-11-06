package io.namnv.k8sstudio.remote;

import io.namnv.k8sstudio.portforward.PortForwardService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.http.server.ServerHttpRequest;
import org.springframework.http.server.ServerHttpResponse;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.*;
import org.springframework.web.socket.handler.BinaryWebSocketHandler;
import org.springframework.web.socket.server.HandshakeInterceptor;
import org.springframework.web.util.UriComponentsBuilder;

import java.io.IOException;
import java.io.InputStream;
import java.net.InetAddress;
import java.net.Socket;
import java.nio.ByteBuffer;
import java.util.Arrays;
import java.util.Map;
import java.util.OptionalInt;

/**
 * TCP over WebSocket: {@code /tunnel/{id}} (remote-access port only). Each WebSocket is one TCP connection to the
 * forward's loopback port; binary frames carry the bytes both ways. Works for any TCP protocol (Postgres, Redis,
 * MySQL, gRPC…) — the client side (websocat, or connect.java) listens on the user's machine and opens one WebSocket
 * per accepted connection. The forward's token comes in the X-K8s-Studio-Token header (or ?token=).
 * Browsers can't use it cross-site: Spring only accepts handshakes without Origin or from the same origin.
 */
@Component
public class TunnelHandler extends BinaryWebSocketHandler implements HandshakeInterceptor {

    private static final Logger log = LoggerFactory.getLogger(TunnelHandler.class);
    public static final String TOKEN_HEADER = "X-K8s-Studio-Token";
    private static final String PORT = "pf.port", SOCKET = "pf.socket", ID = "pf.id";

    private final PortForwardService forwards;

    public TunnelHandler(PortForwardService forwards) {
        this.forwards = forwards;
    }

    // ------------------------------------------------------------------ handshake: token check before the upgrade

    @Override
    public boolean beforeHandshake(ServerHttpRequest req, ServerHttpResponse res, WebSocketHandler h, Map<String, Object> attrs) {
        String path = req.getURI().getPath();
        String id = path.substring(path.lastIndexOf('/') + 1);
        String token = req.getHeaders().getFirst(TOKEN_HEADER);
        if (token == null) token = UriComponentsBuilder.fromUri(req.getURI()).build().getQueryParams().getFirst("token");
        OptionalInt port = forwards.authorize(id, token);
        if (port.isEmpty()) {
            res.setStatusCode(HttpStatus.FORBIDDEN);
            log.info("tunnel {} refused (bad token or forward stopped) from {}", id, req.getRemoteAddress());
            return false;
        }
        attrs.put(PORT, port.getAsInt());
        attrs.put(ID, id);
        return true;
    }

    @Override
    public void afterHandshake(ServerHttpRequest req, ServerHttpResponse res, WebSocketHandler h, Exception e) {}

    // ------------------------------------------------------------------ bytes both ways

    @Override
    public void afterConnectionEstablished(WebSocketSession ws) throws IOException {
        Socket s = new Socket(InetAddress.getLoopbackAddress(), (int) ws.getAttributes().get(PORT));
        s.setTcpNoDelay(true);
        ws.getAttributes().put(SOCKET, s);
        log.info("tunnel {} opened from {}", ws.getAttributes().get(ID), ws.getRemoteAddress());
        Thread.ofVirtual().name("tunnel-" + ws.getId()).start(() -> pump(s, ws)); // pod → client; the only sender on this session
    }

    private void pump(Socket s, WebSocketSession ws) {
        byte[] buf = new byte[32 * 1024];
        try (InputStream in = s.getInputStream()) {
            int n;
            while ((n = in.read(buf)) > 0) ws.sendMessage(new BinaryMessage(Arrays.copyOf(buf, n)));
            closeQuietly(ws, CloseStatus.NORMAL); // the service closed the connection
        } catch (IOException e) {
            closeQuietly(ws, ws.isOpen() ? CloseStatus.SERVER_ERROR : CloseStatus.NORMAL);
        }
    }

    @Override
    protected void handleBinaryMessage(WebSocketSession ws, BinaryMessage msg) throws IOException {
        Socket s = (Socket) ws.getAttributes().get(SOCKET);
        ByteBuffer b = msg.getPayload();
        if (b.hasArray()) s.getOutputStream().write(b.array(), b.arrayOffset() + b.position(), b.remaining());
        else { byte[] copy = new byte[b.remaining()]; b.get(copy); s.getOutputStream().write(copy); }
    }

    /** fragments are written as they arrive: no size limit, no buffering of big messages */
    @Override
    public boolean supportsPartialMessages() { return true; }

    @Override
    public void afterConnectionClosed(WebSocketSession ws, CloseStatus status) {
        Object s = ws.getAttributes().get(SOCKET);
        if (s instanceof Socket socket) try { socket.close(); } catch (IOException ignored) {}
        log.info("tunnel {} closed ({})", ws.getAttributes().get(ID), status.getCode());
    }

    @Override
    public void handleTransportError(WebSocketSession ws, Throwable e) {
        log.debug("tunnel {} error: {}", ws.getAttributes().get(ID), e.toString());
    }

    private static void closeQuietly(WebSocketSession ws, CloseStatus st) {
        try { if (ws.isOpen()) ws.close(st); } catch (IOException ignored) {}
    }
}
