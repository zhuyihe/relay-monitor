# 炬元控制台改版 · 实施计划

> 依据：`design/ui-audit.md`（问题清单）、`design/ui-design-spec.md`（规范）、`design/mockups/`（高保真稿）。
> 本文档是 `feat/ui-redesign` 这个 PR 的施工图：做什么、怎么做、按什么顺序提交、怎么验收，以及明确不做什么。

## 0. 目标与边界

**目标**：把真实的 Next.js 应用还原成高保真稿的样子，并满足规范中的交互、可访问性和响应式要求。改版只动展示层，所有接口和计算口径保持不变。

**包含**

| 范围 | 内容 |
|---|---|
| 地基 | 设计令牌单一来源；IBM Plex Sans；字号/间距/圆角/阴影尺度；深浅色首帧正确 |
| 外壳 | 自研 AppShell 替换 ProLayout：分组导航、折叠、移动端抽屉、56px 顶栏（页标题、数据截至、刷新、主题、账户） |
| 组件 | 时间范围、利润等式条、需要处理、余量跑道、状态标记、金额、面板、数据状态、横向条形、趋势面板、热力图、预测图、分段控件、标签页 |
| 页面 | 运营总览、自营业务、上游资源、成本与利润、告警中心、系统设置、用量分析、登录 |
| 修复 | 审计 V1–V6（密钥明文回显、未配置当错误、部分数据标红、对比度不足、主题闪烁、刷新闪骨架） |

**不包含（另开 PR）**

- 渠道对账页正文。`fix/reconciliation-review-followups` 仍在改这个文件，本 PR 只让它继承新外壳和令牌：隐藏它自带的重复标题，导航名改为"渠道对账"。页面文件一行不改。
- 余额阈值从美元改为人民币。涉及存量数据换算和告警判断口径，需要单独迁移。本 PR 只在界面上同时显示美元和折合人民币。
- 凭证明文存库。这是已知安全问题，不属于 UI 改版。

## 1. 现状与约束

- Next.js 16 App Router、React 19、antd 6（默认开启 CSS 变量）、pro-components 3、@ant-design/plots。
- 页面都是客户端组件，各自轮询接口，没有全局数据层。
- 以下文件的 API 形状和计算逻辑本 PR 不改：`/api/stations`、`/api/meta`、`/api/analytics`、`/api/own/analytics`、`/api/usage`、`/api/history/*`、`/api/notifications/*`、`/api/settings`、`/api/auth/*`。
- 以下文件本 PR 不改：`lib/providers.js`、`lib/providers.test.js`、`lib/reconciliation-contract.js`、`server/reconciliation*.js`、`app/(dashboard)/reconciliation/page.tsx`。
- Docker 构建阶段可能没有外网，所以字体不能依赖 `next/font/google`。

## 2. 技术方案

### 2.1 设计令牌：`lib/design-tokens.js`

唯一来源，导出三部分：

```js
export const palette = { light: {...}, dark: {...} };   // ink / ink-2 / ink-3 / ink-dis / cobalt / plane / sheet / sunken / rule / rule-soft / sider / 状态色 / 图表色 / seq 1–6
export const scale   = { font: {...}, space: [...], radius: {...}, shadow, breakpoints, contentMax: 1440, siderW: 232, siderCollapsedW: 64 };
export function cssVariables(theme)   // 生成 { "--jy-ink": "#152033", ... }
export function antdTheme(theme)      // 生成 ConfigProvider 的 theme（token + components）
```

- 根布局在 `<head>` 里用 `<style>` 输出 `:root{…}` 和 `[data-theme="dark"]{…}` 两组 `--jy-*` 变量，由 `cssVariables()` 生成，不再手写。
- antd 需要真实色值来推导衍生色，不能直接吃 CSS 变量，所以 `antdTheme(theme)` 用同一份 hex 值。
- 深色主按钮：背景 `#7F9CFF`，文字 `#0B1020`（`components.Button.primaryColor`），保证对比度。
- 图表颜色（槽 1 收入、槽 2 用量成本、槽 3 固定成本、亏损色、seq 色阶）也从这里取，SVG 图表里用 `var(--jy-s1)` 等引用。

### 2.2 主题首帧

