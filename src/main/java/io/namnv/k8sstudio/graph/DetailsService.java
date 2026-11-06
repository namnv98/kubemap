package io.namnv.k8sstudio.graph;

import io.fabric8.kubernetes.api.model.*;
import io.fabric8.kubernetes.api.model.apps.DaemonSet;
import io.fabric8.kubernetes.api.model.apps.Deployment;
import io.fabric8.kubernetes.api.model.apps.ReplicaSet;
import io.fabric8.kubernetes.api.model.apps.StatefulSet;
import io.fabric8.kubernetes.api.model.batch.v1.CronJob;
import io.fabric8.kubernetes.api.model.batch.v1.Job;
import io.fabric8.kubernetes.api.model.rbac.ClusterRole;
import io.fabric8.kubernetes.api.model.rbac.PolicyRule;
import io.fabric8.kubernetes.api.model.rbac.Role;
import org.springframework.stereotype.Service;

import java.util.*;

/**
 * On-demand details for the side panel: containers, conditions, events, annotations, Helm info, node capacity…
 * Secret values are never returned (only key names and sizes).
 */
@Service
public class DetailsService {

    private static final Set<String> DROP_ANNOTATIONS = Set.of("kubectl.kubernetes.io/last-applied-configuration");
    private static final int MAX_EVENTS = 25;

    private final ClusterCache cache;
    private final MetricsCache metrics;
    private final io.namnv.k8sstudio.actions.ManagedBy managedBy;

    public DetailsService(ClusterCache cache, MetricsCache metrics, io.namnv.k8sstudio.actions.ManagedBy managedBy) {
        this.cache = cache;
        this.metrics = metrics;
        this.managedBy = managedBy;
    }

    public Optional<Map<String, Object>> details(String kind, String ns, String name) {
        return cache.find(kind, ns == null || ns.isBlank() ? null : ns, name).map(this::describe);
    }

    private Map<String, Object> describe(HasMetadata o) {
        var m = o.getMetadata();
        Map<String, Object> d = new LinkedHashMap<>();
        d.put("kind", o.getKind());
        d.put("name", m.getName());
        d.put("namespace", m.getNamespace());
        d.put("uid", m.getUid());
        d.put("created", m.getCreationTimestamp());
        d.put("labels", m.getLabels() == null ? Map.of() : new TreeMap<>(m.getLabels()));
        d.put("annotations", annotations(m.getAnnotations()));
        d.put("helm", helm(m));
        d.put("manager", managedBy.detect(o).orElse(null));
        d.put("owners", nz(m.getOwnerReferences()).stream().map(r -> Map.of("kind", r.getKind(), "name", r.getName())).toList());
        List<Map<String, Object>> conds = conditions(o);
        if (conds.isEmpty() && o instanceof GenericKubernetesResource r) conds = parentConditions(r);
        d.put("conditions", conds);
        d.put("tables", tables(o));

        switch (o) {
            case Pod p -> d.put("containers", podContainers(p));
            case Deployment x -> d.put("containers", templateContainers(x.getSpec().getTemplate()));
            case ReplicaSet x -> d.put("containers", templateContainers(x.getSpec().getTemplate()));
            case StatefulSet x -> d.put("containers", templateContainers(x.getSpec().getTemplate()));
            case DaemonSet x -> d.put("containers", templateContainers(x.getSpec().getTemplate()));
            case Job x -> d.put("containers", templateContainers(x.getSpec().getTemplate()));
            case CronJob x -> d.put("containers", templateContainers(x.getSpec().getJobTemplate().getSpec().getTemplate()));
            case io.fabric8.kubernetes.api.model.Node n -> d.put("node", node(n));
            case ConfigMap c -> d.put("data", keys(c.getData(), c.getBinaryData()));
            case Secret s -> d.put("data", keys(s.getData(), null)); // sizes only, never values
            case io.fabric8.kubernetes.api.model.Service svc -> d.put("endpoints", endpoints(svc));
            case Role r -> d.put("rules", rules(r.getRules()));
            case ClusterRole r -> d.put("rules", rules(r.getRules()));
            default -> { }
        }
        d.put("events", cache.eventsFor(o).stream().limit(MAX_EVENTS).map(e -> {
            Map<String, Object> ev = new LinkedHashMap<>();
            ev.put("type", e.getType());
            ev.put("reason", e.getReason());
            ev.put("message", e.getMessage());
            ev.put("count", e.getCount() != null ? e.getCount() : e.getSeries() != null ? e.getSeries().getCount() : 1);
            ev.put("last", ClusterCache.eventTime(e));
            ev.put("source", e.getSource() != null && e.getSource().getComponent() != null ? e.getSource().getComponent()
                    : e.getReportingComponent());
            return ev;
        }).toList());
        return d;
    }

