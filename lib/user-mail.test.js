import test from "node:test";
import assert from "node:assert/strict";
import { USER_MAIL, buildUserMail, decideUserMail, mailDaysText, mailKindOf, mailLevelOf, userMailPayUrl } from "./user-mail.js";

const NOW = Date.parse("2026-11-02T10:00:00Z"), MIN = 60000;
const soon = (level, days = 2, balanceUsd = 12) => ({ state: "soon", level, days, balanceUsd });
const ok = (days) => ({ state: "ok", level: 0, days, balanceUsd: 100 });
const empty = { state: "empty", level: 3, days: 0, balanceUsd: 0 };

test("该发哪一封：1 级是第一封，2 级和 3 级（用完）都是第二封", () => {
  assert.deepEqual([mailLevelOf(ok(10)), mailLevelOf(soon(1)), mailLevelOf(soon(2)), mailLevelOf(empty)], [0, 1, 2, 2]);
  assert.deepEqual([mailKindOf(1, soon(1)), mailKindOf(2, soon(2)), mailKindOf(2, empty)], ["soon", "urgent", "empty"]);
});

test("决定发不发：进提醒天数发第一封、1 天以内发第二封、用完不再发第三封；同一封不重复", () => {
  const first = decideUserMail({ prev: null, runway: soon(1), now: NOW });
  assert.deepEqual([first.action, first.level], ["send", 1]);
  assert.deepEqual(first.state, { level: 1, retryAt: NOW + USER_MAIL.RETRY_MS, tries: 1 }, "先写：级别和 30 分钟后的重试时刻");
  const sent = { level: 1, retryAt: null, tries: 1 };
  assert.equal(decideUserMail({ prev: sent, runway: soon(1), now: NOW + 60 * MIN }).action, "none");
  const second = decideUserMail({ prev: sent, runway: soon(2), now: NOW + 60 * MIN });
  assert.deepEqual([second.action, second.level], ["send", 2]);
  const secondSent = { level: 2, retryAt: null, tries: 1 };
  assert.equal(decideUserMail({ prev: secondSent, runway: empty, now: NOW + 120 * MIN }).action, "none", "二级之后用完，不发第三封");
  assert.deepEqual(decideUserMail({ prev: null, runway: soon(2), now: NOW }).level, 2, "一下子就到 1 天以内：直接发第二封");
  assert.equal(decideUserMail({ prev: null, runway: ok(10), now: NOW }).action, "none");
  assert.equal(decideUserMail({ prev: null, runway: { state: "warming", level: 0, days: null, balanceUsd: 5 }, now: NOW }).action, "none");
});

test("没发出去：30 分钟后再试一次，只试一次", () => {
  const pending = { level: 1, retryAt: NOW + 30 * MIN, tries: 1 };
  assert.equal(decideUserMail({ prev: pending, runway: soon(1), now: NOW + 29 * MIN }).action, "none");
  const retry = decideUserMail({ prev: pending, runway: soon(1), now: NOW + 30 * MIN });
  assert.deepEqual([retry.action, retry.level, retry.state], ["retry", 1, { level: 1, retryAt: null, tries: 2 }]);
  const after = { level: 1, retryAt: null, tries: 2 };
  assert.equal(decideUserMail({ prev: after, runway: soon(1), now: NOW + 600 * MIN }).action, "none", "试过一次就不再发");
  // 重试之前又进了下一级：发新的一封，不重试旧的
  assert.deepEqual(decideUserMail({ prev: pending, runway: soon(2), now: NOW + 10 * MIN }).level, 2);
});

test("充值：预计天数回到提醒天数的 1.2 倍以上才重新开始一轮；在线上下不清零", () => {
  const prev = { level: 2, retryAt: null, tries: 1 };
  assert.equal(decideUserMail({ prev, runway: ok(3.3), level1Days: 3, now: NOW }).action, "none", "3.3 天（< 3.6）还不清零");
  const cleared = decideUserMail({ prev, runway: ok(3.7), level1Days: 3, now: NOW });
  assert.deepEqual([cleared.action, cleared.state], ["clear", { level: 0, retryAt: null, tries: 0 }]);
  assert.equal(decideUserMail({ prev: cleared.state, runway: soon(1), now: NOW + MIN }).action, "send", "清零以后新的一轮又发第一封");
  assert.equal(decideUserMail({ prev, runway: ok(7), level1Days: 6, now: NOW }).action, "none", "提醒天数设成 6 天：要到 7.2 天才清零");
  assert.equal(decideUserMail({ prev, runway: ok(7.3), level1Days: 6, now: NOW }).action, "clear");
});