- 主题选择写入 cookie `jy-theme`（light / dark），localStorage 中旧的 `app-shell-theme` 读到后迁移一次。
- 根布局在服务端读取 cookie，把结果写到 `<html data-theme>`，同时传给 Providers 作为初值，antd 首帧也按正确主题渲染。
- 没有 cookie 时（跟随系统），`<head>` 里的内联脚本在首次绘制前按 `prefers-color-scheme` 设置 `data-theme`，Providers 挂载后再同步给 antd。
- 修复审计 V5：深色用户刷新时先闪白。

### 2.3 字体

- IBM Plex Sans 400、500、600 的 latin 子集 woff2 放在 `app/fonts/`，附 OFL 许可说明，通过 `next/font/local` 加载，变量为 `--jy-font-plex`。
- 字体栈：`var(--jy-font-plex), "PingFang SC", "HarmonyOS Sans SC", "Microsoft YaHei", "Noto Sans CJK SC", system-ui, sans-serif`。中文走系统字体。
- 金额、表格、坐标轴一律 `font-variant-numeric: tabular-nums`。

### 2.4 样式组织

- 新增 `app/styles/jy.css`：由高保真稿的 `app.css` 迁移而来，类名统一加 `jy-` 前缀，避免与 antd 和旧样式冲突；变量统一改为 `--jy-*`。
- 组件级别的 antd 覆盖（Table 表头、Drawer、Segmented、Input 等）集中写在 `jy.css` 末尾的"antd 适配"一节，不散落在页面里。
- `app/globals.css`：页面重写完成后，删掉只被旧页面使用的类（`overview-*`、`station-row*`、`resource-list*`、`login-*` 等）。`reconciliation-*` 和对账页仍在用的通用类全部保留。每删一个类前先 `grep` 确认没有引用。

### 2.5 外壳：`app/(dashboard)/layout.tsx` 重写为 AppShell

```
┌──────────┬────────────────────────────────────────────────────┐
│ 炬元      │ ☰  页面标题         [时间范围]   · 数据截至 14:32  ⟳ ◐ 账户 │  ← 56px 顶栏，吸顶
│          ├────────────────────────────────────────────────────┤
│ 监控      │                                                    │
│  运营总览 3│   内容区：最大宽度 1440，24px 内边距（移动端 16）    │
│  上游资源  │                                                    │
│  用量分析  │                                                    │
│ 经营      │                                                    │
│  自营业务  │                                                    │
│  成本与利润│                                                    │
│  渠道对账  │                                                    │
│ 系统      │                                                    │
│  告警中心  │                                                    │
│  系统设置  │                                                    │
│ v2.2.0   │                                                    │
└──────────┴────────────────────────────────────────────────────┘
```

- 导航配置放在 `lib/nav.js`：分组、路由、标签、图标 key，是唯一来源。顶栏标题、`document.title`、面包屑都从这里取。
- 菜单项用 Next `<Link>`，可以用中键在新标签打开，也有预取；当前页加 `aria-current="page"`。
- 运营总览的计数徽标：外壳每 60 秒拉一次 `/api/stations`，用 `buildOverviewActions().all.length` 计算，和总览页"需要处理"的条数一致。
- 侧栏宽度 232，可折叠到 64，状态存 localStorage `jy-sider`；≤991px 自动收窄；≤767px 变为抽屉，由顶栏菜单按钮打开，Esc 关闭，焦点回到按钮。
- `ShellContext` 提供给页面注册：
  - `useShellPage({ onRefresh, asOf, range })`：刷新按钮调用页面注册的 `onRefresh`（原来 POST `/api/refresh` 的逻辑移到各页）；`asOf` 显示为"数据截至 HH:MM"；`range` 是一个 ReactNode，渲染在顶栏标题右侧，移动端落到内容区顶部。
  - 刷新期间内容区降到 0.6 不透明度，图标旋转，不闪骨架（审计 V6）。
- 保留原有行为：默认密码强制跳转 `/settings`、退出登录、PWA SW 注册。
- 旧的 `PageContainer` 标题由外壳 CSS 隐藏（只对渠道对账页生效，其他页面不再使用 PageContainer）。

### 2.6 组件清单：`app/components/`

