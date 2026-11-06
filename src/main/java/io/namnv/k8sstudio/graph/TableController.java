package io.namnv.k8sstudio.graph;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.text.Normalizer;
import java.time.Instant;
import java.util.*;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Collectors;
import java.util.stream.Stream;

/**
 * Server-side table for the grid view: filter, sort and page one kind of object, from the cached graph
 * ({@link GraphSnapshots}), so the browser only gets the rows of the page it shows.
 * Same rules as the former in-browser table (grid.js): the search language
 * ({@code word -word "two words" col:val col=val col!=val key=val restarts>3 cpu>100m age<1h}), the health / namespace
 * filters, multi-column sort with natural order, severity for status, newest first for age, empty cells last.
 */
@RestController
public class TableController {

    private final GraphSnapshots snapshots;
    private final ObjectMapper json = new ObjectMapper();

    public TableController(GraphSnapshots snapshots) {
        this.snapshots = snapshots;
    }

    // ------------------------------------------------------------------ common filters

    /** what every view of the table shares: namespace(s) picked in the top bar, top-bar search and health chip */
    private record Scope(String namespace, Set<String> nss, String gq, String gh) {}

    private List<Graph.Node> scoped(Graph g, Scope s) {
        boolean all = "*".equals(s.namespace) || s.namespace.isBlank();
        Set<String> runsOn = all ? Set.of() : g.edges().stream().filter(e -> "runs-on".equals(e.type())).map(Graph.Edge::target).collect(Collectors.toSet());
        String q = s.gq.toLowerCase(Locale.ROOT);
        List<Graph.Node> out = new ArrayList<>();
        for (Graph.Node n : g.nodes()) {
            if (n.missing()) continue;
            if ("Node".equals(n.kind()) && !all && !runsOn.contains(n.id())) continue; // a node card only where its pods are
            if (s.nss != null && n.namespace() != null && !s.nss.contains(n.namespace())) continue;
            if (!s.gh.isEmpty() && !s.gh.equals(n.health())) continue;
            if (!q.isEmpty() && !globalMatch(n, q)) continue;
            out.add(n);
        }
        return out;
    }

    private static boolean globalMatch(Graph.Node n, String q) {
        if (n.name().toLowerCase(Locale.ROOT).contains(q) || n.kind().toLowerCase(Locale.ROOT).contains(q)) return true;
        if (n.namespace() != null && n.namespace().toLowerCase(Locale.ROOT).contains(q)) return true;
        return n.labels() != null && n.labels().values().stream().anyMatch(v -> String.valueOf(v).toLowerCase(Locale.ROOT).contains(q));
    }

    static String gkey(Graph.Node n) { return n.group() != null ? n.group() + "/" + n.kind() : n.kind(); }

    private Scope scope(String namespace, String nss, String gq, String gh) {
        Set<String> set = nss == null || nss.isBlank() ? null : new HashSet<>(Arrays.asList(nss.split(",")));
        return new Scope(namespace == null ? "*" : namespace, set, gq == null ? "" : gq.trim(), gh == null ? "" : gh);
    }

    // ------------------------------------------------------------------ sidebar: kinds with counts

    @GetMapping("/api/table/kinds")
    public Map<String, Object> kinds(@RequestParam(defaultValue = "*") String namespace, @RequestParam(required = false) String nss,
                                     @RequestParam(defaultValue = "") String gq, @RequestParam(defaultValue = "") String gh) {
        Graph g = snapshots.get(namespace);
        Map<String, Map<String, Object>> by = new LinkedHashMap<>();
        for (Graph.Node n : scoped(g, scope(namespace, nss, gq, gh))) {
            Map<String, Object> k = by.computeIfAbsent(gkey(n), x -> {
                Map<String, Object> m = new LinkedHashMap<>();
                m.put("key", x);
                m.put("count", 0);
                m.put("errors", 0);
                m.put("sample", Map.of("kind", n.kind(), "group", n.group() == null ? "" : n.group(), "id", n.id(), "name", n.name()));
                return m;
            });
            k.put("count", (int) k.get("count") + 1);
            if ("error".equals(n.health())) k.put("errors", (int) k.get("errors") + 1);
        }
        return Map.of("context", Objects.requireNonNullElse(g.context(), ""), "kinds", by.values());
    }

