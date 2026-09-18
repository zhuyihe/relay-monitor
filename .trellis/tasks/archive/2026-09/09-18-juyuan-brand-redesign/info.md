# 技术实施方案

## 总体策略

采用“保留技术栈、替换产品层”的方式实施。Ant Design 继续承担控件、表单、弹层和无障碍基础，
ProLayout 可以保留为响应式壳能力，但通过品牌组件、主题令牌和布局配置彻底改写默认外观。

实施分五个可独立审查的批次。每一批完成后运行构建和相关测试，不能等到最后一次性验证。

## 批次 0：清理前置任务

目标：建立干净基线。

- 验收并提交 `.trellis/tasks/09-18-mobile-responsive` 对应的 11 个前端文件。
- 将 `package-lock.json`、`.codegraph/`、`AGENTS.md` 等不属于该任务的改动继续排除在提交之外。
- 记录移动端关键截图或验证结果，供品牌改造后回归对比。

验证：工作树中能清楚区分移动端提交与本任务规划文件。

## 批次 1：品牌基础

预计新增或修改：

- `lib/brand.js`：前后端共享品牌文案常量；避免通知、日报和 UI 各写一套名称。
- `app/components/brand-mark.tsx`：单色 SVG 标识和 wordmark 组合。
- `app/providers.tsx`：浅色/深色 Ant Design 主题令牌和组件覆盖。
- `app/globals.css`：CSS 语义变量、排版、数字、焦点、表面和状态基础样式。
- `app/layout.tsx`：metadata 标题模板、描述、图标和 viewport。
- `public/manifest.webmanifest`、`public/icons/*`、`public/sw.js`：PWA 品牌统一。

注意：共享组件只为至少两个调用点创建；不建立庞大的自研设计系统。

验证：品牌 token 清单、logo/favicon 多尺寸预览、浅色/深色基础控件页。

## 批次 2：应用外壳与登录

预计修改：

- `app/(dashboard)/layout.tsx`
- `app/login/page.tsx`
- `app/globals.css`
- 必要时新增轻量的品牌头部或应用状态组件

实现要点：

- 保留 ProLayout 的路由与移动抽屉能力，重写 logo、侧栏、菜单选中态、顶栏动作和页脚。
- 页面标题由当前路由映射生成；URL 不变。
- 主题切换、刷新和退出收敛到清晰的动作层级。
- 登录页不再使用居中 Card，保持现有 API、错误处理和默认密码登录后提醒。

验证：未登录、登录失败、登录成功、桌面收起侧栏、移动抽屉、深浅主题持久化。

## 批次 3：三个核心界面

预计修改：

- `app/(dashboard)/page.tsx`
- `app/(dashboard)/stations/page.tsx`
- `app/(dashboard)/trend-modal.tsx`
- `app/globals.css`
- 仅在复用成立时新增指标、状态点或空状态组件

实现顺序：

1. 运营总览重新组织主指标、健康摘要、趋势图和资源摘要。
2. 上游资源桌面列表降噪；移动卡片只做品牌迁移和可读性修正，不推翻已完成的响应式结构。
3. 趋势弹层统一指标、颜色、加载和空状态。

验证：数据加载、无数据、接口错误、部分站点失败、固定成本站、长名称、大金额和危险状态。

## 批次 4：外围品牌与全局状态

预计修改：

- `app/api/notifications/test/route.js`
- `lib/notify.js`
- `server/report.js`
- `lib/runtime.js`
- `app/(dashboard)/settings/page.tsx`
- 新增 `app/not-found.tsx`、`app/error.tsx`、必要的 `loading.tsx`

实现要点：

- 所有用户可见消息从共享品牌常量读取。
- 版本和 commit 进入“系统信息”，不出现在全局页脚。
- 统一加载、空、错误、无权限状态；错误信息保留可操作的重试或返回路径。
- 不修改协议字段、Webhook 数据结构和事件名，避免破坏已有集成。

验证：发送测试通知、生成日报预览、检查邮件 HTML、离线 PWA 壳、404 与运行时错误页。

## 批次 5：其余页面迁移与回归

预计修改：

- `app/(dashboard)/my/page.tsx`
- `app/(dashboard)/usage/page.tsx`
- `app/(dashboard)/analytics/page.tsx`
- `app/(dashboard)/notifications/page.tsx`
- `app/(dashboard)/settings/page.tsx`

首发只进行命名、令牌、排版、状态组件和明显模板结构清理。复杂数据布局保留到第二阶段，
防止品牌任务演变成全站业务重写。

验证：页面筛选、表格横向滚动、图表 tooltip、弹窗表单、通知渠道配置、深浅主题和移动端布局。

## 设计资产确认门

进入批次 1 实现前先提供一张品牌基础预览，至少包含：

- 标识在 16、32、64px 的表现
- 侧栏品牌区
- 浅色与深色颜色样片
- 登录页桌面/移动构图
- 总览主指标区

该预览只确认视觉语言，不重新讨论业务范围。确认后再落代码，减少大面积返工。

## 测试矩阵

自动验证：

- `git diff --check`
- `npm test`
- `npm run build`
- 全仓检索旧品牌字符串和未迁移的硬编码品牌色

人工/浏览器验证：

- 视口：375×812、390×844、768×1024、991×900、1280×800、1440×900
- 主题：浅色、深色、跟随系统
- 状态：正常、加载、空、局部错误、全局错误、未登录、无权限
- 交互：键盘导航、焦点环、移动抽屉、主题切换、刷新、退出、弹层和表单
- PWA：安装名称、图标、主题色、横竖屏和平板横屏

## 提交边界

建议按上述批次形成 4–5 个独立提交，禁止将移动端任务、品牌基础、核心页面和外围消息压成一个巨型提交。
每个提交都应能够构建，并且不包含 `.codegraph/`、个人配置或其他无法识别的工作区改动。

