package io.namnv.k8sstudio.graph;

import io.fabric8.kubernetes.api.model.*;
import io.fabric8.kubernetes.api.model.apps.DaemonSet;
import io.fabric8.kubernetes.api.model.apps.Deployment;
import io.fabric8.kubernetes.api.model.apps.ReplicaSet;
import io.fabric8.kubernetes.api.model.apps.StatefulSet;
import io.fabric8.kubernetes.api.model.autoscaling.v2.HorizontalPodAutoscaler;
import io.fabric8.kubernetes.api.model.autoscaling.v2.MetricSpec;
import io.fabric8.kubernetes.api.model.batch.v1.CronJob;
import io.fabric8.kubernetes.api.model.batch.v1.Job;
import io.fabric8.kubernetes.api.model.discovery.v1.EndpointSlice;
import io.fabric8.kubernetes.api.model.networking.v1.*;
import io.fabric8.kubernetes.api.model.policy.v1.PodDisruptionBudget;
import io.fabric8.kubernetes.api.model.rbac.*;
import io.fabric8.kubernetes.api.model.storage.StorageClass;
import org.springframework.stereotype.Service;

import java.time.Instant;
import java.util.*;
import java.util.function.Function;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Builds the topology graph of a namespace (or of all namespaces).
 * <p>
 * Relations: ownerReferences (owns), Service→Pod (selects), Ingress→Service (routes), Ingress→Secret (tls),
 * Ingress/PVC→IngressClass/StorageClass (class), Pod→Node (runs-on), Pod→ConfigMap/Secret/PVC (mounts),
 * Pod/ServiceAccount→Secret (pulls), Pod→ServiceAccount (runs-as), PVC→PV (binds), StatefulSet→Service (uses),
 * RoleBinding→Role (grants), RoleBinding→ServiceAccount (subject), HPA→workload (scales), PDB→Pod (protects),
 * NetworkPolicy→Pod (applies), IngressClass→controller Deployment/DaemonSet (controller, matched heuristically).
 * <p>
 * References to objects that don't exist become "missing" nodes so broken config is visible.
 */
@Service
public class GraphService {

    private static final Set<String> ERROR_REASONS = Set.of(
            "CrashLoopBackOff", "ImagePullBackOff", "ErrImagePull", "CreateContainerConfigError",
            "CreateContainerError", "InvalidImageName", "OOMKilled", "Error", "RunContainerError");
    /** Auto-injected into every namespace; mounted by every pod -> pure noise in the diagram. */
    private static final String KUBE_ROOT_CA = "kube-root-ca.crt";
    private static final Set<String> HIDDEN_SECRET_TYPES = Set.of("kubernetes.io/service-account-token", "helm.sh/release.v1");
    private static final long EVENT_WINDOW_MS = 60 * 60 * 1000;
    private static final Pattern SCHED = Pattern.compile("(?:\\d+ )?(Insufficient [\\w./-]+|node\\(s\\) [^,.]+|[^:,.]*taint[^,.]*)");
    private static final Set<String> PRESSURE = Set.of("MemoryPressure", "DiskPressure", "PIDPressure", "NetworkUnavailable");

    private final ClusterCache cache;
    private final MetricsCache metrics;

    public GraphService(ClusterCache cache, MetricsCache metrics) {
        this.cache = cache;
        this.metrics = metrics;
    }

    public List<String> namespaces() {
        return cache.namespaceNames();
    }

    public Graph build(String namespace) {
        boolean all = namespace == null || namespace.isBlank() || "*".equals(namespace);
        String ns = all ? null : namespace;
        Builder g = new Builder(latestWarnings());

        List<Pod> pods = ClusterCache.list(cache.pods, ns);
        Map<String, io.fabric8.kubernetes.api.model.Node> k8sNodes = new HashMap<>();
        cache.nodes.getStore().list().forEach(n -> k8sNodes.put(n.getMetadata().getName(), n));

        workloads(g, ns, pods);
        for (Pod p : pods) pod(g, p, k8sNodes);
        k8sNodes.values().forEach(n -> node(g, n)); // every node, in every view: the UI shows them in the node bar
        configAndStorage(g, ns, all);
        services(g, ns, pods);
        ingresses(g, ns);
        rbac(g, ns, all);
        policies(g, ns, pods);
        Map<String, int[]> eps = endpointCounts();
        quotas(g, ns);
        replicationControllers(g, ns);
        classes(g, all, pods);
        admission(g, ns, all, eps);
        apiServices(g, ns, all);
        csrs(g, all);
        csi(g, all);
        leases(g, ns, pods);
        customResources(g, ns);
        owners(g);
        workloadMetrics(g, pods);
        markUnused(g);

        return g.build(cache.context(), cache.warnings(), metrics.available());
    }

    // ================================================================== workloads

    private void workloads(Builder g, String ns, List<Pod> pods) {
        Set<String> podOwners = new HashSet<>();
        pods.forEach(p -> nz(p.getMetadata().getOwnerReferences()).forEach(r -> podOwners.add(r.getUid())));

        for (Deployment d : ClusterCache.list(cache.deployments, ns)) {
            int desired = nz(d.getSpec().getReplicas());
            var st = d.getStatus();
            int ready = st == null ? 0 : nz(st.getReadyReplicas());
            String reason = null;
            if (st != null) {
                var failure = condition(st.getConditions(), DeploymentConditionView::of, "ReplicaFailure", "True");
                var progressing = condition(st.getConditions(), DeploymentConditionView::of, "Progressing", "False");
                if (failure != null) reason = shortMsg(failure.message());
                else if (progressing != null) reason = progressing.reason();
            }
            Map<String, String> info = new LinkedHashMap<>();
            info.put("replicas", ready + "/" + desired);
            if (st != null) info.put("updated", nz(st.getUpdatedReplicas()) + "/" + desired);
            info.put("strategy", d.getSpec().getStrategy() == null ? "RollingUpdate" : d.getSpec().getStrategy().getType());
            info.put("images", images(d.getSpec().getTemplate()));
            boolean paused = Boolean.TRUE.equals(d.getSpec().getPaused());
            if (paused) info.put("paused", "true");
            g.node(d, ready + "/" + desired + (paused ? " · paused" : ""), paused ? "warn" : replicaHealth(ready, desired),
                    paused ? "rollout đang tạm dừng" : reason, info);
        }
        for (ReplicaSet rs : ClusterCache.list(cache.replicaSets, ns)) {
            int desired = nz(rs.getSpec().getReplicas());
            if (desired == 0 && !podOwners.contains(rs.getMetadata().getUid())) continue; // old revisions
            int ready = rs.getStatus() == null ? 0 : nz(rs.getStatus().getReadyReplicas());
            String reason = null;
            if (rs.getStatus() != null) {
                var failure = condition(rs.getStatus().getConditions(), ReplicaSetConditionView::of, "ReplicaFailure", "True");
                if (failure != null) reason = shortMsg(failure.message());
            }
            g.node(rs, ready + "/" + desired, replicaHealth(ready, desired), reason,
                    Map.of("images", images(rs.getSpec().getTemplate())));
        }
        for (StatefulSet s : ClusterCache.list(cache.statefulSets, ns)) {
            int desired = nz(s.getSpec().getReplicas());
            int ready = s.getStatus() == null ? 0 : nz(s.getStatus().getReadyReplicas());
            Map<String, String> info = new LinkedHashMap<>();
            info.put("replicas", ready + "/" + desired);
            info.put("serviceName", String.valueOf(s.getSpec().getServiceName()));
            info.put("images", images(s.getSpec().getTemplate()));
            String id = g.node(s, ready + "/" + desired, replicaHealth(ready, desired), null, info);
            String svc = s.getSpec().getServiceName();
            if (svc != null && !svc.isBlank()) {
                g.ref(id, "Service", s.getMetadata().getNamespace(), svc, "uses",
                        ClusterCache.get(cache.services, s.getMetadata().getNamespace(), svc) != null, "warn",
                        "Headless service của StatefulSet không tồn tại");
            }
        }
        for (DaemonSet ds : ClusterCache.list(cache.daemonSets, ns)) {
            var st = ds.getStatus();
            int desired = st == null ? 0 : nz(st.getDesiredNumberScheduled());
            int ready = st == null ? 0 : nz(st.getNumberReady());
            Map<String, String> info = new LinkedHashMap<>();
            info.put("ready", ready + "/" + desired);
            if (st != null && nz(st.getNumberMisscheduled()) > 0) info.put("misscheduled", "" + st.getNumberMisscheduled());
            info.put("images", images(ds.getSpec().getTemplate()));
            g.node(ds, ready + "/" + desired, replicaHealth(ready, desired), null, info);
        }
        for (CronJob cj : ClusterCache.list(cache.cronJobs, ns)) {
            boolean suspended = Boolean.TRUE.equals(cj.getSpec().getSuspend());
            Map<String, String> info = new LinkedHashMap<>();
            info.put("schedule", String.valueOf(cj.getSpec().getSchedule()));
            if (cj.getStatus() != null && cj.getStatus().getLastScheduleTime() != null)
                info.put("lastSchedule", cj.getStatus().getLastScheduleTime());
            if (cj.getStatus() != null && cj.getStatus().getLastSuccessfulTime() != null)
                info.put("lastSuccess", cj.getStatus().getLastSuccessfulTime());
            info.put("active", "" + (cj.getStatus() == null ? 0 : nz(cj.getStatus().getActive()).size()));
            g.node(cj, suspended ? "Suspended" : cj.getSpec().getSchedule(), suspended ? "warn" : "ok",
                    suspended ? "đã tạm dừng" : null, info);
        }
        for (Job j : ClusterCache.list(cache.jobs, ns)) {
            var st = j.getStatus();
            int failed = st == null ? 0 : nz(st.getFailed());
            int succeeded = st == null ? 0 : nz(st.getSucceeded());
            int active = st == null ? 0 : nz(st.getActive());
            var failedCond = st == null ? null : condition(st.getConditions(), JobConditionView::of, "Failed", "True");
            var complete = st == null ? null : condition(st.getConditions(), JobConditionView::of, "Complete", "True");
            String status = complete != null ? "Complete" : failedCond != null ? "Failed"
                    : active > 0 ? "Running" : succeeded > 0 ? "Complete" : failed > 0 ? "Failed" : "Pending";
            String health = "Failed".equals(status) ? "error" : "Running".equals(status) || "Pending".equals(status) ? "warn" : "ok";
            if ("Running".equals(status) && failed == 0) health = "ok";
            Map<String, String> info = new LinkedHashMap<>();
            info.put("succeeded", "" + succeeded);
            info.put("failed", "" + failed);
            if (st != null && st.getCompletionTime() != null) info.put("completed", st.getCompletionTime());
            g.node(j, status, health, failedCond == null ? null : failedCond.reason(), info);
        }
    }

    // ================================================================== pods

