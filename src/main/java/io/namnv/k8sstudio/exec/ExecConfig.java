package io.namnv.k8sstudio.exec;

import org.springframework.context.annotation.Configuration;
import org.springframework.web.socket.config.annotation.EnableWebSocket;
import org.springframework.web.socket.config.annotation.WebSocketConfigurer;
import org.springframework.web.socket.config.annotation.WebSocketHandlerRegistry;

/** No setAllowedOrigins(): Spring then only accepts same-origin WebSocket handshakes, so other sites can't open a shell. */
@Configuration
@EnableWebSocket
public class ExecConfig implements WebSocketConfigurer {

    private final ExecHandler handler;
    private final io.namnv.k8sstudio.remote.TunnelHandler tunnel;

    public ExecConfig(ExecHandler handler, io.namnv.k8sstudio.remote.TunnelHandler tunnel) {
        this.handler = handler;
        this.tunnel = tunnel;
    }

    @Override
    public void registerWebSocketHandlers(WebSocketHandlerRegistry registry) {
        registry.addHandler(handler, "/api/exec");
        // TCP tunnel for port-forwards (remote-access port only, see RemoteProxyFilter); the interceptor checks the token
        registry.addHandler(tunnel, "/tunnel/*").addInterceptors(tunnel);
    }
}
