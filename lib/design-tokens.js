// 炬元控制台设计令牌：颜色、字号、间距、圆角的唯一来源。
// CSS 变量（--jy-*）、antd 主题和图表配色都由这里生成，页面里不再手写色值。
// 数值与 design/ui-design-spec.md §3 一一对应；图表色已用 dataviz 校验脚本验证过。

const light = {
  plane: "#F4F6F8",
  sheet: "#FFFFFF",
  sunken: "#EEF1F5",
  rule: "#DFE4EA",
  "rule-soft": "#E9EDF2",
  ink: "#152033",
  "ink-2": "#475467",
  "ink-3": "#667085",
  "ink-dis": "#98A2B3",
  cobalt: "#3157D5",
  "cobalt-hover": "#2748B8",
  "cobalt-tint": "#EBF0FD",
  "on-cobalt": "#FFFFFF",
  sider: "#131B2C",
  "sider-edge": "transparent",
  "sider-ink": "#C5CCD8",
  "sider-ink-3": "#8B95A6",
  "sider-active": "rgba(127, 156, 255, .16)",
  good: "#137A63", "good-ink": "#0F6B56", "good-tint": "#E6F3EE",
  warn: "#A86400", "warn-ink": "#915500", "warn-tint": "#FFF4E0",
  crit: "#C83C3C", "crit-ink": "#B42F2F", "crit-tint": "#FDECEC",
  info: "#3157D5",
  "muted-tint": "#EEF1F5",
  // 图表：颜色跟随度量——槽 1 收入、槽 2 用量成本、槽 3 固定成本，其余按固定顺序分给实体
  s1: "#3157D5", s2: "#EB6834", s3: "#1BAF7A", s4: "#EDA100",
  s5: "#E87BA4", s6: "#008300", s7: "#8A3FB8", s8: "#E34948",
  loss: "#D0493B",
  "seq-1": "#E4EAFB", "seq-2": "#9DB2F0", "seq-3": "#6F8CE6", "seq-4": "#3F66DA", "seq-5": "#2A4DB8", "seq-6": "#1D3886",
  shadow: "0 8px 24px rgba(21, 32, 51, .12)",
  scrim: "rgba(15, 20, 27, .36)",
};

const dark = {
  plane: "#0F141B",
  sheet: "#151C25",
  sunken: "#1B2430",
  rule: "#283343",
  "rule-soft": "#212B38",
  ink: "#EEF2F7",
  "ink-2": "#B7C0CD",
  "ink-3": "#8A96A7",
  "ink-dis": "#5D6979",
  cobalt: "#7F9CFF",
  "cobalt-hover": "#9AB1FF",
  "cobalt-tint": "rgba(127, 156, 255, .14)",
  "on-cobalt": "#0B1020",
  sider: "#0B1017",
  "sider-edge": "#232D3B",
  "sider-ink": "#C5CCD8",
  "sider-ink-3": "#8B95A6",
  "sider-active": "rgba(127, 156, 255, .16)",
  good: "#55C7A6", "good-ink": "#55C7A6", "good-tint": "rgba(85, 199, 166, .14)",
  warn: "#E4AD62", "warn-ink": "#E4AD62", "warn-tint": "rgba(228, 173, 98, .14)",
  crit: "#FF7B7B", "crit-ink": "#FF7B7B", "crit-tint": "rgba(255, 123, 123, .14)",
  info: "#7F9CFF",
  "muted-tint": "rgba(138, 150, 167, .14)",
  s1: "#6481EC", s2: "#D95926", s3: "#199E70", s4: "#C98500",
  s5: "#D55181", s6: "#008300", s7: "#9085E9", s8: "#E66767",
  loss: "#E66767",
  "seq-1": "#1E2940", "seq-2": "#25397A", "seq-3": "#2E4DAE", "seq-4": "#4A6BE0", "seq-5": "#7F9CFF", "seq-6": "#B7C8FF",
  shadow: "0 8px 24px rgba(0, 0, 0, .45)",
  scrim: "rgba(0, 0, 0, .5)",
};

export const palette = Object.freeze({ light: Object.freeze(light), dark: Object.freeze(dark) });

export const FONT_STACK = '"PingFang SC", "HarmonyOS Sans SC", "Microsoft YaHei", "Noto Sans CJK SC", system-ui, sans-serif';

export const scale = Object.freeze({
  // [字号, 行高, 字重]
  font: Object.freeze({
    caption: [12, 18, 400],
    body: [14, 22, 400],
    strong: [16, 24, 600],
    title: [20, 28, 600],
    figure: [24, 32, 500],
    hero: [32, 40, 600],
  }),
  space: Object.freeze([4, 8, 12, 16, 24, 32, 48]),
  radius: Object.freeze({ r1: 4, r2: 8, r3: 12 }),
  breakpoints: Object.freeze({ sm: 576, md: 768, lg: 992, xl: 1200, xxl: 1600 }),
  contentMax: 1440,
  siderW: 232,
  siderCollapsedW: 64,
  topbarH: 56,
});

