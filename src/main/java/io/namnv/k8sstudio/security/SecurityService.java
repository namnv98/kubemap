package io.namnv.k8sstudio.security;

import io.fabric8.kubernetes.api.model.*;
import io.fabric8.kubernetes.api.model.apps.DaemonSet;
import io.fabric8.kubernetes.api.model.apps.Deployment;
import io.fabric8.kubernetes.api.model.apps.StatefulSet;
import io.fabric8.kubernetes.api.model.batch.v1.CronJob;
import io.fabric8.kubernetes.api.model.batch.v1.Job;
import io.fabric8.kubernetes.api.model.networking.v1.Ingress;
import io.fabric8.kubernetes.api.model.networking.v1.NetworkPolicy;
import io.fabric8.kubernetes.api.model.rbac.*;
import io.namnv.k8sstudio.graph.ClusterCache;
import org.springframework.stereotype.Service;

import java.util.*;

/**
 * Security overview computed from the informer cache (no scanner, no agent):
 * workload configuration checks on pod templates, network entry points, and RBAC — who can do what, through which binding.
 */
@Service
public class SecurityService {

    private final ClusterCache cache;

    public SecurityService(ClusterCache cache) {
        this.cache = cache;
    }

    // ================================================================== workload checks

    /** severity: high | medium | low */
    public record Finding(String severity, String check, String title, String detail) {}

    public record WorkloadReport(String id, String kind, String namespace, String name, String serviceAccount, List<Finding> findings) {}

    public List<WorkloadReport> workloads(String ns) {
        List<WorkloadReport> out = new ArrayList<>();
        Map<String, List<NetworkPolicy>> policies = new HashMap<>();
        for (NetworkPolicy p : cache.listOf(NetworkPolicy.class, ns)) policies.computeIfAbsent(p.getMetadata().getNamespace(), k -> new ArrayList<>()).add(p);
        for (Deployment d : cache.listOf(Deployment.class, ns)) out.add(check(d, d.getSpec().getTemplate(), policies));
        for (StatefulSet s : cache.listOf(StatefulSet.class, ns)) out.add(check(s, s.getSpec().getTemplate(), policies));
        for (DaemonSet d : cache.listOf(DaemonSet.class, ns)) out.add(check(d, d.getSpec().getTemplate(), policies));
        for (CronJob c : cache.listOf(CronJob.class, ns)) out.add(check(c, c.getSpec().getJobTemplate().getSpec().getTemplate(), policies));
        for (Job j : cache.listOf(Job.class, ns)) if (controller(j) == null) out.add(check(j, j.getSpec().getTemplate(), policies));
        for (Pod p : cache.listOf(Pod.class, ns)) if (controller(p) == null) {
            PodTemplateSpec t = new PodTemplateSpec(p.getMetadata(), p.getSpec());
            out.add(check(p, t, policies));
        }
        out.removeIf(r -> r.findings().isEmpty());
        out.sort(Comparator.comparingInt((WorkloadReport r) -> -score(r.findings())).thenComparing(WorkloadReport::id));
        return out;
    }

    private static int score(List<Finding> f) {
        return f.stream().mapToInt(x -> switch (x.severity()) { case "high" -> 100; case "medium" -> 10; default -> 1; }).sum();
    }

