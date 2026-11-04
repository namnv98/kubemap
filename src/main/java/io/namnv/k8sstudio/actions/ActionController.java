package io.namnv.k8sstudio.actions;

import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.Map;

/** Cluster-changing endpoints. Guarded by {@link WriteGuardFilter}; every call is written to {@link AuditLog}. */
@RestController
@RequestMapping("/api/actions")
public class ActionController {

    private final ActionService actions;
    private final ManifestService manifests;
    private final RolloutService rollouts;
    private final AuditLog audit;

    public ActionController(ActionService actions, ManifestService manifests, RolloutService rollouts, AuditLog audit) {
        this.actions = actions;
        this.manifests = manifests;
        this.rollouts = rollouts;
        this.audit = audit;
    }

    public record DeleteRequest(String kind, String namespace, String name, String propagation, boolean force) {}
    public record RollbackRequest(String kind, String namespace, String name, long revision) {}
    public record PauseRequest(String namespace, String name, boolean paused) {}

    @PostMapping("/delete")
    public Map<String, String> delete(@RequestBody DeleteRequest r) {
        return ok(actions.delete(r.kind(), r.namespace(), r.name(), r.propagation(), r.force()));
    }

    /** read-only: revisions of a Deployment / StatefulSet / DaemonSet */
    @GetMapping("/history")
    public List<RolloutService.Revision> history(@RequestParam String kind, @RequestParam String namespace, @RequestParam String name) {
        return rollouts.history(kind, namespace, name);
    }

    @PostMapping("/rollback")
    public Map<String, String> rollback(@RequestBody RollbackRequest r) {
        return ok(rollouts.rollback(r.kind(), r.namespace(), r.name(), r.revision()));
    }

    @PostMapping("/pause")
    public Map<String, String> pause(@RequestBody PauseRequest r) {
        return ok(rollouts.pause(r.namespace(), r.name(), r.paused()));
    }

    public record ManifestUpdate(String kind, String namespace, String name, String resourceVersion, String yaml,
                                 List<ActionService.WorkloadRef> restart, String mode, boolean force) {}

    /** Live manifest (YAML) — read-only call, allowed even when writes are disabled. Secret values are masked. */
    @GetMapping("/manifest")
    public ManifestService.Manifest manifest(@RequestParam String kind, @RequestParam(required = false) String namespace,
                                             @RequestParam String name, @RequestParam(defaultValue = "false") boolean clean,
                                             @RequestParam(defaultValue = "true") boolean status) {
        return manifests.read(kind, namespace, name, clean, status);
    }

    /** dryRun=true only validates against the API server (nothing is changed). */
    @PutMapping("/manifest")
    public Map<String, String> saveManifest(@RequestBody ManifestUpdate u, @RequestParam(defaultValue = "false") boolean dryRun) {
        String rv = manifests.update(u.kind(), u.namespace(), u.name(), u.resourceVersion(), u.yaml(), dryRun, u.mode(), u.force());
        if (dryRun) return Map.of("message", "Hợp lệ", "resourceVersion", rv);
        StringBuilder msg = new StringBuilder("Đã lưu " + u.kind() + " " + u.name());
        if (u.restart() != null) for (var w : u.restart()) {
            actions.restart(w.kind(), u.namespace(), w.name());
            msg.append("; đã restart ").append(w.kind()).append(' ').append(w.name());
        }
        return Map.of("message", msg.toString(), "resourceVersion", rv);
    }

    public record Target(String kind, String namespace, String name) {}
    public record ScaleRequest(String kind, String namespace, String name, int replicas) {}
    public record SuspendRequest(String namespace, String name, boolean suspend) {}
    public record ConfigMapUpdate(String namespace, String name, String resourceVersion, Map<String, String> data,
                                  List<ActionService.WorkloadRef> restart) {}

    @PostMapping("/scale")
    public Map<String, String> scale(@RequestBody ScaleRequest r) {
        return ok(actions.scale(r.kind(), r.namespace(), r.name(), r.replicas()));
    }

    @PostMapping("/restart")
    public Map<String, String> restart(@RequestBody Target t) {
        return ok(actions.restart(t.kind(), t.namespace(), t.name()));
    }

    @PostMapping("/delete-pod")
    public Map<String, String> deletePod(@RequestBody Target t) {
        return ok(actions.deletePod(t.namespace(), t.name()));
    }

    @PostMapping("/cronjob/suspend")
    public Map<String, String> suspend(@RequestBody SuspendRequest r) {
        return ok(actions.suspendCronJob(r.namespace(), r.name(), r.suspend()));
    }

    @PostMapping("/cronjob/trigger")
    public Map<String, String> trigger(@RequestBody Target t) {
        return ok(actions.triggerCronJob(t.namespace(), t.name()));
    }

    @GetMapping("/configmap")
    public Map<String, Object> readConfigMap(@RequestParam String namespace, @RequestParam String name) {
        return actions.readConfigMap(namespace, name);
    }

    @PutMapping("/configmap")
    public Map<String, String> updateConfigMap(@RequestBody ConfigMapUpdate u) {
        return ok(actions.updateConfigMap(u.namespace(), u.name(), u.resourceVersion(), u.data(), u.restart()));
    }

    @GetMapping("/audit")
    public Map<String, Object> audit() {
        return Map.of("file", audit.file().toString(), "entries", audit.recent());
    }

    @ExceptionHandler(ActionService.ActionException.class)
    public ResponseEntity<Map<String, String>> failed(ActionService.ActionException e) {
        return ResponseEntity.status(e.status).body(Map.of("error", String.valueOf(e.getMessage())));
    }

    private static Map<String, String> ok(String message) {
        return Map.of("message", message);
    }
}
