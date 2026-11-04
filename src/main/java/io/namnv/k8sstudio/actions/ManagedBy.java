package io.namnv.k8sstudio.actions;

import io.fabric8.kubernetes.api.model.GenericKubernetesResource;
import io.fabric8.kubernetes.api.model.HasMetadata;
import io.fabric8.kubernetes.api.model.OwnerReference;
import io.namnv.k8sstudio.graph.ClusterCache;
import org.springframework.stereotype.Component;

import java.util.Map;
import java.util.Optional;

/**
 * Who else owns this object? Editing something that Argo CD / Flux / Helm or a controller manages is usually
 * undone at the next sync / reconcile, so the UI warns before such changes.
 */
@Component
public class ManagedBy {

    /** tool: Argo CD | Flux | Helm | controller. revertsQuickly: an automated sync/self-heal will undo edits within seconds. */
    public record Manager(String tool, String name, String note, boolean revertsQuickly) {}

    private final ClusterCache cache;

    public ManagedBy(ClusterCache cache) {
        this.cache = cache;
    }

    public Optional<Manager> detect(HasMetadata o) {
        Map<String, String> labels = nz(o.getMetadata().getLabels()), ann = nz(o.getMetadata().getAnnotations());

        // --- Argo CD: annotation tracking ("app:group/kind:ns/name"), label tracking, or app.kubernetes.io/instance = an existing Application
        String app = null;
        String tracking = ann.get("argocd.argoproj.io/tracking-id");
        if (tracking != null && tracking.contains(":")) app = tracking.substring(0, tracking.indexOf(':'));
        if (app == null) app = labels.get("argocd.argoproj.io/instance");
        String instance = labels.get("app.kubernetes.io/instance");
        Optional<GenericKubernetesResource> application = argoApplication(app != null ? app : instance);
        if (app != null || application.isPresent()) {
            String name = app != null ? app : instance;
            boolean auto = false, selfHeal = false;
            if (application.isPresent()) {
                Object policy = path(application.get().getAdditionalProperties(), "spec", "syncPolicy", "automated");
                auto = policy instanceof Map<?, ?>;
                selfHeal = auto && Boolean.TRUE.equals(((Map<?, ?>) policy).get("selfHeal"));
            }
            String note = selfHeal ? "Application bật auto-sync + self-heal: thay đổi tay sẽ bị hoàn tác gần như ngay lập tức."
                    : auto ? "Application bật auto-sync: thay đổi tay sẽ bị ghi đè ở lần sync tới (khi Git thay đổi)."
                    : "Thay đổi tay sẽ làm app OutOfSync và bị ghi đè ở lần Sync tới.";
            return Optional.of(new Manager("Argo CD", name, note, selfHeal));
        }

        // --- Flux
        String ks = labels.get("kustomize.toolkit.fluxcd.io/name");
        if (ks != null) return Optional.of(new Manager("Flux", labels.getOrDefault("kustomize.toolkit.fluxcd.io/namespace", "") + "/" + ks,
                "Kustomization của Flux sẽ đưa object về đúng như Git ở lần reconcile tới (mặc định vài phút).", false));
        String hr = labels.get("helm.toolkit.fluxcd.io/name");
        if (hr != null) return Optional.of(new Manager("Flux", labels.getOrDefault("helm.toolkit.fluxcd.io/namespace", "") + "/" + hr,
                "HelmRelease của Flux sẽ ghi đè thay đổi ở lần reconcile tới.", false));

        // --- Helm
        String release = ann.get("meta.helm.sh/release-name");
        if (release != null || "Helm".equals(labels.get("app.kubernetes.io/managed-by")))
            return Optional.of(new Manager("Helm", release != null ? release : instance,
                    "Lần `helm upgrade` tới sẽ ghi đè thay đổi tay (Helm 3 có thể giữ lại nếu field đó không có trong chart).", false));

        // --- owned by a controller (Pod of a ReplicaSet, ReplicaSet of a Deployment, Job of a CronJob…)
        for (OwnerReference r : o.getMetadata().getOwnerReferences() == null ? java.util.List.<OwnerReference>of() : o.getMetadata().getOwnerReferences()) {
            if (Boolean.TRUE.equals(r.getController()))
                return Optional.of(new Manager("controller", r.getKind() + "/" + r.getName(),
                        r.getKind() + " " + r.getName() + " quản lý object này — sửa ở đây thường bị controller ghi đè; nên sửa " + r.getKind() + ".", false));
        }
        return Optional.empty();
    }

    private Optional<GenericKubernetesResource> argoApplication(String name) {
        if (name == null) return Optional.empty();
        String short_ = name.contains("_") ? name.substring(name.indexOf('_') + 1) : name; // apps-in-any-namespace: "ns_name"
        return cache.customTypes().stream()
                .filter(t -> "Application".equals(t.kind()) && "argoproj.io".equals(t.group()))
                .flatMap(t -> t.informer().getStore().list().stream())
                .filter(a -> short_.equals(a.getMetadata().getName()))
                .findFirst();
    }

    private static Object path(Map<String, Object> m, String... keys) {
        Object cur = m;
        for (String k : keys) {
            if (!(cur instanceof Map<?, ?> mm)) return null;
            cur = mm.get(k);
        }
        return cur;
    }

    private static Map<String, String> nz(Map<String, String> m) { return m == null ? Map.of() : m; }
}