    // ------------------------------------------------------------------ one page of one kind

    @GetMapping("/api/table")
    public Map<String, Object> table(@RequestParam(defaultValue = "*") String namespace, @RequestParam(required = false) String nss,
                                     @RequestParam(defaultValue = "") String gq, @RequestParam(defaultValue = "") String gh,
                                     @RequestParam String kind,
                                     @RequestParam(defaultValue = "") String q,
                                     @RequestParam(defaultValue = "") String cols,      // JSON [[key, label]…]: data columns of the kind
                                     @RequestParam(defaultValue = "") String health,    // error,warn,ok
                                     @RequestParam(defaultValue = "") String nsf,       // JSON [ns…] (namespace filter of the table)
                                     @RequestParam(defaultValue = "") String sort,      // col:1,col2:-1
                                     @RequestParam(defaultValue = "0") int page,
                                     @RequestParam(defaultValue = "50") int size,
                                     @RequestParam(defaultValue = "") String sel) throws Exception {
        size = Math.max(1, Math.min(500, size));
        Graph g = snapshots.get(namespace);
        List<Graph.Node> ofKind = scoped(g, scope(namespace, nss, gq, gh)).stream().filter(n -> gkey(n).equals(kind)).toList();
        List<String[]> colList = cols.isBlank() ? List.of() : json.readValue(cols, new TypeReference<List<List<String>>>() {})
                .stream().map(l -> new String[]{l.get(0), l.size() > 1 ? l.get(1) : l.get(0)}).toList();
        Set<String> nsFilter = nsf.isBlank() ? Set.of() : new HashSet<>(json.readValue(nsf, new TypeReference<List<String>>() {}));
        Set<String> hf = health.isBlank() ? Set.of() : Set.of(health.split(","));

        // namespace counts for the namespace filter, info keys for the column picker (over the whole kind)
        Map<String, Integer> nsCounts = new TreeMap<>();
        LinkedHashSet<String> infoKeys = new LinkedHashSet<>();
        boolean nsCol = false;
        for (Graph.Node n : ofKind) {
            nsCounts.merge(n.namespace() == null ? "" : n.namespace(), 1, Integer::sum);
            if (n.info() != null) infoKeys.addAll(n.info().keySet());
            nsCol |= n.namespace() != null;
        }
        List<Token> toks = parse(q, colList);
        List<Graph.Node> base = new ArrayList<>();
        for (Graph.Node n : ofKind) {
            if (!nsFilter.isEmpty() && !nsFilter.contains(n.namespace() == null ? "" : n.namespace())) continue;
            if (toks.stream().allMatch(t -> t.matches(n, colList))) base.add(n);
        }
        Map<String, Integer> hc = new LinkedHashMap<>(Map.of("error", 0, "warn", 0, "ok", 0));
        base.forEach(n -> hc.merge(hGroup(n), 1, Integer::sum));
        List<Graph.Node> rows = hf.isEmpty() ? base : base.stream().filter(n -> hf.contains(hGroup(n))).collect(Collectors.toCollection(ArrayList::new));

        List<Object[]> sorts = new ArrayList<>();
        for (String s : sort.split(",")) {
            if (s.isBlank()) continue;
            int i = s.lastIndexOf(':');
            sorts.add(new Object[]{s.substring(0, i), Integer.parseInt(s.substring(i + 1))});
        }
        if (sorts.isEmpty()) { sorts.add(new Object[]{"namespace", 1}); sorts.add(new Object[]{"name", 1}); } // like kubectl get -A
        rows.sort(comparator(sorts));

        int pages = Math.max(1, (rows.size() + size - 1) / size);
        if (!sel.isBlank()) { // open the page holding the selected object
            for (int i = 0; i < rows.size(); i++) if (rows.get(i).id().equals(sel)) { page = i / size; break; }
        }
        page = Math.max(0, Math.min(page, pages - 1));
        List<Graph.Node> slice = rows.subList(Math.min(rows.size(), page * size), Math.min(rows.size(), (page + 1) * size));

        Map<String, Object> out = new LinkedHashMap<>();
        out.put("context", Objects.requireNonNullElse(g.context(), ""));
        out.put("kindTotal", ofKind.size());
        out.put("total", rows.size());
        out.put("hc", hc);
        out.put("page", page);
        out.put("pages", pages);
        out.put("size", size);
        out.put("rows", new ArrayList<>(slice));
        out.put("nsCounts", nsCounts);
        out.put("nsCol", nsCol);
        out.put("infoKeys", infoKeys);
        out.put("sample", ofKind.isEmpty() ? null : ofKind.get(0));
        return out;
    }