    private void pod(Builder g, Pod p, Map<String, io.fabric8.kubernetes.api.model.Node> k8sNodes) {
        String[] sh = podStatus(p);
        Map<String, String> info = new LinkedHashMap<>();
        if (p.getStatus() != null && p.getStatus().getPodIP() != null) info.put("podIP", p.getStatus().getPodIP());
        if (p.getSpec().getNodeName() != null) info.put("node", p.getSpec().getNodeName());
        // like kubectl's READY column: ready / total app containers (init containers are listed apart)
        List<Container> appCtrs = nz(p.getSpec().getContainers());
        long readyCtrs = p.getStatus() == null ? 0 : nz(p.getStatus().getContainerStatuses()).stream().filter(cs -> Boolean.TRUE.equals(cs.getReady())).count();
        info.put("ready", readyCtrs + "/" + appCtrs.size());
        int inits = nz(p.getSpec().getInitContainers()).size();
        info.put("containers", appCtrs.stream().map(Container::getName).reduce((a, b) -> a + ", " + b).orElse("") + (inits > 0 ? " +" + inits + " init" : ""));
        info.put("restarts", String.valueOf(restarts(p)));
        if (p.getStatus() != null && p.getStatus().getQosClass() != null) info.put("qos", p.getStatus().getQosClass());
        var usage = metrics.pod(p.getMetadata().getNamespace(), p.getMetadata().getName());
        if (usage != null) {
            info.put("cpu", MetricsCache.cpu(usage.cpuMilli()));
            info.put("memory", MetricsCache.mem(usage.memBytes()));
        }
        String id = g.node(p, sh[0], sh[1], podReason(p, sh[0]), info);
        String pns = p.getMetadata().getNamespace();

        // pod -> node
        String nodeName = p.getSpec().getNodeName();
        if (nodeName != null) {
            var kn = k8sNodes.get(nodeName);
            String nid = kn == null ? g.missing("Node", null, nodeName, "error", "Node không còn tồn tại") : node(g, kn);
            g.edge(id, nid, "runs-on");
        }

        // pod -> service account
        String sa = Objects.requireNonNullElse(p.getSpec().getServiceAccountName(), "default");
        g.ref(id, "ServiceAccount", pns, sa, "runs-as",
                ClusterCache.get(cache.serviceAccounts, pns, sa) != null, "error", "ServiceAccount không tồn tại");

        // pod -> PriorityClass / RuntimeClass (a missing RuntimeClass keeps the pod from starting)
        String pcName = p.getSpec().getPriorityClassName();
        if (pcName != null && !pcName.isBlank())
            g.ref(id, "PriorityClass", null, pcName, "priority", ClusterCache.get(cache.priorityClasses, null, pcName) != null, "error", "PriorityClass không tồn tại");
        String rcName = p.getSpec().getRuntimeClassName();
        if (rcName != null && !rcName.isBlank())
            g.ref(id, "RuntimeClass", null, rcName, "runtime", ClusterCache.get(cache.runtimeClasses, null, rcName) != null, "error", "RuntimeClass không tồn tại — pod không khởi động được");

        // pod -> image pull secrets
        for (LocalObjectReference ref : nz(p.getSpec().getImagePullSecrets())) {
            if (ref.getName() == null) continue;
            g.ref(id, "Secret", pns, ref.getName(), "pulls",
                    ClusterCache.get(cache.secrets, pns, ref.getName()) != null, "warn", "imagePullSecret không tồn tại");
        }

        // pod -> configmap / secret / pvc
        for (Volume v : nz(p.getSpec().getVolumes())) {
            if (v.getConfigMap() != null) cm(g, id, pns, v.getConfigMap().getName(), v.getConfigMap().getOptional());
            if (v.getSecret() != null) secret(g, id, pns, v.getSecret().getSecretName(), v.getSecret().getOptional());
            if (v.getPersistentVolumeClaim() != null) {
                String claim = v.getPersistentVolumeClaim().getClaimName();
                g.ref(id, "PersistentVolumeClaim", pns, claim, "mounts",
                        ClusterCache.get(cache.pvcs, pns, claim) != null, "error", "PVC không tồn tại");
            }
            if (v.getProjected() != null) {
                for (VolumeProjection src : nz(v.getProjected().getSources())) {
                    if (src.getConfigMap() != null) cm(g, id, pns, src.getConfigMap().getName(), src.getConfigMap().getOptional());
                    if (src.getSecret() != null) secret(g, id, pns, src.getSecret().getName(), src.getSecret().getOptional());
                }
            }
        }
        List<Container> containers = new ArrayList<>(nz(p.getSpec().getContainers()));
        containers.addAll(nz(p.getSpec().getInitContainers()));
        for (Container c : containers) {
            for (EnvFromSource ef : nz(c.getEnvFrom())) {
                if (ef.getConfigMapRef() != null) cm(g, id, pns, ef.getConfigMapRef().getName(), ef.getConfigMapRef().getOptional());
                if (ef.getSecretRef() != null) secret(g, id, pns, ef.getSecretRef().getName(), ef.getSecretRef().getOptional());
            }
            for (EnvVar ev : nz(c.getEnv())) {
                var vf = ev.getValueFrom();
                if (vf == null) continue;
                if (vf.getConfigMapKeyRef() != null) cm(g, id, pns, vf.getConfigMapKeyRef().getName(), vf.getConfigMapKeyRef().getOptional());
                if (vf.getSecretKeyRef() != null) secret(g, id, pns, vf.getSecretKeyRef().getName(), vf.getSecretKeyRef().getOptional());
            }
        }
    }

    private void cm(Builder g, String from, String ns, String name, Boolean optional) {
        if (name == null || KUBE_ROOT_CA.equals(name)) return;
        g.ref(from, "ConfigMap", ns, name, "mounts", ClusterCache.get(cache.configMaps, ns, name) != null,
                Boolean.TRUE.equals(optional) ? "unknown" : "error", "ConfigMap không tồn tại" + (Boolean.TRUE.equals(optional) ? " (optional)" : ""));
    }

    private void secret(Builder g, String from, String ns, String name, Boolean optional) {
        if (name == null) return;
        g.ref(from, "Secret", ns, name, "mounts", ClusterCache.get(cache.secrets, ns, name) != null,
                Boolean.TRUE.equals(optional) ? "unknown" : "error", "Secret không tồn tại" + (Boolean.TRUE.equals(optional) ? " (optional)" : ""));
    }

    private String node(Builder g, io.fabric8.kubernetes.api.model.Node n) {
        String id = Builder.id(n);
        if (g.nodes.containsKey(id)) return id;
        boolean ready = nodeReady(n);
        boolean cordoned = Boolean.TRUE.equals(n.getSpec().getUnschedulable());
        List<String> pressure = n.getStatus() == null ? List.of() : nz(n.getStatus().getConditions()).stream()
                .filter(c -> PRESSURE.contains(c.getType()) && "True".equals(c.getStatus())).map(NodeCondition::getType).toList();
        Map<String, String> info = new LinkedHashMap<>();
        String roles = nz(n.getMetadata().getLabels()).keySet().stream()
                .filter(k -> k.startsWith("node-role.kubernetes.io/")).map(k -> k.substring(24)).sorted()
                .reduce((a, b) -> a + "," + b).orElse("worker");
        info.put("roles", roles);
        if (n.getStatus() != null) {
            nz(n.getStatus().getAddresses()).stream().filter(a -> "InternalIP".equals(a.getType()))
                    .findFirst().ifPresent(a -> info.put("internalIP", a.getAddress()));
            if (n.getStatus().getNodeInfo() != null) info.put("kubelet", n.getStatus().getNodeInfo().getKubeletVersion());
            var alloc = n.getStatus().getAllocatable();
            var u = metrics.node(n.getMetadata().getName());
            if (alloc != null) {
                long cpuAlloc = milli(alloc.get("cpu")), memAlloc = bytes(alloc.get("memory"));
                if (u != null && cpuAlloc > 0) info.put("cpuPct", String.valueOf(u.cpuMilli() * 100 / cpuAlloc));
                if (u != null && memAlloc > 0) info.put("memPct", String.valueOf(u.memBytes() * 100 / memAlloc));
                info.put("cpu", (u != null ? MetricsCache.cpu(u.cpuMilli()) + " / " : "") + MetricsCache.cpu(cpuAlloc)
                        + (u != null && cpuAlloc > 0 ? " (" + u.cpuMilli() * 100 / cpuAlloc + "%)" : ""));
                info.put("memory", (u != null ? MetricsCache.mem(u.memBytes()) + " / " : "") + MetricsCache.mem(memAlloc)
                        + (u != null && memAlloc > 0 ? " (" + u.memBytes() * 100 / memAlloc + "%)" : ""));
            }
        }
        int taints = nz(n.getSpec().getTaints()).size();
        if (taints > 0) info.put("taints", "" + taints);
        String status = !ready ? "NotReady" : cordoned ? "Ready, cordoned" : "Ready";
        String health = !ready ? "error" : !pressure.isEmpty() || cordoned ? "warn" : "ok";
        String reason = !pressure.isEmpty() ? String.join(", ", pressure) : cordoned ? "không nhận pod mới" : null;
        return g.node(n, status, health, reason, info);
    }

    // ================================================================== config & storage

    private void configAndStorage(Builder g, String ns, boolean all) {
        for (ConfigMap c : ClusterCache.list(cache.configMaps, ns)) {
            if (KUBE_ROOT_CA.equals(c.getMetadata().getName())) continue;
            int keys = nz(c.getData()).size() + (c.getBinaryData() == null ? 0 : c.getBinaryData().size());
            g.nodeIfAbsentOrPlaceholder(c, keys + " keys", "ok", null, Map.of("keys", "" + keys));
        }
        for (Secret s : ClusterCache.list(cache.secrets, ns)) {
            if (HIDDEN_SECRET_TYPES.contains(s.getType())) continue;
            int keys = nz(s.getData()).size();
            g.nodeIfAbsentOrPlaceholder(s, shortType(s.getType()), "ok", null, Map.of("type", String.valueOf(s.getType()), "keys", "" + keys));
        }
        for (PersistentVolumeClaim pvc : ClusterCache.list(cache.pvcs, ns)) {
            String phase = pvc.getStatus() == null ? "Unknown" : pvc.getStatus().getPhase();
            Map<String, String> info = new LinkedHashMap<>();
            String sc = pvc.getSpec().getStorageClassName();
            info.put("storageClass", String.valueOf(sc));
            if (pvc.getSpec().getResources() != null && pvc.getSpec().getResources().getRequests() != null
                    && pvc.getSpec().getResources().getRequests().get("storage") != null)
                info.put("request", pvc.getSpec().getResources().getRequests().get("storage").toString());
            if (pvc.getStatus() != null && pvc.getStatus().getCapacity() != null && pvc.getStatus().getCapacity().get("storage") != null)
                info.put("capacity", pvc.getStatus().getCapacity().get("storage").toString());
            info.put("accessModes", String.join(",", nz(pvc.getSpec().getAccessModes())));
            String health = "Bound".equals(phase) ? "ok" : "Lost".equals(phase) ? "error" : "warn";
            String id = g.node(pvc, phase, health, null, info);
            if (sc != null && !sc.isBlank()) {
                var cls = ClusterCache.get(cache.storageClasses, null, sc);
                if (cls != null) storageClass(g, cls);
                g.ref(id, "StorageClass", null, sc, "class", cls != null, "warn", "StorageClass không tồn tại");
            }
            String pvName = pvc.getSpec().getVolumeName();
            if (pvName != null && !pvName.isBlank()) {
                var pv = ClusterCache.get(cache.pvs, null, pvName);
                if (pv != null) pv(g, pv);
                g.ref(id, "PersistentVolume", null, pvName, "binds", pv != null, "error", "PV không tồn tại");
            }
        }
        if (all) { // unbound / released PVs only show up in the cluster-wide view
            for (PersistentVolume pv : cache.pvs.getStore().list()) pv(g, pv);
        }
    }

    private void pv(Builder g, PersistentVolume pv) {
        if (g.nodes.containsKey(Builder.id(pv))) return;
        String phase = pv.getStatus() == null ? "Unknown" : pv.getStatus().getPhase();
        Map<String, String> info = new LinkedHashMap<>();
        if (pv.getSpec().getCapacity() != null && pv.getSpec().getCapacity().get("storage") != null)
            info.put("capacity", pv.getSpec().getCapacity().get("storage").toString());
        info.put("reclaimPolicy", String.valueOf(pv.getSpec().getPersistentVolumeReclaimPolicy()));
        if (pv.getSpec().getClaimRef() != null)
            info.put("claim", pv.getSpec().getClaimRef().getNamespace() + "/" + pv.getSpec().getClaimRef().getName());
        String health = "Bound".equals(phase) || "Available".equals(phase) ? "ok" : "Failed".equals(phase) ? "error" : "warn";
        String id = g.node(pv, phase, health, "Released".equals(phase) ? "PVC đã bị xoá" : null, info);
        String sc = pv.getSpec().getStorageClassName();
        if (sc != null && !sc.isBlank()) {
            var cls = ClusterCache.get(cache.storageClasses, null, sc);
            if (cls != null) { storageClass(g, cls); g.edge(id, Builder.id(cls), "class"); }
        }
    }

