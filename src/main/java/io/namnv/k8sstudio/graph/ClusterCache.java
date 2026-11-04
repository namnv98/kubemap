package io.namnv.k8sstudio.graph;

import io.fabric8.kubernetes.api.model.*;
import io.fabric8.kubernetes.api.model.apiextensions.v1.CustomResourceDefinition;
import io.fabric8.kubernetes.api.model.apiextensions.v1.CustomResourceDefinitionVersion;
import io.fabric8.kubernetes.api.model.apps.DaemonSet;
import io.fabric8.kubernetes.api.model.apps.Deployment;
import io.fabric8.kubernetes.api.model.apps.ReplicaSet;
import io.fabric8.kubernetes.api.model.apps.StatefulSet;
import io.fabric8.kubernetes.api.model.autoscaling.v2.HorizontalPodAutoscaler;
import io.fabric8.kubernetes.api.model.batch.v1.CronJob;
import io.fabric8.kubernetes.api.model.batch.v1.Job;
import io.fabric8.kubernetes.api.model.discovery.v1.EndpointSlice;
import io.fabric8.kubernetes.api.model.networking.v1.Ingress;
import io.fabric8.kubernetes.api.model.networking.v1.IngressClass;
import io.fabric8.kubernetes.api.model.networking.v1.NetworkPolicy;
import io.fabric8.kubernetes.api.model.policy.v1.PodDisruptionBudget;
import io.fabric8.kubernetes.api.model.rbac.ClusterRole;
import io.fabric8.kubernetes.api.model.rbac.ClusterRoleBinding;
import io.fabric8.kubernetes.api.model.rbac.Role;
import io.fabric8.kubernetes.api.model.rbac.RoleBinding;
import io.fabric8.kubernetes.api.model.storage.StorageClass;
import io.fabric8.kubernetes.client.KubernetesClient;
import io.fabric8.kubernetes.client.dsl.Informable;
import io.fabric8.kubernetes.client.dsl.base.ResourceDefinitionContext;
import io.fabric8.kubernetes.client.informers.ResourceEventHandler;
import io.fabric8.kubernetes.client.informers.SharedIndexInformer;
import io.namnv.k8sstudio.cluster.KubeConnection;
import jakarta.annotation.PreDestroy;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.util.*;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;

/**
 * In-memory mirror of the cluster, kept up to date by fabric8 informers (one LIST, then WATCH).
 * Informers retry forever, so the app starts even when the cluster is unreachable and recovers on its own.
 * Custom resources get an informer per CRD, created/removed as CRDs come and go.
 */
@Component
public class ClusterCache {

    private static final Logger log = LoggerFactory.getLogger(ClusterCache.class);

    private final KubernetesClient client;
    private final boolean customResourcesEnabled;
    private final Map<String, SharedIndexInformer<? extends HasMetadata>> informers = new ConcurrentHashMap<>();
    private final Map<String, String> errors = new ConcurrentHashMap<>();
    private final List<Runnable> listeners = new CopyOnWriteArrayList<>();
    /** bumped on every cluster switch; callbacks from the previous cluster's informers are ignored */
    private volatile int generation;

    volatile SharedIndexInformer<Namespace> namespaces;
    volatile SharedIndexInformer<Node> nodes;
    volatile SharedIndexInformer<Pod> pods;
    volatile SharedIndexInformer<Deployment> deployments;
    volatile SharedIndexInformer<ReplicaSet> replicaSets;
    volatile SharedIndexInformer<StatefulSet> statefulSets;
    volatile SharedIndexInformer<DaemonSet> daemonSets;
    volatile SharedIndexInformer<Job> jobs;
    volatile SharedIndexInformer<CronJob> cronJobs;
    volatile SharedIndexInformer<io.fabric8.kubernetes.api.model.Service> services;
    volatile SharedIndexInformer<EndpointSlice> endpointSlices;
    volatile SharedIndexInformer<Ingress> ingresses;
    volatile SharedIndexInformer<IngressClass> ingressClasses;
    volatile SharedIndexInformer<PersistentVolumeClaim> pvcs;
    volatile SharedIndexInformer<PersistentVolume> pvs;
    volatile SharedIndexInformer<StorageClass> storageClasses;
    volatile SharedIndexInformer<ConfigMap> configMaps;
    volatile SharedIndexInformer<Secret> secrets;
    volatile SharedIndexInformer<ServiceAccount> serviceAccounts;
    volatile SharedIndexInformer<Role> roles;
    volatile SharedIndexInformer<RoleBinding> roleBindings;
    volatile SharedIndexInformer<ClusterRole> clusterRoles;
    volatile SharedIndexInformer<ClusterRoleBinding> clusterRoleBindings;
    volatile SharedIndexInformer<HorizontalPodAutoscaler> hpas;
    volatile SharedIndexInformer<PodDisruptionBudget> pdbs;
    volatile SharedIndexInformer<NetworkPolicy> networkPolicies;
    volatile SharedIndexInformer<Event> events;
    volatile SharedIndexInformer<CustomResourceDefinition> crds;
    /** node heartbeats (kube-node-lease), for `describe node`; renewed every ~10s, so they don't trigger graph pushes */
    volatile SharedIndexInformer<io.fabric8.kubernetes.api.model.coordination.v1.Lease> nodeLeases;