    // ------------------------------------------------------------------ pieces

    private static Map<String, String> annotations(Map<String, String> a) {
        Map<String, String> out = new TreeMap<>();
        nz(a).forEach((k, v) -> {
            if (DROP_ANNOTATIONS.contains(k)) return;
            out.put(k, v != null && v.length() > 400 ? v.substring(0, 400) + "… (" + v.length() + " ký tự)" : v);
        });
        return out;
    }

    private static Map<String, String> helm(ObjectMeta m) {
        String release = nz(m.getAnnotations()).get("meta.helm.sh/release-name");
        String managedBy = nz(m.getLabels()).get("app.kubernetes.io/managed-by");
        String chart = nz(m.getLabels()).get("helm.sh/chart");
        if (release == null && chart == null && !"Helm".equals(managedBy)) return null;
        Map<String, String> h = new LinkedHashMap<>();
        if (release != null) h.put("release", release);
        String relNs = nz(m.getAnnotations()).get("meta.helm.sh/release-namespace");
        if (relNs != null) h.put("namespace", relNs);
        if (chart != null) h.put("chart", chart);
        String instance = nz(m.getLabels()).get("app.kubernetes.io/instance");
        if (release == null && instance != null) h.put("release", instance);
        return h;
    }

    /** status.conditions of any object (built-in or custom), read generically. */
    @SuppressWarnings("unchecked")
    private List<Map<String, Object>> conditions(HasMetadata o) {
        Map<String, Object> obj = cache.client().getKubernetesSerialization().convertValue(o, Map.class);
        Object status = obj.get("status");
        if (!(status instanceof Map<?, ?> st) || !(st.get("conditions") instanceof List<?> list)) return List.of();
        List<Map<String, Object>> out = new ArrayList<>();
        for (Object c : list) {
            if (!(c instanceof Map<?, ?> cm)) continue;
            Map<String, Object> v = new LinkedHashMap<>();
            for (String k : List.of("type", "status", "reason", "message", "lastTransitionTime"))
                if (cm.get(k) != null) v.put(k, cm.get(k));
            out.add(v);
        }
        return out;
    }

    private List<Map<String, Object>> podContainers(Pod p) {
        Map<String, ContainerStatus> st = new HashMap<>();
        if (p.getStatus() != null) {
            nz(p.getStatus().getInitContainerStatuses()).forEach(s -> st.put(s.getName(), s));
            nz(p.getStatus().getContainerStatuses()).forEach(s -> st.put(s.getName(), s));
        }
        var usage = metrics.containers(p.getMetadata().getNamespace(), p.getMetadata().getName());
        List<Map<String, Object>> out = new ArrayList<>();
        List<Container> init = nz(p.getSpec().getInitContainers());
        for (Container c : init) out.add(container(c, true, st.get(c.getName()), usage.get(c.getName())));
        for (Container c : nz(p.getSpec().getContainers())) out.add(container(c, false, st.get(c.getName()), usage.get(c.getName())));
        return out;
    }

