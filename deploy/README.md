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

配置 `RELAY_SECRET_KEY` 后，上游的令牌、Key、密码、登录邮箱（连同余额记录里的账号名），通知方式的密钥（Bot Token、Webhook 地址、SMTP 密码等），以及签登录 Cookie 用的会话密钥、算账单身份用的密钥，都用 AES-256-GCM 加密后存进 MySQL。没配时照旧明文保存，启动日志和「系统设置」页顶会提醒。

加密防的是「数据库或备份单独外泄」。密钥和数据库放在同一份备份里，就等于没加密。

### 第一次开启

1. 生成密钥：`openssl rand -base64 32`。
2. 把密钥单独备份，例如存进密码管理器。**不要**和数据库备份（`mysql-data/`、导出的 SQL）放在一起。
3. 确认 compose 文件里 `relay-monitor` 的 `environment` 有这一行（新版 `deploy/docker-compose.yml` 已经有；Watchtower 只更新镜像，不会更新你手里的 compose 文件）：
   ```yaml
         - RELAY_SECRET_KEY=${RELAY_SECRET_KEY:-}
   ```
   compose 只用同目录 `.env` 里的值替换这里的 `${…}`，**没有这一行，写进 `.env` 也传不进容器**。
4. 在 compose 同目录的 `.env` 里加一行 `RELAY_SECRET_KEY=刚生成的密钥`。
   - 整个目录打包备份时，记得排除 `.env`，否则密钥和 `mysql-data/` 又进了同一份备份。
   - 也可以把密钥写进一个文件，放在别的目录，只读挂载进容器，再用 `RELAY_SECRET_KEY_FILE` 指向它。两者只配一个。例如：
     ```yaml
         environment:
           - RELAY_SECRET_KEY_FILE=/run/secrets/relay_secret_key
         volumes:
           - /etc/relay-monitor/secret.key:/run/secrets/relay_secret_key:ro
     ```
5. 重建应用容器：`docker compose up -d relay-monitor`。
6. 看日志：`docker compose logs --tail 50 relay-monitor`。应该能看到三行：
   - 「登录信息加密保存（密钥编号 xxxxxxxx）」
   - 「已把 N 处明文保存的登录信息改成加密保存」
   - 「会话密钥已换新，之前登录的设备要重新登录」

   如果看到的是「登录信息还是明文保存在数据库里」，说明密钥没传进容器，回到第 3 步检查。
7. 所有设备重新登录一次。
8. 收尾。加密之前的明文还留在别处，下面三件都要做：
   - 清掉 MySQL 的二进制日志。先切到一个新的日志文件，等两秒再清掉之前的（正在写的那个清不掉，所以要先切）：
     ```bash
     docker compose exec db sh -c 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" -e "FLUSH BINARY LOGS"; sleep 2; mysql -uroot -p"$MYSQL_ROOT_PASSWORD" -e "PURGE BINARY LOGS BEFORE NOW()"'
     ```
   - 删掉开启加密之前的数据库备份。
   - 从「账单身份改 HMAC」（S3）之前的版本升级上来，即使还没开启加密，也建议做这一步和上一步：升级时改写的账单能力表，旧身份还留在二进制日志和升级前的备份里。
   - **必须**到各上游后台把令牌、密码换一遍，通知方式的 Webhook、Bot Token 也换新，再到控制台填上新的。数据库文件里可能还残留着改写前的旧数据页，只有换掉，旧的才真的没用了。

### 启动不了时

服务不会带着解不开的登录信息继续跑（那样会把它们覆盖掉），而是退出，在日志里说明原因；容器会反复重启。

日志里「[致命] 服务初始化失败：」后面是一行 JSON：`code` 是码，`message` 是那句话。数据库直接报的错只写码，不带原文（原文里可能有写进库的登录信息）。

| 日志里说 | 原因 | 怎么办 |
|---|---|---|
| 库里的登录信息是加密保存的，但没有配置 RELAY_SECRET_KEY | 漏配了，或者没传进容器（见「第一次开启」第 3 步） | 把原来的密钥配回去，重建容器 |
| 库里的登录信息是用另一个密钥（编号 …）加密的 | 换成了别的密钥，或者密钥抄错了 | 换回编号对得上的那个 |
| 解不开库里的上游「…」的…… | 密钥没换过的话，是库里这几处数据被改过 | 运行下面的恢复脚本，它只会清解不开的这几处 |
| RELAY_SECRET_KEY 格式不对 | 不是 32 字节的 base64，常见是复制少了几位 | 对照备份重新填 |
| RELAY_SECRET_KEY_FILE 指向的文件是空的 / 读不到 | 文件没挂载进容器，或者是空的 | 检查挂载和文件内容 |
| RELAY_SECRET_KEY 和 RELAY_SECRET_KEY_FILE 只能配一个 | 两个都配了 | 删掉一个 |
| `"code":"ECONNREFUSED"`、`"code":"ENOTFOUND"` 或 `"code":"ETIMEDOUT"` | 连不上数据库：数据库还没起来，地址、端口填错了，或者被防火墙挡住 | 看 db 容器在不在跑，核对 DB_HOST、DB_PORT |
| `"code":"ER_ACCESS_DENIED_ERROR"` | 数据库的用户名或密码不对 | 核对 .env 里的 DB_USER、DB_PASSWORD。compose 里的 MySQL 只在第一次建 mysql-data 时按 .env 建账号，之后改 .env 不会改库里的账号，要和第一次建库时的一致 |
| `"code":"ER_BAD_DB_ERROR"` | 数据库里没有这个库 | 核对 DB_NAME，同样要和第一次建库时的一致 |
| `"code":"ER_HOST_NOT_PRIVILEGED"` | 用的是外面的数据库，它不让这台机器登录 | 在数据库里给这台机器的地址授权 |
| 其他以 `_DENIED_ERROR` 结尾的码（例如 `ER_DBACCESS_DENIED_ERROR`、`ER_TABLEACCESS_DENIED_ERROR`） | 数据库账号没有建表、改表的权限 | 给 DB_USER 授权这个库的全部权限 |