    /** CRD name -> informer of its objects. */
    private final Map<String, CustomType> customTypes = new ConcurrentHashMap<>();

    public record CustomType(String crd, String group, String version, String kind, String plural, boolean namespaced,
                             SharedIndexInformer<GenericKubernetesResource> informer) {}

    public ClusterCache(KubernetesClient client, KubeConnection connection,
                        @Value("${k8s-studio.custom-resources.enabled:true}") boolean customResourcesEnabled) {
        this.client = client;
        this.customResourcesEnabled = customResourcesEnabled;
        start();
        connection.onSwitch(this::restart);
    }

    /**
     * Cluster switched (the client proxy already points at the new one): drop every informer and its cached
     * objects, then inform on the new cluster. The UI briefly shows "đang đồng bộ…" while they sync.
     */
    private synchronized void restart() {
        generation++;
        informers.values().forEach(SharedIndexInformer::stop);
        informers.clear();
        customTypes.clear();
        errors.clear();
        start();
        changed();
    }

    private void start() {
        namespaces = inform("namespaces", client.namespaces());
        nodes = inform("nodes", client.nodes());
        pods = inform("pods", client.pods().inAnyNamespace());
        deployments = inform("deployments", client.apps().deployments().inAnyNamespace());
        replicaSets = inform("replicasets", client.apps().replicaSets().inAnyNamespace());
        statefulSets = inform("statefulsets", client.apps().statefulSets().inAnyNamespace());
        daemonSets = inform("daemonsets", client.apps().daemonSets().inAnyNamespace());
        jobs = inform("jobs", client.batch().v1().jobs().inAnyNamespace());
        cronJobs = inform("cronjobs", client.batch().v1().cronjobs().inAnyNamespace());
        services = inform("services", client.services().inAnyNamespace());
        endpointSlices = inform("endpointslices", client.discovery().v1().endpointSlices().inAnyNamespace());
        ingresses = inform("ingresses", client.network().v1().ingresses().inAnyNamespace());
        ingressClasses = inform("ingressclasses", client.network().v1().ingressClasses());
        pvcs = inform("pvcs", client.persistentVolumeClaims().inAnyNamespace());
        pvs = inform("pvs", client.persistentVolumes());
        storageClasses = inform("storageclasses", client.storage().v1().storageClasses());
        configMaps = inform("configmaps", client.configMaps().inAnyNamespace());
        secrets = inform("secrets", client.secrets().inAnyNamespace());
        serviceAccounts = inform("serviceaccounts", client.serviceAccounts().inAnyNamespace());
        roles = inform("roles", client.rbac().roles().inAnyNamespace());
        roleBindings = inform("rolebindings", client.rbac().roleBindings().inAnyNamespace());
        clusterRoles = inform("clusterroles", client.rbac().clusterRoles());
        clusterRoleBindings = inform("clusterrolebindings", client.rbac().clusterRoleBindings());
        hpas = inform("hpas", client.autoscaling().v2().horizontalPodAutoscalers().inAnyNamespace());
        pdbs = inform("pdbs", client.policy().v1().podDisruptionBudget().inAnyNamespace());
        networkPolicies = inform("networkpolicies", client.network().v1().networkPolicies().inAnyNamespace());
        events = inform("events", client.v1().events().inAnyNamespace());
        crds = inform("crds", client.apiextensions().v1().customResourceDefinitions());
        nodeLeases = inform("nodeleases", client.leases().inNamespace("kube-node-lease"), false);
        if (customResourcesEnabled) {
            int gen = generation;
            crds.addEventHandler(new ResourceEventHandler<>() {
                @Override public void onAdd(CustomResourceDefinition crd) { if (gen == generation) syncCustomType(crd); }
                @Override public void onUpdate(CustomResourceDefinition o, CustomResourceDefinition crd) { if (gen == generation) syncCustomType(crd); }
                @Override public void onDelete(CustomResourceDefinition crd, boolean unknown) { if (gen == generation) dropCustomType(crd.getMetadata().getName()); }
            });
        }
    }

