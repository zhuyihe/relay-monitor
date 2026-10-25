// 界面文案守护（design/ui-copy-spec.md §12.6）：扫描页面里给用户看的字，命中 §3.6 的词或多余的英文就失败。
// 含中文的字符串和 JSX 里的文字算界面文字；注释、import、类型、console 和 Error 的参数（只给开发看，§12.4）不扫。
// 范围跟着文案改动一批批扩大：A2 结束时 app/ 下全部页面和组件都扫，接口逐个列；A3-1 加通知方式的报错（lib/smtp.js、通知和日报的接口），
// A3-2 加推送（lib/alerts.js、lib/notify.js），A3-3 加日报（server/report.js）。
// 推送和日报的整句是运行时拼出来的，守护扫不到，最后两条测试拿固定数据真的跑一遍再扫。
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Store } from "../db/store.js";
import { evaluateStation } from "../lib/alerts.js";
import { buildReport } from "../server/report.js";

const ts = createRequire(import.meta.url)("typescript");
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// 一个目录下（含子目录）的源码文件，不含测试；skip 里的子目录不进
const walk = (dir, skip = []) => readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
  const path = join(dir, entry.name);
  if (entry.isDirectory()) return skip.includes(path) ? [] : walk(path, skip);
  return /\.(tsx?|jsx?)$/.test(entry.name) && !/\.test\./.test(entry.name) ? [path] : [];
});

const FILES = [
  // app/ 下全部页面和组件；接口在下面逐个列，app/mock 是演示用的假上游，不上界面
  ...walk("app", ["app/api", "app/mock"]),
  "server/demo.js",
  "lib/brand.js",
  "lib/reconciliation-view.js",
  "lib/upstream-merge-view.js",
  "lib/reconciliation-contract.js",
  "lib/workflow-actions.js",
  "lib/error-copy.js",
  "lib/channel-onboarding.js",
  "lib/onboarding-workflow.js",
  "lib/format.js",
  "lib/overview-actions.js",
  "lib/profit.js",
  "lib/client.ts",
  "lib/providers.js",
  "lib/connection-test.js",
  "lib/api.js",
  "lib/cap.js",
  "lib/smtp.js",
  "lib/alert-rules.js",
  "lib/alerts.js",
  "lib/notify.js",
  "server/own-helpers.js",
  "server/report.js",
  "db/store.js",
  "app/api/meta/route.js",
  "app/api/analytics/route.js",
  "app/api/analytics/coverage.js",
  ...["admin-keys", "analytics", "audit"].map((name) => `app/api/own/${name}/route.js`),
  ...["", "/test", "/[id]", "/[id]/history", "/[id]/refresh"].map((dir) => `app/api/stations${dir}/route.js`),
  "app/api/stations/[id]/purge.js",
  ...walk("app/api/auth"),
  ...walk("app/api/notifications"),
  ...walk("app/api/report"),
];

// §3.6 里不分场合都不能上界面的词。「范围」「关联」「授权」「资源」「站点」「完整」这类要看场合的，靠逐条改文案，不在这里卡。
// 「版本」只卡 §3.6、§9 不显示的那几种；「软件版本」（§11）和「对方的版本不支持这项功能」（§8.2）照用
const FORBIDDEN = [
  "核算", "结账", "自然日", "窗口", "分段", "生效", "范围版本", "计算版本", "授权版本", "配置版本", "版本号", "口径", "计法", "证据", "能力", "核验", "核对", "凭证", "凭据",
  "仅供参考", "待获取", "获取中", "不可用", "读取失败", "查询失败", "尚未查询", "数据已过期", "最后刷新", "更新于", "最近成功",
  "快照", "账本", "迁移", "旧账", "兜底", "降级", "轮询", "采集", "留存", "回归", "回测", "精算", "推算",
  "中转站", "本站", "阈值", "耗尽", "摊销", "待办", "待处理", "待核算", "已核验", "已取全", "原币", "归属", "覆盖",
  // §3.3、§3.2：「消耗」改「花费」，「期内收入」这类去掉「期内」（单写「期内」会误伤「日期内」），算不出写「—」
  "消耗", "期内成本", "期内收入", "期内经营", "期内总", "期内消费", "无法计算",
  // §3.4：缓存只写「缓存」
  "缓存读写", "缓存读", "缓存写",
];

// §3.7 的类型名和输入框名，以及 Key、ID、Token；文案表里的 {channel} 这类占位符填的是名称和时间。去掉这些后不该再有英文字母。
// 「API」只许出现在类型名和 Key 说明里的上游页面名「API 密钥」中，单独写的「API」「API 地址」算后端用语；
// 「UTC 时间」是 §6 那句「按 UTC 时间算一天」
const ALLOWED_ENGLISH = /New API|Sub2API|「API 密钥」|Key|ID|Token|UTC 时间|sk-|https?:\/\/[\w./-]+|\{\w+\}/g;
// lib/notify.js 是通知方式的类型名和填写项：§3.7 让它们照对方后台的原名写（类型名里的品牌、Webhook 地址、ntfy 令牌、Resend Key、
// SMTP 服务器的例子、请求头的 JSON 格式），只在这个文件放行，别处照样卡
const ENGLISH_ALLOWED_IN = Object.freeze({
  "lib/notify.js": /Telegram|Server酱|Resend|SMTP|smtp\.gmail\.com|Webhook|ntfy|JSON 格式|re_ 开头/g,
  // 新式访问令牌「作废」那句说明里的 nap_ 开头（用语规范 §5.2）
  "lib/reconciliation-contract.js": /nap_ 开头/g,
});
const leftoverEnglish = (file, text) =>
  /[A-Za-z]/.test((ENGLISH_ALLOWED_IN[file] ? text.replace(ENGLISH_ALLOWED_IN[file], "") : text).replace(ALLOWED_ENGLISH, ""));
