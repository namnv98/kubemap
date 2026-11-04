package io.namnv.k8sstudio.actions;

import io.fabric8.kubernetes.api.model.HasMetadata;
import io.fabric8.kubernetes.api.model.Secret;
import io.fabric8.kubernetes.client.KubernetesClient;
import io.fabric8.kubernetes.client.KubernetesClientException;
import io.fabric8.kubernetes.client.utils.KubernetesSerialization;
import io.namnv.k8sstudio.graph.ClusterCache;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.dataformat.yaml.YAMLFactory;
import com.fasterxml.jackson.dataformat.yaml.YAMLGenerator;
import com.fasterxml.jackson.dataformat.yaml.YAMLMapper;
import org.springframework.stereotype.Service;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;

/**
 * Live manifest view/edit, ArgoCD style: YAML of the object as the API server has it now,
 * edited as a whole and saved with a PUT (optimistic lock on resourceVersion).
 * <p>
 * Secret values are masked; a masked value left untouched keeps the stored value on save,
 * so real secret data never reaches the browser.
 */
@Service
public class ManifestService {

    public static final String MASK = "++++++++";
    /** `kubectl apply` stores the whole manifest here — for a Secret that includes the secret values in clear text */
    private static final String LAST_APPLIED = "kubectl.kubernetes.io/last-applied-configuration";

    public record Manifest(String kind, String apiVersion, String namespace, String name, String resourceVersion,
                           String yaml, boolean secret, ManagedBy.Manager manager) {}

    public static final String FIELD_MANAGER = "k8s-studio";

    private final KubernetesClient client;
    private final ClusterCache cache;
    private final AuditLog audit;
    private final KubernetesSerialization ser;
    private final ManagedBy managedBy;
    /** kubectl/ArgoCD-looking YAML: quotes only where needed, multi-line strings as | blocks, no leading --- */
    private static final YAMLMapper YAML = new YAMLMapper(YAMLFactory.builder()
            .enable(YAMLGenerator.Feature.MINIMIZE_QUOTES)
            .enable(YAMLGenerator.Feature.ALWAYS_QUOTE_NUMBERS_AS_STRINGS)
            .enable(YAMLGenerator.Feature.LITERAL_BLOCK_STYLE)
            .enable(YAMLGenerator.Feature.INDENT_ARRAYS_WITH_INDICATOR)
            .disable(YAMLGenerator.Feature.WRITE_DOC_START_MARKER)
            .build());

    public ManifestService(KubernetesClient client, ClusterCache cache, AuditLog audit, ManagedBy managedBy) {
        this.managedBy = managedBy;
        this.client = client;
        this.cache = cache;
        this.audit = audit;
        this.ser = client.getKubernetesSerialization();
    }

    public Manifest read(String kind, String ns, String name) {
        return read(kind, ns, name, false, true);
    }

    /**
     * clean=true drops what the API server / controllers fill in (uid, resourceVersion, timestamps, generation,
     * last-applied and revision annotations), so a comparison shows real differences; status=false drops .status too.
     */
    public Manifest read(String kind, String ns, String name, boolean clean, boolean status) {
        HasMetadata live = fetch(kind, ns, name);
        HasMetadata view = ser.clone(live);
        view.getMetadata().setManagedFields(null);
        if (clean) {
            var m = view.getMetadata();
            m.setUid(null); m.setResourceVersion(null); m.setCreationTimestamp(null); m.setGeneration(null); m.setSelfLink(null);
            if (m.getAnnotations() != null) {
                m.getAnnotations().keySet().removeAll(List.of(LAST_APPLIED, "deployment.kubernetes.io/revision", "deprecated.daemonset.template.generation"));
                if (m.getAnnotations().isEmpty()) m.setAnnotations(null);
            }
            if (m.getOwnerReferences() != null) m.getOwnerReferences().forEach(r -> r.setUid(null));
        }
        boolean secret = view instanceof Secret;
        if (view instanceof Secret s) {
            if (s.getData() != null) s.getData().replaceAll((k, v) -> MASK);
            if (s.getStringData() != null) s.getStringData().replaceAll((k, v) -> MASK);
            if (s.getMetadata().getAnnotations() != null && s.getMetadata().getAnnotations().containsKey(LAST_APPLIED))
                s.getMetadata().getAnnotations().put(LAST_APPLIED, MASK);
        }
        String yaml = toYaml(view);
        if (!status) {
            try {
                @SuppressWarnings("unchecked") Map<String, Object> tree = ser.convertValue(view, Map.class);
                tree.remove("status");
                yaml = YAML.writeValueAsString(tree);
            } catch (JsonProcessingException ignored) {}
        }
        return new Manifest(live.getKind(), live.getApiVersion(), live.getMetadata().getNamespace(), name,
                live.getMetadata().getResourceVersion(), yaml, secret, managedBy.detect(live).orElse(null));
    }

