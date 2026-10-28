# 生产部署安全清单

控制台应只通过 HTTPS 反向代理对外提供服务。不要把应用容器的 `8787` 端口直接暴露到公网；外部用户只能访问代理的 443 端口。

## HTTPS 与代理

- 在反向代理处终止 TLS，并将 HTTP 请求重定向到 HTTPS。
- 代理转发时应覆盖（而不是沿用客户端传入的）`X-Forwarded-Proto` 与 `X-Forwarded-For`。
- 只有同时满足“应用端口不可被公网直连”和“代理会清理外部伪造的转发头”时，才设置 `TRUST_PROXY=true`。启用后，HTTPS 代理请求签发的会话 Cookie 会带 `Secure` 属性。
- 未启用 `TRUST_PROXY` 时，应用只根据自身请求协议决定 Cookie 是否带 `Secure`；直接 HTTP 访问不会带该属性，因此不能作为生产访问方式。

示例 Compose 将应用端口绑定到宿主机 `127.0.0.1:8787`，供宿主机上的反向代理访问。满足上述代理条件后，在 Compose 使用的 `.env` 中设置 `TRUST_PROXY=true` 并重建应用容器。若反向代理也在 Docker 内，使用同一内部网络访问 `relay-monitor:8787`，并移除应用的 `ports` 映射。

### 登录失败限流按哪个来源算

同一个来源连续输错 10 次密码，锁 5 分钟；锁着的时候密码对了也进不去。「来源」按下面的规则分辨，前提都是本节开头那条：应用端口不要直接暴露给不受信任的网络。

- **没开 `TRUST_PROXY`**：按真正连进来的地址（IPv6 按所在的 /64 段算，一个用户通常整段分到手，不按单个地址分）。
  - 应用端口确实只有反向代理能连到时，连进来的都是代理地址，等于所有访问者共用一个计数——这是本节开头推荐的部署方式，和开了 `TRUST_PROXY` 时「隔着好几层代理」的效果一样，不会更差。
  - **把应用端口直接暴露给公网、又没开 `TRUST_PROXY`**：按真正连进来的地址分源能挡住「一个人乱试、所有人一起被锁」，但攻击者本身不受这层防护约束——他可以无限换地址（尤其是 IPv6 段）慢慢试；这属于本节开头就不建议的部署方式，只是没有反向代理时能做到的下限。
- **开了 `TRUST_PROXY`**：按 `X-Forwarded-For` 的**最后一个**地址，也就是离应用最近的那层代理加上去的（同样按 /64 段算 IPv6；取到的不是合法地址时退回连接地址）。
  - nginx 推荐用 `proxy_set_header X-Forwarded-For $remote_addr;` 覆盖这个头，不要用 `$proxy_add_x_forwarded_for` 往后追加。两种写法下最后一个地址都对，覆盖更干净。
  - 隔着好几层代理（比如 CDN 再到 nginx）时，最后一个地址是上一层代理，所有人又共用一个计数。要按真实访问者算，在离应用最近的那层代理上配好 `real_ip`（nginx 的 `set_real_ip_from` 和 `real_ip_header`），再用 `$remote_addr` 覆盖；`set_real_ip_from` **只能填这层代理自己的地址段**（比如 CDN 公布的出口段），填 `0.0.0.0/0` 等于谁都能冒充代理、自己伪造 `X-Forwarded-For`，和没开限流一样。
  - **开错了的后果**：应用端口能被直连、又开了 `TRUST_PROXY` 时，客户端自己发的 `X-Forwarded-For` 会被当真。攻击者既能在最后一段填一个不存在的地址，绕开限流无限次试密码；也能填管理员真实的地址，把管理员自己先锁住。
- **Docker 默认配置下 IPv6 访问会合成一个来源**：Docker 默认不开 IPv6、且用 `userland-proxy` 转发端口时，不管走 IPv4 还是 IPv6 连进来的请求，容器看到的来源都是宿主机网桥网关的同一个地址。这种配置下即使日志写着「按连接地址」，IPv6 的访问者（含管理员自己，双栈环境下浏览器常优先用 IPv6）实际还是共用一个计数，本节要防的问题在这条路径上并没有解决。要分开算，给 Docker 开 IPv6 支持，或者让反向代理和应用之间不经过端口转发（同一个 Docker 网络内直接访问）。
- 启动日志会写现在按什么算：「登录限流按连接地址」或「登录限流按 X-Forwarded-For 的最后一个地址」。看到「登录限流全站共用一个计数」，说明启动命令没带 `--import ./lib/peer-address.js`（镜像自带；自己改过启动命令的要加回来）。

