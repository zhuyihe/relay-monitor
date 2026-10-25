# 中转站余额监控 · Relay Monitor v2

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

> 文档从[总目录](design/README.md)进：想知道什么，看哪一份的哪一节。给开发的规矩见 [CONTRIBUTING.md](CONTRIBUTING.md)。

监控 **sub2api** 与 **new-api** 类中转站余额的自托管面板。
**v2 技术栈**：Next.js 16 全栈（App Router + Route Handlers）+ Ant Design Pro（antd 6 + pro-components）+ MySQL 持久化，浅色 / 深色双主题。

接上自营的 New API 站点以后，还能按天算每个渠道赚了多少（每日利润）。

后端逻辑（站点适配、告警、预测、日报）从 v1 平移而来；存储从 JSON 文件升级为 MySQL（余额历史落表，供经营分析 SQL 聚合）。

## 功能

页面名以[用语规范](design/ui-copy-spec.md) §11 为准；每一页放什么、为什么这样排，见[设计规范](design/ui-design-spec.md) §5。

- **运营总览**：今天的利润等式（收入 − 上游成本 = 毛利，毛利 − 固定成本 = 净利）、需处理、各上游还能用几天、今天的收入和上游成本。
- **上游资源**：
  - 上游列表：每个上游的余额、日均花费、可用天数和状态；近 48 小时的余额小图，点开看余额趋势；新增、编辑、归档上游。
  - 今天花费：Sub2API 上游直接读站点自己的今日实际扣费（和站点页面上的数一样），其他类型按余额变化估算，数前带「≈」。
  - 渠道绑定、上游账单：把自营站点的渠道绑到上游的 Key 上，开始算利润（见下面「怎么开始算利润」）。
  - 只用来看余额、或者和别的上游重复计数的上游，可以关掉「算进利润」。
- **自营业务**：自营 New API 站点的用量、收入和消费。
  - 概览：这段时间的用量、利润等式、每日收入、消费最多的用户和模型、预计花费（按过去的规律估以后的花费，写成一个范围）。
  - 用户：每个用户的用量和消费；模型与渠道：按模型、分组、渠道拆开，和上一段同样长的时间比。
  - 按明细细算：逐条看用量记录，补上概览没算进去的缓存和长对话用量。
  - 管理员账号的转售 Key 可以标出来，算进收入。
- **用量分析**：按上游、按模型看 Token 用量，今天到近 30 天。
- **成本估算**：按余额的变化估出上游成本（不是上游的实际账单），加上按天平摊的固定成本；收入与上游成本的趋势、花费时段（星期 × 小时）、可用天数。
- **每日利润**：用自营站点各渠道的收费记录和上游每把 Key 的实际账单，算每条绑定每天的毛利（收入 − 上游成本；一条绑定是上游的一把 Key 和用它的渠道）。每天只有三种状态：实时、已固定、需处理（[用语规范](design/ui-copy-spec.md) §4）。这里算的是账面毛利，不是现金收支：控制台没有记采购和现金的账，充值、余额变化和手填的固定成本只能作参考。
- **告警中心**：
  - 余额提醒：余额偏低、余额用完、读不到余额、快用完、恢复正常。连续读不到几次才提醒；上游标了「不再续费」，余额偏低只提醒一次；每种提醒可以选发给哪几个通知方式。
  - 通知方式 10 种：Telegram、钉钉（加签）、企业微信、飞书（签名）、Bark、ntfy、Server酱、Resend 邮件、SMTP 邮件（零依赖客户端）、自定义 Webhook，每个都能发测试消息。
  - 日报的设置也在这里（日报写什么见下面）。这一页改了马上保存。
- **系统设置**：刷新间隔、历史数据保留、修改密码、软件版本。

其他：

- **Sub2API 用邮箱和密码登录**：控制台自己登录换令牌，过期自动刷新（支持轮换），刷新失败自动重新登录，不用人管。
- **余额预测**：按余额历史（30 天）和近期的花费速度（近 3 小时优先）估算还能用几天；余额趋势里有历史和预计用完的时间。
- **日报**：每天定时发昨天的经营情况：消费和环比，收入、上游成本、毛利、固定成本、净利，消费最多的模型和用户，上游余额和快用完的，预计花费。发到通知方式（邮件是全文，聊天工具里太长会截掉），可以预览、立即发送。
  - 定时日报到达计划时间后最多尝试 5 次，每次失败结束后依次等待 1、2、4、8 分钟再重试。发送进度持久化，部分成功时只重试尚未成功的通知方式；全部当前启用的通知方式成功后才记录当天已发送。达到上限后停止当天的自动尝试，可在排除故障后手动发送，下一天重新开始。外部通知方式已接收但成功进度尚未写库的情况下，进程崩溃后仍可能重复发送。
