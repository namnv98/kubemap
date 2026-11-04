package io.namnv.k8sstudio.graph;

import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

/** `kubectl describe`-style text, generated in-process by {@link DescribeService} (no kubectl binary needed). */
@RestController
public class DescribeController {

    private final DescribeService describe;

    public DescribeController(DescribeService describe) {
        this.describe = describe;
    }

    @GetMapping("/api/describe")
    public ResponseEntity<Map<String, String>> describe(@RequestParam String kind, @RequestParam(required = false) String group,
                                                       @RequestParam(required = false) String namespace, @RequestParam String name) {
        String resource = (group == null || group.isBlank() ? kind : kind + "." + group).toLowerCase();
        String command = "describe " + resource + " " + name + (namespace == null || namespace.isBlank() ? "" : " -n " + namespace);
        return describe.describe(kind, namespace, name)
                .<ResponseEntity<Map<String, String>>>map(text -> ResponseEntity.ok(Map.of("text", text, "command", command)))
                .orElseGet(() -> ResponseEntity.status(HttpStatus.NOT_FOUND)
                        .body(Map.of("error", "Error from server (NotFound): " + resource + " \"" + name + "\" not found")));
    }
}
