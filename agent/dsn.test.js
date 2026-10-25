import test from "node:test";
import assert from "node:assert/strict";
import { resolveDatabase } from "./dsn.js";

test("没配库：SQLite，路径照 SQLITE_PATH，默认 one-api.db，? 后面的参数去掉", () => {
  assert.deepEqual(resolveDatabase({}), { kind: "sqlite", path: "one-api.db" });
  assert.deepEqual(resolveDatabase({ SQL_DSN: "local" }), { kind: "sqlite", path: "one-api.db" });
  assert.deepEqual(resolveDatabase({ SQLITE_PATH: "/data/new-api.db?_busy_timeout=30000" }), { kind: "sqlite", path: "/data/new-api.db" });
});

test("postgres:// 和 postgresql:// 是 PostgreSQL，连接串原样给驱动", () => {
  assert.deepEqual(resolveDatabase({ SQL_DSN: "postgres://u:p@db:5432/newapi?sslmode=disable" }), { kind: "postgres", connectionString: "postgres://u:p@db:5432/newapi?sslmode=disable" });
  assert.equal(resolveDatabase({ SQL_DSN: "postgresql://u@h/d" }).kind, "postgres");
});

test("Go 风格 MySQL：tcp(host:port)、密码里有 @ / : 、默认端口", () => {
  assert.deepEqual(resolveDatabase({ SQL_DSN: "root:123456@tcp(mysql:3306)/new-api?charset=utf8mb4&parseTime=True&loc=Local" }),
    { kind: "mysql", user: "root", password: "123456", database: "new-api", host: "mysql", port: 3306 });
  assert.deepEqual(resolveDatabase({ SQL_DSN: "u:p@ss:w/rd@tcp(10.0.0.5)/db" }),
    { kind: "mysql", user: "u", password: "p@ss:w/rd", database: "db", host: "10.0.0.5", port: 3306 });
  assert.equal(resolveDatabase({ SQL_DSN: "u:p@tcp([::1]:3307)/db" }).host, "::1");
  assert.equal(resolveDatabase({ SQL_DSN: "u:p@/db" }).host, "127.0.0.1");
  assert.deepEqual(resolveDatabase({ SQL_DSN: "u:p@unix(/var/run/mysqld/mysqld.sock)/db" }),
    { kind: "mysql", user: "u", password: "p", database: "db", socketPath: "/var/run/mysqld/mysqld.sock" });
});

test("Go 风格 MySQL：tls 参数", () => {
  assert.deepEqual(resolveDatabase({ SQL_DSN: "u:p@tcp(h:3306)/d?tls=true" }).ssl, {});
  assert.deepEqual(resolveDatabase({ SQL_DSN: "u:p@tcp(h:3306)/d?tls=skip-verify" }).ssl, { rejectUnauthorized: false });
  assert.equal(resolveDatabase({ SQL_DSN: "u:p@tcp(h:3306)/d?tls=false" }).ssl, undefined);
});

test("mysql:// 的 URL 写法也认", () => {
  assert.deepEqual(resolveDatabase({ KEY_AGENT_DSN: "mysql://ro:pw%40x@db:3307/newapi" }),
    { kind: "mysql", user: "ro", password: "pw@x", database: "newapi", host: "db", port: 3307 });
});

test("KEY_AGENT_DSN 优先于 SQL_DSN", () => {
  assert.equal(resolveDatabase({ KEY_AGENT_DSN: "postgres://ro@h/d", SQL_DSN: "root:p@tcp(h)/d" }).kind, "postgres");
});

test("格式不对报 DSN_INVALID，报错里不带连接串", () => {
  for (const bad of ["no-slash-here", "u:p@weird(x)(y)/db", "u:p@tcp(h:notaport)/db", "u:p@udp(h:1)/db"]) {
    assert.throws(() => resolveDatabase({ SQL_DSN: bad }), (e) => e.code === "DSN_INVALID" && !e.message.includes(bad));
  }
});
