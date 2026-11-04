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

    public ConfigController(@Value("${k8s-studio.system-namespaces:^kube-.*}") List<String> systemNamespaces,
                            io.namnv.k8sstudio.actions.WriteGuardFilter writeGuard) {
        this.systemNamespaces = systemNamespaces;
        this.writeGuard = writeGuard;
    }

    @GetMapping("/api/config")
    public Map<String, Object> config() {
        return Map.of("systemNamespaces", systemNamespaces, "writeEnabled", writeGuard.writeEnabled());
    }
}
