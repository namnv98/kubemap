# Triển khai Kubemap lên server

Cách đang dùng cho server thử nghiệm trên GCP (VM `k8s-studio-app`, Ubuntu, Java 25): Kubemap chạy bằng systemd,
chỉ nghe trên `127.0.0.1:8080`; **Caddy** đứng trước, phục vụ HTTPS. Đăng nhập do Kubemap đảm nhận
(`k8s-studio.auth.enabled=true`).

```
trình duyệt ──HTTPS:443──▶ Caddy ──▶ 127.0.0.1:8080  Kubemap ──▶ Kubernetes API (kubeconfig)
máy khác   ──TCP:8091───▶ Kubemap (chỉ /pf/… và /tunnel/…, mỗi link có token)
```

## Bố trí trên server

| Đường dẫn | Nội dung |
|---|---|
| `/opt/k8s-studio/k8s-studio.jar` | file jar (`root:k8s-studio`, 0640) |
| `/etc/k8s-studio/kubeconfig` | kubeconfig mặc định (biến `KUBECONFIG`) |
| `/var/lib/k8s-studio/` | thư mục làm việc: kubeconfig import từ giao diện, `config/secrets/remember-me.key`, nhật ký thao tác, lịch sử metrics |
| `/etc/systemd/system/k8s-studio.service` | service, chạy bằng user hệ thống `k8s-studio` |
| `/etc/caddy/Caddyfile` | HTTPS (chứng chỉ tự ký: `tls internal`) |

Tên `k8s-studio` trên server là tên cũ của dự án; đổi sang `kubemap` là việc riêng (tạo user, dời thư mục, service mới).

### Service (rút gọn)

```ini
[Service]
User=k8s-studio
Group=k8s-studio
WorkingDirectory=/var/lib/k8s-studio
Environment=KUBECONFIG=/etc/k8s-studio/kubeconfig
Environment=JAVA_TOOL_OPTIONS=-XX:MaxRAMPercentage=60
ExecStart=/usr/bin/java -jar /opt/k8s-studio/k8s-studio.jar \
  --server.address=127.0.0.1 --server.port=8080 --server.forward-headers-strategy=native \
  --k8s-studio.remote.address=0.0.0.0 --k8s-studio.remote.port=8091 \
  --k8s-studio.remote.public-url=http://<IP>:8091 \
  --k8s-studio.kubeconfig-dir=/var/lib/k8s-studio/kubeconfigs
Restart=on-failure
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=/var/lib/k8s-studio
```

### Caddy

```caddyfile
{
	default_sni <IP>
	auto_https disable_redirects
}
https://<IP> {
	tls internal
	reverse_proxy 127.0.0.1:8080
}
```

Có tên miền thì thay `https://<IP>` bằng tên miền và bỏ `tls internal`: Caddy tự lấy chứng chỉ Let's Encrypt.

### Firewall

Chỉ mở 443 (giao diện) và 8091 (port-forward từ xa) cho các IP cần dùng; 22 cho quản trị. Cổng 8080 không mở ra ngoài.

## Cập nhật phiên bản

```bash
# trên máy build
mvn -DskipTests package
gcloud compute scp target/kubemap-0.1.0-SNAPSHOT.jar k8s-studio-app:/tmp/kubemap.jar --zone asia-southeast1-a

# trên server
TS=$(date +%Y%m%d-%H%M%S)
sudo cp -p /opt/k8s-studio/k8s-studio.jar /opt/k8s-studio/k8s-studio.jar.bak-$TS   # giữ bản cũ
sudo install -o root -g k8s-studio -m 0640 /tmp/kubemap.jar /opt/k8s-studio/k8s-studio.jar
sudo systemctl restart k8s-studio
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8080/      # 302 → /login.html là đã chạy
sudo journalctl -u k8s-studio -f                                      # xem log
```

## Quay lại bản cũ

```bash
sudo cp -p /opt/k8s-studio/k8s-studio.jar.bak-<thời-điểm> /opt/k8s-studio/k8s-studio.jar
sudo systemctl restart k8s-studio
```

## Lưu ý

- Tài khoản đăng nhập nên đặt trong file cấu hình trên server (ví dụ `/var/lib/k8s-studio/config/application.properties`)
  thay vì dựa vào giá trị đóng gói sẵn trong jar.
- Xoá `/var/lib/k8s-studio/config/secrets/remember-me.key` (rồi restart) để đăng xuất mọi trình duyệt đang “Ghi nhớ đăng nhập”.
- Lỗi `etcd event received with PrevKv=nil` lặp lại trong log là lỗi phía k3s (thường sau khi xoá hàng loạt object);
  khởi động lại k3s trên node master thường hết.
