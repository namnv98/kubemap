package io.namnv.k8sstudio.remote;

import io.namnv.k8sstudio.portforward.PortForwardService;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.Cookie;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.core.io.ClassPathResource;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.ConnectException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.*;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Splits the two ports and implements the HTTP proxy.
 * <p>
 * UI port: the remote paths don't exist there (404). Remote port: nothing but the remote paths — no UI, no /api.
 * <p>
 * HTTP proxy: {@code /pf/{id}/{token}/rest} checks the token, stores "{id}.{token}" in a cookie and redirects to
 * {@code /rest}; from then on every request of that browser is proxied to the forward at the root path. Apps that use
 * absolute paths (/static/…, /api/…) — Grafana, Argo CD, most SPAs — work unchanged; the price is one HTTP forward at a
 * time per browser on this host (opening another link switches it).
 */
@Component
@Order(Ordered.HIGHEST_PRECEDENCE)
public class RemoteProxyFilter extends OncePerRequestFilter {

    private static final Logger log = LoggerFactory.getLogger(RemoteProxyFilter.class);
    static final String COOKIE = "k8s_studio_pf";
    private static final Pattern ENTRY = Pattern.compile("^/pf/([A-Za-z0-9]+)/([A-Za-z0-9_-]+)(/.*)?$");
    /** hop-by-hop headers (RFC 9110 §7.6.1) plus the ones java.net.http sets itself */
    private static final Set<String> SKIP_REQ = Set.of("connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "proxy-connection",
            "te", "trailer", "transfer-encoding", "upgrade", "host", "content-length", "expect", "http2-settings");
    private static final Set<String> SKIP_RES = Set.of("connection", "keep-alive", "proxy-authenticate", "proxy-connection", "te", "trailer",
            "transfer-encoding", "upgrade");

    private final RemoteAccess remote;
    private final PortForwardService forwards;
    private final HttpClient http = HttpClient.newBuilder().version(HttpClient.Version.HTTP_1_1)
            .followRedirects(HttpClient.Redirect.NEVER).connectTimeout(Duration.ofSeconds(5)).build();

    public RemoteProxyFilter(RemoteAccess remote, PortForwardService forwards) {
        this.remote = remote;
        this.forwards = forwards;
    }

    static boolean remotePath(String uri) {
        return uri.startsWith("/pf/") || uri.startsWith("/tunnel/") || uri.equals("/connect.java");
    }

    @Override
    protected void doFilterInternal(HttpServletRequest req, HttpServletResponse res, FilterChain chain) throws ServletException, IOException {
        String uri = req.getRequestURI();
        boolean remotePort = remote.enabled() && req.getLocalPort() == remote.port();
        if (!remotePort) {
            if (remotePath(uri)) { res.sendError(404); return; }
            chain.doFilter(req, res);
            return;
        }
        if (uri.startsWith("/tunnel/")) { chain.doFilter(req, res); return; } // WebSocket handshake → TunnelHandler
        if (uri.equals("/connect.java")) { client(res); return; }

        Matcher m = ENTRY.matcher(uri);
        if (m.matches()) { enter(req, res, m.group(1), m.group(2), m.group(3)); return; }

        String[] pair = cookie(req);
        OptionalInt port = pair == null ? OptionalInt.empty() : forwards.authorize(pair[0], pair[1]);
        if (port.isEmpty()) {
            page(res, 404, "Không có port-forward nào được chọn",
                    "Mở link “Mở qua web” của một port-forward trong Kubemap. Link có dạng /pf/&lt;id&gt;/&lt;token&gt;/ và hết hiệu lực khi port-forward bị dừng.");
            return;
        }
        if ("websocket".equalsIgnoreCase(req.getHeader("Upgrade"))) { webSocket(req, res, port.getAsInt()); return; }
        proxy(req, res, port.getAsInt());
    }