// 实体配色的固定顺序（颜色跟随实体、不随排名变化；第 9 个起合并为“其他”）
export const SERIES_KEYS = Object.freeze(["s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8"]);

export function cssVariables(mode = "light") {
  const p = mode === "dark" ? dark : light;
  const vars = {};
  for (const [k, v] of Object.entries(p)) vars[`--jy-${k}`] = v;
  if (mode !== "dark") {
    vars["--jy-r1"] = `${scale.radius.r1}px`;
    vars["--jy-r2"] = `${scale.radius.r2}px`;
    vars["--jy-r3"] = `${scale.radius.r3}px`;
    vars["--jy-sider-w"] = `${scale.siderW}px`;
    vars["--jy-topbar-h"] = `${scale.topbarH}px`;
    vars["--jy-content-max"] = `${scale.contentMax}px`;
  }
  return vars;
}

const block = (selector, vars) => `${selector}{${Object.entries(vars).map(([k, v]) => `${k}:${v}`).join(";")}}`;

// 根布局注入的完整样式文本：浅色挂在 :root，深色挂在 [data-theme="dark"]
export function themeStyleText() {
  return [
    block(":root", { "color-scheme": "light", ...cssVariables("light") }),
    block('[data-theme="dark"]', { "color-scheme": "dark", ...cssVariables("dark") }),
  ].join("\n");
}

// antd 主题：需要真实色值推导衍生色，所以不能直接用 CSS 变量
export function antdThemeConfig(mode = "light") {
  const p = mode === "dark" ? dark : light;
  const isDark = mode === "dark";
  const token = {
    colorPrimary: p.cobalt,
    colorInfo: p.cobalt,
    colorLink: p.cobalt,
    colorSuccess: p.good,
    colorWarning: p.warn,
    colorError: p.crit,
    colorBgBase: isDark ? p.plane : "#FFFFFF",
    colorBgLayout: p.plane,
    colorBgContainer: p.sheet,
    colorBgElevated: isDark ? p.sunken : p.sheet,
    colorText: p.ink,
    colorTextSecondary: p["ink-2"],
    colorTextTertiary: p["ink-3"],
    colorTextQuaternary: p["ink-dis"],
    colorTextPlaceholder: p["ink-3"],
    colorTextDisabled: p["ink-dis"],
    colorBorder: p.rule,
    colorBorderSecondary: p["rule-soft"],
    colorFillAlter: p.sunken,
    colorSplit: p["rule-soft"],
    fontFamily: `var(--jy-font-plex), ${FONT_STACK}`,
    fontSize: 14,
    lineHeight: 22 / 14,
    borderRadius: scale.radius.r2,
    borderRadiusSM: scale.radius.r1,
    borderRadiusLG: scale.radius.r3,
    controlHeight: 36,
    controlHeightLG: 40,
    controlHeightSM: 28,
    boxShadow: p.shadow,
    boxShadowSecondary: p.shadow,
    motionDurationMid: "0.15s",
  };
  const components = {
    Button: {
      primaryShadow: "none",
      defaultShadow: "none",
      dangerShadow: "none",
      primaryColor: p["on-cobalt"],
      fontWeight: 500,
    },
    Input: { activeShadow: `0 0 0 2px ${p["cobalt-tint"]}`, activeBorderColor: p.cobalt, hoverBorderColor: p["ink-3"] },
    InputNumber: { activeShadow: `0 0 0 2px ${p["cobalt-tint"]}`, activeBorderColor: p.cobalt, hoverBorderColor: p["ink-3"] },
    Select: { activeOutlineColor: p["cobalt-tint"], optionSelectedBg: p["cobalt-tint"] },
    Table: {
      headerBg: p.sunken,
      headerColor: p["ink-2"],
      headerSplitColor: "transparent",
      borderColor: p["rule-soft"],
      rowHoverBg: isDark ? "#18202A" : "#F6F8FA",
      cellPaddingBlock: 12,
      cellPaddingInline: 16,
      headerBorderRadius: scale.radius.r2,
      fontWeightStrong: 500,
    },
    Tag: { defaultBg: p.sunken, defaultColor: p["ink-2"] },
    Modal: { contentBg: p.sheet, headerBg: p.sheet, footerBg: p.sheet },
    Drawer: { colorBgElevated: p.sheet },
    Segmented: {
      trackBg: p.sunken,
      itemSelectedBg: p.sheet,
      itemColor: p["ink-2"],
      itemHoverColor: p.ink,
      itemSelectedColor: p.ink,
    },
    Tabs: { itemColor: p["ink-2"], itemSelectedColor: p.ink, inkBarColor: p.cobalt, itemHoverColor: p.ink },
    Switch: { colorPrimary: p.cobalt, colorPrimaryHover: p["cobalt-hover"] },
    Alert: { colorInfoBg: p.sunken, colorInfoBorder: p.rule },
    Dropdown: { colorBgElevated: p.sheet },
    Popover: { colorBgElevated: p.sheet },
    Tooltip: { colorBgSpotlight: isDark ? p.sunken : p.ink },
  };
  return { token, components };
}