| 组件 | 文件 | 要点 |
|---|---|---|
| `Panel` | `panel.tsx` | 扁平面板 + 细线；`title`、`caption`、`badge`、`extra`、`sub`、`foot`；`body={false}` 时内容贴边 |
| `Seg` | `seg.tsx` | 分段控件，`aria-pressed`，可带计数；标签页 `Tabs` 另有 `role="tab"`，支持方向键切换 |
| `RangePicker` | `range-picker.tsx` | 预设（今天 / 近 7 天 / 近 30 天 / 近 90 天）+ 可选"自定义"日期弹层；点选即生效；下方显示解析后的窗口（如"9 月 18 日至今天 14:32"）；值同步到 URL `?range=` |
| `Money` / `formatMoney` | `money.tsx`，`lib/format.js` | 真减号 `−`；估算加 `≈ `；千分位；不用科学计数法；可选 `dp`、`sign`；纯函数带单测 |
| `StatusMark` / `StatusTag` | `status.tsx` | good 实心圆、warn 三角、crit 菱形、info 圆内 i、unknown 空心圆；图形 + 文字 + 颜色三重编码 |
| `ProfitEquation` | `profit-equation.tsx` | 收入 − 用量成本 − 固定成本 = 毛利；各项可链接；结果项为钴蓝底；部分数据时显示斜纹 + `≈`，不标红；亏损时显示 crit 图标和"亏损"；"每 ¥100 收入中"去向条；移动端改为账单式纵向排列 |
| `AttentionList` | `attention-list.tsx` | 图标 + 对象 + 问题 + 说明 + 主次操作；按 crit → warn → info 排序 |
| `Runway` | `runway.tsx` | 0–14 天刻度；阈值竖线取自 `rules.etaDays` 和 7 天；平时用 ink-3，只在 warn/crit 时着色；查询失败显示虚线空框和"无法计算" |
| `HBars` | `hbars.tsx` | HTML 横向条形；最长条占 76%；有悬停提示；未知值显示斜纹 |
| `TrendPanel` | `trend-panel.tsx` | 上图为收入、用量成本、固定成本折线（单轴），下图为逐日毛利柱（共用 x 轴）；当天用虚线；缺数日用斜纹带；十字准线 + 提示；键盘 ←/→/Home/End/Esc；可切换为表格视图（带"合计 N 天"行） |
| `ForecastChart` | `forecast-chart.tsx` | 过去 24 小时实线 + 未来 24 小时预测带（opacity .14）+ 中位线 +"明天"竖线 |
| `Heatmap` | `heatmap.tsx` | 7×24 单色相 seq 色阶；图例；峰值说明 |
| `DataState` | `data-state.tsx` | 骨架（首次加载）、空态、错误（带重试）、未配置引导（Onboarding）；局部失败只影响所在面板 |
| `Icon` | `icons.tsx` | 高保真稿中的线性图标（导航、刷新、主题、编辑、更多、恢复、排序等）+ 状态符号 |

图表不再依赖 G2 的默认样式。总览、自营、成本与利润的图表用上面的自研 SVG 组件，保证和稿子一致；用量分析和余额趋势弹窗继续用 `@ant-design/plots`，但主题改从令牌取，并禁用双轴和逐点标签。

### 2.7 URL 状态：`app/components/use-url-state.ts`

`useUrlState(key, default, allowed)` 读写 `?range=`、`?tab=`、`?filter=` 等参数，写入时用 `router.replace`、`scroll: false`，刷新页面和分享链接都能还原当前视图。

## 3. 页面方案

### 3.1 运营总览 `/`

