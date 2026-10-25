// 种子和测量脚本共用的环境，全部从环境变量取（默认值见 README）：
//   DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/DB_NAME  夹具库（默认 127.0.0.1:3306，root，空密码，relay_monitor_perf）
//   APP_PORT  被测服务的端口（默认 3301）；FAKE_PORT 假站点（lib/model.mjs，默认 18950）
//   PERF_APP_DIR  种子和测量引用的应用代码目录（要有 node_modules；默认仓库根）
//   PERF_OUT  结果目录（lib/model.mjs）
import { appendFileSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { join, resolve } from "node:path";
import { PERF_DIR, OUT_DIR } from "./model.mjs";

export const DB_NAME = process.env.DB_NAME || "relay_monitor_perf";
export const DB_ENV = { DB_HOST: process.env.DB_HOST || "127.0.0.1", DB_PORT: process.env.DB_PORT || "3306",
  DB_USER: process.env.DB_USER || "root", DB_PASSWORD: process.env.DB_PASSWORD ?? "", DB_NAME };
// 应用自己的 getPool() 读的也是这几个环境变量
for (const [k, v] of Object.entries(DB_ENV)) process.env[k] = v;
export const APP_PORT = Number(process.env.APP_PORT || 3301);
export const APP = `http://127.0.0.1:${APP_PORT}`;
export const APP_DIR = resolve(process.env.PERF_APP_DIR || join(PERF_DIR, "..", ".."));
export { OUT_DIR };

// 种子会删库重建：库名里不带 perf 的一律不碰（防止指到 relay_monitor、relay_monitor_test 这类库）
export function assertPerfDatabase() {
  if (!/perf/i.test(DB_NAME)) throw new Error(`DB_NAME=${DB_NAME}：性能夹具只用名字里带 perf 的库，别的库不碰`);
}

export function progress(line) {
  const text = `${new Date().toLocaleString("zh-CN", { hour12: false })} ${line}`;
  mkdirSync(OUT_DIR, { recursive: true });
  appendFileSync(join(OUT_DIR, "progress.log"), text + "\n");
  console.log(text);
}

// 在 APP_PORT 上监听的进程号（服务进程的 CPU、内存采样用）：先试 lsof，没有就用 ss（Linux）
export function appPid() {
  try { const pid = execSync(`lsof -ti tcp:${APP_PORT} -sTCP:LISTEN`, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim().split("\n")[0]; if (pid) return pid; } catch { /* 试下一个 */ }
  try { const m = execSync(`ss -Hltnp 'sport = :${APP_PORT}'`, { stdio: ["ignore", "pipe", "ignore"] }).toString().match(/pid=(\d+)/); if (m) return m[1]; } catch { /* 都没有 */ }
  return null;
}

// 带登录 cookie 的接口客户端
export async function login() {
  const res = await fetch(`${APP}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "admin123" }) });
  if (!res.ok) throw new Error(`登录失败 HTTP ${res.status} ${await res.text()}`);
  const cookie = res.headers.get("set-cookie").split(";")[0];
  return async function api(path, { method = "GET", body, raw = false } = {}) {
    const r = await fetch(`${APP}${path}`, { method, headers: { Cookie: cookie, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined });
    if (raw) return r;
    const text = await r.text();
    let data; try { data = JSON.parse(text); } catch { data = { __raw: text.slice(0, 300) }; }
    if (!r.ok) throw Object.assign(new Error(`${method} ${path} → HTTP ${r.status}: ${data.error || data.__raw || text.slice(0, 200)}`), { status: r.status, data });
    return data;
  };
}
