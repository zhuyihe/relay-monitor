"use client";
// 炬元控制台登录页：桌面双区建立品牌信任，移动端收敛为单列表单。
// 登录失败时在表单顶部说明原因并标红字段，不只弹 toast。
import "../styles/pages/login.css";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { App, Button, Form, Input } from "antd";
import type { InputRef } from "antd";
import { CheckOutlined, LockOutlined, UserOutlined } from "@ant-design/icons";
import { api } from "../../lib/client";
import { BRAND } from "../../lib/brand";
import BrandMark from "../components/brand-mark";
import { Sym } from "../components/icons";

type LoginError = { title: string; hint: string; fields: boolean };

// 把接口错误翻成"发生了什么 + 怎么办"。只有账号密码不对时才标红字段，
// 限流或网络问题与输入无关，标红会误导用户去改输入
function describeError(e: any): LoginError {
  const msg = String(e?.message || "");
  if (e instanceof TypeError) return { title: "无法连接到服务器", hint: "请检查网络连接后重试。", fields: false };
  if (msg.includes("用户名或密码")) return { title: msg, hint: "请检查用户名和密码后重新输入。", fields: true };
  if (msg.includes("尝试次数过多")) return { title: msg, hint: "", fields: false };
  return { title: msg || "登录失败", hint: "请稍后重试。", fields: false };
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
      // 与 v1 一致：默认密码登录成功后提示尽快修改
      if (r.isDefaultPassword) message.warning("当前为默认密码，请到「系统设置」中修改");
      router.push(r.isDefaultPassword ? "/settings" : "/");
    } catch (e: any) {
      const next = describeError(e);
      setError(next);
      // 账号密码不对时把焦点放回密码框，方便直接重输
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
          <p className="jy-login-lead">把分散的上游资源和经营信号，汇入一个清晰、可信的管理界面。</p>
          <ul className="jy-login-caps" aria-label="平台能力">
            <li><CheckOutlined aria-hidden="true" />资源状态集中掌握</li>
            <li><CheckOutlined aria-hidden="true" />用量与成本统一核算</li>
            <li><CheckOutlined aria-hidden="true" />风险变化及时告警</li>
          </ul>
        </div>
        <span className="jy-login-brand-foot">精确掌握每一份 API 资源</span>
      </section>

      <section className="jy-login-main">
        <div className="jy-login-card">
          <div className="jy-login-mobile-brand">
            <BrandMark showWordmark size={34} label={BRAND.name} subtitle={BRAND.productDescriptor} />
          </div>
          <div className="jy-login-heading">
            <p className="jy-login-eyebrow">安全访问</p>
            <h1>登录{BRAND.productName}</h1>
            <p>使用管理员账户继续。</p>
          </div>
          {/* 表单顶部的错误说明（role=alert 出现即播报） */}
          {error ? (
            <div className="jy-banner jy-banner--crit jy-login-error" role="alert">
              <Sym kind="crit" />
              <div>
                <b>{error.title}</b>
                {error.hint ? <span>{error.hint}</span> : null}
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
            <Form.Item name="username" label="用户名" validateStatus={fieldStatus} rules={[{ required: true, message: "请输入用户名" }]}>
              <Input prefix={<UserOutlined aria-hidden="true" />} autoComplete="username" autoFocus />
            </Form.Item>
            <Form.Item name="password" label="密码" validateStatus={fieldStatus} rules={[{ required: true, message: "请输入密码" }]}>
              <Input.Password ref={passwordRef} prefix={<LockOutlined aria-hidden="true" />} autoComplete="current-password" />
            </Form.Item>
            <Button className="jy-login-submit" type="primary" htmlType="submit" block loading={loading}>
              登录
            </Button>
          </Form>
          <p className="jy-login-foot">访问即表示你已获得本平台管理员授权。</p>
        </div>
      </section>
    </main>
  );
}
