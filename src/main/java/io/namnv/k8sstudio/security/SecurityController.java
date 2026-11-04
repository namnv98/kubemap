package io.namnv.k8sstudio.security;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;

/** Security overview (read-only), see {@link SecurityService}. namespace "*" or empty = all namespaces. */
@RestController
@RequestMapping("/api/security")
public class SecurityController {

    private final SecurityService security;

    public SecurityController(SecurityService security) {
        this.security = security;
    }

    private static String ns(String n) { return n == null || n.isBlank() || "*".equals(n) ? null : n; }

    @GetMapping("/workloads")
    public List<SecurityService.WorkloadReport> workloads(@RequestParam(defaultValue = "*") String namespace) {
        return security.workloads(ns(namespace));
    }

    @GetMapping("/entrypoints")
    public List<SecurityService.EntryPoint> entryPoints(@RequestParam(defaultValue = "*") String namespace) {
        return security.entryPoints(ns(namespace));
    }

    @GetMapping("/rbac")
    public List<SecurityService.SubjectReport> rbac(@RequestParam(defaultValue = "*") String namespace) {
        return security.subjects(ns(namespace));
    }

    /** who can <verb> <resource>[/<subresource>] of <group> in <namespace> ("*" = cluster-wide) */
    @GetMapping("/rbac/can")
    public List<SecurityService.Allowed> can(@RequestParam String verb, @RequestParam String resource,
                                             @RequestParam(defaultValue = "") String group, @RequestParam(defaultValue = "*") String namespace) {
        return security.whoCan(verb.trim(), resource.trim(), group.trim(), ns(namespace));
    }
}