    /**
     * WebSocket (or any HTTP/1.1 Upgrade) through the proxy: replay the handshake to the app over a raw socket, hand the
     * app's 101 back to the browser, then let Tomcat give us the raw connection and pipe bytes both ways.
     */
    private void webSocket(HttpServletRequest req, HttpServletResponse res, int port) throws IOException {
        java.net.Socket up = new java.net.Socket(java.net.InetAddress.getLoopbackAddress(), port);
        up.setTcpNoDelay(true);
        try {
            String q = req.getQueryString();
            StringBuilder h = new StringBuilder("GET ").append(req.getRequestURI()).append(q == null ? "" : "?" + q).append(" HTTP/1.1\r\n");
            for (String name : Collections.list(req.getHeaderNames())) {
                for (String v : Collections.list(req.getHeaders(name))) {
                    if (name.equalsIgnoreCase("cookie")) v = stripOwnCookie(v);
                    if (v != null && !v.isEmpty()) h.append(name).append(": ").append(v).append("\r\n");
                }
            }
            h.append("X-Forwarded-For: ").append(req.getRemoteAddr()).append("\r\n\r\n");
            up.getOutputStream().write(h.toString().getBytes(StandardCharsets.ISO_8859_1));
            up.getOutputStream().flush();

            java.io.BufferedInputStream in = new java.io.BufferedInputStream(up.getInputStream());
            List<String> head = readHead(in);
            if (head.isEmpty()) throw new IOException("empty handshake response");
            String[] status = head.get(0).split(" ", 3);
            int code = status.length > 1 ? Integer.parseInt(status[1]) : 502;
            if (code != 101) { // the app refused the upgrade: pass its status on
                res.setStatus(code);
                up.close();
                return;
            }
            res.setStatus(101);
            for (String line : head.subList(1, head.size())) {
                int c = line.indexOf(':');
                if (c > 0) res.addHeader(line.substring(0, c).trim(), line.substring(c + 1).trim());
            }
            UpgradePipe pipe = req.upgrade(UpgradePipe.class);
            pipe.upstream = up;
            pipe.upstreamIn = in; // may already hold the first frames the app sent after its 101
        } catch (IOException | RuntimeException | ServletException e) {
            try { up.close(); } catch (IOException ignored) {}
            log.debug("websocket proxy failed", e);
            if (!res.isCommitted()) page(res, 502, "Không mở được WebSocket tới dịch vụ trong pod", String.valueOf(e.getMessage()));
        }
    }

    /** response status line + headers, up to the blank line (the body / frames stay in the stream) */
    private static List<String> readHead(java.io.InputStream in) throws IOException {
        List<String> lines = new ArrayList<>();
        StringBuilder line = new StringBuilder();
        int b, prev = -1;
        while ((b = in.read()) != -1) {
            if (b == '\n' && prev == '\r') {
                line.setLength(line.length() - 1);
                if (line.isEmpty()) return lines;
                lines.add(line.toString());
                line.setLength(0);
            } else line.append((char) b);
            prev = b;
            if (line.length() > 16_384) throw new IOException("handshake header too long");
        }
        return lines;
    }

    /** Tomcat hands the upgraded connection here; two threads copy bytes until either side closes. */
    public static class UpgradePipe implements jakarta.servlet.http.HttpUpgradeHandler {
        volatile java.net.Socket upstream;
        volatile java.io.InputStream upstreamIn;

        @Override
        public void init(jakarta.servlet.http.WebConnection wc) {
            Thread.ofVirtual().name("ws-proxy-up").start(() -> {
                try (InputStream from = wc.getInputStream()) { from.transferTo(upstream.getOutputStream()); }
                catch (Exception ignored) {} finally { closeAll(wc); }
            });
            Thread.ofVirtual().name("ws-proxy-down").start(() -> {
                try (OutputStream to = wc.getOutputStream()) {
                    byte[] buf = new byte[16 * 1024];
                    int n;
                    while ((n = upstreamIn.read(buf)) > 0) { to.write(buf, 0, n); to.flush(); }
                } catch (Exception ignored) {} finally { closeAll(wc); }
            });
        }

        private void closeAll(jakarta.servlet.http.WebConnection wc) {
            try { upstream.close(); } catch (Exception ignored) {}
            try { wc.close(); } catch (Exception ignored) {}
        }

        @Override
        public void destroy() {
            try { if (upstream != null) upstream.close(); } catch (IOException ignored) {}
        }
    }

    /** /pf/{id}/{token}/rest → cookie + redirect to /rest */
    private void enter(HttpServletRequest req, HttpServletResponse res, String id, String token, String rest) throws IOException {
        if (forwards.authorize(id, token).isEmpty()) {
            page(res, 403, "Link không hợp lệ hoặc port-forward đã dừng", "Lấy link mới trong danh sách port-forward của Kubemap.");
            return;
        }
        Cookie c = new Cookie(COOKIE, id + "." + token);
        c.setPath("/");
        c.setHttpOnly(true);
        c.setSecure(req.isSecure() || "https".equalsIgnoreCase(req.getHeader("X-Forwarded-Proto")));
        c.setAttribute("SameSite", "Lax");
        res.addCookie(c);
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("Referrer-Policy", "no-referrer"); // the token is in this URL
        String q = req.getQueryString();
        res.sendRedirect((rest == null || rest.isEmpty() ? "/" : rest) + (q == null ? "" : "?" + q));
    }

