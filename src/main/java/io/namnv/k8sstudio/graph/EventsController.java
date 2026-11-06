package io.namnv.k8sstudio.graph;

import io.fabric8.kubernetes.api.model.Event;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.time.Instant;
import java.util.*;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Collectors;

/**
 * Events for the timeline view, straight from the informer cache (the API server keeps them ~1h by default).
 * Times are epoch millis: first / last occurrence (an aggregated event is one entry with count > 1).
 */
@RestController
public class EventsController {

    private final ClusterCache cache;
    private final GraphSnapshots snapshots;

    public EventsController(ClusterCache cache, GraphSnapshots snapshots) {
        this.cache = cache;
        this.snapshots = snapshots;
    }

    public record Item(String uid, String type, String reason, String message, long first, long last, int count,
                       String source, String fieldPath, String kind, String namespace, String name, String objectId) {}

    /** namespace "*" or empty = all namespaces; cluster-scoped objects (Node…) are always included */
    @GetMapping("/api/events")
    public Map<String, Object> events(@RequestParam(defaultValue = "*") String namespace) {
        return Map.of("now", System.currentTimeMillis(), "events", items(namespace));
    }

    private List<Item> items(String namespace) {
        boolean all = namespace.isBlank() || "*".equals(namespace);
        List<Item> out = new ArrayList<>();
        for (Event e : cache.events.getStore().list()) {
            var o = e.getInvolvedObject();
            if (o == null || o.getKind() == null || o.getName() == null) continue;
            String ons = o.getNamespace() == null || o.getNamespace().isEmpty() ? null : o.getNamespace();
            if (!all && ons != null && !namespace.equals(ons)) continue;
            String eventTime = e.getEventTime() == null ? null : e.getEventTime().getTime();
            long first = millis(eventTime != null ? eventTime : e.getFirstTimestamp());
            long last = millis(e.getSeries() != null && e.getSeries().getLastObservedTime() != null ? e.getSeries().getLastObservedTime().getTime()
                    : e.getLastTimestamp() != null ? e.getLastTimestamp() : eventTime != null ? eventTime : e.getFirstTimestamp());
            if (first == 0) first = last;
            if (last == 0) last = first;
            if (first == 0) first = last = millis(e.getMetadata().getCreationTimestamp());
            int count = e.getSeries() != null && e.getSeries().getCount() != null ? e.getSeries().getCount() : e.getCount() != null ? e.getCount() : 1;
            String source = e.getSource() != null && e.getSource().getComponent() != null && !e.getSource().getComponent().isEmpty()
                    ? e.getSource().getComponent() : Objects.requireNonNullElse(e.getReportingComponent(), "");
            out.add(new Item(e.getMetadata().getUid(), Objects.requireNonNullElse(e.getType(), "Normal"), Objects.requireNonNullElse(e.getReason(), ""),
                    Objects.requireNonNullElse(e.getMessage(), "").strip(), Math.min(first, last), Math.max(first, last), Math.max(1, count),
                    source, o.getFieldPath(), o.getKind(), ons, o.getName(), o.getKind() + "/" + (ons == null ? "" : ons) + "/" + o.getName()));
        }
        out.sort(Comparator.comparingLong(Item::last));
        return out;
    }

    // ================================================================== timeline, computed and paged on the server

    /** still happening: seen in the last two minutes (and repeating, or a warning) */
    private static boolean live(Item e, long now) { return now - e.last() < 120_000 && (e.count() > 1 || "Warning".equals(e.type())); }

    private static final Pattern NAMEISH = Pattern.compile("\\b[a-z0-9]+(-[a-z0-9]+){1,}-[a-z0-9]{4,10}\\b");
    /** "0/3 nodes are available: 3 Too many pods" from 700 pods folds into one message: generated names and numbers out */
    static String msgKey(String m) {
        String k = NAMEISH.matcher(m == null ? "" : m).replaceAll("‹tên›").replaceAll("\\d+", "N");
        return k.length() > 220 ? k.substring(0, 220) : k;
    }

