// 每日日报：自营站点前一天（业务时区的一整天）的经营汇总，字按 design/ui-copy-spec.md §10 写。
// buildReport/sendReport 供 /api/report/preview、/api/report/send 端点调用；
// startReportScheduler 由 lib/runtime.js 在初始化时启动，定时器挂在 rt 字段上。
import { consumeLogIncomeState } from "../lib/consume-log.js";
import { queryOwnData } from "../lib/providers.js";
import { forecastDaily } from "../lib/forecast.js";
import { BRAND } from "../lib/brand.js";
import { FONT_STACK, palette } from "../lib/design-tokens.js";
import { broadcast } from "../lib/notify.js";
import { readOwnIncomeOrUnconfirmed, unconfirmedIncomeProfit, computeProfit } from "./own-helpers.js";
import { businessTimeZone, dayKeyInTz, dayStartInTz, shiftDayLabel, zonedParts } from "../lib/business-time.js";
import { errorText } from "../lib/error-copy.js";
import {
  ADMIN_UNMARKED, BALANCE_STATE_TEXT, BASIS_TITLE, COST_MODE_TEXT, EMPTY, FORECAST_TEXT, NO_SPEND_TEXT, NO_UPSTREAM_TEXT,
  OWN_STATION_UNSET, RATE_UNSET, formatCompact, formatDayKey, formatDays, formatDeltaPct, formatMoney, formatPct, weekdayOfDayKey,
} from "../lib/format.js";
import { balanceViewOf, burnText, ownStationDisplayName, stationDisplayName } from "../lib/overview-actions.js";
import { balanceMoneyOf, isLoss, profitApproxOf, rateSnapshotOf, splitProfitWarnings } from "../lib/profit.js";

// 日报时区就是业务时区（BUSINESS_TIME_ZONE，兼容旧的 REPORT_TIME_ZONE），与利润页、日汇总同一套日界线
export const REPORT_TIME_ZONE = businessTimeZone();

// 日报日界线必须与进程/容器时区无关，否则 UTC 部署会在北京时间 08:00 才切换“昨天”。
export function reportDayWindow(nowMs = Date.now(), tz = REPORT_TIME_ZONE) {
  const todayLabel = dayKeyInTz(nowMs, tz);
  const dayEnd = dayStartInTz(todayLabel, tz);
  const dayStart = dayStartInTz(shiftDayLabel(todayLabel, -1), tz);
  const wideStart = dayStartInTz(shiftDayLabel(todayLabel, -34), tz);
  return { tz, todayLabel, dayStart, dayEnd, wideStart };
}