**全站还有一道兜底**：按来源限流挡不住很多个来源各试几次的分布式乱试。5 分钟内全站登录失败满一个数（环境变量 `LOGIN_SITE_FAILURE_LIMIT`，默认 50；填 0 关掉这道兜底，只剩按来源的锁；填的不是合法的非负整数按默认值 50 算），这之后不管哪个来源来的都直接拒绝，不再校验密码，直到窗口过去。**已经在这台浏览器登录成功过**（即使后来退出了登录）不受这条约束——浏览器会收到一个长期有效（180 天）的设备标记，退出登录不会清掉它，所以就算外面正在被大量乱试，自己这台常用的浏览器照样能登进去；密码还是要输对，单来源的锁也照常算。改密码或改用户名以后，这个标记会跟着凭证一起换新（当时这台浏览器刚验证过原密码，改密码的响应里会直接发一张新的），其余浏览器上的旧标记作废，要重新登录一次才能恢复。清掉浏览器 Cookie、换一台新设备，或者服务端的签名密钥换了（登录信息加密设置变更、密钥丢了重置），也是同样要先登录成功一次。

**全站兜底被打满时怎么恢复**（比如一时半会儿处理不了那么多分布式乱试请求）：
- 用前面提到的、已经登录成功过的浏览器——它不受这条约束，密码对了照样能进去；
- 把反向代理或防火墙临时只放行自己的出口地址，隔掉乱试的来源；
- 把 `LOGIN_SITE_FAILURE_LIMIT` 调大，或者设成 0 临时关掉这道兜底，改完 `.env` 后 `docker compose up -d` 重建应用容器生效；
- 直接重启应用容器能让全站失败计数清零，但只能清这一次——乱试还在继续的话很快又会堆满，治标不治本，配合上面几条一起用。

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
6. 看日志：`docker compose logs --tail 50 relay-monitor`。
   - **第一次装（库里还没有任何登录信息）**：只有一行「登录信息加密保存（密钥编号 xxxxxxxx）」。库里没有明文可改，也没有旧的会话密钥可换新，下面两行不会出现，第 8 步的收尾也用不着。
   - **已经在用、现在才开加密**：两到三行——「登录信息加密保存（密钥编号 xxxxxxxx）」、库里存过上游或通知方式的令牌密码时多一行「已把 N 处明文保存的登录信息改成加密保存」、「会话密钥已换新，之前登录的设备要重新登录」。

   如果看到的是「登录信息还是明文保存在数据库里」，说明密钥没传进容器，回到第 3 步检查。
7. 所有设备重新登录一次。
8. 收尾（只有「已经在用、现在才开加密」才要做；第一次装没有加密之前的明文，跳过这一步）：
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

## 装渠道 Key 读取服务

控制台要知道自营站点的每个渠道现在用的是哪把 Key，才能把渠道的收入和上游 Key 的花费对在一起。自营站点的接口读不到渠道里填的完整 Key，所以装一个放在自营 New API 旁边的小服务：它直接读 New API 的 `channels` 表，**只对外给每把 Key 的打码（前 4 位、后 4 位）和一个 HMAC 指纹，不给完整的 Key**。控制台拿指纹去和上游的 Key 精确比对。

这一项先把读取服务装好、验到读得出 Key 就行；控制台里对应的设置栏（读取服务地址、读取服务令牌）随后面的版本加入，加入之前读取服务单独跑着，不影响控制台现在的任何功能。

### 它怎么保证不拖累线上的 New API

自营站点是正式环境，读取服务出任何问题（代码出错、查询卡住、New API 升级改表、被人攻击）都不该让 New API 慢下来。下面分开写：哪些是**数据库自己强制**的（读取服务的代码出错也越不过去），哪些是**读取服务自己做**的（防代码出错、防升级改表，但防不了进程被人完全攻破后故意去烧数据库）。