    private void storageClass(Builder g, StorageClass sc) {
        if (g.nodes.containsKey(Builder.id(sc))) return;
        boolean isDefault = "true".equals(nz(sc.getMetadata().getAnnotations()).get("storageclass.kubernetes.io/is-default-class"));
        Map<String, String> info = new LinkedHashMap<>();
        info.put("provisioner", sc.getProvisioner());
        info.put("reclaimPolicy", String.valueOf(sc.getReclaimPolicy()));
        info.put("bindingMode", String.valueOf(sc.getVolumeBindingMode()));
        g.node(sc, isDefault ? "default · " + sc.getProvisioner() : sc.getProvisioner(), "ok", null, info);
    }

    // ================================================================== networking

    private void services(Builder g, String ns, List<Pod> pods) {
        // EndpointSlices by "ns/service-name"
        Map<String, int[]> endpoints = new HashMap<>(); // [ready, total]
        for (EndpointSlice es : ClusterCache.list(cache.endpointSlices, ns)) {
            String svc = nz(es.getMetadata().getLabels()).get("kubernetes.io/service-name");
            if (svc == null) continue;
            int[] c = endpoints.computeIfAbsent(es.getMetadata().getNamespace() + "/" + svc, k -> new int[2]);
            for (var ep : nz(es.getEndpoints())) {
                c[1]++;
                if (ep.getConditions() == null || !Boolean.FALSE.equals(ep.getConditions().getReady())) c[0]++;
            }
        }
        for (var svc : ClusterCache.list(cache.services, ns)) {
            String type = svc.getSpec().getType();
            String sns = svc.getMetadata().getNamespace();
            Map<String, String> info = new LinkedHashMap<>();
            info.put("type", type);
            if (svc.getSpec().getClusterIP() != null) info.put("clusterIP", svc.getSpec().getClusterIP());
            if ("ExternalName".equals(type)) info.put("externalName", svc.getSpec().getExternalName());
            info.put("ports", ports(svc));
            // the same, one field per column (port / target / protocol / nodePort), in port order
            List<ServicePort> sps = nz(svc.getSpec().getPorts());
            if (!sps.isEmpty()) {
                info.put("port", sps.stream().map(sp -> String.valueOf(sp.getPort())).reduce((a, b) -> a + ", " + b).orElse(""));
                info.put("targetPort", sps.stream().map(sp -> sp.getTargetPort() == null ? String.valueOf(sp.getPort())
                        : sp.getTargetPort().getIntVal() != null ? String.valueOf(sp.getTargetPort().getIntVal()) : sp.getTargetPort().getStrVal()).reduce((a, b) -> a + ", " + b).orElse(""));
                info.put("protocol", sps.stream().map(sp -> Objects.requireNonNullElse(sp.getProtocol(), "TCP")).distinct().reduce((a, b) -> a + ", " + b).orElse(""));
                String nodePorts = sps.stream().filter(sp -> sp.getNodePort() != null).map(sp -> String.valueOf(sp.getNodePort())).reduce((a, b) -> a + ", " + b).orElse(null);
                if (nodePorts != null) info.put("nodePort", nodePorts);
            }
            if (svc.getStatus() != null && svc.getStatus().getLoadBalancer() != null) {
                String lb = nz(svc.getStatus().getLoadBalancer().getIngress()).stream()
                        .map(i -> i.getIp() != null ? i.getIp() : i.getHostname()).filter(Objects::nonNull)
                        .reduce((a, b) -> a + ", " + b).orElse(null);
                if (lb != null) info.put("loadBalancer", lb);
            }
            Map<String, String> selector = svc.getSpec().getSelector();
            String id = Builder.id(svc);
            int matched = 0;
            if (selector != null && !selector.isEmpty()) {
                info.put("selector", selector.entrySet().stream().map(e -> e.getKey() + "=" + e.getValue()).sorted()
                        .reduce((a, b) -> a + ", " + b).orElse(""));
                for (Pod p : pods) {
                    if (!Objects.equals(p.getMetadata().getNamespace(), sns)) continue;
                    if (nz(p.getMetadata().getLabels()).entrySet().containsAll(selector.entrySet())) {
                        g.edge(id, Builder.id(p), "selects");
                        matched++;
                    }
                }
            }
            int[] ep = endpoints.getOrDefault(sns + "/" + svc.getMetadata().getName(), new int[2]);
            String status = type, health = "ok", reason = null;
            if ("ExternalName".equals(type)) {
                status = "ExternalName";
            } else if (selector != null && !selector.isEmpty()) {
                info.put("endpoints", ep[0] + "/" + ep[1] + " sẵn sàng");
                status = type + " · " + ep[0] + "/" + ep[1] + " endpoint";
                if (matched == 0) { health = "warn"; reason = "không pod nào khớp selector"; }
                else if (ep[0] == 0) { health = "error"; reason = "không có endpoint sẵn sàng"; }
                else if (ep[0] < ep[1]) { health = "warn"; reason = (ep[1] - ep[0]) + " endpoint chưa sẵn sàng"; }
            } else if (ep[1] > 0) {
                info.put("endpoints", ep[0] + "/" + ep[1] + " sẵn sàng (thủ công)");
            }
            g.node(svc, status, health, reason, info);
        }
    }

    private void ingresses(Builder g, String ns) {
        for (Ingress ing : ClusterCache.list(cache.ingresses, ns)) {
            String ins = ing.getMetadata().getNamespace();
            Map<String, String> info = new LinkedHashMap<>();
            List<String> hosts = new ArrayList<>();
            for (IngressRule r : nz(ing.getSpec().getRules())) if (r.getHost() != null) hosts.add(r.getHost());
            info.put("hosts", hosts.isEmpty() ? "*" : String.join(", ", hosts));
            String cls = ing.getSpec().getIngressClassName();
            if (cls == null) cls = nz(ing.getMetadata().getAnnotations()).get("kubernetes.io/ingress.class");
            if (cls != null) info.put("class", cls);
            if (ing.getStatus() != null && ing.getStatus().getLoadBalancer() != null) {
                String lb = nz(ing.getStatus().getLoadBalancer().getIngress()).stream()
                        .map(i -> i.getIp() != null ? i.getIp() : i.getHostname()).filter(Objects::nonNull)
                        .reduce((a, b) -> a + ", " + b).orElse(null);
                if (lb != null) info.put("address", lb);
            }
            if (!nz(ing.getSpec().getTls()).isEmpty()) info.put("tls", "có");
            String id = g.node(ing, hosts.isEmpty() ? "*" : String.join(", ", hosts), "ok", null, info);

            List<IngressBackend> backends = new ArrayList<>();
            if (ing.getSpec().getDefaultBackend() != null) backends.add(ing.getSpec().getDefaultBackend());
            for (IngressRule r : nz(ing.getSpec().getRules()))
                if (r.getHttp() != null) nz(r.getHttp().getPaths()).forEach(pth -> backends.add(pth.getBackend()));
            boolean broken = false;
            for (IngressBackend b : backends) {
                if (b == null || b.getService() == null) continue;
                String svc = b.getService().getName();
                boolean exists = ClusterCache.get(cache.services, ins, svc) != null;
                broken |= !exists;
                g.ref(id, "Service", ins, svc, "routes", exists, "error", "Service không tồn tại");
            }
            for (IngressTLS tls : nz(ing.getSpec().getTls())) {
                if (tls.getSecretName() == null) continue;
                g.ref(id, "Secret", ins, tls.getSecretName(), "tls",
                        ClusterCache.get(cache.secrets, ins, tls.getSecretName()) != null, "warn", "Secret TLS không tồn tại");
            }
            if (cls != null) {
                IngressClass ic = ClusterCache.get(cache.ingressClasses, null, cls);
                if (ic != null && !g.nodes.containsKey(Builder.id(ic))) {
                    boolean def = "true".equals(nz(ic.getMetadata().getAnnotations()).get("ingressclass.kubernetes.io/is-default-class"));
                    g.node(ic, (def ? "default · " : "") + ic.getSpec().getController(), "ok", null,
                            Map.of("controller", String.valueOf(ic.getSpec().getController())));
                    ingressController(g, ic);
                }
                g.ref(id, "IngressClass", null, cls, "class", ic != null, "warn", "IngressClass không tồn tại");
            }
            if (broken) g.update(id, "error", "backend không tồn tại");
        }
    }

    /**
     * IngressClass → the workload that serves it. Kubernetes records no such link (only spec.controller, e.g.
     * "traefik.io/ingress-controller"), so known controllers are recognised by their pod-template labels and flags:
     * an explicit --controller-class / --ingress-class / --providers.kubernetesingress.ingressclass flag must match,
     * otherwise the well-known app.kubernetes.io/name label of that controller is enough. Unknown controllers: no edge.
     * The workload may live in another namespace (kube-system…): it is added to the view so the chain stays visible.
     */
    private void ingressController(Builder g, IngressClass ic) {
        String controller = ic.getSpec().getController(), cls = ic.getMetadata().getName();
        if (controller == null) return;
        List<HasMetadata> workloads = new ArrayList<>();
        workloads.addAll(ClusterCache.list(cache.deployments, null));
        workloads.addAll(ClusterCache.list(cache.daemonSets, null));
        for (HasMetadata w : workloads) {
            PodTemplateSpec t = w instanceof Deployment d ? d.getSpec().getTemplate() : ((DaemonSet) w).getSpec().getTemplate();
            if (t == null || t.getSpec() == null || !servesIngressClass(t, controller, cls)) continue;
            String id = Builder.id(w);
            if (!g.nodes.containsKey(id)) {
                int ready, desired;
                if (w instanceof Deployment d) {
                    desired = nz(d.getSpec().getReplicas());
                    ready = d.getStatus() == null ? 0 : nz(d.getStatus().getReadyReplicas());
                } else {
                    var st = ((DaemonSet) w).getStatus();
                    desired = st == null ? 0 : nz(st.getDesiredNumberScheduled());
                    ready = st == null ? 0 : nz(st.getNumberReady());
                }
                Map<String, String> info = new LinkedHashMap<>();
                info.put("replicas", ready + "/" + desired);
                info.put("images", images(t));
                g.node(w, ready + "/" + desired, replicaHealth(ready, desired), null, info);
            }
            g.addInfo(id, "ingressController", cls);
            // nodes its pods run on: lets the node filter reach the controller when its pods are outside the view
            Map<String, String> sel = w instanceof Deployment d ? (d.getSpec().getSelector() == null ? null : d.getSpec().getSelector().getMatchLabels())
                    : ((DaemonSet) w).getSpec().getSelector() == null ? null : ((DaemonSet) w).getSpec().getSelector().getMatchLabels();
            if (sel != null && !sel.isEmpty()) {
                String nodes = ClusterCache.list(cache.pods, w.getMetadata().getNamespace()).stream()
                        .filter(p -> nz(p.getMetadata().getLabels()).entrySet().containsAll(sel.entrySet()))
                        .map(p -> p.getSpec().getNodeName()).filter(Objects::nonNull).distinct().sorted()
                        .reduce((x, y) -> x + "," + y).orElse(null);
                if (nodes != null) g.addInfo(id, "podNodes", nodes);
            }
            g.edge(Builder.id(ic), id, "controller");
        }
    }

    private static final Map<String, List<String>> CONTROLLER_LABELS = Map.of(
            "traefik.io/ingress-controller", List.of("traefik"),
            "k8s.io/ingress-nginx", List.of("ingress-nginx"),
            "nginx.org/ingress-controller", List.of("nginx-ingress"),
            "haproxy.org/ingress-controller/haproxy", List.of("kubernetes-ingress", "haproxy-ingress"),
            "k8s.io/ingress-gce", List.of());