export function reportClock(nowMs = Date.now(), tz = REPORT_TIME_ZONE) {
  const { hour, minute } = zonedParts(nowMs, tz);
  return { today: dayKeyInTz(nowMs, tz), hhmm: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}` };
}

// 日报里的字（§10）：文字版和邮件版共用，HTML 里只填数。金额、Token、日期、余额、档位、原因、成本来源、
// 利润说明、预计花费的说法取共用的写法（lib/format.js、lib/profit.js、lib/overview-actions.js），这里只放日报自己的话
export const REPORT_TEXT = Object.freeze({
  title: (site, day) => `【${BRAND.name}日报】${site} ${day}`,
  head: (site, day, weekday) => `【${BRAND.name}日报】${site} · ${day}（${weekday}）`,
  wholeDay: (day) => `统计的是 ${day} 一整天`,
  overview: "经营概览",
  spend: "消费",
  versusPrev: (delta) => `环比 ${delta}`,
  // 和前 7 天日均比：文字版带上日均是多少（avg），邮件的格子里放不下就不带
  versusAvg: (avg, word, pct) => `比前 7 天日均${avg ? ` ${avg} ` : ""}${word} ${pct}`,
  higher: "高",
  lower: "低",
  sameAsAvg: "和前 7 天日均持平",
  income: "收入",
  adminSelf: "管理员自用",
  upstreamCost: "上游成本",
  fixedCost: "固定成本",
  gross: "毛利",
  net: "净利",
  grossRate: "毛利率",
  netRate: "净利率",
  loss: "亏损",
  unread: "没读到",
  usage: "用量",
  // 用量那一行的三项：文字版用「｜」隔开，邮件用「·」
  usageParts: (requests, tokens, users) => [`请求数 ${requests}`, `Token（不含缓存）${tokens}`, `有消费的用户 ${users} 个`],
  requests: "请求数",
  token: "Token",
  topModels: "用得最多的模型",
  topUsers: "消费最多的用户",
  admin: "管理员",
  noSpend: "这天没有消费",
  costs: "成本明细",
  balances: "上游余额",
  burn: "日均花费",
  runway: (days) => `可用${days}`,
  prepaid: "预收",
  userCount: (n) => `${n} 个用户`,
  forecast: "预计花费",
  today: "今天",
  next7: "未来 7 天",
  // 以往起伏范围；上下限写出来一样时只写一个数
  band: (lo, hi) => (lo === hi ? `预计 ${lo}` : `预计 ${lo} 到 ${hi}`),
  trend: "近 14 天消费",
  mailTitle: (site) => `${BRAND.name} · ${site} 日报`,
  mailFooter: "每日经营日报",
});

// 汇总前一天（业务时区的一整天）的经营情况，返回 {title, text, html, degraded}
export async function buildReport(rt) {
  const { store } = rt;
  const configuredOwn = store.list().find((s) => s.isOwn && s.type === "newapi");
  // 日报正文、HTML 和利润使用同一份售价/转售配置，读取期间的修改留到下一次生成。
  const own = configuredOwn ? { ...configuredOwn, resoldAdminKeys: (configuredOwn.resoldAdminKeys || []).map((key) => ({ ...key })) } : null;
  if (!own) throw Object.assign(new Error(OWN_STATION_UNSET), { code: "OWN_STATION_UNSET" });
  const { tz, dayStart, dayEnd, wideStart } = reportDayWindow();

  const [modelRows, userRows] = await Promise.all([
    queryOwnData(own, wideStart, dayEnd, "model"),
    queryOwnData(own, dayStart, dayEnd, "user"),
  ]);
  // 收入确认不了时日报照发、利润不写（design/ui-copy-spec.md §10）：收入那几项写「没读到（原因）」，别的照常
  const income = await readOwnIncomeOrUnconfirmed(rt, own, userRows, { startMs: dayStart, endMs: dayEnd, tz });
  // 自营站点现在关着、或昨天碰到过关着的那一段：消费日志不全，按用户消费算出来的收入是少的，日报不当真报，写原因（用语规范 §8.1「自营站点不记收费记录了」）
  const logState = consumeLogIncomeState(own.consumeLogOffPeriods, { startMs: dayStart, endMs: dayEnd });
  const { users: ownUsers, adminSet } = income;
  const { incomeUsd, adminUsageUsd: adminUsd, resold, unconfirmed } = logState
    ? { incomeUsd: null, adminUsageUsd: null, resold: null, unconfirmed: Object.assign(new Error("自营站点不记收费记录了"), { code: logState === "off" ? "OWN_CONSUME_LOG_OFF" : "OWN_CONSUME_LOG_GAP" }) }
    : income;

  // 这一天的聚合
  const agg = (rows) => {
    const m = new Map();
    for (const r of rows) {
      const a = m.get(r.key) || { key: r.key, tokens: 0, cost: 0, requests: 0 };
      a.tokens += r.tokens; a.cost += r.cost; a.requests += r.requests;
      m.set(r.key, a);
    }
    return [...m.values()].sort((a, b) => b.cost - a.cost);
  };
  const yRows = modelRows.filter((r) => r.t >= dayStart && r.t < dayEnd);
  const yUserRows = userRows.filter((r) => r.t >= dayStart && r.t < dayEnd);
  const byModel = agg(yRows);
  // 用户只算这天消费金额大于 0 的：只调了免费模型的不算进「有消费的用户」，也不进排行
  const byUser = agg(yUserRows).filter((u) => u.cost > 0).map((u) => ({ ...u, isAdmin: adminSet.has(u.key) }));
  // 这一天的利润（成本也只算这一天）
  const profit = unconfirmed
    ? await unconfirmedIncomeProfit(rt, own, unconfirmed, { startMs: dayStart, now: dayEnd, tz, range: "7d" })
    : await computeProfit(rt, own, incomeUsd, adminUsd, { startMs: dayStart, now: dayEnd, tz, range: "7d", resold });

  // 日序列（近 34 天，不含今天）→ 环比、前 7 天日均与预测
  // 按日期标签逐日推进（不加 24h），夏令时时区也不会错位
  const dmap = new Map();
  for (const r of modelRows) {
    if (r.t >= dayEnd) continue;
    const label = dayKeyInTz(r.t, tz);
    dmap.set(label, (dmap.get(label) || 0) + r.cost);
  }
  const daily = [];
  if (dmap.size) {
    const lastLabel = dayKeyInTz(dayStart, tz);
    for (let label = [...dmap.keys()].sort()[0]; label <= lastLabel; label = shiftDayLabel(label, 1)) {
      daily.push({ t: dayStartInTz(label, tz), cost: dmap.get(label) || 0 });
    }
  }

  const d = reportFigures(rt, {
    own, tz, dayStart, byModel, byUser, daily, profit, ownUsers, incomeUsd, adminUsd, unconfirmed, fc: forecastDaily(daily, 7),
  });
  // degraded：收入或成本没读到，这份是降级的（定时发送先重试，最后一次才发它）
  return { title: d.title, text: reportText(d), html: reportHtml(d), degraded: !!unconfirmed || !!profit?.error };
}

// 日报里的每个数按 §10 写好：文字版和邮件版都从这里取，字一样、顺序一样
function reportFigures(rt, { own, tz, dayStart, byModel, byUser, daily, profit, ownUsers, incomeUsd, adminUsd, unconfirmed, fc }) {
  const T = REPORT_TEXT;
  const { store, history } = rt;
  // 自营站点的金额按售价折成人民币（没设置按 1 比 1，利润说明里有那句）
  const ownRate = rateSnapshotOf(own).cnyPerUsd;
  const money = (usd, opts) => formatMoney(usd * ownRate, opts);
  // 自营站点没起名字时写「自营站点」，不写「未命名上游」
  const site = ownStationDisplayName(own);
  const dayKey = dayKeyInTz(dayStart, tz);
  const day = formatDayKey(dayKey, tz);
  const weekday = weekdayOfDayKey(dayKey);
  const totalCost = byModel.reduce((a, m) => a + m.cost, 0);

  // 消费的两个对比：环比和前一天比，前一天没有消费时不写；前 7 天日均是这天之前 7 个整天的平均，
  // 不满 7 天或平均是 0 时不写；差多少四舍五入后是 0.0% 时写「持平」
  const prev = daily.length >= 2 ? daily[daily.length - 2].cost : 0;
  const before = daily.slice(-8, -1);
  const avg7 = before.length === 7 ? before.reduce((a, x) => a + x.cost, 0) / 7 : 0;
  const versus = (withAvg) => {
    const out = prev > 0 ? [T.versusPrev(formatDeltaPct((totalCost - prev) / prev))] : [];
    if (avg7 > 0) {
      const ratio = (totalCost - avg7) / avg7;
      const pct = formatPct(Math.abs(ratio));
      out.push(pct === formatPct(0) ? T.sameAsAvg : T.versusAvg(withAvg ? money(avg7) : "", ratio > 0 ? T.higher : T.lower, pct));
    }
    return out;
  };

  // 收入、成本、利润：读不到的说原因（§8.2 那一类的话）；估算的数和页面一样加「≈」
  // 收入读不到的原因：关着、关过用自己的说法（关过的那句写「昨天」），别的是收入确认不了
  const incomeReason = unconfirmed ? (unconfirmed.code === "OWN_CONSUME_LOG_GAP" ? errorText({ code: "OWN_CONSUME_LOG_GAP" }).replace("这一天", "昨天") : errorText({ code: unconfirmed.code === "OWN_CONSUME_LOG_OFF" ? "OWN_CONSUME_LOG_OFF" : "OWN_INCOME_UNCONFIRMED" })) : null;
  const costReason = profit?.error ? errorText(profit) : null;
  const approx = profitApproxOf(profit, own);
  const { reasons, notes } = costReason ? { reasons: [], notes: [] } : splitProfitWarnings(profit);
  // 毛利、净利后面的括号：亏损写「亏损」，不写利润率；收入是 0 时利润率是 null，也不写
  const result = (value, rateLabel, pct) => ({
    value: formatMoney(value, { approx: approx.result }),
    note: isLoss(value) ? { text: T.loss, loss: true }
      : pct != null ? { text: `${rateLabel} ${approx.result ? "≈ " : ""}${formatPct(pct / 100)}`, loss: false } : null,
  });
  const profitOk = !incomeReason && !costReason;

  // 上游余额：和上游列表同一套档位、分档和写法（快用完按提醒规则里的提醒天数，不写死）
  const balances = store.list().filter((s) => !s.isOwn && s.type !== "fixed").map((s) => {
    const name = stationDisplayName(s);
    const b = s.balance;
    const prediction = b?.ok ? history.predict(s.id) : null;
    const view = balanceViewOf({ ...s, prediction }, { settings: store.settings, rules: store.rules });
    if (view.state === "pending" || view.state === "unreadable") {
      const state = view.state === "pending" ? BALANCE_STATE_TEXT.pending : `${BALANCE_STATE_TEXT.unreadable}（${errorText(b)}）`;
      return { name, state, level: view.level, tail: null, amount: EMPTY, amountSub: null, text: state };
    }
    const amount = balanceMoneyOf(s, b.remaining);
    const state = view.state ? BALANCE_STATE_TEXT[view.state] : null;
    // 余额用完时不写日均花费和可用天数；近期没有花费只写这一句；估不出来不写
    const burn = view.state === "empty" ? null : burnText(s, prediction);
    const tail = view.state === "empty" ? null : view.days === Infinity ? NO_SPEND_TEXT
      : burn ? `${T.burn} ${burn}${view.days != null ? `，${T.runway(formatDays(view.days))}` : ""}` : null;
    return {
      name, state, level: view.level, tail, amount: amount.text, amountSub: amount.cny || RATE_UNSET,
      text: [amount.full, state, tail].filter(Boolean).join("，"),
    };
  });

  // 预收：不算管理员；用户列表读不到时说原因
  const payers = (ownUsers || []).filter((u) => u.role < 10);
  const prepaid = ownUsers ? `${money(payers.reduce((a, u) => a + u.quotaUsd, 0))}（${T.userCount(payers.length)}）`
    : incomeReason ? `${T.unread}（${incomeReason}）` : null;

  // 预计花费：写以往起伏范围，不写单个数；和自营业务的预计花费同一套说法
  const F = FORECAST_TEXT;
  const forecast = fc ? {
    today: T.band(money(fc.points[0].lo), money(fc.points[0].hi)),
    next7: T.band(money(fc.nextLo ?? fc.points.reduce((a, p) => a + p.lo, 0)), money(fc.nextHi ?? fc.points.reduce((a, p) => a + p.hi, 0))),
    basis: `${F.sampleLead} ${F.sampleDays(fc.sampleDays)}${F.sampleTail}`
      + (fc.backtestWapePct != null ? `，${F.accuracy} ${F.accuracyPct(fc.backtestWapePct)}` : ""),
  } : null;

  return {
    title: T.title(site, day), site, day, weekday,
    spend: money(totalCost), versusLong: versus(true), versusShort: versus(false),
    incomeReason, costReason,
    income: incomeReason ? null : money(incomeUsd, { approx: approx.income }),
    admin: incomeReason ? null : money(adminUsd),
    adminPositive: !incomeReason && adminUsd > 0,
    upstream: costReason ? null : formatMoney(profit.upstreamCostCny, { approx: approx.upstream }),
    fixed: costReason ? null : formatMoney(profit.fixedCostCny),
    gross: profitOk ? result(profit.grossProfitCny, T.grossRate, profit.grossMarginPct) : null,
    net: profitOk ? result(profit.netProfitCny, T.netRate, profit.netMarginPct) : null,
    basis: reasons.length + notes.length ? [...reasons, ...notes].join("") : null,
    requests: formatCompact(byModel.reduce((a, m) => a + m.requests, 0)),
    tokens: formatCompact(byModel.reduce((a, m) => a + m.tokens, 0)),
    payingUsers: byUser.length,
    models: byModel.slice(0, 5).map((m) => ({
      name: m.key, cost: m.cost, money: money(m.cost), tokens: formatCompact(m.tokens), requests: formatCompact(m.requests),
    })),
    users: byUser.slice(0, 5).map((u) => ({ name: u.key, cost: u.cost, money: money(u.cost), tokens: formatCompact(u.tokens), admin: u.isAdmin })),
    // 用户列表读不到：标不出谁是管理员
    adminUnmarked: !!unconfirmed && !ownUsers,
    // 成本明细：有说明的写说明，没有的写来源名；按余额变化估算的金额加「≈」
    costs: costReason ? [] : (profit.costs || []).map((c) => ({
      name: stationDisplayName(c), money: formatMoney(c.cny, { approx: c.mode === "history" }), how: c.note || COST_MODE_TEXT[c.mode] || "",
    })),
    balances, prepaid, forecast,
    // 近 14 天消费（邮件里的柱状图）
    trend: daily.slice(-14).map((x) => ({ cost: x.cost * ownRate, money: money(x.cost), day: formatDayKey(dayKeyInTz(x.t, tz), tz) })),
  };
}

// 文字版（聊天软件收到的）：每块前面「■ 块名」，每行「名称：内容」
function reportText(d) {
  const T = REPORT_TEXT;
  const pair = (label, value) => `${label}：${value}`;
  const both = (a, b) => `${a} ｜ ${b}`;
  const block = (name) => `■ ${name}`;
  const paren = (text) => (text ? `（${text}）` : "");
  const unread = (reason) => `${T.unread}（${reason}）`;
  const L = [T.head(d.site, d.day, d.weekday), T.wholeDay(d.day), "", block(T.overview)];
  L.push(pair(T.spend, `${d.spend}${paren(d.versusLong.join("；"))}`));
  // 读不到的几项合成一行，原因相同的放在一起（§10）
  if (d.incomeReason) L.push(pair([T.income, T.adminSelf, T.gross, T.net].join("、"), unread(d.incomeReason)));
  else L.push(both(pair(T.income, d.income), pair(T.adminSelf, d.admin)));
  if (d.costReason) {
    const labels = d.incomeReason ? [T.upstreamCost, T.fixedCost] : [T.upstreamCost, T.fixedCost, T.gross, T.net];
    L.push(pair(labels.join("、"), unread(d.costReason)));
  } else if (d.incomeReason) {
    L.push(both(pair(T.upstreamCost, d.upstream), pair(T.fixedCost, d.fixed)));
  } else {
    L.push(both(pair(T.upstreamCost, d.upstream), pair(T.gross, `${d.gross.value}${paren(d.gross.note?.text)}`)));
    L.push(both(pair(T.fixedCost, d.fixed), pair(T.net, `${d.net.value}${paren(d.net.note?.text)}`)));
  }
  if (d.basis) L.push(pair(BASIS_TITLE, d.basis));

  L.push("", block(T.usage));
  L.push(T.usageParts(d.requests, d.tokens, d.payingUsers).join(" ｜ "));

  L.push("", block(T.topModels));
  d.models.forEach((m, i) => L.push(`${i + 1}. ${m.name}  ${m.money}（${T.token} ${m.tokens} · ${T.requests} ${m.requests}）`));
  if (!d.models.length) L.push(paren(T.noSpend));

  L.push("", block(T.topUsers));
  d.users.forEach((u, i) => L.push(`${i + 1}. ${u.name}${u.admin ? paren(T.admin) : ""}  ${u.money}（${T.token} ${u.tokens}）`));
  if (!d.users.length) L.push(paren(T.noSpend));
  else if (d.adminUnmarked) L.push(paren(ADMIN_UNMARKED));

  if (d.costs.length) {
    L.push("", block(T.costs));
    d.costs.forEach((c) => L.push(`- ${c.name}  ${c.money}${paren(c.how)}`));
  }

  L.push("", block(T.balances));
  L.push(...(d.balances.length ? d.balances.map((b) => `- ${b.name}：${b.text}`) : [paren(NO_UPSTREAM_TEXT)]));

  if (d.prepaid) L.push("", block(pair(T.prepaid, d.prepaid)));

  if (d.forecast) {
    L.push("", block(T.forecast));
    L.push(pair(T.today, d.forecast.today), pair(T.next7, d.forecast.next7), d.forecast.basis);
  }
  L.push("", BRAND.reportSignature);
  return L.join("\n");
}

// 邮件版（HTML）：全内联样式 + 表格排版，图表用色块/条形实现（Gmail 会剥离 SVG、屏蔽 data:URI 图片，这是全客户端可靠的做法）。
// 字和文字版一样、顺序一样，都从 reportFigures 取；颜色取设计令牌（lib/design-tokens.js）
function reportHtml(d) {
  const T = REPORT_TEXT;
  const P = palette.light;
  const C = {
    ink: P.ink, sub: P["ink-3"], line: P.rule, sheet: P.sheet, bg: P.plane,
    blue: P.cobalt, blueSoft: P["seq-2"], track: P["cobalt-tint"], crit: P["crit-ink"], warn: P["warn-ink"],
  };
  // 档位名的颜色和上游列表一样：crit 红、warn 黄，其余不标
  const LEVEL_COLOR = { crit: C.crit, warn: C.warn };
  const font = `font-family:${FONT_STACK.replaceAll('"', "'")};`;
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const tinted = (text, color) => `<span style="color:${color}">${esc(text)}</span>`;
  const dot = (...parts) => parts.filter(Boolean).join(" · ");
  const card = (inner, padding = "6px 14px") =>
    `<div style="background:${C.sheet};border:1px solid ${C.line};border-radius:10px;padding:${padding}">${inner}</div>`;
  const small = (text, color = C.sub) => `<div style="${font}font-size:11px;color:${color};margin:6px 0;line-height:1.8">${esc(text)}</div>`;

  // 指标卡：sub 是拼好的 HTML（里面的字都转义过）
  const kpi = (label, value, sub) => `
    <td width="25%" style="padding:6px">${card(`
      <div style="${font}font-size:11px;color:${C.sub}">${esc(label)}</div>
      <div style="${font}font-size:20px;font-weight:700;color:${C.ink};margin-top:2px">${esc(value)}</div>
      ${sub ? `<div style="${font}font-size:11px;color:${C.sub};margin-top:2px">${sub}</div>` : ""}`, "12px 14px")}</td>`;
  // 毛利、净利两格：下面照常写上游成本、固定成本；成本没读到时写「上游成本 没读到（原因）」，和文字版说的是同一件事。
  // 收入或成本没读到时数写「没读到」；亏损的数字仍用墨色，利润率换成红色的「亏损」
  const resultKpi = (label, r, costLabel, cost) => {
    if (d.costReason) return kpi(label, T.unread, esc(`${costLabel} ${T.unread}（${d.costReason}）`));
    if (d.incomeReason) return kpi(label, T.unread, esc(`${costLabel} ${cost}`));
    const note = r.note ? (r.note.loss ? tinted(r.note.text, C.crit) : esc(r.note.text)) : "";
    return kpi(label, r.value, dot(note, esc(`${costLabel} ${cost}`)));
  };

  const section = (title, inner = "") => `
    <tr><td style="padding:18px 12px 6px;${font}font-size:14px;font-weight:700;color:${C.ink}">${esc(title)}</td></tr>
    ${inner ? `<tr><td style="padding:0 12px">${inner}</td></tr>` : ""}`;

  // 近 14 天消费柱状图（表格 + 色块；最后一天高亮）
  const days = d.trend;
  const maxDay = Math.max(...days.map((x) => x.cost), 0.01);
  const trend = days.length ? card(`
      <table width="100%" cellpadding="0" cellspacing="0" style="height:76px"><tr>${days.map((x, i) => `<td align="center" valign="bottom" style="padding:0 2px">
        <div title="${esc(x.money)}" style="height:${Math.max(3, Math.round((x.cost / maxDay) * 72))}px;background:${i === days.length - 1 ? C.blue : C.blueSoft};border-radius:3px 3px 0 0"></div>
      </td>`).join("")}</tr></table>
      <table width="100%" cellpadding="0" cellspacing="0"><tr>
        <td style="${font}font-size:10px;color:${C.sub}">${esc(days[0].day)}</td>
        <td align="right" style="${font}font-size:10px;color:${C.sub}">${esc(dot(days[days.length - 1].day, days[days.length - 1].money))}</td>
      </tr></table>`, "14px") : "";

  // 条形榜单（名称 + 比例条 + 数值）；name 是拼好的 HTML
  const barList = (rows, nameOf) => {
    const max = Math.max(...rows.map((r) => r.cost), 1e-9);
    return card(rows.map((r) => `
      <table width="100%" cellpadding="0" cellspacing="0" style="margin:8px 0"><tr>
        <td width="34%" style="${font}font-size:12px;color:${C.ink};white-space:nowrap;overflow:hidden">${nameOf(r)}</td>
        <td style="padding:0 10px"><div style="background:${C.track};border-radius:4px"><div style="width:${Math.max(2, Math.round((r.cost / max) * 100))}%;height:8px;background:${C.blue};border-radius:4px"></div></div></td>
        <td width="20%" align="right" style="${font}font-size:12px;color:${C.ink};font-weight:600;white-space:nowrap">${esc(r.money)}</td>
      </tr></table>`).join(""));
  };
  const none = small(`（${T.noSpend}）`);
  const models = d.models.length ? barList(d.models, (m) => esc(m.name)) : none;
  // 管理员的标记用次要颜色，不标红；用户列表读不到时下面说一句（和文字版同一句）
  const users = d.users.length
    ? barList(d.users, (u) => `${esc(u.name)}${u.admin ? ` <span style="color:${C.sub};font-size:10px">${esc(T.admin)}</span>` : ""}`)
      + (d.adminUnmarked ? small(`（${ADMIN_UNMARKED}）`) : "")
    : none;

  // 一行：左边名字和说明，右边金额（金额下面可以再写一行）
  const row = (left, right, rightSub) => `
      <table width="100%" cellpadding="0" cellspacing="0" style="margin:7px 0"><tr>
        <td style="${font}font-size:12px;color:${C.ink}">${left}</td>
        <td align="right" style="${font}font-size:12px;font-weight:600;color:${C.ink};white-space:nowrap">${esc(right)}${rightSub ? `<div style="font-size:11px;font-weight:400;color:${C.sub}">${esc(rightSub)}</div>` : ""}</td>
      </tr></table>`;
  const costs = d.costs.length
    ? card(d.costs.map((c) => row(`${esc(c.name)}${c.how ? ` <span style="color:${C.sub};font-size:11px">${esc(c.how)}</span>` : ""}`, c.money)).join(""))
    : "";
  const balances = card(d.balances.length
    ? d.balances.map((b) => row(
      `${esc(b.name)}${b.state ? ` <span style="color:${LEVEL_COLOR[b.level] || C.sub};font-size:11px">${esc(b.state)}</span>` : ""}`
        + `${b.tail ? ` <span style="color:${C.sub};font-size:11px">${esc(b.tail)}</span>` : ""}`,
      b.amount, b.amountSub)).join("")
    : small(`（${NO_UPSTREAM_TEXT}）`));

  const forecast = d.forecast
    ? card(`<div style="${font}font-size:12px;color:${C.ink};line-height:1.9">${esc(`${T.today}：${d.forecast.today}`)}<br>${esc(`${T.next7}：${d.forecast.next7}`)}<br>
      <span style="color:${C.sub};font-size:11px">${esc(d.forecast.basis)}</span></div>`, "12px 14px")
    : "";

  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:${C.bg}">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:${C.bg};padding:18px 0"><tr><td align="center">
  <table width="640" cellpadding="0" cellspacing="0" style="max-width:640px;width:100%">
    <tr><td style="padding:6px 12px 2px;${font}font-size:18px;font-weight:700;color:${C.ink}">${esc(T.mailTitle(d.site))}</td></tr>
    <tr><td style="padding:0 12px 8px;${font}font-size:12px;color:${C.sub}">${esc(dot(`${d.day}（${d.weekday}）`, BRAND.reportSignature))}</td></tr>
    <tr><td><table width="100%" cellpadding="0" cellspacing="0"><tr>
      ${kpi(T.spend, d.spend, dot(...d.versusShort.map(esc)))}
      ${d.incomeReason ? kpi(T.income, T.unread, esc(d.incomeReason)) : kpi(T.income, d.income, d.adminPositive ? esc(`${T.adminSelf} ${d.admin}`) : "")}
      ${resultKpi(T.gross, d.gross, T.upstreamCost, d.upstream)}
      ${resultKpi(T.net, d.net, T.fixedCost, d.fixed)}
    </tr></table></td></tr>
    ${d.basis ? section(BASIS_TITLE, small(d.basis, C.ink)) : ""}
    ${trend ? section(T.trend, trend) : ""}
    ${section(`${T.usage}：${dot(...T.usageParts(d.requests, d.tokens, d.payingUsers))}`)}
    ${section(T.topModels, models)}
    ${section(T.topUsers, users)}
    ${costs ? section(T.costs, costs) : ""}
    ${section(T.balances, balances)}
    ${d.prepaid ? section(`${T.prepaid}：${d.prepaid}`) : ""}
    ${forecast ? section(T.forecast, forecast) : ""}
    <tr><td style="padding:16px 12px;${font}font-size:11px;color:${C.sub}">${esc(dot(BRAND.reportSignature, T.mailFooter))}</td></tr>
  </table></td></tr></table></body></html>`;
}

