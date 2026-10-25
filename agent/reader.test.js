import test from "node:test";
import assert from "node:assert/strict";
import { classifyError, isMissingColumn, mysqlFlavor, selectSql, withTimeLimit } from "./reader.js";

test("缺 channel_info 这一列：按各库的错误码认，而且报错里要点名 channel_info；别的列缺了、别的错不算", () => {
  const mysqlMissing = "Unknown column 'channel_info' in 'field list'";
  assert.equal(isMissingColumn({ code: "ER_BAD_FIELD_ERROR", errno: 1054, message: mysqlMissing }), true);
  assert.equal(isMissingColumn({ errno: 1054, message: mysqlMissing }), true);
  assert.equal(isMissingColumn({ code: "42703", message: 'column "channel_info" does not exist' }), true);
  assert.equal(isMissingColumn({ code: "ERR_SQLITE_ERROR", errcode: 1, message: "no such column: channel_info" }), true);
  // 有这一列、账号没给它授权（1143）不是缺列：退回会把多 Key 渠道悄悄当成一把 Key。只认 1054
  assert.equal(isMissingColumn({ code: "ER_COLUMNACCESS_DENIED_ERROR", errno: 1143, message: "SELECT command denied to user 'u'@'h' for column 'channel_info' in table 'channels'" }), false);
  assert.equal(isMissingColumn({ code: "ER_COLUMNACCESS_DENIED_ERROR", errno: 1143, message: "SELECT command denied to user 'u'@'h' for column 'key' in table 'channels'" }), false);
  assert.equal(isMissingColumn({ code: "ER_BAD_FIELD_ERROR", errno: 1054, message: "Unknown column 'base_url' in 'field list'" }), false, "别的列缺了不能悄悄退");
  assert.equal(isMissingColumn({ code: "ER_NO_SUCH_TABLE", message: "Table 'x.channels' doesn't exist" }), false);
  assert.equal(isMissingColumn({ code: "ERR_SQLITE_ERROR", errcode: 1, message: "no such table: channels" }), false);
  assert.equal(isMissingColumn(new Error("column channel_info does not exist")), false, "不靠报错文字单独认");
});

test("原因码：连不上、被拒、表不存在、其他", () => {
  const code = (err) => classifyError(err).code;
  for (const c of ["ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT", "ECONNRESET", "ENOENT", "EACCES", "PROTOCOL_CONNECTION_LOST", "ER_BAD_DB_ERROR", "3D000", "08006", "57P03"]) assert.equal(code({ code: c }), "DB_UNREACHABLE", c);
  assert.equal(code({ code: "ERR_SQLITE_ERROR", errcode: 14, message: "unable to open database file" }), "DB_UNREACHABLE");
  for (const c of ["ER_ACCESS_DENIED_ERROR", "ER_DBACCESS_DENIED_ERROR", "ER_TABLEACCESS_DENIED_ERROR", "ER_COLUMNACCESS_DENIED_ERROR", "28P01", "28000", "42501"]) assert.equal(code({ code: c }), "DB_DENIED", c);
  assert.equal(code({ code: "ERR_SQLITE_ERROR", errcode: 8, message: "attempt to write a readonly database" }), "DB_DENIED");
  for (const c of ["ER_NO_SUCH_TABLE", "42P01"]) assert.equal(code({ code: c }), "TABLE_MISSING", c);
  assert.equal(code({ code: "ERR_SQLITE_ERROR", errcode: 1, message: "no such table: channels" }), "TABLE_MISSING");
  assert.equal(code({ code: "ER_PARSE_ERROR" }), "DB_ERROR");
  // 库自己到点掐掉的、额度到顶的、连接被掐的
  for (const err of [{ code: "ER_QUERY_TIMEOUT", errno: 3024 }, { errno: 1969 }, { code: "ER_STATEMENT_TIMEOUT" }, { code: "57014" }, { code: "55P03" }]) assert.equal(code(err), "DB_TIMEOUT", JSON.stringify(err));
  for (const err of [{ code: "ER_USER_LIMIT_REACHED", errno: 1226 }, { errno: 1226 }, { errno: 1203 }, { code: "ER_CON_COUNT_ERROR" }, { code: "53300" }]) assert.equal(code(err), "DB_LIMIT", JSON.stringify(err));
  for (const err of [{ code: "57P01" }, { code: "57P02" }, new Error("Connection terminated unexpectedly"), new Error("terminating connection due to administrator command")]) assert.equal(code(err), "DB_UNREACHABLE", String(err.message ?? err.code));
  assert.equal(code({ code: "PROTOCOL_SEQUENCE_TIMEOUT" }), "DB_UNREACHABLE", "客户端自己等不下去，分不清是不是连不上");
  assert.equal(code({ code: "ERR_SQLITE_ERROR", errcode: 5, message: "database is locked" }), "DB_TIMEOUT");
  assert.equal(code(new Error("boom")), "DB_ERROR");
  assert.equal(code(undefined), "DB_ERROR");
});

