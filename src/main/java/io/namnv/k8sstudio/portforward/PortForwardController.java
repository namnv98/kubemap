package io.namnv.k8sstudio.portforward;

import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.Map;

/** Port-forward sessions (127.0.0.1 only). Non-GET calls go through WriteGuardFilter's header / origin check. */
@RestController
@RequestMapping("/api/portforward")
public class PortForwardController {

    private final PortForwardService pf;

    public PortForwardController(PortForwardService pf) {
        this.pf = pf;
    }

    public record StartRequest(String kind, String namespace, String name, int port, int localPort) {}

    @GetMapping
    public List<PortForwardService.Forward> list() { return pf.list(); }

    @GetMapping("/ports")
    public List<PortForwardService.PortOption> ports(@RequestParam String kind, @RequestParam(required = false) String namespace, @RequestParam String name) {
        return pf.ports(kind, namespace, name);
    }

    @PostMapping
    public PortForwardService.Forward start(@RequestBody StartRequest r) {
        return pf.start(r.kind(), r.namespace(), r.name(), r.port(), r.localPort());
    }

    @DeleteMapping("/{id}")
    public Map<String, String> stop(@PathVariable String id) {
        pf.stop(id);
        return Map.of("message", "Đã dừng port-forward");
    }

    @ExceptionHandler({IllegalArgumentException.class, IllegalStateException.class})
    public ResponseEntity<Map<String, String>> error(RuntimeException e) {
        return ResponseEntity.status(e instanceof IllegalArgumentException ? HttpStatus.BAD_REQUEST : HttpStatus.BAD_GATEWAY)
                .body(Map.of("error", String.valueOf(e.getMessage())));
    }
}
