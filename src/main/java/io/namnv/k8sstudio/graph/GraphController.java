package io.namnv.k8sstudio.graph;

import io.fabric8.kubernetes.client.KubernetesClientException;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.util.List;
import java.util.Map;

@RestController
@RequestMapping("/api")
public class GraphController {

    private final GraphService graphService;
    private final GraphStreamer streamer;
    private final DetailsService detailsService;

    public GraphController(GraphService graphService, GraphStreamer streamer, DetailsService detailsService) {
        this.graphService = graphService;
        this.streamer = streamer;
        this.detailsService = detailsService;
    }

    @GetMapping("/namespaces")
    public List<String> namespaces() {
        return graphService.namespaces();
    }

    /** namespace = "*" or empty means all namespaces. */
    @GetMapping("/graph")
    public Graph graph(@RequestParam(defaultValue = "default") String namespace) {
        return graphService.build(namespace);
    }

    /** Side-panel details for one object (containers, events, conditions…). Secret values are never included. */
    @GetMapping("/details")
    public ResponseEntity<?> details(@RequestParam String kind, @RequestParam(required = false) String namespace,
                                     @RequestParam String name) {
        return detailsService.details(kind, namespace, name)
                .<ResponseEntity<?>>map(ResponseEntity::ok)
                .orElseGet(() -> ResponseEntity.status(HttpStatus.NOT_FOUND).body(Map.of("error", "Không tìm thấy " + kind + " " + name)));
    }

    /** SSE: events "namespaces" and "graph", pushed whenever the cluster changes. */
    @GetMapping(path = "/graph/stream", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public SseEmitter stream(@RequestParam(defaultValue = "default") String namespace) {
        return streamer.subscribe(namespace);
    }

    @ExceptionHandler(KubernetesClientException.class)
    public ResponseEntity<Map<String, String>> k8sError(KubernetesClientException e) {
        String msg = e.getCause() != null ? e.getCause().getMessage() : e.getMessage();
        return ResponseEntity.status(HttpStatus.BAD_GATEWAY)
                .body(Map.of("error", "Kubernetes API error: " + msg));
    }
}
