package io.namnv.k8sstudio.helm;

import io.namnv.k8sstudio.actions.AuditLog;
import io.namnv.k8sstudio.cluster.KubeConnection;
import io.namnv.k8sstudio.graph.ClusterCache;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;

/**
 * Helm rollback / uninstall, delegated to the helm CLI (re-implementing hooks and three-way merges is not worth the risk),
 * run against the kubeconfig + context the app is connected to. Under /api/actions → WriteGuardFilter applies
 * (writes can be switched off, custom header, same origin). Every call is audited.
 */
@RestController
@RequestMapping("/api/actions/helm")
public class HelmActions {

    private final KubeConnection connection;
    private final ClusterCache cache;
    private final AuditLog audit;
    private final String helmBinary;

    public HelmActions(KubeConnection connection, ClusterCache cache, AuditLog audit, @Value("${k8s-studio.helm-binary:helm}") String helmBinary) {
        this.connection = connection;
        this.cache = cache;
        this.audit = audit;
        this.helmBinary = helmBinary;
    }

    public record RollbackRequest(String namespace, String name, int revision) {}
    public record UninstallRequest(String namespace, String name, boolean keepHistory) {}

    @GetMapping("/available")
    public Map<String, Object> available() {
        try {
            String v = run(List.of(helmBinary, "version", "--short"), 10).strip();
            return Map.of("available", true, "version", v);
        } catch (RuntimeException e) {
            return Map.of("available", false, "error", String.valueOf(e.getMessage()));
        }
    }

    @PostMapping("/rollback")
    public Map<String, String> rollback(@RequestBody RollbackRequest r) {
        validName(r.name()); validName(r.namespace());
        if (r.revision() <= 0) throw new HelmException(400, "Revision không hợp lệ");
        String target = "Helm release " + r.namespace() + "/" + r.name();
        try {
            String out = run(cmd("rollback", r.name(), String.valueOf(r.revision()), "-n", r.namespace()), 300);
            audit.record(cache.context(), "helm-rollback", target, "revision=" + r.revision(), null);
            return Map.of("message", "Đã rollback " + r.name() + " về revision " + r.revision(), "output", out.strip());
        } catch (RuntimeException e) {
            audit.record(cache.context(), "helm-rollback", target, "revision=" + r.revision(), e);
            throw e;
        }
    }

    @PostMapping("/uninstall")
    public Map<String, String> uninstall(@RequestBody UninstallRequest r) {
        validName(r.name()); validName(r.namespace());
        String target = "Helm release " + r.namespace() + "/" + r.name();
        List<String> c = cmd("uninstall", r.name(), "-n", r.namespace());
        if (r.keepHistory()) c.add("--keep-history");
        try {
            String out = run(c, 300);
            audit.record(cache.context(), "helm-uninstall", target, r.keepHistory() ? "keep-history" : null, null);
            return Map.of("message", "Đã uninstall " + r.name(), "output", out.strip());
        } catch (RuntimeException e) {
            audit.record(cache.context(), "helm-uninstall", target, null, e);
            throw e;
        }
    }

    /** helm <args> --kubeconfig <file in use> --kube-context <context in use> */
    private List<String> cmd(String... args) {
        List<String> c = new ArrayList<>(List.of(helmBinary));
        c.addAll(List.of(args));
        var sel = connection.selection();
        if (sel != null && sel.file() != null) { c.add("--kubeconfig"); c.add(sel.file()); }
        if (sel != null && sel.context() != null) { c.add("--kube-context"); c.add(sel.context()); }
        return c;
    }

    private static void validName(String s) {
        // release / namespace names are DNS-1123 labels; also keeps anything flag-like out of the argv
        if (s == null || !s.matches("[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?")) throw new HelmException(400, "Tên không hợp lệ: " + s);
    }

    private static String run(List<String> command, int timeoutSeconds) {
        try {
            Path out = Files.createTempFile("k8s-studio-helm", ".log");
            try {
                Process p = new ProcessBuilder(command).redirectErrorStream(true).redirectOutput(out.toFile()).start();
                if (!p.waitFor(timeoutSeconds, TimeUnit.SECONDS)) { p.destroyForcibly(); throw new HelmException(504, "helm chạy quá " + timeoutSeconds + "s"); }
                String text = Files.readString(out, StandardCharsets.UTF_8);
                if (p.exitValue() != 0) throw new HelmException(502, text.isBlank() ? "helm thoát với mã " + p.exitValue() : text.strip());
                return text;
            } finally {
                Files.deleteIfExists(out);
            }
        } catch (IOException e) {
            throw new HelmException(501, "Không chạy được helm (" + command.get(0) + "): " + e.getMessage() + ". Cài helm hoặc đặt k8s-studio.helm-binary");
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new HelmException(500, "Bị ngắt");
        }
    }

    static class HelmException extends RuntimeException {
        final int status;
        HelmException(int status, String msg) { super(msg); this.status = status; }
    }

    @ExceptionHandler(HelmException.class)
    public ResponseEntity<Map<String, String>> failed(HelmException e) {
        return ResponseEntity.status(HttpStatus.valueOf(e.status)).body(Map.of("error", String.valueOf(e.getMessage())));
    }
}
