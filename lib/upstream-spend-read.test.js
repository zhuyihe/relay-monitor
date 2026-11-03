// 读上游每天花了多少（lib/providers.js queryUpstreamDailySpend）：New API（数据看板一次读一段、按天退回 stat）和 Sub2API（按天趋势）
import assert from "node:assert/strict";
import test from "node:test";
import { QUOTA_PER_UNIT, SPEND_DENIED_CODES, queryStation, queryUpstreamDailySpend } from "./providers.js";
import { dayStartInTz } from "./business-time.js";

const TZ = "Asia/Shanghai";
const START = dayStartInTz("2026-10-01", TZ), END = dayStartInTz("2026-10-31", TZ); // 30 个整天
const newApi = { id: "up", type: "newapi", baseUrl: "https://up.test", accessToken: "tok", userId: "7" };
const sub2 = { id: "sub", type: "sub2api", baseUrl: "https://sub.test", accessToken: "jwt" };
const noSleep = async () => {};
const hour = (day, h) => Math.floor((dayStartInTz(day, TZ) + h * 3600000) / 1000); // data/self 每条是一小时，created_at 是那个小时的起点（秒）

function fakeFetch(t, handler) {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (input) => {
    const url = new URL(String(input));
    calls.push(url);
    return handler(url, calls.length);
  });
  return calls;
}
const json = (body, status = 200) => Response.json(body, { status });

test("New API：数据看板一次读 30 天，按业务时区分天，没花钱的天是 0，额度除以 QUOTA_PER_UNIT（和余额同一个换算）", async (t) => {
  const calls = fakeFetch(t, () => json({ success: true, data: [
    { created_at: hour("2026-10-01", 0), quota: QUOTA_PER_UNIT * 2, model_name: "a", count: 1, token_used: 1 },       // 10-01 00:00 上海
    { created_at: hour("2026-10-01", 23), quota: QUOTA_PER_UNIT, model_name: "b", count: 1, token_used: 1 },          // 10-01 23:00 仍是 10-01
    { created_at: hour("2026-10-02", 0), quota: QUOTA_PER_UNIT * 4, model_name: "a", count: 1, token_used: 1 },       // 10-02 00:00
    { created_at: hour("2026-10-30", 12), quota: QUOTA_PER_UNIT * 0.5, model_name: "a", count: 1, token_used: 1 },
  ] }));
  const result = await queryUpstreamDailySpend(newApi, { startMs: START, endMs: END, timezone: TZ, sleep: noSleep });
  assert.equal(calls.length, 1, "一次读一段");
  assert.equal(calls[0].pathname, "/api/data/self");
  const span = Number(calls[0].searchParams.get("end_timestamp")) - Number(calls[0].searchParams.get("start_timestamp"));
  assert.ok(span <= 30 * 86400, "New API 一次最多读一个月：" + span);
  assert.equal(result.source, "dashboard");
  assert.equal(result.days.length, 30);
  assert.deepEqual([result.days[0], result.days[1], result.days[2]], [{ day: "2026-10-01", usd: 3 }, { day: "2026-10-02", usd: 4 }, { day: "2026-10-03", usd: 0 }]);
  assert.deepEqual(result.days.at(-1), { day: "2026-10-30", usd: 0.5 });
  assert.equal(new Set(result.days.map((day) => day.day)).size, 30);
});

test("花费和余额同一个口径：同一个账号 quota=1000000，余额页读到 $2，每天花费里同样 $2 额度也是 $2", async (t) => {
  fakeFetch(t, (url) => (url.pathname === "/api/user/self"
    ? json({ success: true, data: { quota: 1000000, used_quota: 0, username: "u" } })
    : json({ success: true, data: [{ created_at: hour("2026-10-05", 3), quota: 1000000, model_name: "a", count: 1, token_used: 1 }] })));
  const balance = (await queryStation(newApi)).result;
  const spend = await queryUpstreamDailySpend(newApi, { startMs: START, endMs: END, timezone: TZ, sleep: noSleep });
  assert.equal(balance.remaining, 2);
  assert.equal(spend.days.find((day) => day.day === "2026-10-05").usd, balance.remaining);
});

