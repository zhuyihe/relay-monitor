import test from "node:test";
import assert from "node:assert/strict";
import { classifyError, isMissingColumn, selectSql } from "./reader.js";

test("缺列按各库的错误码认，别的错不算", () => {
  assert.equal(isMissingColumn({ code: "ER_BAD_FIELD_ERROR", errno: 1054 }), true);
  assert.equal(isMissingColumn({ errno: 1054 }), true);
  assert.equal(isMissingColumn({ code: "42703" }), true);
  assert.equal(isMissingColumn({ code: "ERR_SQLITE_ERROR", errcode: 1, message: "no such column: channel_info" }), true);
  assert.equal(isMissingColumn({ code: "ER_COLUMNACCESS_DENIED_ERROR", errno: 1143 }), false);
  assert.equal(isMissingColumn({ code: "ER_NO_SUCH_TABLE" }), false);
  assert.equal(isMissingColumn({ code: "ERR_SQLITE_ERROR", errcode: 1, message: "no such table: channels" }), false);
  assert.equal(isMissingColumn(new Error("column channel_info does not exist")), false, "不靠 MySQL、PostgreSQL 的报错文字");
});

test("原因码：连不上、被拒、表不存在、其他", () => {
  const code = (err) => classifyError(err).code;
  for (const c of ["ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT", "ECONNRESET", "PROTOCOL_CONNECTION_LOST", "ER_BAD_DB_ERROR", "3D000", "08006", "57P03"]) assert.equal(code({ code: c }), "DB_UNREACHABLE", c);
  assert.equal(code({ code: "ERR_SQLITE_ERROR", errcode: 14, message: "unable to open database file" }), "DB_UNREACHABLE");
  for (const c of ["ER_ACCESS_DENIED_ERROR", "ER_DBACCESS_DENIED_ERROR", "ER_TABLEACCESS_DENIED_ERROR", "ER_COLUMNACCESS_DENIED_ERROR", "28P01", "28000", "42501"]) assert.equal(code({ code: c }), "DB_DENIED", c);
  assert.equal(code({ code: "ERR_SQLITE_ERROR", errcode: 8, message: "attempt to write a readonly database" }), "DB_DENIED");
  for (const c of ["ER_NO_SUCH_TABLE", "42P01"]) assert.equal(code({ code: c }), "TABLE_MISSING", c);
  assert.equal(code({ code: "ERR_SQLITE_ERROR", errcode: 1, message: "no such table: channels" }), "TABLE_MISSING");
  assert.equal(code({ code: "ER_PARSE_ERROR" }), "DB_ERROR");
  assert.equal(code(new Error("boom")), "DB_ERROR");
  assert.equal(code(undefined), "DB_ERROR");
});

test("原因码里不带报错原文", () => {
  assert.deepEqual(classifyError({ code: "ER_ACCESS_DENIED_ERROR", message: "Access denied for user 'root'@'10.0.0.8' (using password: YES)" }), { code: "DB_DENIED", driver: "ER_ACCESS_DENIED_ERROR" });
});

test("固定的 SELECT：两种库的引号，有无 channel_info", () => {
  assert.equal(selectSql("mysql", true), "SELECT id, name, type, status, base_url, `key`, channel_info FROM channels ORDER BY id");
  assert.equal(selectSql("postgres", true), 'SELECT id, name, type, status, base_url, "key", channel_info FROM channels ORDER BY id');
  assert.equal(selectSql("sqlite", false), 'SELECT id, name, type, status, base_url, "key" FROM channels ORDER BY id');
});
