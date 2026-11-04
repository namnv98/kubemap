package io.namnv.k8sstudio.actions;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;
import java.net.URI;
import java.nio.charset.StandardCharsets;

/**
 * Guards every endpoint that changes the cluster (/api/actions/**).
 * <p>
 * The app listens on localhost, so any web page open in the same browser could try to POST to it (CSRF).
 * Requiring a custom header forces a CORS preflight, which Spring rejects for foreign origins; the Origin check
 * is a second line of defence. Writes can also be switched off entirely with k8s-studio.write.enabled=false.
 */
@Component
public class WriteGuardFilter extends OncePerRequestFilter {

    public static final String HEADER = "X-K8s-Studio";

    private final boolean writeEnabled;

    public WriteGuardFilter(@Value("${k8s-studio.write.enabled:true}") boolean writeEnabled) {
        this.writeEnabled = writeEnabled;
    }

    @Override
    protected boolean shouldNotFilter(HttpServletRequest request) {
        String uri = request.getRequestURI();
        return !uri.startsWith("/api/actions/") && !uri.startsWith("/api/clusters");
    }

    @Override
    protected void doFilterInternal(HttpServletRequest req, HttpServletResponse res, FilterChain chain)
            throws ServletException, IOException {
        boolean read = "GET".equals(req.getMethod());
        // switching / importing a kubeconfig changes nothing in a cluster, so read-only mode allows it
        boolean clusterPicker = req.getRequestURI().startsWith("/api/clusters");
        if (!read && !writeEnabled && !clusterPicker) {
            deny(res, "Tính năng thay đổi cluster đang tắt (k8s-studio.write.enabled=false)");
            return;
        }
        if (!read && !"1".equals(req.getHeader(HEADER))) {
            deny(res, "Thiếu header " + HEADER);
            return;
        }
        String origin = req.getHeader("Origin");
        if (origin != null && !sameOrigin(origin, req)) {
            deny(res, "Origin không hợp lệ: " + origin);
            return;
        }
        chain.doFilter(req, res);
    }

    private static boolean sameOrigin(String origin, HttpServletRequest req) {
        try {
            URI o = URI.create(origin);
            String host = req.getHeader("Host");
            return host != null && host.equalsIgnoreCase(o.getHost() + (o.getPort() > 0 ? ":" + o.getPort() : ""));
        } catch (IllegalArgumentException e) {
            return false;
        }
    }

    private static void deny(HttpServletResponse res, String msg) throws IOException {
        res.setStatus(HttpServletResponse.SC_FORBIDDEN);
        res.setContentType("application/json");
        res.setCharacterEncoding(StandardCharsets.UTF_8.name());
        res.getWriter().write("{\"error\":\"" + msg.replace("\"", "'") + "\"}");
    }

    public boolean writeEnabled() {
        return writeEnabled;
    }
}
