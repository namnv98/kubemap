package io.namnv.k8sstudio.auth;

import jakarta.servlet.http.HttpServletResponse;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.security.authentication.AnonymousAuthenticationToken;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.annotation.web.configuration.EnableWebSecurity;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.core.userdetails.User;
import org.springframework.security.core.userdetails.UserDetails;
import org.springframework.security.core.userdetails.UserDetailsService;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.security.crypto.factory.PasswordEncoderFactories;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.security.provisioning.InMemoryUserDetailsManager;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.authentication.HttpStatusEntryPoint;
import org.springframework.security.web.authentication.LoginUrlAuthenticationEntryPoint;
import org.springframework.security.web.util.matcher.AntPathRequestMatcher;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import java.security.SecureRandom;
import java.util.Base64;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Optional login (k8s-studio.auth.enabled). Off by default: on a laptop the UI only listens on 127.0.0.1.
 * On a shared server turn it on and list the users:
 * <pre>
 * k8s-studio.auth.enabled=true
 * k8s-studio.auth.users=alice:$2a$10$…:admin,bob:$2a$10$…:viewer
 * </pre>
 * admin = everything; viewer = read-only (no writes, no terminal, no port-forward, no cluster switch).
 * Hashes: {@code java -jar kubemap.jar hash-password}. The remote port-forward port (/pf, /tunnel) is not covered:
 * it is guarded by per-forward tokens instead.
 * "Ghi nhớ đăng nhập" on the login form sets a signed remember-me cookie (30 days, no password in it); the signing key is
 * k8s-studio.auth.remember-key, or a random one kept in config/secrets/remember-me.key (git-ignored, 0600) so the
 * cookie survives restarts. Changing a user's password hash or deleting the key file logs every remembered browser out.
 * CSRF tokens aren't used: writes need the X-K8s-Studio header + same Origin (WriteGuardFilter) and the session
 * cookie is SameSite=Lax, which together block cross-site requests.
 */
@Configuration
@EnableWebSecurity
@RestController
public class SecurityConfig {

    private static final Logger log = LoggerFactory.getLogger(SecurityConfig.class);
    public static final String ADMIN = "ADMIN", VIEWER = "VIEWER";

    private static final int REMEMBER_SECONDS = 30 * 24 * 3600;

    private final boolean enabled;
    private final String users;
    private final String rememberKey;

    public SecurityConfig(@Value("${k8s-studio.auth.enabled:false}") boolean enabled, @Value("${k8s-studio.auth.users:}") String users,
                          @Value("${k8s-studio.auth.remember-key:}") String rememberKey) {
        this.enabled = enabled;
        this.users = users;
        this.rememberKey = rememberKey;
    }

    public boolean enabled() { return enabled; }

    @Bean
    SecurityFilterChain filterChain(HttpSecurity http, UserDetailsService uds) throws Exception {
        http.csrf(c -> c.disable())
            .headers(h -> h.frameOptions(f -> f.sameOrigin()));
        if (!enabled) {
            http.authorizeHttpRequests(a -> a.anyRequest().permitAll());
            return http.build();
        }
        AntPathRequestMatcher api = new AntPathRequestMatcher("/api/**");
        String key = rememberKey();
        http.authorizeHttpRequests(a -> a
                        // login page and the token-guarded remote port-forward paths (the UI port 404s those anyway)
                        .requestMatchers("/login.html", "/login", "/favicon.ico", "/error", "/tunnel/**", "/pf/**", "/connect.java").permitAll()
                        .requestMatchers("/api/exec").hasRole(ADMIN)          // a shell in a pod is a write
                        .requestMatchers("/logout", "/api/me").authenticated()
                        .requestMatchers(HttpMethod.GET, "/**").authenticated()
                        .anyRequest().hasRole(ADMIN))                          // every POST/PUT/PATCH/DELETE
                .formLogin(f -> f.loginPage("/login.html").loginProcessingUrl("/login")
                        .defaultSuccessUrl("/", true).failureUrl("/login.html?error").permitAll())
                .rememberMe(r -> r.key(key).rememberMeParameter("remember").rememberMeCookieName("k8s-studio-remember")
                        .tokenValiditySeconds(REMEMBER_SECONDS).userDetailsService(uds))
                .logout(l -> l.logoutUrl("/logout").logoutSuccessUrl("/login.html?logout").deleteCookies("k8s-studio-remember"))
                .exceptionHandling(e -> e
                        // the API (fetch, EventSource) gets a status code, pages get the login form
                        .defaultAuthenticationEntryPointFor(new HttpStatusEntryPoint(HttpStatus.UNAUTHORIZED), api)
                        .defaultAuthenticationEntryPointFor(new LoginUrlAuthenticationEntryPoint("/login.html"), req -> true)
                        .accessDeniedHandler((req, res, ex) -> json(res, 403, "Tài khoản này chỉ được xem (viewer), không được thay đổi cluster")));
        return http.build();
    }

