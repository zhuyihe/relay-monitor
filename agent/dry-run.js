// docker compose run --rm relay-key-agent --dry-run：用专用账号读一次，打印耗时、渠道数、账号权限检查结果，然后退出。不起服务。
// 只打数量和原因码，不打 Key、渠道名、连接串
import { ReadFailure } from "./reader.js";

const ACCOUNT_TEXT = {
  GLOBAL_PRIVILEGE: "账号有全局权限（不只是登录）",
  SCHEMA_PRIVILEGE: "账号在某个库上有整库的权限",
  TABLE_PRIVILEGE: "账号在某张表上有整表的权限",
  COLUMN_PRIVILEGE: "账号在 channels 以外的列上有权限，或有 SELECT 以外的权限",
  ROLE_UNKNOWN: "查不到这个账号的角色信息",
  ROLE_ATTRIBUTES: "角色是超级用户或能建角色、建库、复制、绕过行级安全",
  OTHER_TABLES: "账号对 channels 以外的表有权限",
  WRITE_PRIVILEGE: "账号对 channels 有写的权限",
  TABLE_WIDE_SELECT: "账号对 channels 整表有 SELECT（不止那 7 列）",
  EXTRA_COLUMNS: "账号能读 channels 里那 7 列以外的列",
};

export async function runDryRun({ reader, paused = false, write = (line) => process.stdout.write(`${line}\n`), now = Date.now }) {
  write(`数据库类型：${reader.kind}`);
  if (paused) {
    write("KEY_AGENT_PAUSED 已打开：读取服务不读库。去掉它再试。");
    return 0;
  }
  const started = now();
  try {
    const rows = await reader.read();
    const status = reader.status();
    write(`读取：成功，${rows.length} 个渠道，用时 ${now() - started} 毫秒`);
    write(status.account === "ok" && reader.kind !== "sqlite" ? "账号权限：只有 channels 表那几列的 SELECT，没有多余的权限" : "账号权限：这个数据库不查账号（SQLite 没有账号）");
    write(`channel_info 列：${status.withChannelInfo ? "有" : "没有（老版本的表，多 Key 渠道会当成一把 Key）"}`);
    if (status.connectionLimit !== undefined && status.connectionLimit !== 1) write(`提醒：这个角色的连接数上限是 ${status.connectionLimit === -1 ? "没设" : status.connectionLimit}，建议设成 1（ALTER ROLE … CONNECTION LIMIT 1）`);
    return 0;
  } catch (err) {
    const code = err instanceof ReadFailure ? err.code : "DB_ERROR";
    const driver = err instanceof ReadFailure ? err.driver : "UNKNOWN";
    write(`读取：失败，原因码 ${code}（${driver}），用时 ${now() - started} 毫秒`);
    if (code === "ACCOUNT_TOO_BROAD") write(`账号权限不合格：${ACCOUNT_TEXT[driver] ?? driver}。请按部署说明建一个专用账号，只给 channels 表那 7 列的 SELECT。`);
    return 1;
  } finally {
    await reader.close();
  }
}
