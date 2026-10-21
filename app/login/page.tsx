"use client";
// 炬元控制台登录页：桌面双区建立品牌信任，移动端收敛为单列表单。
// 登录失败时在表单顶部说明原因，按接口给的码处理（design/ui-copy-spec.md §8.2）：
// 用户名或密码不对时标红两个输入框，试太多次、连不上时只说原因，不标红，免得误导用户去改输入。
// 只在本页出现的话都在同目录的 copy.ts 里；报错的说法、漏填提示从 lib/error-copy.js 取。
// 这是控制台自己的接口：除了这两个码，报错按 consoleErrorText 说，不按读上游的几类关键词猜
import "../styles/pages/login.css";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { App, Button, Form, Input } from "antd";
import type { InputRef } from "antd";
import { CheckOutlined, LockOutlined, UserOutlined } from "@ant-design/icons";
import { api } from "../../lib/client";
import { BRAND } from "../../lib/brand";
import { CONSOLE_UNREACHABLE, consoleFailureText, describeError, errorText, requiredRule } from "../../lib/error-copy";
import BrandMark from "../components/brand-mark";
import { ErrorDetail, noteOf } from "../components/error-detail";
import { Sym } from "../components/icons";
import { COPY } from "./copy";


// 表单顶部那一句；fields：要不要标红输入框；raw：原文，只进「查看详细原因」
type LoginError = { text: string; fields: boolean; raw?: unknown };

function loginErrorOf(e: any): LoginError {
  if (e instanceof TypeError) return { text: CONSOLE_UNREACHABLE, fields: false };
  const { code } = describeError(e);
  if (code === "LOGIN_FAILED") return { text: errorText(e), fields: true };
  if (code === "LOGIN_RATE_LIMITED") return { text: errorText(e), fields: false };
  return { text: consoleFailureText(COPY.failed, e), fields: false, raw: noteOf(e).raw };
}

export default function LoginPage() {
  const router = useRouter();
  const { message } = App.useApp();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<LoginError | null>(null);
  const passwordRef = useRef<InputRef>(null);

  const onFinish = async (values: { username: string; password: string }) => {
    setLoading(true);
    setError(null);
    try {
      const r = await api("/api/auth/login", {
        body: { username: String(values.username || "").trim(), password: values.password },
      });
      // 与 v1 一致：默认密码登录成功后先去系统设置改密码
      if (r.isDefaultPassword) message.warning(errorText({ code: "DEFAULT_PASSWORD_CHANGE_REQUIRED" }));
      router.push(r.isDefaultPassword ? "/settings" : "/");
    } catch (e: any) {
      const next = loginErrorOf(e);
      setError(next);
      // 用户名或密码不对时把焦点放回密码框，方便直接重输
      if (next.fields) passwordRef.current?.focus({ cursor: "all" });
    } finally {
      setLoading(false);
    }
  };

  const fieldStatus = error?.fields ? ("error" as const) : undefined;

  return (
    <main className="jy-login">
      <section className="jy-login-brand" aria-label={BRAND.productName}>
        <BrandMark inverse showWordmark size={40} label={BRAND.name} subtitle={BRAND.productDescriptor} />
        <div className="jy-login-brand-body">
          <p className="jy-login-eyebrow">{BRAND.positioning}</p>
          <p className="jy-login-tagline">{BRAND.loginTagline}</p>
          <p className="jy-login-lead">{COPY.lead}</p>
          <ul className="jy-login-caps" aria-label={COPY.capsLabel}>
            {COPY.caps.map((text) => (
              <li key={text}>
                <CheckOutlined aria-hidden="true" />
                {text}
              </li>
            ))}
          </ul>
        </div>
        <span className="jy-login-brand-foot">{COPY.foot}</span>
      </section>

      <section className="jy-login-main">
        <div className="jy-login-card">
          <div className="jy-login-mobile-brand">
            <BrandMark showWordmark size={34} label={BRAND.name} subtitle={BRAND.productDescriptor} />
          </div>
          <div className="jy-login-heading">
            <h1>{COPY.title}</h1>
            <p>{COPY.subtitle}</p>
          </div>
          {/* 表单顶部的错误说明（role=alert 出现即播报） */}
          {error ? (
            <div className="jy-banner jy-banner--crit jy-login-error" role="alert">
              <Sym kind="crit" />
              <div className="jy-banner__body">
                <b>{error.text}</b>
                <ErrorDetail raw={error.raw} />
              </div>
            </div>
          ) : null}
          <Form
            layout="vertical"
            onFinish={onFinish}
            // 用户开始修改输入即视为已看到错误，收起提示和红框
            onValuesChange={() => error && setError(null)}
            requiredMark={false}
            size="large"
          >
            <Form.Item name="username" label={COPY.username} validateStatus={fieldStatus} rules={[requiredRule(COPY.username)]}>
              <Input prefix={<UserOutlined aria-hidden="true" />} autoComplete="username" autoFocus />
            </Form.Item>
            <Form.Item name="password" label={COPY.password} validateStatus={fieldStatus} rules={[requiredRule(COPY.password)]}>
              <Input.Password ref={passwordRef} prefix={<LockOutlined aria-hidden="true" />} autoComplete="current-password" />
            </Form.Item>
            <Button className="jy-login-submit" type="primary" htmlType="submit" block loading={loading}>
              {COPY.submit}
            </Button>
          </Form>
          <p className="jy-login-foot">{COPY.notice}</p>
        </div>
      </section>
    </main>
  );
}
