# 上游渠道对账：代码评审遗留项

针对 PR #1 / #3 / #4 / #5 合并后的对账实现（`server/reconciliation.js`、
`server/reconciliation-repository.js`、`lib/providers.js`、`db/pool.js`）的评审结论。
每条任务都写了位置、现象、修改要求和验收标准，可以独立完成、独立提交。

## 前置：怎么跑测试

仓库默认的 `node` 是 v14，没有 `node --test`，`npm test` 会直接报 `bad option: --test`。
必须切到 Node 24：

```bash
export PATH="$HOME/.nvm/versions/node/v24.9.0/bin:$PATH" && npm test
```

当前 main 的基线是 `pass 87 / fail 1`（失败项见 T1）。修完 T1 后基线应为全绿，
之后每条任务都不允许让它再变红。

---

## T1（必修）测试断言依赖并发到达顺序，main 上 `npm test` 是红的

**位置** `server/reconciliation.test.js:568`，测试 `跨分段窗口分别核算并以合计金额重算毛利率，同时保留渠道禁用状态`

**现象**

```
actual:   [ { tokenName: 'stable', group: null, start: 1030, end: 1059 },
            { tokenName: 'stable', group: null, start: 1000, end: 1029 } ]
expected: [ { tokenName: 'stable', group: null, start: 1000, end: 1029 },
            { tokenName: 'stable', group: null, start: 1030, end: 1059 } ]
```

断言要求 mock server 收到的 `statRequests` 按分段先后顺序排列，但
`server/reconciliation.js:461` 是并发扇出：

```js
const segmentResults = await Promise.all(applicable.map(async ({ segment, segmentWindow }) => {
```

到达顺序不受控。在 Node 24.9.0 / macOS 上连跑 5 次全是反序，不是偶发。

**修改要求**

断言想表达的语义是对的——「每个半开分段各查一次自己的 token-only 窗口，不重叠」——
保留这个语义，只去掉对顺序的依赖。比较前按 `start` 排序即可，例如：

```js
assert.deepEqual([...statRequests].sort((a, b) => a.start - b.start), [
  { tokenName: "stable", group: null, start: 1000, end: 1029 },
  { tokenName: "stable", group: null, start: 1030, end: 1059 },
], "each half-open segment must query its own token-only window exactly once");
```

不要改成串行请求来迁就测试——并发扇出是有意的。

**验收**
- `npm test` 全绿（`fail 0`）。
- 连续跑 5 次结果稳定。
- 「每个分段各查一次、窗口半开不重叠」这三点断言强度不降低（数组长度仍是 2，起止仍被校验）。

---

## T2（必修）`lastSuccessfulResults` 从不清理：既是脏数据也是内存泄漏

**位置**
- `server/reconciliation.js:216` `clearRuleResults()`
- `server/reconciliation.js:210` `lastSuccessfulResults` 的创建
- 调用点：`:371`（保存规则）、`:717`（归档规则）、`:734`（修正切换时间）

**现象**

`clearRuleResults` 只删 `resultCache`，完全不动 `lastSuccessfulResults`：

```js
function clearRuleResults(ruleId) {
  const prefix = `${ruleId}:`;
  for (const key of resultCache.keys()) {
    if (key.startsWith(prefix)) resultCache.delete(key);
  }
}
```

两个后果：

1. **脏数据**。`ReconciliationRepository.correctTransition()`
   （`server/reconciliation-repository.js:347`）特意在同一事务里
   `DELETE FROM reconciliation_snapshots` 作废受影响分段的快照，但内存里那份
   "最近成功结果"还在。之后上游一挂，`inspectRule` 的兜底分支
   （`server/reconciliation.js:538`）会优先读内存：

   ```js
   const previous = lastSuccessfulResults.get(cacheKey)
     || await repository.latestSuccessfulResult(rule.id, window).catch(() => null);
   ```

   于是把「按旧分段边界算出来的数」当 stale 展示出来，而 DB 里那份已经被作废了。
   `updateRule` 改渠道集合同理：展示的会是旧渠道集合口径的收入。

