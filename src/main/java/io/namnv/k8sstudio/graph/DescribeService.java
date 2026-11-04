package io.namnv.k8sstudio.graph;

import io.fabric8.kubernetes.api.model.*;
import io.fabric8.kubernetes.api.model.apps.*;
import io.fabric8.kubernetes.api.model.autoscaling.v2.HPAScalingRules;
import io.fabric8.kubernetes.api.model.autoscaling.v2.HorizontalPodAutoscaler;
import io.fabric8.kubernetes.api.model.autoscaling.v2.MetricSpec;
import io.fabric8.kubernetes.api.model.autoscaling.v2.MetricStatus;
import io.fabric8.kubernetes.api.model.batch.v1.CronJob;
import io.fabric8.kubernetes.api.model.batch.v1.Job;
import io.fabric8.kubernetes.api.model.batch.v1.JobTemplateSpec;
import io.fabric8.kubernetes.api.model.coordination.v1.Lease;
import io.fabric8.kubernetes.api.model.discovery.v1.EndpointSlice;
import io.fabric8.kubernetes.api.model.networking.v1.Ingress;
import io.fabric8.kubernetes.api.model.networking.v1.IngressBackend;
import io.fabric8.kubernetes.api.model.rbac.*;
import org.springframework.stereotype.Service;

import java.math.BigDecimal;
import java.math.BigInteger;
import java.math.RoundingMode;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZonedDateTime;
import java.time.format.DateTimeFormatter;
import java.util.*;

/**
 * `kubectl describe`, generated in-process from the informer cache (no kubectl binary, no extra API calls).
 * A port of kubectl v1.36 pkg/describe: same format strings, same PrefixWriter levels, same tabwriter settings
 * (minwidth 0, tabwidth 8, padding 2) including the Flush() calls that end a column block, Go's
 * resource.Quantity formatting and the pod request/limit arithmetic. Built-in kinds have dedicated describers,
 * everything else (custom resources…) uses kubectl's generic object printer.
 */
@Service
public class DescribeService {

    private static final DateTimeFormatter RFC1123Z = DateTimeFormatter.ofPattern("EEE, dd MMM yyyy HH:mm:ss Z", Locale.ENGLISH)
            .withZone(ZoneId.systemDefault());
    private static final int MAX_ANNOTATION = 140;
    private static final String SKIP_ANNOTATION = "kubectl.kubernetes.io/last-applied-configuration";

    private final ClusterCache cache;

    public DescribeService(ClusterCache cache) {
        this.cache = cache;
    }

    public Optional<String> describe(String kind, String ns, String name) {
        return cache.find(kind, ns == null || ns.isBlank() ? null : ns, name).map(o -> {
            W w = new W();
            switch (o) {
                case Pod p -> pod(w, p);
                case Deployment d -> deployment(w, d);
                case ReplicaSet rs -> replicaSet(w, rs);
                case StatefulSet s -> statefulSet(w, s);
                case DaemonSet ds -> daemonSet(w, ds);
                case Job j -> job(w, j);
                case CronJob cj -> cronJob(w, cj);
                case io.fabric8.kubernetes.api.model.Service s -> service(w, s);
                case Ingress i -> ingress(w, i);
                case ConfigMap c -> configMap(w, c);
                case Secret s -> secret(w, s);
                case PersistentVolumeClaim c -> pvc(w, c);
                case PersistentVolume v -> pv(w, v);
                case io.fabric8.kubernetes.api.model.Node n -> node(w, n);
                case HorizontalPodAutoscaler h -> hpa(w, h);
                case Role r -> role(w, r.getMetadata(), r.getRules());
                case ClusterRole r -> role(w, r.getMetadata(), r.getRules());
                case RoleBinding b -> binding(w, b.getMetadata(), b.getRoleRef(), b.getSubjects());
                case ClusterRoleBinding b -> binding(w, b.getMetadata(), b.getRoleRef(), b.getSubjects());
                case ServiceAccount sa -> serviceAccount(w, sa);
                default -> generic(w, o);
            }
            return tabwrite(w.toString());
        });
    }

    // ================================================================== pod

    private void pod(W w, Pod p) {
        var m = p.getMetadata();
        var spec = p.getSpec();
        var st = p.getStatus() == null ? new PodStatus() : p.getStatus();
        w.w(0, "Name:\t" + m.getName() + "\n");
        w.w(0, "Namespace:\t" + m.getNamespace() + "\n");
        if (spec.getPriority() != null) w.w(0, "Priority:\t" + spec.getPriority() + "\n");
        if (nonEmpty(spec.getPriorityClassName())) w.w(0, "Priority Class Name:\t" + spec.getPriorityClassName() + "\n");
        if (nonEmpty(spec.getRuntimeClassName())) w.w(0, "Runtime Class Name:\t" + spec.getRuntimeClassName() + "\n");
        if (nonEmpty(spec.getServiceAccountName())) w.w(0, "Service Account:\t" + spec.getServiceAccountName() + "\n");
        if (!nonEmpty(spec.getNodeName())) w.w(0, "Node:\t<none>\n");
        else w.w(0, "Node:\t" + spec.getNodeName() + "/" + s(st.getHostIP()) + "\n");
        if (st.getStartTime() != null) w.w(0, "Start Time:\t" + time(st.getStartTime()) + "\n");
        labels(w, "Labels", m.getLabels());
        annotations(w, "Annotations", m.getAnnotations());
        if (m.getDeletionTimestamp() != null && !"Failed".equals(st.getPhase()) && !"Succeeded".equals(st.getPhase())) {
            w.w(0, "Status:\tTerminating (lasts " + since(m.getDeletionTimestamp()) + ")\n");
            w.w(0, "Termination Grace Period:\t" + nz(m.getDeletionGracePeriodSeconds()) + "s\n");
        } else w.w(0, "Status:\t" + s(st.getPhase()) + "\n");
        if (nonEmpty(st.getReason())) w.w(0, "Reason:\t" + st.getReason() + "\n");
        if (nonEmpty(st.getMessage())) w.w(0, "Message:\t" + st.getMessage() + "\n");
        if (spec.getSecurityContext() != null && spec.getSecurityContext().getSeccompProfile() != null) {
            var sp = spec.getSecurityContext().getSeccompProfile();
            w.w(0, "SeccompProfile:\t" + sp.getType() + "\n");
            if ("Localhost".equals(sp.getType())) w.w(0, "LocalhostProfile:\t" + s(sp.getLocalhostProfile()) + "\n");
        }
        w.w(0, "IP:\t" + s(st.getPodIP()) + "\n");
        if (nzl(st.getPodIPs()).isEmpty()) w.w(0, "IPs:\t<none>\n");
        else {
            w.w(0, "IPs:\n");
            for (PodIP ip : st.getPodIPs()) w.w(1, "IP:\t" + ip.getIp() + "\n");
        }
        controlledBy(w, m);
        if (nonEmpty(st.getNominatedNodeName())) w.w(0, "NominatedNodeName:\t" + st.getNominatedNodeName() + "\n");
        if (spec.getResources() != null) {
            w.w(0, "Resources:\n");
            resources(w, spec.getResources(), 1);
        }
        EnvResolver resolver = e -> fieldValue(p, e.getValueFrom().getFieldRef());
        if (!nzl(spec.getInitContainers()).isEmpty())
            containers(w, "Init Containers", spec.getInitContainers(), st.getInitContainerStatuses(), resolver, "");
        containers(w, "Containers", spec.getContainers(), st.getContainerStatuses(), resolver, "");
        if (!nzl(spec.getEphemeralContainers()).isEmpty()) {
            List<Container> ec = new ArrayList<>();
            for (EphemeralContainer e : spec.getEphemeralContainers())
                ec.add(cache.client().getKubernetesSerialization().convertValue(e, Container.class));
            containers(w, "Ephemeral Containers", ec, st.getEphemeralContainerStatuses(), resolver, "");
        }
        if (!nzl(spec.getReadinessGates()).isEmpty()) {
            w.w(0, "Readiness Gates:\n  Type\tStatus\n");
            for (PodReadinessGate g : spec.getReadinessGates()) {
                String status = "<none>";
                for (PodCondition c : nzl(st.getConditions())) if (g.getConditionType().equals(c.getType())) { status = c.getStatus(); break; }
                w.w(1, g.getConditionType() + " \t" + status + " \n");
            }
        }
        if (!nzl(st.getConditions()).isEmpty()) {
            w.w(0, "Conditions:\n  Type\tStatus\n");
            for (PodCondition c : st.getConditions()) w.w(1, c.getType() + " \t" + c.getStatus() + " \n");
        }
        volumes(w, spec.getVolumes(), "");
        w.w(0, "QoS Class:\t" + s(st.getQosClass()) + "\n");
        labels(w, "Node-Selectors", spec.getNodeSelector());
        tolerations(w, "Tolerations", spec.getTolerations());
        topologySpread(w, spec.getTopologySpreadConstraints(), "");
        events(w, p);
    }

    /** kubectl resolves only metadata.name / metadata.namespace (client-go's scheme has no other pod field-label conversions) */
    private static String fieldValue(Pod p, ObjectFieldSelector f) {
        if (f == null) return "";
        return switch (s(f.getFieldPath())) {
            case "metadata.name" -> s(p.getMetadata().getName());
            case "metadata.namespace" -> s(p.getMetadata().getNamespace());
            default -> "";
        };
    }

    private interface EnvResolver { String resolve(EnvVar e); }

    private void containers(W w, String label, List<Container> list, List<ContainerStatus> statusList, EnvResolver resolver, String space) {
        Map<String, ContainerStatus> statuses = new HashMap<>();
        for (ContainerStatus cs : nzl(statusList)) statuses.put(cs.getName(), cs);
        w.w(0, space + label + ":" + (nzl(list).isEmpty() ? " <none>" : "") + "\n");
        for (Container c : nzl(list)) {
            ContainerStatus status = statuses.get(c.getName());
            boolean ok = status != null;
            w.w(1, (space.isEmpty() ? "" : " ") + c.getName() + ":\n");
            if (ok) w.w(2, "Container ID:\t" + s(status.getContainerID()) + "\n");
            w.w(2, "Image:\t" + s(c.getImage()) + "\n");
            if (ok) w.w(2, "Image ID:\t" + s(status.getImageID()) + "\n");
            List<String> ports = new ArrayList<>(), hostPorts = new ArrayList<>();
            for (ContainerPort cp : nzl(c.getPorts())) {
                String n = nonEmpty(cp.getName()) ? " (" + cp.getName() + ")" : "";
                ports.add(nz(cp.getContainerPort()) + "/" + s(cp.getProtocol()) + n);
                hostPorts.add(nz(cp.getHostPort()) + "/" + s(cp.getProtocol()) + n);
            }
            String ps = String.join(", ", ports), hps = String.join(", ", hostPorts);
            if (ps.contains(",")) w.w(2, "Ports:\t" + ps + "\n"); else w.w(2, "Port:\t" + orNone(ps) + "\n");
            if (hps.contains(",")) w.w(2, "Host Ports:\t" + hps + "\n"); else w.w(2, "Host Port:\t" + orNone(hps) + "\n");
            if (c.getSecurityContext() != null && c.getSecurityContext().getSeccompProfile() != null) {
                var sp = c.getSecurityContext().getSeccompProfile();
                w.w(2, "SeccompProfile:\t" + sp.getType() + "\n");
                if ("Localhost".equals(sp.getType())) w.w(3, "LocalhostProfile:\t" + s(sp.getLocalhostProfile()) + "\n");
            }
            if (!nzl(c.getCommand()).isEmpty()) {
                w.w(2, "Command:\n");
                for (String x : c.getCommand()) for (String line : x.split("\n", -1)) w.w(3, line + "\n");
            }
            if (!nzl(c.getArgs()).isEmpty()) {
                w.w(2, "Args:\n");
                for (String x : c.getArgs()) for (String line : x.split("\n", -1)) w.w(3, line + "\n");
            }
            if (ok) {
                state(w, "State", status.getState());
                if (status.getLastState() != null && status.getLastState().getTerminated() != null) state(w, "Last State", status.getLastState());
                w.w(2, "Ready:\t" + bool(Boolean.TRUE.equals(status.getReady())) + "\n");
                w.w(2, "Restart Count:\t" + nz(status.getRestartCount()) + "\n");
            }
            resources(w, c.getResources(), 2);
            if (c.getLivenessProbe() != null) w.w(2, "Liveness:\t" + probe(c.getLivenessProbe()) + "\n");
            if (c.getReadinessProbe() != null) w.w(2, "Readiness:\t" + probe(c.getReadinessProbe()) + "\n");
            if (c.getStartupProbe() != null) w.w(2, "Startup:\t" + probe(c.getStartupProbe()) + "\n");
            if (!nzl(c.getEnvFrom()).isEmpty()) {
                w.w(2, "Environment Variables from:\n");
                for (EnvFromSource e : c.getEnvFrom()) {
                    String from = "", name = "";
                    boolean optional = false;
                    if (e.getConfigMapRef() != null) { from = "ConfigMap"; name = s(e.getConfigMapRef().getName()); optional = Boolean.TRUE.equals(e.getConfigMapRef().getOptional()); }
                    else if (e.getSecretRef() != null) { from = "Secret"; name = s(e.getSecretRef().getName()); optional = Boolean.TRUE.equals(e.getSecretRef().getOptional()); }
                    if (!nonEmpty(e.getPrefix())) w.w(3, name + "\t" + from + "\tOptional: " + optional + "\n");
                    else w.w(3, name + "\t" + from + " with prefix '" + e.getPrefix() + "'\tOptional: " + optional + "\n");
                }
            }
            envVars(w, c, resolver);
            w.w(2, "Mounts:" + (nzl(c.getVolumeMounts()).isEmpty() ? "\t<none>" : "") + "\n");
            List<VolumeMount> mounts = new ArrayList<>(nzl(c.getVolumeMounts()));
            mounts.sort(Comparator.comparing(VolumeMount::getMountPath));
            for (VolumeMount vm : mounts) {
                List<String> flags = new ArrayList<>();
                flags.add(Boolean.TRUE.equals(vm.getReadOnly()) ? "ro" : "rw");
                if (nonEmpty(vm.getSubPath())) flags.add("path=" + goQuote(vm.getSubPath()));
                w.w(3, vm.getMountPath() + " from " + vm.getName() + " (" + String.join(",", flags) + ")\n");
            }
            if (!nzl(c.getVolumeDevices()).isEmpty()) {
                w.w(2, "Devices:" + (nzl(c.getVolumeMounts()).isEmpty() ? "\t<none>" : "") + "\n");
                List<VolumeDevice> devs = new ArrayList<>(c.getVolumeDevices());
                devs.sort(Comparator.comparing(VolumeDevice::getDevicePath));
                for (VolumeDevice d : devs) w.w(3, d.getDevicePath() + " from " + d.getName() + "\n");
            }
        }
    }

