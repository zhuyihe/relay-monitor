// 主密钥丢了、或者配错了又找不回时用：把库里解不开的登录信息清空，会话密钥在下次启动时重新生成，之后到页面上重新填。
// 解得开的（配着加密时用的密钥）和本来就是明文的都不动。
// 先不带参数运行，列出要清的；确认后加 --yes 才真的清。用法见 deploy/README.md「加密密钥丢了怎么办」
import { getPool } from "./pool.js";
import { readStoreRows } from "./store.js";
import { canOpen, cipherKeyId, isCiphertext, loadSecretKey, META_SECRETS, metaAad, secretSlots } from "./secrets.js";
import { errorLogLine } from "../lib/log.js";

// 返回 { cleared: [{ kind, holder, label }], metaReset: [META_SECRETS 的项], keyIds: [解不开的密文用的密钥编号], applied }
export async function resetSecrets(pool, { secretKey = null, apply = false } = {}) {
  const { stations, meta } = await readStoreRows(pool);
  const notifications = meta.notifications && typeof meta.notifications === "object" ? meta.notifications : null;
  const cleared = [], keyIds = new Set(), changedStations = new Set();
  for (const slot of secretSlots({ stations, notifications })) {
    const value = slot.owner[slot.key];
    if (!isCiphertext(value) || canOpen(secretKey, value, slot.aad)) continue;
    cleared.push({ kind: slot.kind, holder: slot.holder, label: slot.label });
    keyIds.add(cipherKeyId(value));
    slot.owner[slot.key] = slot.empty;
    if (slot.kind === "station") changedStations.add(slot.id);
  }
  const metaReset = META_SECRETS.filter(({ key }) => isCiphertext(meta[key]) && !canOpen(secretKey, meta[key], metaAad(key)));
  for (const { key } of metaReset) keyIds.add(cipherKeyId(meta[key]));
  const applied = apply && (cleared.length > 0 || metaReset.length > 0);
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
      for (const { key } of metaReset) await conn.query("DELETE FROM meta WHERE k = ?", [key]);
      await conn.commit();
    } catch (err) {
      await conn.rollback().catch(() => {});
      throw err;
    } finally {
      conn.release();
    }
  }
  return { cleared, metaReset, keyIds: [...keyIds].sort(), applied };
}

// 给运行脚本的人看的几行话
export function resetReportLines({ cleared, metaReset, keyIds, applied }, { secretKey = null } = {}) {
  const lines = [];
  if (!secretKey) lines.push("没有配置 RELAY_SECRET_KEY：库里所有加密保存的登录信息都算解不开。");
  if (!cleared.length && !metaReset.length) return [...lines, "库里的登录信息都解得开（或者本来就是明文），不用清。"];
  const groups = new Map();
  for (const item of cleared) groups.set(item.holder, [...(groups.get(item.holder) || []), item.label]);
  lines.push(applied ? "已清空下面这些解不开的登录信息：" : "下面这些登录信息解不开：");
  for (const [holder, labels] of groups) lines.push(`- ${holder}：${labels.join("、")}`);
  for (const item of metaReset) lines.push(`- ${item.label}：${item.reset}`);
  // 先确认是不是只是配错了密钥：编号对得上的那个密钥找得回，就不用清
  const other = keyIds.filter((id) => id !== secretKey?.id);
  if (other.length) {
    lines.push(`这些是用编号 ${other.join("、")} 的密钥加密的，${secretKey ? `现在配置的密钥编号是 ${secretKey.id}` : "现在没有配置密钥"}。`
      + `找得回编号 ${other.join("、")} 的那个密钥，就把它配回去重启，不用清。`);
  }
  if (secretKey && keyIds.includes(secretKey.id)) lines.push(`其中用现在这个密钥（编号 ${secretKey.id}）加密、却解不开的，是库里的数据被改过。`);
  lines.push(applied
    ? "启动服务后，到「上游列表」和「告警中心」把上面的登录信息重新填上。"
    : "看清楚上面的内容。确认要清空的话，加 --yes 再运行一次：node db/reset-secrets.js --yes");
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
    for (const line of resetReportLines(report, { secretKey })) console.log(line);
  } catch (err) {
    // 只记码和一句话：mysql2 的报错上挂着整条 SQL，里面是整个站点文档（lib/log.js）
    console.error("没有清成，库里什么都没改：", errorLogLine(err));
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
