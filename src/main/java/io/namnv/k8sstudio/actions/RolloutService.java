package io.namnv.k8sstudio.actions;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.dataformat.yaml.YAMLFactory;
import com.fasterxml.jackson.dataformat.yaml.YAMLGenerator;
import com.fasterxml.jackson.dataformat.yaml.YAMLMapper;
import io.fabric8.kubernetes.api.model.HasMetadata;
import io.fabric8.kubernetes.api.model.PodTemplateSpec;
import io.fabric8.kubernetes.api.model.apps.ControllerRevision;
import io.fabric8.kubernetes.api.model.apps.Deployment;
import io.fabric8.kubernetes.api.model.apps.ReplicaSet;
import io.fabric8.kubernetes.client.KubernetesClient;
import io.fabric8.kubernetes.client.dsl.base.PatchContext;
import io.fabric8.kubernetes.client.dsl.base.PatchType;
import io.namnv.k8sstudio.graph.ClusterCache;
import org.springframework.stereotype.Service;

import java.util.*;

/**
 * Rollout history / undo, like `kubectl rollout history|undo|pause|resume`.
 * Deployments keep old pod templates in their ReplicaSets; StatefulSets and DaemonSets in ControllerRevisions.
 */
@Service
public class RolloutService {

    private static final YAMLMapper YAML = new YAMLMapper(YAMLFactory.builder()
            .enable(YAMLGenerator.Feature.MINIMIZE_QUOTES).enable(YAMLGenerator.Feature.ALWAYS_QUOTE_NUMBERS_AS_STRINGS)
            .enable(YAMLGenerator.Feature.LITERAL_BLOCK_STYLE).enable(YAMLGenerator.Feature.INDENT_ARRAYS_WITH_INDICATOR)
            .disable(YAMLGenerator.Feature.WRITE_DOC_START_MARKER).build());
    private static final ObjectMapper JSON = new ObjectMapper();

    public record Revision(long revision, boolean current, String created, String changeCause, List<String> images, String template) {}

    private final KubernetesClient client;
    private final ClusterCache cache;
    private final AuditLog audit;

    public RolloutService(KubernetesClient client, ClusterCache cache, AuditLog audit) {
        this.client = client;
        this.cache = cache;
        this.audit = audit;
    }

    public List<Revision> history(String kind, String ns, String name) {
        List<Revision> out = new ArrayList<>();
        switch (kind) {
            case "Deployment" -> {
                Deployment d = client.apps().deployments().inNamespace(ns).withName(name).get();
                if (d == null) throw new ActionService.ActionException(404, "Deployment " + name + " không tồn tại");
                String cur = ann(d, "deployment.kubernetes.io/revision");
                for (ReplicaSet rs : ownedReplicaSets(d)) {
                    String rev = ann(rs, "deployment.kubernetes.io/revision");
                    if (rev == null) continue;
                    PodTemplateSpec t = cleanTemplate(rs.getSpec().getTemplate());
                    out.add(new Revision(Long.parseLong(rev), rev.equals(cur), rs.getMetadata().getCreationTimestamp(),
                            ann(rs, "kubernetes.io/change-cause"), images(t), yaml(t)));
                }
            }
            case "StatefulSet", "DaemonSet" -> {
                HasMetadata owner = "StatefulSet".equals(kind)
                        ? client.apps().statefulSets().inNamespace(ns).withName(name).get()
                        : client.apps().daemonSets().inNamespace(ns).withName(name).get();
                if (owner == null) throw new ActionService.ActionException(404, kind + " " + name + " không tồn tại");
                List<ControllerRevision> crs = ownedRevisions(owner);
                String curName = owner instanceof io.fabric8.kubernetes.api.model.apps.StatefulSet s && s.getStatus() != null
                        ? s.getStatus().getUpdateRevision() : null;
                long maxRev = crs.stream().mapToLong(c -> c.getRevision() == null ? 0 : c.getRevision()).max().orElse(0);
                for (ControllerRevision cr : crs) {
                    // data is a RawExtension-like value: normalise to a plain map first
                    Object tmpl = path(client.getKubernetesSerialization().convertValue(cr.getData(), Map.class), "spec", "template");
                    boolean current = curName != null ? curName.equals(cr.getMetadata().getName()) : Objects.equals(cr.getRevision(), maxRev);
                    out.add(new Revision(cr.getRevision(), current, cr.getMetadata().getCreationTimestamp(),
                            ann(cr, "kubernetes.io/change-cause"), images(tmpl), yaml(stripTemplate(tmpl))));
                }
            }
            default -> throw new ActionService.ActionException(400, kind + " không có lịch sử rollout");
        }
        out.sort(Comparator.comparingLong(Revision::revision).reversed());
        return out;
    }

