// 仓库里的文本文件不该留着没解开的 git 冲突标记（CONTRIBUTING 第 1 节「一处来源」的前提：规范、代码得先是干净的）。
// 只按行扫描这三种标记本身（<<<<<<</=======/>>>>>>>，后面跟空格加别的内容，或者整行就这 7 个字符）字面还在不在，
// 抓的是「标记没删」这一种错。合并转发时更隐蔽的错——把三行标记删掉、但两边内容都留着拼在一起——这条测试看不出来，
// 文件字面上一个标记都没有，但内容是重复/矛盾的；这种只能靠审核看 diff，不是自动化能当场拦的。
// 已知的假阳性：markdown 里 Setext 风格的一级标题，下划线刚好是 7 个「=」，会被当成冲突标记（这个仓库目前统一用
// # 这种 ATX 标题，没有这种写法）；真碰上了，把下划线换成别的长度，或者改成 # 标题。
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