const CJK = /[一-鿿]/;

function skipped(node) {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent) || ts.isTypeNode(parent)) return true;
    // 日期选择框的 format 是格式串
    if (ts.isJsxAttribute(parent) && parent.name.getText() === "format") return true;
    // 只跳过造报错对象的：new Error、TypeError，和带 code 的 batchError、repositoryError、providerError、newApiResponseError、
    // catalogueError、deliveryError（页面按 code 归类，原话只进「详情」）；
    // setError 这类存的是要显示的话，照样扫
    if (ts.isCallExpression(parent) || ts.isNewExpression(parent)) {
      const callee = parent.expression.getText();
      if (/^console\./.test(callee) || /^((Type|Range|Syntax)?Error|batchError|repositoryError|providerError|newApiResponseError|catalogueError|deliveryError)$/.test(callee)) return true;
    }
  }
  return false;
}

// 一个文件里的界面文字：[行号, 文字]
function visibleTexts(file) {
  const source = ts.createSourceFile(file, readFileSync(join(ROOT, file), "utf8"), ts.ScriptTarget.Latest, true,
    file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const texts = [];
  const visit = (node) => {
    let text = null;
    if (ts.isJsxText(node)) text = node.getText().trim();
    else if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node)
      || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      text = CJK.test(node.text) ? node.text : null;
      // 对象的键不是界面文字
      if (text && ts.isPropertyAssignment(node.parent) && node.parent.name === node) text = null;
    }
    if (text && !skipped(node)) texts.push([source.getLineAndCharacterOfPosition(node.getStart()).line + 1, text]);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return texts;
}

test("界面文字不出现 §3.6 的词", () => {
  const hits = FILES.flatMap((file) => visibleTexts(file).flatMap(([line, text]) => FORBIDDEN
    .filter((word) => text.includes(word)).map((word) => `${file}:${line}「${word}」${text}`)));
  assert.deepEqual(hits, []);
});

test("界面文字除 §3.7 的词和 Key、ID、Token 外不出现英文", () => {
  const hits = FILES.flatMap((file) => visibleTexts(file)
    .filter(([, text]) => leftoverEnglish(file, text))
    .map(([line, text]) => `${file}:${line} ${text}`));
  assert.deepEqual(hits, []);
});

test("余额推送拼出来的整句也不出现 §3.6 的词和多余的英文（运行时扫描）", async (t) => {
  const sent = [];
  t.mock.method(globalThis, "fetch", async (url, init) => { sent.push(JSON.parse(init.body)); return new Response("{}", { status: 200 }); });
  const channel = { id: "c", type: "webhook", name: "运维群", enabled: true, config: { url: "https://hooks.example.com/x" } };
  const rules = { onLow: true, onExhaust: true, onError: true, onRecover: true, onEta: true, etaDays: 3, renotifyHours: 1 };
  const push = async (station, prediction) => {
    station.alertState = (await evaluateStation(station, prediction, rules, [channel], 5)) || station.alertState;
  };
  // 各种推送各来一次：余额偏低、持续告警、余额用完、恢复、读不到余额、快用完、不再续费、没设汇率、没起名字
  const a = { id: "a", name: "主力上游", type: "newapi", cnyPerUsd: 7.2, balance: { ok: true, remaining: 4 } };
  await push(a, { burnPerDay: 2.1, etaDays: 1.9 });
  a.alertState.notifiedAt = 0;
  await push(a, { burnPerDay: 2.1, etaDays: 1.9 });
  a.balance = { ok: true, remaining: 0 };
  await push(a, { burnPerDay: 2.1, etaDays: 0 });
  a.balance = { ok: true, remaining: 80 };
  await push(a, null);
  await push({ id: "b", name: "备用上游", type: "sub2api", balance: { ok: false, error: "Unauthorized", code: "AUTHENTICATION_FAILED" } }, null);
  await push({ id: "c", name: "", type: "newapi", balance: { ok: true, remaining: 50 } }, { burnPerDay: 20, etaDays: 2.5 });
  await push({ id: "d", name: "包月上游", type: "newapi", noRenewal: true, balance: { ok: true, remaining: 3 } }, { burnPerDay: 0, etaDays: null });
  assert.equal(sent.length, 7);
  // 每种都以落款结尾：钉钉、飞书机器人的关键词靠它（§10）
  assert.deepEqual(sent.map(({ body }) => body.split("\n").at(-1)), sent.map(() => "炬元告警中心"));
  const texts = sent.flatMap(({ title, body }) => [title, ...body.split("\n")]);
  assert.deepEqual(texts.flatMap((text) => FORBIDDEN.filter((word) => text.includes(word)).map((word) => `「${word}」${text}`)), []);
  assert.deepEqual(texts.filter((text) => leftoverEnglish("", text)), []);
});