    /**
     * The object an event belongs under: up the "owns" edges (Pod → ReplicaSet → Deployment, Pod → Job → CronJob);
     * objects already gone (finished CronJob pods…) by name. Same rules as the browser had (timeline.js tlRootOf).
     */
    static String rootOf(String id, String kind, String ns, String name, Map<String, String> owners, Set<String> known) {
        String cur = id;
        for (int i = 0; i < 6 && owners.containsKey(cur); i++) cur = owners.get(cur);
        if (!cur.equals(id)) return cur;
        String n = ns == null ? "" : ns;
        java.util.function.BiPredicate<String, String> has = (k, x) -> known.contains(k + "/" + n + "/" + x);
        if ("Pod".equals(kind)) {
            String parent = strip(name, "-[a-z0-9]{5}$");
            if (parent != null) {
                if (has.test("Job", parent)) return rootOf("Job/" + n + "/" + parent, "Job", ns, parent, owners, known);
                if (has.test("ReplicaSet", parent)) return rootOf("ReplicaSet/" + n + "/" + parent, "ReplicaSet", ns, parent, owners, known);
                String cj = strip(parent, "-\\d{6,}$"); if (cj != null && has.test("CronJob", cj)) return "CronJob/" + n + "/" + cj;
                String dep = strip(parent, "-[a-z0-9]{6,10}$"); if (dep != null && has.test("Deployment", dep)) return "Deployment/" + n + "/" + dep;
            }
            String sts = strip(name, "-\\d+$"); if (sts != null && has.test("StatefulSet", sts)) return "StatefulSet/" + n + "/" + sts;
        }
        if ("Job".equals(kind)) { String cj = strip(name, "-\\d{6,}$"); if (cj != null && has.test("CronJob", cj)) return "CronJob/" + n + "/" + cj; }
        if ("ReplicaSet".equals(kind)) { String dep = strip(name, "-[a-z0-9]{6,10}$"); if (dep != null && has.test("Deployment", dep)) return "Deployment/" + n + "/" + dep; }
        return id;
    }

    private static String strip(String s, String re) {
        Matcher m = Pattern.compile(re).matcher(s);
        return m.find() ? s.substring(0, m.start()) : null;
    }

    private static final int OBJS_PER_GROUP = 20;