    /**
     * Validates (dryRun) or saves an edited manifest. Returns the new resourceVersion.
     * mode "apply" (default): server-side apply as field manager "k8s-studio" — fields owned by other managers
     *   (HPA, controllers, Argo CD…) are not trampled; changing one of them is a conflict unless force=true.
     * mode "replace": PUT the whole object (what the editor shows is exactly what gets stored).
     */
    public String update(String kind, String ns, String name, String resourceVersion, String yaml, boolean dryRun, String mode, boolean force) {
        boolean apply = !"replace".equals(mode);
        String target = kind + " " + (ns == null || ns.isBlank() ? "" : ns + "/") + name;
        HasMetadata obj;
        try {
            Object parsed = ser.unmarshal(yaml);
            if (!(parsed instanceof HasMetadata h)) throw new ActionService.ActionException(400, "YAML không phải một Kubernetes object");
            obj = h;
        } catch (ActionService.ActionException e) {
            throw e;
        } catch (RuntimeException e) {
            throw new ActionService.ActionException(400, "YAML không hợp lệ: " + rootMessage(e));
        }
        // the edit may not retarget another object
        String objNs = obj.getMetadata() == null ? null : obj.getMetadata().getNamespace();
        if (!kind.equals(obj.getKind()))
            throw new ActionService.ActionException(400, "Không được đổi kind (" + kind + " → " + obj.getKind() + ")");
        if (obj.getMetadata() == null || !name.equals(obj.getMetadata().getName()))
            throw new ActionService.ActionException(400, "Không được đổi metadata.name");
        if (!Objects.equals(blankToNull(ns), blankToNull(objNs)))
            throw new ActionService.ActionException(400, "Không được đổi metadata.namespace");
        // optimistic lock on the version that was loaded, whatever the YAML says
        obj.getMetadata().setResourceVersion(resourceVersion);
        obj.getMetadata().setManagedFields(null);

        HasMetadata live = fetch(kind, ns, name);
        if (obj instanceof Secret edited && live instanceof Secret stored) unmask(edited, stored);

        if (apply && obj.getMetadata() != null) obj.getMetadata().setCreationTimestamp(null);
        if (dryRun) {
            try {
                return save(obj, true, apply, force).getMetadata().getResourceVersion();
            } catch (KubernetesClientException e) {
                throw toAction(e);
            }
        }
        try {
            String rv = save(obj, false, apply, force).getMetadata().getResourceVersion();
            audit.record(cache.context(), apply ? (force ? "apply-force" : "apply") : "replace", target, yaml.length() + " bytes YAML", null);
            return rv;
        } catch (KubernetesClientException e) {
            ActionService.ActionException ae = toAction(e);
            audit.record(cache.context(), "edit-manifest", target, null, ae);
            throw ae;
        }
    }

    private HasMetadata save(HasMetadata obj, boolean dryRun, boolean apply, boolean force) {
        var res = dryRun ? client.resource(obj).dryRun() : client.resource(obj);
        if (!apply) return res.update();
        var ssa = res.fieldManager(FIELD_MANAGER);
        if (force) ssa = ssa.forceConflicts();
        return ssa.serverSideApply();
    }

    /** masked values the user left alone get the stored value back; new/changed keys are taken as typed */
    private static void unmask(Secret edited, Secret stored) {
        if (edited.getData() != null) {
            Map<String, String> data = new LinkedHashMap<>(edited.getData());
            data.replaceAll((k, v) -> MASK.equals(v) ? stored.getData() == null ? null : stored.getData().get(k) : v);
            data.values().removeIf(Objects::isNull);
            edited.setData(data);
        }
        if (edited.getStringData() != null) {
            edited.getStringData().values().removeIf(MASK::equals);
        }
        var ann = edited.getMetadata().getAnnotations();
        if (ann != null && MASK.equals(ann.get(LAST_APPLIED))) {
            String original = stored.getMetadata().getAnnotations() == null ? null : stored.getMetadata().getAnnotations().get(LAST_APPLIED);
            if (original != null) ann.put(LAST_APPLIED, original); else ann.remove(LAST_APPLIED);
        }
    }

    private String toYaml(HasMetadata obj) {
        try {
            // go through the k8s serializer first (Quantity, IntOrString… become plain values), then pretty YAML
            Object tree = ser.convertValue(obj, Map.class);
            return YAML.writeValueAsString(tree);
        } catch (JsonProcessingException e) {
            return ser.asYaml(obj);
        }
    }

    private HasMetadata fetch(String kind, String ns, String name) {
        HasMetadata cached = cache.find(kind, blankToNull(ns), name)
                .orElseThrow(() -> new ActionService.ActionException(404, kind + " " + name + " không tồn tại"));
        HasMetadata live;
        try {
            live = client.resource(cached).get(); // fresh from the API server, not the informer cache
        } catch (KubernetesClientException e) {
            throw toAction(e);
        }
        if (live == null) throw new ActionService.ActionException(404, kind + " " + name + " không tồn tại");
        return live;
    }

    private static ActionService.ActionException toAction(KubernetesClientException e) {
        String raw = e.getStatus() != null && e.getStatus().getMessage() != null ? e.getStatus().getMessage() : "";
        if (e.getCode() == 409 && raw.startsWith("Apply failed"))
            return new ActionService.ActionException(409, "FIELD_CONFLICT: " + raw);
        if (e.getCode() == 409)
            return new ActionService.ActionException(409, "Object vừa bị thay đổi bởi người/tiến trình khác. Mở lại manifest để lấy bản mới nhất.");
        String msg = e.getStatus() != null && e.getStatus().getMessage() != null ? e.getStatus().getMessage() : rootMessage(e);
        return new ActionService.ActionException(e.getCode() >= 400 ? e.getCode() : 502, msg);
    }

    private static String rootMessage(Throwable t) {
        while (t.getCause() != null && t.getCause() != t) t = t.getCause();
        return String.valueOf(t.getMessage());
    }

    private static String blankToNull(String s) {
        return s == null || s.isBlank() ? null : s;
    }
}