| 区块 | 数据来源 | 说明 |
|---|---|---|
| 时间范围（顶栏） | URL `?range=today\|7d\|30d` | 只提供三个预设 |
| 利润等式 | `/api/own/analytics?range=` 的 `profit`：收入 = `incomeCny`；用量成本 = `costs` 中 mode≠fixed 的合计；固定成本 = mode=fixed 的合计；毛利 = `profitCny` | `estimated` 或 `!complete` 时为部分数据（加 `≈` 和斜纹，列出 `warnings`）。没有配置自营站时收入显示"未设置"并提供引导链接，成本退回 `/api/analytics?days=` 的合计 |
| 需要处理 | `/api/stations` + `/api/meta` → `buildOverviewActions` | query-failed 为 crit，balance-danger 为 crit，balance-low / eta-soon / fixed-expiring 为 warn；操作为"立即同步"、"编辑"、"查看趋势"；为空时显示"一切正常" |
| 上游余量 | `/api/stations`（非自营、未归档）的 `prediction.etaDays` | 按天数升序；阈值竖线取自 `rules.etaDays` 和 7；面板副标题为"可用余额合计 ¥X，不含 N 个查询失败的上游" |
| 期内收入 | `profit` / `byUser` 前 5 | 真实系统只有一个自营站，"按自营站点"只会有一根条，所以改为"按下游用户" |
| 期内用量成本 | `profit.costs`（mode≠fixed）按上游 | 没有自营站时用 `/api/analytics` 的 `stations[].totalCny` |

删除：重复的上游资源列表、KPI 卡阵列、总余额趋势大图（移到"上游资源 → 余额趋势"弹窗）。保留：单站刷新、趋势弹窗入口。

### 3.2 自营业务 `/my`

- 页面结构：顶栏范围（今天 / 近 7 天 / 近 30 天）+ 标签页 `?tab=overview|users|models`。
- **概览**
  - 利润等式。
  - 趋势面板：逐日收入、用量成本、固定成本和毛利。每日收入按 `trend` 占比摊分，与成本与利润页口径相同。每日成本来自 `/api/analytics`。
  - 未来 24 小时预测（`hourly`）。
  - 消费最多的用户（HBars）。
  - 管理员转售 Key 与成本明细折叠在"利润口径"面板里。
- **用户**
  - 可搜索、可排序的用户表：用户、请求数、Token、消费、占比、¥/M、环比、最近使用。
  - 用户余额表。
  - 用户 × 分组。
- **模型与渠道**
  - 模型条形 + 模型明细表。
  - 分组表与渠道表（带环比）。
  - 未关联渠道提示。
  - 日志精算（折叠，按需加载）。
- 未配置自营站（接口返回 400 "还没有标记…"）：显示三步引导，不当错误处理（审计 V2）。

### 3.3 上游资源 `/stations`

- 工具栏：
  - 搜索。
  - 状态分段（全部 / 需处理 / 正常 / 已归档，带计数），同步到 URL `?filter=`。
  - 类型下拉。
  - "同步全部"。
  - 主按钮"新增上游资源"。
- 表格列：资源（名称链接 + 类型 + 主机）｜状态｜余额（美元站显示 `$` 并在下方附折合人民币）｜日均消耗｜可用天数（迷你跑道）｜最近同步｜操作（编辑、更多：刷新 / 余额趋势 / 归档 / 删除）。
  - 行本身不可点击，名称是链接，操作列常驻显示。
- 移动端改为列表卡片。
- 编辑改用右侧抽屉（520px，移动端全宽），分三组字段：
  1. **基本信息**：名称、类型、接口地址、自营站开关、计入利润开关。
  2. **连接凭证**：密钥用 `Input.Password`，设置 `autoComplete="new-password"`，占位"已保存"，帮助文案"留空则继续使用已保存的令牌"，输入后改为"保存后替换原来的令牌"（审计 V1）。只有连接字段改动后才要求重新测试，测试结果内联显示。
  3. **成本与阈值**：汇率、低余额阈值、不再续费、固定成本付费记录。
- 底栏显示"有未保存的修改"。关闭时如有修改，二次确认。
- 已归档行可以"恢复"。

### 3.4 成本与利润 `/analytics`

- 范围：近 7 / 30 / 90 天 + 自定义（接口 `days` 1–365），同步到 URL。
- 利润等式：30 天以内有收入；超过 30 天时收入显示"不适用"并附说明，保持现有口径。
- 趋势面板：收入、用量成本、固定成本三条线加逐日毛利柱。缺数日用斜纹，不补零。
- 成本构成：按上游的 HBars。
- 消耗时段：热力图，只在 30 天以内提供，其余情况说明原因。
- 余额跑道：复用 Runway 组件。
- 覆盖说明：提示历史不足或数据缺失的日期。
- "包含已归档"开关保留。

### 3.5 告警中心 `/notifications`