    /** `kubectl rollout undo --to-revision=N`: put that revision's pod template back. */
    public String rollback(String kind, String ns, String name, long revision) {
        String target = kind + " " + ns + "/" + name;
        try {
            switch (kind) {
                case "Deployment" -> {
                    Deployment d = client.apps().deployments().inNamespace(ns).withName(name).get();
                    if (d == null) throw new ActionService.ActionException(404, "Deployment " + name + " không tồn tại");
                    ReplicaSet rs = ownedReplicaSets(d).stream()
                            .filter(r -> String.valueOf(revision).equals(ann(r, "deployment.kubernetes.io/revision"))).findFirst()
                            .orElseThrow(() -> new ActionService.ActionException(404, "Không tìm thấy revision " + revision));
                    PodTemplateSpec t = cleanTemplate(rs.getSpec().getTemplate());
                    String patch = JSON.writeValueAsString(List.of(Map.of("op", "replace", "path", "/spec/template",
                            "value", client.getKubernetesSerialization().convertValue(t, Map.class))));
                    client.apps().deployments().inNamespace(ns).withName(name).patch(PatchContext.of(PatchType.JSON), patch);
                }
                case "StatefulSet", "DaemonSet" -> {
                    HasMetadata owner = "StatefulSet".equals(kind)
                            ? client.apps().statefulSets().inNamespace(ns).withName(name).get()
                            : client.apps().daemonSets().inNamespace(ns).withName(name).get();
                    if (owner == null) throw new ActionService.ActionException(404, kind + " " + name + " không tồn tại");
                    ControllerRevision cr = ownedRevisions(owner).stream().filter(c -> Objects.equals(c.getRevision(), revision)).findFirst()
                            .orElseThrow(() -> new ActionService.ActionException(404, "Không tìm thấy revision " + revision));
                    // ControllerRevision.data is the patch kubectl applies on undo
                    String patch = JSON.writeValueAsString(client.getKubernetesSerialization().convertValue(cr.getData(), Map.class));
                    if ("StatefulSet".equals(kind)) client.apps().statefulSets().inNamespace(ns).withName(name).patch(PatchContext.of(PatchType.STRATEGIC_MERGE), patch);
                    else client.apps().daemonSets().inNamespace(ns).withName(name).patch(PatchContext.of(PatchType.STRATEGIC_MERGE), patch);
                }
                default -> throw new ActionService.ActionException(400, kind + " không rollback được");
            }
        } catch (JsonProcessingException e) {
            throw new ActionService.ActionException(500, e.getMessage());
        } catch (ActionService.ActionException e) {
            audit.record(cache.context(), "rollback", target, "revision=" + revision, e);
            throw e;
        } catch (io.fabric8.kubernetes.client.KubernetesClientException e) {
            ActionService.ActionException ae = new ActionService.ActionException(e.getCode() >= 400 ? e.getCode() : 502,
                    e.getStatus() != null && e.getStatus().getMessage() != null ? e.getStatus().getMessage() : e.getMessage());
            audit.record(cache.context(), "rollback", target, "revision=" + revision, ae);
            throw ae;
        }
        audit.record(cache.context(), "rollback", target, "revision=" + revision, null);
        return "Đã rollback " + kind + " " + name + " về revision " + revision;
    }