    private void envVars(W w, Container c, EnvResolver resolver) {
        w.w(2, "Environment:" + (nzl(c.getEnv()).isEmpty() ? "\t<none>" : "") + "\n");
        for (EnvVar e : nzl(c.getEnv())) {
            var vf = e.getValueFrom();
            if (vf == null) {
                String[] lines = s(e.getValue()).split("\n", -1);
                for (int i = 0; i < lines.length; i++) w.w(3, (i == 0 ? e.getName() + ":\t" : "\t") + lines[i] + "\n");
                continue;
            }
            if (vf.getFieldRef() != null) {
                String v = resolver == null ? "" : resolver.resolve(e);
                w.w(3, e.getName() + ":\t" + v + " (" + s(vf.getFieldRef().getApiVersion()) + ":" + s(vf.getFieldRef().getFieldPath()) + ")\n");
            } else if (vf.getResourceFieldRef() != null) {
                String res = s(vf.getResourceFieldRef().getResource());
                String v = containerResourceValue(vf.getResourceFieldRef(), c);
                if ("0".equals(v) && (res.equals("limits.cpu") || res.equals("limits.memory"))) v = "node allocatable";
                w.w(3, e.getName() + ":\t" + v + " (" + res + ")\n");
            } else if (vf.getSecretKeyRef() != null) {
                w.w(3, e.getName() + ":\t<set to the key '" + vf.getSecretKeyRef().getKey() + "' in secret '" + vf.getSecretKeyRef().getName()
                        + "'>\tOptional: " + Boolean.TRUE.equals(vf.getSecretKeyRef().getOptional()) + "\n");
            } else if (vf.getConfigMapKeyRef() != null) {
                w.w(3, e.getName() + ":\t<set to the key '" + vf.getConfigMapKeyRef().getKey() + "' of config map '" + vf.getConfigMapKeyRef().getName()
                        + "'>\tOptional: " + Boolean.TRUE.equals(vf.getConfigMapKeyRef().getOptional()) + "\n");
            }
        }
    }

    /** kubectl's ExtractContainerResourceValue: ceil(value / divisor), for the container being described */
    private static String containerResourceValue(ResourceFieldSelector f, Container c) {
        BigDecimal divisor = f.getDivisor() == null || Quantity.getAmountInBytes(f.getDivisor()).signum() == 0
                ? BigDecimal.ONE : Quantity.getAmountInBytes(f.getDivisor());
        String res = s(f.getResource());
        int dot = res.indexOf('.');
        if (dot < 0) return "";
        String kind = res.substring(0, dot), name = res.substring(dot + 1);
        if (!name.equals("cpu") && !name.equals("memory") && !name.equals("ephemeral-storage") && !name.startsWith("hugepages-")) return "";
        Map<String, Quantity> list = c.getResources() == null ? null
                : kind.equals("limits") ? c.getResources().getLimits() : kind.equals("requests") ? c.getResources().getRequests() : null;
        if (list == null && !kind.equals("limits") && !kind.equals("requests")) return "";
        BigDecimal v = qq(nzm(list).get(name)).v;
        if (name.equals("cpu")) return String.valueOf((long) Math.ceil((double) milli(v) / (double) milli(divisor)));
        return String.valueOf((long) Math.ceil((double) value(v) / (double) value(divisor)));
    }

    private static void state(W w, String title, ContainerState st) {
        if (st != null && st.getRunning() != null) {
            w.w(2, title + ":\tRunning\n");
            w.w(3, "Started:\t" + time(st.getRunning().getStartedAt()) + "\n");
        } else if (st != null && st.getWaiting() != null) {
            w.w(2, title + ":\tWaiting\n");
            if (nonEmpty(st.getWaiting().getReason())) w.w(3, "Reason:\t" + st.getWaiting().getReason() + "\n");
        } else if (st != null && st.getTerminated() != null) {
            var t = st.getTerminated();
            w.w(2, title + ":\tTerminated\n");
            if (nonEmpty(t.getReason())) w.w(3, "Reason:\t" + t.getReason() + "\n");
            if (nonEmpty(t.getMessage())) w.w(3, "Message:\t" + t.getMessage() + "\n");
            w.w(3, "Exit Code:\t" + nz(t.getExitCode()) + "\n");
            if (nz(t.getSignal()) > 0) w.w(3, "Signal:\t" + t.getSignal() + "\n");
            w.w(3, "Started:\t" + time(t.getStartedAt()) + "\n");
            w.w(3, "Finished:\t" + time(t.getFinishedAt()) + "\n");
        } else w.w(2, title + ":\tWaiting\n");
    }

    private static void resources(W w, ResourceRequirements r, int level) {
        if (r == null) return;
        if (!nzm(r.getLimits()).isEmpty()) w.w(level, "Limits:\n");
        for (var e : new TreeMap<>(nzm(r.getLimits())).entrySet()) w.w(level + 1, e.getKey() + ":\t" + q(e.getValue()) + "\n");
        if (!nzm(r.getRequests()).isEmpty()) w.w(level, "Requests:\n");
        for (var e : new TreeMap<>(nzm(r.getRequests())).entrySet()) w.w(level + 1, e.getKey() + ":\t" + q(e.getValue()) + "\n");
    }

    private static String probe(Probe p) {
        String attrs = "delay=" + nz(p.getInitialDelaySeconds()) + "s timeout=" + nz(p.getTimeoutSeconds()) + "s period=" + nz(p.getPeriodSeconds())
                + "s #success=" + nz(p.getSuccessThreshold()) + " #failure=" + nz(p.getFailureThreshold());
        if (p.getExec() != null) return "exec [" + String.join(" ", nzl(p.getExec().getCommand())) + "] " + attrs;
        if (p.getHttpGet() != null) {
            var h = p.getHttpGet();
            String port = ios(h.getPort());
            String host = port.isEmpty() ? s(h.getHost()) : (s(h.getHost()).contains(":") ? "[" + h.getHost() + "]" : s(h.getHost())) + ":" + port;
            String path = s(h.getPath());
            if (!path.isEmpty() && !path.startsWith("/") && !host.isEmpty()) path = "/" + path;
            String scheme = s(h.getScheme()).toLowerCase(Locale.ROOT);
            return "http-get " + (scheme.isEmpty() ? "" : scheme + ":") + (host.isEmpty() && scheme.isEmpty() ? "" : "//") + host + path + " " + attrs;
        }
        if (p.getTcpSocket() != null) return "tcp-socket " + s(p.getTcpSocket().getHost()) + ":" + ios(p.getTcpSocket().getPort()) + " " + attrs;
        if (p.getGrpc() != null) return "grpc <pod>:" + nz(p.getGrpc().getPort()) + " " + s(p.getGrpc().getService()) + " " + attrs;
        return "unknown " + attrs;
    }

    private void volumes(W w, List<Volume> vols, String space) {
        if (nzl(vols).isEmpty()) { w.w(0, space + "Volumes:\t<none>\n"); return; }
        w.w(0, space + "Volumes:\n");
        for (Volume v : vols) {
            w.w(1, (space.isEmpty() ? "" : " ") + v.getName() + ":\n");
            if (v.getHostPath() != null) {
                w.w(2, "Type:\tHostPath (bare host directory volume)\n    Path:\t" + s(v.getHostPath().getPath())
                        + "\n    HostPathType:\t" + (v.getHostPath().getType() == null ? "<none>" : v.getHostPath().getType()) + "\n");
            } else if (v.getEmptyDir() != null) {
                var sl = v.getEmptyDir().getSizeLimit();
                String size = sl != null && Quantity.getAmountInBytes(sl).signum() > 0 ? q(sl) : "<unset>";
                w.w(2, "Type:\tEmptyDir (a temporary directory that shares a pod's lifetime)\n    Medium:\t" + s(v.getEmptyDir().getMedium())
                        + "\n    SizeLimit:\t" + size + "\n");
            } else if (v.getSecret() != null) {
                w.w(2, "Type:\tSecret (a volume populated by a Secret)\n    SecretName:\t" + s(v.getSecret().getSecretName())
                        + "\n    Optional:\t" + Boolean.TRUE.equals(v.getSecret().getOptional()) + "\n");
            } else if (v.getConfigMap() != null) {
                w.w(2, "Type:\tConfigMap (a volume populated by a ConfigMap)\n    Name:\t" + s(v.getConfigMap().getName())
                        + "\n    Optional:\t" + Boolean.TRUE.equals(v.getConfigMap().getOptional()) + "\n");
            } else if (v.getNfs() != null) {
                w.w(2, "Type:\tNFS (an NFS mount that lasts the lifetime of a pod)\n    Server:\t" + s(v.getNfs().getServer())
                        + "\n    Path:\t" + s(v.getNfs().getPath()) + "\n    ReadOnly:\t" + Boolean.TRUE.equals(v.getNfs().getReadOnly()) + "\n");
            } else if (v.getPersistentVolumeClaim() != null) {
                w.w(2, "Type:\tPersistentVolumeClaim (a reference to a PersistentVolumeClaim in the same namespace)\n    ClaimName:\t"
                        + s(v.getPersistentVolumeClaim().getClaimName()) + "\n    ReadOnly:\t" + Boolean.TRUE.equals(v.getPersistentVolumeClaim().getReadOnly()) + "\n");
            } else if (v.getEphemeral() != null) {
                w.w(2, "Type:\tEphemeralVolume (an inline specification for a volume that gets created and deleted with the pod)\n");
            } else if (v.getDownwardAPI() != null) {
                w.w(2, "Type:\tDownwardAPI (a volume populated by information about the pod)\n    Items:\n");
                for (var it : nzl(v.getDownwardAPI().getItems())) {
                    if (it.getFieldRef() != null) w.w(3, it.getFieldRef().getFieldPath() + " -> " + it.getPath() + "\n");
                    if (it.getResourceFieldRef() != null) w.w(3, it.getResourceFieldRef().getResource() + " -> " + it.getPath() + "\n");
                }
            } else if (v.getProjected() != null) {
                w.w(2, "Type:\tProjected (a volume that contains injected data from multiple sources)\n");
                for (var src : nzl(v.getProjected().getSources())) {
                    if (src.getSecret() != null)
                        w.w(2, "SecretName:\t" + s(src.getSecret().getName()) + "\n    Optional:\t" + Boolean.TRUE.equals(src.getSecret().getOptional()) + "\n");
                    else if (src.getDownwardAPI() != null) w.w(2, "DownwardAPI:\ttrue\n");
                    else if (src.getConfigMap() != null)
                        w.w(2, "ConfigMapName:\t" + s(src.getConfigMap().getName()) + "\n    Optional:\t" + Boolean.TRUE.equals(src.getConfigMap().getOptional()) + "\n");
                    else if (src.getServiceAccountToken() != null)
                        w.w(2, "TokenExpirationSeconds:\t" + nz(src.getServiceAccountToken().getExpirationSeconds()) + "\n");
                }
            } else if (v.getCsi() != null) {
                var c = v.getCsi();
                w.w(2, "Type:\tCSI (a Container Storage Interface (CSI) volume source)\n    Driver:\t" + s(c.getDriver())
                        + "\n    FSType:\t" + s(c.getFsType()) + "\n    ReadOnly:\t" + Boolean.TRUE.equals(c.getReadOnly()) + "\n");
                w.w(2, "VolumeAttributes:\t");
                if (nzm(c.getVolumeAttributes()).isEmpty()) w.line("<none>");
                else {
                    boolean first = true;
                    for (var e : new TreeMap<>(c.getVolumeAttributes()).entrySet()) {
                        if (!first) w.w(0, "\t\t\t");
                        w.w(0, e.getKey() + "=" + e.getValue() + "\n");
                        first = false;
                    }
                }
            } else if (v.getImage() != null) {
                w.w(2, "Type:\tImage (a container image or OCI artifact)\n    Reference:\t" + s(v.getImage().getReference())
                        + "\n    PullPolicy:\t" + s(v.getImage().getPullPolicy()) + "\n");
            } else w.w(1, "<unknown>\n");
        }
    }