    private List<Map<String, Object>> templateContainers(PodTemplateSpec t) {
        if (t == null || t.getSpec() == null) return List.of();
        List<Map<String, Object>> out = new ArrayList<>();
        nz(t.getSpec().getInitContainers()).forEach(c -> out.add(container(c, true, null, null)));
        nz(t.getSpec().getContainers()).forEach(c -> out.add(container(c, false, null, null)));
        return out;
    }

    private static Map<String, Object> container(Container c, boolean init, ContainerStatus s, MetricsCache.Usage u) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("name", c.getName());
        m.put("init", init);
        m.put("image", c.getImage());
        m.put("ports", nz(c.getPorts()).stream().map(pt -> (pt.getName() != null ? pt.getName() + " " : "")
                + pt.getContainerPort() + "/" + Objects.requireNonNullElse(pt.getProtocol(), "TCP")).toList());
        if (c.getResources() != null) {
            m.put("requests", quantities(c.getResources().getRequests()));
            m.put("limits", quantities(c.getResources().getLimits()));
        }
        Map<String, String> probes = new LinkedHashMap<>();
        if (c.getLivenessProbe() != null) probes.put("liveness", probe(c.getLivenessProbe()));
        if (c.getReadinessProbe() != null) probes.put("readiness", probe(c.getReadinessProbe()));
        if (c.getStartupProbe() != null) probes.put("startup", probe(c.getStartupProbe()));
        m.put("probes", probes);
        if (s != null) {
            m.put("ready", Boolean.TRUE.equals(s.getReady()));
            m.put("restarts", s.getRestartCount() == null ? 0 : s.getRestartCount());
            var cs = s.getState();
            if (cs != null && cs.getRunning() != null) { m.put("state", "running"); m.put("since", cs.getRunning().getStartedAt()); }
            else if (cs != null && cs.getWaiting() != null) { m.put("state", "waiting"); m.put("reason", cs.getWaiting().getReason()); m.put("message", cs.getWaiting().getMessage()); }
            else if (cs != null && cs.getTerminated() != null) { m.put("state", "terminated"); m.put("reason", cs.getTerminated().getReason());
                m.put("exitCode", cs.getTerminated().getExitCode()); m.put("message", cs.getTerminated().getMessage()); }
            var last = s.getLastState() == null ? null : s.getLastState().getTerminated();
            if (last != null) {
                Map<String, Object> l = new LinkedHashMap<>();
                l.put("reason", last.getReason());
                l.put("exitCode", last.getExitCode());
                l.put("finishedAt", last.getFinishedAt());
                if (last.getMessage() != null) l.put("message", last.getMessage());
                m.put("lastState", l);
            }
        }
        if (u != null) m.put("usage", Map.of("cpu", MetricsCache.cpu(u.cpuMilli()), "memory", MetricsCache.mem(u.memBytes())));
        return m;
    }

    private static String probe(Probe p) {
        String what;
        if (p.getHttpGet() != null) what = "HTTP GET :" + intOrString(p.getHttpGet().getPort()) + Objects.requireNonNullElse(p.getHttpGet().getPath(), "/");
        else if (p.getTcpSocket() != null) what = "TCP :" + intOrString(p.getTcpSocket().getPort());
        else if (p.getGrpc() != null) what = "gRPC :" + p.getGrpc().getPort();
        else if (p.getExec() != null) what = "exec " + String.join(" ", nz(p.getExec().getCommand()));
        else what = "?";
        return what + " · mỗi " + Objects.requireNonNullElse(p.getPeriodSeconds(), 10) + "s, lỗi sau "
                + Objects.requireNonNullElse(p.getFailureThreshold(), 3) + " lần";
    }

    private static String intOrString(IntOrString v) {
        return v == null ? "?" : v.getIntVal() != null ? v.getIntVal().toString() : v.getStrVal();
    }

    private Map<String, Object> node(io.fabric8.kubernetes.api.model.Node n) {
        Map<String, Object> d = new LinkedHashMap<>();
        if (n.getStatus() != null) {
            d.put("capacity", quantities(n.getStatus().getCapacity()));
            d.put("allocatable", quantities(n.getStatus().getAllocatable()));
            var ni = n.getStatus().getNodeInfo();
            if (ni != null) d.put("system", Map.of("os", ni.getOsImage(), "kernel", ni.getKernelVersion(),
                    "runtime", ni.getContainerRuntimeVersion(), "arch", ni.getArchitecture(), "kubelet", ni.getKubeletVersion()));
        }
        d.put("taints", nz(n.getSpec().getTaints()).stream().map(t -> t.getKey() + (t.getValue() != null ? "=" + t.getValue() : "")
                + ":" + t.getEffect()).toList());
        d.put("unschedulable", Boolean.TRUE.equals(n.getSpec().getUnschedulable()));
        var u = metrics.node(n.getMetadata().getName());
        if (u != null) d.put("usage", Map.of("cpu", MetricsCache.cpu(u.cpuMilli()), "memory", MetricsCache.mem(u.memBytes())));
        long pods = cache.pods.getStore().list().stream().filter(p -> n.getMetadata().getName().equals(p.getSpec().getNodeName())).count();
        d.put("pods", pods);
        return d;
    }

    private static List<Map<String, Object>> keys(Map<String, String> data, Map<String, String> binary) {
        List<Map<String, Object>> out = new ArrayList<>();
        nz(data).forEach((k, v) -> out.add(Map.of("key", k, "size", v == null ? 0 : v.length())));
        nz(binary).forEach((k, v) -> out.add(Map.of("key", k, "size", v == null ? 0 : v.length(), "binary", true)));
        out.sort(Comparator.comparing(x -> (String) x.get("key")));
        return out;
    }

    private static List<Map<String, String>> rules(List<PolicyRule> rules) {
        return nz(rules).stream().map(r -> Map.of(
                "verbs", String.join(", ", nz(r.getVerbs())),
                "resources", String.join(", ", !nz(r.getResources()).isEmpty() ? r.getResources() : nz(r.getNonResourceURLs())),
                "apiGroups", nz(r.getApiGroups()).stream().map(g -> g.isEmpty() ? "core" : g).reduce((a, b) -> a + ", " + b).orElse("")
        )).toList();
    }

    private static Map<String, String> quantities(Map<String, Quantity> q) {
        Map<String, String> out = new TreeMap<>();
        nz(q).forEach((k, v) -> out.put(k, v.toString()));
        return out;
    }


    // ------------------------------------------------------------------ service endpoints

    /** every address of the Service's EndpointSlices: pod, ip, ports, node, ready / serving / terminating */
    private List<Map<String, Object>> endpoints(io.fabric8.kubernetes.api.model.Service svc) {
        String ns = svc.getMetadata().getNamespace(), name = svc.getMetadata().getName();
        List<Map<String, Object>> out = new ArrayList<>();
        for (var es : ClusterCache.list(cache.endpointSlices, ns)) {
            if (!name.equals(nz(es.getMetadata().getLabels()).get("kubernetes.io/service-name"))) continue;
            String ports = nz(es.getPorts()).stream().map(p -> (p.getName() != null && !p.getName().isEmpty() ? p.getName() + " " : "")
                    + p.getPort() + "/" + Objects.requireNonNullElse(p.getProtocol(), "TCP")).reduce((a, b) -> a + ", " + b).orElse("");
            for (var ep : nz(es.getEndpoints())) {
                var c = ep.getConditions();
                for (String ip : nz(ep.getAddresses())) {
                    Map<String, Object> m = new LinkedHashMap<>();
                    m.put("ip", ip);
                    m.put("ports", ports);
                    m.put("family", es.getAddressType());
                    m.put("ready", c == null || !Boolean.FALSE.equals(c.getReady()));
                    m.put("serving", c == null || c.getServing() == null || c.getServing());
                    m.put("terminating", c != null && Boolean.TRUE.equals(c.getTerminating()));
                    if (ep.getTargetRef() != null) { m.put("targetKind", ep.getTargetRef().getKind()); m.put("target", ep.getTargetRef().getName());
                        m.put("targetNs", Objects.requireNonNullElse(ep.getTargetRef().getNamespace(), ns)); }
                    if (ep.getNodeName() != null) m.put("node", ep.getNodeName());
                    if (ep.getZone() != null) m.put("zone", ep.getZone());
                    out.add(m);
                }
            }
        }
        out.sort(Comparator.comparing((Map<String, Object> m) -> !(Boolean) m.get("ready")).thenComparing(m -> String.valueOf(m.get("target"))));
        return out;
    }

    // ------------------------------------------------------------------ kind-specific tables (rules, routes, listeners…)

    /** {title, columns, rows}: rendered as a table in the panel */
    private static Map<String, Object> table(String title, List<String> columns, List<List<String>> rows) {
        return Map.of("title", title, "columns", columns, "rows", rows);
    }

    @SuppressWarnings("unchecked")
    private List<Map<String, Object>> tables(HasMetadata o) {
        List<Map<String, Object>> out = new ArrayList<>();
        switch (o) {
            case io.fabric8.kubernetes.api.model.admissionregistration.v1.ValidatingWebhookConfiguration v ->
                    out.add(webhookTable(nz(v.getWebhooks()).stream().map(w -> webhookRow(w.getName(), w.getRules(), w.getFailurePolicy(),
                            w.getNamespaceSelector(), w.getObjectSelector(), w.getClientConfig(), w.getTimeoutSeconds())).toList()));
            case io.fabric8.kubernetes.api.model.admissionregistration.v1.MutatingWebhookConfiguration m ->
                    out.add(webhookTable(nz(m.getWebhooks()).stream().map(w -> webhookRow(w.getName(), w.getRules(), w.getFailurePolicy(),
                            w.getNamespaceSelector(), w.getObjectSelector(), w.getClientConfig(), w.getTimeoutSeconds())).toList()));
            case io.fabric8.kubernetes.api.model.admissionregistration.v1.ValidatingAdmissionPolicy p -> {
                out.add(table("Validations", List.of("Biểu thức CEL", "Thông báo khi vi phạm"),
                        nz(p.getSpec().getValidations()).stream().map(v -> List.of(v.getExpression(),
                                Objects.requireNonNullElse(v.getMessage(), Objects.requireNonNullElse(v.getMessageExpression(), "—")))).toList()));
                if (p.getSpec().getMatchConstraints() != null)
                    out.add(table("Áp dụng cho", List.of("Thao tác", "Tài nguyên"),
                            nz(p.getSpec().getMatchConstraints().getResourceRules()).stream().map(r -> List.of(
                                    String.join(", ", nz(r.getOperations())), resources(r.getApiGroups(), r.getResources()))).toList()));
            }
            case LimitRange lr -> {
                List<List<String>> rows = new ArrayList<>();
                for (LimitRangeItem it : nz(lr.getSpec().getLimits())) {
                    Set<String> res = new TreeSet<>();
                    for (Map<String, Quantity> q : Arrays.asList(it.getMin(), it.getMax(), it.getDefaultRequest(), it.getDefault())) if (q != null) res.addAll(q.keySet());
                    for (String r : res) rows.add(List.of(it.getType() + " · " + r, q(it.getMin(), r), q(it.getMax(), r), q(it.getDefaultRequest(), r), q(it.getDefault(), r)));
                }
                out.add(table("Giới hạn", List.of("Loại · tài nguyên", "Min", "Max", "Request mặc định", "Limit mặc định"), rows));
            }
            case GenericKubernetesResource r -> {
                Map<String, Object> spec = r.getAdditionalProperties().get("spec") instanceof Map<?, ?> s ? (Map<String, Object>) s : Map.of();
                Map<String, Object> status = r.getAdditionalProperties().get("status") instanceof Map<?, ?> s ? (Map<String, Object>) s : Map.of();
                switch (Objects.requireNonNullElse(r.getKind(), "")) {
                    case "Gateway" -> {
                        Map<String, Object> attached = new HashMap<>();
                        maps(status.get("listeners")).forEach(l -> attached.put(String.valueOf(l.get("name")), l.get("attachedRoutes")));
                        out.add(table("Listeners", List.of("Tên", "Giao thức", "Cổng", "Hostname", "TLS", "Route gắn vào"),
                                maps(spec.get("listeners")).stream().map(l -> List.of(s(l.get("name")), s(l.get("protocol")), s(l.get("port")),
                                        s(l.get("hostname")), l.get("tls") instanceof Map<?, ?> t ? s(t.get("mode")) : "—",
                                        s(attached.get(String.valueOf(l.get("name")))))).toList()));
                    }
                    case "HTTPRoute", "GRPCRoute", "TCPRoute", "TLSRoute", "UDPRoute" -> {
                        List<List<String>> rows = new ArrayList<>();
                        for (Map<String, Object> rule : maps(spec.get("rules"))) {
                            List<String> matches = maps(rule.get("matches")).stream().map(DetailsService::routeMatch).toList();
                            String backends = maps(rule.get("backendRefs")).stream().map(b -> s(b.get("name")) + (b.get("port") != null ? ":" + b.get("port") : "")
                                    + (b.get("weight") != null ? " (weight " + b.get("weight") + ")" : "")).reduce((a, b) -> a + ", " + b).orElse("—");
                            String filters = maps(rule.get("filters")).stream().map(f -> s(f.get("type"))).reduce((a, b) -> a + ", " + b).orElse("—");
                            rows.add(List.of(matches.isEmpty() ? "mọi request" : String.join(" · ", matches), backends, filters));
                        }
                        out.add(table("Định tuyến", List.of("Khớp", "Backend", "Filter"), rows));
                        out.add(table("Gắn vào", List.of("Gateway", "Section"), maps(spec.get("parentRefs")).stream().map(p ->
                                List.of((p.get("namespace") != null ? p.get("namespace") + "/" : "") + s(p.get("name")), s(p.get("sectionName")))).toList()));
                    }
                    case "IngressRoute", "IngressRouteTCP", "IngressRouteUDP" -> out.add(table("Định tuyến", List.of("Khớp", "Service", "Middleware"),
                            maps(spec.get("routes")).stream().map(rt -> List.of(Objects.requireNonNullElse(s(rt.get("match")), "mọi request"),
                                    maps(rt.get("services")).stream().map(x -> s(x.get("name")) + (x.get("port") != null ? ":" + x.get("port") : "")).reduce((a, b) -> a + ", " + b).orElse("—"),
                                    maps(rt.get("middlewares")).stream().map(x -> s(x.get("name"))).reduce((a, b) -> a + ", " + b).orElse("—"))).toList()));
                    default -> { }
                }
            }
            default -> { }
        }
        return out.stream().filter(t -> !((List<?>) t.get("rows")).isEmpty()).toList();
    }

    private static Map<String, Object> webhookTable(List<List<String>> rows) {
        return table("Webhooks", List.of("Tên", "Chặn khi", "Phạm vi", "Gọi tới", "Failure policy"), rows);
    }

    private static List<String> webhookRow(String name, List<io.fabric8.kubernetes.api.model.admissionregistration.v1.RuleWithOperations> rules,
                                           String failure, LabelSelector nsSel, LabelSelector objSel,
                                           io.fabric8.kubernetes.api.model.admissionregistration.v1.WebhookClientConfig cc, Integer timeout) {
        String when = nz(rules).stream().map(r -> String.join("/", nz(r.getOperations())) + " " + resources(r.getApiGroups(), r.getResources()))
                .reduce((a, b) -> a + "; " + b).orElse("—");
        String scope = selector("namespace", nsSel) + (objSel != null && (objSel.getMatchLabels() != null || objSel.getMatchExpressions() != null) ? "; " + selector("object", objSel) : "");
        String target = cc == null ? "—" : cc.getService() != null ? "svc " + cc.getService().getNamespace() + "/" + cc.getService().getName()
                + (cc.getService().getPort() != null ? ":" + cc.getService().getPort() : "") + Objects.requireNonNullElse(cc.getService().getPath(), "") : String.valueOf(cc.getUrl());
        return List.of(name, when, scope, target, Objects.requireNonNullElse(failure, "Fail") + (timeout != null ? " · timeout " + timeout + "s" : ""));
    }

    private static String selector(String what, LabelSelector sel) {
        if (sel == null || (nz(sel.getMatchLabels()).isEmpty() && nz(sel.getMatchExpressions()).isEmpty())) return "mọi " + what;
        List<String> parts = new ArrayList<>();
        nz(sel.getMatchLabels()).forEach((k, v) -> parts.add(k + "=" + v));
        nz(sel.getMatchExpressions()).forEach(e -> parts.add(e.getKey() + " " + e.getOperator() + (e.getValues() == null ? "" : " (" + String.join(",", e.getValues()) + ")")));
        return what + " " + String.join(", ", parts);
    }

    private static String resources(List<String> groups, List<String> res) {
        String g = nz(groups).stream().map(x -> x.isEmpty() ? "core" : x).reduce((a, b) -> a + "," + b).orElse("*");
        return String.join(", ", nz(res)) + " (" + g + ")";
    }

    private static String routeMatch(Map<String, Object> m) {
        List<String> p = new ArrayList<>();
        if (m.get("path") instanceof Map<?, ?> path) p.add(s(path.get("type")) + " " + s(path.get("value")));
        if (m.get("method") != null) p.add(s(m.get("method")));
        if (m.get("headers") instanceof List<?> h) p.add(h.size() + " header");
        if (m.get("queryParams") instanceof List<?> q) p.add(q.size() + " query");
        return String.join(" ", p);
    }

    private static String q(Map<String, Quantity> m, String k) { return m == null || m.get(k) == null ? "—" : m.get(k).toString(); }

    private static String s(Object o) { return o == null ? "—" : String.valueOf(o); }

    @SuppressWarnings("unchecked")
    private static List<Map<String, Object>> maps(Object o) {
        if (!(o instanceof List<?> l)) return List.of();
        return l.stream().filter(x -> x instanceof Map).map(x -> (Map<String, Object>) x).toList();
    }

    /** route status is per parent (status.parents[].conditions): flatten, naming the Gateway in the reason */
    @SuppressWarnings("unchecked")
    private static List<Map<String, Object>> parentConditions(GenericKubernetesResource r) {
        if (!(r.getAdditionalProperties().get("status") instanceof Map<?, ?> st)) return List.of();
        List<Map<String, Object>> out = new ArrayList<>();
        for (Map<String, Object> p : maps(st.get("parents"))) {
            String gw = p.get("parentRef") instanceof Map<?, ?> ref ? String.valueOf(ref.get("name")) : "?";
            for (Map<String, Object> c : maps(p.get("conditions"))) {
                Map<String, Object> v = new LinkedHashMap<>();
                for (String k : List.of("type", "status", "reason", "message", "lastTransitionTime")) if (c.get(k) != null) v.put(k, c.get(k));
                v.put("reason", "Gateway " + gw + (c.get("reason") != null ? " · " + c.get("reason") : ""));
                out.add(v);
            }
        }
        return out;
    }

    private static <T> List<T> nz(List<T> l) { return l == null ? List.of() : l; }
    private static <K, V> Map<K, V> nz(Map<K, V> m) { return m == null ? Map.of() : m; }
}