    /** the remember-me signing key: from the config, else a random one created once and kept next to the kubeconfigs */
    private String rememberKey() throws IOException {
        if (!rememberKey.isBlank()) return rememberKey;
        Path f = Path.of("config", "secrets", "remember-me.key");
        if (Files.isRegularFile(f)) {
            String k = Files.readString(f).strip();
            if (!k.isEmpty()) return k;
        }
        Files.createDirectories(f.getParent());
        byte[] b = new byte[32];
        new SecureRandom().nextBytes(b);
        String k = Base64.getUrlEncoder().withoutPadding().encodeToString(b);
        Files.writeString(f, k + "\n");
        try { Files.setPosixFilePermissions(f, PosixFilePermissions.fromString("rw-------")); } catch (UnsupportedOperationException ignored) { }
        log.info("created remember-me key {}", f.toAbsolutePath());
        return k;
    }

    @Bean
    UserDetailsService userDetailsService() {
        List<UserDetails> list = new ArrayList<>();
        if (enabled) {
            for (String entry : users.split(",")) {
                String e = entry.trim();
                if (e.isEmpty()) continue;
                // name:hash:role — the bcrypt hash contains no ':' (its alphabet is ./A-Za-z0-9$)
                int first = e.indexOf(':'), last = e.lastIndexOf(':');
                if (first <= 0 || last <= first) throw new IllegalStateException("k8s-studio.auth.users: cần dạng tên:hash:role, nhận \"" + e + "\"");
                String name = e.substring(0, first), hash = e.substring(first + 1, last), role = e.substring(last + 1).trim().toUpperCase();
                if (!role.equals(ADMIN) && !role.equals(VIEWER)) throw new IllegalStateException("role của " + name + " phải là admin hoặc viewer");
                list.add(User.withUsername(name).password(hash.startsWith("{") ? hash : "{bcrypt}" + hash).roles(role).build());
            }
            if (list.isEmpty()) throw new IllegalStateException("k8s-studio.auth.enabled=true nhưng k8s-studio.auth.users trống");
            log.info("login required; users: {}", list.stream().map(u -> u.getUsername() + "(" + u.getAuthorities().iterator().next().getAuthority().substring(5).toLowerCase() + ")").toList());
        }
        return new InMemoryUserDetailsManager(list); // never empty-with-defaults: no generated password in the log
    }

    @Bean
    PasswordEncoder passwordEncoder() {
        return PasswordEncoderFactories.createDelegatingPasswordEncoder();
    }

    /** who is using the UI (shown in the top bar, used to hide write actions from viewers) */
    @GetMapping("/api/me")
    public Map<String, Object> me() {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("authEnabled", enabled);
        m.put("user", currentUser());
        m.put("admin", isAdmin());
        return m;
    }

    /** name for the audit log: the logged-in user, or "local" when login is off */
    public static String currentUser() {
        Authentication a = SecurityContextHolder.getContext().getAuthentication();
        return a == null || a instanceof AnonymousAuthenticationToken || !a.isAuthenticated() ? "local" : a.getName();
    }

    /** login off → everyone is admin (the UI is only on localhost) */
    public boolean isAdmin() {
        if (!enabled) return true;
        Authentication a = SecurityContextHolder.getContext().getAuthentication();
        return a != null && a.getAuthorities().stream().anyMatch(g -> g.getAuthority().equals("ROLE_" + ADMIN));
    }

    private static void json(HttpServletResponse res, int status, String msg) throws IOException {
        res.setStatus(status);
        res.setContentType("application/json");
        res.setCharacterEncoding(StandardCharsets.UTF_8.name());
        res.getWriter().write("{\"error\":\"" + msg.replace("\"", "'") + "\"}");
    }

    /** `java -jar kubemap.jar hash-password [password]`: prints the bcrypt hash (asks for it when not given) */
    public static void hashPasswordCli(String[] args) {
        String pw;
        if (args.length > 1) pw = args[1];
        else if (System.console() != null) pw = new String(System.console().readPassword("Mật khẩu: "));
        else {
            try { pw = new String(System.in.readAllBytes(), StandardCharsets.UTF_8).strip(); }
            catch (IOException e) { throw new IllegalStateException(e); }
        }
        if (pw.isEmpty()) { System.err.println("mật khẩu trống"); System.exit(2); }
        System.out.println(new BCryptPasswordEncoder().encode(pw));
    }
}
