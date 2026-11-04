package io.namnv.k8sstudio.graph;

import io.fabric8.kubernetes.api.model.Event;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.time.Instant;
import java.util.*;

/**
 * Events for the timeline view, straight from the informer cache (the API server keeps them ~1h by default).
 * Times are epoch millis: first / last occurrence (an aggregated event is one entry with count > 1).
 */
@RestController
public class EventsController {

    private final ClusterCache cache;

    public EventsController(ClusterCache cache) {
        this.cache = cache;
    }

    public record Item(String uid, String type, String reason, String message, long first, long last, int count,
                       String source, String fieldPath, String kind, String namespace, String name, String objectId) {}

    /** namespace "*" or empty = all namespaces; cluster-scoped objects (Node…) are always included */
    @GetMapping("/api/events")
    public Map<String, Object> events(@RequestParam(defaultValue = "*") String namespace) {
        boolean all = namespace.isBlank() || "*".equals(namespace);
        List<Item> out = new ArrayList<>();
        for (Event e : cache.events.getStore().list()) {
            var o = e.getInvolvedObject();
            if (o == null || o.getKind() == null || o.getName() == null) continue;
            String ons = o.getNamespace() == null || o.getNamespace().isEmpty() ? null : o.getNamespace();
            if (!all && ons != null && !namespace.equals(ons)) continue;
            String eventTime = e.getEventTime() == null ? null : e.getEventTime().getTime();
            long first = millis(eventTime != null ? eventTime : e.getFirstTimestamp());
            long last = millis(e.getSeries() != null && e.getSeries().getLastObservedTime() != null ? e.getSeries().getLastObservedTime().getTime()
                    : e.getLastTimestamp() != null ? e.getLastTimestamp() : eventTime != null ? eventTime : e.getFirstTimestamp());
            if (first == 0) first = last;
            if (last == 0) last = first;
            if (first == 0) first = last = millis(e.getMetadata().getCreationTimestamp());
            int count = e.getSeries() != null && e.getSeries().getCount() != null ? e.getSeries().getCount() : e.getCount() != null ? e.getCount() : 1;
            String source = e.getSource() != null && e.getSource().getComponent() != null && !e.getSource().getComponent().isEmpty()
                    ? e.getSource().getComponent() : Objects.requireNonNullElse(e.getReportingComponent(), "");
            out.add(new Item(e.getMetadata().getUid(), Objects.requireNonNullElse(e.getType(), "Normal"), Objects.requireNonNullElse(e.getReason(), ""),
                    Objects.requireNonNullElse(e.getMessage(), "").strip(), Math.min(first, last), Math.max(first, last), Math.max(1, count),
                    source, o.getFieldPath(), o.getKind(), ons, o.getName(), o.getKind() + "/" + (ons == null ? "" : ons) + "/" + o.getName()));
        }
        out.sort(Comparator.comparingLong(Item::last));
        return Map.of("now", System.currentTimeMillis(), "events", out);
    }

    private static long millis(String iso) {
        if (iso == null || iso.isEmpty()) return 0;
        try { return Instant.parse(iso).toEpochMilli(); } catch (RuntimeException ex) { return 0; }
    }
}