    private <T extends HasMetadata> SharedIndexInformer<T> inform(String name, Informable<T> op) {
        return inform(name, op, true);
    }

    private <T extends HasMetadata> SharedIndexInformer<T> inform(String name, Informable<T> op, boolean notify) {
        SharedIndexInformer<T> inf = op.runnableInformer(0);
        int gen = generation;
        if (notify) inf.addEventHandler(new ResourceEventHandler<>() {
            @Override public void onAdd(T obj) { changed(); }
            @Override public void onUpdate(T oldObj, T newObj) { changed(); }
            @Override public void onDelete(T obj, boolean unknownFinalStateUnknown) { changed(); }
        });
        inf.exceptionHandler((started, t) -> {
            if (gen != generation) return false; // informer of a cluster we switched away from
            String msg = t.getCause() != null ? t.getCause().getMessage() : t.getMessage();
            if (!Objects.equals(errors.put(name, msg), msg)) log.warn("informer {} failed: {} (retrying)", name, msg);
            changed();
            return true; // keep retrying with backoff
        });
        informers.put(name, inf);
        inf.start().whenComplete((v, t) -> {
            if (t == null && gen == generation) {
                errors.remove(name);
                log.info("informer {} synced ({} objects)", name, inf.getStore().list().size());
                changed();
            }
        });
        return inf;
    }

    // ------------------------------------------------------------------ custom resources

    private synchronized void syncCustomType(CustomResourceDefinition crd) {
        String name = crd.getMetadata().getName();
        var spec = crd.getSpec();
        String version = spec.getVersions().stream().filter(v -> Boolean.TRUE.equals(v.getStorage()))
                .map(CustomResourceDefinitionVersion::getName).findFirst()
                .orElse(spec.getVersions().get(0).getName());
        CustomType existing = customTypes.get(name);
        if (existing != null && existing.version().equals(version)) return;
        if (existing != null) dropCustomType(name);
        boolean namespaced = "Namespaced".equals(spec.getScope());
        var ctx = new ResourceDefinitionContext.Builder()
                .withGroup(spec.getGroup()).withVersion(version).withKind(spec.getNames().getKind())
                .withPlural(spec.getNames().getPlural()).withNamespaced(namespaced).build();
        var op = client.genericKubernetesResources(ctx);
        SharedIndexInformer<GenericKubernetesResource> inf =
                inform("cr:" + name, namespaced ? op.inAnyNamespace() : op);
        customTypes.put(name, new CustomType(name, spec.getGroup(), version, spec.getNames().getKind(),
                spec.getNames().getPlural(), namespaced, inf));
    }

    private synchronized void dropCustomType(String crdName) {
        CustomType t = customTypes.remove(crdName);
        if (t == null) return;
        t.informer().stop();
        informers.remove("cr:" + crdName);
        errors.remove("cr:" + crdName);
        changed();
    }

    public Collection<CustomType> customTypes() {
        return customTypes.values();
    }

    // ------------------------------------------------------------------ access

    public void changed() {
        listeners.forEach(Runnable::run);
    }

    /** Called (from informer threads) on every change; keep it cheap. */
    public void addListener(Runnable r) {
        listeners.add(r);
    }

    /** Objects of an informer, filtered by namespace (null = all). */
    static <T extends HasMetadata> List<T> list(SharedIndexInformer<T> inf, String ns) {
        if (ns == null) return inf.getStore().list();
        return inf.getStore().list().stream()
                .filter(o -> ns.equals(o.getMetadata().getNamespace()))
                .toList();
    }

    static <T extends HasMetadata> T get(SharedIndexInformer<T> inf, String ns, String name) {
        return inf.getStore().getByKey(ns == null || ns.isEmpty() ? name : ns + "/" + name);
    }

    public List<Secret> secretsIn(String namespace) { return list(secrets, namespace); }

    /** cached objects of a built-in kind, by its model class (namespace null = all) */
    @SuppressWarnings("unchecked")
    public <T extends HasMetadata> List<T> listOf(Class<T> type, String namespace) {
        SharedIndexInformer<? extends HasMetadata> inf = builtin(type.getSimpleName());
        if (inf == null) return List.of();
        return (List<T>) list(inf, namespace);
    }

