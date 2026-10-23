// 利润问题的推送（E 里整个删掉）：发送层不再加前缀以后，靠正文最后一行的落款带上关键词「炬元」
import test from "node:test";
import assert from "node:assert/strict";
import { NOTIFY_KEYWORD } from "../lib/brand.js";
import { notifyReconciliationHealth } from "./reconciliation-notify.js";

test("利润问题的推送：正文最后一行是落款，带着推荐给机器人设的关键词", async (t) => {
  const sent = [];
  t.mock.method(globalThis, "fetch", async (url, init) => { sent.push(JSON.parse(init.body)); return new Response("{}", { status: 200 }); });
  const calls = [];
  const repo = {
    getAlertState: async () => null,
    setAlertState: async (...args) => { calls.push(args); },
    clearActiveAlerts: async () => {},
  };
  const rt = { store: { channels: [{ id: "c", type: "webhook", name: "运维群", enabled: true, config: { url: "https://hooks.example.com/x" } }] } };
  const rule = { id: "r1", tokenName: "prod-key", fixedGroup: "default", channels: [{ name: "渠道 A" }] };
  await notifyReconciliationHealth(rt, repo, rule, { health: { code: "KEY_INVALID_OR_DENIED", label: "上游拒绝读取这把 Key" }, window: {} });
  assert.equal(sent.length, 1);
  const lines = sent[0].body.split("\n");
  assert.equal(lines.at(-1), "炬元告警中心");
  assert.ok(`${sent[0].title}\n${sent[0].body}`.includes(NOTIFY_KEYWORD));
  assert.equal(calls.length, 1);
});