    private static void topologySpread(W w, List<TopologySpreadConstraint> tscs, String space) {
        if (nzl(tscs).isEmpty()) return;
        List<TopologySpreadConstraint> l = new ArrayList<>(tscs);
        l.sort(Comparator.comparing(TopologySpreadConstraint::getTopologyKey));
        w.w(0, space + "Topology Spread Constraints:\t");
        for (int i = 0; i < l.size(); i++) {
            var t = l.get(i);
            if (i != 0) w.w(0, space + "\t");
            w.w(0, t.getTopologyKey() + ":" + t.getWhenUnsatisfiable() + " when max skew " + nz(t.getMaxSkew()) + " is exceeded");
            if (t.getLabelSelector() != null) w.w(0, " for selector " + selector(t.getLabelSelector()));
            w.w(0, "\n");
        }
    }

    // ================================================================== workloads

    private void podTemplate(W w, PodTemplateSpec t) {
        w.w(0, "Pod Template:\n");
        if (t == null) { w.w(1, "<unset>"); return; }
        var m = t.getMetadata() == null ? new ObjectMeta() : t.getMetadata();
        labels(w, "  Labels", m.getLabels());
        if (!nzm(m.getAnnotations()).isEmpty()) annotations(w, "  Annotations", m.getAnnotations());
        var spec = t.getSpec();
        if (nonEmpty(spec.getServiceAccountName())) w.w(1, "Service Account:\t" + spec.getServiceAccountName() + "\n");
        if (!nzl(spec.getInitContainers()).isEmpty()) containers(w, "Init Containers", spec.getInitContainers(), null, null, "  ");
        containers(w, "Containers", spec.getContainers(), null, null, "  ");
        volumes(w, spec.getVolumes(), "  ");
        topologySpread(w, spec.getTopologySpreadConstraints(), "  ");
        if (nonEmpty(spec.getPriorityClassName())) w.w(1, "Priority Class Name:\t" + spec.getPriorityClassName() + "\n");
        labels(w, "  Node-Selectors", spec.getNodeSelector());
        tolerations(w, "  Tolerations", spec.getTolerations());
    }

    private void deployment(W w, Deployment d) {
        var m = d.getMetadata();
        var spec = d.getSpec();
        var st = d.getStatus() == null ? new DeploymentStatus() : d.getStatus();
        w.w(0, "Name:\t" + m.getName() + "\n");
        w.w(0, "Namespace:\t" + m.getNamespace() + "\n");
        w.w(0, "CreationTimestamp:\t" + time(m.getCreationTimestamp()) + "\n");
        labels(w, "Labels", m.getLabels());
        annotations(w, "Annotations", m.getAnnotations());
        w.w(0, "Selector:\t" + selector(spec.getSelector()) + "\n");
        w.w(0, "Replicas:\t" + nz(spec.getReplicas()) + " desired | " + nz(st.getUpdatedReplicas()) + " updated | " + nz(st.getReplicas()) + " total | "
                + nz(st.getAvailableReplicas()) + " available | " + nz(st.getUnavailableReplicas()) + " unavailable\n");
        var strategy = spec.getStrategy();
        w.w(0, "StrategyType:\t" + (strategy == null ? "" : s(strategy.getType())) + "\n");
        w.w(0, "MinReadySeconds:\t" + nz(spec.getMinReadySeconds()) + "\n");
        if (strategy != null && strategy.getRollingUpdate() != null) {
            var ru = strategy.getRollingUpdate();
            w.w(0, "RollingUpdateStrategy:\t" + iosOr0(ru.getMaxUnavailable()) + " max unavailable, " + iosOr0(ru.getMaxSurge()) + " max surge\n");
        }
        podTemplate(w, spec.getTemplate());
        if (!nzl(st.getConditions()).isEmpty()) {
            w.w(0, "Conditions:\n  Type\tStatus\tReason\n");
            w.w(1, "----\t------\t------\n");
            for (var c : st.getConditions()) w.w(1, c.getType() + " \t" + c.getStatus() + "\t" + s(c.getReason()) + "\n");
        }
        // kubectl: ReplicaSets controlled by the deployment; the new one has the deployment's revision, all others are old (even at 0 replicas)
        String rev = ann(d, "deployment.kubernetes.io/revision");
        List<ReplicaSet> rss = new ArrayList<>(ClusterCache.list(cache.replicaSets, m.getNamespace()).stream().filter(rs -> controlledBy(rs, d)).toList());
        rss.sort(Comparator.comparing(rs -> rs.getMetadata().getName()));
        List<String> old = new ArrayList<>(), cur = new ArrayList<>();
        for (ReplicaSet rs : rss) {
            String txt = rs.getMetadata().getName() + " (" + nz(rs.getStatus() == null ? null : rs.getStatus().getReplicas()) + "/" + nz(rs.getSpec().getReplicas()) + " replicas created)";
            if (cur.isEmpty() && rev != null && rev.equals(ann(rs, "deployment.kubernetes.io/revision"))) cur.add(txt); else old.add(txt);
        }
        if (!old.isEmpty() || !cur.isEmpty()) {
            w.w(0, "OldReplicaSets:\t" + (old.isEmpty() ? "<none>" : String.join(", ", old)) + "\n");
            w.w(0, "NewReplicaSet:\t" + (cur.isEmpty() ? "<none>" : String.join(", ", cur)) + "\n");
        }
        events(w, d);
    }

    private void replicaSet(W w, ReplicaSet rs) {
        var m = rs.getMetadata();
        w.w(0, "Name:\t" + m.getName() + "\n");
        w.w(0, "Namespace:\t" + m.getNamespace() + "\n");
        w.w(0, "Selector:\t" + selector(rs.getSpec().getSelector()) + "\n");
        labels(w, "Labels", m.getLabels());
        annotations(w, "Annotations", m.getAnnotations());
        controlledBy(w, m);
        w.w(0, "Replicas:\t" + nz(rs.getStatus() == null ? null : rs.getStatus().getReplicas()) + " current / " + nz(rs.getSpec().getReplicas()) + " desired\n");
        w.w(0, "Pods Status:\t");
        w.w(0, podsStatus(rs) + "\n");
        podTemplate(w, rs.getSpec().getTemplate());
        if (rs.getStatus() != null && !nzl(rs.getStatus().getConditions()).isEmpty()) {
            w.w(0, "Conditions:\n  Type\tStatus\tReason\n");
            w.w(1, "----\t------\t------\n");
            for (var c : rs.getStatus().getConditions()) w.w(1, c.getType() + " \t" + c.getStatus() + "\t" + s(c.getReason()) + "\n");
        }
        events(w, rs);
    }

    private void statefulSet(W w, StatefulSet ss) {
        var m = ss.getMetadata();
        var spec = ss.getSpec();
        w.w(0, "Name:\t" + m.getName() + "\n");
        w.w(0, "Namespace:\t" + m.getNamespace() + "\n");
        w.w(0, "CreationTimestamp:\t" + time(m.getCreationTimestamp()) + "\n");
        w.w(0, "Selector:\t" + selector(spec.getSelector()) + "\n");
        labels(w, "Labels", m.getLabels());
        annotations(w, "Annotations", m.getAnnotations());
        w.w(0, "Replicas:\t" + nz(spec.getReplicas()) + " desired | " + nz(ss.getStatus() == null ? null : ss.getStatus().getReplicas()) + " total\n");
        var us = spec.getUpdateStrategy();
        w.w(0, "Update Strategy:\t" + (us == null ? "" : s(us.getType())) + "\n");
        if (us != null && us.getRollingUpdate() != null && us.getRollingUpdate().getPartition() != null) {
            w.w(1, "Partition:\t" + us.getRollingUpdate().getPartition() + "\n");
            if (us.getRollingUpdate().getMaxUnavailable() != null) w.w(1, "MaxUnavailable:\t" + ios(us.getRollingUpdate().getMaxUnavailable()) + "\n");
        }
        w.w(0, "Pods Status:\t" + podsStatus(ss) + "\n");
        podTemplate(w, spec.getTemplate());
        if (nzl(spec.getVolumeClaimTemplates()).isEmpty()) w.w(0, "Volume Claims:\t<none>\n");
        else {
            w.w(0, "Volume Claims:\n");
            for (PersistentVolumeClaim c : spec.getVolumeClaimTemplates()) {
                w.w(1, "Name:\t" + c.getMetadata().getName() + "\n");
                w.w(1, "StorageClass:\t" + storageClassOf(c) + "\n");
                labels(w, "  ", "Labels", "\t", c.getMetadata().getLabels());
                labels(w, "  ", "Annotations", "\t", c.getMetadata().getAnnotations());
                Quantity cap = c.getSpec().getResources() == null ? null : nzm(c.getSpec().getResources().getRequests()).get("storage");
                w.w(1, "Capacity:\t" + (cap == null ? "<default>" : q(cap)) + "\n");
                w.w(1, "Access Modes:\t[" + String.join(" ", nzl(c.getSpec().getAccessModes())) + "]\n");
            }
        }
        events(w, ss);
    }

    private void daemonSet(W w, DaemonSet ds) {
        var m = ds.getMetadata();
        var st = ds.getStatus() == null ? new DaemonSetStatus() : ds.getStatus();
        w.w(0, "Name:\t" + m.getName() + "\n");
        w.w(0, "Namespace:\t" + m.getNamespace() + "\n");
        w.w(0, "Selector:\t" + selector(ds.getSpec().getSelector()) + "\n");
        w.w(0, "Node-Selector:\t" + formatLabels(ds.getSpec().getTemplate().getSpec().getNodeSelector()) + "\n");
        labels(w, "Labels", m.getLabels());
        annotations(w, "Annotations", m.getAnnotations());
        w.w(0, "Desired Number of Nodes Scheduled: " + nz(st.getDesiredNumberScheduled()) + "\n");
        w.w(0, "Current Number of Nodes Scheduled: " + nz(st.getCurrentNumberScheduled()) + "\n");
        w.w(0, "Number of Nodes Scheduled with Up-to-date Pods: " + nz(st.getUpdatedNumberScheduled()) + "\n");
        w.w(0, "Number of Nodes Scheduled with Available Pods: " + nz(st.getNumberAvailable()) + "\n");
        w.w(0, "Number of Nodes Misscheduled: " + nz(st.getNumberMisscheduled()) + "\n");
        w.w(0, "Pods Status:\t" + podsStatus(ds) + "\n");
        podTemplate(w, ds.getSpec().getTemplate());
        events(w, ds);
    }

    private void job(W w, Job j) {
        var m = j.getMetadata();
        var spec = j.getSpec();
        var st = j.getStatus() == null ? new io.fabric8.kubernetes.api.model.batch.v1.JobStatus() : j.getStatus();
        w.w(0, "Name:\t" + m.getName() + "\n");
        w.w(0, "Namespace:\t" + m.getNamespace() + "\n");
        w.w(0, "Selector:\t" + selector(spec.getSelector()) + "\n");
        labels(w, "Labels", m.getLabels());
        annotations(w, "Annotations", m.getAnnotations());
        controlledBy(w, m);
        if (spec.getParallelism() != null) w.w(0, "Parallelism:\t" + spec.getParallelism() + "\n");
        w.w(0, "Completions:\t" + (spec.getCompletions() == null ? "<unset>" : spec.getCompletions()) + "\n");
        if (spec.getCompletionMode() != null) w.w(0, "Completion Mode:\t" + spec.getCompletionMode() + "\n");
        if (spec.getSuspend() != null) w.w(0, "Suspend:\t" + spec.getSuspend() + "\n");
        if (spec.getBackoffLimit() != null) w.w(0, "Backoff Limit:\t" + spec.getBackoffLimit() + "\n");
        if (spec.getTtlSecondsAfterFinished() != null) w.w(0, "TTL Seconds After Finished:\t" + spec.getTtlSecondsAfterFinished() + "\n");
        if (st.getStartTime() != null) w.w(0, "Start Time:\t" + time(st.getStartTime()) + "\n");
        if (st.getCompletionTime() != null) w.w(0, "Completed At:\t" + time(st.getCompletionTime()) + "\n");
        if (st.getStartTime() != null && st.getCompletionTime() != null)
            w.w(0, "Duration:\t" + human(Duration.between(Instant.parse(st.getStartTime()), Instant.parse(st.getCompletionTime()))) + "\n");
        if (spec.getActiveDeadlineSeconds() != null) w.w(0, "Active Deadline Seconds:\t" + spec.getActiveDeadlineSeconds() + "s\n");
        if (st.getReady() == null) w.w(0, "Pods Statuses:\t" + nz(st.getActive()) + " Active / " + nz(st.getSucceeded()) + " Succeeded / " + nz(st.getFailed()) + " Failed\n");
        else w.w(0, "Pods Statuses:\t" + nz(st.getActive()) + " Active (" + st.getReady() + " Ready) / " + nz(st.getSucceeded()) + " Succeeded / " + nz(st.getFailed()) + " Failed\n");
        if ("Indexed".equals(spec.getCompletionMode())) w.w(0, "Completed Indexes:\t" + capIndexes(st.getCompletedIndexes(), 50) + "\n");
        podTemplate(w, spec.getTemplate());
        events(w, j);
    }

    private static String capIndexes(String ix, int soft) {
        if (ix == null || ix.isEmpty()) return "<none>";
        int i = soft;
        for (; i < ix.length(); i++) if (ix.charAt(i) == ',') break;
        return i >= ix.length() ? ix : ix.substring(0, i + 1) + "...";
    }

