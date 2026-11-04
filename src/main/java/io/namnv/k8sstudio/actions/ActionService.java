package io.namnv.k8sstudio.actions;

import io.fabric8.kubernetes.api.model.ConfigMap;
import io.fabric8.kubernetes.api.model.ConfigMapBuilder;
import io.fabric8.kubernetes.api.model.DeletionPropagation;
import io.fabric8.kubernetes.api.model.HasMetadata;
import io.fabric8.kubernetes.api.model.batch.v1.CronJob;
import io.fabric8.kubernetes.api.model.batch.v1.Job;
import io.fabric8.kubernetes.api.model.batch.v1.JobBuilder;
import io.fabric8.kubernetes.client.KubernetesClient;
import io.fabric8.kubernetes.client.KubernetesClientException;
import io.fabric8.kubernetes.client.dsl.Resource;
import io.fabric8.kubernetes.client.dsl.base.PatchContext;
import io.fabric8.kubernetes.client.dsl.base.PatchType;
import io.namnv.k8sstudio.graph.ClusterCache;
import org.springframework.stereotype.Service;

import java.time.Instant;
import java.util.*;
import java.util.concurrent.Callable;

/** Changes to the cluster made from the UI. Every call is audited (success or failure). */
@Service
public class ActionService {

    public static class ActionException extends RuntimeException {
        final int status;
        ActionException(int status, String msg) { super(msg); this.status = status; }
    }

    private static final int MAX_REPLICAS = 1000;

    private final KubernetesClient client;
    private final ClusterCache cache;
    private final AuditLog audit;

    public ActionService(KubernetesClient client, ClusterCache cache, AuditLog audit) {
        this.client = client;
        this.cache = cache;
        this.audit = audit;
    }

    // ------------------------------------------------------------------ workloads

    public String scale(String kind, String ns, String name, int replicas) {
        if (replicas < 0 || replicas > MAX_REPLICAS) throw new ActionException(400, "replicas phải trong khoảng 0–" + MAX_REPLICAS);
        return run("scale", kind + " " + ns + "/" + name, "replicas=" + replicas, () -> {
            switch (kind) {
                case "Deployment" -> existing(client.apps().deployments().inNamespace(ns).withName(name), kind, name).scale(replicas);
                case "StatefulSet" -> existing(client.apps().statefulSets().inNamespace(ns).withName(name), kind, name).scale(replicas);
                case "ReplicaSet" -> existing(client.apps().replicaSets().inNamespace(ns).withName(name), kind, name).scale(replicas);
                default -> throw new ActionException(400, "Không scale được " + kind);
            }
            return "Đã scale " + kind + " " + name + " → " + replicas + " replicas";
        });
    }

    /** Same as `kubectl rollout restart`: bump an annotation on the pod template. */
    public String restart(String kind, String ns, String name) {
        return run("restart", kind + " " + ns + "/" + name, null, () -> {
            restartWorkload(kind, ns, name);
            return "Đã restart " + kind + " " + name + " (rolling)";
        });
    }

    private void restartWorkload(String kind, String ns, String name) {
        String patch = "{\"spec\":{\"template\":{\"metadata\":{\"annotations\":{\"kubectl.kubernetes.io/restartedAt\":\""
                + Instant.now() + "\"}}}}}";
        PatchContext merge = PatchContext.of(PatchType.STRATEGIC_MERGE);
        switch (kind) {
            case "Deployment" -> existing(client.apps().deployments().inNamespace(ns).withName(name), kind, name).patch(merge, patch);
            case "StatefulSet" -> existing(client.apps().statefulSets().inNamespace(ns).withName(name), kind, name).patch(merge, patch);
            case "DaemonSet" -> existing(client.apps().daemonSets().inNamespace(ns).withName(name), kind, name).patch(merge, patch);
            default -> throw new ActionException(400, "Không restart được " + kind);
        }
    }

    public String deletePod(String ns, String name) {
        return run("delete-pod", "Pod " + ns + "/" + name, null, () -> {
            existing(client.pods().inNamespace(ns).withName(name), "Pod", name).delete();
            return "Đã xoá pod " + name;
        });
    }

    /**
     * Delete any object. propagation: Background (kubectl default: owner goes now, dependents are cleaned up after),
     * Foreground (owner stays until its dependents are gone), Orphan (dependents are kept, ownerReference removed).
     * force = grace period 0 (for pods stuck in Terminating).
     */
    public String delete(String kind, String ns, String name, String propagation, boolean force) {
        DeletionPropagation p;
        try { p = DeletionPropagation.valueOf((propagation == null ? "Background" : propagation).toUpperCase()); }
        catch (IllegalArgumentException e) { throw new ActionException(400, "propagation phải là Background, Foreground hoặc Orphan"); }
        String nsOrNull = ns == null || ns.isBlank() ? null : ns;
        return run("delete", kind + " " + (nsOrNull == null ? "" : nsOrNull + "/") + name, "propagation=" + p + (force ? ", force" : ""), () -> {
            HasMetadata obj = cache.find(kind, nsOrNull, name).orElseThrow(() -> new ActionException(404, kind + " " + name + " không tồn tại"));
            var res = client.resource(obj).withPropagationPolicy(p);
            if (force) res.withGracePeriod(0).delete(); else res.delete();
            return "Đã xoá " + kind + " " + name + (p == DeletionPropagation.ORPHAN ? " (giữ lại tài nguyên con)" : "");
        });
    }

    // ------------------------------------------------------------------ cronjobs