2. **内存泄漏**。缓存 key 对 `7d` / `custom` 带了 `endMs`
   （`server/reconciliation.js:212` `resultKey`），每个不同窗口永久留下一条完整
   result 对象（含 segments、per-channel 明细）。进程不重启就只增不减。
   这与第一轮评审修掉的 `tokenLogCaches` 是同一类问题——PR #5 删掉日志扫描时把
   `pruneTokenLogCaches` 清道夫一起带走了，没有东西接上。

   `resultCache` 本身也只靠规则变更失效，TTL 过期项不回收。

**修改要求**

1. 让 `clearRuleResults(ruleId)` 同时按 `${ruleId}:` 前缀清理 `lastSuccessfulResults`。
2. `server/reconciliation.js:734` 里手抄了一遍 `clearRuleResults` 的循环体，改成直接调用，
   这样修正切换时间也会走到同一套清理逻辑。
3. 给两个 Map 加上界。DB 里已经有 `repository.latestSuccessfulResult()` 作为持久化兜底，
   内存这份纯属加速，所以可以放心限制大小：按条数上限 + LRU（或按写入时间的 TTL 清道夫）
   都可以，选一种实现，并在代码里写一行注释说明"DB 是真值，这里只是加速"。

**验收**
- 新增测试：修正切换时间后，构造上游不可用，断言兜底不会返回修正前的金额
  （应当回落到 DB 快照或直接不可用，而不是内存里的旧值）。
- 新增测试：更新规则渠道集合后，`lastSuccessfulResults` 里该规则的条目已被清除。
- 新增测试：连续查询大量不同 `custom` 窗口后，两个 Map 的 `size` 不超过设定上限。
- `npm test` 全绿。

---

## T3（应修）`7d` 窗口的快照只写不用，且没有任何保留策略

**位置**
- `server/reconciliation.js:86-88`（`7d` 的 `endMs = now`）
- `server/reconciliation.js:172` `snapshotKey()`
- `server/reconciliation-repository.js:445` `latestSuccessfulResult()`
- `db/pool.js:161` `UNIQUE KEY uq_reconciliation_snapshot (rule_id, snapshot_key)`

**现象**

`snapshotKey` 对非 `today` 的 preset 是 `${preset}:${startMs}:${endMs}`，而 `7d` 的
`endMs` 每次都是新的 `now`：

```js
} else if (preset === "7d") {
  startMs = midnight(now, timezone, -6);
  endMs = now;
}
```

所以：

1. 每查一次 `7d` 就 INSERT 一批全新的快照行（`source` 列里塞着完整 result JSON），
   `ON DUPLICATE KEY UPDATE` 永远不会触发。
2. `latestSuccessfulResult` 对非 `today` 的 preset 要求 `endMs` 完全相等：

   ```js
   const sameWindow = window.preset === "today"
     ? Number(saved.endMs) <= Number(window.endMs)
     : Number(saved.endMs) === Number(window.endMs);
   ```

   所以 `7d` 的兜底永远命中不了——写进去的行是纯粹的死重。
3. 该查询是 `SELECT * FROM reconciliation_snapshots WHERE rule_id = ? AND window_kind = ?`，
   **没有 LIMIT**，逐行 `JSON.parse` 后在 JS 里过滤，成本随死行数线性上涨。
4. 全仓对 `reconciliation_snapshots` 没有任何保留/清理逻辑
   （唯一的 DELETE 是 `correctTransition` 里那条），归档规则的快照也永久留存。

`today` 不受影响：它的 key 是 `today:${localDate}`，按本地日期 upsert，
一天一行（乘以分段数），这个设计是对的。UI 的 30 秒自动刷新也只对 `today` 生效
（`app/(dashboard)/reconciliation/page.tsx:334`），所以 `7d` 的增长只来自用户手动查询。

**修改要求**

