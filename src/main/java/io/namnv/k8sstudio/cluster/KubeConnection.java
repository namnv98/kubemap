package io.namnv.k8sstudio.cluster;

import io.fabric8.kubernetes.api.model.NamedCluster;
import io.fabric8.kubernetes.api.model.NamedContext;
import io.fabric8.kubernetes.client.Config;
import io.fabric8.kubernetes.client.ConfigBuilder;
import io.fabric8.kubernetes.client.KubernetesClient;
import io.fabric8.kubernetes.client.KubernetesClientBuilder;
import io.fabric8.kubernetes.client.internal.KubeConfigUtils;
import jakarta.annotation.PreDestroy;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.io.File;
import java.io.IOException;
import java.io.Reader;
import java.io.Writer;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.nio.file.attribute.PosixFilePermissions;
import java.util.*;
import java.util.concurrent.*;

/**
 * Owns the current {@link KubernetesClient} and lets the UI switch cluster at runtime.
 * Kubeconfigs come from the project's kubeconfig directory (k8s-studio.kubeconfig-dir, git-ignored — they hold
 * cluster credentials) plus the user's default kubeconfig (~/.kube/config or $KUBECONFIG).
 * The chosen file + context is saved in {@code <dir>/selected.properties} so a restart reconnects to the same cluster.
 * Everyone else gets the client through a delegating proxy (see ClientConfig), so a switch is transparent to them;
 * components with their own state (informers, metrics) register with {@link #onSwitch}.
 */
@Component
public class KubeConnection {

    private static final Logger log = LoggerFactory.getLogger(KubeConnection.class);
    private static final String SELECTED = "selected.properties";
    private static final Set<String> EXTENSIONS = Set.of("yaml", "yml", "conf", "config", "kubeconfig");

    public record Selection(String file, String context) {}

    /** file: absolute path; managed: lives in the project directory (can be deleted from the UI). */
    public record ContextInfo(String file, String fileLabel, boolean managed, String context, String cluster,
                              String server, String namespace, String user, boolean current) {}

    private final Path dir;
    private final boolean includeDefault;
    private final List<Runnable> switchListeners = new CopyOnWriteArrayList<>();
    private volatile KubernetesClient client;
    private volatile Selection selection;

    public KubeConnection(@Value("${k8s-studio.kubeconfig-dir:config/kubeconfigs}") String dir,
                          @Value("${k8s-studio.include-default-kubeconfig:true}") boolean includeDefault) {
        this.dir = Path.of(dir).toAbsolutePath().normalize();
        this.includeDefault = includeDefault;
        try { Files.createDirectories(this.dir); } catch (IOException e) { log.warn("cannot create {}: {}", this.dir, e.getMessage()); }

        Selection saved = loadSelection();
        if (saved != null) {
            try {
                client = build(saved);
                selection = saved;
                log.info("cluster: context {} from {}", saved.context(), saved.file());
            } catch (RuntimeException e) {
                log.warn("saved cluster selection {} unusable ({}), falling back to default kubeconfig", saved, e.getMessage());
            }
        }
        if (client == null) {
            client = new KubernetesClientBuilder().withConfig(tune(Config.autoConfigure(null))).build();
            var ctx = client.getConfiguration().getCurrentContext();
            String file = defaultKubeconfig().map(f -> f.toAbsolutePath().toString()).orElse(null);
            selection = ctx == null ? null : new Selection(file, ctx.getName());
        }
    }

    public KubernetesClient client() { return client; }

    public Selection selection() { return selection; }

    public Path dir() { return dir; }

    /** Runs after every successful switch (the new client is already current). */
    public void onSwitch(Runnable r) { switchListeners.add(r); }

    // ------------------------------------------------------------------ listing

    public List<ContextInfo> contexts() {
        List<ContextInfo> out = new ArrayList<>();
        for (Path f : files()) {
            boolean managed = f.startsWith(dir);
            io.fabric8.kubernetes.api.model.Config kc;
            try { kc = KubeConfigUtils.parseConfig(f.toFile()); } catch (RuntimeException e) { continue; }
            Map<String, NamedCluster> clusters = new HashMap<>();
            for (NamedCluster c : nzl(kc.getClusters())) clusters.put(c.getName(), c);
            for (NamedContext c : nzl(kc.getContexts())) {
                var ctx = c.getContext();
                NamedCluster cl = ctx == null ? null : clusters.get(ctx.getCluster());
                String server = cl == null || cl.getCluster() == null ? null : cl.getCluster().getServer();
                boolean current = selection != null && c.getName().equals(selection.context())
                        && f.toString().equals(selection.file());
                out.add(new ContextInfo(f.toString(), managed ? dir.relativize(f).toString() : f.toString(), managed,
                        c.getName(), ctx == null ? null : ctx.getCluster(), server,
                        ctx == null ? null : ctx.getNamespace(), ctx == null ? null : ctx.getUser(), current));
            }
        }
        return out;
    }