| | 做法 | 谁来保证 |
|---|---|---|
| 权限 | 专用账号只有 `channels` 表那 7 列的 `SELECT`；权限比这多（能写、能读别的表、能转授权限、通过角色拿权限、连接数上限不是 1、是 New API 自己的账号），读取服务不读 | 数据库（账号权限）；读取服务启动后第一次读之前会再查一遍，不合格就不读（只查这一次：权限之后又改了，要重启读取服务才会发现） |
| 连接数 | 账号的连接数上限设成 1：读取服务出 bug 也开不出第二个连接 | 数据库（MySQL `MAX_USER_CONNECTIONS 1`、PostgreSQL `CONNECTION LIMIT 1`） |
| 每小时查询数 | MySQL / MariaDB 账号设每小时 120 条语句的上限（正常每小时只有十几条） | 数据库（`MAX_QUERIES_PER_HOUR`；PostgreSQL 没有这一项，靠下面的读取节奏） |
| 单条查询时限 | 每次读的那条 `SELECT` 自带 0.5 秒的库侧时限，到点由库掐掉（卡在表锁、排在 New API 升级的 `ALTER` 后面也一样），不靠客户端断开 | 读取服务每次带上（MySQL 5.7.8+/8 的 `MAX_EXECUTION_TIME` 提示、MariaDB 的 `SET STATEMENT max_statement_time`、PostgreSQL 的连接参数）；PostgreSQL 建议再给角色设同样的值（下面的 SQL 里有） |
| 读得少 | 读取服务只在控制台来问、并且离上次读库已经过了 4 分钟时才读（控制台约每 5 分钟问一次）；每次读：连一次库、发 1 条语句、断开，不留连接池和空闲连接 | 读取服务 |
| 出错不反复试 | 读库出错或超时以后停 10 分钟，再错翻倍，最多停 1 小时；每小时的语句额度到顶（`DB_LIMIT` 里 `max_questions`、`max_connections_per_hour` 那种）停到下一个整点（最多约一小时）；连接数满等其他 `DB_LIMIT` 照普通退避；读库出错时上一份成功的结果最多再给 30 分钟（响应头 `X-Agent-Stale: 1`，失败原因在 `X-Agent-Stale-Reason`） | 读取服务 |
| 占用机器 | compose 里给容器限 `cpus: "0.2"`、`mem_limit: 192m`（要 Docker Compose v2），日志轮转 | Docker |
| 一键停 | `KEY_AGENT_PAUSED=1`（或者直接停容器）：不再读库 | 读取服务 |

诚实的边界：连接数、权限、MySQL 的每小时语句数是数据库强制的；查询时限是读取服务带上的，防得了读取服务自己的 bug，防不了「读取服务进程被人完全控制以后，在那唯一的一个连接上故意烧 CPU」，那种情况下只能靠只读 7 列限住能读到的数据、靠你的库监控看 CPU。最坏的正常情况：New API 升级时对 `channels` 表做 `ALTER`，刚好撞上读取服务那几毫秒的读，`ALTER` 最多多等 0.5 秒。

**换 Key 的发现会慢一些**：读取服务按 5 分钟一次的节奏设计（以前设想的是 1 分钟），所以控制台那一侧（K2a、K2b，还没做）上线以后，渠道里换了 Key，它最多要 5 分钟才发现，这几分钟的钱会在两个渠道之间分得粗一点，合计不变；那一侧「读不到你站的渠道 Key」也会改成连续 3 次读不到（约 15 分钟）才算问题。

### 1. 生成令牌

读取服务和控制台用同一串令牌，装的人自己生成，两边各填一次：

```bash
openssl rand -base64 32
```

**必须用上面这条命令生成，不要自己编。**（`openssl rand -hex 32`、`-hex 16` 生成的也能用。）令牌错了读取服务一律回 401、不限次数，在网上一直猜的唯一防线就是这串令牌够随机。所以太短（不到 32 个字符）、太弱（不同字符少于 10 个、整串是同一段重复、全是数字、全是小写或全是大写字母、含连着 8 位的递增或递减如 `abcdefgh`、`01234567`、含键盘排 `qwerty` / `asdfgh` / `zxcvbn`）的，读取服务起不来，日志里只写一句「令牌太短」或「令牌太弱，请用 openssl rand -base64 32 生成」，不带令牌。令牌填进读取服务的 `RELAY_KEY_AGENT_SECRET`，控制台那一侧上线后，再把同一串填进控制台的「读取服务令牌」。读取服务用它派生出两把互不相干的密钥：一把当请求令牌，一把算指纹；令牌出现在代理日志里时，推不出指纹密钥。

### 2. 建专用账号（必须）

读取服务**不再接受 New API 自己的数据库账号**：MySQL、PostgreSQL 要先建一个专用账号，`/keys` 才读得出东西。账号的权限比下面写的多（包括连接数上限不是 1），读取服务不读，`/keys` 回 503 `ACCOUNT_TOO_BROAD`（进程不退出、不再连库，改好账号后重启容器）。

MySQL 5.7 / 8、MariaDB 10.2+ 都是这样写（`<库>` 换成 New API 的库名，密码自己定）：

