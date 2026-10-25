// 文档里的相对链接、图片路径、#锚点都要打得开（CONTRIBUTING 第 1 节「一处来源」的前提：链接得先指对地方）。
// 只查仓库内的相对链接和锚点；外部 http(s)、mailto 链接不验证网络可达性，直接跳过。
// 锚点算法照 GitHub 的标题转锚点规则：转小写、去掉标点（保留中日韩文字、数字、连字符、下划线），空格变成 -，
// 同名标题第二个起加 -1、-2……下面用几条中文标题的例子把这个算法锁住，免得以后改动悄悄走样。
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SKIP_DIRS = new Set(["node_modules", ".git", ".next", ".claude", ".github", "coverage", "out"]);

// 仓库里所有 .md 文件，相对路径
function walkMarkdown(dir) {
  return readdirSync(join(ROOT, dir || "."), { withFileTypes: true }).flatMap((entry) => {
    const path = dir ? `${dir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) return SKIP_DIRS.has(entry.name) ? [] : walkMarkdown(path);
    return entry.name.endsWith(".md") ? [path] : [];
  });
}
const FILES = walkMarkdown("");

// GitHub 风格的标题转锚点：小写、去标点、保留中日韩文字/数字/-/_，空格变 -
function slug(heading) {
  const lower = heading.trim().toLowerCase().replace(/<[^>]+>/g, "");
  let out = "";
  for (const ch of lower) {
    if (ch === "-" || ch === "_" || /[\p{L}\p{N}\p{Mn}]/u.test(ch)) out += ch;
    else if (ch === " ") out += "-";
  }
  return out;
}

const anchorCache = new Map();
function anchorsOf(absPath) {
  if (anchorCache.has(absPath)) return anchorCache.get(absPath);
  let text;
  try { text = readFileSync(absPath, "utf8"); } catch { anchorCache.set(absPath, null); return null; }
  const set = new Set();
  const counts = new Map();
  let inFence = false;
  for (const line of text.split("\n")) {
    if (line.startsWith("```")) { inFence = !inFence; continue; }
    if (inFence) continue;
    const m = /^(#{1,6})\s+(.*)$/.exec(line);
    if (m) {
      const base = slug(m[2]);
      const n = counts.get(base) || 0;
      set.add(n === 0 ? base : `${base}-${n}`);
      counts.set(base, n + 1);
    }
  }
  for (const m of text.matchAll(/<a\s+(?:name|id)="([^"]+)"/g)) set.add(m[1]);
  anchorCache.set(absPath, set);
  return set;
}

const LINK_RE = /(!?)\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
// 反引号里的截图路径，例如 `screens/x.png`；带通配符（* { } |）的例子不查（样稿目录里常见的 glob 写法，本来就不是一个确切文件）
const SCREEN_RE = /`((?:\.\.\/)?(?:ux\/)?screens\/[^`*{}|]+\.png)`/g;

function checkFile(relPath) {
  const abs = join(ROOT, relPath);
  const dir = dirname(abs);
  const text = readFileSync(abs, "utf8");
  const problems = [];
  let inFence = false;
  text.split("\n").forEach((line, idx) => {
    const ln = idx + 1;
    if (line.startsWith("```")) { inFence = !inFence; return; }
    if (inFence) return;
    for (const m of line.matchAll(LINK_RE)) {
      const url = m[3];
      if (/^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith("mailto:")) continue; // 外部链接跳过
      const hashAt = url.indexOf("#");
      const path = hashAt === -1 ? url : url.slice(0, hashAt);
      const frag = hashAt === -1 ? undefined : url.slice(hashAt + 1);
      const target = path ? join(dir, path) : abs;
      if (path && !existsSync(target)) { problems.push(`${relPath}:${ln}  MISSING  ${url}`); continue; }
      if (frag !== undefined && target.endsWith(".md")) {
        const anchors = anchorsOf(target);
        if (anchors !== null && !anchors.has(decodeURIComponent(frag))) problems.push(`${relPath}:${ln}  ANCHOR  ${url}`);
      }
    }
    for (const m of line.matchAll(SCREEN_RE)) {
      const whole = m[1]; // 例如 screens/k-account.png，按文档所在目录查
      if (!existsSync(join(dir, whole))) problems.push(`${relPath}:${ln}  MISSING  \`${whole}\``);
    }
  });
  return problems;
}

test("文档里的相对链接、图片路径、#锚点都存在", () => {
  const problems = FILES.flatMap(checkFile);
  assert.deepEqual(problems, []);
});

test("标题转锚点的算法（中文标题例子，锁住算法不让它悄悄走样）", () => {
  assert.equal(slug("一、设计稿的拟改条目（还没进规范）"), "一设计稿的拟改条目还没进规范");
  assert.equal(slug("5.5 删除和兜底"), "55-删除和兜底");
  assert.equal(slug("Key 认不出来怎么办？"), "key-认不出来怎么办");
  assert.equal(slug("同名标题"), "同名标题");
});
