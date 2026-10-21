// 登录信息加密保存：主密钥解析、加解密、Store 读写边界的几种启动情况、密文复用，和 db/reset-secrets.js
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canOpen, isCiphertext, loadSecretKey, openText, sealText, secretKeyOf, SECRET_TEXT } from "./secrets.js";
import { Store } from "./store.js";
import { resetReportLines, resetSecrets } from "./reset-secrets.js";

const KEY_A = Buffer.alloc(32, 7).toString("base64");
const KEY_B = Buffer.alloc(32, 9).toString("base64");
const keyA = secretKeyOf(KEY_A), keyB = secretKeyOf(KEY_B);
const code = (expected) => (err) => err.code === expected;
const sealed = (key, value, aad) => sealText(key, JSON.stringify(value), aad);

// 有状态的假库：stations、meta 两张表，事务提交才落下；记下写了几次。
// rawMeta：meta 的值按原始 JSON 文本给（带引号的字符串标量），模拟 mysql2 没解析 JSON 列的情况
function memoryPool({ stations = [], meta = {} } = {}, { rawMeta = false, failCommit = () => false } = {}) {
  const db = { stations: new Map(stations.map((doc, pos) => [doc.id, { pos, doc: JSON.stringify(doc) }])),
    meta: new Map(Object.entries(meta).map(([k, v]) => [k, JSON.stringify(v)])) };
  const pool = { writes: 0, commits: 0, db };
  pool.query = async (sql, params) => {
    if (sql.startsWith("SELECT id, doc FROM stations")) {
      return [[...db.stations].sort(([, a], [, b]) => a.pos - b.pos).map(([id, row]) => ({ id, doc: JSON.parse(row.doc) }))];
    }
    if (sql.startsWith("SELECT k, v FROM meta WHERE k IN (?)")) {
      return [[...db.meta].filter(([k]) => params[0].includes(k)).map(([k, v]) => ({ k, v: rawMeta ? v : JSON.parse(v) }))];
    }
    throw new Error(`unexpected ${sql}`);
  };
  pool.getConnection = async () => {
    let draft;
    return {
      beginTransaction: async () => { draft = { stations: new Map(db.stations), meta: new Map(db.meta) }; },
      query: async (sql, params) => {
        pool.writes += 1;
        if (sql.startsWith("DELETE FROM stations WHERE id NOT IN")) for (const id of [...draft.stations.keys()]) { if (!params[0].includes(id)) draft.stations.delete(id); }
        else if (sql.startsWith("DELETE FROM stations")) draft.stations.clear();
        else if (sql.startsWith("INSERT INTO stations")) for (const [id, pos, doc] of params[0]) draft.stations.set(id, { pos, doc });
        else if (sql.startsWith("INSERT INTO meta")) for (const [k, v] of params[0]) draft.meta.set(k, v);
        else if (sql.startsWith("UPDATE stations SET doc")) draft.stations.set(params[1], { ...draft.stations.get(params[1]), doc: params[0] });
        else if (sql.startsWith("UPDATE meta SET v")) draft.meta.set("notifications", params[0]);
        else if (sql.startsWith("DELETE FROM meta WHERE k = ?")) draft.meta.delete(params[0]);
        else throw new Error(`unexpected ${sql}`);
        return [[]];
      },
      commit: async () => {
        if (failCommit()) throw new Error("synthetic offline");
        db.stations = draft.stations; db.meta = draft.meta; pool.commits += 1;
      },
      rollback: async () => {},
      release: () => {},
    };
  };
  pool.doc = (id) => JSON.parse(db.stations.get(id).doc);
  pool.meta = (k) => db.meta.has(k) ? JSON.parse(db.meta.get(k)) : undefined;
  pool.dump = () => JSON.stringify([...db.stations.values(), ...db.meta.values()]);
  return pool;
}

