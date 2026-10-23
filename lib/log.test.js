import test from "node:test";
import assert from "node:assert/strict";
import { errorLogLine, fromDatabase } from "./log.js";

test("errorLogLine: 只记路径、码、类型和一句话；挂着 SQL 的数据库报错不记原文和 SQL", () => {
  const db = Object.assign(new Error("Duplicate entry 'sk-live-secret' for key 'PRIMARY'"), {
    code: "ER_DUP_ENTRY", errno: 1062, sql: "INSERT INTO stations (doc) VALUES ('{\"accessToken\":\"sk-live-secret\"}')", sqlMessage: "Duplicate entry",
  });
  const line = errorLogLine(Object.assign(new Error("保存失败，请稍后重试", { cause: db }), { code: "SAVE_FAILED" }), "/api/stations/1");
  assert.doesNotMatch(line, /sk-live-secret|INSERT/);
  assert.deepEqual(JSON.parse(line), {
    path: "/api/stations/1", name: "Error", code: "SAVE_FAILED", message: "保存失败，请稍后重试",
    cause: { name: "Error", code: "ER_DUP_ENTRY", errno: 1062 },
  });
  // 普通报错留一句话，截到 300 字
  const plain = JSON.parse(errorLogLine(new TypeError("x".repeat(400))));
  assert.equal("path" in plain, false, "没给路径（例如启动失败）时不写空的 path");
  assert.equal(plain.name, "TypeError");
  assert.equal(plain.message.length, 300);
  assert.deepEqual(JSON.parse(errorLogLine("boom", "/x")), { path: "/x", message: "boom" });
  // 只认数据库直接抛出来的；包了一层、自己写了说法的不算
  assert.deepEqual([fromDatabase(db), fromDatabase(new Error("x", { cause: db })), fromDatabase(null), fromDatabase("sql")], [true, false, false, false]);
});