    private static boolean servesIngressClass(PodTemplateSpec t, String controller, String cls) {
        List<String> args = new ArrayList<>();
        for (Container c : nz(t.getSpec().getContainers())) { args.addAll(nz(c.getArgs())); args.addAll(nz(c.getCommand())); }
        Boolean byFlag = null;
        for (String a : args) {
            String v = flag(a, "--controller-class", "-controller-class");
            if (v != null) { if (!v.equals(controller)) return false; byFlag = true; }
            v = flag(a, "--ingress-class", "-ingress-class", "--providers.kubernetesingress.ingressclass");
            if (v != null) { if (!v.equals(cls)) return false; byFlag = true; }
        }
        if (Boolean.TRUE.equals(byFlag)) return true;
        Map<String, String> labels = t.getMetadata() == null ? Map.of() : nz(t.getMetadata().getLabels());
        String name = labels.getOrDefault("app.kubernetes.io/name", labels.get("app"));
        return name != null && CONTROLLER_LABELS.getOrDefault(controller, List.of()).contains(name);
    }

    /** value of "--name=value" for any of the given names, or null */
    private static String flag(String arg, String... names) {
        for (String n : names) if (arg.startsWith(n + "=")) return arg.substring(n.length() + 1);
        return null;
    }

    // ================================================================== RBAC

    private void rbac(Builder g, String ns, boolean all) {
        for (ServiceAccount sa : ClusterCache.list(cache.serviceAccounts, ns)) {
            Map<String, String> info = new LinkedHashMap<>();
            info.put("automountToken", String.valueOf(sa.getAutomountServiceAccountToken() == null || sa.getAutomountServiceAccountToken()));
            info.put("imagePullSecrets", "" + nz(sa.getImagePullSecrets()).size());
            String id = g.nodeIfAbsentOrPlaceholder(sa, "", "ok", null, info);
            String sns = sa.getMetadata().getNamespace();
            for (LocalObjectReference r : nz(sa.getImagePullSecrets())) {
                if (r.getName() == null) continue;
                g.ref(id, "Secret", sns, r.getName(), "pulls", ClusterCache.get(cache.secrets, sns, r.getName()) != null,
                        "warn", "imagePullSecret không tồn tại");
            }
        }
        for (Role r : ClusterCache.list(cache.roles, ns))
            g.node(r, nz(r.getRules()).size() + " rules", "ok", null, Map.of("rules", rulesSummary(r.getRules())));
        for (RoleBinding rb : ClusterCache.list(cache.roleBindings, ns)) {
            String rns = rb.getMetadata().getNamespace();
            String id = g.node(rb, rb.getRoleRef().getKind() + "/" + rb.getRoleRef().getName(), "ok", null,
                    Map.of("subjects", subjects(rb.getSubjects(), rns)));
            roleRef(g, id, rb.getRoleRef(), rns);
            subjectEdges(g, id, rb.getSubjects(), rns);
        }
        // ClusterRoleBindings: only those that bind a service account we show
        for (ClusterRoleBinding crb : cache.clusterRoleBindings.getStore().list()) {
            boolean relevant = nz(crb.getSubjects()).stream().anyMatch(s -> "ServiceAccount".equals(s.getKind())
                    && (all || Objects.equals(ns, s.getNamespace())));
            if (!relevant) continue;
            String id = g.node(crb, "ClusterRole/" + crb.getRoleRef().getName(), "ok", null,
                    Map.of("subjects", subjects(crb.getSubjects(), null)));
            roleRef(g, id, crb.getRoleRef(), null);
            subjectEdges(g, id, crb.getSubjects(), null);
        }
    }

    private void roleRef(Builder g, String bindingId, RoleRef ref, String ns) {
        if ("ClusterRole".equals(ref.getKind())) {
            ClusterRole cr = ClusterCache.get(cache.clusterRoles, null, ref.getName());
            if (cr != null && !g.nodes.containsKey(Builder.id(cr)))
                g.node(cr, nz(cr.getRules()).size() + " rules", "ok", null, Map.of("rules", rulesSummary(cr.getRules())));
            g.ref(bindingId, "ClusterRole", null, ref.getName(), "grants", cr != null, "error", "ClusterRole không tồn tại");
        } else {
            g.ref(bindingId, "Role", ns, ref.getName(), "grants",
                    ClusterCache.get(cache.roles, ns, ref.getName()) != null, "error", "Role không tồn tại");
        }
    }

    private void subjectEdges(Builder g, String bindingId, List<Subject> subjects, String defaultNs) {
        for (Subject s : nz(subjects)) {
            if (!"ServiceAccount".equals(s.getKind())) continue;
            String sns = s.getNamespace() != null ? s.getNamespace() : defaultNs;
            g.edge(bindingId, Builder.id("ServiceAccount", sns, s.getName()), "subject"); // dropped if SA not shown
        }
    }

    // ================================================================== autoscaling & policies

    private void policies(Builder g, String ns, List<Pod> pods) {
        for (HorizontalPodAutoscaler hpa : ClusterCache.list(cache.hpas, ns)) {
            var spec = hpa.getSpec();
            var st = hpa.getStatus();
            int current = st == null ? 0 : nz(st.getCurrentReplicas()), desired = st == null ? 0 : nz(st.getDesiredReplicas());
            Map<String, String> info = new LinkedHashMap<>();
            info.put("replicas", current + " (min " + nz(spec.getMinReplicas()) + ", max " + spec.getMaxReplicas() + ")");
            info.put("current", "" + current);
            info.put("minReplicas", "" + (spec.getMinReplicas() == null ? 1 : spec.getMinReplicas()));
            info.put("maxReplicas", "" + spec.getMaxReplicas());
            info.put("desired", "" + desired);
            for (MetricSpec m : nz(spec.getMetrics())) {
                if (m.getResource() != null && m.getResource().getTarget() != null) {
                    var t = m.getResource().getTarget();
                    String target = t.getAverageUtilization() != null ? t.getAverageUtilization() + "%"
                            : t.getAverageValue() != null ? t.getAverageValue().toString() : String.valueOf(t.getValue());
                    String cur = "?";
                    if (st != null) for (var cm : nz(st.getCurrentMetrics())) {
                        if (cm.getResource() != null && m.getResource().getName().equals(cm.getResource().getName())
                                && cm.getResource().getCurrent() != null) {
                            var c = cm.getResource().getCurrent();
                            cur = c.getAverageUtilization() != null ? c.getAverageUtilization() + "%"
                                    : c.getAverageValue() != null ? c.getAverageValue().toString() : "?";
                        }
                    }
                    info.put(m.getResource().getName(), cur + " / " + target);
                }
            }
            String reason = null, health = "ok";
            if (st != null) {
                for (var c : nz(st.getConditions())) {
                    if (("ScalingActive".equals(c.getType()) || "AbleToScale".equals(c.getType())) && "False".equals(c.getStatus())) {
                        reason = c.getReason(); health = "warn";
                    }
                }
                if (reason == null && current >= spec.getMaxReplicas() && desired >= spec.getMaxReplicas() && desired > 0) {
                    reason = "đã chạm max replicas"; health = "warn";
                }
            }
            String id = g.node(hpa, current + "/" + spec.getMaxReplicas() + " replicas", health, reason, info);
            var ref = spec.getScaleTargetRef();
            boolean exists = cache.find(ref.getKind(), hpa.getMetadata().getNamespace(), ref.getName()).isPresent();
            g.ref(id, ref.getKind(), hpa.getMetadata().getNamespace(), ref.getName(), "scales", exists, "error", "Workload đích không tồn tại");
        }
        for (PodDisruptionBudget pdb : ClusterCache.list(cache.pdbs, ns)) {
            var st = pdb.getStatus();
            int allowed = st == null ? 0 : nz(st.getDisruptionsAllowed());
            int expected = st == null ? 0 : nz(st.getExpectedPods());
            Map<String, String> info = new LinkedHashMap<>();
            if (pdb.getSpec().getMinAvailable() != null) info.put("minAvailable", ios(pdb.getSpec().getMinAvailable()));
            if (pdb.getSpec().getMaxUnavailable() != null) info.put("maxUnavailable", ios(pdb.getSpec().getMaxUnavailable()));
            info.put("pods", (st == null ? 0 : nz(st.getCurrentHealthy())) + "/" + expected + " healthy");
            String health = expected == 0 ? "warn" : allowed == 0 ? "warn" : "ok";
            String reason = expected == 0 ? "không chọn pod nào" : allowed == 0 ? "không cho phép gián đoạn (drain sẽ bị chặn)" : null;
            String id = g.node(pdb, "cho phép " + allowed + " gián đoạn", health, reason, info);
            String pns = pdb.getMetadata().getNamespace();
            for (Pod p : pods)
                if (pns.equals(p.getMetadata().getNamespace()) && matches(pdb.getSpec().getSelector(), p.getMetadata().getLabels()))
                    g.edge(id, Builder.id(p), "protects");
        }
        for (NetworkPolicy np : ClusterCache.list(cache.networkPolicies, ns)) {
            List<String> types = nz(np.getSpec().getPolicyTypes());
            if (types.isEmpty()) types = np.getSpec().getEgress() != null ? List.of("Ingress", "Egress") : List.of("Ingress");
            Map<String, String> info = new LinkedHashMap<>();
            info.put("policyTypes", String.join(", ", types));
            info.put("ingressRules", "" + nz(np.getSpec().getIngress()).size());
            info.put("egressRules", "" + nz(np.getSpec().getEgress()).size());
            boolean selectAll = np.getSpec().getPodSelector() == null
                    || (nz(np.getSpec().getPodSelector().getMatchLabels()).isEmpty() && nz(np.getSpec().getPodSelector().getMatchExpressions()).isEmpty());
            boolean denyAllIngress = types.contains("Ingress") && nz(np.getSpec().getIngress()).isEmpty();
            String status = String.join("+", types) + (selectAll ? " · toàn namespace" : "");
            String id = g.node(np, status, "ok", denyAllIngress ? "chặn mọi ingress" : null, info);
            String pns = np.getMetadata().getNamespace();
            List<Pod> selected = pods.stream().filter(p -> pns.equals(p.getMetadata().getNamespace())
                    && matches(np.getSpec().getPodSelector(), p.getMetadata().getLabels())).toList();
            g.addInfo(id, "pods", selectAll ? "tất cả " + selected.size() + " pod trong namespace" : selected.size() + " pod");
            // a namespace-wide policy would draw a line to every pod; the info line says it instead
            if (!selectAll) selected.forEach(p -> g.edge(id, Builder.id(p), "applies"));
        }
    }

    // ================================================================== quotas, classes, admission, certificates, APIs, CSI, leases

    /** ResourceQuota (used / hard, % of the fullest), LimitRange (the defaults / bounds it injects). */
    private void quotas(Builder g, String ns) {
        for (ResourceQuota q : ClusterCache.list(cache.resourceQuotas, ns)) {
            Map<String, Quantity> hard = q.getStatus() == null ? Map.of() : nz(q.getStatus().getHard());
            Map<String, Quantity> used = q.getStatus() == null ? Map.of() : nz(q.getStatus().getUsed());
            Map<String, String> info = new LinkedHashMap<>();
            String worstKey = null;
            double worst = -1;
            for (String k : new TreeSet<>(hard.keySet())) {
                double h = num(hard.get(k)), u = num(used.get(k));
                int pct = h > 0 ? (int) Math.round(100 * u / h) : (u > 0 ? 100 : 0);
                info.put(k, (used.get(k) == null ? "0" : used.get(k).toString()) + " / " + hard.get(k) + " (" + pct + "%)");
                if (pct > worst) { worst = pct; worstKey = k; }
            }
            String health = worst >= 100 ? "error" : worst >= 90 ? "warn" : "ok";
            String reason = worst >= 100 ? "hết quota " + worstKey + " — không tạo thêm được" : worst >= 90 ? "sắp hết quota " + worstKey : null;
            String status = worstKey == null ? "chưa tính" : worstKey + " " + (int) worst + "%";
            g.node(q, status, health, reason, info);
        }
        for (LimitRange lr : ClusterCache.list(cache.limitRanges, ns)) {
            Map<String, String> info = new LinkedHashMap<>();
            List<String> types = new ArrayList<>();
            for (LimitRangeItem it : nz(lr.getSpec().getLimits())) {
                types.add(it.getType());
                putQ(info, it.getType() + " default request", it.getDefaultRequest());
                putQ(info, it.getType() + " default limit", it.getDefault());
                putQ(info, it.getType() + " min", it.getMin());
                putQ(info, it.getType() + " max", it.getMax());
                putQ(info, it.getType() + " max limit/request", it.getMaxLimitRequestRatio());
            }
            g.node(lr, String.join(", ", types), "ok", null, info);
        }
    }