    private void cronJob(W w, CronJob cj) {
        var m = cj.getMetadata();
        var spec = cj.getSpec();
        w.w(0, "Name:\t" + m.getName() + "\n");
        w.w(0, "Namespace:\t" + m.getNamespace() + "\n");
        labels(w, "Labels", m.getLabels());
        annotations(w, "Annotations", m.getAnnotations());
        w.w(0, "Schedule:\t" + spec.getSchedule() + "\n");
        w.w(0, "Concurrency Policy:\t" + s(spec.getConcurrencyPolicy()) + "\n");
        w.w(0, "Suspend:\t" + (spec.getSuspend() == null ? "<unset>" : bool(spec.getSuspend())) + "\n");
        w.w(0, "Time Zone:\t" + (spec.getTimeZone() == null ? "<unset>" : spec.getTimeZone()) + "\n");
        w.w(0, "Successful Job History Limit:\t" + (spec.getSuccessfulJobsHistoryLimit() == null ? "<unset>" : spec.getSuccessfulJobsHistoryLimit()) + "\n");
        w.w(0, "Failed Job History Limit:\t" + (spec.getFailedJobsHistoryLimit() == null ? "<unset>" : spec.getFailedJobsHistoryLimit()) + "\n");
        w.w(0, "Starting Deadline Seconds:\t" + (spec.getStartingDeadlineSeconds() == null ? "<unset>" : spec.getStartingDeadlineSeconds() + "s") + "\n");
        JobTemplateSpec jt = spec.getJobTemplate();
        var js = jt.getSpec();
        w.w(0, "Selector:\t" + (js.getSelector() == null ? "<unset>" : selector(js.getSelector())) + "\n");
        w.w(0, "Parallelism:\t" + (js.getParallelism() == null ? "<unset>" : js.getParallelism()) + "\n");
        w.w(0, "Completions:\t" + (js.getCompletions() == null ? "<unset>" : js.getCompletions()) + "\n");
        if (js.getActiveDeadlineSeconds() != null) w.w(0, "Active Deadline Seconds:\t" + js.getActiveDeadlineSeconds() + "s\n");
        podTemplate(w, js.getTemplate());
        var st = cj.getStatus();
        w.w(0, "Last Schedule Time:\t" + (st == null || st.getLastScheduleTime() == null ? "<unset>" : time(st.getLastScheduleTime())) + "\n");
        List<ObjectReference> active = st == null ? List.of() : nzl(st.getActive());
        w.w(0, "Active Jobs:\t");
        if (active.isEmpty()) w.line("<none>");
        else w.line(String.join(", ", active.stream().map(ObjectReference::getName).toList()));
        events(w, cj);
    }

    // ================================================================== networking

    private void service(W w, io.fabric8.kubernetes.api.model.Service svc) {
        var m = svc.getMetadata();
        var spec = svc.getSpec();
        w.w(0, "Name:\t" + m.getName() + "\n");
        w.w(0, "Namespace:\t" + m.getNamespace() + "\n");
        labels(w, "Labels", m.getLabels());
        annotations(w, "Annotations", m.getAnnotations());
        w.w(0, "Selector:\t" + formatLabels(spec.getSelector()) + "\n");
        w.w(0, "Type:\t" + s(spec.getType()) + "\n");
        if (spec.getIpFamilyPolicy() != null) w.w(0, "IP Family Policy:\t" + spec.getIpFamilyPolicy() + "\n");
        w.w(0, "IP Families:\t" + (nzl(spec.getIpFamilies()).isEmpty() ? "<none>" : String.join(",", spec.getIpFamilies())) + "\n");
        w.w(0, "IP:\t" + s(spec.getClusterIP()) + "\n");
        w.w(0, "IPs:\t" + (nzl(spec.getClusterIPs()).isEmpty() ? "<none>" : String.join(",", spec.getClusterIPs())) + "\n");
        if (!nzl(spec.getExternalIPs()).isEmpty()) w.w(0, "External IPs:\t" + String.join(",", spec.getExternalIPs()) + "\n");
        if (nonEmpty(spec.getLoadBalancerIP())) w.w(0, "Desired LoadBalancer IP:\t" + spec.getLoadBalancerIP() + "\n");
        if (nonEmpty(spec.getExternalName())) w.w(0, "External Name:\t" + spec.getExternalName() + "\n");
        var lbi = svc.getStatus() == null || svc.getStatus().getLoadBalancer() == null ? List.<LoadBalancerIngress>of() : nzl(svc.getStatus().getLoadBalancer().getIngress());
        if (!lbi.isEmpty()) {
            List<String> parts = new ArrayList<>();
            for (var i : lbi) parts.add(nonEmpty(i.getIp()) ? i.getIp() + (i.getIpMode() != null ? " (" + i.getIpMode() + ")" : "") : s(i.getHostname()));
            w.w(0, "LoadBalancer Ingress:\t" + String.join(", ", parts) + "\n");
        }
        List<EndpointSlice> slices = new ArrayList<>(ClusterCache.list(cache.endpointSlices, m.getNamespace()).stream()
                .filter(es -> m.getName().equals(nzm(es.getMetadata().getLabels()).get("kubernetes.io/service-name"))).toList());
        slices.sort(Comparator.comparing(es -> es.getMetadata().getName()));
        for (ServicePort sp : nzl(spec.getPorts())) {
            String name = nonEmpty(sp.getName()) ? sp.getName() : "<unset>";
            w.w(0, "Port:\t" + name + "\t" + nz(sp.getPort()) + "/" + s(sp.getProtocol()) + "\n");
            w.w(0, "TargetPort:\t" + ios(sp.getTargetPort()) + "/" + s(sp.getProtocol()) + "\n");
            if (sp.getAppProtocol() != null) w.w(0, "AppProtocol:\t" + sp.getAppProtocol() + "\n");
            if (nz(sp.getNodePort()) != 0) w.w(0, "NodePort:\t" + name + "\t" + sp.getNodePort() + "/" + s(sp.getProtocol()) + "\n");
            w.w(0, "Endpoints:\t" + endpoints(slices, s(sp.getName())) + "\n");
        }
        w.w(0, "Session Affinity:\t" + s(spec.getSessionAffinity()) + "\n");
        if (nonEmpty(spec.getExternalTrafficPolicy())) w.w(0, "External Traffic Policy:\t" + spec.getExternalTrafficPolicy() + "\n");
        if (spec.getInternalTrafficPolicy() != null) w.w(0, "Internal Traffic Policy:\t" + spec.getInternalTrafficPolicy() + "\n");
        if (nz(spec.getHealthCheckNodePort()) != 0) w.w(0, "HealthCheck NodePort:\t" + spec.getHealthCheckNodePort() + "\n");
        if (!nzl(spec.getLoadBalancerSourceRanges()).isEmpty()) w.w(0, "LoadBalancer Source Ranges:\t" + String.join(",", spec.getLoadBalancerSourceRanges()) + "\n");
        if (spec.getTrafficDistribution() != null) w.w(0, "Traffic Distribution:\t" + spec.getTrafficDistribution() + "\n");
        events(w, svc);
    }

    /** kubectl's formatEndpointSlices: ready endpoints of the slices' port with that name, at most 3 shown */
    private static String endpoints(List<EndpointSlice> slices, String portName) {
        if (slices.isEmpty()) return "<none>";
        List<String> list = new ArrayList<>();
        int max = 3, count = 0;
        boolean more = false;
        for (EndpointSlice es : slices) {
            if (nzl(es.getPorts()).isEmpty()) {
                for (var e : nzl(es.getEndpoints())) {
                    if (list.size() == max) more = true;
                    if (e.getConditions() != null && Boolean.FALSE.equals(e.getConditions().getReady())) continue;
                    if (!more) list.add(e.getAddresses().get(0));
                    count++;
                }
            } else for (var port : es.getPorts()) {
                if (!portName.equals(s(port.getName()))) continue;
                for (var e : nzl(es.getEndpoints())) {
                    if (list.size() == max) more = true;
                    String addr = e.getAddresses().get(0);
                    if (e.getConditions() != null && Boolean.FALSE.equals(e.getConditions().getReady())) continue;
                    if (!more) list.add((addr.contains(":") ? "[" + addr + "]" : addr) + ":" + nz(port.getPort()));
                    count++;
                }
            }
        }
        String ret = String.join(",", list);
        return more ? ret + " + " + (count - max) + " more..." : ret;
    }

    private void ingress(W w, Ingress i) {
        var m = i.getMetadata();
        var spec = i.getSpec();
        w.w(0, "Name:\t" + m.getName() + "\n");
        labels(w, "Labels", m.getLabels());
        w.w(0, "Namespace:\t" + m.getNamespace() + "\n");
        String addr = i.getStatus() == null || i.getStatus().getLoadBalancer() == null ? "" : String.join(",", new TreeSet<>(nzl(i.getStatus().getLoadBalancer().getIngress())
                .stream().map(x -> nonEmpty(x.getIp()) ? x.getIp() : s(x.getHostname())).filter(x -> !x.isEmpty()).toList()));
        w.w(0, "Address:\t" + addr + "\n");
        w.w(0, "Ingress Class:\t" + (nonEmpty(spec.getIngressClassName()) ? spec.getIngressClassName() : "<none>") + "\n");
        w.w(0, "Default backend:\t" + (spec.getDefaultBackend() == null ? "<default>" : backend(spec.getDefaultBackend(), m.getNamespace())) + "\n");
        if (!nzl(spec.getTls()).isEmpty()) {
            w.w(0, "TLS:\n");
            for (var t : spec.getTls()) w.w(1, (nonEmpty(t.getSecretName()) ? t.getSecretName() : "SNI") + " terminates " + String.join(",", nzl(t.getHosts())) + "\n");
        }
        w.w(0, "Rules:\n");
        w.w(1, "Host\tPath\tBackends\n");
        w.w(1, "----\t----\t--------\n");
        for (var r : nzl(spec.getRules())) {
            w.w(1, (nonEmpty(r.getHost()) ? r.getHost() : "*") + "\t\n");
            if (r.getHttp() != null) for (var p : nzl(r.getHttp().getPaths()))
                w.w(1, "\t" + (nonEmpty(p.getPath()) ? p.getPath() : "/") + " \t" + backend(p.getBackend(), m.getNamespace()) + "\n");
        }
        annotations(w, "Annotations", m.getAnnotations());
        events(w, i);
    }

    private String backend(IngressBackend b, String ns) {
        if (b.getService() == null) return b.getResource() == null ? "<none>"
                : "APIGroup: " + s(b.getResource().getApiGroup()) + ", Kind: " + b.getResource().getKind() + ", Name: " + b.getResource().getName();
        var port = b.getService().getPort();
        String p = port == null ? "" : port.getNumber() != null && port.getNumber() != 0 ? String.valueOf(port.getNumber()) : s(port.getName());
        var svc = ClusterCache.get(cache.services, ns, b.getService().getName());
        if (svc == null) return b.getService().getName() + ":" + p + " (<error: services \"" + b.getService().getName() + "\" not found>)";
        // the Service port the backend refers to, then that port's endpoints
        String portName = "";
        for (ServicePort sp : nzl(svc.getSpec().getPorts()))
            if ((port != null && port.getNumber() != null && port.getNumber().equals(sp.getPort())) || (port != null && nonEmpty(port.getName()) && port.getName().equals(sp.getName())))
                portName = s(sp.getName());
        List<EndpointSlice> slices = new ArrayList<>(ClusterCache.list(cache.endpointSlices, ns).stream()
                .filter(es -> b.getService().getName().equals(nzm(es.getMetadata().getLabels()).get("kubernetes.io/service-name"))).toList());
        slices.sort(Comparator.comparing(es -> es.getMetadata().getName()));
        String eps = endpoints(slices, portName);
        return b.getService().getName() + ":" + p + " (" + ("<none>".equals(eps) ? "" : eps) + ")";
    }

    // ================================================================== config & storage

    private void configMap(W w, ConfigMap c) {
        var m = c.getMetadata();
        w.w(0, "Name:\t" + m.getName() + "\n");
        w.w(0, "Namespace:\t" + m.getNamespace() + "\n");
        labels(w, "Labels", m.getLabels());
        annotations(w, "Annotations", m.getAnnotations());
        w.w(0, "\nData\n====\n");
        for (var e : new TreeMap<>(nzm(c.getData())).entrySet()) {
            w.w(0, e.getKey() + ":\n----\n");
            w.w(0, e.getValue() + "\n\n");
        }
        w.w(0, "\nBinaryData\n====\n");
        for (var e : new TreeMap<>(nzm(c.getBinaryData())).entrySet())
            w.w(0, e.getKey() + ": " + Base64.getDecoder().decode(e.getValue()).length + " bytes\n");
        w.w(0, "\n");
        events(w, c);
    }

    /** like kubectl: sizes only, never values */
    private void secret(W w, Secret sec) {
        var m = sec.getMetadata();
        w.w(0, "Name:\t" + m.getName() + "\n");
        w.w(0, "Namespace:\t" + m.getNamespace() + "\n");
        labels(w, "Labels", m.getLabels());
        annotations(w, "Annotations", m.getAnnotations());
        w.w(0, "\nType:\t" + sec.getType() + "\n");
        w.w(0, "\nData\n====\n");
        for (var e : new TreeMap<>(nzm(sec.getData())).entrySet())
            w.w(0, e.getKey() + ":\t" + Base64.getDecoder().decode(e.getValue()).length + " bytes\n");
    }

