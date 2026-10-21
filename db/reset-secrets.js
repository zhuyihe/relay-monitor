// 主密钥丢了、或者配错了又找不回时用：把库里解不开的登录信息清空，会话密钥在下次启动时重新生成，之后到页面上重新填。
// 解得开的（配着加密时用的密钥）和本来就是明文的都不动。
// 先不带参数运行，列出要清的；确认后加 --yes 才真的清。用法见 deploy/README.md「加密密钥丢了怎么办」
import { getPool } from "./pool.js";
import { asDoc, asScalar } from "./store.js";
import { canOpen, isCiphertext, loadSecretKey, secretSlots, SESSION_SECRET_AAD } from "./secrets.js";
import { credentialFieldOf } from "../lib/channel-onboarding.js";
import { CHANNEL_TYPES } from "../lib/notify.js";

// 这一处叫什么：上游按编辑上游的输入框名，通知方式按告警中心的字段名
function slotLabel(slot) {
  if (slot.kind === "channel") {
    return CHANNEL_TYPES.find((type) => type.value === slot.channelType)?.fields.find((field) => field.key === slot.key)?.label || slot.key;
  }
  if (slot.key === "s2Tokens") return "自动登录拿到的令牌";
  return credentialFieldOf(slot.owner.type, slot.key)?.label || slot.key;
}

// 返回 { cleared: [{ kind, id, name, label }], sessionReset, applied }
export async function resetSecrets(pool, { secretKey = null, apply = false } = {}) {
  const [stationRows] = await pool.query("SELECT id, doc FROM stations ORDER BY pos, created_at");
  const [metaRows] = await pool.query("SELECT k, v FROM meta WHERE k IN ('notifications','session_secret')");
  const meta = Object.fromEntries(metaRows.map((r) => [r.k, r.k === "session_secret" ? asScalar(r.v) : asDoc(r.v)]));
  const stations = stationRows.map((r) => asDoc(r.doc));
  const notifications = meta.notifications && typeof meta.notifications === "object" ? meta.notifications : null;
  const channelTypes = new Map((notifications?.channels || []).map((channel) => [channel?.id, channel?.type]));

  const cleared = [], changedStations = new Set();
  for (const slot of secretSlots({ stations, notifications })) {
    const value = slot.owner[slot.key];
    if (!isCiphertext(value) || canOpen(secretKey, value, slot.aad)) continue;
    cleared.push({ kind: slot.kind, id: slot.ownerId, name: slot.ownerName || slot.ownerId,
      label: slotLabel({ ...slot, channelType: channelTypes.get(slot.ownerId) }) });
    slot.owner[slot.key] = slot.json ? null : "";
    if (slot.kind === "station") changedStations.add(slot.ownerId);
  }
  const session = meta.session_secret;
  const sessionReset = isCiphertext(session) && !canOpen(secretKey, session, SESSION_SECRET_AAD);
  const applied = apply && (cleared.length > 0 || sessionReset);
  if (applied) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      for (const station of stations) {
        if (changedStations.has(station.id)) await conn.query("UPDATE stations SET doc = ? WHERE id = ?", [JSON.stringify(station), station.id]);
      }
      if (cleared.some((item) => item.kind === "channel")) {
        await conn.query("UPDATE meta SET v = ? WHERE k = 'notifications'", [JSON.stringify(notifications)]);
      }
      // 删掉就行：下次启动时 Store 会生成新的（配了密钥就加密保存）
      if (sessionReset) await conn.query("DELETE FROM meta WHERE k = 'session_secret'");
      await conn.commit();
    } catch (err) {
      await conn.rollback().catch(() => {});
      throw err;
    } finally {
      conn.release();
    }
  }
  return { cleared, sessionReset, applied };
}

// 给运行脚本的人看的几行话
export function resetReportLines({ cleared, sessionReset, applied }, { keyed }) {
  const lines = [];
  if (!keyed) lines.push("没有配置 RELAY_SECRET_KEY：库里所有加密保存的登录信息都算解不开。");
  if (!cleared.length && !sessionReset) return [...lines, "库里的登录信息都解得开（或者本来就是明文），不用清。"];
  const groups = new Map();
  for (const item of cleared) {
    const name = `${item.kind === "station" ? "上游" : "通知方式"}「${item.name}」`;
    groups.set(name, [...(groups.get(name) || []), item.label]);
  }
  lines.push(applied ? "已清空下面这些解不开的登录信息：" : "下面这些登录信息解不开：");
  for (const [name, labels] of groups) lines.push(`- ${name}：${labels.join("、")}`);
  if (sessionReset) lines.push("- 会话密钥：下次启动时重新生成，所有设备要重新登录");
  lines.push(applied
    ? "启动服务后，到「上游列表」和「告警中心」把上面的登录信息重新填上。"
    : "确认要清空的话，加 --yes 再运行一次：node db/reset-secrets.js --yes");
  return lines;
}

// 独立运行：node db/reset-secrets.js [--yes]
if (import.meta.url === `file://${process.argv[1]}`) {
  try { process.loadEnvFile(".env"); } catch {}
  try { process.loadEnvFile(".env.local"); } catch {}
  let secretKey;
  try {
    secretKey = loadSecretKey();
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
  const pool = getPool();
  try {
    const report = await resetSecrets(pool, { secretKey, apply: process.argv.includes("--yes") });
    for (const line of resetReportLines(report, { keyed: !!secretKey })) console.log(line);
  } finally {
    await pool.end();
  }
}
