// Next 路由处理器的通用助手：会话校验 / 响应形状与 v1 完全一致。
// v1 约定：错误统一 { error: string }，能说清是哪一类的再带 code（登录未过为 { error, code: "UNAUTHORIZED" }）。
import { NextResponse } from "next/server";
import { errorCodeOf, errorText } from "./error-copy.js";
import { errorLogLine } from "./log.js";
import { getRuntime } from "./runtime.js";
import { isDefaultPasswordRouteAllowed, shouldMarkCookieSecure } from "./auth.js";

function trustsProxyHeaders() {
  return ["1", "true"].includes(String(process.env.TRUST_PROXY || "").toLowerCase());
}

export function requestIsSecure(request) {
  return shouldMarkCookieSecure({
    protocol: request.nextUrl?.protocol,
    forwardedProto: request.headers.get("x-forwarded-proto"),
    trustProxy: trustsProxyHeaders(),
  });
}

export function json(data, status = 200) {
  return NextResponse.json(data, { status });
}

export function cookieToken(request) {
  const raw = request.headers.get("cookie") || "";
  for (const part of raw.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === "rm_session") return rest.join("=");
  }
  return null;
}

export function clientIp(request) {
  if (!trustsProxyHeaders()) return "local";
  const fwd = request.headers.get("x-forwarded-for");
  return (fwd ? fwd.split(",")[0].trim() : "") || "local";
}

// 路由外壳，withAuth、withRuntime 共用：拿运行时、要登录时校验会话、兜住没捕获的异常。
// 初始化失败按「系统还没准备好」给码；没捕获的异常留原文和它带的码，界面按码归类（lib/error-copy.js §8.2），原文只进「查看详细原因」
function wrap(handler, { auth }) {
  return async (request, ctx) => {
    let rt;
    const pathname = () => request.nextUrl?.pathname || new URL(request.url).pathname;
    try {
      rt = await getRuntime();
    } catch (err) {
      // 原文只进日志：未登录的请求也会走到这里，数据库报错可能带出用户名、主机
      console.error("初始化失败:", errorLogLine(err, pathname()));
      return json({ error: errorText({ code: "NOT_READY" }), code: "NOT_READY" }, 503);
    }
    let payload;
    if (auth) {
      payload = rt.sessions.verify(cookieToken(request));
      if (!payload) return json({ error: "未登录", code: "UNAUTHORIZED" }, 401);
      if (payload.v !== rt.sessions.sessionVersion(rt.store.auth)) {
        return json({ error: "登录状态已失效，请重新登录", code: "SESSION_EXPIRED" }, 401);
      }
      if (rt.store.auth.isDefault && !isDefaultPasswordRouteAllowed(pathname())) {
        return json({
          error: "请先修改初始密码后再使用控制台",
          code: "DEFAULT_PASSWORD_CHANGE_REQUIRED",
        }, 403);
      }
    }
    try {
      const params = ctx?.params ? await ctx.params : {};
      return await (auth ? handler(request, rt, params, payload) : handler(request, rt, params));
    } catch (err) {
      console.error("API 错误:", errorLogLine(err, pathname()));
      // 码和别处一样由 errorCodeOf 给（lib/error-copy.js）；认不出是哪一类的不带
      const code = errorCodeOf(err);
      return json({ error: String(err?.message || err || ""), ...(code ? { code } : {}) }, 500);
    }
  };
}

/**
 * 包装需要登录的路由处理器：handler(request, rt, params, payload)
 * - 未登录 → 401 { error: "未登录", code: "UNAUTHORIZED" }（与 v1 一致）
 * - 未捕获异常 → 500 { error: message, code? }
 */
export function withAuth(handler) {
  return wrap(handler, { auth: true });
}

// 不要求登录（登录接口本身、/api/meta）但仍注入运行时
export function withRuntime(handler) {
  return wrap(handler, { auth: false });
}