```sql
-- '%' 是任何地址都能连：能收窄就收窄，例如换成 compose 网络里读取服务的地址或网段
CREATE USER 'relay_key_agent'@'%' IDENTIFIED BY '换成你生成的密码' WITH MAX_USER_CONNECTIONS 1 MAX_QUERIES_PER_HOUR 120;
GRANT SELECT (id, name, type, status, base_url, `key`, channel_info) ON `<库>`.channels TO 'relay_key_agent'@'%';
```

连接串写成 `KEY_AGENT_DSN=relay_key_agent:密码@tcp(mysql:3306)/<库>`（和 New API 的 `SQL_DSN` 同一种写法）。

PostgreSQL（角色上设的时限和读取服务连接时带的是同一组数）：

```sql
CREATE ROLE relay_key_agent LOGIN PASSWORD '换成你生成的密码' CONNECTION LIMIT 1;
ALTER ROLE relay_key_agent SET statement_timeout = '500ms';
ALTER ROLE relay_key_agent SET lock_timeout = '100ms';
ALTER ROLE relay_key_agent SET idle_in_transaction_session_timeout = '5s';
GRANT CONNECT ON DATABASE "<库>" TO relay_key_agent;
GRANT USAGE ON SCHEMA public TO relay_key_agent;
GRANT SELECT (id, name, type, status, base_url, "key", channel_info) ON channels TO relay_key_agent;
```

上面的 `GRANT` 要先连到 New API 的那个库再执行（`psql -d <库>`），不然 `channels` 表在别的库里、授不上。

连接串写成 `KEY_AGENT_DSN=postgres://relay_key_agent:密码@postgres:5432/<库>`（密码里有 `@`、`/`、`:`、`#`、`?` 这类字符时要先做百分号编码，或者换个只含字母数字的密码）。读取服务靠连接参数 `options` 带查询时限；中间如果有 PgBouncer 这类连接池，要在它的配置里加 `ignore_startup_parameters = options`。

**权限检查的范围**：读取服务只在启动后第一次读之前查一次，看的是账号的全局、整库、整表、列级权限、能不能转授权限、有没有通过角色拿权限、连接数上限（MySQL 看 `information_schema`，PostgreSQL 看角色属性、成员关系和 `has_*_privilege`）。它查不到、只能靠你建账号时照上面的 SQL 只授那 7 列的 `SELECT`：单个存储过程的 `EXECUTE`、MySQL 的 `PROXY` 授权、PostgreSQL 的序列权限和 `schema` 上的 `CREATE`、`SET ROLE`、PostgreSQL 17 新加的 `MAINTAIN` 权限（没有实测）。数据库的版本取不到（握手里没有版本串）时没法查角色，一律不读（`ROLE_UNKNOWN`）。账号的权限之后又改了，要重启读取服务才会发现。

**`channels` 表没有 `channel_info` 列的老版本**：

- MySQL：专用账号用不了。MySQL 对列级授权的账号，读到没授权的列或不存在的列，报的是同一个「没有这一列的权限」（实测 MySQL 8.4），读取服务分不清「老表没这一列」和「有这一列但没给授权」，后者退回会把多 Key 渠道悄悄当成一把 Key，所以一律回 `DB_DENIED`、不退回。请先把 New API 升级到 `channels` 表有 `channel_info` 的版本再装。
- PostgreSQL、SQLite：读取服务读到「列不存在」时自动改成只读其余的，全部渠道当成只有一把 Key，日志记一行 `channel_info_missing`；之后每 10 分钟再试一次带这一列的，New API 升级补上这一列以后会自己用上（日志记 `channel_info_restored`），不用重启。授权里也要去掉它（授权列写 `id, name, type, status, base_url, "key"`）。

SQLite 没有账号，读取服务是用只读方式打开库的，代码里不写库、会话设成 `query_only`，每次读是几毫秒的短事务，不挡 New API 写；但它的进程能改那个库文件，这个风险在这一层去不掉（见第 7 步）。

### 3. 加进自营站点的 compose

和 New API 放在同一个 `docker-compose.yml` 里（New API 那一段的名字下面写成 `new-api`，换成你自己的）：

```yaml
  relay-key-agent:
    image: ghcr.io/zhuyihe/relay-monitor-key-agent:latest
    restart: unless-stopped        # 容器反复退出时 Docker 自己会拉长重启的间隔
    cpus: "0.2"                  # cpus、mem_limit 需要 Docker Compose v2（`docker compose`，不是老的 `docker-compose`）
    mem_limit: 192m
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"
    # 反向代理在宿主机上就留这一行；代理也在 Docker 里就删掉它，用同一个网络访问 relay-key-agent:8790
    ports:
      - "127.0.0.1:8790:8790"
    environment:
      - KEY_AGENT_DSN=relay_key_agent:密码@tcp(mysql:3306)/<库>   # 第 2 步建的专用账号；SQLite 不用这一行，改用下面的 volumes
      - RELAY_KEY_AGENT_SECRET=第 1 步生成的那一串
      # - KEY_AGENT_PAUSED=1       # 一键停：不读库
    volumes:
      - ./data:/data                        # 只有 SQLite 才要：和 new-api 挂同一个目录、同一个 SQLITE_PATH
```