    /** Project kubeconfigs first (sorted), then the user's default one. */
    private List<Path> files() {
        List<Path> fs = new ArrayList<>();
        try (var s = Files.list(dir)) {
            s.filter(Files::isRegularFile).filter(p -> EXTENSIONS.contains(ext(p))).sorted().forEach(fs::add);
        } catch (IOException e) { log.warn("cannot list {}: {}", dir, e.getMessage()); }
        if (includeDefault) defaultKubeconfig().map(p -> p.toAbsolutePath().normalize()).filter(p -> !fs.contains(p)).ifPresent(fs::add);
        return fs;
    }

    private static Optional<Path> defaultKubeconfig() {
        for (String name : Config.getKubeconfigFilenames()) {
            Path p = Path.of(name);
            if (Files.isRegularFile(p)) return Optional.of(p);
        }
        return Optional.empty();
    }

    // ------------------------------------------------------------------ switching

    /**
     * Connects to {@code context} of {@code file} and, only if the API server answers, makes it current.
     * Throws with a readable message otherwise; the current connection is left untouched.
     */
    public synchronized void switchTo(String file, String context) {
        Path f = known(file);
        Selection sel = new Selection(f.toString(), context);
        KubernetesClient next = build(sel);
        try {
            CompletableFuture.supplyAsync(next::getKubernetesVersion).get(10, TimeUnit.SECONDS);
        } catch (TimeoutException e) {
            next.close();
            throw new IllegalStateException("API server không phản hồi sau 10s (" + next.getMasterUrl() + ")");
        } catch (ExecutionException | InterruptedException e) {
            next.close();
            Throwable c = e.getCause() == null ? e : e.getCause();
            while (c.getCause() != null && c.getCause() != c) c = c.getCause();
            throw new IllegalStateException("Không kết nối được " + next.getMasterUrl() + ": " + c.getMessage());
        }
        KubernetesClient old = client;
        client = next;
        selection = sel;
        saveSelection(sel);
        log.info("switched cluster to context {} ({})", context, next.getMasterUrl());
        for (Runnable r : switchListeners) {
            try { r.run(); } catch (RuntimeException e) { log.warn("switch listener failed", e); }
        }
        old.close();
    }

    private KubernetesClient build(Selection sel) {
        File f = new File(sel.file());
        if (!f.isFile()) throw new IllegalArgumentException("Không có file " + sel.file());
        var kc = KubeConfigUtils.parseConfig(f);
        if (nzl(kc.getContexts()).stream().noneMatch(c -> c.getName().equals(sel.context())))
            throw new IllegalArgumentException("File " + f.getName() + " không có context " + sel.context());
        return new KubernetesClientBuilder().withConfig(tune(Config.fromKubeconfig(sel.context(), f))).build();
    }

    /** Per-request retries cut down: informers retry forever, and the default backoff hides "connection refused" for ~2 min. */
    private static Config tune(Config c) {
        return new ConfigBuilder(c).withRequestRetryBackoffLimit(1).build();
    }

    // ------------------------------------------------------------------ project kubeconfig files

