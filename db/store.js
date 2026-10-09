// MySQL 持久化的 Store：公开 API 与 v1（JSON 文件版 lib/store.js）逐字一致。
// 设计：内存缓存 this.data 保持 v1 数据形状，所有读走内存（同步 getter 不变），
// 所有写通过 save() 串行化写透 MySQL——消费方（26 个端点/告警/日报）零改动。
import { hashPassword } from "../lib/auth.js";
import { ALERT_EVENT_KEYS, DEFAULT_RULES } from "../lib/alerts.js";

const DEFAULT_SETTINGS = {
  refreshIntervalSec: 60, // 后台自动刷新间隔
  lowBalanceUsd: 5, // 全局低余额告警阈值（美元）
  // null 表示永久保留；有限期限只影响原始监测快照，不影响日汇总。
  historyRetentionDays: null,
  // 每日日报：默认按北京时间定时汇总昨日「我的站点」经营情况并推送
  dailyReport: { enabled: false, time: "09:00", channelIds: [], lastSent: null },
};

function uid(prefix = "st") {
  return prefix + "_" + Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-3);
}

// 阈值等可选数值：空/非数字一律归 null（NaN 会让告警判断永远为 false）
function numOrNull(v) {
  if (v === "" || v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function normalizeHistoryRetentionDays(v) {
  if (v == null) return null;
  const n = Number(v);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

// 成本渠道匹配别名：用于渠道配置采用容器域名/IP、与监控地址不一致的场景。
function sanitizeCostAliases(input) {
  const rows = Array.isArray(input) ? input : String(input || "").split(/[\n,]/);
  return [...new Set(rows.map((v) => String(v || "").trim()).filter(Boolean))];
}

// 固定成本付费记录：[{amount(¥), days, startDate|null}]，无效行直接丢弃
function sanitizePurchases(input) {
  if (!Array.isArray(input)) return null;
  const out = [];
  for (const p of input) {
    const amount = numOrNull(p?.amount);
    const days = numOrNull(p?.days);
    if (amount == null || amount <= 0 || days == null || days <= 0) continue;
    out.push({
      amount, days,
      startDate: /^\d{4}-\d{2}-\d{2}$/.test(p?.startDate || "") ? p.startDate : null,
    });
  }
  return out;
}

// 转售的管理员/root API Key：(用户名, Key 名) 二元组唯一定位（Key 名跨用户重名）。
// 这些 Key 的消费从「管理员消耗（成本）」重归为「下游收入」。
function sanitizeResoldKeys(input) {
  if (!Array.isArray(input)) return null;
  const out = [], seen = new Set();
  for (const k of input) {
    const username = String(k?.username || "").trim();
    const tokenName = String(k?.tokenName ?? k?.token_name ?? "").trim();
    if (!username || !tokenName) continue;
    const dedup = `${username} ${tokenName}`;
    if (seen.has(dedup)) continue;
    seen.add(dedup);
    out.push({ username, tokenName });
  }
  return out;
}

// mysql2 的 JSON 列可能返回已解析对象或字符串，统一成对象
function asDoc(v) {
  return typeof v === "string" ? JSON.parse(v) : v;
}

// This value comes from server-side verification, never from station input.
function verifiedAccount(identity) {
  if (!identity) return null;
  if (!["newapi", "sub2api"].includes(identity.provider) || !String(identity.accountId || "").trim()) {
    throw new Error("上游账号身份无效");
  }
  const panel = new URL(identity.baseUrl);
  if (!["http:", "https:"].includes(panel.protocol) || panel.username || panel.password) {
    throw new Error("上游面板地址无效");
  }
  panel.search = "";
  panel.hash = "";
  return {
    provider: identity.provider,
    baseUrl: panel.toString().replace(/\/+$/, ""),
    accountId: String(identity.accountId).trim(),
    verifiedAt: Date.now(),
  };
}

// 每类告警的渠道绑定：归一化为 5 个事件键齐全的新对象（渠道 id 去重、字符串化）。
// 始终返回新对象，避免共享/回写 DEFAULT_RULES.channelsFor。
function sanitizeChannelsFor(input, base) {
  const out = {};
  for (const k of ALERT_EVENT_KEYS) {
    const src = input && k in input ? input[k] : base?.[k];
    out[k] = Array.isArray(src) ? [...new Set(src.map(String).filter(Boolean))] : [];
  }
  return out;
}

export class Store {
  constructor(pool) {
    this.pool = pool;
    // The runtime has one Store instance.  Source edits and reconciliation
    // observation commits use this short-lived, per-station boundary; network
    // requests deliberately happen before it is acquired.
    this._stationLocks = new Map();
    this.data = {
      stations: [],
      settings: { ...DEFAULT_SETTINGS },
      auth: null, // { username, hash, salt }
      notifications: { channels: [], rules: { ...DEFAULT_RULES } },
    };
  }

  async load() {
    // DB 读取失败（连接/权限/损坏）→ 直接抛错中止启动，绝不带着空状态运行
    //（那会在首次 save() 时覆盖掉现有站点凭证——与 v1.15.1 的保护语义一致）
    // pos 保持 v1 的数组插入顺序（created_at 在批量迁移时同秒，排序不稳定）
    const [stationRows] = await this.pool.query("SELECT id, doc FROM stations ORDER BY pos, created_at");
    const [metaRows] = await this.pool.query("SELECT k, v FROM meta WHERE k IN ('settings','auth','notifications')");
    const meta = Object.fromEntries(metaRows.map((r) => [r.k, asDoc(r.v)]));
    this.data = {
      stations: stationRows.map((r) => asDoc(r.doc)),
      settings: { ...DEFAULT_SETTINGS, ...(meta.settings || {}) },
      auth: meta.auth || null,
      notifications: {
        channels: Array.isArray(meta.notifications?.channels) ? meta.notifications.channels : [],
        rules: { ...DEFAULT_RULES, ...(meta.notifications?.rules || {}) },
      },
    };
    this.data.settings.historyRetentionDays =
      normalizeHistoryRetentionDays(this.data.settings.historyRetentionDays);
    // v2.2：旧规则没有渠道绑定字段；归一化成 5 个事件键齐全的独立对象
    this.data.notifications.rules.channelsFor =
      sanitizeChannelsFor(this.data.notifications.rules.channelsFor, null);
    // 迁移：历代固定成本字段（fixedMonthlyCny / fixedCostCny+fixedDays+fixedStartDate）
    // 统一为付费记录数组 fixedPurchases（v1 老数据经 db/migrate.js 导入时同样适用）
    for (const s of this.data.stations) {
      // v2.1：旧站点没有续费计划字段，默认保持原有的正常重复提醒策略。
      s.noRenewal = !!s.noRenewal;
      // 归档资源保留在存储层及长期分析中，但不再出现在默认实时列表。
      s.archivedAt = typeof s.archivedAt === "string" && s.archivedAt ? s.archivedAt : null;
      s.costAliases = sanitizeCostAliases(s.costAliases);
      s.monitorEnabled = s.monitorEnabled !== false;
      s.authVersion = Number.isSafeInteger(s.authVersion) && s.authVersion > 0 ? s.authVersion : 1;
      // 所有监控上游默认计入利润成本；仅显式关闭的观察/重复汇总节点排除。
      s.includeInProfit = s.includeInProfit !== false;
      if (!s.monitorEnabled) { s.includeInProfit = false; s.isOwn = false; }
      delete s.costGateway;
      if (!Array.isArray(s.fixedPurchases)) {
        s.fixedPurchases = [];
        const amount = s.fixedCostCny ?? s.fixedMonthlyCny;
        if (amount > 0) {
          s.fixedPurchases.push({
            amount,
            days: s.fixedDays > 0 ? s.fixedDays : 30,
            startDate: /^\d{4}-\d{2}-\d{2}$/.test(s.fixedStartDate || "") ? s.fixedStartDate : null,
          });
        }
      }
      delete s.fixedMonthlyCny; delete s.fixedPeriod;
      delete s.fixedCostCny; delete s.fixedDays; delete s.fixedStartDate;
    }
    // 初始化面板账号（默认 admin / admin123，登录后请在设置里修改）
    if (!this.data.auth) {
      const { salt, hash } = hashPassword("admin123");
      this.data.auth = { username: "admin", salt, hash, isDefault: true };
      console.log("  已创建默认面板账号：admin / admin123（请登录后在「设置」中修改密码）");
    }
    await this.save();
    return this;
  }

  // 串行化写透（并行刷新会同时触发 save）；事务保证 stations+meta 原子落库
  save() {
    return this._saveChange(() => ({ data: this.data }));
  }

  _saveChange(prepare) {
    const pending = (this._saveChain || Promise.resolve()).then(async () => {
      const change = prepare();
      if (!change) return null;
      if (change.data) {
        try {
          await this._writeNow(change.data);
        } catch (err) {
          // API 只返回操作失败，不回显可能包含凭证的数据库错误。
          throw new Error("保存失败，请稍后重试", { cause: err });
        }
      }
      change.publish?.();
      return change.value;
    });
    // 队列恢复与本次操作的返回值分开：调用方仍能收到失败。
    this._saveChain = pending.catch((err) => console.error("保存失败:", err?.cause?.code || err?.message));
    return pending;
  }

  async _writeNow(data = this.data) {
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      const ids = data.stations.map((s) => s.id);
      if (ids.length) {
        await conn.query("DELETE FROM stations WHERE id NOT IN (?)", [ids]);
        const values = data.stations.map((s, i) => [s.id, i, JSON.stringify(s)]);
        await conn.query(
          "INSERT INTO stations (id, pos, doc) VALUES ? ON DUPLICATE KEY UPDATE pos = VALUES(pos), doc = VALUES(doc)",
          [values]
        );
      } else {
        await conn.query("DELETE FROM stations");
      }
      const metas = [
        ["settings", JSON.stringify(data.settings)],
        ["auth", JSON.stringify(data.auth)],
        ["notifications", JSON.stringify(data.notifications)],
      ];
      await conn.query(
        "INSERT INTO meta (k, v) VALUES ? ON DUPLICATE KEY UPDATE v = VALUES(v)",
        [metas]
      );
      await conn.commit();
    } catch (err) {
      await conn.rollback().catch(() => {});
      throw err;
    } finally {
      conn.release();
    }
  }

  // ---- 设置 ------------------------------------------------------------------
  get settings() {
    return this.data.settings;
  }

  async updateSettings(patch) {
    return this._saveChange(() => {
      // dailyReport 做字段级合并与校验，保留 lastSent
      if (patch.dailyReport && typeof patch.dailyReport === "object") {
        const cur = this.data.settings.dailyReport || DEFAULT_SETTINGS.dailyReport;
        const p = patch.dailyReport;
        patch = {
          ...patch,
          dailyReport: {
            ...cur,
            enabled: "enabled" in p ? !!p.enabled : cur.enabled,
            time: /^\d{2}:\d{2}$/.test(p.time || "") ? p.time : cur.time,
            channelIds: Array.isArray(p.channelIds) ? p.channelIds.map(String) : cur.channelIds,
            lastSent: cur.lastSent ?? null,
          },
        };
      }
      if ("historyRetentionDays" in patch) {
        patch = {
          ...patch,
          historyRetentionDays: normalizeHistoryRetentionDays(patch.historyRetentionDays),
        };
      }
      const settings = { ...this.data.settings, ...patch };
      return {
        data: { ...this.data, settings },
        publish: () => { this.data.settings = settings; },
        value: settings,
      };
    });
  }

  async saveReportDelivery(delivery, lastSent = null) {
    return this._saveChange(() => {
      const dailyReport = {
        ...this.settings.dailyReport, delivery,
        ...(lastSent == null ? {} : { lastSent }),
      };
      const settings = { ...this.settings, dailyReport };
      return {
        data: { ...this.data, settings },
        publish: () => { this.data.settings = settings; },
        value: dailyReport,
      };
    });
  }

  // ---- 面板账号 --------------------------------------------------------------
  get auth() {
    return this.data.auth;
  }

  async setPassword(username, password) {
    const { salt, hash } = hashPassword(password);
    return this._saveChange(() => {
      const auth = { username: username || this.data.auth.username, salt, hash, isDefault: false };
      return { data: { ...this.data, auth }, publish: () => { this.data.auth = auth; } };
    });
  }

  // ---- 通知 ------------------------------------------------------------------
  get channels() {
    return this.data.notifications.channels;
  }

  get rules() {
    return this.data.notifications.rules;
  }

  _changeNotifications(apply) {
    return this._saveChange(() => {
      const notifications = structuredClone(this.data.notifications);
      const settings = structuredClone(this.settings);
      const value = apply(notifications, settings);
      if (value == null) return null;
      return {
        data: { ...this.data, notifications, settings },
        publish: () => { Object.assign(this.data, { notifications, settings }); },
        value,
      };
    });
  }

  async addChannel(input) {
    const ch = {
      id: uid("ch"),
      type: String(input.type || ""),
      name: String(input.name || "未命名渠道").trim(),
      enabled: input.enabled !== false,
      config: typeof input.config === "object" && input.config ? input.config : {},
      createdAt: new Date().toISOString(),
    };
    return this._changeNotifications((notifications) => {
      notifications.channels.push(ch);
      return ch;
    });
  }

  async updateChannel(id, patch) {
    return this._changeNotifications((notifications) => {
      const ch = notifications.channels.find((c) => c.id === id);
      if (!ch) return null;
      if ("name" in patch) ch.name = String(patch.name ?? "").trim();
      if ("enabled" in patch) ch.enabled = !!patch.enabled;
      if ("config" in patch && typeof patch.config === "object" && patch.config) {
        // 空值表示保留原值（前端编辑时不回显密钥）
        for (const [k, v] of Object.entries(patch.config)) {
          if (v !== "" && v != null) ch.config[k] = String(v);
          else if (v === "" && !(k in ch.config)) ch.config[k] = "";
        }
      }
      return ch;
    });
  }

  async removeChannel(id) {
    return this._changeNotifications((notifications, settings) => {
      const n = notifications.channels.length;
      notifications.channels = notifications.channels.filter((c) => c.id !== id);
      // 同步清理各处的渠道绑定，避免留下永远匹配不到的死 id
      // （绑定清空后自动回落到「所有启用渠道」的默认语义）
      const cf = notifications.rules.channelsFor;
      if (cf) {
        for (const k of ALERT_EVENT_KEYS) {
          if (Array.isArray(cf[k])) cf[k] = cf[k].filter((x) => x !== id);
        }
      }
      const dr = settings.dailyReport;
      if (Array.isArray(dr?.channelIds)) dr.channelIds = dr.channelIds.filter((x) => x !== id);
      return notifications.channels.length < n;
    });
  }

  async updateRules(patch) {
    return this._changeNotifications((notifications) => {
      const r = notifications.rules;
      for (const k of ["onLow", "onExhaust", "onError", "onRecover", "onEta"]) {
        if (k in patch) r[k] = !!patch[k];
      }
      if ("etaDays" in patch) {
        const v = Number(patch.etaDays);
        // 非法输入保留原值；下限 1 小时（阈值支持按小时配置）
        if (Number.isFinite(v) && v > 0) r.etaDays = Math.max(1 / 24, Math.round(v * 10000) / 10000);
      }
      if ("etaUnit" in patch) r.etaUnit = patch.etaUnit === "hours" ? "hours" : "days";
      if ("renotifyHours" in patch) r.renotifyHours = Math.max(0, Number(patch.renotifyHours) || 0);
      if ("errorThreshold" in patch) r.errorThreshold = Math.max(1, Math.floor(Number(patch.errorThreshold) || 1));
      if ("errorRetrySec" in patch) r.errorRetrySec = Math.max(0, Math.floor(Number(patch.errorRetrySec) || 0));
      if ("channelsFor" in patch && typeof patch.channelsFor === "object" && patch.channelsFor) {
        // 字段级合并：只更新载荷里出现的事件键；仅接受当前存在的渠道 id
        const valid = new Set(notifications.channels.map((c) => c.id));
        const cleaned = {};
        for (const k of ALERT_EVENT_KEYS) {
          if (!(k in patch.channelsFor)) continue;
          const v = patch.channelsFor[k];
          cleaned[k] = Array.isArray(v) ? v.filter((x) => valid.has(String(x))) : [];
        }
        r.channelsFor = sanitizeChannelsFor(cleaned, r.channelsFor);
      }
      return r;
    });
  }

  // ---- 中转站 ----------------------------------------------------------------
  list({ includeArchived = false, includeUnmonitored = false } = {}) {
    return this.data.stations.filter((s) =>
      (includeArchived || !s.archivedAt) && (includeUnmonitored || s.monitorEnabled !== false)
    );
  }

  get(id) {
    return this.data.stations.find((s) => s.id === id);
  }

  async add(input, { verifiedIdentity = null } = {}) {
    const station = {
      id: uid("st"),
      name: String(input.name || "未命名中转站").trim(),
      type: input.type,
      baseUrl: String(input.baseUrl || "").trim(),
      monitorEnabled: input.monitorEnabled !== false,
      authVersion: 1,
      verifiedIdentity: verifiedAccount(verifiedIdentity),
      accessToken: input.accessToken ? String(input.accessToken).trim() : "",
      userId: input.userId ? String(input.userId).trim() : "",
      apiKey: input.apiKey ? String(input.apiKey).trim() : "",
      email: input.email ? String(input.email).trim() : "",
      password: input.password ? String(input.password) : "",
      lowBalanceUsd: numOrNull(input.lowBalanceUsd),
      // 充值折算汇率：站点 $1 折合人民币（¥）；null 按 1:1 展示
      cnyPerUsd: numOrNull(input.cnyPerUsd),
      // 自有站渠道可能使用容器域名、内网 IP 等地址；别名参与利润成本归属匹配。
      costAliases: sanitizeCostAliases(input.costAliases),
      // 即使不出现在 New API 渠道列表，也按本站用量/余额下降计入利润成本。
      includeInProfit: input.monitorEnabled !== false && input.includeInProfit !== false,
      // 我自己的中转站：启用「我的站点」下游用量分析（需管理员令牌）
      isOwn: input.monitorEnabled !== false && !!input.isOwn,
      // 不再续费：余额低于阈值时仅提醒一次，不再发送耗尽/ETA/持续余额提醒
      noRenewal: input.type !== "fixed" && !!input.noRenewal,
      // 固定成本付费记录（可多笔叠加）：每笔按 金额÷天数 在生效区间内摊销
      fixedPurchases: sanitizePurchases(input.fixedPurchases) || [],
      // 转售给下游的管理员/root API Key（其消费计入收入而非成本）
      resoldAdminKeys: sanitizeResoldKeys(input.resoldAdminKeys) || [],
      demo: !!input.demo,
      createdAt: new Date().toISOString(),
      archivedAt: null,
      s2Tokens: null, // Sub2API 密码模式的令牌缓存 {accessToken, refreshToken, expiresAt}
      alertState: null, // 告警去重状态（含不再续费站点的一次性低余额提醒时间）
      balance: null, // 最近一次查询结果
    };
    return this._saveChange(() => {
      const stations = [...this.data.stations, station];
      return { data: { ...this.data, stations }, publish: () => { this.data.stations = stations; }, value: station };
    });
  }

  async update(id, patch, { verifiedIdentity, expectedAuthVersion } = {}) {
    const identity = verifiedIdentity === undefined ? undefined : verifiedAccount(verifiedIdentity);
    return this._changeStation(id, (s) => {
      if (expectedAuthVersion != null && Number(expectedAuthVersion) !== (s.authVersion || 1)) {
        throw Object.assign(new Error("授权配置已变化，请重新验证"), { code: "AUTHORIZATION_CHANGED" });
      }
      const before = {
        type: s.type, baseUrl: s.baseUrl, email: s.email,
        accessToken: s.accessToken, password: s.password, userId: s.userId, apiKey: s.apiKey,
      };
      const fields = ["name", "type", "baseUrl", "accessToken", "userId", "apiKey", "email"];
      for (const f of fields) if (f in patch) s[f] = String(patch[f] ?? "").trim();
      if ("password" in patch) s.password = String(patch.password ?? "");
      if ("lowBalanceUsd" in patch) s.lowBalanceUsd = numOrNull(patch.lowBalanceUsd);
      if ("cnyPerUsd" in patch) s.cnyPerUsd = numOrNull(patch.cnyPerUsd);
      if ("costAliases" in patch) s.costAliases = sanitizeCostAliases(patch.costAliases);
      if ("includeInProfit" in patch) s.includeInProfit = patch.includeInProfit !== false;
      if ("isOwn" in patch) s.isOwn = !!patch.isOwn;
      if ("monitorEnabled" in patch) s.monitorEnabled = patch.monitorEnabled !== false;
      if (s.monitorEnabled === false) { s.includeInProfit = false; s.isOwn = false; }
      if ("noRenewal" in patch || s.type === "fixed") {
        const noRenewal = s.type !== "fixed" && !!patch.noRenewal;
        if (noRenewal !== !!s.noRenewal && s.alertState) {
          // 每次重新标记都开启一轮新的单次提醒；其他告警去重状态保持不变。
          const { noRenewalLowNotifiedAt, ...alertState } = s.alertState;
          s.alertState = alertState;
        }
        s.noRenewal = noRenewal;
      }
      if ("fixedPurchases" in patch) s.fixedPurchases = sanitizePurchases(patch.fixedPurchases) || [];
      if ("resoldAdminKeys" in patch) s.resoldAdminKeys = sanitizeResoldKeys(patch.resoldAdminKeys) || [];
      // 凭证或站点实际变化才作废令牌缓存（前端编辑总会带上 type/email 原值，
      // 无脑作废会导致每次改名都触发一次完整重登录）
      const credsChanged =
        before.type !== s.type || before.baseUrl !== s.baseUrl || before.email !== s.email ||
        ("accessToken" in patch && s.accessToken !== before.accessToken) ||
        ("password" in patch && s.password !== before.password) ||
        before.userId !== s.userId || before.apiKey !== s.apiKey;
      if (credsChanged) {
        s.s2Tokens = null;
        s.authVersion = (s.authVersion || 1) + 1;
        s.verifiedIdentity = null;
      }
      if (identity !== undefined) s.verifiedIdentity = identity;
      // 即使原缓存为空，也须覆盖提交期间后台取得的旧凭证令牌。
      if (credsChanged) return { s2Tokens: null };
    });
  }

  _changeStation(id, apply) {
    return this.withStationLocks([id], () => this._saveChange(() => {
      const current = this.get(id);
      if (!current) return null;
      const next = { ...current };
      const forcedFields = apply(next);
      const fields = Object.fromEntries(Object.entries(next).filter(([key, value]) => !Object.is(current[key], value)));
      Object.assign(fields, forcedFields);
      if (!Object.keys(fields).length) return { value: current };
      const stations = this.data.stations.map((s) => s.id === id ? next : s);
      return {
        data: { ...this.data, stations },
        // 保留刷新持有的对象及提交期间更新的余额、令牌等未编辑字段。
        publish: () => {
          if ("noRenewal" in fields) {
            // 只重置单次提醒，保留提交期间后台更新的其他告警字段。
            const { noRenewalLowNotifiedAt, ...alertState } = current.alertState || {};
            fields.alertState = current.alertState ? alertState : current.alertState;
          }
          Object.assign(current, fields);
        },
        value: current,
      };
    }));
  }

  async remove(id) {
    return this.withStationLocks([id], () => this._saveChange(() => {
      const n = this.data.stations.length;
      const stations = this.data.stations.filter((s) => s.id !== id);
      return {
        data: { ...this.data, stations },
        publish: () => { this.data.stations = stations; },
        value: stations.length < n,
      };
    }));
  }

  async archive(id) {
    return this._changeStation(id, (s) => { s.archivedAt ||= new Date().toISOString(); });
  }

  async restore(id) {
    return this._changeStation(id, (s) => { if (s.archivedAt) s.archivedAt = null; });
  }

  async withStationLocks(ids, action) {
    const releases = [];
    for (const id of [...new Set(ids.filter(Boolean))].sort()) {
      const previous = this._stationLocks.get(id) || Promise.resolve();
      let release;
      const gate = new Promise((resolve) => { release = resolve; });
      const tail = previous.then(() => gate);
      this._stationLocks.set(id, tail);
      await previous;
      releases.push(() => {
        release();
        if (this._stationLocks.get(id) === tail) this._stationLocks.delete(id);
      });
    }
    try {
      return await action();
    } finally {
      for (const release of releases.reverse()) release();
    }
  }

  async setBalance(id, balance) {
    await this._changeStation(id, (s) => { s.balance = balance; });
  }
}
