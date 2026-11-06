package io.namnv.k8sstudio.actions;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.time.Instant;
import java.util.ArrayDeque;
import java.util.Deque;
import java.util.List;

/** Every change made through the UI: kept in memory for the UI and appended to a file (one line per action). */
@Component
public class AuditLog {

    private static final Logger log = LoggerFactory.getLogger(AuditLog.class);
    private static final int KEEP = 200;

    public record Entry(String time, String user, String context, String action, String target, String detail, boolean ok, String error) {}

    private final Deque<Entry> entries = new ArrayDeque<>();
    private final Path file;

    public AuditLog(@Value("${k8s-studio.audit-file:${user.home}/.k8s-studio/audit.log}") String file) {
        this.file = Path.of(file);
    }

    public synchronized void record(String context, String action, String target, String detail, Exception error) {
        String user = io.namnv.k8sstudio.auth.SecurityConfig.currentUser();
        Entry e = new Entry(Instant.now().toString(), user, context, action, target, detail, error == null,
                error == null ? null : error.getMessage());
        entries.addFirst(e);
        while (entries.size() > KEEP) entries.removeLast();
        String line = String.format("%s\tuser=%s\tcontext=%s\t%s\t%s\t%s\t%s%n", e.time(), user, context, action, target,
                detail == null ? "" : detail.replace('\n', ' '), e.ok() ? "OK" : "FAILED: " + e.error());
        log.info("audit: {}", line.trim());
        try {
            Files.createDirectories(file.getParent());
            Files.writeString(file, line, StandardCharsets.UTF_8, StandardOpenOption.CREATE, StandardOpenOption.APPEND);
        } catch (IOException io) {
            log.warn("cannot write audit file {}: {}", file, io.getMessage());
        }
    }

    public synchronized List<Entry> recent() {
        return List.copyOf(entries);
    }

    public Path file() {
        return file;
    }
}
