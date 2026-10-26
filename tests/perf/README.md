# 对拍和「接口和后台」性能实测

在一个大数据量夹具上，让两个版本（base、head）：

- **对拍（结账）**：把最近 N 天（默认 14）重新结一遍，逐行逐字段比两边写进账本的内容；
- **性能**：各量一次接口（冷 1 次 + 连续 10 次）和后台（稳态 185 秒），比请求数、SQL 条数、扫描行数、字节。

默认在 GitHub Actions 上跑（`.github/workflows/perf.yml`，手动触发）。本机只在 CI 跑不了时用。

数据全是假的：一个进程模拟 50 个上游和 1 个自营 New API，数字由确定性模型算出来，没有生产信息。

## 文件

| 文件 | 做什么 |
|---|---|
| `run.sh` | 编排：`local`（本机一条命令）、`all`、`seed`、`measure`、`parity`、`compare`、`stop`。CI 一步一个子命令 |
| `lib/model.mjs` | 确定性数据模型：50 个上游、300 个自营渠道、80 条绑定、500 个用户、每天 10 万条日志（第 k 条全由 hash(k) 决定），按小时预聚合。`PERF_BINDINGS=N` 只接入前 N 条绑定（见「整站读场景」） |
| `lib/env.mjs` | 环境变量（库、端口、应用目录、结果目录）、登录、进度日志 |
| `lib/ps.mjs` | performance_schema 语句摘要的快照和差值、binlog 字节、看门狗（夹具库里跑超过 60 秒的查询直接 `KILL QUERY`） |
| `lib/metrics.mjs` | 后台稳态窗口折成「每轮结账轮询」 |
| `lib/kill-queries.mjs` | 停服务时把它留在 MySQL 里还在跑的查询杀掉 |
| `fake-site.mjs` | 假站点：44 个 New API、4 个 Sub2API、2 个只用 Key 的上游和 1 个自营 New API（`/na01`…`/s245`…`/nk49`、`/own`），每个请求延迟 50 ms（`FAKE_DELAY_MS`）。`/__stats[?reset=1&detail=1]` 看请求计数，`/__ctl?delay=` 改延迟 |
| | 开关：`FAKE_TEST_LOGS=1`（默认关）让自营站点的 `/api/log/`、`/api/log/stat` 里多出渠道测试日志（照 New API 的写法：token_name「模型测试」、token_id 0，每 10 分钟测一遍 300 个渠道） |
| | 开关：`FAKE_OWN_RATE_LIMIT=1`（默认关）给自营站点加全站限流（同一来源 180 秒 360 个请求，超了回 429 带 Retry-After，被拒的数在 `/__stats` 的 `ownRateLimited`） |
| | 开关：`FAKE_USER_ROLES="1:1,450:100"`（默认空）改用户列表里的角色（把 root 列成普通用户、user450 列成超级管理员） |
| | 开关：`/__ctl?down=/na01,/na02` 让这些上游一律回 503（像上游挂了），`down=` 清空 |
| | 自营 `/api/log/` 分两类计数：不带 `username`/`token_name`/`channel`/`model_name`/`group` 的是整站读（`all`），带任何一个的是 `filtered`；`/__stats` 的 `ownLogKinds`，`detail=1` 的请求时间线里这类请求多一项类别 |
| `seed/00-config.mjs` | 定夹具起点（92 天前的 UTC 零点）和哪些（上游, 分组）40 天前换过倍率，写 `$PERF_OUT/fixture/config.json` |
| `seed/01-base.mjs` | 删库重建、建表（应用的 `ensureSchema`），用应用的 `Store` 写自营站点、面板账号 admin/admin123、通知方式、日报 |
| `seed/02-onboard.mjs` | 服务在跑：走「接入渠道」同一条接口建 50 个上游和 80 条绑定 |
| `seed/03-history.mjs` | 服务停着：创建时间搬回起点，记 11 次倍率变化，灌余额历史（51 站 × 90 天 × 每分钟一点 = 660 万点，不进 binlog），算日汇总 |
| `seed/04-recon.mjs` | 服务在跑：最近 90 天每天一次 `POST /api/reconciliation/query {observe:true}`，让应用自己结账；再补「今天」观测快照和约 10% 的重结版本 |
| `parity.mjs` | 对拍：`move`（最近 N 天的账本挪进备份表）、`settle <标签>`（结一遍、导出）、`reset`、`restore`、`diff` |
| `measure/api.mjs` | 接口：每个接口冷 1 次 + 连续 N 次，p50/p95、返回体字节、状态码 |
| `measure/background.mjs` | 后台：稳态窗口里假站点请求（按路由）、SQL 条数和扫描行数（按语句摘要）、binlog 字节、进程 CPU/内存、每轮结账轮询；再单独一轮 `POST /api/refresh` |
| `measure/db.mjs` | `snap`/`report`：表行数和大小；测量期间所有语句按摘要统计，查询语句逐条 EXPLAIN |
| `measure/summarize.mjs` | 一次测量写成 markdown 表（`summary.md`） |
| `measure/compare.mjs` | base 对 head 的对比表（`compare.md`），只在可比的数上标超线 |