    private static void putQ(Map<String, String> info, String key, Map<String, Quantity> q) {
        if (q != null && !q.isEmpty()) info.put(key, new TreeMap<>(q).entrySet().stream().map(e -> e.getKey() + " " + e.getValue())
                .reduce((a, b) -> a + ", " + b).orElse(""));
    }

    private static double num(Quantity q) {
        try { return q == null ? 0 : q.getNumericalAmount().doubleValue(); } catch (RuntimeException e) { return 0; }
    }

    /** the legacy ReplicationController: like a ReplicaSet (its pods hang under it through ownerReferences) */
    private void replicationControllers(Builder g, String ns) {
        for (ReplicationController rc : ClusterCache.list(cache.replicationControllers, ns)) {
            int desired = nz(rc.getSpec().getReplicas()), ready = rc.getStatus() == null ? 0 : nz(rc.getStatus().getReadyReplicas());
            Map<String, String> info = new LinkedHashMap<>();
            info.put("replicas", ready + "/" + desired);
            if (rc.getSpec().getTemplate() != null) info.put("images", images(rc.getSpec().getTemplate()));
            String health = replicaHealth(ready, desired);
            g.node(rc, ready + "/" + desired, health, health.equals("ok") || health.equals("unknown") ? null : "chưa đủ pod sẵn sàng", info);
        }
    }

    /** PriorityClass / RuntimeClass: all of them in the all-namespaces view, otherwise those the shown pods use */
    private void classes(Builder g, boolean all, List<Pod> pods) {
        Set<String> pcs = new HashSet<>(), rcs = new HashSet<>();
        pods.forEach(p -> { pcs.add(p.getSpec().getPriorityClassName()); rcs.add(p.getSpec().getRuntimeClassName()); });
        for (var pc : cache.priorityClasses.getStore().list()) {
            if (!all && !pcs.contains(pc.getMetadata().getName())) continue;
            Map<String, String> info = new LinkedHashMap<>();
            info.put("value", String.valueOf(pc.getValue()));
            if (Boolean.TRUE.equals(pc.getGlobalDefault())) info.put("globalDefault", "true");
            if (pc.getPreemptionPolicy() != null) info.put("preemptionPolicy", pc.getPreemptionPolicy());
            g.node(pc, "giá trị " + pc.getValue() + (Boolean.TRUE.equals(pc.getGlobalDefault()) ? " · mặc định" : ""), "ok", null, info);
        }
        for (var rc : cache.runtimeClasses.getStore().list()) {
            if (!all && !rcs.contains(rc.getMetadata().getName())) continue;
            Map<String, String> info = new LinkedHashMap<>();
            info.put("handler", rc.getHandler());
            if (rc.getOverhead() != null) putQ(info, "overhead", rc.getOverhead().getPodFixed());
            g.node(rc, "handler " + rc.getHandler(), "ok", null, info);
        }
    }

    /** ready / total endpoints of every Service (EndpointSlices), keyed "ns/name" */
    private Map<String, int[]> endpointCounts() {
        Map<String, int[]> out = new HashMap<>();
        for (EndpointSlice es : cache.endpointSlices.getStore().list()) {
            String svc = nz(es.getMetadata().getLabels()).get("kubernetes.io/service-name");
            if (svc == null) continue;
            int[] c = out.computeIfAbsent(es.getMetadata().getNamespace() + "/" + svc, k -> new int[2]);
            for (var ep : nz(es.getEndpoints())) {
                c[1]++;
                if (ep.getConditions() == null || !Boolean.FALSE.equals(ep.getConditions().getReady())) c[0]++;
            }
        }
        return out;
    }

    private record Hook(String name, String failurePolicy, String svcNs, String svcName, Integer port, String url) {}

    /**
     * Admission webhooks: the classic "nothing can be created in this namespace" cause. A webhook whose Service has no
     * ready endpoint rejects every matching request (failurePolicy Fail) or is silently skipped (Ignore).
     * Shown in the all-namespaces view, and in a namespace that hosts one of their Services.
     */
    private void admission(Builder g, String ns, boolean all, Map<String, int[]> eps) {
        List<HasMetadata> configs = new ArrayList<>();
        configs.addAll(cache.mutatingWebhooks.getStore().list());
        configs.addAll(cache.validatingWebhooks.getStore().list());
        for (HasMetadata cfg : configs) {
            List<Hook> hooks = new ArrayList<>();
            if (cfg instanceof io.fabric8.kubernetes.api.model.admissionregistration.v1.MutatingWebhookConfiguration m)
                for (var w : nz(m.getWebhooks())) hooks.add(hook(w.getName(), w.getFailurePolicy(), w.getClientConfig()));
            if (cfg instanceof io.fabric8.kubernetes.api.model.admissionregistration.v1.ValidatingWebhookConfiguration v)
                for (var w : nz(v.getWebhooks())) hooks.add(hook(w.getName(), w.getFailurePolicy(), w.getClientConfig()));
            if (!all && hooks.stream().noneMatch(h -> ns.equals(h.svcNs()))) continue;
            Map<String, String> info = new LinkedHashMap<>();
            info.put("webhooks", "" + hooks.size());
            info.put("failurePolicy", hooks.stream().map(Hook::failurePolicy).distinct().reduce((a, b) -> a + ", " + b).orElse("Fail"));
            info.put("targets", hooks.stream().map(h -> h.svcName() != null ? "svc " + h.svcNs() + "/" + h.svcName() + (h.port() != null ? ":" + h.port() : "") : h.url())
                    .distinct().reduce((a, b) -> a + ", " + b).orElse(""));
            String health = "ok", reason = null;
            for (Hook h : hooks) {
                if (h.svcName() == null) continue;
                boolean exists = ClusterCache.get(cache.services, h.svcNs(), h.svcName()) != null;
                int[] ep = eps.getOrDefault(h.svcNs() + "/" + h.svcName(), new int[2]);
                boolean fail = !"Ignore".equals(h.failurePolicy());
                if (!exists || ep[0] == 0) {
                    String why = !exists ? "Service của webhook không tồn tại" : "Service của webhook không có endpoint sẵn sàng";
                    if (fail) { health = "error"; reason = why + " → request khớp rule bị từ chối"; }
                    else if (!"error".equals(health)) { health = "warn"; reason = why + " → webhook bị bỏ qua"; }
                }
            }
            String id = g.node(cfg, hooks.size() + " webhook", health, reason, info);
            for (Hook h : hooks)
                if (h.svcName() != null)
                    g.ref(id, "Service", h.svcNs(), h.svcName(), "calls", ClusterCache.get(cache.services, h.svcNs(), h.svcName()) != null,
                            "Ignore".equals(h.failurePolicy()) ? "warn" : "error", "Service của webhook không tồn tại");
        }
        if (!all) return;
        for (var p : cache.admissionPolicies.getStore().list()) {
            Map<String, String> info = new LinkedHashMap<>();
            info.put("validations", "" + nz(p.getSpec().getValidations()).size());
            if (p.getSpec().getFailurePolicy() != null) info.put("failurePolicy", p.getSpec().getFailurePolicy());
            if (p.getSpec().getParamKind() != null) info.put("paramKind", p.getSpec().getParamKind().getKind());
            int warnings = p.getStatus() == null || p.getStatus().getTypeChecking() == null ? 0 : nz(p.getStatus().getTypeChecking().getExpressionWarnings()).size();
            g.node(p, nz(p.getSpec().getValidations()).size() + " validation", warnings > 0 ? "warn" : "ok",
                    warnings > 0 ? warnings + " biểu thức CEL có cảnh báo kiểu" : null, info);
        }
        for (var b : cache.admissionPolicyBindings.getStore().list()) {
            String policy = b.getSpec().getPolicyName();
            Map<String, String> info = new LinkedHashMap<>();
            info.put("policy", policy);
            info.put("actions", String.join(", ", nz(b.getSpec().getValidationActions())));
            boolean exists = ClusterCache.get(cache.admissionPolicies, null, policy) != null;
            String id = g.node(b, String.join(", ", nz(b.getSpec().getValidationActions())), exists ? "ok" : "error",
                    exists ? null : "policy " + policy + " không tồn tại — binding không có tác dụng", info);
            g.ref(id, "ValidatingAdmissionPolicy", null, policy, "binds", exists, "error", "ValidatingAdmissionPolicy không tồn tại");
        }
    }

    private static Hook hook(String name, String failurePolicy, io.fabric8.kubernetes.api.model.admissionregistration.v1.WebhookClientConfig cc) {
        var svc = cc == null ? null : cc.getService();
        return new Hook(name, failurePolicy == null ? "Fail" : failurePolicy, svc == null ? null : svc.getNamespace(),
                svc == null ? null : svc.getName(), svc == null ? null : svc.getPort(), cc == null ? null : cc.getUrl());
    }

    /** Aggregated APIs (metrics.k8s.io, custom.metrics…): when one is unavailable, kubectl top / HPA / discovery break. */
    @SuppressWarnings("unchecked")
    private void apiServices(Builder g, String ns, boolean all) {
        for (GenericKubernetesResource a : cache.apiServices.getStore().list()) {
            Map<String, Object> spec = (Map<String, Object>) a.getAdditionalProperties().getOrDefault("spec", Map.of());
            if (!(spec.get("service") instanceof Map<?, ?> svc)) continue; // local (built-in) group versions are noise
            String sns = String.valueOf(svc.get("namespace")), sname = String.valueOf(svc.get("name"));
            if (!all && !sns.equals(ns)) continue;
            if (a.getKind() == null) a.setKind("APIService");
            String status = "Available", health = "ok", reason = null;
            if (a.getAdditionalProperties().get("status") instanceof Map<?, ?> st && st.get("conditions") instanceof List<?> conds)
                for (Object o : conds)
                    if (o instanceof Map<?, ?> c && "Available".equals(c.get("type")) && !"True".equals(String.valueOf(c.get("status")))) {
                        status = "Unavailable"; health = "error";
                        reason = c.get("reason") + (c.get("message") != null ? ": " + shortMsg(String.valueOf(c.get("message"))) : "");
                    }
            Map<String, String> info = new LinkedHashMap<>();
            info.put("api", spec.get("group") + "/" + spec.get("version"));
            info.put("service", sns + "/" + sname);
            String id = g.node(a, status, health, reason, info);
            g.ref(id, "Service", sns, sname, "calls", ClusterCache.get(cache.services, sns, sname) != null, "error", "Service của API không tồn tại");
        }
    }

    /** CSRs: pending ones need someone to approve them (kubelet serving certs, user certs). All-namespaces view only. */
    private void csrs(Builder g, boolean all) {
        if (!all) return;
        for (var csr : cache.csrs.getStore().list()) {
            List<String> conds = csr.getStatus() == null ? List.of() : nz(csr.getStatus().getConditions()).stream().map(c -> c.getType()).toList();
            boolean issued = csr.getStatus() != null && csr.getStatus().getCertificate() != null && !csr.getStatus().getCertificate().isEmpty();
            String status = conds.contains("Denied") ? "Denied" : conds.contains("Failed") ? "Failed" : issued ? "Issued" : conds.contains("Approved") ? "Approved" : "Pending";
            String health = switch (status) { case "Denied", "Failed" -> "error"; case "Pending" -> "warn"; default -> "ok"; };
            Map<String, String> info = new LinkedHashMap<>();
            info.put("signer", csr.getSpec().getSignerName());
            if (csr.getSpec().getUsername() != null) info.put("username", csr.getSpec().getUsername());
            info.put("usages", String.join(", ", nz(csr.getSpec().getUsages())));
            g.node(csr, status, health, "Pending".equals(status) ? "chờ duyệt (kubectl certificate approve)" : null, info);
        }
    }