让 `7d`（以及 `custom`，如果口径允许）的窗口末端对齐到一个稳定边界，使 upsert 和兜底同时
生效。至少要达到：同一天内重复查询 `7d` 不再无限新增快照行，且 `latestSuccessfulResult`
能命中同一窗口的历史成功结果。

顺带给 `latestSuccessfulResult` 加上 `ORDER BY generated_at DESC LIMIT ?`，
不要把一条规则的全部历史快照都拉进内存再过滤。

**验收**
- 新增测试：同一 `7d` 窗口连查多次，只产生一条快照（按 `rule_id + snapshot_key` upsert）。
- 新增测试：`7d` 窗口在上游不可用时能命中之前的成功快照作为 stale 兜底。
- `latestSuccessfulResult` 的 SQL 带 LIMIT，且有测试覆盖"只看最近 N 条"的行为。
- `npm test` 全绿。

---

## T4（先确认再改）「现在」这个边界有三套互不一致的规则

**位置** `server/reconciliation.js:71-96` `resolveReconciliationWindow()`

**现象** 同一个"当前时刻"的边界，三种 preset 三种做法，没有任何注释说明理由：

| preset | 窗口末端 |
| --- | --- |
| `today` | `now + TODAY_WINDOW_END_OFFSET_MS`（`:17`，+1 小时） |
| `7d` | `now`（同样覆盖今天，没有那 1 小时） |
| `custom` | 拒绝 `endMs > now`（`:80`） |

引入 `+1h` 的提交是 `130b15f fix: reconcile rule controls`，commit message 没有写理由。

**修改要求（先判断，再动手）**

先确认那 1 小时是为什么存在：

- 如果是为了容忍上游站点与本站的时钟漂移 / 上游日志落库延迟，那么 `7d`（也覆盖今天）
  需要同样的处理，否则同一笔消费在两个 preset 下会被算进不同窗口。
- 如果不需要，`today` 就不该把一个未来时间写进 `window_end_ms` 并显示到 UI 上，
  应当与 `custom` 对齐。

无论结论是哪一个，都要在 `TODAY_WINDOW_END_OFFSET_MS` 旁边留一行注释写明原因，
并让三种 preset 的边界语义可以用一句话解释清楚。

**验收**
- `TODAY_WINDOW_END_OFFSET_MS` 处有注释说明它存在的原因，以及为什么其它 preset
  需要/不需要它。
- 现有的 `默认今天对账窗口按规则时区切零点，结束点比当前时刻晚一小时`
  和 `昨天和近 7 天对账窗口保留原有结束时间语义` 两个测试相应更新，
  且测试名准确反映最终语义。
- `npm test` 全绿。

---

## T5（先确认再改）上下游 `type` 参数口径不一致

**位置**
- `lib/providers.js:724` 上游 `/api/log/self/stat` 传 `type: "0"`
- `lib/providers.js:786` 本站 `/api/log/stat` 传 `type: "2"`

**现象**

成本侧（上游）不按日志类型过滤，收入侧（本站）只取 `type=2`（消费）。两个 mock
（`server/demo.js` 的 `mockNewApiSelfLogStat` / `mockNewApiLogStat`）都完全忽略 `type`
参数，所以没有任何测试钉住这个契约。

如果某个 NewAPI 版本的 `SumUsedQuota` 真的尊重 `type` 参数，`type=0`（不过滤）
会把非消费类的 quota（充值、管理员额度调整）算进**成本**，直接污染对账差额。

**修改要求（先判断，再动手）**

确认目标 NewAPI 版本的 `/api/log/self/stat` 对 `type` 的实际处理：

- 如果 `type` 被忽略、`quota` 恒为消费口径 → 把两侧统一成 `type=2`（或至少在上游侧
  加注释写明"该接口忽略 type，quota 恒为消费口径"），消除这个看起来像 bug 的不对称。
- 如果 `type` 生效 → 上游侧必须改成 `type=2`，并补测试。

同时让 mock 真正尊重 `type` 参数，这样契约才有测试保护。

