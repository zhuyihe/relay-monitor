// Next 路由处理器的通用助手：会话校验 / 响应形状与 v1 完全一致。
// v1 约定：错误统一 { error: string }（登录未过为 { error, code: "UNAUTHORIZED" }）。
import { NextResponse } from "next/server";
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

/**
 * 包装需要登录的路由处理器：handler(request, rt, params)
 * - 未登录 → 401 { error: "未登录", code: "UNAUTHORIZED" }（与 v1 一致）
 * - 未捕获异常 → 500 { error: message }（v1 全局错误处理等价物）
 */
export function withAuth(handler) {
  return async (request, ctx) => {
    let rt;
    try {
      rt = await getRuntime();
    } catch (err) {
      return json({ error: `服务初始化失败：${err?.message}` }, 500);
    }
    const payload = rt.sessions.verify(cookieToken(request));
    if (!payload) return json({ error: "未登录", code: "UNAUTHORIZED" }, 401);
    if (payload.v !== rt.sessions.sessionVersion(rt.store.auth)) {
      return json({ error: "登录状态已失效，请重新登录", code: "SESSION_EXPIRED" }, 401);
    }
    const pathname = request.nextUrl?.pathname || new URL(request.url).pathname;
    if (rt.store.auth.isDefault && !isDefaultPasswordRouteAllowed(pathname)) {
      return json({
        error: "请先修改初始密码后再使用控制台",
        code: "DEFAULT_PASSWORD_CHANGE_REQUIRED",
      }, 403);
    }
    try {
      const params = ctx?.params ? await ctx.params : {};
      return await handler(request, rt, params, payload);
    } catch (err) {
      console.error("API 错误:", err);
      return json({ error: err?.message || "服务器错误" }, 500);
    }
  };
}

// 不要求登录（登录接口本身、/api/meta）但仍注入运行时
export function withRuntime(handler) {
  return async (request, ctx) => {
    let rt;
    try {
      rt = await getRuntime();
    } catch (err) {
      return json({ error: `服务初始化失败：${err?.message}` }, 500);
    }
    try {
      const params = ctx?.params ? await ctx.params : {};
      return await handler(request, rt, params);
    } catch (err) {
      console.error("API 错误:", err);
      return json({ error: err?.message || "服务器错误" }, 500);
    }
  };
}
