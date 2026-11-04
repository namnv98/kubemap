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

    public ExecConfig(ExecHandler handler) {
        this.handler = handler;
    }

    @Override
    public void registerWebSocketHandlers(WebSocketHandlerRegistry registry) {
        registry.addHandler(handler, "/api/exec");
    }
}
