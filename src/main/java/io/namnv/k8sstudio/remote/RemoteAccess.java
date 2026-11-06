package io.namnv.k8sstudio.remote;

import org.apache.catalina.connector.Connector;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.web.embedded.tomcat.TomcatServletWebServerFactory;
import org.springframework.boot.web.server.WebServerFactoryCustomizer;
import org.springframework.stereotype.Component;

/**
 * Remote access to port-forwards: a second HTTP port that serves only
 * <ul>
 *   <li>{@code /pf/{id}/{token}/} – HTTP proxy into a forward (browser),</li>
 *   <li>{@code /tunnel/{id}} – TCP over WebSocket into a forward (any protocol, with a small client),</li>
 *   <li>{@code /connect.java} – that client.</li>
 * </ul>
 * It is a separate port on purpose: a different origin from the Kubemap UI, so JavaScript of a proxied app can't
 * call the Kubemap API (which can change the cluster). It can also listen on another address than the UI, e.g. the
 * UI on 127.0.0.1 and this port on 0.0.0.0. Every request needs the forward's secret token.
 */
@Component
public class RemoteAccess implements WebServerFactoryCustomizer<TomcatServletWebServerFactory> {

    private final int port;
    private final String address;
    private final String publicUrl;

    public RemoteAccess(@Value("${k8s-studio.remote.port:8091}") int port,
                        @Value("${k8s-studio.remote.address:${server.address:127.0.0.1}}") String address,
                        @Value("${k8s-studio.remote.public-url:}") String publicUrl) {
        this.port = port;
        this.address = address;
        this.publicUrl = publicUrl == null ? "" : publicUrl.replaceAll("/+$", "");
    }

    @Override
    public void customize(TomcatServletWebServerFactory factory) {
        if (!enabled()) return;
        Connector c = new Connector(TomcatServletWebServerFactory.DEFAULT_PROTOCOL);
        c.setPort(port);
        c.setProperty("address", address);
        factory.addAdditionalTomcatConnectors(c);
    }

    public boolean enabled() { return port > 0; }

    public int port() { return port; }

    public String address() { return address; }

    /** base URL clients should use (k8s-studio.remote.public-url, e.g. behind a TLS reverse proxy); empty = derive from the UI's host */
    public String publicUrl() { return publicUrl; }
}