    /** VolumeAttachment (PV ↔ node, attach errors), CSIDriver (← StorageClass provisioner), CSINode (drivers per node). */
    private void csi(Builder g, boolean all) {
        for (var va : cache.volumeAttachments.getStore().list()) {
            String pv = va.getSpec().getSource() == null ? null : va.getSpec().getSource().getPersistentVolumeName();
            String pvId = pv == null ? null : Builder.id("PersistentVolume", null, pv);
            if (!all && (pvId == null || !g.nodes.containsKey(pvId))) continue;
            var st = va.getStatus();
            boolean attached = st != null && Boolean.TRUE.equals(st.getAttached());
            String err = st == null ? null : st.getAttachError() != null ? st.getAttachError().getMessage()
                    : st.getDetachError() != null ? st.getDetachError().getMessage() : null;
            Map<String, String> info = new LinkedHashMap<>();
            info.put("attacher", va.getSpec().getAttacher());
            info.put("node", va.getSpec().getNodeName());
            if (pv != null) info.put("pv", pv);
            String id = g.node(va, attached ? "attached" : "chưa attach", err != null ? "error" : attached ? "ok" : "warn",
                    err != null ? shortMsg(err) : null, info);
            if (pv != null) g.ref(id, "PersistentVolume", null, pv, "attaches", ClusterCache.get(cache.pvs, null, pv) != null, "error", "PV không tồn tại");
            g.edge(id, Builder.id("Node", null, va.getSpec().getNodeName()), "attaches");
        }
        Set<String> provisioners = new HashSet<>();
        g.objects.values().forEach(o -> { if (o instanceof StorageClass sc) provisioners.add(sc.getProvisioner()); });
        for (var d : cache.csiDrivers.getStore().list()) {
            if (!all && !provisioners.contains(d.getMetadata().getName())) continue;
            Map<String, String> info = new LinkedHashMap<>();
            info.put("attachRequired", String.valueOf(d.getSpec().getAttachRequired()));
            info.put("podInfoOnMount", String.valueOf(d.getSpec().getPodInfoOnMount()));
            info.put("modes", String.join(", ", nz(d.getSpec().getVolumeLifecycleModes())));
            String id = g.node(d, "CSI driver", "ok", null, info);
            g.objects.values().stream().filter(o -> o instanceof StorageClass sc && d.getMetadata().getName().equals(sc.getProvisioner()))
                    .toList().forEach(sc -> g.edge(Builder.id(sc), id, "driver"));
        }
        if (!all) return;
        for (var cn : cache.csiNodes.getStore().list()) {
            List<String> drivers = nz(cn.getSpec().getDrivers()).stream().map(d -> d.getName()).toList();
            String id = g.node(cn, drivers.size() + " driver", "ok", null, Map.of("drivers", String.join(", ", drivers)));
            g.edge(id, Builder.id("Node", null, cn.getMetadata().getName()), "runs-on");
        }
    }

    /**
     * Leader-election leases (controllers, operators): who holds them, and whether the holder stopped renewing
     * (a crashed leader). Node heartbeats (kube-node-lease) are left out.
     */
    private void leases(Builder g, String ns, List<Pod> pods) {
        for (var l : ClusterCache.list(cache.leases, ns)) {
            if ("kube-node-lease".equals(l.getMetadata().getNamespace())) continue;
            var spec = l.getSpec();
            String holder = spec.getHolderIdentity();
            Map<String, String> info = new LinkedHashMap<>();
            info.put("holder", holder == null ? "(không ai)" : holder);
            if (spec.getLeaseDurationSeconds() != null) info.put("duration", spec.getLeaseDurationSeconds() + "s");
            if (spec.getLeaseTransitions() != null) info.put("transitions", "" + spec.getLeaseTransitions());
            String health = "ok", reason = null;
            if (holder == null || holder.isBlank()) { health = "unknown"; }
            else if (spec.getRenewTime() != null && spec.getLeaseDurationSeconds() != null) {
                long age = Instant.now().getEpochSecond() - spec.getRenewTime().toEpochSecond();
                if (age > 3L * spec.getLeaseDurationSeconds() + 60) { health = "warn"; reason = "holder không còn gia hạn lease"; }
            }
            String id = g.node(l, holder == null || holder.isBlank() ? "trống" : "giữ bởi " + shortHolder(holder), health, reason, info);
            if (holder != null)
                for (Pod p : pods)
                    if (p.getMetadata().getNamespace().equals(l.getMetadata().getNamespace()) && holder.startsWith(p.getMetadata().getName()))
                        g.edge(id, Builder.id(p), "held");
        }
    }

    private static String shortHolder(String h) {
        int us = h.indexOf('_');
        String s = us > 0 ? h.substring(0, us) : h;
        return s.length() > 40 ? s.substring(0, 39) + "…" : s;
    }

    // ================================================================== Gateway API / Traefik routes

    private static final String GATEWAY_GROUP = "gateway.networking.k8s.io";
    private static final Set<String> ROUTE_KINDS = Set.of("HTTPRoute", "GRPCRoute", "TCPRoute", "TLSRoute", "UDPRoute");
    private static final Set<String> TRAEFIK_GROUPS = Set.of("traefik.io", "traefik.containo.us");
    private static final Set<String> TRAEFIK_ROUTES = Set.of("IngressRoute", "IngressRouteTCP", "IngressRouteUDP");
    private static final Pattern TRAEFIK_HOST = Pattern.compile("Host(?:SNI)?\\(([^)]*)\\)");

    /** Cluster-scoped custom resources the namespaced ones point at (a Gateway's GatewayClass), so they get a card. */
    @SuppressWarnings("unchecked")
    private static Set<String> referencedClusterCustom(List<GenericKubernetesResource> namespaced) {
        Set<String> out = new HashSet<>();
        for (var r : namespaced)
            if ("Gateway".equals(r.getKind()) && r.getAdditionalProperties().get("spec") instanceof Map<?, ?> spec && spec.get("gatewayClassName") != null)
                out.add("GatewayClass/" + spec.get("gatewayClassName"));
        return out;
    }

    /** Edges + health of Gateway API and Traefik objects (the generic custom-resource pass only knows ownerReferences). */
    @SuppressWarnings("unchecked")
    private void routing(Builder g, GenericKubernetesResource r, String group, String id) {
        String kind = r.getKind(), rns = r.getMetadata().getNamespace();
        Map<String, Object> spec = r.getAdditionalProperties().get("spec") instanceof Map<?, ?> m ? (Map<String, Object>) m : Map.of();
        Map<String, Object> status = r.getAdditionalProperties().get("status") instanceof Map<?, ?> m ? (Map<String, Object>) m : Map.of();
        if (GATEWAY_GROUP.equals(group)) {
            if ("Gateway".equals(kind)) {
                String cls = str(spec.get("gatewayClassName"));
                if (cls != null) g.ref(id, "GatewayClass", null, cls, "class", cache.find("GatewayClass", null, cls).isPresent(), "error", "GatewayClass không tồn tại");
                List<String> listeners = list(spec.get("listeners")).stream().map(l -> str(l.get("protocol")) + ":" + str(l.get("port"))
                        + (l.get("hostname") != null ? " " + l.get("hostname") : "")).toList();
                if (!listeners.isEmpty()) g.addInfo(id, "listeners", String.join(", ", listeners));
                String addr = list(status.get("addresses")).stream().map(a -> str(a.get("value"))).filter(Objects::nonNull).reduce((a, b) -> a + ", " + b).orElse(null);
                if (addr != null) g.addInfo(id, "address", addr);
                conditionHealth(g, id, list(status.get("conditions")), Set.of("Accepted", "Programmed"), addr != null ? "Programmed · " + addr : "Programmed");
            } else if ("GatewayClass".equals(kind)) {
                g.addInfo(id, "controller", String.valueOf(spec.get("controllerName")));
                conditionHealth(g, id, list(status.get("conditions")), Set.of("Accepted"), "Accepted");
            } else if (ROUTE_KINDS.contains(kind)) {
                for (Map<String, Object> p : list(spec.get("parentRefs"))) {
                    String pk = Objects.requireNonNullElse(str(p.get("kind")), "Gateway"), pns = Objects.requireNonNullElse(str(p.get("namespace")), rns), pn = str(p.get("name"));
                    if (pn != null) g.ref(id, pk, pns, pn, "parent", cache.find(pk, pns, pn).isPresent(), "error", pk + " không tồn tại");
                }
                for (Map<String, Object> rule : list(spec.get("rules")))
                    for (Map<String, Object> b : list(rule.get("backendRefs"))) backend(g, id, b, rns);
                List<String> hosts = spec.get("hostnames") instanceof List<?> hl ? hl.stream().map(String::valueOf).toList() : List.of();
                if (!hosts.isEmpty()) g.addInfo(id, "hosts", String.join(", ", hosts));
                // route status is per parent: Accepted (attached to the Gateway) and ResolvedRefs (backends exist)
                List<Map<String, Object>> conds = new ArrayList<>();
                list(status.get("parents")).forEach(p -> conds.addAll(list(p.get("conditions"))));
                conditionHealth(g, id, conds, Set.of("Accepted", "ResolvedRefs"), "Accepted");
            }
        } else if (TRAEFIK_GROUPS.contains(group) && (kind.equals("Middleware") || kind.equals("MiddlewareTCP"))) {
            // the middleware type is its only spec key (stripPrefix, basicAuth, redirectScheme…)
            g.update(id, String.join(", ", spec.keySet()), "ok", null);
        } else if (TRAEFIK_GROUPS.contains(group) && TRAEFIK_ROUTES.contains(kind)) {
            List<String> hosts = new ArrayList<>();
            for (Map<String, Object> route : list(spec.get("routes"))) {
                if (route.get("match") instanceof String match) {
                    Matcher hm = TRAEFIK_HOST.matcher(match);
                    while (hm.find()) hosts.add(hm.group(1).replaceAll("[`\"']", ""));
                }
                for (Map<String, Object> s : list(route.get("services"))) backend(g, id, s, rns);
                for (Map<String, Object> mw : list(route.get("middlewares"))) {
                    String mn = str(mw.get("name")), mns = Objects.requireNonNullElse(str(mw.get("namespace")), rns);
                    if (mn != null && !mn.contains("@")) // "name@provider" = defined outside Kubernetes
                        g.ref(id, "Middleware", mns, mn, "middleware", cache.find("Middleware", mns, mn).isPresent(), "error", "Middleware không tồn tại");
                }
            }
            if (!hosts.isEmpty()) g.addInfo(id, "hosts", String.join(", ", hosts));
            if (spec.get("entryPoints") instanceof List<?> eps) g.addInfo(id, "entryPoints", eps.stream().map(String::valueOf).reduce((a, b) -> a + ", " + b).orElse(""));
            if (spec.get("tls") instanceof Map<?, ?> tls && tls.get("secretName") != null) {
                String sec = String.valueOf(tls.get("secretName"));
                g.ref(id, "Secret", rns, sec, "tls", ClusterCache.get(cache.secrets, rns, sec) != null, "error", "Secret TLS không tồn tại");
            }
            Graph.Node n = g.nodes.get(id);
            if (n != null && n.status().isEmpty()) g.update(id, hosts.isEmpty() ? kind : String.join(", ", hosts), n.health(), null);
        }
    }

    /** a backendRef / Traefik service: Service by default, or any other kind (TraefikService…) */
    private void backend(Builder g, String from, Map<String, Object> b, String defaultNs) {
        String kind = Objects.requireNonNullElse(str(b.get("kind")), "Service"), name = str(b.get("name"));
        String bns = Objects.requireNonNullElse(str(b.get("namespace")), defaultNs);
        if (name == null || name.contains("@")) return;
        boolean exists = "Service".equals(kind) ? ClusterCache.get(cache.services, bns, name) != null : cache.find(kind, bns, name).isPresent();
        g.ref(from, kind, bns, name, "routes", exists, "error", kind + " đích không tồn tại");
    }