const plainState = () => ({
  stations: [
    { id: "st_a", name: "甲", type: "newapi", baseUrl: "https://a.example", accessToken: "tok-A-secret", userId: "7", apiKey: "", email: "", password: "", s2Tokens: null },
    { id: "st_b", name: "乙", type: "sub2api-password", baseUrl: "https://b.example", accessToken: "", apiKey: "", email: "b@example.test", password: "pw-B-secret",
      s2Tokens: { site: "https://b.example:443", accessToken: "jwt-B-secret", refreshToken: "refresh-B-secret", expiresAt: 123 } },
  ],
  meta: {
    settings: {}, auth: { username: "admin", salt: "s", hash: "h" },
    notifications: { channels: [{ id: "ch_1", type: "telegram", name: "运维群", enabled: true, config: { botToken: "123:bot-secret", chatId: "42", apiBase: "" } }], rules: {} },
    session_secret: "old-plain-session",
  },
});
const SECRETS = /tok-A-secret|pw-B-secret|b@example\.test|jwt-B-secret|refresh-B-secret|bot-secret|old-plain-session/;

test("主密钥：没配就是明文运行；32 字节 base64（含 URL 安全写法）才收；文件读不到、是空的、和变量都配了，都报错", () => {
  assert.equal(loadSecretKey({}), null);
  assert.equal(loadSecretKey({ RELAY_SECRET_KEY: "  " }), null);
  assert.deepEqual(loadSecretKey({ RELAY_SECRET_KEY: ` ${KEY_A}\n` }).id, keyA.id);
  assert.equal(secretKeyOf(Buffer.alloc(32, 7).toString("base64url")).id, keyA.id);
  assert.match(keyA.id, /^[0-9a-f]{8}$/);
  assert.notEqual(keyA.id, keyB.id);
  // 64 位 hex 不是 base64 写法的 32 字节
  for (const bad of ["short", Buffer.alloc(16).toString("base64"), Buffer.alloc(33).toString("base64"), `${KEY_A}!`, Buffer.alloc(32, 7).toString("hex")]) {
    assert.throws(() => loadSecretKey({ RELAY_SECRET_KEY: bad }), (err) => err.code === "SECRET_KEY_INVALID" && err.message === SECRET_TEXT.invalid("RELAY_SECRET_KEY "));
  }
  const dir = mkdtempSync(join(tmpdir(), "relay-secret-"));
  try {
    writeFileSync(join(dir, "key"), `${KEY_B}\n`);
    writeFileSync(join(dir, "empty"), "\n");
    writeFileSync(join(dir, "bad"), "not-a-key");
    assert.equal(loadSecretKey({ RELAY_SECRET_KEY_FILE: join(dir, "key") }).id, keyB.id);
    assert.throws(() => loadSecretKey({ RELAY_SECRET_KEY: KEY_A, RELAY_SECRET_KEY_FILE: join(dir, "key") }), (err) => err.message === SECRET_TEXT.both);
    assert.throws(() => loadSecretKey({ RELAY_SECRET_KEY_FILE: join(dir, "missing") }), (err) => err.message === SECRET_TEXT.unreadable(join(dir, "missing")));
    assert.throws(() => loadSecretKey({ RELAY_SECRET_KEY_FILE: join(dir, "empty") }), (err) => err.code === "SECRET_KEY_INVALID" && err.message === SECRET_TEXT.emptyFile(join(dir, "empty")));
    assert.throws(() => loadSecretKey({ RELAY_SECRET_KEY_FILE: join(dir, "bad") }), (err) => err.message === SECRET_TEXT.invalid("RELAY_SECRET_KEY_FILE 指向的文件里的密钥"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("加解密：往返一致；每次密文不同；换了附加数据（别的站点、别的字段）、换了密钥、改过的密文都解不开", () => {
  const value = sealText(keyA, "tok-中文-secret", "station:st_a:accessToken");
  assert.ok(isCiphertext(value));
  assert.equal(value.split(":")[2], keyA.id);
  assert.notEqual(sealText(keyA, "tok-中文-secret", "station:st_a:accessToken"), value);
  assert.equal(openText(keyA, value, "station:st_a:accessToken"), "tok-中文-secret");
  assert.throws(() => openText(keyA, value, "station:st_b:accessToken", "上游「乙」的访问令牌"), (err) => err.code === "SECRET_KEY_MISMATCH" && err.message === SECRET_TEXT.corrupt("上游「乙」的访问令牌"));
  assert.throws(() => openText(keyA, value, "station:st_a:password"), code("SECRET_KEY_MISMATCH"));
  assert.throws(() => openText(keyB, value, "station:st_a:accessToken"), (err) => err.code === "SECRET_KEY_MISMATCH" && err.message === SECRET_TEXT.mismatch(keyA.id, keyB.id));
  assert.throws(() => openText(null, value, "station:st_a:accessToken"), (err) => err.code === "SECRET_KEY_MISSING" && err.message === SECRET_TEXT.missing);
  const tampered = value.slice(0, -2) + (value.endsWith("AA") ? "BB" : "AA");
  assert.throws(() => openText(keyA, tampered, "station:st_a:accessToken"), code("SECRET_KEY_MISMATCH"));
  assert.equal(canOpen(keyA, value, "station:st_a:accessToken"), true);
  assert.equal(canOpen(keyB, value, "station:st_a:accessToken"), false);
  for (const plain of ["", "sk-abc", "enc:v1:short", null, 42]) assert.equal(isCiphertext(plain), false);
  // 报错文字里没有密钥和明文
  for (const text of [SECRET_TEXT.missing, SECRET_TEXT.mismatch(keyA.id, keyB.id), SECRET_TEXT.corrupt("上游「甲」的访问令牌")]) assert.doesNotMatch(text, /tok-|BwcH|CQkJ/);
});

test("明文库第一次配上密钥启动：登录信息全部改成密文，内存里还是明文，会话密钥换新；不是密钥的字段不加密", async () => {
  const pool = memoryPool(plainState());
  const store = await new Store(pool, { secretKey: keyA }).load();
  assert.doesNotMatch(pool.dump(), SECRETS);
  assert.ok(isCiphertext(pool.doc("st_a").accessToken));
  assert.ok(isCiphertext(pool.doc("st_b").s2Tokens));
  assert.equal(pool.doc("st_a").apiKey, "", "空值不加密");
  assert.equal(pool.doc("st_a").s2Tokens, null);
  assert.equal(pool.doc("st_a").userId, "7");
  const channel = pool.meta("notifications").channels[0].config;
  assert.ok(isCiphertext(channel.botToken));
  assert.equal(channel.chatId, "42");
  assert.ok(isCiphertext(pool.meta("session_secret")));
  // 内存里是明文
  assert.equal(store.get("st_a").accessToken, "tok-A-secret");
  assert.deepEqual(store.get("st_b").s2Tokens, plainState().stations[1].s2Tokens);
  assert.equal(store.channels[0].config.botToken, "123:bot-secret");
  assert.equal(store.secretsEncrypted, true);
  assert.match(store.sessionSecret, /^[0-9a-f]{64}$/);
  assert.deepEqual(store.secretReport, { encrypted: true, keyId: keyA.id, converted: 5, rotated: ["session_secret"] });
});

test("余额结果里的账号名（可能就是登录邮箱）也加密；上游给的、长得像密文的字符串不会让服务起不来", async () => {
  const state = plainState();
  state.stations[1].balance = { ok: true, remaining: 1, account: "b@example.test" };
  const pool = memoryPool(state);
  const store = await new Store(pool, { secretKey: keyA }).load();
  assert.ok(isCiphertext(pool.doc("st_b").balance.account));
  assert.equal(pool.doc("st_b").balance.remaining, 1);
  assert.equal((await new Store(pool, { secretKey: keyA }).load()).get("st_b").balance.account, "b@example.test");
  // 刷新换了余额对象：内存不动，库里照样加密
  store.get("st_b").balance = { ok: true, remaining: 2, account: "renamed@example.test" };
  await store.save();
  assert.equal(store.get("st_b").balance.account, "renamed@example.test");
  assert.doesNotMatch(pool.dump(), /renamed@example/);

  // 明文模式：上游返回的账号名、登录令牌刚好长得像密文，照样启动；账号名清空，下次刷新会重写
  const fake = sealText(keyB, "\"x\"", "anything");
  const hostile = plainState();
  hostile.stations[1].balance = { ok: true, account: fake };
  hostile.stations[1].s2Tokens = { accessToken: fake };
  const plain = await new Store(memoryPool(hostile)).load();
  assert.equal(plain.get("st_b").balance.account, "");
  assert.deepEqual(plain.get("st_b").s2Tokens, { accessToken: fake });
  // 配了密钥也一样（第一次加密时库里原样存着上游给的字符串）
  assert.equal((await new Store(memoryPool(hostile), { secretKey: keyA }).load()).get("st_b").balance.account, "");
});

test("已加密的库用同一个密钥重启：读回原样、会话密钥不再换；内容没变时沿用原来的密文，改了的那处才重新加密", async () => {
  const pool = memoryPool(plainState());
  const first = await new Store(pool, { secretKey: keyA }).load();
  const before = { a: pool.doc("st_a"), b: pool.doc("st_b"), notifications: pool.meta("notifications"), session: pool.meta("session_secret") };
  const store = await new Store(pool, { secretKey: keyA }).load();
  assert.deepEqual(store.list().map((s) => [s.accessToken, s.password, s.email, s.s2Tokens]), first.list().map((s) => [s.accessToken, s.password, s.email, s.s2Tokens]));
  assert.equal(store.sessionSecret, first.sessionSecret);
  assert.deepEqual(store.secretReport, { encrypted: true, keyId: keyA.id, converted: 0, rotated: [] });
  assert.deepEqual([pool.doc("st_a"), pool.doc("st_b"), pool.meta("notifications"), pool.meta("session_secret")], [before.a, before.b, before.notifications, before.session]);

  // Sub2API 续期换了令牌：只有 s2Tokens 那处是新密文，其余照旧
  store.get("st_b").s2Tokens = { ...store.get("st_b").s2Tokens, accessToken: "jwt-B-renewed" };
  await store.save();
  assert.notEqual(pool.doc("st_b").s2Tokens, before.b.s2Tokens);
  assert.equal(pool.doc("st_b").password, before.b.password);
  assert.equal(pool.doc("st_a").accessToken, before.a.accessToken);
  assert.equal(store.get("st_b").s2Tokens.accessToken, "jwt-B-renewed");
  // 编辑上游填了新令牌：读回来是新的
  await store.update("st_a", { accessToken: "tok-A-new" });
  assert.equal((await new Store(pool, { secretKey: keyA }).load()).get("st_a").accessToken, "tok-A-new");

  // 通知方式：只改 Chat ID 时 Bot Token 沿用原来的密文；换了 Bot Token 才是新密文
  const botBefore = pool.meta("notifications").channels[0].config.botToken;
  await store.updateChannel("ch_1", { config: { botToken: "", chatId: "43", apiBase: "" } });
  assert.equal(pool.meta("notifications").channels[0].config.botToken, botBefore);
  assert.equal(pool.meta("notifications").channels[0].config.chatId, "43");
  await store.updateChannel("ch_1", { config: { botToken: "999:bot-new", chatId: "43", apiBase: "" } });
  assert.notEqual(pool.meta("notifications").channels[0].config.botToken, botBefore);
  assert.equal((await new Store(pool, { secretKey: keyA }).load()).channels[0].config.botToken, "999:bot-new");
});

test("写库失败后再保存：库里是新值的密文，不会留着旧的或写成空值", async () => {
  let fail = false;
  const pool = memoryPool(plainState(), { failCommit: () => fail });
  const store = await new Store(pool, { secretKey: keyA }).load();
  fail = true;
  await assert.rejects(store.update("st_a", { accessToken: "tok-A-offline" }), code("SAVE_FAILED"));
  fail = false;
  await store.update("st_a", { accessToken: "tok-A-retry" });
  assert.equal((await new Store(pool, { secretKey: keyA }).load()).get("st_a").accessToken, "tok-A-retry");
});

test("启动中止的几种情况：库里有密文却没配密钥、换错了密钥、密文被挪到别的站点上；都不写库，报错说清是哪个上游的哪一处", async () => {
  const pool = memoryPool(plainState());
  await new Store(pool, { secretKey: keyA }).load();
  const snapshot = pool.dump(), writes = pool.writes;
  await assert.rejects(new Store(pool).load(), (err) => err.code === "SECRET_KEY_MISSING" && err.message === SECRET_TEXT.missing);
  await assert.rejects(new Store(pool, { secretKey: keyB }).load(), (err) => err.code === "SECRET_KEY_MISMATCH" && err.message === SECRET_TEXT.mismatch(keyA.id, keyB.id));
  // 把甲的令牌密文换到乙身上：附加数据对不上
  const a = pool.doc("st_a"), b = pool.doc("st_b");
  pool.db.stations.set("st_b", { ...pool.db.stations.get("st_b"), doc: JSON.stringify({ ...b, accessToken: a.accessToken }) });
  await assert.rejects(new Store(pool, { secretKey: keyA }).load(), (err) => err.code === "SECRET_KEY_MISMATCH" && err.message === SECRET_TEXT.corrupt("上游「乙」的登录令牌"));
  assert.equal(pool.writes, writes);
  pool.db.stations.set("st_b", { ...pool.db.stations.get("st_b"), doc: JSON.stringify(b) });
  assert.equal(pool.dump(), snapshot);
  // 只有会话密钥是密文也算
  const sessionOnly = memoryPool({ meta: { session_secret: sealed(keyA, "s", "meta:session_secret") } });
  await assert.rejects(new Store(sessionOnly).load(), code("SECRET_KEY_MISSING"));
  assert.equal(sessionOnly.writes, 0);
});

test("没配密钥、库里也没有密文：照旧明文读写，会话密钥沿用；混着的库配上密钥能读；配了密钥但没有会话密钥那一行就生成一个", async () => {
  const pool = memoryPool(plainState());
  const store = await new Store(pool).load();
  assert.equal(store.secretsEncrypted, false);
  assert.equal(store.sessionSecret, "old-plain-session");
  assert.deepEqual(store.secretReport, { encrypted: false, keyId: null, converted: 0, rotated: [] });
  assert.equal(pool.doc("st_a").accessToken, "tok-A-secret");
  assert.equal(pool.meta("session_secret"), "old-plain-session");

  const mixed = plainState();
  mixed.stations[0].accessToken = sealed(keyA, "tok-A-secret", "station:st_a:accessToken");
  const mixedPool = memoryPool(mixed);
  const loaded = await new Store(mixedPool, { secretKey: keyA }).load();
  assert.equal(loaded.get("st_a").accessToken, "tok-A-secret");
  assert.equal(loaded.secretReport.converted, 4);
  assert.doesNotMatch(mixedPool.dump(), SECRETS);

  const { session_secret: _, ...withoutSession } = plainState().meta;
  const fresh = memoryPool({ stations: [], meta: withoutSession });
  const created = await new Store(fresh, { secretKey: keyA }).load();
  assert.match(created.sessionSecret, /^[0-9a-f]{64}$/);
  assert.deepEqual(created.secretReport.rotated, []);
  assert.ok(isCiphertext(fresh.meta("session_secret")));
});

test("mysql2 没解析 JSON 列、给的是带引号的原始文本时：明文和密文的会话密钥都读得对", async () => {
  const plain = memoryPool(plainState(), { rawMeta: true });
  assert.equal((await new Store(plain).load()).sessionSecret, "old-plain-session");
  const encrypted = memoryPool(plainState());
  const first = await new Store(encrypted, { secretKey: keyA }).load();
  const raw = memoryPool({ stations: [], meta: {} }, { rawMeta: true });
  raw.db.meta = encrypted.db.meta;
  assert.equal((await new Store(raw, { secretKey: keyA }).load()).sessionSecret, first.sessionSecret);
});

test("通知方式：字段表以外的旧键读库时清掉；config 是空、不是对象、类型认不出时照样能读能写", async () => {
  const state = plainState();
  state.meta.notifications.channels = [
    { id: "ch_1", type: "telegram", name: "运维群", config: { botToken: "123:bot-secret", chatId: "42", legacyToken: "old-plain-secret" } },
    { id: "ch_2", type: "webhook", name: "空配置", config: null },
    { id: "ch_3", type: "bark", name: "数组配置", config: ["x"] },
    { id: "ch_4", type: "legacy", name: "认不出的类型", config: { token: "unknown-type-token" } },
  ];
  const pool = memoryPool(state);
  const store = await new Store(pool, { secretKey: keyA }).load();
  assert.deepEqual(Object.keys(store.channels[0].config), ["botToken", "chatId"]);
  assert.doesNotMatch(pool.dump(), /old-plain-secret/);
  assert.deepEqual(store.channels.slice(1).map((c) => c.config), [null, ["x"], { token: "unknown-type-token" }]);
  assert.equal((await new Store(pool, { secretKey: keyA }).load()).channels[0].config.botToken, "123:bot-secret");
});

test("reset-secrets：先列出解不开的、说清密钥编号，不动库；--yes 才清空、删掉会话密钥；之后能启动，解得开的不动", async () => {
  const pool = memoryPool(plainState());
  await new Store(pool, { secretKey: keyA }).load();
  // 同一个密钥：都解得开，不用清
  const fine = await resetSecrets(pool, { secretKey: keyA, apply: true });
  assert.deepEqual(fine, { cleared: [], metaReset: [], keyIds: [], applied: false });
  assert.deepEqual(resetReportLines(fine, { secretKey: keyA }), ["库里的登录信息都解得开（或者本来就是明文），不用清。"]);

  const writes = pool.writes;
  const dry = await resetSecrets(pool, { secretKey: keyB });
  assert.equal(pool.writes, writes);
  assert.deepEqual(dry.cleared.map((item) => `${item.holder}:${item.label}`), [
    "上游「甲」:访问令牌", "上游「乙」:登录密码", "上游「乙」:登录邮箱", "上游「乙」:自动登录拿到的令牌", "通知方式「运维群」:Bot Token",
  ]);
  const listing = [
    "- 上游「甲」：访问令牌",
    "- 上游「乙」：登录密码、登录邮箱、自动登录拿到的令牌",
    "- 通知方式「运维群」：Bot Token",
    "- 会话密钥：下次启动时重新生成，所有设备要重新登录",
  ];
  // 配了别的密钥：说出两个编号，提醒找得回原来的就不用清
  assert.deepEqual(resetReportLines(dry, { secretKey: keyB }), [
    "下面这些登录信息解不开：", ...listing,
    `这些是用编号 ${keyA.id} 的密钥加密的，现在配置的密钥编号是 ${keyB.id}。找得回编号 ${keyA.id} 的那个密钥，就把它配回去重启，不用清。`,
    "看清楚上面的内容。确认要清空的话，加 --yes 再运行一次：node db/reset-secrets.js --yes",
  ]);
  assert.deepEqual(resetReportLines(await resetSecrets(pool), {}), [
    "没有配置 RELAY_SECRET_KEY：库里所有加密保存的登录信息都算解不开。", "下面这些登录信息解不开：", ...listing,
    `这些是用编号 ${keyA.id} 的密钥加密的，现在没有配置密钥。找得回编号 ${keyA.id} 的那个密钥，就把它配回去重启，不用清。`,
    "看清楚上面的内容。确认要清空的话，加 --yes 再运行一次：node db/reset-secrets.js --yes",
  ]);

  const done = await resetSecrets(pool, { secretKey: keyB, apply: true });
  assert.equal(done.applied, true);
  assert.equal(resetReportLines(done, { secretKey: keyB }).at(-1), "启动服务后，到「上游列表」和「告警中心」把上面的登录信息重新填上。");
  assert.deepEqual([pool.doc("st_a").accessToken, pool.doc("st_b").password, pool.doc("st_b").s2Tokens], ["", "", null]);
  assert.equal(pool.doc("st_a").baseUrl, "https://a.example");
  assert.equal(pool.meta("notifications").channels[0].config.botToken, "");
  assert.equal(pool.meta("notifications").channels[0].config.chatId, "42");
  assert.equal(pool.meta("session_secret"), undefined);
  const store = await new Store(pool, { secretKey: keyB }).load();
  assert.equal(store.get("st_a").accessToken, "");
  assert.match(store.sessionSecret, /^[0-9a-f]{64}$/);
});

test("reset-secrets：用现在这个密钥加密、却解不开的，说是数据被改过", async () => {
  const pool = memoryPool(plainState());
  await new Store(pool, { secretKey: keyA }).load();
  const b = pool.doc("st_b");
  pool.db.stations.set("st_b", { ...pool.db.stations.get("st_b"), doc: JSON.stringify({ ...b, password: pool.doc("st_a").accessToken }) });
  const report = await resetSecrets(pool, { secretKey: keyA });
  assert.deepEqual(report.cleared.map((item) => item.label), ["登录密码"]);
  assert.ok(resetReportLines(report, { secretKey: keyA }).includes(`其中用现在这个密钥（编号 ${keyA.id}）加密、却解不开的，是库里的数据被改过。`));
});
