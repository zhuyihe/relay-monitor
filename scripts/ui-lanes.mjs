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

function run(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--test", "--test-reporter=spec", ...args, FILE], { env: { ...process.env, ...env } });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { out += d; });
    child.on("close", (code) => resolve({ code, out }));
  });
}
const count = (out, key) => Number(out.match(new RegExp(`^ℹ ${key} (\\d+)`, "m"))?.[1] || 0);
// 失败的用例名：「failing tests」之前、顶格的 ✖ 行（不含整个文件那一行）
const failedNames = (out) => [...new Set(out.split("\n✖ failing tests:")[0].split("\n")
  .filter((line) => line.startsWith("✖ ") && !line.startsWith("✖ tests/"))
  .map((line) => line.slice(2).replace(/ \([\d.]+m?s\)$/, "")))];

const t0 = Date.now();
const results = await Promise.all(Array.from({ length: lanes }, (_, i) => run([], { UI_SHARD: String(i), UI_SHARDS: String(lanes) })));
results.forEach((r, i) => writeFileSync(`${outDir}/lane-${i}.log`, r.out));
const total = results.reduce((s, r) => s + count(r.out, "tests"), 0);
const pass = results.reduce((s, r) => s + count(r.out, "pass"), 0);
console.log(`${lanes} 路同时跑 ${Math.round((Date.now() - t0) / 1000)} 秒：${pass} / ${total}`);

const failed = results.flatMap((r) => failedNames(r.out));
const crashed = results.map((r, i) => ({ r, i })).filter(({ r }) => r.code !== 0 && failedNames(r.out).length === 0);
for (const { i } of crashed) console.log(`第 ${i} 路没跑完（没有失败的用例名，见 ${outDir}/lane-${i}.log）`);
let stillFailing = 0;
for (const name of failed) {
  const pattern = `^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`;
  const again = await run([`--test-name-pattern=${pattern}`], {});
  if (again.code === 0) console.log(`  单独重跑过了：${name}`);
  else {
    stillFailing += 1;
    writeFileSync(`${outDir}/failed-${stillFailing}.log`, again.out);
    console.log(`  单独重跑还是失败：${name}（见 ${outDir}/failed-${stillFailing}.log）`);
  }
}
if (total === 0) console.log("一条用例都没跑到");
process.exit(stillFailing || crashed.length || total === 0 ? 1 : 0);