test("日报拼出来的整句也不出现 §3.6 的词和多余的英文（运行时扫描）", async (t) => {
  // 北京时间 10月8日 9:00，日报统计 10月7日；名字都用中文，扫出来的英文只会是日报自己的字
  const dayStart = Date.parse("2026-10-06T16:00:00Z");
  t.mock.timers.enable({ apis: ["Date"], now: dayStart + 33 * 3600000 });
  const USD = 500000;
  const sec = (day, hour = 10) => (dayStart + day * 86400000 + hour * 3600000) / 1000;
  const scan = async ({ usersDown = false, channelsDown = false } = {}) => {
    const store = new Store({ getConnection: async () => { throw new Error("不写库"); } });
    const up = (id, name, extra = {}) => ({ id, name, type: "newapi", baseUrl: `https://${id}.example`, accessToken: "t", cnyPerUsd: 7.2, ...extra });
    store.data.stations = [
      { id: "own", type: "newapi", isOwn: true, name: "自营站", baseUrl: "https://own.example", accessToken: "t", cnyPerUsd: null },
      up("a", "主力上游", { balance: { ok: true, remaining: 400 } }),
      up("b", "备用上游", { cnyPerUsd: null, balance: { ok: true, remaining: 4 } }),
      up("c", "用完上游", { balance: { ok: true, remaining: 0 } }),
      up("d", "读不到上游", { balance: { ok: false, error: "Unauthorized", code: "AUTHENTICATION_FAILED" } }),
      up("e", "新上游", { includeInProfit: false }),
      up("f", "闲置上游", { balance: { ok: true, remaining: 100 } }),
      { id: "g", name: "服务器", type: "fixed", fixedPurchases: [{ amount: 300, days: 30, startDate: "2026-10-01" }, { amount: 10, days: 3, startDate: "2026-09-01" }] },
    ];
    const predictions = { a: { burnPerDay: 50, etaDays: 8 }, b: { burnPerDay: 2, etaDays: 2 }, c: { burnPerDay: 3, etaDays: 0 }, f: { burnPerDay: 0, etaDays: null } };
    const rt = { store, history: { predict: (id) => predictions[id] ?? null, usedBetween: () => 1 } };
    const ok = (data) => Response.json({ success: true, data });
    const down = () => Response.json({ success: false, message: "unavailable" }, { status: 503 });
    t.mock.method(globalThis, "fetch", async (input) => {
      const url = new URL(input);
      if (url.host === "own.example") {
        if (url.pathname === "/api/user/") return usersDown ? down() : ok({ items: [
          { id: 1, username: "管理员甲", role: 100, quota: 0, status: 1 }, { id: 2, username: "用户甲", role: 1, quota: 20 * USD, status: 1 },
        ], total: 2 });
        if (url.pathname === "/api/channel/") return channelsDown ? down() : ok({ items: [{ id: 1, name: "渠道甲", base_url: "https://x.example", status: 1 }], total: 1 });
        if (url.pathname === "/api/data/users") return ok([
          { username: "用户甲", created_at: sec(0), quota: 30 * USD, token_used: 50000, count: 20 },
          { username: "管理员甲", created_at: sec(0), quota: 60 * USD, token_used: 30000, count: 10 },
        ]);
        if (url.pathname === "/api/data/") return ok([
          ...Array.from({ length: 20 }, (_, i) => ({ model_name: "模型甲", created_at: sec(-20 + i), quota: (60 + i * 3) * USD, token_used: 1000, count: 10 })),
          { model_name: "模型甲", created_at: sec(0), quota: 70 * USD, token_used: 60000, count: 20 },
          { model_name: "模型乙", created_at: sec(0), quota: 20 * USD, token_used: 20000, count: 10 },
        ]);
        return ok([]);
      }
      // 主力上游的用量接口读不到，改按余额变化估算
      if (url.host === "a.example") return down();
      return ok([]);
    });
    const { title, text, html } = await buildReport(rt);
    return [title, ...text.split("\n"), ...html.replace(/<[^>]+>/g, "\n").split("\n")].map((line) => line.trim()).filter(Boolean);
  };
  // 正常的一份（含亏损、估算、没设置售价和汇率、读不到余额）和收入、成本都读不到的一份
  const texts = [...await scan(), ...await scan({ usersDown: true, channelsDown: true })];
  assert.ok(texts.some((text) => text.includes("亏损")) && texts.some((text) => text.includes("没读到")), "两份都跑到了");
  assert.deepEqual(texts.flatMap((text) => FORBIDDEN.filter((word) => text.includes(word)).map((word) => `「${word}」${text}`)), []);
  assert.deepEqual(texts.filter((text) => leftoverEnglish("", text)), []);
});