test("SQLite 的扩展错误码只看低 8 位；驱动错误码只留字母数字下划线", () => {
  assert.deepEqual(classifyError({ code: "ERR_SQLITE_ERROR", errcode: 1544, message: "attempt to write a readonly database" }), { code: "DB_DENIED", driver: "SQLITE_8" });
  assert.deepEqual(classifyError({ code: "ERR_SQLITE_ERROR", errcode: 266, message: "disk I/O error" }), { code: "DB_ERROR", driver: "SQLITE_10" });
  assert.equal(classifyError({ code: "weird code with spaces and 密钥", message: "x" }).driver, "UNKNOWN");
  assert.equal(classifyError({ code: "x".repeat(41) }).driver, "UNKNOWN");
});

test("原因码里不带报错原文", () => {
  assert.deepEqual(classifyError({ code: "ER_ACCESS_DENIED_ERROR", message: "Access denied for user 'root'@'10.0.0.8' (using password: YES)" }), { code: "DB_DENIED", driver: "ER_ACCESS_DENIED_ERROR" });
});

test("固定的 SELECT：两种库的引号，有无 channel_info", () => {
  assert.equal(selectSql("mysql", true), "SELECT id, name, type, status, base_url, `key`, channel_info FROM channels ORDER BY id");
  assert.equal(selectSql("postgres", true), 'SELECT id, name, type, status, base_url, "key", channel_info FROM channels ORDER BY id');
  assert.equal(selectSql("sqlite", false), 'SELECT id, name, type, status, base_url, "key" FROM channels ORDER BY id');
});

test("按握手的版本串分 MySQL / MariaDB / 老 MySQL，语句仍然只有一条，库侧时限写在语句里", () => {
  for (const [version, flavor] of [["8.4.11", "mysql"], ["8.0.36-0ubuntu0.22.04.1", "mysql"], ["5.7.44", "mysql"], ["5.7.8", "mysql"], ["5.7.7-log", "old"], ["5.6.51", "old"], ["5.5.62", "old"],
    ["10.11.6-MariaDB-1:10.11.6+maria~ubu2204", "mariadb"], ["5.5.5-10.6.16-MariaDB", "mariadb"], ["", "unknown"], [undefined, "unknown"], ["weird", "unknown"], ["9.1.0", "mysql"]]) {
    assert.equal(mysqlFlavor(version), flavor, String(version));
  }
  const body = "SELECT id FROM channels ORDER BY id";
  assert.equal(withTimeLimit(body, { flavor: "mysql", limitMs: 500 }), "SELECT /*+ MAX_EXECUTION_TIME(500) */ id FROM channels ORDER BY id");
  assert.equal(withTimeLimit(body, { flavor: "mariadb", limitMs: 500 }), "SET STATEMENT max_statement_time=0.5 FOR SELECT id FROM channels ORDER BY id");
  assert.equal(withTimeLimit(body, { flavor: "old", limitMs: 500 }), body);
  assert.equal(withTimeLimit(body, { flavor: "unknown", limitMs: 500 }), "SELECT /*+ MAX_EXECUTION_TIME(500) */ id FROM channels ORDER BY id", "认不得的版本串也带提示：不认识的服务器把它当注释");
  assert.equal(withTimeLimit(body, { flavor: "mysql", limitMs: 0 }), body);
  assert.equal(selectSql("mysql", true, { flavor: "mysql", limitMs: 500 }), "SELECT /*+ MAX_EXECUTION_TIME(500) */ id, name, type, status, base_url, `key`, channel_info FROM channels ORDER BY id");
  assert.equal(selectSql("mysql", false, { flavor: "mariadb", limitMs: 500 }), "SET STATEMENT max_statement_time=0.5 FOR SELECT id, name, type, status, base_url, `key` FROM channels ORDER BY id");
  assert.ok(!/;/.test(selectSql("mysql", true, { flavor: "mariadb", limitMs: 500 })), "一条语句，不带分号");
});

test("DB_LIMIT：报错里点名每小时的额度（max_questions 等）才算 hourly，同时连接数满（max_user_connections）、库整体连接满、PostgreSQL 53300 走普通断路", () => {
  const limit = (message, extra = {}) => classifyError({ errno: 1226, code: "ER_USER_LIMIT_REACHED", message, ...extra });
  assert.deepEqual(limit("User 'u' has exceeded the 'max_questions' resource (current value: 120)"), { code: "DB_LIMIT", driver: "ER_USER_LIMIT_REACHED", hourly: true });
  assert.equal(limit("User 'u' has exceeded the 'max_updates' resource (current value: 1)").hourly, true);
  // MySQL 8.4 的原文（实测）：每小时连接数那一种点名的是 max_connections_per_hour，后面不是紧跟引号
  assert.equal(limit("User 'u' has exceeded the 'max_connections_per_hour' resource (current value: 1)").hourly, true);
  assert.equal(limit("User 'u' has exceeded the 'max_connections' resource (current value: 5)").hourly, false, "没有这种写法，不是每小时的额度");
  assert.equal(limit("User 'u' has exceeded the 'max_user_connections' resource (current value: 1)").hourly, false);
  assert.equal(classifyError({ errno: 1203, message: "User u already has more than 'max_user_connections' active connections" }).hourly, false);
  assert.equal(classifyError({ errno: 1040, code: "ER_CON_COUNT_ERROR", message: "Too many connections" }).hourly, false);
  assert.equal(classifyError({ code: "53300", message: "too many connections for role" }).hourly, false);
});