    static String hGroup(Graph.Node n) { return "error".equals(n.health()) || "warn".equals(n.health()) ? n.health() : "ok"; }

    // ------------------------------------------------------------------ cell values (grid.js cellText / DERIVED)

    private static final Pattern NUM = Pattern.compile("^(-?[\\d.]+)\\s*(m|Ki|Mi|Gi|k|M|G)?");
    private static final Pattern SHORT_NODE = Pattern.compile("^[a-z0-9-]+\\.[a-z0-9.-]+\\.(internal|local|compute\\.amazonaws\\.com)$", Pattern.CASE_INSENSITIVE);
    private static final Set<String> HPA_KEYS = Set.of("replicas", "desired", "current", "minReplicas", "maxReplicas");

    static Double numVal(String s) {
        if (s == null) return null;
        Matcher m = NUM.matcher(s);
        if (!m.find()) return null;
        double v;
        try { v = Double.parseDouble(m.group(1)); } catch (NumberFormatException e) { return null; }
        String u = m.group(2);
        double f = u == null ? 1 : switch (u) { case "m" -> 0.001; case "k" -> 1e3; case "M" -> 1e6; case "G" -> 1e9; case "Ki" -> 1024; case "Mi" -> 1024d * 1024; case "Gi" -> 1024d * 1024 * 1024; default -> 1; };
        return v * f;
    }

    private static List<String> images(Graph.Node n) {
        String s = info(n, "images");
        return s.isEmpty() ? List.of() : Arrays.stream(s.split(",\\s*")).filter(x -> !x.isEmpty()).toList();
    }

    private static String[] splitImage(String ref) {
        int at = ref.indexOf('@');
        if (at > 0) return new String[]{ref.substring(0, at), ref.substring(at + 1, Math.min(ref.length(), at + 20)) + "…"};
        int slash = ref.lastIndexOf('/'), colon = ref.lastIndexOf(':');
        return colon > slash ? new String[]{ref.substring(0, colon), ref.substring(colon + 1)} : new String[]{ref, "latest"};
    }

    private static Map.Entry<String, String> hpaMetric(Graph.Node n) {
        if (n.info() == null) return null;
        return n.info().entrySet().stream().filter(e -> !HPA_KEYS.contains(e.getKey()) && e.getValue() != null && e.getValue().contains(" / ")).findFirst().orElse(null);
    }

    private static String info(Graph.Node n, String k) {
        String v = n.info() == null ? null : n.info().get(k);
        return v == null ? "" : v;
    }

    private static String derived(Graph.Node n, String k) {
        return switch (k) {
            case "image" -> images(n).stream().map(i -> splitImage(i)[0]).distinct().collect(Collectors.joining(", "));
            case "tag" -> images(n).stream().map(i -> splitImage(i)[1]).distinct().collect(Collectors.joining(", "));
            case "metricNow" -> { var m = hpaMetric(n); yield m == null ? "" : m.getKey() + " " + m.getValue().split(" / ")[0]; }
            case "metricTarget" -> { var m = hpaMetric(n); yield m == null ? "" : m.getValue().split(" / ")[1]; }
            case "cpuUsed" -> info(n, "cpu").split(" / ")[0];
            case "memUsed" -> info(n, "memory").split(" / ")[0];
            case "cpuPct" -> n.info() != null && n.info().get("cpuPct") != null ? n.info().get("cpuPct") + "%" : "";
            case "memPct" -> n.info() != null && n.info().get("memPct") != null ? n.info().get("memPct") + "%" : "";
            default -> null;
        };
    }

    static String cellText(Graph.Node n, String k) {
        String v = n.info() == null ? null : n.info().get(k);
        if (("Node".equals(n.kind()) || v == null)) { String d = derived(n, k); if (d != null) return d; }
        if ("node".equals(k) && v != null && SHORT_NODE.matcher(v).matches()) return v.substring(0, v.indexOf('.'));
        return v == null ? "" : v;
    }