test("天数怎么写：整天写「2 天」，不到 1 天写小时，接近 1 天写「1 天」，不写「24 小时」", () => {
  assert.deepEqual([2, 2.4, 1, 0.99, 0.5, 0.01].map(mailDaysText), ["2 天", "2 天", "1 天", "1 天", "12 小时", "1 小时"]);
  assert.equal(mailDaysText(null), "");
});

const money = (usd) => `¥${usd.toFixed(2)}`;
const base = { siteName: "My Site", username: "alice", money, payUrl: "https://api.mysite.com/wallet" };

test("第一封：照设计稿写；以站点的名义，不出现控制台的名字", () => {
  const mail = buildUserMail({ ...base, kind: "soon", balanceUsd: 12.4, days: 2 });
  assert.equal(mail.subject, "My Site 账户余额快用完了，还能用约 2 天");
  assert.equal(mail.text, [
    "您好，alice：", "",
    "您在 My Site 的账户余额还剩 ¥12.40。按最近 7 天的用量，大约还能用 2 天。", "",
    "为了不影响使用，请尽快充值。", "",
    "去充值：https://api.mysite.com/wallet", "",
    "如果已经充值，请忽略这封邮件。", "",
    "—— My Site", "",
    "这封邮件由 My Site 自动发送。",
  ].join("\n"));
  assert.ok(mail.html.includes('href="https://api.mysite.com/wallet"') && mail.html.includes(">去充值<"));
  assert.ok(!/炬元|relay-monitor|控制台/.test(mail.subject + mail.text + mail.html));
});

test("第二封：1 天以内写大约只够用几小时；余额用完写已经用完、接口会失败", () => {
  const urgent = buildUserMail({ ...base, kind: "urgent", balanceUsd: 3.1, days: 0.5 });
  assert.equal(urgent.subject, "My Site 账户余额快用完了，大约只够用 12 小时");
  assert.match(urgent.text, /您在 My Site 的账户余额还剩 ¥3\.10，按最近的用量大约只够用 12 小时。/);
  const empty = buildUserMail({ ...base, kind: "empty", balanceUsd: 0, days: 0 });
  assert.equal(empty.subject, "My Site 账户余额已经用完");
  assert.match(empty.text, /您在 My Site 的账户余额已经用完，接口调用会失败。充值后马上恢复。/);
  assert.ok(!empty.text.includes("为了不影响使用"), "用完那封不写「为了不影响使用」");
});

test("没有充值页地址时不放按钮；站点名没填写「自营站点」；用户名和站点名进 HTML 前转义", () => {
  const mail = buildUserMail({ ...base, kind: "soon", balanceUsd: 1, days: 2, payUrl: "", siteName: "", username: "<b>x</b>" });
  assert.ok(!mail.text.includes("去充值") && !mail.html.includes("<a "));
  assert.match(mail.subject, /^自营站点 /);
  assert.ok(mail.html.includes("&lt;b&gt;x&lt;/b&gt;") && !mail.html.includes("<b>x</b>"));
});

test("充值页地址：站长填了用站长的，没填就是站点地址加 /wallet；填的不是 http(s) 当没填", () => {
  const station = { baseUrl: "https://api.mysite.com/" };
  assert.equal(userMailPayUrl(station, {}), "https://api.mysite.com/wallet");
  assert.equal(userMailPayUrl(station, { userMailPayUrl: "https://pay.mysite.com/topup" }), "https://pay.mysite.com/topup");
  assert.equal(userMailPayUrl(station, { userMailPayUrl: "javascript:alert(1)" }), "https://api.mysite.com/wallet");
  assert.equal(userMailPayUrl({ baseUrl: "" }, {}), "");
});
