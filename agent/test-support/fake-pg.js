// 假 PostgreSQL 服务：只会免密码握手、回 SET；收到 SELECT 的反应由 mode 定：
// drop-in-select：直接把连接掐断（模拟 DB 重启、连接被 kill 在查询中途）；
// idle-drop：回一个空结果集，空闲 200 毫秒后掐断；
// hang：什么都不回（模拟查询卡住）。不需要真的 PostgreSQL，所以哪里都能跑
import net from "node:net";

const message = (type, body = Buffer.alloc(0)) => {
  const out = Buffer.alloc(5 + body.length);
  out.write(type);
  out.writeInt32BE(4 + body.length, 1);
  body.copy(out, 5);
  return out;
};
const READY = message("Z", Buffer.from("I"));

export async function startFakePg(mode = "drop-in-select") {
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    let started = false, buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!started) {
        if (buffer.length < 4 || buffer.length < buffer.readInt32BE(0)) return;
        buffer = buffer.subarray(buffer.readInt32BE(0));
        started = true;
        socket.write(Buffer.concat([message("R", Buffer.from([0, 0, 0, 0])), READY]));
      }
      while (buffer.length >= 5 && buffer.length >= 1 + buffer.readInt32BE(1)) {
        const type = String.fromCharCode(buffer[0]), length = buffer.readInt32BE(1);
        const body = buffer.subarray(5, 1 + length).toString();
        buffer = buffer.subarray(1 + length);
        if (type !== "Q") continue;
        if (/^SET /i.test(body)) socket.write(Buffer.concat([message("C", Buffer.from("SET\0")), READY]));
        else if (/^SELECT/i.test(body)) {
          if (mode === "drop-in-select") socket.destroy();
          else if (mode === "idle-drop") {
            socket.write(Buffer.concat([message("C", Buffer.from("SELECT 0\0")), READY]));
            setTimeout(() => socket.destroy(), 200);
          }
        }
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: server.address().port,
    close: () => new Promise((resolve) => { for (const socket of sockets) socket.destroy(); server.close(resolve); }),
  };
}