    private WorkloadReport check(HasMetadata o, PodTemplateSpec t, Map<String, List<NetworkPolicy>> policies) {
        List<Finding> f = new ArrayList<>();
        PodSpec s = t == null || t.getSpec() == null ? new PodSpec() : t.getSpec();
        var psc = s.getSecurityContext();
        if (Boolean.TRUE.equals(s.getHostNetwork())) f.add(new Finding("high", "hostNetwork", "Dùng mạng của node (hostNetwork)", "Pod thấy và mở cổng trực tiếp trên card mạng của node."));
        if (Boolean.TRUE.equals(s.getHostPID())) f.add(new Finding("high", "hostPID", "Thấy tiến trình của node (hostPID)", "Có thể đọc /proc và gửi tín hiệu tới tiến trình khác trên node."));
        if (Boolean.TRUE.equals(s.getHostIPC())) f.add(new Finding("medium", "hostIPC", "Dùng IPC của node (hostIPC)", null));
        for (Volume v : nzl(s.getVolumes())) if (v.getHostPath() != null) {
            String p = v.getHostPath().getPath();
            boolean sensitive = p != null && (p.equals("/") || p.startsWith("/etc") || p.startsWith("/var/run") || p.startsWith("/run") || p.contains("docker.sock") || p.contains("containerd") || p.startsWith("/proc") || p.startsWith("/sys") || p.startsWith("/root") || p.startsWith("/var/lib/kubelet"));
            f.add(new Finding(sensitive ? "high" : "medium", "hostPath", "Gắn thư mục của node: " + p, "volume " + v.getName() + (sensitive ? " — đường dẫn nhạy cảm, container có thể đọc/sửa node" : "")));
        }
        boolean nonRootPod = psc != null && (Boolean.TRUE.equals(psc.getRunAsNonRoot()) || (psc.getRunAsUser() != null && psc.getRunAsUser() != 0));
        if (psc == null || psc.getSeccompProfile() == null) {
            boolean allHave = nzl(s.getContainers()).stream().allMatch(c -> c.getSecurityContext() != null && c.getSecurityContext().getSeccompProfile() != null);
            if (!allHave) f.add(new Finding("low", "seccomp", "Không đặt seccompProfile", "Nên dùng RuntimeDefault."));
        }
        List<Container> all = new ArrayList<>(nzl(s.getInitContainers()));
        all.addAll(nzl(s.getContainers()));
        for (Container c : all) {
            var sc = c.getSecurityContext();
            String who = "container " + c.getName();
            if (sc != null && Boolean.TRUE.equals(sc.getPrivileged())) f.add(new Finding("high", "privileged", "Container privileged", who + " có toàn quyền như root trên node."));
            if (sc != null && sc.getCapabilities() != null) {
                List<String> add = nzl(sc.getCapabilities().getAdd());
                List<String> danger = add.stream().filter(x -> Set.of("ALL", "SYS_ADMIN", "NET_ADMIN", "SYS_PTRACE", "SYS_MODULE", "DAC_READ_SEARCH", "NET_RAW", "BPF").contains(x.toUpperCase(Locale.ROOT))).toList();
                if (!danger.isEmpty()) f.add(new Finding("high", "capabilities", "Thêm capability nguy hiểm: " + String.join(", ", danger), who));
            }
            boolean nonRoot = nonRootPod || (sc != null && (Boolean.TRUE.equals(sc.getRunAsNonRoot()) || (sc.getRunAsUser() != null && sc.getRunAsUser() != 0)));
            if (sc != null && sc.getRunAsUser() != null && sc.getRunAsUser() == 0) f.add(new Finding("medium", "root", "Chạy bằng root (runAsUser: 0)", who));
            else if (!nonRoot) f.add(new Finding("medium", "root", "Có thể chạy bằng root", who + " không đặt runAsNonRoot / runAsUser — chạy theo user của image."));
            if (sc == null || !Boolean.FALSE.equals(sc.getAllowPrivilegeEscalation()))
                f.add(new Finding("low", "privEsc", "Không chặn leo quyền", who + " chưa đặt allowPrivilegeEscalation: false."));
            if (sc == null || !Boolean.TRUE.equals(sc.getReadOnlyRootFilesystem()))
                f.add(new Finding("low", "rootfs", "Root filesystem ghi được", who + " chưa đặt readOnlyRootFilesystem: true."));
            String img = c.getImage() == null ? "" : c.getImage();
            String tag = img.contains("@") ? "digest" : img.lastIndexOf(':') > img.lastIndexOf('/') ? img.substring(img.lastIndexOf(':') + 1) : "";
            if (tag.isEmpty() || tag.equals("latest")) f.add(new Finding("medium", "imageTag", "Image không cố định phiên bản: " + img, who + " — mỗi lần pull có thể ra bản khác."));
            var r = c.getResources();
            boolean noLimits = r == null || r.getLimits() == null || r.getLimits().get("memory") == null;
            if (noLimits && nzl(s.getContainers()).contains(c)) f.add(new Finding("low", "limits", "Không giới hạn memory", who + " có thể dùng hết RAM của node."));
            for (ContainerPort p : nzl(c.getPorts())) if (p.getHostPort() != null && p.getHostPort() > 0)
                f.add(new Finding("medium", "hostPort", "Mở hostPort " + p.getHostPort(), who + " nhận traffic trực tiếp trên IP của node."));
        }
        // network policy coverage: is the pod selected by any policy of its namespace?
        Map<String, String> labels = t == null || t.getMetadata() == null ? Map.of() : nzm(t.getMetadata().getLabels());
        boolean covered = nzl(policies.get(o.getMetadata().getNamespace())).stream().anyMatch(p -> matches(p.getSpec().getPodSelector(), labels));
        if (!covered && !Boolean.TRUE.equals(s.getHostNetwork()))
            f.add(new Finding("low", "netpol", "Không có NetworkPolicy nào áp lên", "Mọi pod trong cluster đều kết nối tới được."));
        if (!Boolean.FALSE.equals(s.getAutomountServiceAccountToken())) {
            String sa = s.getServiceAccountName() == null || s.getServiceAccountName().isEmpty() ? "default" : s.getServiceAccountName();
            List<String> flags = flagsOf(subjectRules("ServiceAccount", sa, o.getMetadata().getNamespace()));
            if (!flags.isEmpty()) f.add(new Finding(flags.contains("cluster-admin") || flags.contains("đọc Secret") || flags.contains("leo quyền") ? "high" : "medium",
                    "saToken", "Token ServiceAccount có quyền rộng: " + String.join(", ", flags), "ServiceAccount " + sa + " được gắn tự động vào pod."));
        }
        String sa = s.getServiceAccountName() == null || s.getServiceAccountName().isEmpty() ? "default" : s.getServiceAccountName();
        return new WorkloadReport(id(o), o.getKind(), o.getMetadata().getNamespace(), o.getMetadata().getName(), sa, f);
    }