    private void proxy(HttpServletRequest req, HttpServletResponse res, int port) throws IOException {
        String q = req.getQueryString();
        URI target = URI.create("http://127.0.0.1:" + port + req.getRequestURI() + (q == null ? "" : "?" + q));
        HttpRequest.Builder b = HttpRequest.newBuilder(target);
        for (String name : Collections.list(req.getHeaderNames())) {
            String lower = name.toLowerCase(Locale.ROOT);
            if (SKIP_REQ.contains(lower)) continue;
            for (String v : Collections.list(req.getHeaders(name))) {
                if (lower.equals("cookie")) v = stripOwnCookie(v);
                if (v != null && !v.isEmpty()) b.header(name, v);
            }
        }
        String host = req.getHeader("Host");
        if (host != null) b.header("X-Forwarded-Host", host);
        b.header("X-Forwarded-Proto", req.isSecure() ? "https" : "http");
        b.header("X-Forwarded-For", req.getRemoteAddr());
        boolean hasBody = req.getContentLengthLong() > 0 || req.getHeader("Transfer-Encoding") != null;
        b.method(req.getMethod(), hasBody ? HttpRequest.BodyPublishers.ofInputStream(() -> {
            try { return req.getInputStream(); } catch (IOException e) { throw new java.io.UncheckedIOException(e); }
        }) : HttpRequest.BodyPublishers.noBody());

        HttpResponse<InputStream> up;
        try {
            up = http.send(b.build(), HttpResponse.BodyHandlers.ofInputStream());
        } catch (ConnectException e) {
            page(res, 502, "Không kết nối được tới dịch vụ trong pod", "Port-forward đang mở nhưng không có gì lắng nghe ở cổng đích, hoặc pod vừa khởi động lại.");
            return;
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            res.sendError(503);
            return;
        } catch (IOException e) {
            log.debug("proxy to {} failed", target, e);
            page(res, 502, "Lỗi khi gọi tới dịch vụ trong pod", e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage());
            return;
        }

        res.setStatus(up.statusCode());
        up.headers().map().forEach((name, values) -> {
            String lower = name.toLowerCase(Locale.ROOT);
            if (SKIP_RES.contains(lower) || lower.equals(":status")) return;
            for (String v : values) res.addHeader(name, lower.equals("location") ? relocate(v, port) : v);
        });
        try (InputStream in = up.body(); OutputStream out = res.getOutputStream()) {
            byte[] buf = new byte[16 * 1024];
            int n;
            while ((n = in.read(buf)) > 0) {
                out.write(buf, 0, n);
                if (in.available() == 0) out.flush(); // streams (SSE, long polling) reach the browser as they arrive
            }
        } catch (IOException e) {
            log.debug("proxy stream {} ended: {}", target, e.toString()); // usually the browser went away
        }
    }

    /** "http://127.0.0.1:{port}/x" (the app thinks it lives there) → "/x" */
    private static String relocate(String location, int port) {
        for (String prefix : List.of("http://127.0.0.1:" + port, "http://localhost:" + port))
            if (location.startsWith(prefix)) return location.substring(prefix.length()).isEmpty() ? "/" : location.substring(prefix.length());
        return location;
    }

    private static String[] cookie(HttpServletRequest req) {
        if (req.getCookies() == null) return null;
        for (Cookie c : req.getCookies()) {
            if (!COOKIE.equals(c.getName())) continue;
            int dot = c.getValue().indexOf('.');
            if (dot > 0) return new String[]{c.getValue().substring(0, dot), c.getValue().substring(dot + 1)};
        }
        return null;
    }

    /** the app behind the proxy never sees our cookie (it holds the token) */
    private static String stripOwnCookie(String header) {
        StringJoiner j = new StringJoiner("; ");
        for (String part : header.split(";")) {
            String p = part.trim();
            if (!p.isEmpty() && !p.startsWith(COOKIE + "=")) j.add(p);
        }
        return j.toString();
    }

    private static void client(HttpServletResponse res) throws IOException {
        res.setContentType("text/x-java-source; charset=utf-8");
        res.setHeader("Content-Disposition", "attachment; filename=\"connect.java\"");
        try (InputStream in = new ClassPathResource("remote/connect.java").getInputStream()) { in.transferTo(res.getOutputStream()); }
    }

    private static void page(HttpServletResponse res, int status, String title, String detail) throws IOException {
        res.setStatus(status);
        res.setContentType("text/html; charset=utf-8");
        res.setHeader("Cache-Control", "no-store");
        res.getOutputStream().write(("""
                <!doctype html><html lang="vi"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
                <title>Kubemap · port-forward</title>
                <style>body{font:15px system-ui,sans-serif;margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0e14;color:#e6eaf2}
                main{max-width:520px;padding:24px}h1{font-size:18px;margin:0 0 8px}p{color:#a1aabb;line-height:1.6;margin:0}
                @media (prefers-color-scheme: light){body{background:#f5f6fa;color:#1b2130}p{color:#4f5869}}</style>
                <main><h1>%s</h1><p>%s</p></main></html>""".formatted(title, detail)).getBytes(StandardCharsets.UTF_8));
    }
}
