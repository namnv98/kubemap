package io.namnv.k8sstudio.graph;

import io.fabric8.kubernetes.api.model.HasMetadata;
import io.fabric8.kubernetes.api.model.Pod;
import io.fabric8.kubernetes.api.model.apps.ReplicaSet;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.*;

/** CPU / memory over the last hour for a node, a pod, or a workload (sum of its pods), from metrics-server polls. */
@RestController
public class MetricsController {

    private final MetricsCache metrics;
    private final ClusterCache cache;

    public MetricsController(MetricsCache metrics, ClusterCache cache) {
        this.metrics = metrics;
        this.cache = cache;
    }

    @GetMapping("/api/metrics/history")
    public Map<String, Object> history(@RequestParam String kind, @RequestParam(required = false) String namespace, @RequestParam String name) {
        List<long[]> samples;
        if (kind.equals("Node")) samples = metrics.history("node:" + name);
        else if (kind.equals("Pod")) samples = metrics.history("pod:" + namespace + "/" + name);
        else {
            Optional<HasMetadata> o = cache.find(kind, namespace, name);
            if (o.isEmpty()) samples = List.of();
            else {
                // pods controlled by the workload, directly or through its ReplicaSets
                Set<String> uids = new HashSet<>(Set.of(o.get().getMetadata().getUid()));
                for (ReplicaSet rs : cache.listOf(ReplicaSet.class, namespace))
                    if (owned(rs, uids)) uids.add(rs.getMetadata().getUid());
                List<String> keys = cache.listOf(Pod.class, namespace).stream().filter(p -> owned(p, uids))
                        .map(p -> namespace + "/" + p.getMetadata().getName()).toList();
                samples = metrics.sum(keys);
            }
        }
        Map<String, Object> out = new LinkedHashMap<>(series(samples));
        out.put("available", metrics.available());
        out.put("now", System.currentTimeMillis());
        if (kind.equals("Pod")) { // per container, for pods with sidecars / several containers
            Map<String, Object> per = new TreeMap<>();
            cache.pod(namespace, name).ifPresent(p -> {
                for (var c : p.getSpec().getContainers()) per.put(c.getName(), series(metrics.history("ctr:" + namespace + "/" + name + "/" + c.getName())));
            });
            out.put("containers", per);
        }
        return out;
    }

    private static Map<String, Object> series(List<long[]> samples) {
        List<Long> t = new ArrayList<>(), cpu = new ArrayList<>(), mem = new ArrayList<>();
        for (long[] s : samples) { t.add(s[0]); cpu.add(s[1]); mem.add(s[2]); }
        return Map.of("t", t, "cpuMilli", cpu, "memBytes", mem);
    }

    private static boolean owned(HasMetadata o, Set<String> uids) {
        return o.getMetadata().getOwnerReferences() != null && o.getMetadata().getOwnerReferences().stream().anyMatch(r -> uids.contains(r.getUid()));
    }
}