    // ================================================================== entry points

    public record EntryPoint(String severity, String kind, String id, String namespace, String name, String how, String detail) {}

    public List<EntryPoint> entryPoints(String ns) {
        List<EntryPoint> out = new ArrayList<>();
        for (var svc : cache.listOf(io.fabric8.kubernetes.api.model.Service.class, ns)) {
            var sp = svc.getSpec();
            String ports = String.join(", ", nzl(sp.getPorts()).stream().map(p -> p.getPort() + (p.getNodePort() != null ? "→" + p.getNodePort() : "") + "/" + p.getProtocol()).toList());
            if ("LoadBalancer".equals(sp.getType())) {
                String addr = svc.getStatus() == null || svc.getStatus().getLoadBalancer() == null ? "" : String.join(", ", nzl(svc.getStatus().getLoadBalancer().getIngress()).stream()
                        .map(i -> i.getIp() != null ? i.getIp() : i.getHostname()).filter(Objects::nonNull).toList());
                boolean open = nzl(sp.getLoadBalancerSourceRanges()).isEmpty();
                out.add(new EntryPoint(open ? "high" : "medium", "Service", id(svc), svc.getMetadata().getNamespace(), svc.getMetadata().getName(), "LoadBalancer",
                        (addr.isEmpty() ? "" : addr + " · ") + ports + (open ? " · mở cho mọi nguồn (không có loadBalancerSourceRanges)" : " · giới hạn " + String.join(",", sp.getLoadBalancerSourceRanges()))));
            } else if ("NodePort".equals(sp.getType()))
                out.add(new EntryPoint("medium", "Service", id(svc), svc.getMetadata().getNamespace(), svc.getMetadata().getName(), "NodePort", ports + " trên IP của mọi node"));
            if (!nzl(sp.getExternalIPs()).isEmpty())
                out.add(new EntryPoint("medium", "Service", id(svc), svc.getMetadata().getNamespace(), svc.getMetadata().getName(), "externalIPs", String.join(", ", sp.getExternalIPs())));
        }
        for (Ingress i : cache.listOf(Ingress.class, ns)) {
            Set<String> tlsHosts = new HashSet<>();
            nzl(i.getSpec().getTls()).forEach(t -> tlsHosts.addAll(nzl(t.getHosts())));
            List<String> hosts = nzl(i.getSpec().getRules()).stream().map(r -> r.getHost() == null ? "*" : r.getHost()).distinct().toList();
            List<String> plain = hosts.stream().filter(h -> !tlsHosts.contains(h)).toList();
            List<String> missingSecrets = nzl(i.getSpec().getTls()).stream().map(t -> t.getSecretName())
                    .filter(n -> n != null && cache.find("Secret", i.getMetadata().getNamespace(), n).isEmpty()).toList();
            String detail = String.join(", ", hosts) + (plain.isEmpty() ? " · TLS" : " · không TLS: " + String.join(", ", plain))
                    + (missingSecrets.isEmpty() ? "" : " · thiếu Secret TLS: " + String.join(", ", missingSecrets));
            out.add(new EntryPoint(plain.isEmpty() && missingSecrets.isEmpty() ? "low" : "medium", "Ingress", id(i), i.getMetadata().getNamespace(), i.getMetadata().getName(), "Ingress", detail));
        }
        for (Pod p : cache.listOf(Pod.class, ns)) {
            if (Boolean.TRUE.equals(p.getSpec().getHostNetwork()))
                out.add(new EntryPoint("medium", "Pod", id(p), p.getMetadata().getNamespace(), p.getMetadata().getName(), "hostNetwork", "node " + p.getSpec().getNodeName()));
            for (Container c : nzl(p.getSpec().getContainers())) for (ContainerPort cp : nzl(c.getPorts()))
                if (cp.getHostPort() != null && cp.getHostPort() > 0 && !Boolean.TRUE.equals(p.getSpec().getHostNetwork()))
                    out.add(new EntryPoint("medium", "Pod", id(p), p.getMetadata().getNamespace(), p.getMetadata().getName(), "hostPort", cp.getHostPort() + "/" + cp.getProtocol() + " trên node " + p.getSpec().getNodeName()));
        }
        out.sort(Comparator.comparing((EntryPoint e) -> rank(e.severity())).thenComparing(EntryPoint::id));
        return out;
    }

