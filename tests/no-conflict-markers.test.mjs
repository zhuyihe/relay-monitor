// 仓库里的文本文件不该留着没解开的 git 冲突标记（CONTRIBUTING 第 1 节「一处来源」的前提：规范、代码得先是干净的）。
// 合并转发时最容易出的错不是留着整段 <<<<<<< / ======= / >>>>>>>，而是「删掉这三行标记、两边内容都留着」这种
// 看着像解决了、其实把两份内容拼在一起的半吊子解法——这条守护两种都抓：按行扫描，一行开头是这三种标记之一
// （后面跟着分支名或者整行就这 7 个字符）就算数，不看文件是不是“看起来还能跑”。
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SELF = "tests/no-conflict-markers.test.mjs"; // 本文件的说明文字会提到这几个标记，不扫自己
const SKIP_DIRS = new Set(["node_modules", ".git", ".next", ".claude", "coverage", "out"]);
const EXTENSIONS = new Set([".md", ".js", ".ts", ".tsx", ".mjs", ".json", ".yml"]);
// 仓库根目录的 data/（中转站凭证、面板密码哈希、会话密钥——见 .gitignore 的注释）不扫；
// 只锚定根目录，app/mock/**/api/data/ 这类源码目录照样扫（同 .gitignore 的锚定理由）
const ROOT_ONLY_SKIP = new Set(["data"]);

function walk(dir) {
  return readdirSync(join(ROOT, dir || "."), { withFileTypes: true }).flatMap((entry) => {
    const path = dir ? `${dir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || (!dir && ROOT_ONLY_SKIP.has(entry.name))) return [];
      return walk(path);
    }
    const dot = entry.name.lastIndexOf(".");
    const ext = dot === -1 ? "" : entry.name.slice(dot);
    return EXTENSIONS.has(ext) && path !== SELF ? [path] : [];
  });
}

// 7 个同样的字符开头：后面跟空格加别的内容（分支名、标签），或者整行就这 7 个字符
const MARKER_RE = /^(<{7}|={7}|>{7})(?:[ \t].*)?$/;

test("仓库里的文本文件（.md/.js/.ts/.tsx/.mjs/.json/.yml）不留没解开的 git 冲突标记", () => {
  const problems = [];
  for (const path of walk("")) {
    let text;
    try { text = readFileSync(join(ROOT, path), "utf8"); } catch { continue; } // 读不了当二进制，跳过
    text.split("\n").forEach((line, idx) => {
      if (MARKER_RE.test(line)) problems.push(`${path}:${idx + 1}  ${line.slice(0, 60)}`);
    });
  }
  assert.deepEqual(problems, [], `发现没解开的 git 冲突标记，先解决冲突再提交：\n${problems.join("\n")}`);
});
