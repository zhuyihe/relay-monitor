# 生产部署安全清单

控制台应只通过 HTTPS 反向代理对外提供服务。不要把应用容器的 `8787` 端口直接暴露到公网；外部用户只能访问代理的 443 端口。

## HTTPS 与代理

- 在反向代理处终止 TLS，并将 HTTP 请求重定向到 HTTPS。
- 代理转发时应覆盖（而不是沿用客户端传入的）`X-Forwarded-Proto` 与 `X-Forwarded-For`。
- 只有同时满足“应用端口不可被公网直连”和“代理会清理外部伪造的转发头”时，才设置 `TRUST_PROXY=true`。启用后，HTTPS 代理请求签发的会话 Cookie 会带 `Secure` 属性。
- 未启用 `TRUST_PROXY` 时，应用只根据自身请求协议决定 Cookie 是否带 `Secure`；直接 HTTP 访问不会带该属性，因此不能作为生产访问方式。

示例 Compose 将应用端口绑定到宿主机 `127.0.0.1:8787`，供宿主机上的反向代理访问。满足上述代理条件后，在 Compose 使用的 `.env` 中设置 `TRUST_PROXY=true` 并重建应用容器。若反向代理也在 Docker 内，使用同一内部网络访问 `relay-monitor:8787`，并移除应用的 `ports` 映射。

本地 Docker 构建排除 `.env`、`.env.*` 和 `server.md`；公开的 `.env.example` 可以保留。构建阶段不应包含真实数据库或部署凭证。

## 登录信息加密

配置 `RELAY_SECRET_KEY` 后，上游的令牌、Key、密码、登录邮箱，通知方式的密钥（Bot Token、Webhook 地址、SMTP 密码等），以及签登录 Cookie 用的会话密钥，都用 AES-256-GCM 加密后存进 MySQL。没配时照旧明文保存，启动日志和「系统设置」页顶会提醒。

加密防的是「数据库或备份单独外泄」。密钥和数据库放在同一台机器上、同一份备份里，就等于没加密。

### 第一次开启

1. 生成密钥：`openssl rand -base64 32`。
2. 把密钥单独备份，例如存进密码管理器。**不要**和数据库备份（`mysql-data/`、导出的 SQL）放在一起。
3. 在 compose 同目录的 `.env` 里加一行 `RELAY_SECRET_KEY=刚生成的密钥`。
   - 也可以把密钥写进一个文件，只读挂载进容器，再用 `RELAY_SECRET_KEY_FILE` 指向它。两者只配一个。
4. 重建应用容器：`docker compose up -d relay-monitor`。
5. 看日志：`docker compose logs --tail 50 relay-monitor`。应该能看到三行：
   - 「登录信息加密保存（密钥编号 xxxxxxxx）」
   - 「已把 N 处明文保存的登录信息改成加密保存」
   - 「会话密钥已换新，之前登录的设备要重新登录」
6. 所有设备重新登录一次。
7. 收尾。加密之前的明文还留在别处，要清掉：
   - MySQL 的二进制日志：`docker compose exec db sh -c 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" -e "PURGE BINARY LOGS BEFORE NOW()"'`；
   - 删掉开启加密之前的数据库备份；
   - 到各上游后台把令牌、密码换一遍，通知方式的 Webhook、Bot Token 也换新，再到控制台填上新的。

### 启动不了时

服务不会带着解不开的登录信息继续跑（那样会把它们覆盖掉），而是退出，在日志里说明原因；容器会反复重启。

| 日志里说 | 原因 | 怎么办 |
|---|---|---|
| 库里的登录信息是加密保存的，但没有配置 RELAY_SECRET_KEY | 漏配了，或者 `.env` 没生效 | 把原来的密钥配回去，重建容器 |
| 库里的登录信息是用另一个密钥（编号 …）加密的 | 换成了别的密钥 | 换回编号对得上的那个 |
| 解不开库里的登录信息（…） | 密钥不对，或者库里的数据被改过 | 换回原来的密钥 |
| RELAY_SECRET_KEY 格式不对 | 不是 32 字节的 base64，常见是复制少了几位 | 对照备份重新填 |
| RELAY_SECRET_KEY 和 RELAY_SECRET_KEY_FILE 只能配一个 | 两个都配了 | 删掉一个 |

### 加密密钥丢了怎么办

找不回原来的密钥时，解不开的登录信息就没法用了，只能清掉后重新填：

```bash
cd ~/relay-monitor
docker compose stop relay-monitor
# 先列出要清哪些，不改库
docker compose run --rm --no-deps relay-monitor node db/reset-secrets.js
# 确认后加 --yes 才真的清
docker compose run --rm --no-deps relay-monitor node db/reset-secrets.js --yes
docker compose up -d relay-monitor
```

- 只清解不开的。用现在配的密钥解得开的、本来就是明文的都不动。站点地址、成本设置、历史数据也都不动。
- 会话密钥会在下次启动时重新生成，所有设备要重新登录。
- 清完后，到「上游列表」逐个编辑上游，把令牌、密码重新填上；到「告警中心」把通知方式的密钥重新填上。

### 回滚到旧版本

开启加密后，如果回滚到不支持加密的旧镜像，旧版本读不了密文：所有上游都会读不到余额，通知也发不出去。库里的数据不会坏，换回新镜像就恢复。

## 初始账号

- 首次初始化会创建 `admin / admin123`。
- 使用初始密码登录后只能修改账号密码或退出；请立即设置至少 6 位的新密码。
- 改密会让所有现有会话失效，需使用新密码重新登录。

## 发布前核验

1. 确认公网无法访问 `http://服务器IP:8787`。
2. 确认 HTTPS 登录响应的 `Set-Cookie` 同时包含 `HttpOnly`、`SameSite=Lax` 与 `Secure`。
3. 确认 HTTP 请求会跳转 HTTPS，且不会使用正式账号登录。
4. 使用新密码重新登录，确认旧浏览器会话已失效。
