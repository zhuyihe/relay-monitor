import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import test from "node:test";
import { queryStation } from "./providers.js";

function seededHex(seed, length) {
  let state = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    state ^= seed.charCodeAt(i);
    state += (state << 1) + (state << 4) + (state << 7) + (state << 8) + (state << 24);
  }
  state >>>= 0;
  let out = "";
  while (out.length < length) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    out += (state >>> 0).toString(16).padStart(8, "0");
  }
  return out.slice(0, length);
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function sendJson(response, body, status = 200) {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

test("Sub2API password login solves a Cap challenge and sends turnstile_token", async (t) => {
  const challengeToken = "local-challenge";
  const challengeSpec = { c: 2, s: 8, d: 1 };
  let origin;
  let loginBody;

  const server = createServer(async (request, response) => {
    if (request.url === "/api/v1/settings/public") {
      return sendJson(response, {
        code: 0,
        data: {
          turnstile_enabled: true,
          captcha_provider: "cap",
          cap_api_endpoint: `${origin}/cap`,
          cap_site_key: "local-site",
        },
      });
    }
    if (request.url === "/cap/local-site/challenge" && request.method === "POST") {
      return sendJson(response, { challenge: challengeSpec, token: challengeToken });
    }
    if (request.url === "/cap/local-site/redeem" && request.method === "POST") {
      const body = await readJson(request);
      assert.equal(body.token, challengeToken);
      assert.equal(body.solutions.length, challengeSpec.c);
      for (let i = 0; i < body.solutions.length; i++) {
        const n = i + 1;
        const salt = seededHex(`${challengeToken}${n}`, challengeSpec.s);
        const target = seededHex(`${challengeToken}${n}d`, challengeSpec.d);
        const hash = createHash("sha256").update(`${salt}${body.solutions[i]}`).digest("hex");
        assert.ok(hash.startsWith(target));
      }
      return sendJson(response, { success: true, token: "local-cap-token", expires: Date.now() + 60000 });
    }
    if (request.url === "/api/v1/auth/login" && request.method === "POST") {
      loginBody = await readJson(request);
      return sendJson(response, {
        code: 0,
        data: {
          access_token: "access-token",
          refresh_token: "refresh-token",
          expires_in: 3600,
          user: { email: "user@example.com" },
        },
      });
    }
    if (request.url === "/api/v1/auth/me") {
      assert.equal(request.headers.authorization, "Bearer access-token");
      return sendJson(response, {
        code: 0,
        data: { email: "user@example.com", balance: 12.5, total_recharged: 20 },
      });
    }
    if (request.url === "/api/v1/usage/dashboard/stats") {
      return sendJson(response, {
        code: 0,
        data: { today_actual_cost: 1.25, today_requests: 3, today_tokens: 4000 },
      });
    }
    sendJson(response, { error: "not found" }, 404);
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  origin = `http://127.0.0.1:${address.port}`;

  const station = {
    type: "sub2api-password",
    baseUrl: origin,
    email: "user@example.com",
    password: "secret123",
  };
  const { result, tokensChanged } = await queryStation(station);

  assert.equal(result.ok, true);
  assert.equal(result.remaining, 12.5);
  assert.equal(result.used, 7.5);
  assert.equal(result.todayUsed, 1.25);
  assert.equal(tokensChanged, true);
  assert.deepEqual(loginBody, {
    email: "user@example.com",
    password: "secret123",
    turnstile_token: "local-cap-token",
  });
  assert.equal(station.s2Tokens.refreshToken, "refresh-token");
});

test("流向数据把用户/分组/模型/渠道口径归一化", async (t) => {
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://x");
    assert.equal(url.pathname, "/api/data/flow");
    assert.equal(request.headers.authorization, "adm");
    assert.equal(request.headers["new-api-user"], "6");
    assert.equal(url.searchParams.get("start_timestamp"), "1000");
    assert.equal(url.searchParams.get("end_timestamp"), "1059"); // 结束值包含式，减到窗内最后一秒
    sendJson(response, {
      success: true,
      data: [
        { username: "a", use_group: "grok", model_name: "grok-4.6", channel_id: 7, channel_name: "sol", token_used: 400, count: 596, quota: 76000000 },
        { username: "b", use_group: "", model_name: "gpt-4o", channel_id: 1, token_used: 100, count: 3, quota: 500000 },
      ],
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const origin = `http://127.0.0.1:${server.address().port}`;
  const { queryOwnFlow } = await import("./providers.js");

  const rows = await queryOwnFlow({ baseUrl: origin, accessToken: "adm", userId: "6" }, 1000000, 1060000);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], {
    user: "a", group: "grok", model: "grok-4.6", channelId: 7, channelName: "sol",
    tokenName: "", tokens: 400, cost: 152, requests: 596,
  });
  assert.equal(rows[1].channelName, ""); // 没有 channel_name 时留空，由调用方兜底
});

test("渠道对账用固定 Key 名称查询分段统计，不用当前分组过滤旧日志", async (t) => {
  let selfCalls = 0;
  let expectedUserId = "42";
  let flowCalls = 0;
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://x");
    if (url.pathname === "/api/status") {
      return sendJson(response, { success: true, data: { version: "test", quota_per_unit: 100 } });
    }
    if (url.pathname === "/api/user/self") {
      selfCalls += 1;
      assert.equal(request.headers.authorization, "Bearer pat");
      assert.equal(request.headers["new-api-user"], undefined);
      return sendJson(response, { success: true, data: { id: 42 } });
    }
    if (["/api/token/", "/api/user/self/groups", "/api/log/self/stat"].includes(url.pathname)) {
      assert.equal(request.headers.authorization, "Bearer pat");
      assert.equal(request.headers["new-api-user"], expectedUserId);
    }
    if (url.pathname === "/api/token/") {
      return sendJson(response, { success: true, data: { total: 1, items: [
        { id: 9, name: "oai", status: 1, group: "oai", cross_group_retry: false, key: "sk-masked" },
      ] } });
    }
    if (url.pathname === "/api/user/self/groups") {
      return sendJson(response, { success: true, data: { oai: { ratio: 2.3, desc: "OpenAI" } } });
    }
    if (url.pathname === "/api/log/self/stat") {
      assert.equal(url.searchParams.get("type"), "0");
      assert.equal(url.searchParams.get("token_name"), "oai");
      assert.equal(url.searchParams.has("group"), false);
      assert.equal(url.searchParams.get("start_timestamp"), "1000");
      assert.equal(url.searchParams.get("end_timestamp"), "1059");
      assert.equal(url.searchParams.has("p"), false);
      assert.equal(url.searchParams.has("page_size"), false);
      return sendJson(response, { success: true, data: { quota: 400, rpm: 2, tpm: 3 } });
    }
    if (url.pathname === "/api/log/stat") {
      assert.equal(url.searchParams.get("type"), "2");
      assert.equal(url.searchParams.get("channel"), "1");
      assert.equal(url.searchParams.has("channel_id"), false);
      assert.equal(url.searchParams.get("start_timestamp"), "1000");
      assert.equal(url.searchParams.get("end_timestamp"), "1059");
      return sendJson(response, { success: true, data: { quota: 500 } });
    }
    if (url.pathname === "/api/data/flow") {
      flowCalls += 1;
      return sendJson(response, { success: true, data: [
        { channel_id: 1, channel_name: "渠道 A", quota: 500, token_used: 2, count: 1 },
        { channel_id: 2, channel_name: "渠道 B", quota: 300, token_used: 1, count: 1 },
      ] });
    }
    if (url.pathname === "/api/data/") {
      return sendJson(response, { success: true, data: [
        { model_name: "gpt", created_at: 1000, quota: 800, token_used: 3, count: 2 },
      ] });
    }
    return sendJson(response, { error: "not found" }, 404);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const origin = `http://127.0.0.1:${server.address().port}`;
  const { queryNewApiReconciliationMetadata, queryNewApiTokenStat, queryOwnChannelRevenue } = await import("./providers.js");
  const station = { baseUrl: origin, accessToken: "pat" };

  const metadata = await queryNewApiReconciliationMetadata(station);
  assert.equal(selfCalls, 1);
  assert.deepEqual(metadata.groups.oai, { ratio: 2.3, description: "OpenAI" });
  assert.equal(metadata.tokens[0].id, 9);
  assert.equal(metadata.tokens[0].maskedKey, "sk-masked");

  const upstream = await queryNewApiTokenStat(station, { tokenName: "oai", startMs: 1000000, endMs: 1060000 });
  assert.equal(selfCalls, 2);
  assert.equal(upstream.quotaUnits, 400);
  assert.equal(upstream.quotaPerUnit, 100);
  assert.equal(upstream.quotaUnits / upstream.quotaPerUnit, 4);

  expectedUserId = "configured-user";
  const configuredStation = { baseUrl: origin, accessToken: "pat", userId: expectedUserId };
  await queryNewApiReconciliationMetadata(configuredStation);
  assert.equal(selfCalls, 2);
  await queryNewApiTokenStat(configuredStation, { tokenName: "oai", startMs: 1000000, endMs: 1060000 });
  assert.equal(selfCalls, 2);

  const downstream = await queryOwnChannelRevenue(station, { channelIds: [1], startMs: 1000000, endMs: 1060000 });
  assert.equal(downstream.quotaUnits, 500);
  assert.equal(downstream.channels[0].amountUsd, 5);
  assert.equal(downstream.coverage, 1);
  assert.equal(downstream.billingSource, "channel-log-stat");
  assert.equal(downstream.calculationVersion, 2);
  assert.equal(flowCalls, 0, "财务收费不得请求 /api/data/flow");
});

test("渠道对账以渠道账单 stat 为收费事实源，不使用偏低的 flow 聚合", async (t) => {
  let flowCalls = 0;
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://x");
    if (url.pathname === "/api/status") {
      return sendJson(response, { success: true, data: { quota_per_unit: 500000 } });
    }
    if (url.pathname === "/api/log/stat") {
      assert.equal(url.searchParams.get("type"), "2");
      assert.equal(url.searchParams.get("channel"), "312");
      assert.equal(url.searchParams.has("channel_id"), false);
      return sendJson(response, { success: true, data: { quota: 4821634 } });
    }
    if (url.pathname === "/api/data/flow") {
      flowCalls += 1;
      return sendJson(response, { success: true, data: [{ channel_id: 312, quota: 3355887 }] });
    }
    return sendJson(response, { success: false }, 404);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const origin = `http://127.0.0.1:${server.address().port}`;
  const { queryOwnChannelRevenue } = await import("./providers.js");

  const result = await queryOwnChannelRevenue(
    { baseUrl: origin, accessToken: "admin" },
    { channelIds: [312], startMs: 1000000, endMs: 1060000 }
  );

  assert.equal(result.quotaUnits, 4821634);
  assert.equal(result.amountUsd, 9.643268);
  assert.equal(result.channels[0].quotaUnits, 4821634);
  assert.equal(flowCalls, 0, "财务收费不得回退到 /api/data/flow");
});

test("多渠道账单按去重渠道并行查询并只汇总一次", async (t) => {
  const requestedChannels = [];
  let active = 0;
  let maxActive = 0;
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://x");
    if (url.pathname === "/api/status") {
      return sendJson(response, { success: true, data: { quota_per_unit: 100 } });
    }
    if (url.pathname === "/api/log/stat") {
      const channelId = Number(url.searchParams.get("channel"));
      requestedChannels.push(channelId);
      active += 1;
      maxActive = Math.max(maxActive, active);
      return setTimeout(() => {
        active -= 1;
        sendJson(response, { success: true, data: { quota: channelId === 1 ? 250 : 350 } });
      }, 15);
    }
    return sendJson(response, { success: false }, 404);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const { queryOwnChannelRevenue } = await import("./providers.js");
  const result = await queryOwnChannelRevenue(
    { baseUrl: `http://127.0.0.1:${server.address().port}`, accessToken: "admin" },
    { channelIds: [1, 1, 2], startMs: 1000000, endMs: 1060000 }
  );

  assert.deepEqual(requestedChannels.sort((a, b) => a - b), [1, 2]);
  assert.ok(maxActive > 1, "不同渠道应并行读取账单统计");
  assert.equal(result.quotaUnits, 600);
  assert.equal(result.amountUsd, 6);
  assert.deepEqual(result.channels.map((channel) => [channel.channelId, channel.quotaUnits, channel.amountUsd]), [
    [1, 250, 2.5],
    [2, 350, 3.5],
  ]);
});

test("任一渠道账单失败或 quota 缺失时整体失败关闭，quota=0 仍有效", async (t) => {
  let mode = "zero";
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://x");
    if (url.pathname === "/api/status") {
      return sendJson(response, { success: true, data: { quota_per_unit: 100 } });
    }
    if (url.pathname === "/api/log/stat") {
      const channelId = Number(url.searchParams.get("channel"));
      if (channelId === 2 && mode === "http-error") return sendJson(response, { success: false }, 500);
      if (channelId === 2 && mode === "missing") return sendJson(response, { success: true, data: {} });
      if (channelId === 2 && mode === "null") return sendJson(response, { success: true, data: { quota: null } });
      if (channelId === 2 && mode === "blank") return sendJson(response, { success: true, data: { quota: "  " } });
      if (channelId === 2 && mode === "boolean") return sendJson(response, { success: true, data: { quota: false } });
      if (channelId === 2 && mode === "negative") return sendJson(response, { success: true, data: { quota: -1 } });
      if (channelId === 2 && mode === "array") return sendJson(response, { success: true, data: { quota: [] } });
      if (channelId === 2 && mode === "object") return sendJson(response, { success: true, data: { quota: {} } });
      if (mode === "overflow") return sendJson(response, { success: true, data: { quota: Number.MAX_VALUE } });
      return sendJson(response, { success: true, data: { quota: channelId === 1 ? 0 : 100 } });
    }
    return sendJson(response, { success: false }, 404);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const { queryOwnChannelRevenue } = await import("./providers.js");
  const station = { baseUrl: `http://127.0.0.1:${server.address().port}`, accessToken: "admin" };
  const window = { channelIds: [1], startMs: 1000000, endMs: 1060000 };

  const zero = await queryOwnChannelRevenue(station, window);
  assert.equal(zero.quotaUnits, 0);
  assert.equal(zero.channels[0].amountUsd, 0);

  mode = "http-error";
  await assert.rejects(
    () => queryOwnChannelRevenue(station, { ...window, channelIds: [1, 2] }),
    (error) => error.code === "OWN_BILLING_UNAVAILABLE"
  );
  mode = "missing";
  await assert.rejects(
    () => queryOwnChannelRevenue(station, { ...window, channelIds: [1, 2] }),
    (error) => error.code === "OWN_BILLING_UNAVAILABLE"
  );
  for (const invalidMode of ["null", "blank", "boolean", "negative", "array", "object", "overflow"]) {
    mode = invalidMode;
    await assert.rejects(
      () => queryOwnChannelRevenue(station, { ...window, channelIds: [1, 2] }),
      (error) => error.code === "OWN_BILLING_UNAVAILABLE"
    );
  }
});

test("非整秒窗口只归属完全落在窗口内的 NewAPI 秒，和分段位置无关", async () => {
  const { unixSecondWindow } = await import("./providers.js");
  assert.deepEqual(unixSecondWindow(1000, 1500), { start: 1, end: 0, empty: true });
  assert.deepEqual(unixSecondWindow(1500, 3000), { start: 2, end: 2 });
  assert.deepEqual(unixSecondWindow(1500, 1999), { start: 2, end: 0, empty: true });
});

test("空秒窗口不会请求上下游 API，并明确返回无可核算秒", async (t) => {
  let requests = 0;
  const server = createServer((_request, response) => {
    requests += 1;
    sendJson(response, { success: true, data: {} });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const station = { baseUrl: `http://127.0.0.1:${server.address().port}`, accessToken: "pat" };
  const { queryOwnData, queryOwnFlow, queryOwnChannelRevenue, queryNewApiTokenStat } = await import("./providers.js");

  const ownData = await queryOwnData(station, 1500, 1999, "model");
  const ownFlow = await queryOwnFlow(station, 1500, 1999);
  const ownRevenue = await queryOwnChannelRevenue(station, { channelIds: [1], startMs: 1500, endMs: 1999 });
  const upstream = await queryNewApiTokenStat(station, { tokenName: "fixed-key", startMs: 1500, endMs: 1999 });

  assert.equal(requests, 0);
  assert.equal(ownData.emptySecondWindow, true);
  assert.equal(ownFlow.emptySecondWindow, true);
  assert.equal(ownRevenue.emptySecondWindow, true);
  assert.equal(upstream.emptySecondWindow, true);
});

test("其余秒级用量与日志查询在空窗口不发 HTTP，并保留空数据返回形状", async (t) => {
  let requests = 0;
  const server = createServer((_request, response) => {
    requests += 1;
    sendJson(response, { success: true, data: {} });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const station = { type: "newapi", baseUrl: `http://127.0.0.1:${server.address().port}`, accessToken: "pat" };
  const { queryStationUsage, queryOwnLogAudit, queryLogStat } = await import("./providers.js");

  const usage = await queryStationUsage(station, { startMs: 1500, endMs: 1999 });
  const audit = await queryOwnLogAudit(station, { startMs: 1500, endMs: 1999 });
  const stat = await queryLogStat(station, { username: "admin", tokenName: "resold", startMs: 1500, endMs: 1999 });

  assert.equal(requests, 0);
  assert.equal(usage.emptySecondWindow, true);
  assert.deepEqual(usage.models, []);
  assert.deepEqual(usage.trend, []);
  assert.equal(audit.emptySecondWindow, true);
  assert.equal(audit.scanned, 0);
  assert.equal(audit.totals, null);
  assert.equal(stat, 0);
});

test("演示 NewAPI 的 PAT 身份响应包含稳定用户 ID", async () => {
  const { mockNewApiUserSelf } = await import("../server/demo.js");
  const result = mockNewApiUserSelf(new Request("http://demo", { headers: { Authorization: "Bearer pat" } }), "demo");
  assert.equal(result.status, 200);
  assert.equal(Number.isInteger(result.body.data.id) && result.body.data.id > 0, true);
});

test("渠道对账不会透传上游错误中的凭证内容", async (t) => {
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://x");
    if (url.pathname === "/api/status") {
      return sendJson(response, { success: true, data: { quota_per_unit: 100 } });
    }
    if (url.pathname === "/api/user/self") {
      return sendJson(response, { success: true, data: { id: 42 } });
    }
    if (url.pathname === "/api/user/self/groups") {
      return sendJson(response, { success: false, message: "permission denied: Authorization Bearer pat_secret" });
    }
    return sendJson(response, { error: "not found" }, 404);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const origin = `http://127.0.0.1:${server.address().port}`;
  const { queryNewApiReconciliationMetadata } = await import("./providers.js");

  await assert.rejects(
    queryNewApiReconciliationMetadata({ baseUrl: origin, accessToken: "pat" }),
    (err) => err.code === "UPSTREAM_AUTH_DENIED" && /PAT 无权/.test(err.message) && !/pat_secret/.test(err.message)
  );
});

test("上游统计使用已有 Bearer PAT 且认证失败不会泄露凭证", async (t) => {
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://x");
    if (url.pathname === "/api/status") {
      return sendJson(response, { success: true, data: { quota_per_unit: 100 } });
    }
    assert.equal(request.headers.authorization, "Bearer already-prefixed");
    return sendJson(response, { success: false, message: "permission denied: Bearer secret-value" }, 403);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const origin = `http://127.0.0.1:${server.address().port}`;
  const { queryNewApiTokenStat } = await import("./providers.js");

  await assert.rejects(
    queryNewApiTokenStat({ baseUrl: origin, accessToken: "Bearer already-prefixed" }, {
      tokenName: "fixed-key", startMs: 1000000, endMs: 1060000,
    }),
    (err) => err.code === "UPSTREAM_AUTH_DENIED" && !/secret-value|already-prefixed/.test(err.message)
  );
});

test("日志精算把缓存读写算进真实 token，并按语义避免重复计数", async (t) => {
  // Claude 语义：prompt_tokens 只是未命中缓存的输入，缓存读写额外计费（看板漏计的就是这块）
  const claudeRow = (i) => ({
    id: i, created_at: 1700000000 + i, model_name: "claude-sonnet-4-5", username: "u1",
    prompt_tokens: 1000, completion_tokens: 2000, quota: 500000, channel: 3, channel_name: "Claude-Max", group: "claude",
    other: JSON.stringify({
      usage_semantic: "anthropic", claude: true, cache_tokens: 300000, cache_write_tokens: 20000,
      model_ratio: 5, group_ratio: 1, completion_ratio: 5,
    }),
  });
  // OpenAI 语义：缓存 token 本就含在 prompt_tokens 里，真实 token 不能再加一遍
  const gptRow = {
    id: 99, created_at: 1700000500, model_name: "gpt-4o", username: "u2",
    prompt_tokens: 250000, completion_tokens: 1000, quota: 1000000, channel: 1, channel_name: "luna", group: "default",
    other: JSON.stringify({ cache_tokens: 100000, model_ratio: 2.5, group_ratio: 1, completion_ratio: 4, matched_tier: ">200k" }),
  };
  const pages = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://x");
    assert.equal(url.pathname, "/api/log/");
    assert.equal(url.searchParams.get("type"), "2");
    assert.equal(url.searchParams.get("page_size"), "100");
    const p = Number(url.searchParams.get("p"));
    pages.push(p);
    const items = p === 1 ? Array.from({ length: 100 }, (_, i) => claudeRow(i + 1)) : p === 2 ? [gptRow] : [];
    sendJson(response, { success: true, data: { page: p, page_size: 100, total: 101, items } });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const origin = `http://127.0.0.1:${server.address().port}`;
  const { queryOwnLogAudit } = await import("./providers.js");

  const r = await queryOwnLogAudit({ baseUrl: origin, accessToken: "adm" }, {
    startMs: 1700000000000, endMs: 1700001000000, maxRows: 4000,
  });
  assert.equal(r.scanned, 101);
  assert.equal(r.total, 101);
  assert.equal(r.truncated, false);
  assert.deepEqual(pages.slice(0, 2), [1, 2]);

  const claude = r.byModel.find((m) => m.model === "claude-sonnet-4-5");
  assert.equal(claude.billedTokens, 100 * 3000); // 看板口径
  assert.equal(claude.cacheReadTokens, 100 * 300000);
  assert.equal(claude.cacheWriteTokens, 100 * 20000);
  assert.equal(claude.trueTokens, 100 * (3000 + 300000 + 20000)); // 真实口径
  assert.equal(claude.anthropicPct, 100);
  assert.equal(claude.longRequests, 100); // 输入 321000 ≥ 20 万，属长上下文
  assert.deepEqual(claude.avgModelRatio, 5);

  const gpt = r.byModel.find((m) => m.model === "gpt-4o");
  assert.equal(gpt.billedTokens, 251000);
  assert.equal(gpt.trueTokens, 251000); // 缓存 token 已在 prompt 内，不再叠加
  assert.equal(gpt.cacheReadTokens, 100000);
  assert.equal(gpt.longRequests, 1);
  assert.deepEqual(gpt.tiers, [{ name: ">200k", requests: 1 }]);

  assert.equal(r.totals.requests, 101);
  assert.equal(r.byChannel.map((c) => c.channel).sort().join(","), "Claude-Max,luna");
  assert.equal(r.byGroup.length, 2);
});

test("日志精算按条数上限截断并如实报告覆盖范围", async (t) => {
  const server = createServer((request, response) => {
    const p = Number(new URL(request.url, "http://x").searchParams.get("p"));
    sendJson(response, {
      success: true,
      data: {
        total: 5000,
        items: Array.from({ length: 100 }, (_, i) => ({
          id: p * 1000 + i, created_at: 1700000000 - (p - 1) * 100 - i,
          model_name: "m", username: "u", prompt_tokens: 1, completion_tokens: 1, quota: 500, other: "",
        })),
      },
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const { queryOwnLogAudit } = await import("./providers.js");

  const r = await queryOwnLogAudit(
    { baseUrl: `http://127.0.0.1:${server.address().port}`, accessToken: "adm" },
    { startMs: 1600000000000, endMs: 1700001000000, maxRows: 300 }
  );
  assert.equal(r.scanned, 300);
  assert.equal(r.truncated, true);
  assert.equal(r.toMs, 1700000000000);
  assert.equal(r.fromMs, (1700000000 - 2 * 100 - 99) * 1000); // 只覆盖最近 3 页
});