### 加密密钥丢了怎么办

**先确认是真丢了**：日志里说「是用另一个密钥（编号 …）加密的」时，只要找得回编号对得上的那个密钥，配回去就好，什么都不用清。

真的找不回时，解不开的登录信息就没法用了，只能清掉后重新填。要继续加密的话，先在 `.env` 里换上新生成的密钥（新的密钥照样要单独备份）。

第一步：停掉服务，看看要清哪些（不改库）：

```bash
cd ~/relay-monitor
docker compose stop relay-monitor
docker compose run --rm --no-deps relay-monitor node db/reset-secrets.js
```

输出会列出每个上游、通知方式解不开的是哪几项，以及它们是用哪个编号的密钥加密的。**看清楚再做下一步。**

第二步：确认后加 `--yes` 真的清，再启动：

```bash
docker compose run --rm --no-deps relay-monitor node db/reset-secrets.js --yes
docker compose up -d relay-monitor
```

- 只清解不开的。用现在配的密钥解得开的、本来就是明文的都不动。站点地址、成本设置、历史数据也都不动。
- 会话密钥会在下次启动时重新生成，所有设备要重新登录。
- 账单身份密钥也会重新生成：Sub2API 上游能不能按 Key 读账单，要等有消费的那天自动重新确认；在那之前，没有消费的日子每日利润算不出来，过后也不会自动补算。
- 清完后，到「上游列表」逐个编辑上游，把令牌、密码重新填上；到「告警中心」把通知方式的密钥重新填上。

### 回滚到旧版本

开启加密后，如果回滚到不支持加密的旧镜像，请尽快换回：
- 旧版本读不了密文：所有上游都会读不到余额。要填密钥的通知方式发不出去；不用密钥的（例如不带令牌的 ntfy）照样能发，会收到一批「读不到余额」的提醒。
- 旧版本把会话密钥的密文直接当成会话密钥用，所以回滚时所有人要重新登录一次，换回新镜像时还要再登录一次。
- 每日利润只自动补结「昨天」，回滚超过一天，期间那几天可能结不了。
- 回滚到旧版 S3 或更早版本：旧程序不认识新的账单能力身份，Sub2API 上游可能回到未确认，期间没有消费的日子每日利润算不出来。旧程序有消费时重新确认，会按它自己的格式新增能力记录。
- 换回新镜像启动时，会在同一个事务里将这些旧格式身份包装为 `wrapped-v2`，保留核验结果和核验时间；原来就有的新格式不再包装。同一身份冲突时保留核验时间较新的结果，零消费也能沿用已确认的能力。迁移失败会回滚并中止启动，修复数据库错误后可重试，不会改动固定账或账单快照。
- 表里格式不对的旧记录（身份不是 64 位十六进制，或者能力那一列被手改坏、读不出一条记录，正常不会有）启动时跳过，日志写「跳过 N 条格式不对的旧 Sub2API 账单能力记录（BILLING_IDENTITY_INVALID）」，不挡启动。这些行对不上任何上游，不删也不影响使用，只是每次启动都会这样提示一次。要删的话，先停掉旧程序、启动过一次新镜像，这时表里还标着 `legacy` 的就只剩这些行：
  ```bash
  docker compose exec db sh -c 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" "$MYSQL_DATABASE" -e "DELETE FROM reconciliation_billing_capabilities WHERE identity_scheme = \"legacy\""'
  ```
- 回滚期间旧程序作废（删掉）的账单能力，删不到新格式的那一行：换回新镜像后，这个 Sub2API 上游可能又按已确认算。只有回滚期间上游正好改了、不再支持按 Key 读账单时才会遇到：
  - 上游不再给按 Key 的账单：换回后下一轮读账单（通常几分钟内）就会自动作废。
  - 上游还给账单、只是不再按日期或按 Key 过滤：要等离回滚前最后一次确认满 7 天、又有一天有消费，重新确认没通过才作废。这期间这个上游的每日利润可能算错，换回后留意一下它的每日利润。
- 新增的 `identity_scheme` 列默认 `legacy`，兼容旧程序不带该列的写入；每次启动按行扫描，不靠一次性完成标记跳过。旧 `billing_identity_hmac_v1` 标记会保留或补上，阻止旧 S3 程序再次改写已包装身份。**部署切换前先停止旧程序，不要让不同版本同时连接同一库写账单能力。**
- S3 之前的程序回滚期间仍可能写入裸 SHA 摘要；重新升级会处理当前表，但旧备份、二进制日志或回滚期间导出的数据仍须按上文清理。重新升级后的安全性不会追溯覆盖这些副本。
- 库里的数据不会坏，换回新镜像就恢复。

## 初始账号

- 首次初始化会创建 `admin / admin123`。
- 使用初始密码登录后只能修改账号密码或退出；请立即设置至少 6 位的新密码。
- 改密会让所有现有会话失效，需使用新密码重新登录。

## 发布前核验

1. 确认公网无法访问 `http://服务器IP:8787`。
2. 确认 HTTPS 登录响应的 `Set-Cookie` 同时包含 `HttpOnly`、`SameSite=Lax` 与 `Secure`。
3. 确认 HTTP 请求会跳转 HTTPS，且不会使用正式账号登录。
4. 使用新密码重新登录，确认旧浏览器会话已失效。