- 数据库照 New API 自己的规则选：`KEY_AGENT_DSN`（或 `SQL_DSN`）以 `postgres://` 或 `postgresql://` 开头是 PostgreSQL，其他非空的是 MySQL，两个都没设是 SQLite（路径照 `SQLITE_PATH`，默认 `one-api.db`）。**MySQL、PostgreSQL 用 `SQL_DSN` 抄 New API 自己的账号会被拒（`ACCOUNT_TOO_BROAD`）**，请用专用账号的 `KEY_AGENT_DSN`；`${SQL_DSN}` 没设值会悄悄变成 SQLite，所以这里不再写它。
- 镜像和控制台的镜像一样放在 GHCR 上：私有的话先 `docker login ghcr.io`，或者在 GitHub 的包设置里把它改成公开。
- 其他环境变量：`PORT`（默认 8790）、`HOST`（默认 `0.0.0.0`，容器的健康检查会按它去连）。DSN 的写法和 New API 自己的有几处不同：`SQL_DSN=local` 当 SQLite 用，`postgres://` 认大小写不敏感，MySQL 的库名里的 `%xx` 会解码，`tls=preferred` 当 `tls=true`。
- 内存：V8 堆上限设成了 64 MB，进程整个实测约 77 MB（1000 个渠道）、约 92 MB（5000 个）、约 133 MB（2 万个），所以 `mem_limit` 设 192 MB；设成 64 MB 会被杀。MySQL、PostgreSQL 不需要写目录，可以在这一段里加 `user: node`，不用 root 跑；SQLite 不能加（见下）。

### 4. 上线前先看影响：`--dry-run`

装好、起服务之前（或者随时）用专用账号读一次，只打数量和原因码，然后退出，不起服务：

```bash
docker compose run --rm relay-key-agent --dry-run
```

成功时是这样（耗时和渠道数以你的为准）：

```
数据库类型：mysql
读取：成功，12 个渠道，用时 3 毫秒
账号权限检查通过：看到的权限只有 channels 表那几列的 SELECT，连接数上限是 1（单个存储过程的 EXECUTE、代理账号这类查不到，部署说明要求只直接授予那几列）
channel_info 列：有
```

失败时打印原因码（见第 9 步），账号权限不合格时还会说是哪一类（全局权限、整库、整表、多了列、写权限、连接数上限不是 1、能转授权限、通过角色拿权限……），退出码是 1。`--dry-run` 和服务各自连一次、读完就断，几乎不会抢那唯一的连接（正好撞上服务那几毫秒的读时它会报 `DB_LIMIT`，再跑一次就行）。

### 5. 让控制台连得到：HTTPS

控制台那一侧上线后只认 `https://` 的读取服务地址，证书照常校验，没有跳过校验的开关。读取服务没有默认地址，要把它的 HTTPS 地址填进控制台设置自营站点的「读取服务地址」；有反向代理的，在你站的反向代理里挑一个路径（例如 `/relay-monitor-agent/`）转给读取服务，并且**把前缀去掉**（读取服务自己只认 `/keys` 和 `/healthz`）。

Nginx（放在你站的 `server { … }` 里；`proxy_pass` 末尾那个 `/` 是去掉前缀用的，不能少）：

```nginx
location /relay-monitor-agent/ {
    proxy_pass http://127.0.0.1:8790/;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $remote_addr;
}
```

Caddy：

```caddyfile
handle_path /relay-monitor-agent/* {
    reverse_proxy 127.0.0.1:8790
}
```

**没有反向代理**的，读取服务自己也能开 HTTPS：把证书和私钥挂进去，设 `TLS_CERT_FILE`、`TLS_KEY_FILE`（两个都要设），可以直接用站点现有的证书。这时控制台里填「https://你的站点:端口」。证书只在启动时读，续期以后要重启这个容器。注意：不设 `TLS_CERT_FILE` / `TLS_KEY_FILE` 时读取服务自己说的是明文 HTTP（控制台那一侧只认 `https://`），所以要么放在带 HTTPS 的反向代理后面，要么设这两个变量。

