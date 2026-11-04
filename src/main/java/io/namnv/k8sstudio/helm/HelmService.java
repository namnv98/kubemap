package io.namnv.k8sstudio.helm;

import io.fabric8.kubernetes.api.model.ConfigMap;
import io.fabric8.kubernetes.api.model.HasMetadata;
import io.fabric8.kubernetes.api.model.Secret;
import io.fabric8.kubernetes.client.utils.KubernetesSerialization;
import io.namnv.k8sstudio.graph.ClusterCache;
import org.springframework.stereotype.Service;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;
import java.util.zip.GZIPInputStream;

/**
 * Read-only view of Helm 3 releases, decoded from Helm's own storage in the informer cache — no helm binary,
 * no extra API calls. Helm keeps one object per revision: a Secret of type helm.sh/release.v1 (default driver) or a
 * ConfigMap labelled owner=helm, holding base64(gzip(release JSON)).
 * Values can carry passwords, so they are only returned on request, and Secret objects in a rendered manifest are masked.
 */
@Service
public class HelmService {

    private static final String SECRET_TYPE = "helm.sh/release.v1";
    /** kinds that have no namespace (a manifest object of any other kind without one lands in the release namespace) */
    private static final Set<String> CLUSTER_SCOPED = Set.of("Namespace", "Node", "PersistentVolume", "StorageClass", "IngressClass", "ClusterRole",
            "ClusterRoleBinding", "CustomResourceDefinition", "PriorityClass", "RuntimeClass", "CSIDriver", "CSINode", "VolumeAttachment",
            "MutatingWebhookConfiguration", "ValidatingWebhookConfiguration", "ValidatingAdmissionPolicy", "ValidatingAdmissionPolicyBinding",
            "APIService", "FlowSchema", "PriorityLevelConfiguration", "GatewayClass", "ClusterIssuer");

    private final ClusterCache cache;
    private final KubernetesSerialization ser;
    /** decoded releases by storage object uid + resourceVersion */
    private final Map<String, Map<String, Object>> decoded = new ConcurrentHashMap<>();

    public HelmService(ClusterCache cache) {
        this.cache = cache;
        this.ser = cache.client().getKubernetesSerialization();
    }

    /** one stored revision */
    private record Stored(HasMetadata obj, String ns, String name, int version, String status, String data, boolean secret) {}

    public record Summary(String namespace, String name, int revision, int revisions, String status, String chart, String chartVersion,
                          String appVersion, String updated, String description, String storage) {}

    public record Revision(int revision, String status, String updated, String chart, String chartVersion, String appVersion, String description) {}

    public record Resource(String kind, String apiVersion, String namespace, String name, String id, Boolean exists) {}

    public record Detail(Summary summary, String firstDeployed, String chartDescription, String chartHome, String icon, String notes,
                         String manifest, List<Resource> resources, List<Revision> history, boolean hasUserValues) {}

    // ------------------------------------------------------------------ listing

    private List<Stored> stored(String ns) {
        List<Stored> out = new ArrayList<>();
        for (Secret s : cache.secretsIn(ns)) {
            if (!SECRET_TYPE.equals(s.getType()) || s.getData() == null || !s.getData().containsKey("release")) continue;
            Map<String, String> l = nzm(s.getMetadata().getLabels());
            if (l.get("name") == null) continue;
            out.add(new Stored(s, s.getMetadata().getNamespace(), l.get("name"), parseInt(l.get("version")), l.getOrDefault("status", ""), s.getData().get("release"), true));
        }
        for (ConfigMap c : cache.configMapsIn(ns)) {
            Map<String, String> l = nzm(c.getMetadata().getLabels());
            if (!"helm".equals(l.get("owner")) || l.get("name") == null || c.getData() == null || !c.getData().containsKey("release")) continue;
            out.add(new Stored(c, c.getMetadata().getNamespace(), l.get("name"), parseInt(l.get("version")), l.getOrDefault("status", ""), c.getData().get("release"), false));
        }
        return out;
    }