    private void pvc(W w, PersistentVolumeClaim c) {
        var m = c.getMetadata();
        var spec = c.getSpec();
        w.w(0, "Name:\t" + m.getName() + "\n");
        w.w(0, "Namespace:\t" + m.getNamespace() + "\n");
        w.w(0, "StorageClass:\t" + storageClassOf(c) + "\n");
        if (m.getDeletionTimestamp() != null) w.w(0, "Status:\tTerminating (lasts " + since(m.getDeletionTimestamp()) + ")\n");
        else w.w(0, "Status:\t" + (c.getStatus() == null ? "" : s(c.getStatus().getPhase())) + "\n");
        w.w(0, "Volume:\t" + s(spec.getVolumeName()) + "\n");
        labels(w, "Labels", m.getLabels());
        annotations(w, "Annotations", m.getAnnotations());
        w.w(0, "Finalizers:\t[" + String.join(" ", nzl(m.getFinalizers())) + "]\n");
        Quantity cap = c.getStatus() == null ? null : nzm(c.getStatus().getCapacity()).get("storage");
        w.w(0, "Capacity:\t" + (cap == null ? "" : q(cap)) + "\n");
        w.w(0, "Access Modes:\t" + accessModes(c.getStatus() == null ? null : c.getStatus().getAccessModes()) + "\n");
        w.w(0, "VolumeMode:\t" + (spec.getVolumeMode() == null ? "Filesystem" : spec.getVolumeMode()) + "\n");
        List<String> users = ClusterCache.list(cache.pods, m.getNamespace()).stream()
                .filter(p -> nzl(p.getSpec().getVolumes()).stream().anyMatch(v -> v.getPersistentVolumeClaim() != null
                        && m.getName().equals(v.getPersistentVolumeClaim().getClaimName())))
                .map(p -> p.getMetadata().getName()).sorted().toList();
        w.w(0, "Used By:\t");
        if (users.isEmpty()) w.line("<none>");
        else for (int i = 0; i < users.size(); i++) w.w(0, (i == 0 ? "" : "\t") + users.get(i) + "\n");
        events(w, c);
    }

    private void pv(W w, PersistentVolume v) {
        var m = v.getMetadata();
        var spec = v.getSpec();
        w.w(0, "Name:\t" + m.getName() + "\n");
        labels(w, "Labels", m.getLabels());
        annotations(w, "Annotations", m.getAnnotations());
        w.w(0, "Finalizers:\t[" + String.join(" ", nzl(m.getFinalizers())) + "]\n");
        w.w(0, "StorageClass:\t" + s(spec.getStorageClassName()) + "\n");
        if (m.getDeletionTimestamp() != null) w.w(0, "Status:\tTerminating (lasts " + since(m.getDeletionTimestamp()) + ")\n");
        else w.w(0, "Status:\t" + (v.getStatus() == null ? "" : s(v.getStatus().getPhase())) + "\n");
        w.w(0, "Claim:\t" + (spec.getClaimRef() == null ? "" : spec.getClaimRef().getNamespace() + "/" + spec.getClaimRef().getName()) + "\n");
        w.w(0, "Reclaim Policy:\t" + s(spec.getPersistentVolumeReclaimPolicy()) + "\n");
        w.w(0, "Access Modes:\t" + accessModes(spec.getAccessModes()) + "\n");
        w.w(0, "VolumeMode:\t" + (spec.getVolumeMode() == null ? "Filesystem" : spec.getVolumeMode()) + "\n");
        Quantity cap = nzm(spec.getCapacity()).get("storage");
        w.w(0, "Capacity:\t" + (cap == null ? "" : q(cap)) + "\n");
        var na = spec.getNodeAffinity();
        if (na == null || na.getRequired() == null) w.w(0, "Node Affinity:\t<none>\n");
        else {
            w.w(0, "Node Affinity:\n");
            w.w(1, "Required Terms:\t");
            var terms = nzl(na.getRequired().getNodeSelectorTerms());
            if (terms.isEmpty()) w.line("<none>");
            else {
                w.line("");
                for (int i = 0; i < terms.size(); i++) {
                    var reqs = nzl(terms.get(i).getMatchExpressions());
                    w.w(0, "    Term " + i + ":\t");
                    if (reqs.isEmpty()) { w.line("<none>"); continue; }
                    for (int k = 0; k < reqs.size(); k++) {
                        if (k != 0) w.w(0, "    \t");
                        var e = reqs.get(k);
                        w.w(0, e.getKey() + " " + e.getOperator().toLowerCase(Locale.ROOT) + " [" + String.join(", ", nzl(e.getValues())) + "]\n");
                    }
                }
            }
        }
        w.w(0, "Message:\t" + (v.getStatus() == null ? "" : s(v.getStatus().getMessage())) + "\n");
        w.w(0, "Source:\n");
        if (spec.getHostPath() != null) {
            w.w(2, "Type:\tHostPath (bare host directory volume)\n    Path:\t" + s(spec.getHostPath().getPath())
                    + "\n    HostPathType:\t" + (spec.getHostPath().getType() == null ? "<none>" : spec.getHostPath().getType()) + "\n");
        } else if (spec.getLocal() != null) {
            w.w(2, "Type:\tLocalVolume (a persistent volume backed by local storage on a node)\n    Path:\t" + s(spec.getLocal().getPath()) + "\n");
        } else if (spec.getCsi() != null) {
            var c = spec.getCsi();
            w.w(2, "Type:\tCSI (a Container Storage Interface (CSI) volume source)\n    Driver:\t" + s(c.getDriver()) + "\n    FSType:\t" + s(c.getFsType())
                    + "\n    VolumeHandle:\t" + s(c.getVolumeHandle()) + "\n    ReadOnly:\t" + Boolean.TRUE.equals(c.getReadOnly()) + "\n");
        } else if (spec.getNfs() != null) {
            w.w(2, "Type:\tNFS (an NFS mount that lasts the lifetime of a pod)\n    Server:\t" + s(spec.getNfs().getServer()) + "\n    Path:\t" + s(spec.getNfs().getPath())
                    + "\n    ReadOnly:\t" + Boolean.TRUE.equals(spec.getNfs().getReadOnly()) + "\n");
        }
        events(w, v);
    }

    private static String storageClassOf(PersistentVolumeClaim c) {
        String a = nzm(c.getMetadata().getAnnotations()).get("volume.beta.kubernetes.io/storage-class");
        if (a != null) return a;
        return s(c.getSpec().getStorageClassName());
    }

    // ================================================================== cluster

    private void node(W w, io.fabric8.kubernetes.api.model.Node n) {
        var m = n.getMetadata();
        var st = n.getStatus() == null ? new NodeStatus() : n.getStatus();
        w.w(0, "Name:\t" + m.getName() + "\n");
        TreeSet<String> roles = new TreeSet<>();
        nzm(m.getLabels()).forEach((k, v) -> {
            if (k.startsWith("node-role.kubernetes.io/") && k.length() > 24) roles.add(k.substring(24));
            else if (k.equals("kubernetes.io/role") && !v.isEmpty()) roles.add(v);
        });
        w.w(0, "Roles:\t" + (roles.isEmpty() ? "<none>" : String.join(",", roles)) + "\n");
        labels(w, "Labels", m.getLabels());
        annotations(w, "Annotations", m.getAnnotations());
        w.w(0, "CreationTimestamp:\t" + time(m.getCreationTimestamp()) + "\n");
        List<Taint> taints = new ArrayList<>(nzl(n.getSpec().getTaints()));
        taints.sort(Comparator.comparing(t -> s(t.getEffect()) + "," + s(t.getKey())));
        w.w(0, "Taints:\t");
        if (taints.isEmpty()) w.line("<none>");
        else for (int i = 0; i < taints.size(); i++) w.w(0, (i == 0 ? "" : "\t") + taint(taints.get(i)) + "\n");
        w.w(0, "Unschedulable:\t" + Boolean.TRUE.equals(n.getSpec().getUnschedulable()) + "\n");
        Lease lease = cache.nodeLeases == null ? null : ClusterCache.get(cache.nodeLeases, "kube-node-lease", m.getName());
        if (lease == null) w.w(0, "Lease:\tFailed to get lease: leases.coordination.k8s.io \"" + m.getName() + "\" not found\n");
        else {
            var ls = lease.getSpec();
            w.w(0, "Lease:\n");
            w.w(1, "HolderIdentity:\t" + (ls == null || ls.getHolderIdentity() == null ? "<unset>" : ls.getHolderIdentity()) + "\n");
            w.w(1, "AcquireTime:\t" + (ls == null || ls.getAcquireTime() == null ? "<unset>" : time(ls.getAcquireTime())) + "\n");
            w.w(1, "RenewTime:\t" + (ls == null || ls.getRenewTime() == null ? "<unset>" : time(ls.getRenewTime())) + "\n");
        }
        if (!nzl(st.getConditions()).isEmpty()) {
            w.w(0, "Conditions:\n  Type\tStatus\tLastHeartbeatTime\tLastTransitionTime\tReason\tMessage\n");
            w.w(1, "----\t------\t-----------------\t------------------\t------\t-------\n");
            for (NodeCondition c : st.getConditions())
                w.w(1, c.getType() + " \t" + c.getStatus() + " \t" + timeOrZero(c.getLastHeartbeatTime()) + " \t" + timeOrZero(c.getLastTransitionTime())
                        + " \t" + s(c.getReason()) + " \t" + s(c.getMessage()) + "\n");
        }
        w.w(0, "Addresses:\n");
        for (NodeAddress a : nzl(st.getAddresses())) w.w(1, a.getType() + ":\t" + a.getAddress() + "\n");
        if (!nzm(st.getCapacity()).isEmpty()) {
            w.w(0, "Capacity:\n");
            for (var e : new TreeMap<>(st.getCapacity()).entrySet()) w.w(0, "  " + e.getKey() + ":\t" + q(e.getValue()) + "\n");
        }
        if (!nzm(st.getAllocatable()).isEmpty()) {
            w.w(0, "Allocatable:\n");
            for (var e : new TreeMap<>(st.getAllocatable()).entrySet()) w.w(0, "  " + e.getKey() + ":\t" + q(e.getValue()) + "\n");
        }
        var ni = st.getNodeInfo() == null ? new NodeSystemInfo() : st.getNodeInfo();
        w.w(0, "System Info:\n");
        w.w(0, "  Machine ID:\t" + s(ni.getMachineID()) + "\n");
        w.w(0, "  System UUID:\t" + s(ni.getSystemUUID()) + "\n");
        w.w(0, "  Boot ID:\t" + s(ni.getBootID()) + "\n");
        w.w(0, "  Kernel Version:\t" + s(ni.getKernelVersion()) + "\n");
        w.w(0, "  OS Image:\t" + s(ni.getOsImage()) + "\n");
        w.w(0, "  Operating System:\t" + s(ni.getOperatingSystem()) + "\n");
        w.w(0, "  Architecture:\t" + s(ni.getArchitecture()) + "\n");
        w.w(0, "  Container Runtime Version:\t" + s(ni.getContainerRuntimeVersion()) + "\n");
        w.w(0, "  Kubelet Version:\t" + s(ni.getKubeletVersion()) + "\n");
        if (nonEmpty(n.getSpec().getPodCIDR())) w.w(0, "PodCIDR:\t" + n.getSpec().getPodCIDR() + "\n");
        if (!nzl(n.getSpec().getPodCIDRs()).isEmpty()) w.w(0, "PodCIDRs:\t" + String.join(",", n.getSpec().getPodCIDRs()) + "\n");
        if (nonEmpty(n.getSpec().getProviderID())) w.w(0, "ProviderID:\t" + n.getSpec().getProviderID() + "\n");
        nodeResources(w, n);
        events(w, n);
    }

