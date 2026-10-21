// 写日志用的小工具，不依赖 Next，路由外壳（lib/api.js）和单测都能直接用。
// 日志里只记路径、码、类型和一句话，不打印报错对象本身：mysql2 的报错上挂着代入了参数的整条 SQL（err.sql），
// 存站点、通知配置的那条会带出全部登录信息和密钥。挂着 SQL 的报错连那句话也不记（数据库原文可能带出写入的值），只记数据库的错误码
export function errorLogLine(err, pathname = "") {
  const brief = (e) => {
    if (!e || typeof e !== "object") return { message: String(e ?? "").slice(0, 300) };
    const fromDatabase = "sql" in e || "sqlMessage" in e;
    return {
      name: e.name || null,
      code: e.code || null,
      ...(e.errno != null ? { errno: e.errno } : {}),
      ...(fromDatabase ? {} : { message: String(e.message || "").slice(0, 300) }),
    };
  };
  const cause = err && typeof err === "object" && err.cause ? { cause: brief(err.cause) } : {};
  return JSON.stringify({ path: pathname || null, ...brief(err), ...cause });
}