    private static int rank(String s) { return switch (s) { case "high" -> 0; case "medium" -> 1; default -> 2; }; }

    // ================================================================== RBAC

    /** one effective rule of a subject: where it applies (namespace or cluster-wide) and through which binding / role */
    public record Grant(String scope, String binding, String bindingKind, String role, String roleKind, List<String> verbs, List<String> apiGroups,
                        List<String> resources, List<String> resourceNames, List<String> nonResourceURLs) {}

    public record SubjectReport(String kind, String name, String namespace, boolean system, List<String> flags, List<Grant> grants) {}

    public List<SubjectReport> subjects(String ns) {
        Map<String, SubjectReport> out = new TreeMap<>();
        Map<String, List<Grant>> grants = new HashMap<>();
        Map<String, String[]> who = new HashMap<>();
        forEachGrant(ns, (s, g) -> {
            String key = s.getKind() + "\u0000" + nz(s.getNamespace()) + "\u0000" + s.getName();
            grants.computeIfAbsent(key, k -> new ArrayList<>()).add(g);
            who.put(key, new String[]{s.getKind(), s.getName(), s.getNamespace()});
        });
        grants.forEach((key, gs) -> {
            String[] w = who.get(key);
            boolean system = w[1].startsWith("system:") || (w[2] != null && w[2].startsWith("kube-") && "ServiceAccount".equals(w[0]));
            out.put(key, new SubjectReport(w[0], w[1], w[2], system, flagsOf(gs), gs));
        });
        List<SubjectReport> list = new ArrayList<>(out.values());
        list.sort(Comparator.comparing(SubjectReport::system).thenComparing(r -> -r.flags().size()).thenComparing(SubjectReport::kind).thenComparing(SubjectReport::name));
        return list;
    }