    @GetMapping("/api/events/timeline")
    public Map<String, Object> timeline(@RequestParam(defaultValue = "*") String namespace, @RequestParam(required = false) String nss,
                                        @RequestParam(defaultValue = "3600") long range, @RequestParam(defaultValue = "all") String type,
                                        @RequestParam(defaultValue = "") String reason, @RequestParam(defaultValue = "") String q,
                                        @RequestParam(defaultValue = "0") int page, @RequestParam(defaultValue = "40") int size) {
        long now = System.currentTimeMillis();
        size = Math.max(1, Math.min(200, size));
        Set<String> nsSet = nss == null || nss.isBlank() ? null : new HashSet<>(Arrays.asList(nss.split(",")));
        List<Item> every = items(namespace).stream().filter(e -> nsSet == null || e.namespace() == null || nsSet.contains(e.namespace())).toList();
        long start = range > 0 ? now - range * 1000 : Math.min(now - 15 * 60_000, every.stream().mapToLong(Item::first).min().orElse(now));
        String ql = q.toLowerCase(Locale.ROOT);
        List<Item> all = every.stream().filter(e -> e.last() >= start && ("all".equals(type) || type.equals(e.type()))
                && (ql.isEmpty() || java.util.stream.Stream.of(e.name(), e.kind(), e.namespace(), e.reason(), e.message())
                .anyMatch(x -> x != null && x.toLowerCase(Locale.ROOT).contains(ql)))).toList();
        List<Item> evs = reason.isEmpty() ? all : all.stream().filter(e -> reason.equals(e.reason())).toList();

        // warning reasons (over every reason: the chips are how one picks a reason), with their most frequent messages
        Map<String, Map<String, Object>> wr = new HashMap<>();
        Map<String, Map<String, long[]>> msgN = new HashMap<>();
        Map<String, Map<String, String>> msgSample = new HashMap<>();
        for (Item e : all) {
            if (!"Warning".equals(e.type())) continue;
            Map<String, Object> r = wr.computeIfAbsent(e.reason(), k -> new HashMap<>(Map.of("reason", k, "n", 0L, "objs", new HashSet<String>(), "live", false)));
            r.put("n", (long) r.get("n") + e.count());
            ((Set<String>) r.get("objs")).add(e.objectId());
            if (live(e, now)) r.put("live", true);
            String mk = msgKey(e.message());
            msgN.computeIfAbsent(e.reason(), k -> new HashMap<>()).computeIfAbsent(mk, k -> new long[1])[0] += e.count();
            msgSample.computeIfAbsent(e.reason(), k -> new HashMap<>()).putIfAbsent(mk, e.message());
        }
        List<Map<String, Object>> reasons = wr.values().stream().sorted((a, b) -> Long.compare((long) b.get("n"), (long) a.get("n"))).limit(8).map(r -> {
            String rs = (String) r.get("reason");
            List<Map<String, Object>> msgs = msgN.get(rs).entrySet().stream().sorted((a, b) -> Long.compare(b.getValue()[0], a.getValue()[0])).limit(3)
                    .map(m -> Map.<String, Object>of("n", m.getValue()[0], "sample", msgSample.get(rs).get(m.getKey()))).toList();
            return Map.<String, Object>of("reason", rs, "n", r.get("n"), "objs", ((Set<?>) r.get("objs")).size(), "live", r.get("live"), "msgs", msgs);
        }).toList();

        // rate: occurrences per bucket; a repeated event's count spread evenly between its first and last time
        int bk = 60;
        long span = Math.max(1, now - start);
        double bucket = span / (double) bk;
        double[] normal = new double[bk], warn = new double[bk];
        for (Item e : evs) {
            long f = Math.max(e.first(), start);
            int a = (int) Math.max(0, Math.floor((f - start) / bucket)), b = (int) Math.min(bk - 1, Math.floor((e.last() - start) / bucket));
            double per = e.count() / Math.max(1.0, Math.floor((e.last() - e.first()) / bucket) + 1);
            for (int i = a; i <= b; i++) ("Warning".equals(e.type()) ? warn : normal)[i] += per;
        }

        // groups: one per top owner, its objects inside, newest / worst first; only the asked page goes out
        Graph g = snapshots.get(namespace);
        Map<String, String> owners = new HashMap<>();
        g.edges().forEach(e -> { if ("owns".equals(e.type())) owners.put(e.target(), e.source()); });
        Set<String> inGraph = g.nodes().stream().map(Graph.Node::id).collect(Collectors.toSet());
        Set<String> known = new HashSet<>(inGraph);
        evs.forEach(e -> known.add(e.objectId()));
        Map<String, Map<String, List<Item>>> groups = new LinkedHashMap<>(); // root → object id → events
        Map<String, Item> objRef = new HashMap<>();
        for (Item e : evs) {
            String root = rootOf(e.objectId(), e.kind(), e.namespace(), e.name(), owners, known);
            groups.computeIfAbsent(root, k -> new LinkedHashMap<>()).computeIfAbsent(e.objectId(), k -> new ArrayList<>()).add(e);
            objRef.putIfAbsent(e.objectId(), e);
        }
        record G(String key, Map<String, List<Item>> objs, long warn, boolean live, long last) {}
        List<G> list = groups.entrySet().stream().map(en -> {
            List<Item> ev = en.getValue().values().stream().flatMap(List::stream).toList();
            return new G(en.getKey(), en.getValue(), ev.stream().filter(e -> "Warning".equals(e.type())).mapToLong(Item::count).sum(),
                    ev.stream().anyMatch(e -> "Warning".equals(e.type()) && live(e, now)), ev.stream().mapToLong(Item::last).max().orElse(0));
        }).sorted(Comparator.comparing((G x) -> !x.live).thenComparing(x -> x.warn == 0).thenComparing(x -> -x.last)).toList();
        int pages = Math.max(1, (list.size() + size - 1) / size);
        page = Math.max(0, Math.min(page, pages - 1));
        List<Map<String, Object>> rows = list.subList(Math.min(list.size(), page * size), Math.min(list.size(), (page + 1) * size)).stream().map(x -> {
            String[] p = x.key.split("/", 3);
            List<Map<String, Object>> objs = x.objs.entrySet().stream()
                    .sorted((a, b) -> Long.compare(b.getValue().stream().mapToLong(Item::last).max().orElse(0), a.getValue().stream().mapToLong(Item::last).max().orElse(0)))
                    .map(o -> { Item r = objRef.get(o.getKey());
                        return Map.<String, Object>of("id", o.getKey(), "kind", r.kind(), "ns", Objects.requireNonNullElse(r.namespace(), ""), "name", r.name(),
                                "gone", !inGraph.contains(o.getKey()), "evs", o.getValue()); }).toList();
            // the group's own lane: its events merged per (type, reason) — a few spans instead of one per pod
            Map<String, Item> merged = new LinkedHashMap<>();
            x.objs.values().stream().flatMap(List::stream).forEach(e -> merged.merge(e.type() + "|" + e.reason(), e, (a, b) -> new Item(a.uid(), a.type(), a.reason(),
                    b.last() > a.last() ? b.message() : a.message(), Math.min(a.first(), b.first()), Math.max(a.last(), b.last()), a.count() + b.count(),
                    a.source(), null, a.kind(), a.namespace(), a.name(), a.objectId())));
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("key", x.key); m.put("kind", p[0]); m.put("ns", p.length > 1 ? p[1] : ""); m.put("name", p.length > 2 ? p[2] : x.key);
            m.put("warn", x.warn); m.put("live", x.live); m.put("last", x.last);
            m.put("lane", new ArrayList<>(merged.values()));
            m.put("objsTotal", objs.size());
            m.put("objs", objs.subList(0, Math.min(objs.size(), OBJS_PER_GROUP)));
            return m;
        }).toList();

        Map<String, Object> out = new LinkedHashMap<>();
        out.put("now", now);
        out.put("start", start);
        out.put("events", evs.size());
        out.put("occurrences", evs.stream().mapToLong(Item::count).sum());
        out.put("warnGroups", list.stream().filter(x -> x.warn > 0).count());
        out.put("groupsTotal", list.size());
        out.put("page", page);
        out.put("pages", pages);
        out.put("reasons", reasons);
        out.put("warnReasons", wr.size());
        out.put("rate", Map.of("normal", normal, "warn", warn, "bucketMs", bucket));
        out.put("groups", rows);
        return out;
    }

    private static long millis(String iso) {
        if (iso == null || iso.isEmpty()) return 0;
        try { return Instant.parse(iso).toEpochMilli(); } catch (RuntimeException ex) { return 0; }
    }
}