    /** kubectl's describeNodeResource: non-terminated pods on the node with requests/limits as a share of allocatable */
    private void nodeResources(W w, io.fabric8.kubernetes.api.model.Node n) {
        List<Pod> pods = cache.pods.getStore().list().stream()
                .filter(p -> n.getMetadata().getName().equals(p.getSpec().getNodeName()))
                .filter(p -> p.getStatus() == null || !("Succeeded".equals(p.getStatus().getPhase()) || "Failed".equals(p.getStatus().getPhase())))
                .sorted(Comparator.comparing((Pod p) -> p.getMetadata().getNamespace()).thenComparing(p -> p.getMetadata().getName())).toList();
        Map<String, Quantity> alloc = nzm(n.getStatus().getAllocatable()).isEmpty() ? nzm(n.getStatus().getCapacity()) : n.getStatus().getAllocatable();
        long allocCpu = milli(qq(alloc.get("cpu")).v), allocMem = value(qq(alloc.get("memory")).v), allocEph = value(qq(alloc.get("ephemeral-storage")).v);
        w.w(0, "Non-terminated Pods:\t(" + pods.size() + " in total)\n");
        w.w(1, "Namespace\tName\t\tCPU Requests\tCPU Limits\tMemory Requests\tMemory Limits\tAge\n");
        w.w(1, "---------\t----\t\t------------\t----------\t---------------\t-------------\t---\n");
        Map<String, Q> reqs = new HashMap<>(), limits = new HashMap<>();
        for (Pod p : pods) {
            Map<String, Q> r = podRequests(p), l = podLimits(p);
            Q cr = r.getOrDefault("cpu", Q.ZERO), cl = l.getOrDefault("cpu", Q.ZERO), mr = r.getOrDefault("memory", Q.ZERO), ml = l.getOrDefault("memory", Q.ZERO);
            w.w(1, p.getMetadata().getNamespace() + "\t" + p.getMetadata().getName() + "\t\t"
                    + cr + " (" + pct(milli(cr.v), allocCpu) + "%)\t" + cl + " (" + pct(milli(cl.v), allocCpu) + "%)\t"
                    + mr + " (" + pct(value(mr.v), allocMem) + "%)\t" + ml + " (" + pct(value(ml.v), allocMem) + "%)\t"
                    + since(p.getMetadata().getCreationTimestamp()) + "\n");
            r.forEach((k, v) -> reqs.merge(k, v, Q::plus));
            l.forEach((k, v) -> limits.merge(k, v, Q::plus));
        }
        w.w(0, "Allocated resources:\n  (Total limits may be over 100 percent, i.e., overcommitted.)\n");
        w.w(1, "Resource\tRequests\tLimits\n");
        w.w(1, "--------\t--------\t------\n");
        Q cr = reqs.getOrDefault("cpu", Q.ZERO), cl = limits.getOrDefault("cpu", Q.ZERO), mr = reqs.getOrDefault("memory", Q.ZERO), ml = limits.getOrDefault("memory", Q.ZERO);
        Q er = reqs.getOrDefault("ephemeral-storage", Q.ZERO), el = limits.getOrDefault("ephemeral-storage", Q.ZERO);
        w.w(1, "cpu\t" + cr + " (" + pct0(milli(cr.v), allocCpu) + "%)\t" + cl + " (" + pct0(milli(cl.v), allocCpu) + "%)\n");
        w.w(1, "memory\t" + mr + " (" + pct0(value(mr.v), allocMem) + "%)\t" + ml + " (" + pct0(value(ml.v), allocMem) + "%)\n");
        w.w(1, "ephemeral-storage\t" + er + " (" + pct0(value(er.v), allocEph) + "%)\t" + el + " (" + pct0(value(el.v), allocEph) + "%)\n");
        List<String> huge = new ArrayList<>(), ext = new ArrayList<>();
        for (String r : alloc.keySet()) {
            if (r.startsWith("hugepages-")) huge.add(r);
            else if (!STANDARD_CONTAINER_RESOURCES.contains(r) && !r.equals("pods") && !r.startsWith("requests.") && !r.startsWith("limits.")) ext.add(r);
        }
        Collections.sort(huge);
        Collections.sort(ext);
        for (String r : huge) {
            Q hr = reqs.getOrDefault(r, Q.ZERO), hl = limits.getOrDefault(r, Q.ZERO);
            long a = value(qq(alloc.get(r)).v);
            w.w(1, r + "\t" + hr + " (" + pct0(value(hr.v), a) + "%)\t" + hl + " (" + pct0(value(hl.v), a) + "%)\n");
        }
        for (String r : ext) w.w(1, r + "\t" + reqs.getOrDefault(r, Q.ZERO) + "\t" + limits.getOrDefault(r, Q.ZERO) + "\n");
    }

    private static final Set<String> STANDARD_CONTAINER_RESOURCES = Set.of("cpu", "memory", "ephemeral-storage");

    /** k8s.io/component-helpers resource.PodRequests: containers summed, sidecars added, init containers as max, plus overhead */
    private static Map<String, Q> podRequests(Pod p) {
        Map<String, Q> reqs = new HashMap<>();
        for (Container c : nzl(p.getSpec().getContainers())) addList(reqs, c.getResources() == null ? null : c.getResources().getRequests());
        Map<String, Q> restartable = new HashMap<>(), init = new HashMap<>();
        for (Container c : nzl(p.getSpec().getInitContainers())) {
            Map<String, Quantity> r = c.getResources() == null ? null : c.getResources().getRequests();
            Map<String, Q> cur;
            if ("Always".equals(c.getRestartPolicy())) {
                addList(reqs, r);
                addList(restartable, r);
                cur = restartable;
            } else {
                cur = new HashMap<>();
                addList(cur, r);
                cur.putAll(merge(cur, restartable));
            }
            maxList(init, cur);
        }
        maxList(reqs, init);
        if (p.getSpec().getOverhead() != null) addList(reqs, p.getSpec().getOverhead());
        podLevel(reqs, p.getSpec().getResources() == null ? null : p.getSpec().getResources().getRequests());
        return reqs;
    }

    private static Map<String, Q> podLimits(Pod p) {
        Map<String, Q> limits = new HashMap<>();
        for (Container c : nzl(p.getSpec().getContainers())) addList(limits, c.getResources() == null ? null : c.getResources().getLimits());
        Map<String, Q> restartable = new HashMap<>(), init = new HashMap<>();
        for (Container c : nzl(p.getSpec().getInitContainers())) {
            Map<String, Quantity> l = c.getResources() == null ? null : c.getResources().getLimits();
            Map<String, Q> cur;
            if ("Always".equals(c.getRestartPolicy())) {
                addList(limits, l);
                addList(restartable, l);
                cur = restartable;
            } else {
                cur = new HashMap<>();
                addList(cur, l);
                cur.putAll(merge(cur, restartable));
            }
            maxList(init, cur);
        }
        maxList(limits, init);
        if (p.getSpec().getOverhead() != null)
            p.getSpec().getOverhead().forEach((k, v) -> { if (limits.containsKey(k)) limits.put(k, limits.get(k).plus(qq(v))); });
        podLevel(limits, p.getSpec().getResources() == null ? null : p.getSpec().getResources().getLimits());
        return limits;
    }

    /** pod-level resources (spec.resources) win for cpu / memory / hugepages */
    private static void podLevel(Map<String, Q> list, Map<String, Quantity> pod) {
        for (var e : nzm(pod).entrySet())
            if (e.getKey().equals("cpu") || e.getKey().equals("memory") || e.getKey().startsWith("hugepages-")) list.put(e.getKey(), qq(e.getValue()));
    }

    private static void addList(Map<String, Q> list, Map<String, Quantity> add) {
        for (var e : nzm(add).entrySet()) list.merge(e.getKey(), qq(e.getValue()), Q::plus);
    }

    private static Map<String, Q> merge(Map<String, Q> a, Map<String, Q> b) {
        Map<String, Q> out = new HashMap<>(a);
        b.forEach((k, v) -> out.merge(k, v, Q::plus));
        return out;
    }

    private static void maxList(Map<String, Q> list, Map<String, Q> other) {
        other.forEach((k, v) -> { Q cur = list.get(k); if (cur == null || v.v.compareTo(cur.v) > 0) list.put(k, v); });
    }

    private static long pct(long v, long of) { return (long) ((double) v / (double) of * 100); }
    private static long pct0(long v, long of) { return of == 0 ? 0 : pct(v, of); }

    private void hpa(W w, HorizontalPodAutoscaler h) {
        var m = h.getMetadata();
        var spec = h.getSpec();
        var st = h.getStatus();
        List<MetricStatus> current = st == null ? List.of() : nzl(st.getCurrentMetrics());
        w.w(0, "Name:\t" + m.getName() + "\n");
        w.w(0, "Namespace:\t" + m.getNamespace() + "\n");
        labels(w, "Labels", m.getLabels());
        annotations(w, "Annotations", m.getAnnotations());
        w.w(0, "CreationTimestamp:\t" + time(m.getCreationTimestamp()) + "\n");
        w.w(0, "Reference:\t" + spec.getScaleTargetRef().getKind() + "/" + spec.getScaleTargetRef().getName() + "\n");
        w.w(0, "Metrics:\t( current / target )\n");
        List<MetricSpec> metrics = nzl(spec.getMetrics());
        for (int i = 0; i < metrics.size(); i++) {
            MetricSpec ms = metrics.get(i);
            MetricStatus cs = current.size() > i ? current.get(i) : null;
            switch (s(ms.getType())) {
                case "External" -> {
                    var t = ms.getExternal().getTarget();
                    String name = goQuote(ms.getExternal().getMetric().getName());
                    if (t.getAverageValue() != null) {
                        String cur = cs != null && cs.getExternal() != null && cs.getExternal().getCurrent().getAverageValue() != null ? q(cs.getExternal().getCurrent().getAverageValue()) : "<unknown>";
                        w.w(1, name + " (target average value):\t" + cur + " / " + q(t.getAverageValue()) + "\n");
                    } else {
                        String cur = cs != null && cs.getExternal() != null ? q(cs.getExternal().getCurrent().getValue()) : "<unknown>";
                        w.w(1, name + " (target value):\t" + cur + " / " + q(t.getValue()) + "\n");
                    }
                }
                case "Pods" -> {
                    String cur = cs != null && cs.getPods() != null ? q(cs.getPods().getCurrent().getAverageValue()) : "<unknown>";
                    w.w(1, goQuote(ms.getPods().getMetric().getName()) + " on pods:\t" + cur + " / " + q(ms.getPods().getTarget().getAverageValue()) + "\n");
                }
                case "Object" -> {
                    var o = ms.getObject();
                    w.w(1, "\"" + o.getMetric().getName() + "\" on " + o.getDescribedObject().getKind() + "/" + o.getDescribedObject().getName() + " ");
                    if ("AverageValue".equals(o.getTarget().getType())) {
                        String cur = cs != null && cs.getObject() != null ? q(cs.getObject().getCurrent().getAverageValue()) : "<unknown>";
                        w.w(0, "(target average value):\t" + cur + " / " + q(o.getTarget().getAverageValue()) + "\n");
                    } else {
                        String cur = cs != null && cs.getObject() != null ? q(cs.getObject().getCurrent().getValue()) : "<unknown>";
                        w.w(0, "(target value):\t" + cur + " / " + q(o.getTarget().getValue()) + "\n");
                    }
                }
                case "Resource" -> {
                    var r = ms.getResource();
                    w.w(1, "resource " + r.getName() + " on pods");
                    if (r.getTarget().getAverageValue() != null) {
                        String cur = cs != null && cs.getResource() != null ? q(cs.getResource().getCurrent().getAverageValue()) : "<unknown>";
                        w.w(0, ":\t" + cur + " / " + q(r.getTarget().getAverageValue()) + "\n");
                    } else {
                        String cur = cs != null && cs.getResource() != null && cs.getResource().getCurrent().getAverageUtilization() != null
                                ? cs.getResource().getCurrent().getAverageUtilization() + "% (" + q(cs.getResource().getCurrent().getAverageValue()) + ")" : "<unknown>";
                        String target = r.getTarget().getAverageUtilization() == null ? "<auto>" : r.getTarget().getAverageUtilization() + "%";
                        w.w(1, "(as a percentage of request):\t" + cur + " / " + target + "\n");
                    }
                }
                case "ContainerResource" -> {
                    var r = ms.getContainerResource();
                    w.w(1, "resource " + r.getName() + " of container \"" + r.getContainer() + "\" on pods");
                    if (r.getTarget().getAverageValue() != null) {
                        String cur = cs != null && cs.getContainerResource() != null ? q(cs.getContainerResource().getCurrent().getAverageValue()) : "<unknown>";
                        w.w(0, ":\t" + cur + " / " + q(r.getTarget().getAverageValue()) + "\n");
                    } else {
                        String cur = cs != null && cs.getContainerResource() != null && cs.getContainerResource().getCurrent().getAverageUtilization() != null
                                ? cs.getContainerResource().getCurrent().getAverageUtilization() + "% (" + q(cs.getContainerResource().getCurrent().getAverageValue()) + ")" : "<unknown>";
                        String target = r.getTarget().getAverageUtilization() == null ? "<auto>" : r.getTarget().getAverageUtilization() + "%";
                        w.w(1, "(as a percentage of request):\t" + cur + " / " + target + "\n");
                    }
                }
                default -> w.w(1, "<unknown metric type " + goQuote(s(ms.getType())) + ">\n");
            }
        }
        w.w(0, "Min replicas:\t" + (spec.getMinReplicas() == null ? "<unset>" : spec.getMinReplicas()) + "\n");
        w.w(0, "Max replicas:\t" + spec.getMaxReplicas() + "\n");
        if (spec.getBehavior() != null) {
            w.w(0, "Behavior:\n");
            scalingRules(w, "Scale Up", spec.getBehavior().getScaleUp());
            scalingRules(w, "Scale Down", spec.getBehavior().getScaleDown());
        }
        w.w(0, spec.getScaleTargetRef().getKind() + " pods:\t");
        w.w(0, (st == null ? 0 : nz(st.getCurrentReplicas())) + " current / " + (st == null ? 0 : nz(st.getDesiredReplicas())) + " desired\n");
        if (st != null && !nzl(st.getConditions()).isEmpty()) {
            w.w(0, "Conditions:\n");
            w.w(1, "Type\tStatus\tReason\tMessage\n");
            w.w(1, "----\t------\t------\t-------\n");
            for (var c : st.getConditions()) w.w(1, c.getType() + "\t" + c.getStatus() + "\t" + s(c.getReason()) + "\t" + s(c.getMessage()) + "\n");
        }
        events(w, h);
    }

    private static void scalingRules(W w, String direction, HPAScalingRules r) {
        if (r == null) return;
        w.w(1, direction + ":\n");
        if (r.getStabilizationWindowSeconds() != null) w.w(2, "Stabilization Window: " + r.getStabilizationWindowSeconds() + " seconds\n");
        if (!nzl(r.getPolicies()).isEmpty()) {
            w.w(2, "Select Policy: " + (r.getSelectPolicy() == null ? "Max" : r.getSelectPolicy()) + "\n");
            w.w(2, "Policies:\n");
            for (var p : r.getPolicies()) w.w(3, "- Type: " + p.getType() + "\tValue: " + nz(p.getValue()) + "\tPeriod: " + nz(p.getPeriodSeconds()) + " seconds\n");
        }
    }