分为"告警规则"和"通知渠道"两块：
- 规则关闭时，条件和渠道控件整体禁用。
- 阈值用 InputNumber 加单位。
- 渠道为空时列出可选渠道类型，并提供"添加渠道"。
- 测试发送的结果内联显示。
- 渠道密钥字段改为 Password（审计 V1）。

### 3.6 系统设置 `/settings`

- 分为刷新与数据、告警阈值、历史数据留存、账户安全、关于五组。
- 每组有自己的"保存修改"，未保存时组标题旁显示"未保存"。
- 密码表单三项都用 Password，字段级报错。
- 默认密码时顶部显示警示。

### 3.7 用量分析 `/usage`

- 保留现有范围（今天 / 24 小时 / 7 天 / 30 天）和按模型的视图。
- 新增"按上游"分组：各上游的 token 用量堆叠柱，最多 8 个，其余合并为"其他"，颜色按上游固定，不随排名变化。
- 出错时保留筛选栏，只在内容区显示原因和"重试"。

### 3.8 登录 `/login`

- `<h1>` 标题。
- 错误内联显示在表单上方（`role="alert"`）。
- 密码可切换显示。
- 左侧品牌区使用令牌色，深色模式正确。

## 4. 提交顺序

| # | 提交 | 内容 |
|---|---|---|
| 1 | `docs(design): add UI audit, design spec, mockups and implementation plan` | `design/` 全部文档 |
| 2 | `feat(ui): design tokens, local IBM Plex font and flash-free theme` | `lib/design-tokens.js`、`app/fonts/`、`app/layout.tsx`、`app/providers.tsx`、`app/styles/jy.css` |
| 3 | `feat(ui): grouped app shell with topbar, page refresh and mobile drawer` | `lib/nav.js`、`app/(dashboard)/layout.tsx`、`app/components/shell/*`、`lib/brand.js` |
| 4 | `feat(ui): shared components` | 2.6 节全部组件、`lib/format.js` 及其单测 |
| 5 | `feat(overview): equation-first overview` | 总览页 |
| 6 | `feat(stations): table, filters and drawer editor` | 上游资源页 |
| 7 | `feat(my): tabs, onboarding and profit equation` | 自营业务页 |
| 8 | `feat(analytics): trend panel, cost mix and heatmap` | 成本与利润页 |
| 9 | `feat(ui): notifications, settings, usage and login` | 其余页面 |
| 10 | `chore(ui): remove obsolete styles and components` | 清理 globals.css、last-refreshed、chart-box 等不再使用的文件 |

## 5. 验收清单

**自动**

- `npm test`：新增 `lib/format.test.js`。
- `npx tsc --noEmit`。
- `npx next build`。

**浏览器**：本地 MySQL + 预览数据，登录后逐页检查。

- 视口：1440 / 1024 / 375 三档，深浅两色。
  - 对照 `design/mockups/index.html` 的同名页面。
  - 检查标签是否拥挤、换行是否正常、是否出现横向溢出。
- 键盘：
  - Tab 顺序合理，焦点环可见。
  - 抽屉内焦点循环，Esc 关闭后焦点回到触发按钮。
  - 标签页支持方向键；图表支持 ←/→。
- 状态：
  - 首次加载显示骨架。
  - 刷新时保留旧数据并降低不透明度。
  - 空态、未配置引导、单个面板失败都正确显示。
- 主题：深色模式下刷新页面不闪白，antd 组件首帧颜色正确。
- 对比度：正文文字 ≥ 4.5:1，图形元素 ≥ 3:1（令牌已按此校验）。

## 6. 风险与应对

| 风险 | 应对 |
|---|---|
| 页面重写丢失细节功能 | 每个页面先列出现有功能清单，重写后逐条核对（见各页"保留"） |
| 与对账分支冲突 | 不改对账页文件，`lib/brand.js` 只改导航文案；合并时冲突面仅限 `globals.css` 中非对账的段落 |
| 自研 SVG 图表的可维护性 | 图表只有 3 种（趋势、预测、热力图），数据接口统一为纯数组；坐标计算抽成纯函数 |
| cookie 读取使路由变为动态渲染 | 所有页面本来就是需要登录的动态页面，影响可以忽略 |
