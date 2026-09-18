"use client";
// 炬元控制台登录页：桌面双区建立品牌信任，移动端收敛为单列表单。
import { useState } from "react";
import { useRouter } from "next/navigation";
import { App, Button, Form, Input } from "antd";
import { CheckOutlined, LockOutlined, UserOutlined } from "@ant-design/icons";
import { api } from "../../lib/client";
import { BRAND } from "../../lib/brand";
import BrandMark from "../components/brand-mark";

export default function LoginPage() {
  const router = useRouter();
  const { message } = App.useApp();
  const [loading, setLoading] = useState(false);

  const onFinish = async (values: { username: string; password: string }) => {
    setLoading(true);
    try {
      const r = await api("/api/auth/login", {
        body: { username: String(values.username || "").trim(), password: values.password },
      });
      // 与 v1 一致：默认密码登录成功后提示尽快修改
      if (r.isDefaultPassword) message.warning("当前为默认密码，请到「系统设置」中修改");
      router.push(r.isDefaultPassword ? "/settings" : "/");
    } catch (e: any) {
      message.error(e.message || "登录失败");
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="login-screen">
      <section className="login-brand-panel" aria-label={BRAND.productName}>
        <BrandMark inverse showWordmark size={40} label={BRAND.name} subtitle={BRAND.productDescriptor} />
        <div className="login-brand-panel__content">
          <p className="login-eyebrow">{BRAND.positioning}</p>
          <h1>{BRAND.loginTagline}</h1>
          <p>把分散的上游资源和经营信号，汇入一个清晰、可信的管理界面。</p>
          <ul className="login-capabilities" aria-label="平台能力">
            <li><CheckOutlined />资源状态集中掌握</li>
            <li><CheckOutlined />用量与成本统一核算</li>
            <li><CheckOutlined />风险变化及时告警</li>
          </ul>
        </div>
        <span className="login-brand-panel__foot">精确掌握每一份 API 资源</span>
      </section>

      <section className="login-form-panel">
        <div className="login-form-shell">
          <div className="login-mobile-brand">
            <BrandMark showWordmark size={34} label={BRAND.name} subtitle={BRAND.productDescriptor} />
          </div>
          <div className="login-form-heading">
            <p className="login-eyebrow">安全访问</p>
            <h2>登录{BRAND.productName}</h2>
            <p>使用管理员账户继续。</p>
          </div>
          <Form layout="vertical" onFinish={onFinish} requiredMark={false} size="large">
          <Form.Item
            name="username"
            label="用户名"
            rules={[{ required: true, message: "请输入用户名" }]}
          >
            <Input prefix={<UserOutlined />} autoComplete="username" autoFocus />
          </Form.Item>
          <Form.Item name="password" label="密码" rules={[{ required: true, message: "请输入密码" }]}>
            <Input.Password prefix={<LockOutlined />} autoComplete="current-password" />
          </Form.Item>
          <Button className="login-submit" type="primary" htmlType="submit" block loading={loading}>
            登录
          </Button>
        </Form>
          <p className="login-form-foot">访问即表示你已获得本平台管理员授权。</p>
        </div>
      </section>
    </main>
  );
}
