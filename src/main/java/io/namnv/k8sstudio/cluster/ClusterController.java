package io.namnv.k8sstudio.cluster;

import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Cluster picker for the UI: list kube contexts, import a kubeconfig, switch, remove an imported one.
 * Non-GET calls are protected by WriteGuardFilter (custom header + same origin), like cluster actions.
 */
@RestController
@RequestMapping("/api/clusters")
public class ClusterController {

    private final KubeConnection connection;

    public ClusterController(KubeConnection connection) {
        this.connection = connection;
    }

    public record SwitchRequest(String file, String context) {}
    public record ImportRequest(String name, String content) {}
    public record RenameRequest(String file, String name) {}

    @GetMapping
    public Map<String, Object> list() {
        Map<String, Object> out = new LinkedHashMap<>();
        var sel = connection.selection();
        out.put("current", sel == null ? null : Map.of("file", String.valueOf(sel.file()), "context", sel.context()));
        out.put("server", connection.client().getMasterUrl() == null ? null : connection.client().getMasterUrl().toString());
        out.put("dir", connection.dir().toString());
        out.put("contexts", connection.contexts());
        return out;
    }

    @PostMapping("/switch")
    public Map<String, Object> switchTo(@RequestBody SwitchRequest req) {
        connection.switchTo(req.file(), req.context());
        return list();
    }

    /** Saves an imported kubeconfig into the project directory; the UI then offers its contexts. */
    @PostMapping("/import")
    public Map<String, Object> importKubeconfig(@RequestBody ImportRequest req) {
        var file = connection.add(req.name(), req.content()).toString();
        Map<String, Object> out = list();
        out.put("imported", file);
        return out;
    }

    @PostMapping("/rename")
    public Map<String, Object> rename(@RequestBody RenameRequest req) {
        connection.rename(req.file(), req.name());
        return list();
    }

    @DeleteMapping
    public Map<String, Object> remove(@RequestParam String file) {
        connection.remove(file);
        return list();
    }

    @ExceptionHandler({IllegalArgumentException.class, IllegalStateException.class})
    public ResponseEntity<Map<String, String>> error(RuntimeException e) {
        HttpStatus status = e instanceof IllegalArgumentException ? HttpStatus.BAD_REQUEST : HttpStatus.BAD_GATEWAY;
        return ResponseEntity.status(status).body(Map.of("error", String.valueOf(e.getMessage())));
    }
}