// 日报的目标渠道：settings.dailyReport.channelIds 为空数组时发给所有启用渠道。
// channelIds 参数可覆盖设置（v1 的 send 端点不读请求体，调用方不传即与 v1 一致）。
function reportChannels(rt, channelIds) {
  const cfg = rt.store.settings.dailyReport || {};
  const ids = Array.isArray(channelIds) ? channelIds : Array.isArray(cfg.channelIds) ? cfg.channelIds : [];
  return rt.store.channels.filter((c) => c.enabled !== false && (!ids.length || ids.includes(c.id)));
}

// 没有能发日报的通知方式：带码，页面按码说（lib/error-copy.js REPORT_NO_CHANNELS）
const noReportChannels = () => Object.assign(new Error(errorText({ code: "REPORT_NO_CHANNELS" })), { code: "REPORT_NO_CHANNELS" });

// 立即发送日报（/api/report/send 的主体）。与 v1 一致：手动发送不占用 lastSent，
// 不影响当天的定时发送。构建失败会抛错，由调用方决定响应状态码。
// 没有可发的渠道时先报错，不去读上游生成日报；和定时发送用同一句话。
export async function sendReport(rt, channelIds) {
  const channels = reportChannels(rt, channelIds);
  if (!channels.length) throw noReportChannels();
  const { title, text, html } = await buildReport(rt);
  const results = await broadcast(channels, title, text, { event: "daily-report", html });
  return { ok: true, results };
}

