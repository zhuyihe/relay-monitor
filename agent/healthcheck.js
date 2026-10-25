// 镜像的健康检查：只打本机的 /healthz（开了 HTTPS 时证书对不上 127.0.0.1，不校验）
import http from "node:http";
import https from "node:https";

const port = Number(process.env.PORT) || 8790;
const secure = !!(process.env.TLS_CERT_FILE && process.env.TLS_KEY_FILE);
// 服务绑在哪个地址就打哪个（HOST=::1 时 127.0.0.1 打不通）；没设或绑在所有地址上就打本机
const bound = String(process.env.HOST ?? "").trim();
const host = !bound || bound === "0.0.0.0" ? "127.0.0.1" : bound === "::" ? "::1" : bound;
const request = (secure ? https : http).get({ host, port, path: "/healthz", timeout: 4000, ...(secure ? { rejectUnauthorized: false } : {}) }, (res) => {
  res.resume();
  process.exit(res.statusCode === 200 ? 0 : 1);
});
request.on("error", () => process.exit(1));
request.on("timeout", () => process.exit(1));
