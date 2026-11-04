package io.namnv.k8sstudio.graph;

import java.util.List;
import java.util.Map;

/** warnings: non-empty while informers are syncing or the cluster is unreachable. */
public record Graph(String context, List<String> warnings, boolean metrics, List<Node> nodes, List<Edge> edges) {

    /**
     * health: ok | warn | error | unknown.
     * reason: short "why" for a non-ok status (e.g. "Insufficient cpu", "exit 2", "FailedMount"), or null.
     * group: API group for custom resources (null for built-in kinds).
     * missing: referenced by something but does not exist.
     * created: ISO-8601 creationTimestamp (null for placeholder nodes).
     */
    public record Node(String id, String kind, String group, String name, String namespace,
                       String status, String health, String reason, boolean missing,
                       Map<String, String> info, Map<String, String> labels, String created) {}

    /**
     * type: owns | selects | routes | runs-on | mounts | binds | uses | tls | class | pulls | runs-as |
     *       grants | subject | scales | protects | applies
     */
    public record Edge(String source, String target, String type) {}
}