    /** kubectl: rules broken down to one verb each, simple ones compacted back together, sorted by their String() */
    private void role(W w, ObjectMeta m, List<PolicyRule> rules) {
        List<PolicyRule> broken = new ArrayList<>();
        for (PolicyRule r : nzl(rules)) {
            for (String g : nzl(r.getApiGroups())) for (String res : nzl(r.getResources())) for (String v : nzl(r.getVerbs())) {
                if (!nzl(r.getResourceNames()).isEmpty())
                    for (String rn : r.getResourceNames()) broken.add(rule(List.of(g), List.of(res), List.of(v), List.of(rn), List.of()));
                else broken.add(rule(List.of(g), List.of(res), List.of(v), List.of(), List.of()));
            }
            for (String url : nzl(r.getNonResourceURLs())) for (String v : nzl(r.getVerbs())) broken.add(rule(List.of(), List.of(), List.of(v), List.of(), List.of(url)));
        }
        List<PolicyRule> compact = new ArrayList<>();
        Map<String, PolicyRule> simple = new LinkedHashMap<>();
        for (PolicyRule r : broken) {
            boolean isSimple = nzl(r.getResourceNames()).size() <= 1 && nzl(r.getNonResourceURLs()).isEmpty()
                    && nzl(r.getApiGroups()).size() == 1 && nzl(r.getResources()).size() == 1;
            if (!isSimple) { compact.add(r); continue; }
            String key = r.getApiGroups().get(0) + "\u0000" + r.getResources().get(0) + "\u0000" + (nzl(r.getResourceNames()).isEmpty() ? "\u0001" : r.getResourceNames().get(0));
            PolicyRule ex = simple.get(key);
            if (ex == null) simple.put(key, rule(r.getApiGroups(), r.getResources(), new ArrayList<>(nzl(r.getVerbs())), r.getResourceNames(), List.of()));
            else for (String v : nzl(r.getVerbs())) if (!ex.getVerbs().contains(v)) ex.getVerbs().add(v);
        }
        compact.addAll(simple.values());
        compact.sort(Comparator.comparing(DescribeService::ruleString));
        w.w(0, "Name:\t" + m.getName() + "\n");
        labels(w, "Labels", m.getLabels());
        annotations(w, "Annotations", m.getAnnotations());
        w.w(0, "PolicyRule:\n");
        w.w(1, "Resources\tNon-Resource URLs\tResource Names\tVerbs\n");
        w.w(1, "---------\t-----------------\t--------------\t-----\n");
        for (PolicyRule r : compact)
            w.w(1, combineResourceGroup(r.getResources(), r.getApiGroups()) + "\t" + goSlice(r.getNonResourceURLs()) + "\t" + goSlice(r.getResourceNames()) + "\t" + goSlice(r.getVerbs()) + "\n");
    }

    private static PolicyRule rule(List<String> groups, List<String> res, List<String> verbs, List<String> names, List<String> urls) {
        PolicyRule r = new PolicyRule();
        r.setApiGroups(groups); r.setResources(res); r.setVerbs(verbs); r.setResourceNames(names); r.setNonResourceURLs(urls);
        return r;
    }

    /** gogo-protobuf String() of rbacv1.PolicyRule, which is what kubectl sorts on */
    private static String ruleString(PolicyRule r) {
        return "&PolicyRule{Verbs:" + goSlice(r.getVerbs()) + ",APIGroups:" + goSlice(r.getApiGroups()) + ",Resources:" + goSlice(r.getResources())
                + ",ResourceNames:" + goSlice(r.getResourceNames()) + ",NonResourceURLs:" + goSlice(r.getNonResourceURLs()) + ",}";
    }

    private static String combineResourceGroup(List<String> res, List<String> groups) {
        if (nzl(res).isEmpty()) return "";
        String[] parts = res.get(0).split("/", 2);
        String combine = parts[0];
        if (!nzl(groups).isEmpty() && !groups.get(0).isEmpty()) combine += "." + groups.get(0);
        if (parts.length == 2) combine += "/" + parts[1];
        return combine;
    }

    private void binding(W w, ObjectMeta m, RoleRef ref, List<Subject> subjects) {
        w.w(0, "Name:\t" + m.getName() + "\n");
        labels(w, "Labels", m.getLabels());
        annotations(w, "Annotations", m.getAnnotations());
        w.w(0, "Role:\n");
        w.w(1, "Kind:\t" + ref.getKind() + "\n");
        w.w(1, "Name:\t" + ref.getName() + "\n");
        w.w(0, "Subjects:\n");
        w.w(1, "Kind\tName\tNamespace\n");
        w.w(1, "----\t----\t---------\n");
        for (Subject sub : nzl(subjects)) w.w(1, sub.getKind() + "\t" + sub.getName() + "\t" + s(sub.getNamespace()) + "\n");
    }

    private void serviceAccount(W w, ServiceAccount sa) {
        var m = sa.getMetadata();
        w.w(0, "Name:\t" + m.getName() + "\n");
        w.w(0, "Namespace:\t" + m.getNamespace() + "\n");
        labels(w, "Labels", m.getLabels());
        annotations(w, "Annotations", m.getAnnotations());
        List<String> pulls = nzl(sa.getImagePullSecrets()).stream().map(LocalObjectReference::getName).toList();
        if (pulls.isEmpty()) w.w(0, "Image pull secrets:\t<none>\n");
        else for (int i = 0; i < pulls.size(); i++) w.w(0, (i == 0 ? "Image pull secrets:" : "                   ") + "\t" + pulls.get(i) + "\n");
        events(w, sa);
    }

    // ================================================================== generic (custom resources…)

    /** kubectl's printer for objects without a dedicated describer */
    private void generic(W w, HasMetadata o) {
        var m = o.getMetadata();
        w.w(0, "Name:\t" + m.getName() + "\n");
        if (m.getNamespace() != null) w.w(0, "Namespace:\t" + m.getNamespace() + "\n");
        labels(w, "Labels", m.getLabels());
        annotations(w, "Annotations", m.getAnnotations());
        w.w(0, "API Version:\t" + o.getApiVersion() + "\n");
        w.w(0, "Kind:\t" + o.getKind() + "\n");
        Map<String, Object> meta = new LinkedHashMap<>();
        if (m.getCreationTimestamp() != null) meta.put("creationTimestamp", m.getCreationTimestamp());
        if (!nzl(m.getFinalizers()).isEmpty()) meta.put("finalizers", m.getFinalizers());
        if (m.getGeneration() != null) meta.put("generation", m.getGeneration());
        if (!nzl(m.getOwnerReferences()).isEmpty()) meta.put("ownerReferences", cache.client().getKubernetesSerialization().convertValue(m.getOwnerReferences(), List.class));
        meta.put("resourceVersion", m.getResourceVersion());
        meta.put("uid", m.getUid());
        w.w(0, "Metadata:\n");
        unstructured(w, 1, meta);
        @SuppressWarnings("unchecked")
        Map<String, Object> all = cache.client().getKubernetesSerialization().convertValue(o, Map.class);
        Map<String, Object> rest = new LinkedHashMap<>(all);
        rest.keySet().removeAll(List.of("apiVersion", "kind", "metadata"));
        for (var e : new TreeMap<>(rest).entrySet()) field(w, 0, e.getKey(), e.getValue());
        events(w, o);
    }

    @SuppressWarnings("unchecked")
    private void unstructured(W w, int level, Map<String, Object> map) {
        for (var e : new TreeMap<>(map).entrySet()) field(w, level, e.getKey(), e.getValue());
    }

    @SuppressWarnings("unchecked")
    private void field(W w, int level, String key, Object v) {
        String k = words(key);
        if (v instanceof Map<?, ?> mm) {
            w.w(level, k + ":\n");
            unstructured(w, level + 1, (Map<String, Object>) mm);
        } else if (v instanceof List<?> l) {
            w.w(level, k + ":\n");
            for (Object item : l) {
                if (item instanceof Map<?, ?> im) unstructured(w, level + 1, (Map<String, Object>) im);
                else w.w(level + 1, item + "\n");
            }
        } else w.w(level, k + ":\t" + v + "\n");
    }

    /** camelCase → "Camel Case", like kubectl does for unstructured field names */
    private static final Set<String> ACRONYMS = Set.of("API", "UID", "URL", "IP", "ID", "CPU", "DNS", "HTTP", "HTTPS", "JSON", "TLS", "TTL", "URI", "UUID", "TCP", "UDP", "CIDR");
    private static String words(String key) {
        if (!key.matches("[A-Za-z0-9]+")) return key; // e.g. "global.systemDefaultRegistry" is printed as-is
        StringBuilder b = new StringBuilder();
        for (int i = 0; i < key.length(); i++) {
            char c = key.charAt(i);
            if (i == 0) b.append(Character.toUpperCase(c));
            else if (Character.isUpperCase(c) && !Character.isUpperCase(key.charAt(i - 1))) b.append(' ').append(c);
            else b.append(c);
        }
        return String.join(" ", Arrays.stream(b.toString().split(" ")).map(t -> ACRONYMS.contains(t.toUpperCase()) ? t.toUpperCase() : t).toList());
    }

    // ================================================================== shared pieces

    private void controlledBy(W w, ObjectMeta m) {
        nzl(m.getOwnerReferences()).stream().filter(r -> Boolean.TRUE.equals(r.getController())).findFirst()
                .ifPresent(r -> w.w(0, "Controlled By:\t" + r.getKind() + "/" + r.getName() + "\n"));
    }

    /** kubectl's printLabelsMultilineWithIndent; every line at LEVEL_0, continuation lines start with initialIndent + innerIndent */
    private static void labels(W w, String initialIndent, String title, String innerIndent, Map<String, String> labels) {
        w.w(0, initialIndent + title + ":" + innerIndent);
        if (labels == null || labels.isEmpty()) { w.line("<none>"); return; }
        boolean first = true;
        for (var e : new TreeMap<>(labels).entrySet()) {
            if (!first) w.w(0, initialIndent + innerIndent);
            w.w(0, e.getKey() + "=" + e.getValue() + "\n");
            first = false;
        }
    }

    private static void labels(W w, String title, Map<String, String> labels) { labels(w, "", title, "\t", labels); }

    /** kubectl's printAnnotationsMultiline: long (> 140 bytes) or multi-line values go on their own lines, each cut at 138 bytes */
    private static void annotations(W w, String title, Map<String, String> ann) {
        w.w(0, title + ":\t");
        Map<String, String> a = new TreeMap<>(nzm(ann));
        a.remove(SKIP_ANNOTATION);
        if (a.isEmpty()) { w.line("<none>"); return; }
        boolean first = true;
        for (var e : a.entrySet()) {
            if (!first) w.w(0, "\t");
            first = false;
            String value = s(e.getValue());
            if (value.endsWith("\n")) value = value.substring(0, value.length() - 1);
            if (bytes(value) + bytes(e.getKey()) + 2 > MAX_ANNOTATION || value.contains("\n")) {
                w.w(0, e.getKey() + ":\n");
                for (String line : value.split("\n", -1)) w.w(0, "\t  " + shorten(line, MAX_ANNOTATION - 2) + "\n");
            } else w.w(0, e.getKey() + ": " + value + "\n");
        }
    }

    private static int bytes(String s) { return s.getBytes(StandardCharsets.UTF_8).length; }

    private static String shorten(String s, int max) {
        byte[] b = s.getBytes(StandardCharsets.UTF_8);
        return b.length > max ? new String(b, 0, max, StandardCharsets.UTF_8) + "..." : s;
    }

    private static void tolerations(W w, String title, List<Toleration> ts) {
        w.w(0, title + ":\t");
        if (nzl(ts).isEmpty()) { w.line("<none>"); return; }
        List<Toleration> l = new ArrayList<>(ts);
        l.sort(Comparator.comparing(t -> s(t.getKey())));
        for (int i = 0; i < l.size(); i++) {
            Toleration t = l.get(i);
            if (i != 0) w.w(0, "\t");
            StringBuilder b = new StringBuilder(s(t.getKey()));
            if (nonEmpty(t.getValue())) b.append('=').append(t.getValue());
            if (nonEmpty(t.getEffect())) b.append(':').append(t.getEffect());
            if ("Exists".equals(t.getOperator()) && !nonEmpty(t.getValue()))
                b.append(nonEmpty(t.getKey()) || nonEmpty(t.getEffect()) ? " op=Exists" : "op=Exists");
            if (t.getTolerationSeconds() != null) b.append(" for ").append(t.getTolerationSeconds()).append('s');
            w.w(0, b + "\n");
        }
    }

