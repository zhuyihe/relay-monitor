// 第 0 步：定夹具起点。epoch0 = 92 天前的 UTC 零点；以后重建会换新的起点（夹具总是「截至现在的 90 天」）。
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { CONFIG_PATH, RULES } from "../lib/model.mjs";

const now = Math.floor(Date.now() / 1000);
const epoch0Sec = Math.floor(now / 86400) * 86400 - 92 * 86400;
// 约 1/7 的 New API 绑定所在的 (上游, 分组) 在 40 天前换过倍率 → 这些绑定有两段倍率时段
const ratioChangeAtMs = (Math.floor(now / 3600) * 3600 - 40 * 86400) * 1000;
const ratioChanges = [];
for (const rule of RULES) {
  if (rule.up.kind !== "newapi" || rule.r % 7 !== 3) continue;
  if (!ratioChanges.some((x) => x.upstream === rule.up.i && x.group === rule.token.group)) ratioChanges.push({ upstream: rule.up.i, group: rule.token.group });
}
const config = { epoch0Sec, epoch0: new Date(epoch0Sec * 1000).toISOString(), createdAt: new Date().toISOString(), ratioChangeAtMs, ratioChanges };
mkdirSync(dirname(CONFIG_PATH), { recursive: true });
writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
console.log(config);
