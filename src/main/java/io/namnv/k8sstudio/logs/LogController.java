package io.namnv.k8sstudio.logs;

import io.fabric8.kubernetes.api.model.Container;
import io.fabric8.kubernetes.api.model.ContainerStatus;
import io.fabric8.kubernetes.api.model.Pod;
import io.namnv.k8sstudio.graph.ClusterCache;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.server.ResponseStatusException;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.util.*;

@RestController
public class LogController {

    private final ClusterCache cache;
    private final LogStreamer streamer;

    public LogController(ClusterCache cache, LogStreamer streamer) {
        this.cache = cache;
        this.streamer = streamer;
    }

    @ExceptionHandler(ResponseStatusException.class)
    public org.springframework.http.ResponseEntity<Map<String, String>> notFound(ResponseStatusException e) {
        return org.springframework.http.ResponseEntity.status(e.getStatusCode())
                .contentType(MediaType.APPLICATION_JSON)
                .body(Map.of("error", String.valueOf(e.getReason())));
    }

    /** state: running | waiting | terminated | unknown; reason e.g. CrashLoopBackOff / Completed. */
    public record ContainerInfo(String name, boolean init, boolean ready, int restarts, String state, String reason,
                                boolean hasPrevious) {}

    @GetMapping("/api/pods/{namespace}/{pod}/containers")
    public List<ContainerInfo> containers(@PathVariable String namespace, @PathVariable String pod) {
        Pod p = cache.pod(namespace, pod)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Pod không tồn tại"));
        Map<String, ContainerStatus> st = new HashMap<>();
        if (p.getStatus() != null) {
            Optional.ofNullable(p.getStatus().getInitContainerStatuses()).orElse(List.of()).forEach(s -> st.put(s.getName(), s));
            Optional.ofNullable(p.getStatus().getContainerStatuses()).orElse(List.of()).forEach(s -> st.put(s.getName(), s));
        }
        List<ContainerInfo> out = new ArrayList<>();
        for (Container c : Optional.ofNullable(p.getSpec().getContainers()).orElse(List.of())) out.add(info(c, false, st));
        for (Container c : Optional.ofNullable(p.getSpec().getInitContainers()).orElse(List.of())) out.add(info(c, true, st));
        return out;
    }

    private static ContainerInfo info(Container c, boolean init, Map<String, ContainerStatus> st) {
        ContainerStatus s = st.get(c.getName());
        if (s == null) return new ContainerInfo(c.getName(), init, false, 0, "unknown", null, false);
        String state = "unknown", reason = null;
        var cs = s.getState();
        if (cs != null && cs.getRunning() != null) state = "running";
        else if (cs != null && cs.getWaiting() != null) { state = "waiting"; reason = cs.getWaiting().getReason(); }
        else if (cs != null && cs.getTerminated() != null) { state = "terminated"; reason = cs.getTerminated().getReason(); }
        boolean hasPrevious = s.getLastState() != null && s.getLastState().getTerminated() != null;
        return new ContainerInfo(c.getName(), init, Boolean.TRUE.equals(s.getReady()),
                s.getRestartCount() == null ? 0 : s.getRestartCount(), state, reason, hasPrevious);
    }

    /**
     * SSE log stream. tail <= 0 means the whole log. follow is ignored when previous=true
     * (a terminated container's log can't grow).
     */
    /** Logs of several pods (e.g. every pod of a Deployment) in one SSE stream; lines carry the pod index. */
    @GetMapping(path = "/api/logs/multi", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public SseEmitter multi(@RequestParam String namespace, @RequestParam List<String> pods,
                            @RequestParam(required = false) String container,
                            @RequestParam(defaultValue = "200") int tail,
                            @RequestParam(defaultValue = "true") boolean timestamps,
                            @RequestParam(defaultValue = "false") boolean previous,
                            @RequestParam(defaultValue = "true") boolean follow) {
        if (pods.isEmpty() || pods.size() > 50) throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Cần 1–50 pod");
        String c = container;
        if (c == null || c.isBlank()) {
            c = containers(namespace, pods.get(0)).stream().filter(i -> !i.init()).findFirst().map(ContainerInfo::name)
                    .orElseThrow(() -> new ResponseStatusException(HttpStatus.BAD_REQUEST, "Pod không có container"));
        }
        return streamer.openMulti(namespace, pods, c, Math.min(tail, 10_000), timestamps, previous, follow);
    }

    @GetMapping(path = "/api/pods/{namespace}/{pod}/logs", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public SseEmitter logs(@PathVariable String namespace, @PathVariable String pod,
                           @RequestParam(required = false) String container,
                           @RequestParam(defaultValue = "500") int tail,
                           @RequestParam(defaultValue = "false") boolean timestamps,
                           @RequestParam(defaultValue = "false") boolean previous,
                           @RequestParam(defaultValue = "true") boolean follow) {
        String c = container;
        if (c == null || c.isBlank()) {
            c = containers(namespace, pod).stream().filter(i -> !i.init()).findFirst()
                    .map(ContainerInfo::name)
                    .orElseThrow(() -> new ResponseStatusException(HttpStatus.BAD_REQUEST, "Pod không có container"));
        }
        return streamer.open(new LogStreamer.Options(namespace, pod, c, Math.min(tail, 100_000), timestamps, previous, follow));
    }
}