## 一次跑的顺序

`run.sh all`：

1. **seed**（用 base 的代码）：建夹具；
2. **measure base**：起 base，预热到假站点 8 秒没有新请求，量接口和后台，停服务后出数据库统计；
3. **parity**：账本最近 N 天（业务时区 Asia/Shanghai 的自然日，不含今天）全部绑定的行挪进备份表 → 起 base 每天结一遍、导出 → 删掉 base 写的、起 head 从同一个起点再结一遍、导出 → 把备份插回去（夹具恢复原样）→ 逐字比较；
4. **measure head**：同 2；
5. **compare**。

base 的性能放在对拍前面量：head 启动时 `ensureSchema` 可能改表，base 要在没被改过的表上量。

## 本机怎么跑

要 Node 24、一个能连的 MySQL 8（开着 binlog 和 performance_schema，用户能建库、`KILL QUERY`、`SHOW BINARY LOGS`）。**用单独的库**，种子会删库重建：库名必须带 `perf`，别用测试台正在用的库。

```sh
DB_PORT=3307 DB_NAME=relay_monitor_perfci APP_PORT=3311 FAKE_PORT=18960 PERF_OUT=/tmp/perfci \
  tests/perf/run.sh local origin/main HEAD
```

- `local` 把两个提交各检出到 `$PERF_OUT/apps/<sha>`（`git worktree`）、`npm ci`、`next build`，同一提交只打一次，然后跑 `all`。用完 `git worktree remove $PERF_OUT/apps/<sha>`，再删库。
- 约 15 分钟（打包另算：装依赖、打包每个提交 1–2 分钟）；笔记本会热，和别的重活错开。
- 只想调脚本：`PERF_HISTORY_DAYS=2 RECON_DAYS=3 PARITY_DAYS=2 BG_SEC=30 API_N=1` 几分钟跑完（数字不能当真）。
- 结果目录里 `progress.log` 一行一段，`logs/` 是服务、假站点、打包的日志。

## CI 怎么触发

Actions → **Perf (parity + API/background)** → Run workflow，或：

```sh
gh workflow run perf.yml -R zhuyihe/relay-monitor -f pr=123
gh workflow run perf.yml -R zhuyihe/relay-monitor -f base=<SHA 或分支> -f head=<SHA 或分支>
```

- 给 `pr`：head 是 PR 的最新提交，base 是它和目标分支的分叉点（只量这个 PR 自己的改动）。
- 不给 `pr`：`base` 空 = main，`head` 空 = 触发时选的分支。
- `parity_days`：对拍天数，默认 14；`history_days`：余额历史天数，默认 90；`fake_test_logs`：勾上就给假站点带 `FAKE_TEST_LOGS=1`（自营站点多出渠道测试日志），默认不勾。
- `bindings`：绑定条数，空 = 80；`expected_cost`：打开「算应付成本」（整站读）再量后台，默认不勾（和产品默认一样，整站读 0 个请求）。见下面「整站读场景」。
- 测量脚本用触发时选的分支里的 `tests/perf`，不用被测版本里的。
- 用时约 22 分钟：两版各装依赖、打包约 40 秒，建夹具约 5 分钟，每次测量约 6.5 分钟，对拍（14 天）约 1 分钟。余额历史用默认的 90 天就在 60 分钟的上限里，不用缩。