test("New API：看板一天都没有数、整段 stat 也说没花钱 → 都是 0，2 个请求（看板 + 对一下）", async (t) => {
  const calls = fakeFetch(t, (url) => (url.pathname === "/api/data/self" ? json({ success: true, data: [] }) : json({ success: true, data: { quota: 0 } })));
  const result = await queryUpstreamDailySpend(newApi, { startMs: START, endMs: END, timezone: TZ, sleep: noSleep });
  assert.deepEqual(calls.map((url) => url.pathname), ["/api/data/self", "/api/log/self/stat"]);
  assert.ok(result.days.every((day) => day.usd === 0));
  assert.equal(result.source, "dashboard");
});

test("New API：看板空（对方没开数据看板）但 stat 说花了钱 → 按天退回 stat，一天一个请求、不带 token_name，请求之间隔开", async (t) => {
  const calls = fakeFetch(t, (url) => {
    if (url.pathname === "/api/data/self") return json({ success: true, data: [] });
    const start = Number(url.searchParams.get("start_timestamp")), end = Number(url.searchParams.get("end_timestamp"));
    const wholeWindow = end - start > 86400 * 2;
    return json({ success: true, data: { quota: wholeWindow ? QUOTA_PER_UNIT * 99 : start === Math.ceil(START / 1000) ? QUOTA_PER_UNIT * 3 : 0 } });
  });
  const gaps = [];
  const result = await queryUpstreamDailySpend(newApi, { startMs: START, endMs: END, timezone: TZ, sleep: async (ms) => { gaps.push(ms); }, gapMs: 1000 });
  assert.equal(result.source, "stat");
  assert.equal(calls.length, 1 + 1 + 30, "看板 1 + 对一下 1 + 一天一个 30");
  const perDay = calls.slice(2);
  assert.ok(perDay.every((url) => url.pathname === "/api/log/self/stat" && !url.searchParams.has("token_name") && url.searchParams.get("type") === "2"));
  assert.ok(perDay.every((url) => Number(url.searchParams.get("end_timestamp")) - Number(url.searchParams.get("start_timestamp")) === 86400 - 1), "每个请求正好一天");
  assert.equal(result.days.length, 30);
  assert.deepEqual(result.days[0], { day: "2026-10-01", usd: 3 });
  assert.deepEqual(gaps, Array(29).fill(1000), "30 个请求之间隔 29 次");
});

test("New API：看板接口读不了（对方说没开）→ 直接按天读 stat，不多发看板请求", async (t) => {
  const calls = fakeFetch(t, (url) => (url.pathname === "/api/data/self" ? json({ success: false, message: "数据看板未启用" })
    : json({ success: true, data: { quota: QUOTA_PER_UNIT } })));
  const result = await queryUpstreamDailySpend(newApi, { startMs: START, endMs: END, timezone: TZ, sleep: noSleep });
  assert.equal(calls.length, 1 + 30);
  assert.equal(result.source, "stat");
  assert.ok(result.days.every((day) => day.usd === 1));
});

test("New API：按天读到一半上游断路了（shouldPause）→ 停下，抛暂时读不到，不是「不给读」", async (t) => {
  fakeFetch(t, (url) => (url.pathname === "/api/data/self" ? json({ success: false, message: "未启用" }) : json({ success: true, data: { quota: 1 } })));
  let asked = 0;
  await assert.rejects(queryUpstreamDailySpend(newApi, { startMs: START, endMs: END, timezone: TZ, sleep: noSleep, shouldPause: () => ++asked > 3 }),
    (error) => error.code === "UPSTREAM_REQUEST_FAILED" && !SPEND_DENIED_CODES.includes(error.code));
});