    /** first wanted condition that isn't True → error with its reason; all True → ok with okStatus */
    private static void conditionHealth(Builder g, String id, List<Map<String, Object>> conds, Set<String> wanted, String okStatus) {
        if (conds.isEmpty()) { g.update(id, "chưa có trạng thái", "unknown", "controller chưa xử lý (chưa có status)"); return; }
        for (Map<String, Object> c : conds) {
            if (!wanted.contains(str(c.get("type")))) continue;
            if (!"True".equals(str(c.get("status")))) {
                // "Pending" = no controller has picked it up yet: a warning, not a failure
                g.update(id, "Not" + c.get("type"), "Pending".equals(str(c.get("reason"))) ? "warn" : "error",
                        str(c.get("reason")) + (c.get("message") != null ? ": " + shortMsg(str(c.get("message"))) : ""));
                return;
            }
        }
        g.update(id, okStatus, "ok", null);
    }

    @SuppressWarnings("unchecked")
    private static List<Map<String, Object>> list(Object o) {
        if (!(o instanceof List<?> l)) return List.of();
        return l.stream().filter(x -> x instanceof Map).map(x -> (Map<String, Object>) x).toList();
    }

    private static String str(Object o) { return o == null ? null : String.valueOf(o); }

    // ================================================================== custom resources

    private void customResources(Builder g, String ns) {
        if (!cache.customResourcesEnabled()) return;
        // cluster-scoped custom resources are only interesting when something we show points at them
        Set<String> wantedOwners = new HashSet<>();
        g.objects.values().forEach(o -> nz(o.getMetadata().getOwnerReferences()).forEach(r -> wantedOwners.add(r.getUid())));
        List<GenericKubernetesResource> namespaced = new ArrayList<>();
        for (ClusterCache.CustomType t : cache.customTypes())
            if (t.namespaced()) ClusterCache.list(t.informer(), ns).forEach(r -> { if (r.getKind() == null) r.setKind(t.kind()); namespaced.add(r); });
        Set<String> referenced = referencedClusterCustom(namespaced);
        List<String[]> routed = new ArrayList<>(); // [id, group] of objects whose relations we know (Gateway API, Traefik)
        for (ClusterCache.CustomType t : cache.customTypes()) {
            List<GenericKubernetesResource> items = t.namespaced()
                    ? ClusterCache.list(t.informer(), ns)
                    : t.informer().getStore().list().stream().filter(o -> wantedOwners.contains(o.getMetadata().getUid())
                            || referenced.contains(t.kind() + "/" + o.getMetadata().getName())).toList();
            for (GenericKubernetesResource r : items) {
                if (r.getKind() == null) r.setKind(t.kind());
                String[] sh = customStatus(r);
                String id = g.custom(r, t.group(), sh[0], sh[1], sh[2], new LinkedHashMap<>(Map.of("apiVersion", t.group() + "/" + t.version())));
                if (GATEWAY_GROUP.equals(t.group()) || TRAEFIK_GROUPS.contains(t.group())) routed.add(new String[]{id, t.group()});
            }
        }
        // placeholders for missing Gateway API / Traefik objects carry the group too, so they group with the real ones
        Runnable groupMissing = () -> new ArrayList<>(g.nodes.values()).forEach(n -> {
            if (!n.missing() || n.group() != null) return;
            String grp = Set.of("Gateway", "GatewayClass", "ReferenceGrant").contains(n.kind()) || ROUTE_KINDS.contains(n.kind()) ? GATEWAY_GROUP
                    : Set.of("Middleware", "MiddlewareTCP", "TraefikService").contains(n.kind()) ? "traefik.io" : null;
            if (grp != null) g.nodes.put(n.id(), new Graph.Node(n.id(), n.kind(), grp, n.name(), n.namespace(), n.status(), n.health(), n.reason(),
                    true, n.info(), n.labels(), n.created()));
        });
        for (String[] r : routed) {
            routing(g, (GenericKubernetesResource) g.objects.get(r[0]), r[1], r[0]);
            // a route / gateway pointing at something that doesn't exist is broken, whatever its own status says
            List<String> broken = g.edges.stream().filter(e -> e.source().equals(r[0]) && g.nodes.containsKey(e.target()) && g.nodes.get(e.target()).missing())
                    .map(e -> g.nodes.get(e.target()).kind() + " " + g.nodes.get(e.target()).name()).toList();
            Graph.Node n = g.nodes.get(r[0]);
            if (!broken.isEmpty() && n != null && !"error".equals(n.health()))
                g.update(r[0], n.status().isEmpty() || n.status().equals("chưa có trạng thái") ? "tham chiếu gãy" : n.status(), "error",
                        "không tồn tại: " + String.join(", ", broken));
        }
        groupMissing.run();
    }

    @SuppressWarnings("unchecked")
    private static String[] customStatus(GenericKubernetesResource r) {
        Object status = r.getAdditionalProperties().get("status");
        if (!(status instanceof Map<?, ?> st)) return new String[]{"", "ok", null};
        Object conds = st.get("conditions");
        if (conds instanceof List<?> list) {
            for (Object o : list) {
                if (!(o instanceof Map<?, ?> c)) continue;
                String type = String.valueOf(c.get("type"));
                if ("Ready".equals(type) || "Available".equals(type) || "Synced".equals(type) || "Healthy".equals(type)) {
                    boolean ok = "True".equals(String.valueOf(c.get("status")));
                    Object reason = c.get("reason");
                    return new String[]{ok ? type : "Not" + type, ok ? "ok" : "error",
                            ok ? null : reason != null ? String.valueOf(reason) : shortMsg(String.valueOf(c.get("message")))};
                }
            }
        }
        for (String key : List.of("phase", "state", "health", "status")) {
            Object v = st.get(key);
            if (v instanceof String s && !s.isBlank()) {
                String lower = s.toLowerCase(Locale.ROOT);
                String health = lower.matches(".*(fail|error|degraded|unhealthy).*") ? "error"
                        : lower.matches(".*(pending|progress|unknown|waiting).*") ? "warn" : "ok";
                return new String[]{s, health, null};
            }
        }
        return new String[]{"", "ok", null};
    }

    // ================================================================== cross-cutting passes

    /** Generic ownerReferences: Deployment->RS->Pod, CronJob->Job, operator CR->StatefulSet, Certificate->Secret… */
    private void owners(Builder g) {
        for (HasMetadata o : new ArrayList<>(g.objects.values())) {
            for (OwnerReference ref : nz(o.getMetadata().getOwnerReferences())) {
                String nsId = Builder.id(ref.getKind(), o.getMetadata().getNamespace(), ref.getName());
                String clusterId = Builder.id(ref.getKind(), null, ref.getName());
                g.edge(g.nodes.containsKey(nsId) ? nsId : clusterId, Builder.id(o), "owns");
            }
        }
    }

    /** Sum pod usage up the ownership chain (Pod -> RS -> Deployment). */
    private void workloadMetrics(Builder g, List<Pod> pods) {
        if (!metrics.available()) return;
        Map<String, MetricsCache.Usage> sum = new HashMap<>();
        for (Pod p : pods) {
            var u = metrics.pod(p.getMetadata().getNamespace(), p.getMetadata().getName());
            if (u == null) continue;
            Set<String> seen = new HashSet<>();
            Deque<HasMetadata> q = new ArrayDeque<>(List.of(p));
            while (!q.isEmpty()) {
                HasMetadata cur = q.poll();
                for (OwnerReference r : nz(cur.getMetadata().getOwnerReferences())) {
                    String oid = Builder.id(r.getKind(), cur.getMetadata().getNamespace(), r.getName());
                    if (!seen.add(oid)) continue;
                    sum.merge(oid, u, MetricsCache.Usage::plus);
                    HasMetadata owner = g.objects.get(oid);
                    if (owner != null) q.add(owner);
                }
            }
        }
        sum.forEach((id, u) -> {
            g.addInfo(id, "cpu", MetricsCache.cpu(u.cpuMilli()));
            g.addInfo(id, "memory", MetricsCache.mem(u.memBytes()));
        });
    }

    /** ConfigMaps / Secrets / PVCs / ServiceAccounts nothing points at. */
    private void markUnused(Builder g) {
        Set<String> targets = new HashSet<>();
        g.edges.forEach(e -> targets.add(e.target()));
        Set<String> sources = new HashSet<>();
        g.edges.forEach(e -> sources.add(e.source()));
        for (Graph.Node n : new ArrayList<>(g.nodes.values())) {
            if (n.missing() || targets.contains(n.id())) continue;
            switch (n.kind()) {
                case "ConfigMap", "Secret" -> g.update(n.id(), n.status() + " · không dùng", "unknown", null);
                case "PersistentVolumeClaim" -> g.update(n.id(), n.status(), n.health(), "không pod nào mount");
                case "ServiceAccount" -> g.update(n.id(), "không pod nào dùng", "unknown", null);
                default -> { }
            }
        }
    }

    // ------------------------------------------------------------------ helpers

    private Map<String, Event> latestWarnings() {
        long cutoff = System.currentTimeMillis() - EVENT_WINDOW_MS;
        Map<String, Event> out = new HashMap<>();
        for (Event e : cache.events.getStore().list()) {
            if (!"Warning".equals(e.getType()) || e.getInvolvedObject() == null) continue;
            String t = ClusterCache.eventTime(e);
            long ts;
            try { ts = Instant.parse(t).toEpochMilli(); } catch (RuntimeException ex) { continue; }
            if (ts < cutoff) continue;
            var io = e.getInvolvedObject();
            String key = io.getUid() != null ? io.getUid() : Builder.id(io.getKind(), io.getNamespace(), io.getName());
            Event prev = out.get(key);
            if (prev == null || ClusterCache.eventTime(prev).compareTo(t) < 0) out.put(key, e);
        }
        return out;
    }

    private static String podReason(Pod p, String status) {
        PodStatus st = p.getStatus();
        if (st == null) return null;
        if ("Pending".equals(st.getPhase())) {
            for (PodCondition c : nz(st.getConditions())) {
                if ("PodScheduled".equals(c.getType()) && "False".equals(c.getStatus())) {
                    String m = c.getMessage() == null ? "" : c.getMessage();
                    Matcher mt = SCHED.matcher(m.contains(": ") ? m.substring(m.indexOf(": ") + 2) : m);
                    return mt.find() ? mt.group(1).trim().replaceAll("[.]+$", "") : c.getReason();
                }
            }
        }
        List<ContainerStatus> css = new ArrayList<>(nz(st.getInitContainerStatuses()));
        css.addAll(nz(st.getContainerStatuses()));
        for (ContainerStatus cs : css) {
            var s = cs.getState();
            if (s == null) continue;
            if (s.getWaiting() != null && "CrashLoopBackOff".equals(s.getWaiting().getReason())) {
                var last = cs.getLastState() == null ? null : cs.getLastState().getTerminated();
                if (last != null) return "exit " + last.getExitCode() + ("Error".equals(last.getReason()) ? "" : " · " + last.getReason())
                        + (css.size() > 1 ? " (" + cs.getName() + ")" : "");
            }
            if (s.getWaiting() != null && ("ImagePullBackOff".equals(s.getWaiting().getReason()) || "ErrImagePull".equals(s.getWaiting().getReason())))
                return "image " + cs.getImage();
            if (s.getWaiting() != null && "CreateContainerConfigError".equals(s.getWaiting().getReason()))
                return shortMsg(s.getWaiting().getMessage());
            if (s.getTerminated() != null && ERROR_REASONS.contains(s.getTerminated().getReason()) && !"Succeeded".equals(st.getPhase()))
                return "exit " + s.getTerminated().getExitCode();
        }
        if (status.startsWith("Running ")) {
            for (ContainerStatus cs : nz(st.getContainerStatuses()))
                if (!Boolean.TRUE.equals(cs.getReady())) return cs.getName() + " chưa ready";
        }
        return null;
    }