    public String pause(String ns, String name, boolean paused) {
        String target = "Deployment " + ns + "/" + name;
        try {
            if (client.apps().deployments().inNamespace(ns).withName(name).get() == null)
                throw new ActionService.ActionException(404, "Deployment " + name + " không tồn tại");
            client.apps().deployments().inNamespace(ns).withName(name)
                    .patch(PatchContext.of(PatchType.JSON_MERGE), "{\"spec\":{\"paused\":" + paused + "}}");
        } catch (RuntimeException e) {
            audit.record(cache.context(), paused ? "pause-rollout" : "resume-rollout", target, null, e instanceof Exception ex ? ex : null);
            throw e;
        }
        audit.record(cache.context(), paused ? "pause-rollout" : "resume-rollout", target, null, null);
        return (paused ? "Đã tạm dừng" : "Đã tiếp tục") + " rollout của Deployment " + name;
    }

    // ------------------------------------------------------------------ helpers

    private List<ReplicaSet> ownedReplicaSets(Deployment d) {
        String uid = d.getMetadata().getUid();
        return client.apps().replicaSets().inNamespace(d.getMetadata().getNamespace()).list().getItems().stream()
                .filter(rs -> rs.getMetadata().getOwnerReferences() != null
                        && rs.getMetadata().getOwnerReferences().stream().anyMatch(r -> uid.equals(r.getUid())))
                .toList();
    }

    private List<ControllerRevision> ownedRevisions(HasMetadata owner) {
        String uid = owner.getMetadata().getUid();
        return client.apps().controllerRevisions().inNamespace(owner.getMetadata().getNamespace()).list().getItems().stream()
                .filter(c -> c.getMetadata().getOwnerReferences() != null
                        && c.getMetadata().getOwnerReferences().stream().anyMatch(r -> uid.equals(r.getUid())))
                .toList();
    }

    /** the pod-template-hash label is added by the Deployment controller, not part of what the user wrote */
    private PodTemplateSpec cleanTemplate(PodTemplateSpec t) {
        PodTemplateSpec c = client.getKubernetesSerialization().clone(t);
        if (c.getMetadata() != null && c.getMetadata().getLabels() != null) c.getMetadata().getLabels().remove("pod-template-hash");
        return c;
    }

    @SuppressWarnings("unchecked")
    private static Object stripTemplate(Object tmpl) {
        if (tmpl instanceof Map<?, ?> m) {
            Map<String, Object> copy = new LinkedHashMap<>((Map<String, Object>) m);
            copy.remove("$patch");
            return copy;
        }
        return tmpl;
    }

    private String yaml(Object o) {
        try {
            return YAML.writeValueAsString(o instanceof Map<?, ?> ? o : client.getKubernetesSerialization().convertValue(o, Map.class));
        } catch (JsonProcessingException e) {
            return String.valueOf(o);
        }
    }

    private List<String> images(Object tmpl) {
        Object spec = tmpl instanceof PodTemplateSpec p ? client.getKubernetesSerialization().convertValue(p, Map.class) : tmpl;
        Object containers = path(spec, "spec", "containers");
        List<String> out = new ArrayList<>();
        if (containers instanceof List<?> l) for (Object c : l) if (c instanceof Map<?, ?> cm && cm.get("image") != null) out.add(String.valueOf(cm.get("image")));
        return out;
    }

    private static Object path(Object m, String... keys) {
        Object cur = m;
        for (String k : keys) {
            if (!(cur instanceof Map<?, ?> mm)) return null;
            cur = mm.get(k);
        }
        return cur;
    }

    private static String ann(HasMetadata o, String key) {
        return o.getMetadata().getAnnotations() == null ? null : o.getMetadata().getAnnotations().get(key);
    }
}