## 整站读场景（小夹具，「算应付成本」开着）

「算应付成本」打开后，每轮结账轮询结束时控制台按小窗口读自营站点不带筛选的 `/api/log/`（整站读）。它和别的读取共用 New API 默认的全站限流（同一来源 180 秒 360 个请求），自己最多用 25%，还要给别的读取留 120 个。80 条绑定的大夹具里别的读取就把额度占满了，整站读一页都分不到；这个场景用 5 条绑定，别的读取照常开着，量整站读真开起来是什么样。

```sh
gh workflow run perf.yml -R zhuyihe/relay-monitor --ref main -f pr=<号> -f bindings=5 -f expected_cost=true -f fake_test_logs=true
```

- `bindings=5`（`PERF_BINDINGS=5`）：只接入前 5 条绑定、它们所在的 3 个上游和 2 个只用 Key 的上游。数据模型不变：自营站点照旧 300 个渠道、每天 10 万条日志（加上测试日志），没接入的渠道照旧有消费，整站读要读的量和大夹具一样。不设时和原来逐字一样。
- `expected_cost=true`（`PERF_EXPECTED_COST=on`）：后台测量开始前 `PUT /api/settings {expectedCost: true}`，等第一轮整站读建好进度（最多 150 秒）再开稳态窗口。不勾时不开。
- 要量整站读追得多快，可以把稳态窗口放长（本机 `BG_SEC=600`；CI 用默认 185 秒）。

三样数在 `compare.md`（Summary 里）「整站读」一节、各自的 `summary.md`，原始数在 `background.json` 的 `steady.ingest`：

- **每轮实际请求数**：稳态窗口里每轮结账轮询（从这一轮第一个渠道账单前 2 秒到下一轮同一点）对自营站点不带筛选的 `/api/log/` 几个，以及对自营站点全部几个。每轮明细还有「问额度前 180 秒已用」和按 `lib/own-request-budget.js` 的规矩推算的额度 `min(90, 360 − 120 − 已用)`：整站读是 0 时看这两个数，是额度分不到还是别的原因。
- **限流占比**：稳态窗口里任意 180 秒（滑动）对自营站点的最多请求数 ÷ 360，和平均（窗口总数折成 180 秒）÷ 360；整站读和自营站点全部分开报。窗口不到 180 秒时「最多」就是整个窗口的数。全部的占比接近 100% 就是快撞到站点限流了。
- **追平用时**：窗口开始和结束各读一次 `own_log_cursor.covered_to_ms`，落后 = 现在 − 120 秒 − 进度；「每分钟追了」= 进度挪了多少 ÷ 过了多久（每过 1 分钟读完几分钟的日志，大于 1 才追得上）。推算从刚打开（进度从昨天 0 点起）到追平 = 刚打开时落后多少 ÷（每分钟追的 − 1）。落后超过 1 小时时每轮最多 15 页、不到 1 小时 6 页，窗口里测到的是哪一段的速度，推算就按哪一段算，只看量级。base 没有 `own_log_cursor` 表（旧版）时写「不适用」。
- 请求数、占比算可比；落后、追平用时只做参考（随机器快慢和夹具起点变）。这一节只列数，不判超线。

## 结果怎么看

- 运行页的 Summary：各段用时、对拍结果（`parity.md`）、性能对比表（`compare.md`）。
- 整个结果目录是 artifact `perf-<run id>`：`base/`、`head/`（各自的 `summary.md`、`api.json`、`background.json`、`db.json`）、`parity/`（`base.json`、`head.json` 是两边导出的账本、`parity.md`）、`logs/`、`timings.txt`。
- **对拍**有任何不同（少了的行、多出的行、内容不同的行），parity 那一步标红，但后面的性能照样量。
- **性能**超线时 compare 那一步标红（退出码 2），表里超线的项标 ⚠。