    private static String[] podStatus(Pod p) {
        if (p.getMetadata().getDeletionTimestamp() != null) return new String[]{"Terminating", "warn"};
        PodStatus st = p.getStatus();
        if (st == null) return new String[]{"Unknown", "unknown"};
        String phase = Objects.requireNonNullElse(st.getPhase(), "Unknown");
        if ("Failed".equals(phase) && st.getReason() != null) return new String[]{st.getReason(), "error"}; // Evicted…
        List<ContainerStatus> css = new ArrayList<>(nz(st.getInitContainerStatuses()));
        css.addAll(nz(st.getContainerStatuses()));
        for (ContainerStatus cs : css) {
            var s = cs.getState();
            if (s == null) continue;
            if (s.getWaiting() != null && s.getWaiting().getReason() != null) {
                String reason = s.getWaiting().getReason();
                if (ERROR_REASONS.contains(reason)) return new String[]{reason, "error"};
                if (!"PodInitializing".equals(reason)) return new String[]{reason, "warn"};
            }
            if (s.getTerminated() != null && ERROR_REASONS.contains(s.getTerminated().getReason())
                    && !"Succeeded".equals(phase)) {
                return new String[]{s.getTerminated().getReason(), "error"};
            }
        }
        return switch (phase) {
            case "Running" -> {
                long total = nz(st.getContainerStatuses()).size();
                long ready = nz(st.getContainerStatuses()).stream().filter(c -> Boolean.TRUE.equals(c.getReady())).count();
                yield ready == total ? new String[]{"Running", "ok"} : new String[]{"Running " + ready + "/" + total, "warn"};
            }
            case "Succeeded" -> new String[]{"Completed", "ok"};
            case "Failed" -> new String[]{"Failed", "error"};
            case "Pending" -> new String[]{"Pending", "warn"};
            default -> new String[]{phase, "unknown"};
        };
    }

    static boolean matches(LabelSelector sel, Map<String, String> labels) {
        if (sel == null) return false;
        Map<String, String> l = nz(labels);
        for (var e : nz(sel.getMatchLabels()).entrySet()) if (!e.getValue().equals(l.get(e.getKey()))) return false;
        for (LabelSelectorRequirement r : nz(sel.getMatchExpressions())) {
            String v = l.get(r.getKey());
            List<String> vals = nz(r.getValues());
            boolean ok = switch (r.getOperator()) {
                case "In" -> v != null && vals.contains(v);
                case "NotIn" -> v == null || !vals.contains(v);
                case "Exists" -> l.containsKey(r.getKey());
                case "DoesNotExist" -> !l.containsKey(r.getKey());
                default -> false;
            };
            if (!ok) return false;
        }
        return true;
    }

    private record CondView(String type, String status, String reason, String message) {}
    private interface DeploymentConditionView { static CondView of(io.fabric8.kubernetes.api.model.apps.DeploymentCondition c) { return new CondView(c.getType(), c.getStatus(), c.getReason(), c.getMessage()); } }
    private interface ReplicaSetConditionView { static CondView of(io.fabric8.kubernetes.api.model.apps.ReplicaSetCondition c) { return new CondView(c.getType(), c.getStatus(), c.getReason(), c.getMessage()); } }
    private interface JobConditionView { static CondView of(io.fabric8.kubernetes.api.model.batch.v1.JobCondition c) { return new CondView(c.getType(), c.getStatus(), c.getReason(), c.getMessage()); } }

    private static <C> CondView condition(List<C> conds, Function<C, CondView> view, String type, String status) {
        for (C c : nz(conds)) {
            CondView v = view.apply(c);
            if (type.equals(v.type()) && status.equals(v.status())) return v;
        }
        return null;
    }

    static String shortMsg(String m) {
        if (m == null) return null;
        m = m.replaceAll("\\s+", " ").trim();
        int colon = m.lastIndexOf(": ");
        if (m.length() > 60 && colon > 0 && colon < m.length() - 10) m = m.substring(colon + 2);
        return m.length() > 80 ? m.substring(0, 79) + "…" : m;
    }

    private static String shortType(String type) {
        if (type == null) return "Opaque";
        return switch (type) {
            case "kubernetes.io/tls" -> "TLS";
            case "kubernetes.io/dockerconfigjson", "kubernetes.io/dockercfg" -> "docker registry";
            case "kubernetes.io/basic-auth" -> "basic-auth";
            case "kubernetes.io/ssh-auth" -> "ssh-auth";
            default -> type;
        };
    }

    private static String images(PodTemplateSpec t) {
        if (t == null || t.getSpec() == null) return "";
        return nz(t.getSpec().getContainers()).stream().map(Container::getImage).reduce((a, b) -> a + ", " + b).orElse("");
    }

    private static String rulesSummary(List<PolicyRule> rules) {
        StringJoiner j = new StringJoiner("; ");
        for (PolicyRule r : nz(rules)) {
            List<String> res = !nz(r.getResources()).isEmpty() ? r.getResources() : nz(r.getNonResourceURLs());
            j.add(String.join(",", nz(r.getVerbs())) + " " + String.join(",", res));
            if (j.length() > 300) { j.add("…"); break; }
        }
        return j.toString();
    }

    private static String subjects(List<Subject> subjects, String defaultNs) {
        return nz(subjects).stream().map(s -> s.getKind() + " " + (s.getNamespace() != null ? s.getNamespace() + "/"
                : "ServiceAccount".equals(s.getKind()) && defaultNs != null ? defaultNs + "/" : "") + s.getName())
                .reduce((a, b) -> a + ", " + b).orElse("—");
    }

    private static int restarts(Pod p) {
        if (p.getStatus() == null) return 0;
        return nz(p.getStatus().getContainerStatuses()).stream().mapToInt(c -> nz(c.getRestartCount())).sum();
    }

    private static boolean nodeReady(io.fabric8.kubernetes.api.model.Node n) {
        if (n.getStatus() == null) return false;
        return nz(n.getStatus().getConditions()).stream()
                .anyMatch(c -> "Ready".equals(c.getType()) && "True".equals(c.getStatus()));
    }

    private static long milli(Quantity q) {
        return q == null ? 0 : Quantity.getAmountInBytes(q).multiply(java.math.BigDecimal.valueOf(1000)).longValue();
    }

    private static long bytes(Quantity q) {
        return q == null ? 0 : Quantity.getAmountInBytes(q).longValue();
    }

    private static String ports(io.fabric8.kubernetes.api.model.Service svc) {
        StringJoiner j = new StringJoiner(", ");
        for (ServicePort sp : nz(svc.getSpec().getPorts())) {
            String s = sp.getPort() + "/" + sp.getProtocol();
            if (sp.getTargetPort() != null && !String.valueOf(sp.getPort()).equals(sp.getTargetPort().toString()))
                s += "→" + (sp.getTargetPort().getIntVal() != null ? sp.getTargetPort().getIntVal() : sp.getTargetPort().getStrVal());
            if (sp.getNodePort() != null) s += " (node " + sp.getNodePort() + ")";
            j.add(s);
        }
        return j.toString();
    }

    private static String replicaHealth(int ready, int desired) {
        if (desired == 0) return "unknown";
        if (ready >= desired) return "ok";
        return ready == 0 ? "error" : "warn";
    }

    private static int nz(Integer i) { return i == null ? 0 : i; }
    private static String ios(IntOrString v) { return v == null ? "" : v.getIntVal() != null ? String.valueOf(v.getIntVal()) : v.getStrVal(); }
    private static <T> List<T> nz(List<T> l) { return l == null ? List.of() : l; }
    private static <K, V> Map<K, V> nz(Map<K, V> m) { return m == null ? Map.of() : m; }

    /** Accumulates nodes/edges, de-duplicating by id; drops edges whose endpoints don't exist. */
    private static final class Builder {
        final Map<String, Graph.Node> nodes = new LinkedHashMap<>();
        final Map<String, HasMetadata> objects = new LinkedHashMap<>();
        final Set<Graph.Edge> edges = new LinkedHashSet<>();
        final Map<String, Event> warnings;

        Builder(Map<String, Event> warnings) { this.warnings = warnings; }

        static String id(String kind, String ns, String name) {
            return kind + "/" + (ns == null ? "" : ns) + "/" + name;
        }

        static String id(HasMetadata o) {
            return id(o.getKind(), o.getMetadata().getNamespace(), o.getMetadata().getName());
        }

        String node(HasMetadata o, String status, String health, String reason, Map<String, String> info) {
            return put(o, null, status, health, reason, info);
        }

        String custom(HasMetadata o, String group, String status, String health, String reason, Map<String, String> info) {
            return put(o, group, status, health, reason, info);
        }

        private String put(HasMetadata o, String group, String status, String health, String reason, Map<String, String> info) {
            var m = o.getMetadata();
            String id = id(o);
            // no specific reason but something is wrong -> latest Warning event explains it (FailedMount, BackOff, …)
            if (reason == null && !"ok".equals(health)) {
                Event e = warnings.get(m.getUid());
                if (e == null) e = warnings.get(id);
                if (e != null) reason = e.getReason();
            }
            nodes.put(id, new Graph.Node(id, o.getKind(), group, m.getName(), m.getNamespace(), status, health, reason, false,
                    new LinkedHashMap<>(info), m.getLabels() == null ? Map.of() : new TreeMap<>(m.getLabels()), m.getCreationTimestamp()));
            objects.put(id, o);
            return id;
        }

        /** Like node() but keeps an existing real node (only replaces missing placeholders). */
        String nodeIfAbsentOrPlaceholder(HasMetadata o, String status, String health, String reason, Map<String, String> info) {
            Graph.Node existing = nodes.get(id(o));
            if (existing != null && !existing.missing()) return existing.id();
            return node(o, status, health, reason, info);
        }

        String missing(String kind, String ns, String name, String health, String why) {
            String id = id(kind, ns, name);
            nodes.putIfAbsent(id, new Graph.Node(id, kind, null, name, ns, "không tồn tại", health, why, true,
                    new LinkedHashMap<>(Map.of("lỗi", why)), Map.of(), null));
            return id;
        }

        /**
         * Edge from -> (kind/ns/name). If the target doesn't exist, a "missing" node is created so the broken reference shows up.
         * Existing targets are left for their own pass to create (an edge to a node that never appears is dropped).
         */
        void ref(String from, String kind, String ns, String name, String type, boolean exists, String missingHealth, String why) {
            if (name == null) return;
            String id = exists ? id(kind, ns, name) : missing(kind, ns, name, missingHealth, why);
            edge(from, id, type);
        }

        void update(String id, String health, String reason) {
            Graph.Node n = nodes.get(id);
            if (n != null) update(id, n.status(), health, reason);
        }

        void update(String id, String status, String health, String reason) {
            Graph.Node n = nodes.get(id);
            if (n == null) return;
            nodes.put(id, new Graph.Node(n.id(), n.kind(), n.group(), n.name(), n.namespace(), status, health,
                    reason != null ? reason : n.reason(), n.missing(), n.info(), n.labels(), n.created()));
        }

        void addInfo(String id, String key, String value) {
            Graph.Node n = nodes.get(id);
            if (n == null) return;
            try {
                n.info().put(key, value);
            } catch (UnsupportedOperationException e) { // a placeholder node built with Map.of(): copy it
                Map<String, String> info = new LinkedHashMap<>(n.info());
                info.put(key, value);
                nodes.put(id, new Graph.Node(n.id(), n.kind(), n.group(), n.name(), n.namespace(), n.status(), n.health(), n.reason(),
                        n.missing(), info, n.labels(), n.created()));
            }
        }

        void edge(String source, String target, String type) {
            edges.add(new Graph.Edge(source, target, type));
        }

        Graph build(String context, List<String> warnings, boolean metrics) {
            // sorted -> deterministic output, so snapshots can be compared with equals() to skip no-op pushes
            List<Graph.Edge> valid = edges.stream()
                    .filter(e -> nodes.containsKey(e.source()) && nodes.containsKey(e.target()))
                    .sorted(Comparator.comparing(Graph.Edge::source).thenComparing(Graph.Edge::target)
                            .thenComparing(Graph.Edge::type))
                    .toList();
            List<Graph.Node> sorted = nodes.values().stream()
                    .map(n -> new Graph.Node(n.id(), n.kind(), n.group(), n.name(), n.namespace(), n.status(), n.health(),
                            n.reason(), n.missing(), Collections.unmodifiableMap(new LinkedHashMap<>(n.info())), n.labels(), n.created()))
                    .sorted(Comparator.comparing(Graph.Node::id)).toList();
            return new Graph(context, warnings, metrics, sorted, valid);
        }
    }
}