    /** latest revision of every release (namespace null = all) */
    public List<Summary> list(String ns) {
        Map<String, List<Stored>> byRelease = new TreeMap<>();
        for (Stored s : stored(ns)) byRelease.computeIfAbsent(s.ns() + "/" + s.name(), k -> new ArrayList<>()).add(s);
        List<Summary> out = new ArrayList<>();
        for (List<Stored> revs : byRelease.values()) {
            Stored latest = revs.stream().max(Comparator.comparingInt(Stored::version)).orElseThrow();
            out.add(summary(latest, revs.size()));
        }
        return out;
    }

    public Optional<Detail> detail(String ns, String name) {
        List<Stored> revs = stored(ns).stream().filter(s -> s.name().equals(name) && s.ns().equals(ns))
                .sorted(Comparator.comparingInt(Stored::version).reversed()).toList();
        if (revs.isEmpty()) return Optional.empty();
        Stored latest = revs.get(0);
        Map<String, Object> rel = decode(latest);
        Map<String, Object> info = map(rel.get("info")), meta = map(map(rel.get("chart")).get("metadata"));
        List<Revision> history = new ArrayList<>();
        for (Stored s : revs) {
            Map<String, Object> r = decode(s), i = map(r.get("info")), m = map(map(r.get("chart")).get("metadata"));
            history.add(new Revision(s.version(), str(i.get("status"), s.status()), str(i.get("last_deployed"), ""), str(m.get("name"), ""),
                    str(m.get("version"), ""), str(m.get("appVersion"), ""), str(i.get("description"), "")));
        }
        String manifest = str(rel.get("manifest"), "");
        boolean hasUser = !map(rel.get("config")).isEmpty();
        return Optional.of(new Detail(summary(latest, revs.size()), str(info.get("first_deployed"), ""), str(meta.get("description"), ""),
                str(meta.get("home"), ""), str(meta.get("icon"), ""), str(info.get("notes"), ""), maskSecrets(manifest),
                resources(manifest, ns), history, hasUser));
    }

    /** rendered manifest of one revision (0 = latest), Secret values masked */
    public Optional<String> manifest(String ns, String name, int revision) {
        return stored(ns).stream().filter(x -> x.name().equals(name) && x.ns().equals(ns))
                .filter(x -> revision <= 0 || x.version() == revision).max(Comparator.comparingInt(Stored::version))
                .map(s -> maskSecrets(str(decode(s).get("manifest"), "")));
    }

    /** user-supplied values (`helm get values`) or, with all=true, chart defaults merged with them (`helm get values --all`) */
    public Optional<String> values(String ns, String name, int revision, boolean all) {
        Optional<Stored> s = stored(ns).stream().filter(x -> x.name().equals(name) && x.ns().equals(ns))
                .filter(x -> revision <= 0 || x.version() == revision).max(Comparator.comparingInt(Stored::version));
        if (s.isEmpty()) return Optional.empty();
        Map<String, Object> rel = decode(s.get());
        Map<String, Object> user = map(rel.get("config"));
        Map<String, Object> v = all ? merge(map(map(rel.get("chart")).get("values")), user) : user;
        return Optional.of(v.isEmpty() ? "{}\n" : stripDocStart(ser.asYaml(v)));
    }

    private Summary summary(Stored s, int revisions) {
        Map<String, Object> rel = decode(s), info = map(rel.get("info")), meta = map(map(rel.get("chart")).get("metadata"));
        return new Summary(s.ns(), s.name(), s.version(), revisions, str(info.get("status"), s.status()), str(meta.get("name"), ""),
                str(meta.get("version"), ""), str(meta.get("appVersion"), ""), str(info.get("last_deployed"), ""), str(info.get("description"), ""),
                s.secret() ? "Secret" : "ConfigMap");
    }

    // ------------------------------------------------------------------ manifest

    private List<Resource> resources(String manifest, String releaseNs) {
        List<Resource> out = new ArrayList<>();
        for (String doc : docs(manifest)) {
            Map<String, Object> o;
            try { o = map(ser.unmarshal(doc, Map.class)); } catch (RuntimeException e) { continue; }
            String kind = str(o.get("kind"), ""), apiVersion = str(o.get("apiVersion"), "");
            Map<String, Object> md = map(o.get("metadata"));
            String name = str(md.get("name"), "");
            if (kind.isEmpty() || name.isEmpty()) continue;
            String ns = CLUSTER_SCOPED.contains(kind) ? null : str(md.get("namespace"), releaseNs);
            Boolean exists = cache.mirrors(kind) ? cache.find(kind, ns, name).isPresent() : null;
            out.add(new Resource(kind, apiVersion, ns, name, kind + "/" + (ns == null ? "" : ns) + "/" + name, exists));
        }
        return out;
    }

