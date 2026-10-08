# 生产部署安全清单

控制台应只通过 HTTPS 反向代理对外提供服务。不要把应用容器的 `8787` 端口直接暴露到公网；外部用户只能访问代理的 443 端口。

## HTTPS 与代理

- 在反向代理处终止 TLS，并将 HTTP 请求重定向到 HTTPS。
- 代理转发时应覆盖（而不是沿用客户端传入的）`X-Forwarded-Proto` 与 `X-Forwarded-For`。
- 只有同时满足“应用端口不可被公网直连”和“代理会清理外部伪造的转发头”时，才设置 `TRUST_PROXY=true`。启用后，HTTPS 代理请求签发的会话 Cookie 会带 `Secure` 属性。
- 未启用 `TRUST_PROXY` 时，应用只根据自身请求协议决定 Cookie 是否带 `Secure`；直接 HTTP 访问不会带该属性，因此不能作为生产访问方式。

示例 Compose 将应用端口绑定到宿主机 `127.0.0.1:8787`，供宿主机上的反向代理访问。满足上述代理条件后，在 Compose 使用的 `.env` 中设置 `TRUST_PROXY=true` 并重建应用容器。若反向代理也在 Docker 内，使用同一内部网络访问 `relay-monitor:8787`，并移除应用的 `ports` 映射。

本地 Docker 构建排除 `.env`、`.env.*` 和 `server.md`；公开的 `.env.example` 可以保留。构建阶段不应包含真实数据库或部署凭证。

## 初始账号

- 首次初始化会创建 `admin / admin123`。
- 使用初始密码登录后只能修改账号密码或退出；请立即设置至少 6 位的新密码。
- 改密会让所有现有会话失效，需使用新密码重新登录。

## 发布前核验

1. 确认公网无法访问 `http://服务器IP:8787`。
2. 确认 HTTPS 登录响应的 `Set-Cookie` 同时包含 `HttpOnly`、`SameSite=Lax` 与 `Secure`。
3. 确认 HTTP 请求会跳转 HTTPS，且不会使用正式账号登录。
4. 使用新密码重新登录，确认旧浏览器会话已失效。