test("New API：对方繁忙或没连上 → 抛错，不再退回 stat（stat 也一样读不了）；登录信息不对同理", async (t) => {
  for (const [status, code] of [[500, "UPSTREAM_REQUEST_FAILED"], [429, "UPSTREAM_REQUEST_FAILED"], [401, "AUTHENTICATION_FAILED"]]) {
    const calls = fakeFetch(t, () => json({ success: false, message: "x" }, status));
    await assert.rejects(queryUpstreamDailySpend(newApi, { startMs: START, endMs: END, timezone: TZ, sleep: noSleep }), (error) => error.code === code);
    assert.equal(calls.length, 1, `${status}：只发了看板这一个请求`);
    globalThis.fetch.mock.restore();
  }
});

test("New API：看板和 stat 都不给读（404、403）→ 抛「不给读」一类的码", async (t) => {
  for (const status of [404, 403]) {
    fakeFetch(t, () => json({ success: false, message: "no" }, status));
    await assert.rejects(queryUpstreamDailySpend(newApi, { startMs: START, endMs: END, timezone: TZ, sleep: noSleep }), (error) => SPEND_DENIED_CODES.includes(error.code));
    globalThis.fetch.mock.restore();
  }
});

test("Sub2API：按天趋势一次读一段（granularity=day、业务时区），金额是美元、缺的天是 0、只取范围内的天", async (t) => {
  const calls = fakeFetch(t, () => json({ code: 0, data: { models: [], trend: [
    { date: "2026-10-01", actual_cost: 1.25, requests: 3 }, { date: "2026-10-03", actual_cost: 2.5, requests: 1 }, { date: "2026-09-30", actual_cost: 99 }, { date: "2026-10-31", actual_cost: 98 },
  ] } }));
  const result = await queryUpstreamDailySpend(sub2, { startMs: START, endMs: END, timezone: TZ, sleep: noSleep });
  assert.equal(calls.length, 1, "一次读一段");
  assert.equal(calls[0].searchParams.get("granularity"), "day");
  assert.equal(calls[0].searchParams.get("timezone"), TZ);
  assert.equal(calls[0].searchParams.get("start_date"), "2026-10-01");
  assert.equal(calls[0].searchParams.get("end_date"), "2026-10-30");
  assert.equal(result.source, "trend");
  assert.equal(result.days.length, 30);
  assert.deepEqual([result.days[0].usd, result.days[1].usd, result.days[2].usd], [1.25, 0, 2.5]);
});

test("Sub2API：不给读（403）→ 「不给读」一类的码；对方繁忙 → 暂时读不到", async (t) => {
  fakeFetch(t, () => json({ code: 403, message: "forbidden" }, 403));
  await assert.rejects(queryUpstreamDailySpend(sub2, { startMs: START, endMs: END, timezone: TZ, sleep: noSleep }), (error) => SPEND_DENIED_CODES.includes(error.code));
  globalThis.fetch.mock.restore();
  fakeFetch(t, () => json({ code: 500, message: "busy" }, 503));
  await assert.rejects(queryUpstreamDailySpend(sub2, { startMs: START, endMs: END, timezone: TZ, sleep: noSleep }), (error) => error.code === "UPSTREAM_REQUEST_FAILED");
});

test("别的类型（sk 密钥、固定成本）没有用量接口：抛「不给读」一类的码，不发请求", async (t) => {
  const calls = fakeFetch(t, () => json({}));
  for (const type of ["newapi-key", "fixed"]) {
    await assert.rejects(queryUpstreamDailySpend({ id: "x", type, baseUrl: "https://x.test", apiKey: "sk-x" }, { startMs: START, endMs: END, timezone: TZ, sleep: noSleep }), (error) => SPEND_DENIED_CODES.includes(error.code));
  }
  assert.equal(calls.length, 0);
});
