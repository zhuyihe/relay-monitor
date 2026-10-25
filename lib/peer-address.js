// 预加载（node --import ./lib/peer-address.js）：每个请求进来时，把真正连进来的地址（socket.remoteAddress）写进一个私有请求头，
// 登录失败限流按它算（lib/api.js clientIp）。为什么要这样：Next 16 的路由里拿不到 socket；Next 自己写的 x-forwarded-for
// 是「客户端没带才写」，客户端自己带一个就能冒充。
// - 头的名字每个部署随机一个（lib/client-address.js peerHeaderName），客户端猜不到；
// - 每个请求都覆盖写：客户端自己带的同名头会被盖掉，取不到地址时删掉。
// Dockerfile 的 CMD 和 npm start 都带着它（tests/peer-address.test.mjs 守着）；没带时 clientIp 退回全站一个计数，启动日志会警告。
import http from "node:http";
import https from "node:https";
import { randomBytes } from "node:crypto";
import { normalizeAddress, peerHeaderName } from "./client-address.js";

if (!peerHeaderName()) process.env.RELAY_PEER_HEADER = `x-relay-peer-${randomBytes(16).toString("hex")}`;
const header = peerHeaderName();

function stamp(req) {
  const address = normalizeAddress(req.socket?.remoteAddress);
  if (address) req.headers[header] = address;
  else delete req.headers[header];
}

for (const module of [http, https]) {
  const createServer = module.createServer;
  if (createServer.relayPeerAddress) continue;
  const wrapped = function createServerWithPeerAddress(...args) {
    const server = createServer.apply(this, args);
    // 放在最前面：Next 的处理器拿到请求时头已经写好
    server.prependListener("request", stamp);
    return server;
  };
  wrapped.relayPeerAddress = true;
  module.createServer = wrapped;
}