const REPORT_MAX_ATTEMPTS = 5;
const REPORT_RETRY_MS = 60000;

// 调度：到达计划时间后可跨分钟重试；持久化渠道进度，成功后才标记已发送。
export function startReportScheduler(rt) {
  if (rt._reportTimer) clearInterval(rt._reportTimer); // HMR/重复初始化时防止双定时器
  rt._reportTimer = setInterval(async () => {
    if (rt._reportRunning) return;
    const cfg = rt.store.settings.dailyReport;
    if (!cfg?.enabled || !cfg.time) return;
    const { hhmm, today } = reportClock();
    if (hhmm < cfg.time || cfg.lastSent === today) return;
    const previous = rt._reportDelivery?.day === today ? rt._reportDelivery
      : cfg.delivery?.day === today ? cfg.delivery : null;
    const now = Date.now();
    if (previous && (previous.attempts >= REPORT_MAX_ATTEMPTS || previous.nextAttemptAt > now)) return;
    const retryDelay = REPORT_RETRY_MS * 2 ** (previous?.attempts || 0);
    const delivery = {
      day: today,
      attempts: (previous?.attempts || 0) + 1,
      successfulChannelIds: [...(previous?.successfulChannelIds || [])],
      nextAttemptAt: now + retryDelay,
    };
    rt._reportDelivery = delivery;
    rt._reportRunning = true;
    try {
      // 先写本次尝试，重启后仍遵守次数上限；写库失败时不开始外部发送。
      await rt.store.saveReportDelivery(structuredClone(delivery));
      const channels = reportChannels(rt);
      if (!channels.length) throw noReportChannels();
      const successful = new Set(delivery.successfulChannelIds);
      const pending = channels.filter((channel) => !successful.has(channel.id));
      if (pending.length) {
        const { title, text, html, degraded } = await buildReport(rt);
        // 收入或成本没读到：先按退避重试，最后一次还是这样才发降级的那份（design/ui-copy-spec.md §10）
        if (degraded && delivery.attempts < REPORT_MAX_ATTEMPTS) throw new Error("收入或成本没读到，稍后再试");
        const results = await broadcast(pending, title, text, { event: "daily-report", html });
        for (const result of results) if (result.ok) successful.add(result.id);
      }
      delivery.successfulChannelIds = [...successful];
      // 配置可能在发送期间变化，按当前启用渠道判断是否完成。
      const currentChannels = reportChannels(rt);
      const complete = currentChannels.length > 0 && currentChannels.every((channel) => successful.has(channel.id));
      delivery.nextAttemptAt = Date.now() + retryDelay;
      await rt.store.saveReportDelivery(structuredClone(delivery), complete ? today : null);
      if (complete) console.log(`日报已发送（${today} ${cfg.time}）`);
      else console.error(`日报部分渠道发送失败（第 ${delivery.attempts}/${REPORT_MAX_ATTEMPTS} 次）`);
    } catch (err) {
      console.error("日报发送失败:", err?.message);
      delivery.nextAttemptAt = Date.now() + retryDelay;
      try {
        await rt.store.saveReportDelivery(structuredClone(delivery));
      } catch (saveErr) {
        // 进度保存也可能慢失败；本进程仍从最后一次失败完成后等待。
        delivery.nextAttemptAt = Date.now() + retryDelay;
        console.error("日报发送进度保存失败:", saveErr?.message);
      }
    } finally {
      rt._reportRunning = false;
    }
  }, 30000);
}
