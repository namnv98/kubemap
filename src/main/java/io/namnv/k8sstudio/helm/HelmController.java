package io.namnv.k8sstudio.helm;

import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;
import java.util.Map;

/** Helm releases, read-only (see {@link HelmService}). */
@RestController
@RequestMapping("/api/helm")
public class HelmController {

    private final HelmService helm;

    public HelmController(HelmService helm) {
        this.helm = helm;
    }

    /** namespace "*" or empty = all namespaces */
    @GetMapping("/releases")
    public List<HelmService.Summary> releases(@RequestParam(defaultValue = "*") String namespace) {
        return helm.list(namespace.isBlank() || "*".equals(namespace) ? null : namespace);
    }

    @GetMapping("/release")
    public ResponseEntity<?> release(@RequestParam String namespace, @RequestParam String name) {
        return helm.detail(namespace, name).<ResponseEntity<?>>map(ResponseEntity::ok)
                .orElseGet(() -> ResponseEntity.status(HttpStatus.NOT_FOUND).body(Map.of("error", "Không có release " + namespace + "/" + name)));
    }

    /** values of one revision (0 = latest): user-supplied, or merged with the chart's defaults when all=true */
    @GetMapping("/values")
    public ResponseEntity<?> values(@RequestParam String namespace, @RequestParam String name,
                                    @RequestParam(defaultValue = "0") int revision, @RequestParam(defaultValue = "false") boolean all) {
        return helm.values(namespace, name, revision, all).<ResponseEntity<?>>map(v -> ResponseEntity.ok(Map.of("yaml", v)))
                .orElseGet(() -> ResponseEntity.status(HttpStatus.NOT_FOUND).body(Map.of("error", "Không có release " + namespace + "/" + name)));
    }
}