    private static String colText(Graph.Node n, String c) {
        return switch (c) {
            case "name" -> n.name();
            case "namespace" -> Objects.requireNonNullElse(n.namespace(), "");
            case "status" -> Objects.requireNonNullElse(n.status(), "") + " " + Objects.requireNonNullElse(n.reason(), "");
            default -> cellText(n, c);
        };
    }

    // ------------------------------------------------------------------ sorting

    private static final Map<String, Integer> HEALTH_ORDER = Map.of("error", 0, "warn", 1, "unknown", 2, "ok", 3);

    /** natural, case- and accent-insensitive order ("pod-2" before "pod-10"), like Intl.Collator(vi, numeric) */
    static int natural(String a, String b) {
        String x = fold(a), y = fold(b);
        int i = 0, j = 0;
        while (i < x.length() && j < y.length()) {
            char c = x.charAt(i), d = y.charAt(j);
            if (Character.isDigit(c) && Character.isDigit(d)) {
                int si = i, sj = j;
                while (i < x.length() && Character.isDigit(x.charAt(i))) i++;
                while (j < y.length() && Character.isDigit(y.charAt(j))) j++;
                String nx = x.substring(si, i).replaceFirst("^0+(?=\\d)", ""), ny = y.substring(sj, j).replaceFirst("^0+(?=\\d)", "");
                int r = nx.length() != ny.length() ? nx.length() - ny.length() : nx.compareTo(ny);
                if (r != 0) return r;
            } else {
                if (c != d) return c - d;
                i++; j++;
            }
        }
        return (x.length() - i) - (y.length() - j);
    }

    private static final Map<String, String> FOLD = new java.util.concurrent.ConcurrentHashMap<>();
    private static String fold(String s) {
        if (s == null) return "";
        if (s.length() > 200) s = s.substring(0, 200);
        return FOLD.size() > 50_000 ? doFold(s) : FOLD.computeIfAbsent(s, TableController::doFold);
    }
    private static String doFold(String s) {
        return Normalizer.normalize(s, Normalizer.Form.NFD).replaceAll("\\p{M}", "").replace('đ', 'd').replace('Đ', 'D').toLowerCase(Locale.ROOT);
    }

    private static long created(Graph.Node n) {
        try { return n.created() == null ? 0 : Instant.parse(n.created()).toEpochMilli(); } catch (RuntimeException e) { return 0; }
    }

    private static Comparator<Graph.Node> by(String c) {
        return switch (c) {
            case "status" -> Comparator.<Graph.Node>comparingInt(n -> HEALTH_ORDER.getOrDefault(n.health(), 9))
                    .thenComparing((a, b) -> natural(a.status(), b.status()));
            case "age" -> (a, b) -> Long.compare(created(b), created(a)); // ascending = newest first
            case "name" -> (a, b) -> natural(a.name(), b.name());
            case "namespace" -> (a, b) -> natural(a.namespace(), b.namespace());
            default -> (a, b) -> {
                String x = cellText(a, c), y = cellText(b, c);
                Double nx = numVal(x), ny = numVal(y);
                return nx != null && ny != null ? Double.compare(nx, ny) : natural(x, y);
            };
        };
    }

    private static boolean isEmpty(Graph.Node n, String c) {
        return switch (c) {
            case "status", "age", "name" -> false;
            case "namespace" -> n.namespace() == null;
            default -> cellText(n, c).isEmpty();
        };
    }

    private static Comparator<Graph.Node> comparator(List<Object[]> sorts) {
        return (a, b) -> {
            for (Object[] s : sorts) {
                String c = (String) s[0];
                boolean ea = isEmpty(a, c), eb = isEmpty(b, c);
                if (ea != eb) return ea ? 1 : -1; // empty cells sink, whatever the direction
                int r = by(c).compare(a, b) * (int) s[1];
                if (r != 0) return r;
            }
            return natural(a.name(), b.name());
        };
    }

    // ------------------------------------------------------------------ the search language