    /** Saves pasted/uploaded kubeconfig YAML into the project directory; returns the file path. */
    public synchronized Path add(String name, String content) {
        if (content == null || content.isBlank()) throw new IllegalArgumentException("Nội dung kubeconfig trống");
        io.fabric8.kubernetes.api.model.Config kc;
        try { kc = KubeConfigUtils.parseConfigFromString(content); }
        catch (RuntimeException e) { throw new IllegalArgumentException("Không đọc được kubeconfig: " + rootMessage(e)); }
        if (nzl(kc.getContexts()).isEmpty()) throw new IllegalArgumentException("Kubeconfig không có context nào");
        String base = (name == null ? "" : name.trim()).replaceAll("\\.(ya?ml|conf|config|kubeconfig)$", "")
                .replaceAll("[^A-Za-z0-9._-]+", "-").replaceAll("^[-.]+|-+$", "");
        if (base.isEmpty()) base = nzl(kc.getContexts()).get(0).getName().replaceAll("[^A-Za-z0-9._-]+", "-");
        Path f = dir.resolve(base + ".yaml").normalize();
        if (!f.startsWith(dir)) throw new IllegalArgumentException("Tên file không hợp lệ");
        if (Files.exists(f)) throw new IllegalArgumentException("Đã có file " + dir.relativize(f) + ", hãy đặt tên khác");
        try {
            try { Files.createFile(f, PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rw-------"))); }
            catch (UnsupportedOperationException e) { Files.createFile(f); } // non-POSIX filesystem
            Files.writeString(f, content, StandardCharsets.UTF_8, StandardOpenOption.TRUNCATE_EXISTING);
        } catch (IOException e) {
            throw new IllegalStateException("Không ghi được " + f + ": " + e.getMessage());
        }
        log.info("added kubeconfig {}", f);
        return f;
    }

    /** Deletes a kubeconfig from the project directory (never the user's ~/.kube/config); not the one in use. */
    public synchronized void remove(String file) {
        Path f = known(file);
        if (!f.startsWith(dir)) throw new IllegalArgumentException("Chỉ xoá được kubeconfig trong " + dir);
        if (selection != null && f.toString().equals(selection.file()))
            throw new IllegalArgumentException("Đang dùng file này, hãy chuyển sang cluster khác trước khi xoá");
        try { Files.delete(f); } catch (IOException e) { throw new IllegalStateException("Không xoá được " + f + ": " + e.getMessage()); }
        log.info("removed kubeconfig {}", f);
    }

    /** Renames a kubeconfig in the project directory; the saved selection follows it. */
    public synchronized Path rename(String file, String newName) {
        Path f = known(file);
        if (!f.startsWith(dir)) throw new IllegalArgumentException("Chỉ đổi tên được kubeconfig trong " + dir);
        String base = (newName == null ? "" : newName.trim()).replaceAll("\\.(ya?ml|conf|config|kubeconfig)$", "")
                .replaceAll("[^A-Za-z0-9._-]+", "-").replaceAll("^[-.]+|-+$", "");
        if (base.isEmpty()) throw new IllegalArgumentException("Tên mới không hợp lệ");
        Path to = dir.resolve(base + ".yaml").normalize();
        if (!to.startsWith(dir)) throw new IllegalArgumentException("Tên file không hợp lệ");
        if (to.equals(f)) return f;
        if (Files.exists(to)) throw new IllegalArgumentException("Đã có file " + dir.relativize(to));
        try { Files.move(f, to); } catch (IOException e) { throw new IllegalStateException("Không đổi tên được: " + e.getMessage()); }
        if (selection != null && f.toString().equals(selection.file())) {
            selection = new Selection(to.toString(), selection.context());
            saveSelection(selection);
        }
        log.info("renamed kubeconfig {} -> {}", f, to);
        return to;
    }

    /** Only files we list may be used: the API must not read arbitrary paths. */
    private Path known(String file) {
        Path f = Path.of(file).toAbsolutePath().normalize();
        if (!files().contains(f)) throw new IllegalArgumentException("Không biết kubeconfig " + file);
        return f;
    }

    // ------------------------------------------------------------------ persistence

    private Selection loadSelection() {
        Path p = dir.resolve(SELECTED);
        if (!Files.isRegularFile(p)) return null;
        Properties props = new Properties();
        try (Reader r = Files.newBufferedReader(p)) { props.load(r); } catch (IOException e) { return null; }
        String file = props.getProperty("file"), ctx = props.getProperty("context");
        if (file == null || ctx == null) return null;
        Path f = Path.of(file);
        if (!f.isAbsolute()) f = dir.resolve(f);
        return new Selection(f.normalize().toString(), ctx);
    }

    private void saveSelection(Selection sel) {
        Properties props = new Properties();
        Path f = Path.of(sel.file());
        // project files are stored relative, so the directory can be moved with the project
        props.setProperty("file", f.startsWith(dir) ? dir.relativize(f).toString() : f.toString());
        props.setProperty("context", sel.context());
        try (Writer w = Files.newBufferedWriter(dir.resolve(SELECTED))) {
            props.store(w, "cluster chosen in the Kubemap UI");
        } catch (IOException e) {
            log.warn("cannot save cluster selection: {}", e.getMessage());
        }
    }

    @PreDestroy
    void close() { client.close(); }

    private static String ext(Path p) {
        String n = p.getFileName().toString();
        int i = n.lastIndexOf('.');
        return i < 0 ? "" : n.substring(i + 1).toLowerCase(Locale.ROOT);
    }

    private static String rootMessage(Throwable t) {
        while (t.getCause() != null && t.getCause() != t) t = t.getCause();
        return t.getMessage();
    }

    private static <T> List<T> nzl(List<T> l) { return l == null ? List.of() : l; }
}
