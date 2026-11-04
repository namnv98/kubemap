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
    public record RepoRequest(String name, String url) {}
    public record InstallRequest(String namespace, String name, String chart, String version, String values, boolean createNamespace, boolean dryRun) {}

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

    // ------------------------------------------------------------------ repositories & charts (helm's own repo config)

    @GetMapping("/repos")
    public Object repos() {
        try { return parseJson(run(List.of(helmBinary, "repo", "list", "-o", "json"), 30)); }
        catch (HelmException e) { if (String.valueOf(e.getMessage()).contains("no repositories")) return List.of(); throw e; }
    }

    @PostMapping("/repo/add")
    public Map<String, String> repoAdd(@RequestBody RepoRequest r) {
        if (r.name() == null || !r.name().matches("[a-z0-9][a-z0-9_-]{0,62}")) throw new HelmException(400, "Tên repo không hợp lệ");
        if (r.url() == null || !r.url().matches("(https?|oci)://[^\\s]+")) throw new HelmException(400, "URL phải bắt đầu bằng https://, http:// hoặc oci://");
        String out = run(List.of(helmBinary, "repo", "add", r.name(), r.url()), 120);
        audit.record(cache.context(), "helm-repo-add", r.name(), r.url(), null);
        return Map.of("message", "Đã thêm repo " + r.name(), "output", out.strip());
    }

    @PostMapping("/repo/update")
    public Map<String, String> repoUpdate() {
        return Map.of("message", "Đã cập nhật index các repo", "output", run(List.of(helmBinary, "repo", "update"), 300).strip());
    }

    @PostMapping("/repo/remove")
    public Map<String, String> repoRemove(@RequestBody RepoRequest r) {
        if (r.name() == null || !r.name().matches("[a-z0-9][a-z0-9_-]{0,62}")) throw new HelmException(400, "Tên repo không hợp lệ");
        String out = run(List.of(helmBinary, "repo", "remove", r.name()), 30);
        audit.record(cache.context(), "helm-repo-remove", r.name(), null, null);
        return Map.of("message", "Đã xoá repo " + r.name(), "output", out.strip());
    }

    @GetMapping("/search")
    public Object search(@RequestParam(defaultValue = "") String q) {
        if (!q.matches("[A-Za-z0-9._/ -]{0,100}") || q.startsWith("-")) throw new HelmException(400, "Từ khoá không hợp lệ");
        List<String> c = new ArrayList<>(List.of(helmBinary, "search", "repo"));
        if (!q.isBlank()) c.add(q.strip());
        c.addAll(List.of("-o", "json"));
        return parseJson(run(c, 60));
    }

    @GetMapping("/chart/values")
    public Map<String, String> chartValues(@RequestParam String chart, @RequestParam(defaultValue = "") String version) {
        validChart(chart, version);
        List<String> c = new ArrayList<>(List.of(helmBinary, "show", "values", chart));
        if (!version.isBlank()) { c.add("--version"); c.add(version); }
        return Map.of("yaml", run(c, 120));
    }

    /** helm install … -f <values>; dryRun=true renders and validates against the API server without installing */
    @PostMapping("/install")
    public Map<String, String> install(@RequestBody InstallRequest r) {
        validName(r.name()); validName(r.namespace()); validChart(r.chart(), r.version());
        Path values = null;
        try {
            List<String> c = cmd("install", r.name(), r.chart(), "-n", r.namespace());
            if (r.version() != null && !r.version().isBlank()) { c.add("--version"); c.add(r.version()); }
            if (r.createNamespace()) c.add("--create-namespace");
            if (r.dryRun()) c.add("--dry-run=server");
            if (r.values() != null && !r.values().isBlank()) {
                values = Files.createTempFile("k8s-studio-values", ".yaml");
                Files.writeString(values, r.values(), StandardCharsets.UTF_8);
                c.add("-f"); c.add(values.toString());
            }
            String target = "Helm release " + r.namespace() + "/" + r.name();
            try {
                String out = run(c, 600);
                if (!r.dryRun()) audit.record(cache.context(), "helm-install", target, r.chart() + (r.version() == null || r.version().isBlank() ? "" : "@" + r.version()), null);
                return Map.of("message", r.dryRun() ? "Dry-run hợp lệ" : "Đã cài " + r.name(), "output", out.strip());
            } catch (RuntimeException e) {
                if (!r.dryRun()) audit.record(cache.context(), "helm-install", target, r.chart(), e);
                throw e;
            }
        } catch (IOException e) {
            throw new HelmException(500, "Không ghi được file values: " + e.getMessage());
        } finally {
            if (values != null) try { Files.deleteIfExists(values); } catch (IOException ignored) {}
        }
    }

    private static void validChart(String chart, String version) {
        if (chart == null || chart.startsWith("-") || !chart.matches("(oci://)?[A-Za-z0-9._/:-]{1,200}")) throw new HelmException(400, "Tên chart không hợp lệ");
        if (version != null && !version.isBlank() && !version.matches("[A-Za-z0-9.+_~^<>=*-]{1,60}")) throw new HelmException(400, "Version không hợp lệ");
    }

    private Object parseJson(String json) {
        return cache.client().getKubernetesSerialization().unmarshal(json.isBlank() ? "[]" : json, Object.class);
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