**直接对外开端口有一个风险**：读取服务在连接数上限（256）以内，一个只发半截请求头的连接最多占约 15 秒（10 秒的时限加上每 5 秒一次的检查间隔）；有人开满连接不停地发半截请求就能让它一直答不了别人（不需要令牌）。所以**推荐放在反向代理后面**，由代理挡掉这类连接；不得不直接对外时，用防火墙只放行控制台的出口地址。**这类请求不会引起读库**：所有请求都只读内存里的缓存，读库只在令牌对的请求来问、并且缓存已经超过 4 分钟时才发生。

`KEY_AGENT_TRUST_PROXY=true` 只影响日志：读取服务把令牌不对的请求按来源地址限制日志条数（每个来源每分钟只记前 10 条，所有来源加起来每分钟最多 100 条，防日志被刷满），藏在代理后面时设上它，来源才取 `X-Forwarded-For` 的最后一个（只认合法的 IP 地址）；不设，来源就是代理本身，也不影响使用。令牌不对的请求一律回 401，不管多少次，令牌对的请求不受影响。

### 6. 读取节奏、断路和一键停

- 读库只在**有人带着对的令牌来问、并且离上次读库已经超过 4 分钟**时发生；其余请求（包括 `If-None-Match` 的 304）只读内存里的缓存。读库是同一时刻只有一次。
- 读库出错或超时以后进入断路：停 10 分钟，再错停 20、40 分钟，最多停 1 小时；这期间来问的请求不碰库：回上次的失败（503 和原因码），或者——上一份成功的结果还不到 30 分钟时——回那一份结果，响应头带 `X-Agent-Stale: 1` 和 `X-Agent-Stale-Reason: <原因码>`（和 503 体里的 `code` 是同一批固定的码；`304` 也带），`readAt` 还是那次读库的时刻（控制台可以据此显示「读到的是 x 分钟前的」；一次瞬时的错不会让它立刻看到 503）。「30 分钟」从**上一次成功读库**算起，不是从出错算起；账号权限不合格（`ACCOUNT_TOO_BROAD`）不给旧结果。读成功一次就清零。每小时的语句额度到顶（`max_questions`、`max_connections_per_hour` 那种 `DB_LIMIT`）停到下一个整点（最多约一小时）；连接数满、库整体连接满这类 `DB_LIMIT` 照普通退避。日志里记一行 `breaker`（原因码、第几次、停多久）。
- 账号权限不合格（`ACCOUNT_TOO_BROAD`）：进程不退出（退出会让容器不停地重启、不停地去连正式库），`/keys` 回 503，不再连库；改好账号后重启容器。
- 一键停：设 `KEY_AGENT_PAUSED=1` 重启（或者直接停容器）。读取服务不读库，`/keys` 回 503 `PAUSED`，控制台按「读不到你站的渠道 Key」处理，不影响结账以外的任何功能。

### 7. SQLite 的几个坑

- New API 的 SQLite 是 WAL 模式，读的一方也要能写 `-shm` 文件。所以数据目录**不能只读挂载**（不要写 `:ro`），读取服务的进程也要和 New API 用同一个用户（New API 的官方镜像里是 root，所以不要给读取服务加 `user:`）。
- WAL 模式的库在 New API 干净关闭以后，数据目录里没有 `-wal` 文件。这时读取服务**不读**（回 `DB_UNREACHABLE`，日志里 `driver` 是 `SQLITE_NO_WAL`）：只读方式打开它会留下空的 `-wal` / `-shm` 文件，New API 下次启动可能因此写不了。New API 在跑时 `-wal` 一直在，不受影响。
- 读取服务是用只读方式打开库的，代码里不写库。但它的进程能改那个库文件：SQLite 没有账号可以收窄，这个风险没有办法在这一层去掉。

### 8. 装好以后怎么验

```bash
docker compose up -d relay-key-agent
curl -s http://127.0.0.1:8790/healthz        # 回 {"ok":true,"v":1}
docker compose logs --tail 20 relay-key-agent
```

开了 `TLS_CERT_FILE` 的，上面的 `http://` 换成 `https://`，并加 `-k`（证书对的是你的域名，不是 127.0.0.1），或者直接用域名访问。

带令牌读一次渠道（请求令牌是第 1 步那一串派生出来的，不是原串；在控制台设好以后控制台会自己读，这里只用来排错）。令牌不要打到终端或 shell 历史里，下面这条直接把它交给 curl，不显示出来（同样，开了 TLS 要换 `https://` 并加 `-k`）：