    private static final Pattern TOKEN = Pattern.compile("(-?)(?:([\\w./-]+?)(!=|>=|<=|=|:|>|<))?(\"[^\"]*\"?|\\S+)");
    private static final Map<String, String> COL_ALIAS = Map.ofEntries(Map.entry("ns", "namespace"), Map.entry("namespace", "namespace"),
            Map.entry("name", "name"), Map.entry("ten", "name"), Map.entry("status", "status"), Map.entry("st", "status"), Map.entry("age", "age"),
            Map.entry("tuoi", "age"), Map.entry("ip", "podIP"), Map.entry("image", "images"), Map.entry("img", "images"), Map.entry("images", "images"),
            Map.entry("restart", "restarts"), Map.entry("label", "label"), Map.entry("labels", "label"));
    private static final Map<Character, Long> DUR = Map.of('s', 1_000L, 'm', 60_000L, 'h', 3_600_000L, 'd', 86_400_000L, 'w', 604_800_000L);

    private record Token(boolean neg, String key, String op, String value, String col, String label, String labelValue) {
        boolean matches(Graph.Node n, List<String[]> cols) {
            String v = value.toLowerCase(Locale.ROOT);
            boolean ok;
            if (key == null) {
                ok = Stream.concat(Stream.of(n.name(), n.namespace(), n.status(), n.reason()), cols.stream().map(c -> cellText(n, c[0])))
                        .anyMatch(x -> x != null && x.toLowerCase(Locale.ROOT).contains(v))
                        || (n.labels() != null && n.labels().values().stream().anyMatch(x -> String.valueOf(x).toLowerCase(Locale.ROOT).contains(v)));
            } else if (label != null) {
                String lv = n.labels() == null ? null : n.labels().get(label);
                ok = ":".equals(op) && labelValue == null ? lv != null
                        : "!=".equals(op) ? !Objects.equals(lv, labelValue)
                        : "=".equals(op) ? Objects.equals(lv, labelValue)
                        : lv != null && lv.toLowerCase(Locale.ROOT).contains(Objects.requireNonNullElse(labelValue, "").toLowerCase(Locale.ROOT));
            } else if (Set.of(">", "<", ">=", "<=").contains(op)) {
                Double x, y;
                if ("age".equals(col)) {
                    Matcher d = Pattern.compile("^(\\d+(?:\\.\\d+)?)([smhdw])$").matcher(value);
                    x = (double) (System.currentTimeMillis() - created(n));
                    y = d.matches() ? Double.parseDouble(d.group(1)) * DUR.get(d.group(2).charAt(0)) : null;
                } else { x = numVal(colText(n, col)); y = numVal(value); }
                ok = x != null && y != null && switch (op) { case ">" -> x > y; case "<" -> x < y; case ">=" -> x >= y; default -> x <= y; };
            } else {
                String txt = colText(n, col).toLowerCase(Locale.ROOT);
                ok = "=".equals(op) ? txt.trim().equals(v) : "!=".equals(op) ? !txt.trim().equals(v) : txt.contains(v);
                if ("!=".equals(op)) return ok; // "!=" already negates
            }
            return neg != ok;
        }
    }

    private static String resolveCol(String key, List<String[]> cols) {
        String k = key.toLowerCase(Locale.ROOT);
        if (COL_ALIAS.containsKey(k)) return COL_ALIAS.get(k);
        for (String[] c : cols) if (c[0].equalsIgnoreCase(k) || c[1].toLowerCase(Locale.ROOT).replaceAll("\\s+", "").equals(k)) return c[0];
        return null;
    }

    static List<Token> parse(String q, List<String[]> cols) {
        List<Token> out = new ArrayList<>();
        Matcher m = TOKEN.matcher(q == null ? "" : q);
        while (m.find()) {
            if (m.group().isBlank()) continue;
            boolean neg = !m.group(1).isEmpty();
            String key = m.group(2), op = m.group(3), value = m.group(4).replaceAll("^\"|\"$", "");
            if (value.isEmpty() && key == null) continue;
            String col = key == null ? null : resolveCol(key, cols);
            boolean isLabelCol = "label".equals(col);
            String label = key != null && (col == null || isLabelCol) ? (isLabelCol ? value.split("=")[0] : key) : null;
            String labelValue = isLabelCol ? (value.contains("=") ? value.substring(value.indexOf('=') + 1) : null) : value;
            out.add(new Token(neg, key, op, value, isLabelCol ? null : col, label, labelValue));
        }
        return out;
    }

}