    private static List<String> docs(String manifest) {
        List<String> out = new ArrayList<>();
        for (String d : manifest.split("(?m)^---\\s*$")) if (d.lines().anyMatch(l -> !l.isBlank() && !l.stripLeading().startsWith("#"))) out.add(d);
        return out;
    }

    /** Secret objects in the rendered manifest keep their keys, never their values */
    private String maskSecrets(String manifest) {
        StringBuilder out = new StringBuilder();
        String[] parts = manifest.split("(?m)^---\\s*$", -1);
        for (int i = 0; i < parts.length; i++) {
            String d = parts[i];
            if (i > 0) out.append("---");
            Map<String, Object> o = null;
            try { if (d.lines().anyMatch(l -> !l.isBlank() && !l.stripLeading().startsWith("#"))) o = map(ser.unmarshal(d, Map.class)); } catch (RuntimeException ignored) {}
            if (o == null || !"Secret".equals(o.get("kind"))) { out.append(d); continue; }
            StringBuilder head = new StringBuilder("\n");
            d.lines().filter(l -> l.startsWith("#")).forEach(l -> head.append(l).append('\n'));
            for (String key : List.of("data", "stringData")) {
                Map<String, Object> m = map(o.get(key));
                if (m.isEmpty()) continue;
                Map<String, Object> masked = new LinkedHashMap<>();
                m.forEach((k, v) -> masked.put(k, "<ẩn: " + (v == null ? 0 : key.equals("data") ? decodedLength(v.toString()) : v.toString().getBytes(StandardCharsets.UTF_8).length) + " bytes>"));
                o.put(key, masked);
            }
            out.append(head).append(stripDocStart(ser.asYaml(o)));
        }
        return out.toString();
    }

    private static int decodedLength(String b64) {
        try { return Base64.getDecoder().decode(b64.trim()).length; } catch (IllegalArgumentException e) { return b64.length(); }
    }

    // ------------------------------------------------------------------ decoding

    private Map<String, Object> decode(Stored s) {
        String key = s.obj().getMetadata().getUid() + "@" + s.obj().getMetadata().getResourceVersion();
        if (decoded.size() > 2000) decoded.clear(); // old revisions' resourceVersions pile up otherwise
        return decoded.computeIfAbsent(key, k -> {
            try {
                byte[] b = s.secret() ? Base64.getDecoder().decode(s.data()) : s.data().getBytes(StandardCharsets.UTF_8); // Secret data is base64 once more
                b = Base64.getDecoder().decode(new String(b, StandardCharsets.US_ASCII).trim());
                if (b.length > 2 && (b[0] & 0xff) == 0x1f && (b[1] & 0xff) == 0x8b)
                    try (var in = new GZIPInputStream(new ByteArrayInputStream(b))) { b = in.readAllBytes(); }
                return map(ser.unmarshal(new String(b, StandardCharsets.UTF_8), Map.class));
            } catch (IOException | RuntimeException e) {
                return Map.of("info", Map.of("status", s.status(), "description", "không giải mã được release: " + e.getMessage()));
            }
        });
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> merge(Map<String, Object> base, Map<String, Object> over) {
        Map<String, Object> out = new LinkedHashMap<>(base);
        over.forEach((k, v) -> {
            Object b = out.get(k);
            out.put(k, b instanceof Map<?, ?> bm && v instanceof Map<?, ?> vm ? merge((Map<String, Object>) bm, (Map<String, Object>) vm) : v);
        });
        return out;
    }

    private static String stripDocStart(String yaml) { return yaml.startsWith("---\n") ? yaml.substring(4) : yaml; }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> map(Object o) { return o instanceof Map<?, ?> m ? (Map<String, Object>) m : Map.of(); }
    private static String str(Object o, String d) { return o == null || o.toString().isEmpty() ? d : o.toString(); }
    private static int parseInt(String s) { try { return Integer.parseInt(s); } catch (RuntimeException e) { return 0; } }
    private static <K, V> Map<K, V> nzm(Map<K, V> m) { return m == null ? Map.of() : m; }
}