### 对拍比什么

账本 `reconciliation_ledger` 里这 N 天的行，按 `rule_id`、`bill_date`、`revision` 对齐，比两边都有的列（head 加了列也不算不同）。不比每次都会变的：`settled_at`、`version_id`，`detail` 里的 `generatedAt`、`resultGeneratedAt`、`origin`（手动还是轮询结的）、`ratioObservedAt` 等（见 `parity.mjs` 的 `VOLATILE_KEYS`，可以用 `PARITY_IGNORE_KEYS=a,b` 再加）。

### 性能哪些数可比、哪些只做参考

两边在同一台机器、同一个夹具上前后脚量，**数数的**可比，**计时的**不可比（CI 机器快慢不一，同一提交两次能差几十 %）。

| 可比（数出来的，超线规则只用在这一列） | 只做参考（标「参考」，不算超线） |
|---|---|
| 返回体字节、状态码 | 接口 p50/p95、冷请求毫秒 |
| 每轮结账轮询：SQL 条数、对假站点的请求数、binlog 字节、扫描行数 | SQL 耗时、一轮余额刷新的毫秒 |
| 一轮余额刷新：SQL 条数、请求数、`stations` 表写入行数、扫描行数 | 服务进程 CPU、内存 |
| 稳态每分钟的 SQL 条数、扫描行数、请求数、binlog；假站点按路由的请求数 | 启动用时 |
| 新出现的语句和它们的 EXPLAIN | |

超线规则沿用测试台基线报告第 8 节（CONTRIBUTING.md 4.3），只用在可比的数上：

- 返回体比 base 涨超过 20% 且多出 2 KB 以上，或超过 1 MB；base 是 200、head 不是 200；
- 一轮余额刷新、每轮结账轮询的 SQL 条数、请求数、binlog 比 base 涨超过 20%；`stations` 表写入行数比 base 多；
- 新出现的语句每次扫描超过 1 万行，或 EXPLAIN 里有全表扫描（type=ALL 且 rows > 1000）。

base 本来就超了绝对线的（比如有的接口返回体已经超过 1 MB），head 没更差就标「base 已超」，不算超线。阈值能用环境变量调，见 `measure/compare.mjs` 开头。

扫描行数、稳态每分钟的数只列出来不判超线：窗口里两个循环各跑几轮不一定一样，波动比每轮折算的大。

### 余额历史天数

`PERF_HISTORY_DAYS`（workflow 的 `history_days`）默认 90：51 个站点 × 90 天 × 每分钟一点，660 万点。缩短以后灌得快，但读余额历史的接口数字会变小，不能和 90 天的结果比：经营分析 `/api/analytics` 30/90 天、余额曲线 `/api/stations/<id>/history` 30 天、`/api/history/overview`、`/api/settings/history-preview`。结账和对拍不读余额历史，不受影响。base 和 head 用的是同一个夹具，同一次运行里两边照样可比。

## 已知的局限

- 页面（首屏、轮询）和打包体积这次没搬，还在测试台上量。
- 夹具每次现建，「今天」类接口随时间变化：base 和 head 前后差十来分钟，返回体会有小的差别（阈值留了余量）。
- 毫秒在 CI 上只做参考；要看耗时，在同一台机器上前后脚量 base 和 head，还是得在测试台上。
- 同一提交对同一提交，每轮结账轮询的 SQL 条数也能差 10% 上下：后台有一批渠道状态同步（`reconciliation_rule_channels` 的 UPDATE，约 280 条）落不落在 185 秒的窗口里不一定，这批语句也可能出现在「新出现的语句」里（扫描 1 行，不算超线）。离 20% 的线有余量，但 head 小幅变多会被它盖住一点。