    public record Allowed(String kind, String name, String namespace, String scope, String binding, String role) {}

    /** "who can <verb> <resource> in <namespace>" — namespace null = in any namespace (scope says where) */
    public List<Allowed> whoCan(String verb, String resource, String group, String namespace) {
        String res = resource.contains("/") ? resource.substring(0, resource.indexOf('/')) : resource;
        String sub = resource.contains("/") ? resource.substring(resource.indexOf('/') + 1) : null;
        List<Allowed> out = new ArrayList<>();
        forEachGrant(null, (s, g) -> {
            if (namespace != null && !"cluster".equals(g.scope()) && !namespace.equals(g.scope())) return;
            if (!any(g.verbs(), verb) || !any(g.apiGroups(), group == null ? "" : group)) return;
            boolean resOk = g.resources().stream().anyMatch(r -> r.equals("*") || r.equals(resource) || (sub == null && r.equals(res)) || (sub != null && (r.equals(res + "/*") || r.equals("*/" + sub))));
            if (!resOk) return;
            out.add(new Allowed(s.getKind(), s.getName(), s.getNamespace(), g.scope(), g.bindingKind() + " " + g.binding(), g.roleKind() + " " + g.role()));
        });
        out.sort(Comparator.comparing(Allowed::kind).thenComparing(Allowed::name));
        return out;
    }

    private interface GrantSink { void accept(Subject s, Grant g); }

    /** every (subject, rule) pair from RoleBindings (in ns, or all when ns is null) and all ClusterRoleBindings */
    private void forEachGrant(String ns, GrantSink sink) {
        Map<String, ClusterRole> clusterRoles = new HashMap<>();
        cache.listOf(ClusterRole.class, null).forEach(r -> clusterRoles.put(r.getMetadata().getName(), r));
        for (ClusterRoleBinding b : cache.listOf(ClusterRoleBinding.class, null)) {
            ClusterRole r = clusterRoles.get(b.getRoleRef().getName());
            for (Subject s : nzl(b.getSubjects())) for (PolicyRule rule : r == null ? List.<PolicyRule>of() : nzl(r.getRules()))
                sink.accept(s, grant("cluster", b.getMetadata().getName(), "ClusterRoleBinding", r.getMetadata().getName(), "ClusterRole", rule));
        }
        for (RoleBinding b : cache.listOf(RoleBinding.class, ns)) {
            String bns = b.getMetadata().getNamespace();
            List<PolicyRule> rules;
            String roleKind = b.getRoleRef().getKind();
            if ("ClusterRole".equals(roleKind)) {
                ClusterRole r = clusterRoles.get(b.getRoleRef().getName());
                rules = r == null ? List.of() : nzl(r.getRules());
            } else {
                Role r = cache.find("Role", bns, b.getRoleRef().getName()).map(Role.class::cast).orElse(null);
                rules = r == null ? List.of() : nzl(r.getRules());
            }
            for (Subject s : nzl(b.getSubjects())) {
                Subject subj = s;
                if ("ServiceAccount".equals(s.getKind()) && (s.getNamespace() == null || s.getNamespace().isEmpty()))
                    subj = new SubjectBuilder(s).withNamespace(bns).build();
                for (PolicyRule rule : rules) sink.accept(subj, grant(bns, b.getMetadata().getName(), "RoleBinding", b.getRoleRef().getName(), roleKind, rule));
            }
        }
    }

    private List<Grant> subjectRules(String kind, String name, String ns) {
        List<Grant> out = new ArrayList<>();
        forEachGrant(null, (s, g) -> {
            if (!kind.equals(s.getKind()) || !name.equals(s.getName())) return;
            if ("ServiceAccount".equals(kind) && !Objects.equals(ns, s.getNamespace())) return;
            out.add(g);
        });
        // every ServiceAccount is also in these groups
        if ("ServiceAccount".equals(kind)) for (String grp : List.of("system:serviceaccounts", "system:serviceaccounts:" + ns, "system:authenticated"))
            forEachGrant(null, (s, g) -> { if ("Group".equals(s.getKind()) && grp.equals(s.getName()) && !g.role().startsWith("system:")) out.add(g); });
        return out;
    }