    public String suspendCronJob(String ns, String name, boolean suspend) {
        return run(suspend ? "suspend" : "resume", "CronJob " + ns + "/" + name, null, () -> {
            existing(client.batch().v1().cronjobs().inNamespace(ns).withName(name), "CronJob", name)
                    .patch(PatchContext.of(PatchType.JSON_MERGE), "{\"spec\":{\"suspend\":" + suspend + "}}");
            return (suspend ? "Đã tạm dừng" : "Đã tiếp tục") + " CronJob " + name;
        });
    }

    /** Like `kubectl create job --from=cronjob/x`. */
    public String triggerCronJob(String ns, String name) {
        return run("trigger", "CronJob " + ns + "/" + name, null, () -> {
            CronJob cj = existing(client.batch().v1().cronjobs().inNamespace(ns).withName(name), "CronJob", name).get();
            String jobName = (name.length() > 44 ? name.substring(0, 44) : name) + "-manual-" + (System.currentTimeMillis() / 1000 % 1_000_000);
            var tmpl = cj.getSpec().getJobTemplate();
            Job job = new JobBuilder()
                    .withNewMetadata().withName(jobName).withNamespace(ns)
                        .withLabels(tmpl.getMetadata() == null ? null : tmpl.getMetadata().getLabels())
                        .addToAnnotations("cronjob.kubernetes.io/instantiate", "manual")
                        .addNewOwnerReference().withApiVersion("batch/v1").withKind("CronJob").withName(name)
                            .withUid(cj.getMetadata().getUid()).withController(true).endOwnerReference()
                    .endMetadata()
                    .withSpec(tmpl.getSpec())
                    .build();
            client.batch().v1().jobs().inNamespace(ns).resource(job).create();
            return "Đã tạo Job " + jobName + " từ CronJob " + name;
        });
    }

    // ------------------------------------------------------------------ configmaps

    public Map<String, Object> readConfigMap(String ns, String name) {
        ConfigMap cm = client.configMaps().inNamespace(ns).withName(name).get();
        if (cm == null) throw new ActionException(404, "ConfigMap " + name + " không tồn tại");
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("name", name);
        out.put("namespace", ns);
        out.put("resourceVersion", cm.getMetadata().getResourceVersion());
        out.put("data", cm.getData() == null ? Map.of() : new TreeMap<>(cm.getData()));
        out.put("binaryKeys", cm.getBinaryData() == null ? List.of() : new TreeSet<>(cm.getBinaryData().keySet()));
        out.put("immutable", Boolean.TRUE.equals(cm.getImmutable()));
        return out;
    }

    public record WorkloadRef(String kind, String name) {}

    /**
     * Replaces the ConfigMap's data. resourceVersion makes it an optimistic update: if someone changed the
     * ConfigMap since the editor loaded it, the API server answers 409 and nothing is overwritten.
     */
    public String updateConfigMap(String ns, String name, String resourceVersion, Map<String, String> data, List<WorkloadRef> restart) {
        Map<String, String> clean = new TreeMap<>(data == null ? Map.of() : data);
        String result = run("edit-configmap", "ConfigMap " + ns + "/" + name, "keys=" + clean.keySet(), () -> {
            ConfigMap current = client.configMaps().inNamespace(ns).withName(name).get();
            if (current == null) throw new ActionException(404, "ConfigMap " + name + " không tồn tại");
            if (Boolean.TRUE.equals(current.getImmutable())) throw new ActionException(409, "ConfigMap này là immutable, không sửa được");
            if (resourceVersion == null || !resourceVersion.equals(current.getMetadata().getResourceVersion()))
                throw new ActionException(409, "ConfigMap vừa bị thay đổi bởi người/tiến trình khác. Hãy mở lại trình sửa để lấy bản mới nhất.");
            ConfigMap updated = new ConfigMapBuilder(current).withData(clean).build();
            try {
                client.configMaps().inNamespace(ns).resource(updated).update();
            } catch (KubernetesClientException e) {
                if (e.getCode() == 409)
                    throw new ActionException(409, "ConfigMap vừa bị thay đổi bởi người/tiến trình khác. Hãy mở lại trình sửa để lấy bản mới nhất.");
                throw e;
            }
            return "Đã lưu ConfigMap " + name;
        });
        List<String> restarted = new ArrayList<>();
        for (WorkloadRef w : restart == null ? List.<WorkloadRef>of() : restart) {
            restart(w.kind(), ns, w.name());
            restarted.add(w.kind() + " " + w.name());
        }
        return restarted.isEmpty() ? result : result + "; đã restart " + String.join(", ", restarted);
    }

    // ------------------------------------------------------------------ helpers

    private <T extends HasMetadata, R extends Resource<T>> R existing(R res, String kind, String name) {
        if (res.get() == null) throw new ActionException(404, kind + " " + name + " không tồn tại");
        return res;
    }

    private String run(String action, String target, String detail, Callable<String> body) {
        String ctx = cache.context();
        try {
            String msg = body.call();
            audit.record(ctx, action, target, detail, null);
            return msg;
        } catch (ActionException e) {
            audit.record(ctx, action, target, detail, e);
            throw e;
        } catch (KubernetesClientException e) {
            String msg = e.getStatus() != null && e.getStatus().getMessage() != null ? e.getStatus().getMessage() : e.getMessage();
            ActionException ae = new ActionException(e.getCode() >= 400 ? e.getCode() : 502, msg);
            audit.record(ctx, action, target, detail, ae);
            throw ae;
        } catch (Exception e) {
            ActionException ae = new ActionException(500, String.valueOf(e.getMessage()));
            audit.record(ctx, action, target, detail, ae);
            throw ae;
        }
    }
}
