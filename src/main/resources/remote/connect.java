/*
 * Kubemap — TCP tunnel client for a port-forward (any protocol: Postgres, MySQL, Redis, gRPC…).
 *
 *   java connect.java <tunnel-url> <token> [local-port]
 *   java connect.java ws://studio.example.com:8091/tunnel/1a2b3c4d  Xyz…  5432
 *
 * Listens on 127.0.0.1:<local-port> on this machine; every connection to it becomes one WebSocket to Kubemap,
 * which joins it to the port-forward. Then point your tool at 127.0.0.1:<local-port> (psql -h 127.0.0.1 -p 5432).
 * Needs Java 11+, nothing else. Ctrl+C to stop. The token can also come from the K8S_STUDIO_TOKEN variable
 * (pass "-" as token) so it doesn't end up in the shell history.
 */
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.WebSocket;
import java.nio.ByteBuffer;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.atomic.AtomicInteger;

public class connect {

    public static void main(String[] args) throws Exception {
        if (args.length < 2) {
            System.err.println("usage: java connect.java <tunnel-url> <token|-> [local-port]");
            System.exit(2);
        }
        URI uri = URI.create(args[0]);
        String token = "-".equals(args[1]) ? System.getenv("K8S_STUDIO_TOKEN") : args[1];
        if (token == null || token.isBlank()) { System.err.println("missing token (argument or K8S_STUDIO_TOKEN)"); System.exit(2); }
        int localPort = args.length > 2 ? Integer.parseInt(args[2]) : 0;
        HttpClient http = HttpClient.newHttpClient();

        // fail fast on a wrong URL / token instead of on the first client connection
        try { open(http, uri, token, new Sink(null)).sendClose(WebSocket.NORMAL_CLOSURE, "").join(); }
        catch (Exception e) { System.err.println("cannot open the tunnel: " + root(e)); System.exit(1); }

        AtomicInteger active = new AtomicInteger();
        try (ServerSocket server = new ServerSocket(localPort, 50, InetAddress.getLoopbackAddress())) {
            System.out.println("tunnel ready: 127.0.0.1:" + server.getLocalPort() + " -> " + uri + "  (Ctrl+C to stop)");
            while (true) {
                Socket s = server.accept();
                s.setTcpNoDelay(true);
                new Thread(() -> serve(http, uri, token, s, active), "conn-" + s.getPort()).start();
            }
        }
    }

    private static void serve(HttpClient http, URI uri, String token, Socket s, AtomicInteger active) {
        System.out.println("+ connection from :" + s.getPort() + " (" + active.incrementAndGet() + " open)");
        WebSocket ws = null;
        try (s; InputStream in = s.getInputStream()) {
            ws = open(http, uri, token, new Sink(s.getOutputStream()));
            byte[] buf = new byte[32 * 1024];
            int n;
            while ((n = in.read(buf)) > 0) ws.sendBinary(ByteBuffer.wrap(buf, 0, n), true).join(); // join: one frame at a time, buf reused after
            ws.sendClose(WebSocket.NORMAL_CLOSURE, "").join();
        } catch (Exception e) {
            if (ws != null) ws.abort();
            if (!s.isClosed()) System.err.println("  connection :" + s.getPort() + " failed: " + root(e));
        } finally {
            System.out.println("- connection from :" + s.getPort() + " closed (" + active.decrementAndGet() + " open)");
        }
    }

    private static WebSocket open(HttpClient http, URI uri, String token, Sink sink) {
        return http.newWebSocketBuilder().header("X-K8s-Studio-Token", token).buildAsync(uri, sink).join();
    }

    /** server → local socket */
    private static final class Sink implements WebSocket.Listener {
        private final OutputStream out;
        Sink(OutputStream out) { this.out = out; }

        @Override public void onOpen(WebSocket ws) { ws.request(1); }

        @Override public CompletionStage<?> onBinary(WebSocket ws, ByteBuffer data, boolean last) {
            try {
                if (out != null) {
                    byte[] b = new byte[data.remaining()];
                    data.get(b);
                    out.write(b);
                    out.flush();
                }
            } catch (Exception e) { ws.abort(); }
            ws.request(1);
            return null;
        }

        @Override public CompletionStage<?> onClose(WebSocket ws, int code, String reason) {
            try { if (out != null) out.close(); } catch (Exception ignored) {}
            return CompletableFuture.completedFuture(null);
        }

        @Override public void onError(WebSocket ws, Throwable e) {
            try { if (out != null) out.close(); } catch (Exception ignored) {}
        }
    }

    private static String root(Throwable t) {
        while (t.getCause() != null && t.getCause() != t) t = t.getCause();
        return t.getMessage() == null ? t.toString() : t.getMessage();
    }
}