    private static Grant grant(String scope, String binding, String bindingKind, String role, String roleKind, PolicyRule r) {
        return new Grant(scope, binding, bindingKind, role, roleKind, nzl(r.getVerbs()), nzl(r.getApiGroups()), nzl(r.getResources()),
                nzl(r.getResourceNames()), nzl(r.getNonResourceURLs()));
    }

    /** risk flags of a set of grants (cluster-admin, read secrets, exec, escalation, workloads, wildcard) */
    static List<String> flagsOf(List<Grant> gs) {
        Set<String> f = new LinkedHashSet<>();
        for (Grant g : gs) {
            boolean cluster = "cluster".equals(g.scope());
            boolean starAll = g.verbs().contains("*") && g.resources().contains("*") && g.apiGroups().contains("*");
            if (starAll && cluster) f.add("cluster-admin");
            else if (starAll) f.add("admin namespace " + g.scope());
            if (g.resources().contains("*") || g.verbs().contains("*")) f.add("wildcard");
            if (core(g) && hasRes(g, "secrets") && (any(g.verbs(), "get") || any(g.verbs(), "list") || any(g.verbs(), "watch"))) f.add("đọc Secret");
            if (core(g) && (hasRes(g, "pods/exec") || hasRes(g, "pods/attach")) && (any(g.verbs(), "create") || any(g.verbs(), "get"))) f.add("exec vào pod");
            if (any(g.verbs(), "escalate") || any(g.verbs(), "bind") || any(g.verbs(), "impersonate")
                    || (any(g.apiGroups(), "rbac.authorization.k8s.io") && (hasRes(g, "rolebindings") || hasRes(g, "clusterrolebindings")) && (any(g.verbs(), "create") || any(g.verbs(), "update") || any(g.verbs(), "patch"))))
                f.add("leo quyền");
            if ((core(g) && hasRes(g, "pods") || any(g.apiGroups(), "apps") && (hasRes(g, "deployments") || hasRes(g, "daemonsets") || hasRes(g, "statefulsets")))
                    && (any(g.verbs(), "create") || any(g.verbs(), "update") || any(g.verbs(), "patch"))) f.add("tạo/sửa workload");
            if (core(g) && hasRes(g, "nodes/proxy")) f.add("nodes/proxy");
        }
        return new ArrayList<>(f);
    }

    private static boolean core(Grant g) { return any(g.apiGroups(), ""); }
    private static boolean hasRes(Grant g, String r) { return g.resources().contains("*") || g.resources().contains(r); }
    private static boolean any(List<String> l, String v) { return l.contains("*") || l.contains(v); }

    // ================================================================== helpers

    private static boolean matches(LabelSelector sel, Map<String, String> labels) {
        if (sel == null) return true;
        for (var e : nzm(sel.getMatchLabels()).entrySet()) if (!e.getValue().equals(labels.get(e.getKey()))) return false;
        for (var e : nzl(sel.getMatchExpressions())) {
            String v = labels.get(e.getKey());
            switch (e.getOperator()) {
                case "In" -> { if (v == null || !nzl(e.getValues()).contains(v)) return false; }
                case "NotIn" -> { if (v != null && nzl(e.getValues()).contains(v)) return false; }
                case "Exists" -> { if (v == null) return false; }
                case "DoesNotExist" -> { if (v != null) return false; }
                default -> { return false; }
            }
        }
        return true;
    }

    private static OwnerReference controller(HasMetadata o) {
        return nzl(o.getMetadata().getOwnerReferences()).stream().filter(r -> Boolean.TRUE.equals(r.getController())).findFirst().orElse(null);
    }

    private static String id(HasMetadata o) { return o.getKind() + "/" + nz(o.getMetadata().getNamespace()) + "/" + o.getMetadata().getName(); }
    private static String nz(String s) { return s == null ? "" : s; }
    private static <T> List<T> nzl(List<T> l) { return l == null ? List.of() : l; }
    private static <K, V> Map<K, V> nzm(Map<K, V> m) { return m == null ? Map.of() : m; }
}