    public List<ConfigMap> configMapsIn(String namespace) { return list(configMaps, namespace); }

    /** whether objects of this kind are in the cache (so "not found" really means it doesn't exist) */
    public boolean mirrors(String kind) {
        return builtin(kind) != null || customTypes.values().stream().anyMatch(t -> t.kind().equals(kind));
    }

    public Optional<Pod> pod(String namespace, String name) {
        return Optional.ofNullable(get(pods, namespace, name));
    }

    /** Finds any object we mirror by kind / namespace / name (custom resources by kind). */
    public Optional<HasMetadata> find(String kind, String ns, String name) {
        SharedIndexInformer<? extends HasMetadata> inf = builtin(kind);
        if (inf != null) return Optional.ofNullable(get(inf, ns, name));
        for (CustomType t : customTypes.values()) {
            if (t.kind().equals(kind)) {
                HasMetadata o = get(t.informer(), t.namespaced() ? ns : null, name);
                if (o != null) return Optional.of(o);
            }
        }
        return Optional.empty();
    }

    SharedIndexInformer<? extends HasMetadata> builtin(String kind) {
        return switch (kind) {
            case "Namespace" -> namespaces;
            case "Node" -> nodes;
            case "Pod" -> pods;
            case "Deployment" -> deployments;
            case "ReplicaSet" -> replicaSets;
            case "StatefulSet" -> statefulSets;
            case "DaemonSet" -> daemonSets;
            case "Job" -> jobs;
            case "CronJob" -> cronJobs;
            case "Service" -> services;
            case "Ingress" -> ingresses;
            case "IngressClass" -> ingressClasses;
            case "PersistentVolumeClaim" -> pvcs;
            case "PersistentVolume" -> pvs;
            case "StorageClass" -> storageClasses;
            case "ConfigMap" -> configMaps;
            case "Secret" -> secrets;
            case "ServiceAccount" -> serviceAccounts;
            case "Role" -> roles;
            case "RoleBinding" -> roleBindings;
            case "ClusterRole" -> clusterRoles;
            case "ClusterRoleBinding" -> clusterRoleBindings;
            case "HorizontalPodAutoscaler" -> hpas;
            case "PodDisruptionBudget" -> pdbs;
            case "NetworkPolicy" -> networkPolicies;
            default -> null;
        };
    }

    /** Events about one object, newest first. */
    public List<Event> eventsFor(HasMetadata o) {
        String uid = o.getMetadata().getUid(), ns = o.getMetadata().getNamespace(), name = o.getMetadata().getName();
        return events.getStore().list().stream()
                .filter(e -> e.getInvolvedObject() != null)
                .filter(e -> uid != null && uid.equals(e.getInvolvedObject().getUid())
                        || (o.getKind().equals(e.getInvolvedObject().getKind())
                            && name.equals(e.getInvolvedObject().getName())
                            && Objects.equals(ns, e.getInvolvedObject().getNamespace())
                            && e.getInvolvedObject().getUid() == null))
                .sorted(Comparator.comparing(ClusterCache::eventTime).reversed())
                .toList();
    }

    public static String eventTime(Event e) {
        if (e.getLastTimestamp() != null) return e.getLastTimestamp();
        if (e.getEventTime() != null && e.getEventTime().getTime() != null) return e.getEventTime().getTime();
        if (e.getFirstTimestamp() != null) return e.getFirstTimestamp();
        return Objects.requireNonNullElse(e.getMetadata().getCreationTimestamp(), "");
    }

    public List<String> namespaceNames() {
        return namespaces.getStore().list().stream().map(n -> n.getMetadata().getName()).sorted().toList();
    }

    /** Human-readable problems: informers not yet synced / failing. Empty = everything live. */
    public List<String> warnings() {
        List<String> w = new ArrayList<>();
        new TreeMap<>(informers).forEach((name, inf) -> {
            if (inf.hasSynced() && !errors.containsKey(name)) return;
            String err = errors.get(name);
            w.add(name + ": " + (err != null ? err : "đang đồng bộ…"));
        });
        return w;
    }

    public String context() {
        var ctx = client.getConfiguration().getCurrentContext();
        return ctx == null ? null : ctx.getName();
    }

    public KubernetesClient client() {
        return client;
    }

    public boolean customResourcesEnabled() {
        return customResourcesEnabled;
    }

    @PreDestroy
    void stop() {
        informers.values().forEach(SharedIndexInformer::stop);
    }
}