    /** kubectl's DescribeEvents: Flush (own column block), oldest first, age of the first occurrence, fieldPath before the message */
    private void events(W w, HasMetadata o) {
        Set<String> uids = new HashSet<>();
        if (o.getMetadata().getUid() != null) uids.add(o.getMetadata().getUid());
        if (o instanceof io.fabric8.kubernetes.api.model.Node) uids.add(o.getMetadata().getName()); // kubelet reports node events with uid = node name
        String ns = s(o.getMetadata().getNamespace()), name = o.getMetadata().getName(), kind = o.getKind();
        List<Event> evs = new ArrayList<>(cache.events.getStore().list().stream()
                .filter(e -> e.getInvolvedObject() != null && kind.equals(e.getInvolvedObject().getKind()) && name.equals(e.getInvolvedObject().getName())
                        && ns.equals(s(e.getInvolvedObject().getNamespace())) && uids.contains(s(e.getInvolvedObject().getUid())))
                .toList());
        if (evs.isEmpty()) { w.w(0, "Events:\t<none>\n"); return; }
        w.flush();
        // sort.Sort(SortableEvents) on lastTimestamp; for short lists Go's sort is an insertion sort, i.e. stable over the API's (name) order
        evs.sort(Comparator.comparing((Event e) -> e.getMetadata().getName()));
        evs.sort(Comparator.comparing((Event e) -> e.getLastTimestamp() == null ? Instant.EPOCH : Instant.parse(e.getLastTimestamp())));
        w.w(0, "Events:\n  Type\tReason\tAge\tFrom\tMessage\n");
        w.w(1, "----\t------\t----\t----\t-------\n");
        for (Event e : evs) {
            String eventTime = e.getEventTime() == null ? null : e.getEventTime().getTime();
            String first = nonEmpty(eventTime) ? since(eventTime) : since(e.getFirstTimestamp());
            String interval;
            if (e.getSeries() != null)
                interval = since(e.getSeries().getLastObservedTime() == null ? null : e.getSeries().getLastObservedTime().getTime()) + " (x" + nz(e.getSeries().getCount()) + " over " + first + ")";
            else if (nz(e.getCount()) > 1) interval = since(e.getLastTimestamp()) + " (x" + e.getCount() + " over " + first + ")";
            else interval = first;
            String source = e.getSource() != null && nonEmpty(e.getSource().getComponent()) ? e.getSource().getComponent() : s(e.getReportingComponent());
            String msg = s(e.getMessage()).strip();
            if (nonEmpty(e.getInvolvedObject().getFieldPath())) msg = e.getInvolvedObject().getFieldPath() + ": " + msg;
            w.w(1, s(e.getType()) + "\t" + s(e.getReason()) + "\t" + interval + "\t" + source + "\t" + msg + "\n");
        }
    }

    /** kubectl counts pods by phase among those whose controller is the owner */
    private String podsStatus(HasMetadata owner) {
        int running = 0, waiting = 0, succeeded = 0, failed = 0;
        for (Pod p : ClusterCache.list(cache.pods, owner.getMetadata().getNamespace())) {
            if (!controlledBy(p, owner)) continue;
            switch (p.getStatus() == null ? "" : s(p.getStatus().getPhase())) {
                case "Running" -> running++;
                case "Pending" -> waiting++;
                case "Succeeded" -> succeeded++;
                case "Failed" -> failed++;
                default -> { }
            }
        }
        return running + " Running / " + waiting + " Waiting / " + succeeded + " Succeeded / " + failed + " Failed";
    }

    private static boolean controlledBy(HasMetadata child, HasMetadata owner) {
        return nzl(child.getMetadata().getOwnerReferences()).stream()
                .anyMatch(r -> Boolean.TRUE.equals(r.getController()) && owner.getMetadata().getUid().equals(r.getUid()));
    }

    private static String taint(Taint t) {
        return s(t.getKey()) + (nonEmpty(t.getValue()) ? "=" + t.getValue() : "") + ":" + s(t.getEffect());
    }

    /** labels.Selector.String() of metav1.LabelSelectorAsSelector: requirements sorted by key, set values sorted */
    private static String selector(LabelSelector sel) {
        if (sel == null) return "";
        List<String[]> reqs = new ArrayList<>();
        nzm(sel.getMatchLabels()).forEach((k, v) -> reqs.add(new String[]{k, k + "=" + v}));
        for (var e : nzl(sel.getMatchExpressions())) {
            String vals = String.join(",", new TreeSet<>(nzl(e.getValues())));
            switch (s(e.getOperator())) {
                case "In" -> reqs.add(new String[]{e.getKey(), e.getKey() + " in (" + vals + ")"});
                case "NotIn" -> reqs.add(new String[]{e.getKey(), e.getKey() + " notin (" + vals + ")"});
                case "Exists" -> reqs.add(new String[]{e.getKey(), e.getKey()});
                case "DoesNotExist" -> reqs.add(new String[]{e.getKey(), "!" + e.getKey()});
                default -> { }
            }
        }
        reqs.sort(Comparator.comparing(r -> r[0]));
        return String.join(",", reqs.stream().map(r -> r[1]).toList());
    }

    /** labels.FormatLabels */
    private static String formatLabels(Map<String, String> m) {
        if (m == null || m.isEmpty()) return "<none>";
        return String.join(",", new TreeMap<>(m).entrySet().stream().map(e -> e.getKey() + "=" + e.getValue()).toList());
    }

    private static String accessModes(List<String> modes) {
        return String.join(",", nzl(modes).stream().map(m -> switch (m) {
            case "ReadWriteOnce" -> "RWO";
            case "ReadOnlyMany" -> "ROX";
            case "ReadWriteMany" -> "RWX";
            case "ReadWriteOncePod" -> "RWOP";
            default -> m;
        }).toList());
    }

    /** Go %v of a []string */
    private static String goSlice(List<String> l) { return "[" + String.join(" ", nzl(l)) + "]"; }

    /** Go %q */
    private static String goQuote(String s) {
        StringBuilder b = new StringBuilder("\"");
        for (char c : s(s).toCharArray()) {
            switch (c) {
                case '"' -> b.append("\\\"");
                case '\\' -> b.append("\\\\");
                case '\n' -> b.append("\\n");
                case '\t' -> b.append("\\t");
                default -> b.append(c);
            }
        }
        return b.append('"').toString();
    }

    private static String ios(IntOrString v) { return v == null ? "" : v.getIntVal() != null ? String.valueOf(v.getIntVal()) : s(v.getStrVal()); }
    private static String iosOr0(IntOrString v) { return v == null ? "0" : ios(v); }
    private static String ann(HasMetadata o, String k) { return nzm(o.getMetadata().getAnnotations()).get(k); }
    private static String bool(boolean b) { return b ? "True" : "False"; }
    private static String orNone(String s) { return s == null || s.isEmpty() ? "<none>" : s; }

    private static String time(String iso) {
        if (iso == null) return "<unset>";
        try { return RFC1123Z.format(Instant.parse(iso)); } catch (RuntimeException e) { return iso; }
    }

    private static String time(ZonedDateTime t) { return t == null ? "<unset>" : RFC1123Z.format(t.toInstant()); }

    /** Go formats a zero metav1.Time as 0001-01-01 */
    private static String timeOrZero(String iso) { return iso == null ? RFC1123Z.format(Instant.parse("0001-01-01T00:00:00Z")) : time(iso); }

    private static String since(String iso) {
        if (iso == null || iso.isEmpty()) return "<unknown>";
        try { return human(Duration.between(Instant.parse(iso), Instant.now())); } catch (RuntimeException e) { return "<unknown>"; }
    }

    /** k8s.io/apimachinery duration.HumanDuration */
    static String human(Duration d) {
        long s = d.getSeconds();
        if (s < -1) return "<invalid>";
        if (s < 0) return "0s";
        if (s < 120) return s + "s";
        long min = s / 60;
        if (min < 10) return s % 60 == 0 ? min + "m" : min + "m" + (s % 60) + "s";
        if (min < 180) return min + "m";
        long h = s / 3600;
        if (h < 8) return min % 60 == 0 ? h + "h" : h + "h" + (min % 60) + "m";
        if (h < 48) return h + "h";
        if (h < 24 * 8) return h % 24 == 0 ? (h / 24) + "d" : (h / 24) + "d" + (h % 24) + "h";
        if (h < 24 * 365 * 2) return (h / 24) + "d";
        if (h < 24 * 365 * 8) { long dy = (h / 24) % 365; return dy == 0 ? (h / 24 / 365) + "y" : (h / 24 / 365) + "y" + dy + "d"; }
        return (h / 24 / 365) + "y";
    }

    private static boolean nonEmpty(String s) { return s != null && !s.isEmpty(); }
    private static String s(String s) { return s == null ? "" : s; }
    private static int nz(Integer i) { return i == null ? 0 : i; }
    private static long nz(Long i) { return i == null ? 0 : i; }
    private static <T> List<T> nzl(List<T> l) { return l == null ? List.of() : l; }
    private static <K, V> Map<K, V> nzm(Map<K, V> m) { return m == null ? Map.of() : m; }

    // ================================================================== resource.Quantity, Go style

    /** a value plus the format it prints in (Go keeps the receiver's format through Add) */
    record Q(BigDecimal v, int format) {
        static final int DECIMAL = 0, BINARY = 1, EXPONENT = 2;
        static final Q ZERO = new Q(BigDecimal.ZERO, DECIMAL);
        Q plus(Q o) { return new Q(v.add(o.v), format); }
        @Override public String toString() { return canonical(v, format); }
    }

    private static Q qq(Quantity qty) {
        if (qty == null) return Q.ZERO;
        String f = s(qty.getFormat());
        int format = f.endsWith("i") ? Q.BINARY : (f.startsWith("e") || f.startsWith("E")) ? Q.EXPONENT : Q.DECIMAL;
        return new Q(Quantity.getAmountInBytes(qty), format);
    }

    private static String q(Quantity qty) { return qq(qty).toString(); }

    /** resource.Quantity.String() */
    static String canonical(BigDecimal v, int format) {
        if (v.signum() == 0) return "0";
        if (format == Q.BINARY) {
            if (v.abs().compareTo(BigDecimal.valueOf(1024)) < 0 || v.stripTrailingZeros().scale() > 0) format = Q.DECIMAL;
            else {
                BigInteger n = v.toBigIntegerExact(), k = BigInteger.valueOf(1024);
                String[] suffix = {"", "Ki", "Mi", "Gi", "Ti", "Pi", "Ei"};
                int e = 0;
                while (e < 6 && n.mod(k).signum() == 0) { n = n.divide(k); e++; }
                return n + suffix[e];
            }
        }
        BigDecimal r = v.setScale(9, RoundingMode.CEILING).stripTrailingZeros();
        BigInteger mant = r.unscaledValue();
        int exp = -r.scale();
        int mod = Math.floorMod(exp, 3);
        if (mod != 0) { mant = mant.multiply(BigInteger.TEN.pow(mod)); exp -= mod; }
        if (format == Q.EXPONENT) return exp == 0 ? mant.toString() : mant + "e" + exp;
        if (exp > 18) { mant = mant.multiply(BigInteger.TEN.pow(exp - 18)); exp = 18; }
        String sfx = switch (exp) {
            case -9 -> "n"; case -6 -> "u"; case -3 -> "m"; case 0 -> ""; case 3 -> "k"; case 6 -> "M";
            case 9 -> "G"; case 12 -> "T"; case 15 -> "P"; default -> "E";
        };
        return mant + sfx;
    }

    /** Quantity.MilliValue(): rounded up */
    private static long milli(BigDecimal v) { return v.multiply(BigDecimal.valueOf(1000)).setScale(0, RoundingMode.CEILING).longValue(); }
    /** Quantity.Value(): rounded up */
    private static long value(BigDecimal v) { return v.setScale(0, RoundingMode.CEILING).longValue(); }

    // ================================================================== output

    private static final char FLUSH = '\u0001';

    /** kubectl's PrefixWriter: two spaces per level, prefix only at the start of a Write; flush() ends every column block */
    private static final class W {
        private final StringBuilder b = new StringBuilder();
        void w(int level, String text) { if (level > 0) b.append("  ".repeat(level)); b.append(text); }
        void line(String text) { b.append(text).append('\n'); }
        void flush() { b.append(FLUSH); }
        @Override public String toString() { return b.toString(); }
    }

    /** tabwriter over each flushed segment independently, like Go's tabwriter.Flush */
    static String tabwrite(String text) {
        StringBuilder out = new StringBuilder();
        for (String segment : text.split(String.valueOf(FLUSH), -1)) out.append(tabwriteSegment(segment));
        return out.toString();
    }

    /**
     * Port of Go's text/tabwriter (minwidth 0, padding 2, pad with spaces — kubectl describe's settings):
     * tab-terminated cells form columns; a column block is a run of consecutive lines that have that cell,
     * and every cell in a block is padded to the block's widest cell.
     */
    static String tabwriteSegment(String text) {
        String[] raw = text.split("\n", -1);
        List<String[]> lines = new ArrayList<>(raw.length);
        for (String l : raw) lines.add(l.split("\t", -1));
        StringBuilder out = new StringBuilder();
        new Object() {
            final List<Integer> widths = new ArrayList<>();

            void format(int line0, int line1) {
                int column = widths.size();
                for (int t = line0; t < line1; t++) {
                    if (column >= lines.get(t).length - 1) continue;
                    write(line0, t);
                    line0 = t;
                    int width = 0;
                    for (; t < line1; t++) {
                        String[] l = lines.get(t);
                        if (column >= l.length - 1) break;
                        width = Math.max(width, l[column].codePointCount(0, l[column].length()) + 2);
                    }
                    widths.add(width);
                    format(line0, t);
                    widths.remove(widths.size() - 1);
                    line0 = t;
                }
                write(line0, line1);
            }

            void write(int from, int to) {
                for (int i = from; i < to; i++) {
                    String[] cells = lines.get(i);
                    for (int j = 0; j < cells.length; j++) {
                        out.append(cells[j]);
                        if (j < cells.length - 1 && j < widths.size())
                            out.append(" ".repeat(Math.max(0, widths.get(j) - cells[j].codePointCount(0, cells[j].length()))));
                    }
                    if (i < lines.size() - 1) out.append('\n');
                }
            }
        }.format(0, lines.size());
        return out.toString();
    }
}
