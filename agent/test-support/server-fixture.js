// 服务测试共用：假读取器、起一个真的 HTTP 服务（注入时钟和日志）、固定的令牌和一行数据
import http from "node:http";
import net from "node:net";
import { deriveAgentKeys } from "../../lib/key-fingerprint.js";
import { createAgentServer } from "../server.js";

export const SECRET = "Un1t7estKd83LmQwRtYx9zPa5vBn7cJf4hGs2";
export const { token } = deriveAgentKeys(SECRET);
export const baseConfig = { secret: SECRET, trustProxy: false, tls: null };

export function fakeReader(rows, { kind = "mysql" } = {}) {
  const state = { reads: 0, rows, error: null };
  return { state, kind, async read() { state.reads += 1; if (state.error) throw state.error; return state.rows; }, async close() {} };
}

export async function withServer(reader, options, fn) {
  const logs = [];
  const clock = { t: 1_700_000_000_000 };
  const server = createAgentServer({ config: { ...baseConfig, ...options }, reader, now: () => clock.t, log: (entry) => logs.push(entry) });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const get = (path, headers = {}, method = "GET") => new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, method, headers, agent: false }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.end();
  });
  try { await fn({ get, logs, clock }); } finally { await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }); }
}

export const auth = { Authorization: `Bearer ${token}` };
export const ROWS = [{ id: 1, name: "A", type: 1, status: 1, base_url: "https://x", key: "sk-AbC1xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx9f0c", channel_info: null }];


// 子进程要听的端口：先让系统分一个空闲的再还回来。不能随便挑 20000–40000 的数：和系统给出站连接用的临时端口重了，子进程会因为端口被占起不来
export function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
  });
}
