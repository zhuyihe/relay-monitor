// 界面测试分几路同时跑：node scripts/ui-lanes.mjs [路数，默认 4]
// 服务要先开好（RECONCILIATION_UI_BASE_URL），浏览器用 PLAYWRIGHT_MODULE / PLAYWRIGHT_CHANNEL，和单独跑 tests/reconciliation-ui.test.mjs 一样。
// 每一路只登记自己那份用例（UI_SHARD / UI_SHARDS，见测试文件开头）；几路都跑完以后，失败的那几条单独再跑一次：
// 几路同时跑时机器忙，个别用例会超时，单独跑过了就算过；单独跑还是失败才算失败。退出码按最后的结果
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";

const FILE = "tests/reconciliation-ui.test.mjs";
const lanes = Math.max(1, Number(process.argv[2] || 4));
const outDir = process.env.UI_LANES_OUT || "ui-lanes-logs";
mkdirSync(outDir, { recursive: true });

// 每条用例最多跑 4 分钟：卡住的那条超时失败、报出名字（CI 上最慢的一条约 1 分钟）
const TEST_TIMEOUT_MS = 240_000;
// 每一路最多跑 10 分钟（CI 上一路平时 4–5 分钟）：用例超时管不住的卡死（比如 node --test 进程跑完不退出）也有个头，
// 到点把这一路整个杀掉、打出它最后的输出，没跑完的用例再单独跑
const LANE_TIMEOUT_MS = Number(process.env.UI_LANE_TIMEOUT_MS) || 600_000;
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function run(args, env, limitMs) {
  return new Promise((resolve) => {
    const started = Date.now();
    // 单独一个进程组：node --test 会为测试文件再起子进程，超时要连它们一起杀
    const child = spawn(process.execPath, ["--test", "--test-reporter=spec", `--test-timeout=${TEST_TIMEOUT_MS}`, ...args, FILE],
      { env: { ...process.env, ...env }, detached: true });
    let out = "", timedOut = false;
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { out += d; });
    const timer = limitMs ? setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid, "SIGKILL"); } catch {}
    }, limitMs) : null;
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, out, timedOut, seconds: Math.round((Date.now() - started) / 1000) }); });
  });
}
const count = (out, key) => Number(out.match(new RegExp(`^ℹ ${key} (\\d+)`, "m"))?.[1] || 0);
// 顶格的 ✔ / ✖ 行：跑完了的用例（不含整个文件那一行）
const finished = (out) => [...out.matchAll(/^([✔✖]) (.+?)(?: \(([\d.]+)m?s\))?$/gm)]
  .filter((m) => !m[2].startsWith("tests/") && m[2] !== "failing tests:").map((m) => ({ ok: m[1] === "✔", name: m[2], ms: Number(m[3] || 0) }));
// 失败的用例名：「failing tests」之前、顶格的 ✖ 行
const failedNames = (out) => [...new Set(finished(out.split("\n✖ failing tests:")[0]).filter((t) => !t.ok).map((t) => t.name))];
// 第一次失败的那几条为什么失败：「failing tests」后面每条一段（test at … / ✖ 名字 (耗时) / 报错），各取前几行打进 job 日志。
// CI 跑成功时不传日志，单独重跑过了的那几条只有这里看得到原因
function failureBlocks(out) {
  const tail = out.split("\n✖ failing tests:")[1] || "";
  return tail.split(/\n(?=test at )/).map((block) => block.trim()).filter((block) => block.startsWith("test at "))
    .map((block) => block.split("\n").slice(1, 10).join("\n"));
}
// 最慢的几条（看是不是哪条在等）
const slowest = (out, n = 3) => finished(out).sort((a, b) => b.ms - a.ms).slice(0, n);
const group = (title, body) => console.log(`::group::${title}\n${body}\n::endgroup::`);

const t0 = Date.now();
const results = await Promise.all(Array.from({ length: lanes }, (_, i) => run([], { UI_SHARD: String(i), UI_SHARDS: String(lanes) }, LANE_TIMEOUT_MS)));
results.forEach((r, i) => writeFileSync(`${outDir}/lane-${i}.log`, r.out));
const total = results.reduce((s, r) => s + count(r.out, "tests"), 0);
const pass = results.reduce((s, r) => s + count(r.out, "pass"), 0);
console.log(`${lanes} 路同时跑 ${Math.round((Date.now() - t0) / 1000)} 秒：${pass} / ${total}`);
results.forEach((r, i) => console.log(`  第 ${i} 路 ${r.seconds} 秒${r.timedOut ? "（超时，杀掉了）" : ""}，${count(r.out, "pass")} / ${count(r.out, "tests")}；最慢：${slowest(r.out).map((t) => `${t.name.slice(0, 60)} ${Math.round(t.ms / 1000)}s`).join("；")}`));
for (const [i, r] of results.entries()) for (const block of failureBlocks(r.out)) group(`第 ${i} 路第一次失败：${block.split("\n")[0].slice(2, 90)}`, block);

let stillFailing = 0, rerunIndex = 0;
async function rerunOne(name) {
  const again = await run([`--test-name-pattern=^${escapeRegExp(name)}$`], {}, TEST_TIMEOUT_MS + 60_000);
  if (again.code === 0 && !again.timedOut) { console.log(`  单独重跑过了：${name}`); return; }
  stillFailing += 1; rerunIndex += 1;
  writeFileSync(`${outDir}/failed-${rerunIndex}.log`, again.out);
  console.log(`  单独重跑还是失败：${name}（见 ${outDir}/failed-${rerunIndex}.log）`);
  group(`单独重跑还是失败：${name.slice(0, 90)}`, (failureBlocks(again.out)[0] || again.out.split("\n").slice(-30).join("\n")));
}

// 被杀掉的那一路：打出最后的输出；它没跑完的用例（这一路登记了、还没出 ✔ / ✖ 的）再跑一遍，跑过的跳过
let unfinishedLanes = 0;
for (const [i, r] of results.entries()) {
  if (!r.timedOut && !(r.code !== 0 && failedNames(r.out).length === 0)) continue;
  group(`第 ${i} 路没跑完${r.timedOut ? "（超时被杀掉）" : `（退出码 ${r.code}，没有失败的用例名）`}，最后的输出`, r.out.split("\n").slice(-40).join("\n"));
  const done = finished(r.out).map((t) => t.name);
  const skip = done.length ? [`--test-skip-pattern=^(?:${done.map(escapeRegExp).join("|")})$`] : [];
  const rest = await run(skip, { UI_SHARD: String(i), UI_SHARDS: String(lanes) }, LANE_TIMEOUT_MS);
  writeFileSync(`${outDir}/lane-${i}-rest.log`, rest.out);
  console.log(`  第 ${i} 路剩下的再跑一遍：${rest.seconds} 秒，${count(rest.out, "pass")} / ${count(rest.out, "tests") - count(rest.out, "skipped")}${rest.timedOut ? "（又超时了）" : ""}`);
  if (rest.timedOut || (rest.code !== 0 && failedNames(rest.out).length === 0)) {
    unfinishedLanes += 1;
    group(`第 ${i} 路剩下的还是没跑完，最后的输出`, rest.out.split("\n").slice(-40).join("\n"));
  }
  for (const name of failedNames(rest.out)) await rerunOne(name);
}
for (const name of [...new Set(results.flatMap((r) => failedNames(r.out)))]) await rerunOne(name);
if (total === 0) console.log("一条用例都没跑到");
process.exit(stillFailing || unfinishedLanes || total === 0 ? 1 : 0);