**验收**
- 两个 mock 按 `type` 过滤 mock 行。
- 新增测试：mock 里混入非消费类日志行，断言它不进入上游成本。
- 代码里有一行注释说明 `type` 的口径结论。
- `npm test` 全绿。

---

## T6（建议）重复的 blocker 列表迟早会失步

**位置**
- `server/reconciliation.js:153` `CALCULATION_BLOCKERS`
- `server/reconciliation.js:533` 内联数组

**现象** 两处列表差一项：`UPSTREAM_EMPTY_WITH_SALES` 在 `CALCULATION_BLOCKERS` 里
（阻断确认利润），但不在 `:533` 的 `sourceUnavailable` 列表里（不触发 stale 兜底）。

这个区分是**有意且正确的**——"本站有收费但上游无消费"是一个真实观测结果，应当展示为风险
差额，而不是被旧数据盖掉。但目前它只体现在两个手写数组的差异里，下一次改动几乎必然
静默失步。

**修改要求** 把 `:533` 的内联数组提成命名常量（例如 `SOURCE_UNAVAILABLE_BLOCKERS`），
和 `CALCULATION_BLOCKERS` 放在一起，并写一行注释说明两者为什么差 `UPSTREAM_EMPTY_WITH_SALES`。
不要改变现有行为。

**验收** 行为不变，现有测试（尤其是断言 `profitUsd === null` +
`riskDifferenceUsd === 2` + `health.code === "UPSTREAM_EMPTY_WITH_SALES"` 那条）继续通过。

---

## T7（建议）上游请求放大

**位置**
- `lib/providers.js:708` `queryNewApiTokenStat()` —— 每次调用都 `newApiStatus(base)`
- `lib/providers.js:761` `queryOwnChannelRevenue()` —— 同样每次都 `newApiStatus(base)`
- `lib/providers.js:602` `newApiReconciliationAuth()` —— 站点没配 `userId` 时每次重探
  `/api/user/self`

**现象** 一条有 N 个分段的规则，每次刷新会多出 2N 次 `/api/status` 和 N 次身份探测。
轮询间隔最低 60 秒（`server/reconciliation.js:763`），规则多了就是持续的无谓压力。
而 `quotaPerUnit` 其实已经在 5 分钟 TTL 的 `metadataCache` 里了
（`server/reconciliation.js:226`）。

**修改要求** 把已知的 `quotaPerUnit`（以及解析出来的 `New-Api-User`）从调用方传下去，
避免每个分段重复探测。注意不要为此破坏"`quotaPerUnit` 必须来自真实响应、
拿不到就报错"这个约束——缓存命中时仍要是真实观测过的值，不能用默认值兜底。

**验收**
- 新增测试：多分段规则的一次查询中，`/api/status` 与 `/api/user/self` 的请求次数不随
  分段数线性增长。
- 现有关于 `quota_per_unit` 缺失时报错的测试继续通过。
- `npm test` 全绿。

---

## 不要做的事

- 不要改 `RECONCILIATION_CALCULATION_VERSION` 或 `RECONCILIATION_BILLING_SOURCE`
  （`lib/reconciliation-contract.js`）。这套版本号的作用是让 v1 的 flow 口径旧快照
  无法被当成 v2 利润回放，改动会让历史快照失效。
- 不要放宽任何 fail-closed 行为：`TOKEN_NAME_AMBIGUOUS`、Key 改名/停用/跨组重试、
  分段短于一秒判定为不可核算，这些都是有意的，不要为了让数字好看而绕开。
- 不要把并发扇出改成串行来迁就测试（见 T1）。
- 不要顺手重排无关代码的格式。真正需要顺手修掉的格式问题只有两处：
  `server/reconciliation-repository.js:499` 的 `import` 写在 class 体之后
  （靠 hoisting 能跑，但把依赖藏起来了，应移到文件顶部），
  以及 `server/reconciliation.js:736` 的 `},` 多缩进了一个空格。
