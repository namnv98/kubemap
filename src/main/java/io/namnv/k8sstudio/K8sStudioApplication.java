package io.namnv.k8sstudio;

import io.fabric8.kubernetes.client.KubernetesClient;
import io.namnv.k8sstudio.cluster.KubeConnection;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.context.annotation.Bean;

import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Proxy;

@SpringBootApplication
public class K8sStudioApplication {

    public static void main(String[] args) {
        // `java -jar kubemap.jar hash-password` → bcrypt hash for k8s-studio.auth.users (no Spring, no cluster)
        if (args.length > 0 && "hash-password".equals(args[0])) {
            io.namnv.k8sstudio.auth.SecurityConfig.hashPasswordCli(args);
            return;
        }
        SpringApplication.run(K8sStudioApplication.class, args);
    }

    /**
     * The client every service injects: a proxy that always forwards to {@link KubeConnection#client()},
     * so switching cluster from the UI needs no change in the services. close() is a no-op here —
     * KubeConnection owns (and closes) the real clients.
     */
    @Bean(destroyMethod = "")
    KubernetesClient kubernetesClient(KubeConnection connection) {
        return (KubernetesClient) Proxy.newProxyInstance(KubernetesClient.class.getClassLoader(),
                new Class<?>[]{KubernetesClient.class}, (proxy, method, args) -> {
                    switch (method.getName()) {
                        case "close": if (method.getParameterCount() == 0) return null; break;
                        case "equals": if (method.getParameterCount() == 1) return proxy == args[0]; break;
                        case "hashCode": if (method.getParameterCount() == 0) return System.identityHashCode(proxy); break;
                        case "toString": if (method.getParameterCount() == 0) return "KubernetesClient -> " + connection.client(); break;
                        default: break;
                    }
                    try {
                        return method.invoke(connection.client(), args);
                    } catch (InvocationTargetException e) {
                        throw e.getCause();
                    }
                });
    }
}
