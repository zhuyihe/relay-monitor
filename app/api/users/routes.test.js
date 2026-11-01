// 用户运营的三个接口（/api/users、/api/users/[id]、/api/users/big）：没设置自营站点、后台还没读到过数、用户不存在时返回什么。
// 算数本身在 server/user-ops.test.js 里测；这里只测接口把结果翻成状态码和码。只替换鉴权适配层，路由是真的。
import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { createUserOps } from "../../../server/user-ops.js";
import { MemoryUserOpsStore } from "../../../server/test-support/user-ops-memory-store.js";

const hook = registerHooks({ load(url, context, nextLoad) {
  if (url.endsWith("/lib/api.js")) return { format: "module", shortCircuit: true,
    source: "export const withAuth = handler => handler; export const json = (value, status = 200) => Response.json(value, {status});" };
  return nextLoad(url, context);
} });
let list, one, big, preview, mailTest;
try {
  list = (await import("./route.js")).GET;
  one = (await import("./[id]/route.js")).GET;
  big = (await import("./big/route.js")).GET;
  preview = (await import("./mail-preview/route.js")).GET;
  mailTest = (await import("./mail-test/route.js")).POST;
} finally { hook.deregister(); }

const own = { id: "own1", name: "我的站点", isOwn: true, type: "newapi", baseUrl: "https://own.test", accessToken: "tok" };
const request = (path) => new Request(`https://local.test${path}`);
// 有自营站点、有存储、后台一轮都没跑过
const fresh = () => {
  const rt = { store: { list: () => [own], settings: {}, rules: {}, channels: [] }, pool: {} };
  rt._userOpsStore = new MemoryUserOpsStore();
  rt.userOps = createUserOps(rt, { store: rt._userOpsStore });
  return rt;
};
const none = () => ({ store: { list: () => [], settings: {}, rules: {}, channels: [] }, pool: {} , _userOpsStore: new MemoryUserOpsStore() });

test("没设置自营站点：三个接口都是 400 OWN_STATION_UNSET（页面走设置引导）", async () => {
  const rt = none();
  rt.userOps = createUserOps(rt, { store: rt._userOpsStore });
  for (const response of [await list(request("/api/users"), rt), await one(request("/api/users/1"), rt, { id: "1" }), await big(request("/api/users/big"), rt)]) {
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, "OWN_STATION_UNSET");
  }
});

test("后台还没读到过数：整页是 starting（页面写数据补全中），名单 ready: false，抽屉找不到用户是 404 USER_NOT_FOUND", async () => {
  const rt = fresh();
  const page = await (await list(request("/api/users"), rt)).json();
  assert.equal(page.starting, true);
  assert.deepEqual([page.backfill.done, page.backfill.days, page.backfill.total, page.users.length], [false, 0, 60, 0]);
  assert.equal(typeof page.tz, "string");
  assert.equal(page.summary, null);
  assert.deepEqual(await (await big(request("/api/users/big"), rt)).json(), { ready: false, big: [] });
  const missing = await one(request("/api/users/7"), rt, { id: "7" });
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).code, "USER_NOT_FOUND");
});

test("没有数据库（rt.pool 空）：不报错，整页是 starting，抽屉 404；没设置自营站点仍是 400", async () => {
  const rt = { store: { list: () => [own], settings: {}, rules: {}, channels: [] } };
  assert.equal((await (await list(request("/api/users"), rt)).json()).starting, true);
  assert.equal((await one(request("/api/users/1"), rt, { id: "1" })).status, 404);
  assert.deepEqual(await (await big(request("/api/users/big"), rt)).json(), { ready: false, big: [] });
  const unset = { store: { list: () => [], settings: {}, rules: {}, channels: [] } };
  assert.equal((await list(request("/api/users"), unset)).status, 400);
  assert.equal((await one(request("/api/users/1"), unset, { id: "1" })).status, 400);
});

const withMail = (rules = {}, channel = { id: "m1", type: "resend", enabled: true, name: "邮件", config: { apiKey: "re_secret", from: "我的站点 <noreply@own.test>", to: "owner@own.test" } }) => ({
  store: { list: () => [{ ...own, cnyPerUsd: 7.5 }], settings: {}, rules: { userMailChannelId: "m1", userMailPayUrl: "", ...rules }, channels: [channel] },
});

test("看邮件样子：三封，写真的站点名、用 ¥ 和售价换算的钱、充值页地址（站长填的优先，没填是站点地址加 /wallet）", async () => {
  const body = await (await preview(request("/api/users/mail-preview"), withMail())).json();
  assert.deepEqual(body.mails.map((mail) => mail.key), ["soon", "urgent", "empty"]);
  assert.equal(body.mails[0].subject, "我的站点 账户余额快用完了，还能用约 2 天");
  assert.match(body.mails[0].text, /账户余额还剩 ¥12\.40。/, "样例的钱按售价换算后还是 ¥12.40");
  assert.match(body.mails[0].text, /去充值：https:\/\/own\.test\/wallet/);
  assert.equal(body.mails[2].subject, "我的站点 账户余额已经用完");
  const custom = await (await preview(request("/api/users/mail-preview"), withMail({ userMailPayUrl: "https://pay.own.test/topup" }))).json();
  assert.match(custom.mails[0].text, /去充值：https:\/\/pay\.own\.test\/topup/);
  assert.equal((await preview(request("/api/users/mail-preview"), none())).status, 400);
});

test("给自己发一封试信：发到通知方式里填的收件人（站长自己），标题带「试信」，带 HTML；没选通知方式 400；发不出去回 200 带码", async (t) => {
  const sentBodies = [];
  t.mock.method(globalThis, "fetch", async (input, init) => { sentBodies.push(JSON.parse(init.body)); return Response.json({ id: "mail-1" }); });
  const ok = await mailTest(new Request("https://local.test/api/users/mail-test", { method: "POST" }), withMail());
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).ok, true);
  assert.deepEqual(sentBodies[0].to, ["owner@own.test"]);
  assert.match(sentBodies[0].subject, /^试信：我的站点 账户余额快用完了/);
  assert.ok(sentBodies[0].html.includes("去充值"));
  const missing = await mailTest(new Request("https://local.test/api/users/mail-test", { method: "POST" }), withMail({ userMailChannelId: null }));
  assert.equal(missing.status, 400);
  assert.equal((await missing.json()).code, "NOTIFY_CONFIG_MISSING");
  const wrongType = await mailTest(new Request("https://local.test/api/users/mail-test", { method: "POST" }), withMail({}, { id: "m1", type: "webhook", enabled: true, config: { url: "https://x.test" } }));
  assert.equal(wrongType.status, 400, "选的不是邮件类的通知方式，当没选");
  assert.equal((await mailTest(new Request("https://local.test/api/users/mail-test", { method: "POST" }), none())).status, 400);
  t.mock.method(globalThis, "fetch", async () => Response.json({ message: "domain not verified" }, { status: 403 }));
  const failed = await mailTest(new Request("https://local.test/api/users/mail-test", { method: "POST" }), withMail());
  assert.equal(failed.status, 200);
  const body = await failed.json();
  assert.equal(body.ok, false);
  assert.ok(body.code);
  assert.ok(!JSON.stringify(body).includes("re_secret"), "密钥打码");
});