- **业务时区**：利润、日汇总、经营分析和日报的「今天 / 昨天 / 近 N 天」统一按业务时区划日，与服务器和浏览器时区无关；默认 `Asia/Shanghai`，可用环境变量 `BUSINESS_TIME_ZONE` 覆盖（兼容旧的 `REPORT_TIME_ZONE`）。部署后再改业务时区只影响之后重算的日子，已经汇总过的历史日数据不会重新划日
- **汇率和售价**：每个上游可以设汇率（1 美元 = 多少元），自营站点设售价（1 美元额度 = 多少元）。金额什么时候写 $、什么时候写 ¥，见[用语规范](design/ui-copy-spec.md) §7；余额提醒线按各上游自己的余额比。
- **PWA**：可添加到手机主屏幕独立运行（品牌图标 + 离线壳缓存；静态资源网络优先，API 不缓存）
- **控制台登录**：scrypt 哈希 + HMAC 签名会话 Cookie（7 天，登录失败限流）；初始账号 `admin / admin123`，第一次登录必须先改密码（见[部署说明「初始账号」](deploy/README.md#初始账号)）
- **内置演示**：空库第一次启动会自动建几个演示上游（标「演示」，内置模拟站，能走通登录、过期、自动续期），可以直接删除

## 怎么开始算利润

现在要做三件事，都在「上游资源」里：

1. 设好自营站点：新增或编辑你自己的 New API 站点，打开「这是我的自营站点」；
2. 加上游：「新增上游」，填站点地址和登录信息；
3. 绑定：在「渠道绑定」页签勾上渠道，点「去绑定」，选上游和它的 Key，回答「这把 Key 还给别处用吗？」，确认绑定。

之后「每日利润」按天算每条绑定的毛利。现在从零开始一共约 38 步，明细见[体检](design/ui-audit.md) §8.2 流程一到三。

以后会简化成三步：设置自营站点、加上游、开始算利润，一共点或填 9 下，换 Key 不用管，见[流程梳理稿](design/ux/binding-flow.md)。

## 支持的上游类型

| 类型 | 查询方式 | 需要填写 |
|------|----------|----------|
| **New API 账号** | `GET /api/user/self`，头 `Authorization` + `New-Api-User` | 站点地址、访问令牌、用户 ID |
| **New API Key** | OpenAI 兼容 `/dashboard/billing/subscription` + `/usage` | 站点地址、`sk-` 开头的 Key |
| **Sub2API 账号（登录令牌）** | `GET /api/v1/auth/me`，`Bearer JWT` | 站点地址、登录令牌（过期要手动换） |
| **Sub2API 账号（邮箱密码）** | 自动 `POST /api/v1/auth/login` / `refresh` / `me` | 站点地址、登录邮箱、密码（开启 2FA 的账号不支持） |
| **固定成本** | 不访问任何接口 | 每笔付的钱（¥）和覆盖的天数，按天平摊进固定成本 |

## 运行

不用 Docker、直接跑时，需要一个 **MySQL 8+** 实例（自备）；用 Docker 部署时 MySQL 随 compose 一起起，见下面「Docker 部署」。

```bash
cp .env.example .env.local        # 填入 DB_HOST / DB_PORT / DB_USER / DB_PASSWORD / DB_NAME
npm install
npm run db:migrate                # 建表；若配置了 V1_DATA_DIR 且库为空，一次性导入 v1 数据
npm run build && npm start        # 打开 http://127.0.0.1:3000，账号 admin / admin123
```

开发模式：`npm run dev`。对外只能通过 HTTPS 反向代理开放，见[部署说明](deploy/README.md)。

开发与构建使用 **Node.js 24**（版本提示见 `.nvmrc`）；测试怎么跑、PR 怎么做，见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 从 v1 迁移

v1 的 `data/` 目录（stations.json / history.json / secret.key）可一次性导入：

1. 设环境变量 `V1_DATA_DIR` 指向 v1 的 data 目录（Docker 场景把目录只读挂载进容器）
2. 启动（或 `npm run db:migrate`）：**库为空才导入**，幂等、绝不覆盖已有数据；会话密钥一并沿用，已登录设备不掉线（配了 `RELAY_SECRET_KEY` 时第一次启动会换新会话密钥，要重新登录一次）
3. 导入完成后可移除 `V1_DATA_DIR` 配置

## Docker 部署（含 Watchtower 自动更新）

镜像随 main 分支推送自动构建：`ghcr.io/zhuyihe/relay-monitor:latest`（和 `deploy/docker-compose.yml` 里的一样）。

```bash
mkdir -p ~/relay-monitor && cd ~/relay-monitor
# 把 deploy/docker-compose.yml 下载到这个目录。MySQL 随 compose 一起起，
# 在同目录的 .env 里填 DB_NAME、DB_USER、DB_PASSWORD、DB_ROOT_PASSWORD，
# 再配上登录信息加密密钥（单独备份好）：
echo "RELAY_SECRET_KEY=$(openssl rand -base64 32)" >> .env
docker compose up -d
```

- 对外只能通过 HTTPS 反向代理开放。compose 把应用端口绑在本机的 `127.0.0.1:8787`，给同一台机器上的反向代理用，不要直接开到公网。
- `TRUST_PROXY` 默认不开：只有应用端口不能被公网直连、反向代理又会清理外部伪造的转发头时，才设成 `true`。
- 这几条怎么配、上线前怎么核验，见[部署说明](deploy/README.md)。
- compose 给 watchtower 挂了 `docker login` 的凭证（`/root/.docker/config.json`），拉私有镜像时用，说明在 compose 的注释里。

已经在跑的部署：先确认 compose 文件里有 `- RELAY_SECRET_KEY=${RELAY_SECRET_KEY:-}` 这一行（Watchtower 不会更新 compose 文件），否则 `.env` 里的密钥传不进容器。整目录备份时排除 `.env`，别让密钥和 `mysql-data/` 进同一份备份。开启后的收尾、密钥丢了怎么办，见 [deploy/README.md「登录信息加密」](deploy/README.md#登录信息加密)。

- **relay-monitor**：控制台本体（启动顺序：迁移脚本 → Next standalone 服务）；数据全部在 MySQL，容器无状态、升级不丢数据
- **db**：MySQL 8，数据在同目录的 `mysql-data/`
- **watchtower**：自动拉取新镜像并重启控制台；「系统设置 → 关于」里的「软件版本」可以看运行的版本，括号里是提交编号

## 通知方式速查

| 通知方式 | 需要 |
|------|------|
| Telegram | Bot Token + Chat ID |
| 钉钉 | 群机器人 Webhook（安全设置选「加签」则再填密钥） |
| 企业微信 | 群机器人 Webhook |
| 飞书 | 群机器人 Webhook（可选签名密钥） |
| Bark | Device Key（可自建服务器） |
| ntfy | Topic（可自建服务器 / 访问令牌） |
| Server酱 | SendKey（自动识别 sctp 新版 key） |
| Resend | API Key + 已验证域名的发件人 + 收件人（逗号分隔多个） |
| SMTP | 服务器地址 + 端口（465 SSL / 587 STARTTLS）+ 账号密码 + 发件人 / 收件人 |
| Webhook | 任意 URL，POST JSON `{title, body, event, station, ...}` |

## 目录结构

```
relay-monitor/
├── app/                  Next.js App Router
│   ├── (dashboard)/      页面：运营总览 / 上游资源 / 自营业务 / 用量分析 / 成本估算 / 每日利润 / 告警中心 / 系统设置
│   ├── api/              接口（Route Handlers）
│   ├── components/       各页共用的组件
│   ├── mock/             内置演示站 mock（Sub2API / New API 完整链路）
│   └── login/            登录页
├── server/               后台常驻逻辑：refresh.js 刷新循环 / reconciliation.js 每日利润 / report.js 日报 / demo.js 演示站
├── lib/                  providers / alerts / notify / smtp / forecast / auth / profit / 界面文案表 + runtime 单例
├── db/                   MySQL 层：pool / store（写透缓存）/ history / migrate（v1 导入）/ secrets（登录信息加密）/ reset-secrets（密钥丢了时清掉解不开的）
├── deploy/               docker-compose.yml 和部署说明
├── design/               设计文档，从 design/README.md（总目录）进
├── instrumentation.ts    服务启动钩子：初始化 + 定时刷新 + 日报调度
└── public/               PWA manifest / 图标 / service worker
```

## 安全说明

- 面板密码以 scrypt 哈希存储；会话为 HMAC-SHA256 签名的 HttpOnly Cookie
- 上游的令牌、Key、密码、登录邮箱保存在你自有的 MySQL（`stations` 表），通知方式的密钥和会话密钥保存在 `meta` 表。配置 `RELAY_SECRET_KEY` 后用 AES-256-GCM 加密保存，只在读写数据库时加解密；**没配时是明文保存**，启动日志和「系统设置」页顶会提醒。加密只防数据库或备份单独外泄，密钥要和备份分开放（见 [deploy/README.md](deploy/README.md#登录信息加密)）
- 每日利润记下的「Sub2API 上游能不能按 Key 读账单」，按连接身份存在 `reconciliation_billing_capabilities` 表。身份使用带版本的 HMAC 包装，密钥随机生成、和登录信息一样加密存在 `meta` 表；每次启动都会包装旧格式行，包括回滚期间旧版本新增的行，保留核验结果和时间。配了 `RELAY_SECRET_KEY` 时，拿到库也没法拿它离线撞密码（旧备份和二进制日志里仍可能有旧格式，按 [deploy/README.md](deploy/README.md#登录信息加密) 清掉；没配时这把密钥也是明文）
- 接口不回传上游的令牌、Key、密码，也不回传通知方式的密钥，只告诉前端「已保存」
- 改了上游或通知方式的地址（协议、主机、端口任一变了），已保存的令牌、密码不会带过去，要重新填，避免被发到新地址
- 日志只记报错的码和一句话，不打印数据库语句和参数
- SMTP 端口不是 465、服务器又不支持 STARTTLS 时，不发送邮箱密码
- 构建产物经文件追踪排除，凭证目录绝不进入镜像

## 开源协议

[MIT](LICENSE) © lettimepassby