```bash
docker compose exec -T relay-key-agent node -e 'import("/app/lib/key-fingerprint.js").then(m => console.log("Authorization: Bearer " + m.deriveAgentKeys(process.env.RELAY_KEY_AGENT_SECRET).token))' | curl -s -H @- http://127.0.0.1:8790/keys
```

回的是每个渠道的 `id`、`name`、`type`、`status`、`baseUrl` 和每把 Key 的打码 `m`、指纹 `f`，看不到完整的 Key。Vertex 的账号文件、`ak|sk` 这类不是一把 Key 的渠道回 `keyless: true`，不给打码；百度（15）、讯飞（18）、AWS（33）、Codex（57）这几类渠道类型整类按 `keyless` 处理，包括 AWS 的 api-key 模式（`key|region`）：这些渠道的 Key 控制台比不了，不进对账。

### 9. 读不到时看哪里

`/keys` 读不到库时回 503，body 里 `code` 是原因，日志里也有同一个码（日志不写连接串和库的报错原文）：

| `code` | 原因 | 怎么办 |
|---|---|---|
| `DB_UNREACHABLE` | 连不上：库没起来，地址、端口填错，库文件路径不对，被防火墙挡住，连接被掐断；SQLite 是 WAL 模式的库没有 `-wal`（New API 没在跑） | 核对 `KEY_AGENT_DSN` / `SQLITE_PATH`；SQLite 要把 New API 的数据目录挂进来、New API 要在运行 |
| `DB_DENIED` | 账号或密码不对，或者账号没有读 `channels` 那几列的权限（包括 MySQL 老表没有 `channel_info`，见第 2 步） | 对照第 2 步的授权；SQLite 是数据目录被只读挂载了 |
| `DB_TIMEOUT` | 那条查询超过 0.5 秒被库掐掉（`channels` 被锁住了、库很忙），SQLite 是等锁超过 0.2 秒 | 一般是 New API 在做大的改表或维护，过一阵自己恢复；长期出现请看库的负载 |
| `DB_LIMIT` | 账号的连接数上限或每小时语句额度到顶（MySQL 1226 / 1203、PostgreSQL 53300），或者库的总连接数满了 | 额度到顶读取服务停到下一个整点，连接数满照普通退避（最多停 1 小时）；要是持续出现，看是不是别的东西在用这个账号 |
| `TABLE_MISSING` | 库里没有 `channels` 表（PostgreSQL 查权限时发现的，日志里 `driver` 是 `CHANNELS_MISSING`，不会把「账号检查通过」记下来） | 连到的不是 New API 的库 |
| `ACCOUNT_TOO_BROAD` | 账号权限比第 2 步写的多（日志里 `driver` 是简短的类别：`GLOBAL_PRIVILEGE`、`SCHEMA_PRIVILEGE`、`TABLE_PRIVILEGE`、`COLUMN_PRIVILEGE`、`ROLE_ATTRIBUTES`、`OTHER_TABLES`、`WRITE_PRIVILEGE`、`TABLE_WIDE_SELECT`、`EXTRA_COLUMNS`、`CONNECTION_LIMIT`、`GRANT_OPTION`、`ROLE_GRANTED`、`ROLE_MEMBERSHIP`、`ROLE_UNKNOWN`） | 照第 2 步重新建专用账号，重启容器；用 `--dry-run` 看说明 |
| `PAUSED` | 设了 `KEY_AGENT_PAUSED=1` | 去掉它、重启 |
| `DB_ERROR` | 其他没认出来的错 | 看 `docker compose logs relay-key-agent` 里 `driver` 一栏 |

令牌不对（控制台和读取服务填的不是同一串）一律回 401，不说原因；先核对两边的令牌。起不来时容器日志里会说是哪项没配对，**不会把令牌或连接串写进日志**。

### 搬服务器

读取服务跟着 New API 的 compose 一起搬，上面那几行原样拷过去。地址变了就在控制台里改读取服务地址，令牌不用换。

## 初始账号

- 首次初始化会创建 `admin / admin123`。
- 使用初始密码登录后只能修改账号密码或退出；请立即设置至少 6 位的新密码。
- 改密会让所有现有会话失效，需使用新密码重新登录。

## 合并重复的上游

同一个上游账号被加成了好几个上游时（类型、站点地址、账号 ID 三样都一样），每个都会读一遍余额和用量，成本估算里同一个账号被算了好几遍。合并就是留下创建最早的那个，把其余的并进它：它们从上游列表、轮询、成本估算里消失；它们的看余额关联和绑定改指向留下的那个；它们的地址和「渠道里用的其他地址」并进留下那个的别名，渠道照样对得上。凭据、余额历史都不删，账本不动，不会触发重结。

