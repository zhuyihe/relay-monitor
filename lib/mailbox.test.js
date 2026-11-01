import test from "node:test";
import assert from "node:assert/strict";
import { MAILBOX_MAX_LENGTH, isMailbox } from "./mailbox.js";

test("一个干净的地址才算邮箱", () => {
  for (const ok of ["alice@mail.test", "a.b+tag@sub.example.com", "用户@例子.中国", "x@y.z"]) assert.equal(isMailbox(ok), true, ok);
});

test("会发给别人或往 SMTP 会话里塞命令的写法都不算：逗号、分号（含全角）、换行、尖括号、空白、引号、括号、反斜杠", () => {
  const attacks = [
    "alice@mail.test,victim@x.test", "alice@mail.test;victim@x.test", "alice@mail.test，victim@x.test", "alice@mail.test；victim@x.test",
    "a@b.test>\r\nRCPT TO:<victim@x.test", "a@b.test\r\nBcc: victim@x.test", "a@b.test\nBcc: victim@x.test",
    "Alice <alice@mail.test>", "alice@mail.test ", " alice@mail.test", "ali ce@mail.test", "\"a\"@mail.test", "a(b)@mail.test", "a\\b@mail.test",
  ];
  for (const bad of attacks) assert.equal(isMailbox(bad), false, JSON.stringify(bad));
});

test("没有 @ 或没有点、空的、不是字符串、超过 254 个字符都不算", () => {
  for (const bad of ["", "alice", "alice@mail", "@mail.test", "alice@", "alice@.test", null, undefined, 5, {}]) assert.equal(isMailbox(bad), false, String(bad));
  const long = (n) => `${"a".repeat(n - "@b.test".length)}@b.test`;
  assert.equal(isMailbox(long(MAILBOX_MAX_LENGTH)), true);
  assert.equal(isMailbox(long(MAILBOX_MAX_LENGTH + 1)), false);
});
