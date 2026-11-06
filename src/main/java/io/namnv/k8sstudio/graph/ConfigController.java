package io.namnv.k8sstudio.graph;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;
import java.util.Map;

/** UI settings that live in application.properties. */
@RestController
public class ConfigController {

    private final List<String> systemNamespaces;
    private final io.namnv.k8sstudio.actions.WriteGuardFilter writeGuard;
    private final io.namnv.k8sstudio.remote.RemoteAccess remote;
    private final io.namnv.k8sstudio.auth.SecurityConfig security;

    public ConfigController(@Value("${k8s-studio.system-namespaces:^kube-.*}") List<String> systemNamespaces,
                            io.namnv.k8sstudio.actions.WriteGuardFilter writeGuard, io.namnv.k8sstudio.remote.RemoteAccess remote,
                            io.namnv.k8sstudio.auth.SecurityConfig security) {
        this.systemNamespaces = systemNamespaces;
        this.writeGuard = writeGuard;
        this.remote = remote;
        this.security = security;
    }

    @GetMapping("/api/config")
    public Map<String, Object> config() {
        // a viewer sees the same UI without any write action (the server refuses them anyway)
        return Map.of("systemNamespaces", systemNamespaces, "writeEnabled", writeGuard.writeEnabled() && security.isAdmin(),
                "auth", Map.of("enabled", security.enabled(), "user", io.namnv.k8sstudio.auth.SecurityConfig.currentUser(), "admin", security.isAdmin()),
                "remote", Map.of("enabled", remote.enabled(), "port", remote.port(), "address", remote.address(), "publicUrl", remote.publicUrl()));
    }
}