**不会自动合并。** 升级以后什么都不变；先看清单，确认了才合。上游列表顶上有要合的组时会出一条提示，点「查看」打开「合并重复的上游」抽屉，一组一组确认合并；合错了在抽屉最下面的「合并记录」里点「退回」。下面的接口就是页面用的那几个，也可以自己调。

- 看清单（只读，不改任何数据）：登录后访问 `GET /api/upstream-merges`。每一组写着留下哪个、并进去哪些、跟着改指向的绑定和关联有几个、合并前后近 7 天和近 30 天的成本估算（合并前是这个账号下每个上游各算一遍再加起来，合并后只算留下的那个）。`counts` 是几组能合、几组合不了；`records` 是合并记录（每一次合并改了哪几个上游、什么时候、退回过没有、现在还退不退得回）。`?estimate=0` 只出清单、不估算（估算要读上游的用量）。有「挡着不能合的事」（监控状态不一样、算不算进利润不一样、被合掉的有固定成本、同一把 Key 在两个上游里各有一条绑定）的组会写明，不让合。
- 合并一组：`POST /api/upstream-merges`，body 是 `{ "retainedId": "留下的", "mergedIds": ["被合掉的", …] }`，清单上看到的是什么就带什么，对不上（清单已经变了）就不合。上游文档、绑定、关联、合并日志在同一个事务里改，要么全成要么全不变。留下的没设汇率而被合掉的设了、两个上游监控状态不一样、算不算进利润不一样、被合掉的记了固定成本或标了转售 Key、同一把 Key 在两个上游下各有一条绑定，这几种不让合（卡片上写清是哪一项、去哪里改）；两边汇率都设了但不一样时可以合，合并以后按留下的那个算。

### 想改回去

每一次合并改了什么、旧值是什么，都记在 `upstream_merge_log` 里，照它能原样改回（只改合并时碰过的两处上游字段，加密的登录信息不动）。

服务在跑时：`POST /api/upstream-merges/undo`，body 是 `{ "mergeId": "合并记录里那一次的编号" }`，和下面的脚本是同一段代码，上游文档、绑定、关联、日志同一个事务改回。被合掉的上游后来删了就退回不了（`records` 里写着原因）。

服务停着时用脚本。**要先停掉服务**再运行（服务把上游放在内存里，改完要重启才看得到）：

```bash
cd ~/relay-monitor
docker compose stop relay-monitor
docker compose run --rm --no-deps relay-monitor node db/k-unmerge.js
```

输出会列出要改回的每件事。**看清楚再做下一步。** 只想改回其中一次，加 `--merge 编号`（编号在列出的第一行）。确认后加 `--apply --service-stopped` 真的改（后一个表示你已经停掉了服务：服务还在跑的话，它的内存会把改回去的盖掉，所以不带它脚本不改），再启动。**目前没有做「服务在不在跑」的检测，靠 `--service-stopped` 这句自己声明**：如果服务其实还在跑时硬加了它，最坏的后果是——脚本把日志标成「已退回」、库里的上游文档改回去，随后服务把内存里仍是「已合并」的文档又写回库里；之后这次合并在日志里显示已退回，上游实际又是合并状态，既退回不了、页面上也看不出来。所以一定照上面先停服务。

```bash
docker compose run --rm --no-deps relay-monitor node db/k-unmerge.js --apply --service-stopped
docker compose up -d relay-monitor
```

- 合并之后新建的、指向留下那个上游的绑定不动（它们本来就该指向它）。
- 合并以后在留下的上游上自己加的成本匹配地址留着，只去掉合并时加进去的那几个。
- 不跑脚本、直接换回合并之前的旧镜像也能用：旧版本不认「已合并」，被合掉的上游会重新出现、重新被轮询（和合并之前一样，只是重复）；绑定指向留下的那个，是同一个账号，Key 编号都对得上。换回旧镜像期间，如果对被合掉的上游做过改动（旧版本看得见它们），以后再用新版本退回那次合并时，会按「这次合并之后上游又变过」退不了，要先处理。`upstream_merge_log` 这张表旧版本不认识也不读，留着无害。

## 发布前核验

1. 确认公网无法访问 `http://服务器IP:8787`。
2. 确认 HTTPS 登录响应的 `Set-Cookie` 同时包含 `HttpOnly`、`SameSite=Lax` 与 `Secure`。
3. 确认 HTTP 请求会跳转 HTTPS，且不会使用正式账号登录。
4. 使用新密码重新登录，确认旧浏览器会话已失效。
