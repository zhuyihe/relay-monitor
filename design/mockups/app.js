/* 炬元控制台 改版高保真稿：交互与演示数据
   只用于评审。实现时组件拆分见 design/ui-design-spec.md §4。 */
(() => {
  'use strict';

  /* ─── 工具 ─────────────────────────────────────────── */
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const MINUS = '−';
  const nf2 = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const nf1 = new Intl.NumberFormat('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const nf0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
  const round2 = (v) => Math.round(v * 100) / 100;
  // 按比例拆分总数，最后一项取余数，保证分项之和与方程里的总数一致
  const splitTotal = (total, parts) => {
    let left = round2(total);
    return parts.map(([name, s], i) => {
      const value = i === parts.length - 1 ? round2(left) : round2(total * s);
      left -= value;
      return { name, value };
    });
  };
  // 各上游占用量成本的比例；自营业务的渠道和成本构成共用，两处数字才能对上
  const COST_SHARE = [0.38, 0.262, 0.19, 0.115, 0.053];
  const sum = (arr) => arr.reduce((a, b) => a + b, 0);
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  function mulberry32(a) {
    return () => {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // 金额：墨色、真减号、≈ 前缀、两位小数
  function cny(v, { approx = false, dp = 2, sign = false } = {}) {
    if (v == null || Number.isNaN(v)) return '—';
    const body = '¥' + (dp === 0 ? nf0 : nf2).format(Math.abs(v));
    return (approx ? '≈ ' : '') + (v < 0 ? MINUS : sign && v > 0 ? '+' : '') + body;
  }
  const usd = (v) => '$' + nf2.format(v);
  function axisMoney(v) {
    const a = Math.abs(v);
    const s = a >= 1000 ? (a / 1000).toFixed(a >= 10000 ? 0 : 1).replace(/\.0$/, '') + 'k' : nf0.format(a);
    return (v < 0 ? MINUS : '') + '¥' + s;
  }
  const pct = (v, dp = 1) => (v * 100).toFixed(dp) + '%';
  const wan = (v) => (v >= 1e4 ? nf0.format(v / 1e4) + ' 万' : nf0.format(v));

  const icon = (id, cls = 'icon') => `<svg class="ic ${cls}" aria-hidden="true"><use href="#i-${id}"/></svg>`;
  const LEVEL = {
    crit: { icon: 'crit', label: '紧急' },
    warn: { icon: 'warn', label: '注意' },
    good: { icon: 'good', label: '正常' },
    muted: { icon: 'unknown', label: '未知' },
  };
  const statusTag = (level, text) => `<span class="tag tag--${level}">${icon(LEVEL[level].icon, '')}${text || LEVEL[level].label}</span>`;
  const statusText = (level, text) => `<span class="status status--${level}">${icon(LEVEL[level].icon, '')}${text || LEVEL[level].label}</span>`;

  /* ─── 演示时间与数据 ───────────────────────────────── */
  const TODAY = new Date(2026, 8, 24); // 周四
  let asOf = { h: 14, m: 32 };
  const hhmm = ({ h, m }) => `${h}:${String(m).padStart(2, '0')}`;
  const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
  const md = (d) => `${d.getMonth() + 1}月${d.getDate()}日`;
  const isoDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

  const FIXED_PER_DAY = 40;
  const THRESH = { crit: 3, warn: 7, max: 14 };

  // 90 天日序列，最后一天是今天（截至 14:32）
  const N = 90;
  const SERIES = (() => {
    const rng = mulberry32(20260924);
    const out = [];
    for (let i = 0; i < N; i++) {
      const date = addDays(TODAY, i - (N - 1));
      const dow = date.getDay();
      const weekly = dow === 0 || dow === 6 ? 0.8 : 1;
      const trend = 0.85 + 0.3 * (i / (N - 1));
      let rev = 1780 * weekly * trend * (1 + (rng() - 0.5) * 0.16);
      let ratio = 0.665 + (rng() - 0.5) * 0.06;
      if (i === 68) ratio = 1.03;   // 9月3日：上游涨价未同步调价，当天亏损
      if (i === 41) ratio = 1.012;
      let cost = rev * ratio;
      if (i === N - 1) { rev = 1248.60; cost = 830.21; }
      out.push({ i, date, rev: round2(rev), cost: round2(cost), fixed: FIXED_PER_DAY, today: i === N - 1 });
    }
    return out;
  })();
  const MISSING = new Set([77, 78, 79]); // 9月12日至14日：上游用量记录缺失
  const DEEPSEEK_TODAY = 158.30;

  const STATIONS = [
    { id: 'yunqiao', name: '云桥 API', host: 'api.yunqiao.cc', type: 'NewAPI', balance: 30.20, burn: 72.00, synced: '14:31', today: 46.60, uid: '2031' },
    { id: 'xinghe', name: '星河中转', host: 'api.xinghe-relay.com', type: 'NewAPI', balance: 726.80, burn: 158.00, synced: '14:31', today: 92.16, uid: '1024' },
    { id: 'deepseek', name: '深度求索', host: 'api.deepseek.com', type: '官方 API', balance: 2262.00, burn: 260.00, synced: '14:30', today: DEEPSEEK_TODAY },
    { id: 'openrouter', name: 'OpenRouter', host: 'openrouter.ai', type: 'OpenRouter', balanceUsd: 1141.10, balance: 8215.92, burn: 520.00, synced: '14:31', today: 318.40 },
    { id: 'siliconflow', name: '硅基流动', host: 'api.siliconflow.cn', type: '官方 API', balance: 7200.00, burn: 360.00, synced: '14:30', today: 214.75 },
    { id: 'oldb', name: '旧线路 B', host: 'b.oldrelay.net', type: 'OneAPI', balance: 0, burn: 0, synced: '8月30日', archived: true },
  ];
  const SITES_TODAY = [
    { name: '炬元主站', value: 862.40 },
    { name: '企业专线', value: 301.20 },
    { name: '测试站', value: 85.00 },
  ];

  /* ─── 状态 ─────────────────────────────────────────── */
  const state = {
    theme: 'light',
    data: 'normal',
    route: 'overview',
    range: { overview: '1', my: '30', analytics: '30' },
    custom: {},
    tab: 'overview',
    stFilter: 'all',
    stQuery: '',
    stType: '',
    views: {},
  };

  function stationView(s) {
    const failed = state.data === 'partial' && s.id === 'deepseek';
    const days = s.burn > 0 ? s.balance / s.burn : null;
    let level = 'good';
    if (s.archived) level = 'muted';
    else if (failed) level = 'crit';
    else if (days != null && days < THRESH.crit) level = 'crit';
    else if (days != null && days < THRESH.warn) level = 'warn';
    return { ...s, failed, days: failed ? null : days, level };
  }
  const activeStations = () => STATIONS.filter((s) => !s.archived).map(stationView);
  const LEVEL_ORDER = { crit: 0, warn: 1, good: 2, muted: 3 };
  const byUrgency = (a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level]
    || (a.failed - b.failed) || ((a.days ?? 0) - (b.days ?? 0));
  const fmtDays = (d) => (d == null ? '无法计算' : d < 1 ? `约 ${Math.round(d * 24)} 小时` : `${nf1.format(d)} 天`);

  function attentionItems() {
    const items = [];
    const st = Object.fromEntries(activeStations().map((s) => [s.id, s]));
    items.push({
      level: 'crit', who: '云桥 API', what: `余额${fmtDays(st.yunqiao.days)}后用完`,
      desc: `余额 ${cny(st.yunqiao.balance)}，近 7 天日均消耗 ${cny(st.yunqiao.burn)}。`,
      primary: '去充值', secondary: '查看资源',
    });
    if (st.deepseek.failed) {
      items.push({
        level: 'crit', who: '深度求索', what: '余额查询失败',
        desc: '13:58 起接口返回 HTTP 401，访问令牌可能已失效。今日用量成本暂不含该上游。',
        primary: '更新凭证', secondary: '查看日志',
      });
    }
    items.push({
      level: 'warn', who: '星河中转', what: `余额可用 ${fmtDays(st.xinghe.days)}`,
      desc: `余额 ${cny(st.xinghe.balance)}，已低于 7 天提醒线。`,
      primary: '去充值', secondary: '查看资源',
    });
    items.push({
      level: 'warn', who: '阿里云服务器', what: '3 天后到期',
      desc: '9 月 27 日到期，月费 ¥600.00。续费后更新到期日，或标记为不再续费。',
      primary: '标记已续费', secondary: '不再续费',
    });
    return items;
  }

  // 取时间窗：预设为最近 n 天（含今天）；自定义为起止索引
  function rangeIdx(page) {
    const r = state.range[page];
    if (r === 'custom' && state.custom[page]) return state.custom[page];
    const n = Number(r);
    return { start: N - n, end: N - 1 };
  }
  function windowRows(page) {
    const { start, end } = rangeIdx(page);
    return SERIES.slice(start, end + 1).map((d) => {
      const r = { ...d };
      if (state.data === 'partial') {
        if (MISSING.has(d.i)) { r.cost = null; r.missing = true; }
        if (d.today) { r.cost = round2(d.cost - DEEPSEEK_TODAY); r.partialCost = true; }
      }
      if (state.data === 'unconfigured') r.rev = null;
      r.profit = r.rev == null || r.cost == null ? null : round2(r.rev - r.cost - r.fixed);
      return r;
    });
  }
  function totals(rows) {
    const unconf = state.data === 'unconfigured';
    const rev = unconf ? null : round2(sum(rows.map((r) => r.rev)));
    const cost = round2(sum(rows.map((r) => r.cost || 0)));
    const fixed = round2(sum(rows.map((r) => r.fixed)));
    const reasons = [];
    const miss = rows.filter((r) => r.missing);
    if (miss.length) reasons.push(`${md(miss[0].date)}至${md(miss[miss.length - 1].date)}上游用量记录缺失，这 ${miss.length} 天的用量成本未计入。`);
    if (rows.some((r) => r.partialCost)) reasons.push('深度求索 13:58 起余额查询失败，今日该上游的消耗未计入。');
    return { rev, cost, fixed, profit: rev == null ? null : round2(rev - cost - fixed), reasons };
  }
  function windowCaption(page) {
    const { start, end } = rangeIdx(page);
    const n = end - start + 1;
    const from = SERIES[start].date;
    if (n === 1 && end === N - 1) return `今日 00:00 至 ${hhmm(asOf)}`;
    if (end !== N - 1) return `${md(from)} 至 ${md(SERIES[end].date)}，共 ${n} 天`;
    return `${md(from)} 00:00 至 ${md(TODAY)} ${hhmm(asOf)}，共 ${n} 天`;
  }
  function rangeLabel(page) {
    const r = state.range[page];
    if (r === 'custom') { const { start, end } = rangeIdx(page); return `${end - start + 1} 天`; }
    return r === '1' ? '今日' : `近 ${r} 天`;
  }

  /* ─── 利润等式条 ───────────────────────────────────── */
  function moneyHero(v, approx) {
    return `${approx ? '<span class="approx">≈</span>' : ''}${v < 0 ? MINUS : ''}<span class="unit">¥</span>${nf2.format(Math.abs(v))}`;
  }
  function eqTerm({ label, color, value, approx, partial, note, href, op, empty = '—', result }) {
    const tag = href ? 'a' : 'div';
    const cls = ['eq-term', partial ? 'is-partial' : '', result ? 'eq-result' : ''].filter(Boolean).join(' ');
    const v = value == null ? `<span class="eq-empty">${empty}</span>` : moneyHero(value, approx);
    return `<${tag} class="${cls}"${href ? ` href="${href}"` : ''}${op ? ` data-op="${op}"` : ''}>
      <span class="eq-label">${color ? `<i class="swatch" style="background:${color}"></i>` : ''}${label}</span>
      <span class="eq-value num">${v}</span>
      ${partial ? '<span class="partial-strip hatch" aria-hidden="true"></span>' : ''}
      <span class="eq-note">${note || ''}</span>
    </${tag}>`;
  }
  const eqOp = (ch, spoken) => `<span class="eq-op"><span aria-hidden="true">${ch}</span><span class="sr-only">${spoken}</span></span>`;

  function renderEquation(el, { title, page, notes = {}, links = {} }) {
    const rows = windowRows(page);
    const t = totals(rows);
    const unconf = state.data === 'unconfigured';
    const partial = t.reasons.length > 0;
    const loss = t.profit != null && t.profit < 0;
    const margin = t.rev ? t.profit / t.rev : null;
    let resultNote = '';
    if (unconf) resultNote = '设置自营站点后计算';
    else if (loss) resultNote = statusText('crit', '亏损');
    else resultNote = `毛利率 ${partial ? '≈ ' : ''}${pct(margin)}`;

    let below = '';
    if (unconf) {
      below = `<div class="partial-note">${icon('info')}<span>还没有设置自营站点，所以收入和毛利暂时无法计算；用量成本和固定成本照常统计。<a href="#my">设置自营站点</a></span></div>`;
    } else {
      if (!loss) {
        const per = (v) => nf2.format((v / t.rev) * 100);
        const a = partial ? '≈ ' : '';
        below += `<div class="flow" aria-label="每 100 元收入的去向">
          <div class="flow-bar" aria-hidden="true">
            <span style="flex:${t.cost};background:var(--s2)"></span>
            <span style="flex:${t.fixed};background:var(--s3)"></span>
            <span style="flex:${t.profit};background:var(--s1)"></span>
          </div>
          <div class="flow-legend">
            <span>每 ¥100 收入中</span>
            <span><i class="swatch" style="background:var(--s2)"></i>用量成本 <b class="num">${a}¥${per(t.cost)}</b></span>
            <span><i class="swatch" style="background:var(--s3)"></i>固定成本 <b class="num">¥${per(t.fixed)}</b></span>
            <span><i class="swatch" style="background:var(--s1)"></i>留作毛利 <b class="num">${a}¥${per(t.profit)}</b></span>
          </div>
        </div>`;
      }
      if (partial) {
        below += `<div class="partial-note">${icon('info')}<span>数据不完整，带 ≈ 的数字是按已有数据算出的。${t.reasons.join('')}实际毛利会比这里低。</span></div>`;
      }
    }

    el.innerHTML = `
      <div class="eq-head"><h2>${title}</h2><span class="caption">${windowCaption(page)}</span></div>
      <div class="eq-row">
        ${eqTerm({ label: '收入', color: 'var(--s1)', value: t.rev, empty: '未设置', note: unconf ? '没有自营站点' : notes.rev, href: links.rev })}
        ${eqOp(MINUS, '减')}
        ${eqTerm({ label: '用量成本', color: 'var(--s2)', value: t.cost, approx: partial, partial, note: partial ? '部分数据缺失' : notes.cost, href: links.cost, op: MINUS })}
        ${eqOp(MINUS, '减')}
        ${eqTerm({ label: '固定成本', color: 'var(--s3)', value: t.fixed, note: notes.fixed, href: links.fixed, op: MINUS })}
        ${eqOp('=', '等于')}
        ${eqTerm({ label: '毛利', value: t.profit, approx: partial, note: resultNote, result: true, op: '=' })}
      </div>
      ${below}`;
  }

  /* ─── 浮动提示 ─────────────────────────────────────── */
  const floatTip = $('#floatTip');
  function showFloat(html, x, y) {
    floatTip.innerHTML = html;
    floatTip.classList.add('is-on');
    const w = floatTip.offsetWidth, h = floatTip.offsetHeight;
    let left = x + 14, top = y + 14;
    if (left + w > innerWidth - 8) left = x - w - 14;
    if (top + h > innerHeight - 8) top = y - h - 14;
    floatTip.style.left = left + 'px';
    floatTip.style.top = top + 'px';
  }
  const hideFloat = () => floatTip.classList.remove('is-on');
  function bindFloat(root) {
    $$('[data-tip]', root).forEach((node) => {
      const html = () => node.getAttribute('data-tip');
      node.addEventListener('pointermove', (e) => showFloat(html(), e.clientX, e.clientY));
      node.addEventListener('pointerleave', hideFloat);
      node.addEventListener('focus', () => { const r = node.getBoundingClientRect(); showFloat(html(), r.left + r.width / 2, r.bottom - 6); });
      node.addEventListener('blur', hideFloat);
    });
  }
  const tipHTML = (title, rows) => `<div class="t-title">${title}</div>${rows.map(([k, v, c]) => `<div class="t-row">${c ? `<i class="swatch" style="background:${c}"></i>` : ''}<span>${k}</span><b>${v}</b></div>`).join('')}`;

  /* ─── 横向条形（HTML） ─────────────────────────────── */
  function hbars(host, items, { color, fmt = (v) => cny(v), unitName = '' } = {}) {
    const known = items.filter((d) => d.value != null);
    const max = Math.max(...known.map((d) => d.value));
    const total = sum(known.map((d) => d.value));
    host.innerHTML = `<ul class="hbars">${items.map((d) => {
      if (d.value == null) {
        return `<li><span class="name">${d.name}</span><span class="bar-wrap"><span class="bar bar--unknown hatch"></span><span class="val val--muted">${d.note || '无数据'}</span></span></li>`;
      }
      const tip = tipHTML(d.name, [[unitName || '金额', fmt(d.value)], ['占比', pct(d.value / total)]]);
      return `<li tabindex="0" data-tip='${tip}'><span class="name">${d.name}</span><span class="bar-wrap"><span class="bar" style="width:${(d.value / max) * 76}%;background:${color}"></span><span class="val num">${fmt(d.value)}</span></span></li>`;
    }).join('')}</ul>`;
    bindFloat(host);
  }

  /* ─── SVG 图表 ────────────────────────────────────── */
  function niceStep(raw) {
    const p = Math.pow(10, Math.floor(Math.log10(raw)));
    const f = raw / p;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
  }
  function niceTicks(min, max, count) {
    if (max === min) max = min + 1;
    const step = niceStep((max - min) / count);
    const lo = Math.floor(min / step) * step;
    const hi = Math.ceil(max / step) * step;
    const ticks = [];
    for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Math.round(v * 100) / 100);
    return { ticks, lo, hi };
  }
  let uid = 0;
  const hatchDef = (id) => `<pattern id="${id}" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="2" height="6" style="fill:var(--ink-dis);opacity:.45"/></pattern>`;
  function barPath(x, top, bottom, w, r, roundTop) {
    const h = bottom - top;
    r = Math.max(0, Math.min(r, w / 2, h));
    if (roundTop) return `M${x},${bottom}V${top + r}A${r},${r} 0 0 1 ${x + r},${top}H${x + w - r}A${r},${r} 0 0 1 ${x + w},${top + r}V${bottom}Z`;
    return `M${x},${top}V${bottom - r}A${r},${r} 0 0 0 ${x + r},${bottom}H${x + w - r}A${r},${r} 0 0 0 ${x + w},${bottom - r}V${top}Z`;
  }
  function linePath(vals, x, y, from, to) {
    let d = '', pen = false;
    for (let i = from; i <= to; i++) {
      const v = vals[i];
      if (v == null) { pen = false; continue; }
      d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
      pen = true;
    }
    return d;
  }
  function xTickIdx(rows, plotW) {
    const n = rows.length;
    const maxTicks = Math.max(2, Math.floor(plotW / 76));
    let step = Math.ceil(n / maxTicks);
    if (n > 14) step = Math.ceil(step / 7) * 7;
    const idx = [];
    for (let i = n - 1; i >= 0; i -= step) idx.push(i);
    return idx;
  }
  const dayLabel = (r) => (r.today ? '今天' : md(r.date));

  // 收入与用量成本（同一纵轴）+ 每日毛利（共用横轴），一个面板
  function trendPanel(host, page) {
    const rows = windowRows(page);
    const showRev = state.data !== 'unconfigured';
    const key = host.id;
    const view = state.views[key] || 'chart';
    const hasMissing = rows.some((r) => r.missing);
    const hasToday = rows.some((r) => r.today);
    const tt = totals(rows);
    const approxTotal = tt.reasons.length > 0;

    host.innerHTML = `
      <div class="panel-head">
        <h2>${showRev ? '收入与用量成本' : '用量成本'}</h2>
        <span class="caption">按天，同一纵轴</span>
        <span class="spacer"></span>
        <div class="seg seg--sm" role="group" aria-label="显示方式">
          <button type="button" data-view="chart" aria-pressed="${view === 'chart'}">图表</button>
          <button type="button" data-view="table" aria-pressed="${view === 'table'}">表格</button>
        </div>
      </div>
      <div class="panel-body">
        <div class="chart-view" ${view === 'chart' ? '' : 'hidden'}>
          <div class="legend">
            ${showRev ? '<span><i class="line-key" style="background:var(--s1)"></i>收入</span>' : ''}
            <span><i class="line-key" style="background:var(--s2)"></i>用量成本</span>
            ${hasToday ? '<span><i class="line-key line-key--dash"></i>今天（未满一天）</span>' : ''}
            ${hasMissing ? '<span><i class="swatch hatch-swatch"></i>数据缺失</span>' : ''}
            <span class="legend-note">固定成本每天 ¥40.00，只计入毛利</span>
          </div>
          <div class="chart-stack" tabindex="0" role="img" aria-label="${showRev ? '每日收入与用量成本折线图，以及每日毛利柱状图' : '每日用量成本折线图'}，可用左右方向键逐日查看">
            <div class="chart chart-line"></div>
            ${showRev ? `<div class="chart-sub"><h3>每日毛利</h3><div class="legend">
              <span><i class="swatch" style="background:var(--s1)"></i>盈利</span>
              <span><i class="swatch" style="background:var(--loss)"></i>亏损</span>
            </div></div>
            <div class="chart chart-bars"></div>` : ''}
            <div class="tip"></div>
          </div>
        </div>
        <div class="table-view" ${view === 'table' ? '' : 'hidden'}>
          <div class="table-scroll"><table class="data data--compact">
            <thead><tr><th>日期</th>${showRev ? '<th class="r">收入</th>' : ''}<th class="r">用量成本</th><th class="r">固定成本</th>${showRev ? '<th class="r">毛利</th>' : ''}</tr></thead>
            <tbody>${rows.slice().reverse().map((r) => `<tr>
              <td>${md(r.date)} ${WEEK[r.date.getDay()]}${r.today ? `，截至 ${hhmm(asOf)}` : ''}</td>
              ${showRev ? `<td class="r">${cny(r.rev)}</td>` : ''}
              <td class="r">${r.cost == null ? '<span class="muted">数据缺失</span>' : cny(r.cost, { approx: r.partialCost })}</td>
              <td class="r">${cny(r.fixed)}</td>
              ${showRev ? `<td class="r">${r.profit == null ? '<span class="muted">无法计算</span>' : cny(r.profit, { approx: r.partialCost })}</td>` : ''}
            </tr>`).join('')}</tbody>
            <tfoot><tr>
              <th scope="row">合计 ${rows.length} 天</th>
              ${showRev ? `<td class="r">${cny(tt.rev)}</td>` : ''}
              <td class="r">${cny(tt.cost, { approx: approxTotal })}</td>
              <td class="r">${cny(tt.fixed)}</td>
              ${showRev ? `<td class="r">${cny(tt.profit, { approx: approxTotal })}</td>` : ''}
            </tr></tfoot>
          </table></div>
        </div>
      </div>`;

    $$('[data-view]', host).forEach((b) => b.addEventListener('click', () => {
      state.views[key] = b.dataset.view;
      trendPanel(host, page);
    }));
    if (view !== 'chart') return;

    const stack = $('.chart-stack', host);
    const lineHost = $('.chart-line', host);
    const barHost = $('.chart-bars', host);
    const tip = $('.tip', stack);
    const T = 12;
    let L = 52, R = 72;
    let hover = null;
    let geo = null;

    function draw() {
      const w = lineHost.clientWidth;
      if (!w) return;
      // 窄屏收紧左右留白，给绘图区让出宽度；右侧仍够放“用量成本”末端标签
      L = w < 480 ? 46 : 52;
      R = w < 480 ? 60 : 72;
      const n = rows.length;
      const pw = w - L - R;
      const step = pw / n;
      const cx = (i) => L + step * (i + 0.5);
      const id = 'h' + (++uid);

      // 上图
      const HL = 208, BL = showRev ? 8 : 28;
      const vals = rows.flatMap((r) => [showRev ? r.rev : null, r.cost]).filter((v) => v != null);
      const yt = niceTicks(0, Math.max(...vals), 4);
      const y = (v) => T + (1 - (v - yt.lo) / (yt.hi - yt.lo)) * (HL - T - BL);
      const bands = [];
      rows.forEach((r, i) => {
        if (!r.missing) return;
        const last = bands[bands.length - 1];
        if (last && last[1] === i - 1) last[1] = i; else bands.push([i, i]);
      });
      const bandSvg = (h0, h1, withLabel) => bands.map(([a, b]) => {
        const x0 = cx(a) - step / 2, bw = (b - a + 1) * step;
        return `<rect x="${x0}" y="${h0}" width="${bw}" height="${h1 - h0}" fill="url(#${id})"/>` +
          (withLabel && bw >= 44 ? `<text class="tick-label" x="${x0 + bw / 2}" y="${h0 + 14}" text-anchor="middle">缺失</text>` : '');
      }).join('');
      const series = [];
      if (showRev) series.push({ name: '收入', color: 'var(--s1)', vals: rows.map((r) => r.rev) });
      series.push({ name: '用量成本', color: 'var(--s2)', vals: rows.map((r) => r.cost) });
      const lastSolid = hasToday ? n - 2 : n - 1;
      const paths = series.map((s) => {
        let out = `<path class="series" style="stroke:${s.color}" d="${linePath(s.vals, cx, y, 0, lastSolid)}"/>`;
        if (hasToday && n > 1) out += `<path class="series" style="stroke:${s.color}" stroke-dasharray="3 4" d="${linePath(s.vals, cx, y, n - 2, n - 1)}"/>`;
        return out;
      }).join('');
      // 线尾直接标注，靠得太近时上下错开
      const ends = series.map((s) => ({ name: s.name, y: y(s.vals[n - 1] ?? s.vals[n - 2] ?? 0) + 4 })).sort((a, b) => a.y - b.y);
      for (let k = 1; k < ends.length; k++) if (ends[k].y - ends[k - 1].y < 15) ends[k].y = ends[k - 1].y + 15;
      const xIdx = xTickIdx(rows, pw);
      const xLabels = (h) => xIdx.map((i) => `<text class="tick-label" x="${cx(i)}" y="${h - 8}" text-anchor="middle">${dayLabel(rows[i])}</text>`).join('');

      lineHost.innerHTML = `<svg viewBox="0 0 ${w} ${HL}" height="${HL}" aria-hidden="true">
        <defs>${hatchDef(id)}</defs>
        <g class="grid">${yt.ticks.map((t) => `<line x1="${L}" x2="${w - R}" y1="${y(t)}" y2="${y(t)}"/>`).join('')}</g>
        ${yt.ticks.map((t) => `<text class="tick-label" x="${L - 8}" y="${y(t) + 4}" text-anchor="end">${axisMoney(t)}</text>`).join('')}
        ${bandSvg(T, HL - BL, true)}
        ${paths}
        ${ends.map((e) => `<text class="end-label" x="${cx(n - 1) + 10}" y="${e.y}">${e.name}</text>`).join('')}
        ${showRev ? '' : xLabels(HL)}
        <line class="cross" x1="0" x2="0" y1="${T}" y2="${HL - BL}" visibility="hidden"/>
        ${series.map((s, k) => `<circle class="hover-dot" data-k="${k}" r="4.5" style="fill:${s.color}" visibility="hidden"/>`).join('')}
        <rect class="hit" x="${L}" y="0" width="${pw}" height="${HL}" fill="transparent"/>
      </svg>`;

      // 下图：每日毛利
      if (showRev) {
        const HB = 148, BB = 28;
        const pv = rows.map((r) => r.profit).filter((v) => v != null);
        const bt = niceTicks(Math.min(0, ...pv), Math.max(0, ...pv), 3);
        const yb = (v) => T + (1 - (v - bt.lo) / (bt.hi - bt.lo)) * (HB - T - BB);
        const bw = Math.max(1, Math.min(22, step - 2));
        const bars = rows.map((r, i) => {
          if (r.profit == null) return '';
          const x = cx(i) - bw / 2;
          const pos = r.profit >= 0;
          const top = pos ? yb(r.profit) : yb(0);
          const bottom = pos ? yb(0) : yb(r.profit);
          return `<path d="${barPath(x, top, Math.max(bottom, top + 1), bw, 4, pos)}" style="fill:${pos ? 'var(--s1)' : 'var(--loss)'}"${r.today || r.partialCost ? ' fill-opacity=".4"' : ''}/>`;
        }).join('');
        barHost.innerHTML = `<svg viewBox="0 0 ${w} ${HB}" height="${HB}" aria-hidden="true">
          <defs>${hatchDef(id + 'b')}</defs>
          <g class="grid">${bt.ticks.filter((t) => t !== 0).map((t) => `<line x1="${L}" x2="${w - R}" y1="${yb(t)}" y2="${yb(t)}"/>`).join('')}</g>
          ${bt.ticks.map((t) => `<text class="tick-label" x="${L - 8}" y="${yb(t) + 4}" text-anchor="end">${axisMoney(t)}</text>`).join('')}
          ${bands.map(([a, b]) => `<rect x="${cx(a) - step / 2}" y="${T}" width="${(b - a + 1) * step}" height="${HB - T - BB}" fill="url(#${id}b)"/>`).join('')}
          ${bars}
          <line class="zero" x1="${L}" x2="${w - R}" y1="${yb(0)}" y2="${yb(0)}"/>
          ${xLabels(HB)}
          <line class="cross" x1="0" x2="0" y1="${T}" y2="${HB - BB}" visibility="hidden"/>
          <rect class="hit" x="${L}" y="0" width="${pw}" height="${HB}" fill="transparent"/>
        </svg>`;
      }
      geo = { cx, y, step, n, w, series };
      if (hover != null) setHover(hover);
    }

    function setHover(i) {
      hover = i;
      const svgs = $$('svg', stack);
      if (i == null || !geo) {
        svgs.forEach((s) => $$('.cross, .hover-dot', s).forEach((n) => n.setAttribute('visibility', 'hidden')));
        tip.classList.remove('is-on');
        return;
      }
      const r = rows[i];
      const x = geo.cx(i);
      svgs.forEach((s) => { const c = $('.cross', s); c.setAttribute('x1', x); c.setAttribute('x2', x); c.setAttribute('visibility', 'visible'); });
      $$('.hover-dot', lineHost).forEach((dot) => {
        const v = geo.series[dot.dataset.k].vals[i];
        if (v == null) { dot.setAttribute('visibility', 'hidden'); return; }
        dot.setAttribute('cx', x); dot.setAttribute('cy', geo.y(v)); dot.setAttribute('visibility', 'visible');
      });
      const title = `${md(r.date)} ${WEEK[r.date.getDay()]}${r.today ? `，截至 ${hhmm(asOf)}` : ''}`;
      const lines = [];
      if (showRev) lines.push(['收入', cny(r.rev), 'var(--s1)']);
      lines.push(['用量成本', r.cost == null ? '数据缺失' : cny(r.cost, { approx: r.partialCost }), 'var(--s2)']);
      lines.push(['固定成本', cny(r.fixed)]);
      if (showRev) lines.push(['毛利', r.profit == null ? '无法计算' : (r.profit < 0 ? `${statusText('crit', '亏损')} ` : '') + cny(r.profit, { approx: r.partialCost })]);
      tip.innerHTML = tipHTML(title, lines);
      tip.classList.add('is-on');
      const tw = tip.offsetWidth;
      let left = x + 14;
      if (left + tw > geo.w - 4) left = x - tw - 14;
      tip.style.left = left + 'px';
      tip.style.top = '8px';
    }

    stack.addEventListener('pointermove', (e) => {
      if (!geo) return;
      const box = lineHost.getBoundingClientRect();
      const px = e.clientX - box.left;
      if (px < L - 4 || px > geo.w - R + 4) { setHover(null); return; }
      setHover(clamp(Math.floor((px - L) / geo.step), 0, geo.n - 1));
    });
    stack.addEventListener('pointerleave', () => setHover(null));
    stack.addEventListener('keydown', (e) => {
      if (!geo) return;
      const k = e.key;
      if (k === 'ArrowLeft' || k === 'ArrowRight') {
        e.preventDefault();
        const d = k === 'ArrowLeft' ? -1 : 1;
        setHover(hover == null ? geo.n - 1 : clamp(hover + d, 0, geo.n - 1));
      } else if (k === 'Home') { e.preventDefault(); setHover(0); }
      else if (k === 'End') { e.preventDefault(); setHover(geo.n - 1); }
      else if (k === 'Escape') setHover(null);
    });
    stack.addEventListener('blur', () => setHover(null));
    observe(lineHost, draw);
  }

  // 未来 24 小时预测：单系列 + 历史波动范围
  function forecastChart(host) {
    const rng = mulberry32(42);
    const pts = [];
    for (let k = 0; k < 24; k++) {
      const h = (asOf.h + 1 + k) % 24;
      const shape = h < 7 ? 0.25 : h < 10 ? 0.7 : h < 13 ? 1.15 : h < 18 ? 1.25 : h < 23 ? 1.05 : 0.55;
      const mid = 86 * shape * (0.95 + rng() * 0.1);
      pts.push({ h, mid: round2(mid), lo: round2(mid * 0.78), hi: round2(mid * 1.22) });
    }
    const tot = sum(pts.map((p) => p.mid));
    $('#fcSummary').innerHTML = `预计 <b class="num">${cny(tot)}</b>，按历史波动在 <span class="num">${cny(tot * 0.86, { dp: 0 })}</span> 至 <span class="num">${cny(tot * 1.14, { dp: 0 })}</span> 之间。按近 14 天同时段推算。`;
    host.innerHTML = '<div class="chart-stack" tabindex="0" role="img" aria-label="未来 24 小时每小时消费预测，阴影为历史波动范围"><div class="chart"></div><div class="tip"></div></div>';
    const stack = $('.chart-stack', host);
    const c = $('.chart', host);
    const tip = $('.tip', host);
    const L = 44, R = 16, T = 12, B = 28, H = 196;
    let geo = null, hover = null;
    function draw() {
      const w = c.clientWidth;
      if (!w) return;
      const pw = w - L - R, step = pw / 24;
      const cx = (i) => L + step * (i + 0.5);
      const yt = niceTicks(0, Math.max(...pts.map((p) => p.hi)), 3);
      const y = (v) => T + (1 - v / yt.hi) * (H - T - B);
      const band = `M${pts.map((p, i) => `${cx(i)},${y(p.hi)}`).join('L')}L${pts.slice().reverse().map((p, j) => `${cx(23 - j)},${y(p.lo)}`).join('L')}Z`;
      const line = `M${pts.map((p, i) => `${cx(i)},${y(p.mid)}`).join('L')}`;
      const mid = pts.findIndex((p) => p.h === 0);
      c.innerHTML = `<svg viewBox="0 0 ${w} ${H}" height="${H}" aria-hidden="true">
        <g class="grid">${yt.ticks.map((t) => `<line x1="${L}" x2="${w - R}" y1="${y(t)}" y2="${y(t)}"/>`).join('')}</g>
        ${yt.ticks.map((t) => `<text class="tick-label" x="${L - 8}" y="${y(t) + 4}" text-anchor="end">${axisMoney(t)}</text>`).join('')}
        ${mid > 0 ? `<line class="day-rule" x1="${cx(mid) - step / 2}" x2="${cx(mid) - step / 2}" y1="${T}" y2="${H - B}"/><text class="tick-label" x="${cx(mid) - step / 2 + 6}" y="${T + 12}">明天</text>` : ''}
        <path d="${band}" style="fill:var(--s1);opacity:.14"/>
        <path class="series" style="stroke:var(--s1)" d="${line}"/>
        ${pts.map((p, i) => (p.h % 3 === 0 ? `<text class="tick-label" x="${cx(i)}" y="${H - 8}" text-anchor="middle">${p.h}:00</text>` : '')).join('')}
        <line class="cross" x1="0" x2="0" y1="${T}" y2="${H - B}" visibility="hidden"/>
        <circle class="hover-dot" r="4.5" style="fill:var(--s1)" visibility="hidden"/>
      </svg>`;
      geo = { cx, y, step, w };
      if (hover != null) setHover(hover);
    }
    function setHover(i) {
      hover = i;
      const svg = $('svg', c);
      if (!svg) return;
      const cross = $('.cross', svg), dot = $('.hover-dot', svg);
      if (i == null) { cross.setAttribute('visibility', 'hidden'); dot.setAttribute('visibility', 'hidden'); tip.classList.remove('is-on'); return; }
      const p = pts[i], x = geo.cx(i);
      cross.setAttribute('x1', x); cross.setAttribute('x2', x); cross.setAttribute('visibility', 'visible');
      dot.setAttribute('cx', x); dot.setAttribute('cy', geo.y(p.mid)); dot.setAttribute('visibility', 'visible');
      const midIdx = pts.findIndex((q) => q.h === 0);
      tip.innerHTML = tipHTML(`${midIdx > 0 && i >= midIdx ? '明天 ' : ''}${p.h}:00 至 ${p.h + 1}:00`, [['预计消费', cny(p.mid), 'var(--s1)'], ['历史波动', `${cny(p.lo, { dp: 0 })} 至 ${cny(p.hi, { dp: 0 })}`]]);
      tip.classList.add('is-on');
      const tw = tip.offsetWidth;
      tip.style.left = (x + 14 + tw > geo.w ? x - tw - 14 : x + 14) + 'px';
      tip.style.top = '8px';
    }
    stack.addEventListener('pointermove', (e) => {
      if (!geo) return;
      const px = e.clientX - c.getBoundingClientRect().left;
      setHover(clamp(Math.floor((px - L) / geo.step), 0, 23));
    });
    stack.addEventListener('pointerleave', () => setHover(null));
    stack.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        setHover(hover == null ? 0 : clamp(hover + (e.key === 'ArrowLeft' ? -1 : 1), 0, 23));
      } else if (e.key === 'Escape') setHover(null);
    });
    stack.addEventListener('blur', () => setHover(null));
    observe(c, draw);
  }

  // 星期 × 小时热力图（单色阶）
  function heatmap(host) {
    const rng = mulberry32(7);
    const rowsOrder = [1, 2, 3, 4, 5, 6, 0];
    const base = (h) => (h < 6 ? 0.1 : h < 8 ? 0.3 : h < 10 ? 0.7 : h < 12 ? 1.2 : h < 14 ? 0.95 : h < 18 ? 1.35 : h < 20 ? 0.9 : h < 23 ? 1.1 : 0.5);
    const data = rowsOrder.map((dow) => {
      const weekend = dow === 0 || dow === 6;
      return Array.from({ length: 24 }, (_, h) => {
        const b = base(weekend ? Math.max(0, h - 2) : h) * (weekend ? 0.72 : 1);
        return round2(71 * b * (0.9 + rng() * 0.2));
      });
    });
    const flat = data.flat();
    const max = Math.max(...flat), min = Math.min(...flat);
    const bins = [0.1, 0.28, 0.46, 0.64, 0.82];
    const bin = (v) => { const t = (v - min) / (max - min); let k = 0; while (k < bins.length && t > bins[k]) k++; return k + 1; };
    let peak = { v: 0 };
    data.forEach((row, r) => row.forEach((v, h) => { if (v > peak.v) peak = { v, r, h }; }));
    const dayName = (r) => WEEK[rowsOrder[r]];
    host.innerHTML = `
      <div class="heat" role="img" aria-label="每小时平均用量成本热力图。最高在${dayName(peak.r)} ${peak.h}:00，约 ${cny(peak.v)}；凌晨 1:00 至 6:00 最低。">
        ${data.map((row, r) => `<span class="rlabel">${dayName(r).slice(1)}</span>${row.map((v, h) => `<span class="cell" style="background:var(--seq-${bin(v)})" data-tip='${tipHTML(`${dayName(r)} ${h}:00 至 ${h + 1}:00`, [['平均用量成本', cny(v)]])}'></span>`).join('')}`).join('')}
        <span></span>${Array.from({ length: 24 }, (_, h) => `<span class="clabel">${h % 3 === 0 ? h : ''}</span>`).join('')}
      </div>
      <div class="heat-scale"><span class="num">${cny(min, { dp: 0 })}</span><span class="ramp">${[1, 2, 3, 4, 5, 6].map((k) => `<i style="background:var(--seq-${k})"></i>`).join('')}</span><span class="num">${cny(max, { dp: 0 })}</span><span class="heat-peak">工作日 14:00 至 18:00 最高，周末整体晚 2 小时</span></div>`;
    bindFloat(host);
  }

  // 统一的尺寸监听：宽度变化时重绘
  function observe(node, draw) {
    new ResizeObserver(() => requestAnimationFrame(draw)).observe(node);
  }

  /* ─── 时间范围选择器 ───────────────────────────────── */
  const PRESETS = {
    overview: [['1', '今天'], ['7', '近 7 天'], ['30', '近 30 天']],
    my: [['7', '近 7 天'], ['30', '近 30 天'], ['90', '近 90 天'], ['custom', '自定义']],
    analytics: [['7', '近 7 天'], ['30', '近 30 天'], ['90', '近 90 天'], ['custom', '自定义']],
  };
  function renderRange() {
    const slots = [$('#rangeSlot'), $('#mobileRangeSlot')];
    const presets = PRESETS[state.route];
    if (!presets || (state.route === 'my' && state.data === 'unconfigured')) { slots.forEach((s) => (s.innerHTML = '')); return; }
    const cur = state.range[state.route];
    const customLabel = () => { const { start, end } = rangeIdx(state.route); return `${md(SERIES[start].date)} 至 ${md(SERIES[end].date)}`; };
    const html = `<div class="range-wrap"><div class="seg" role="group" aria-label="时间范围">${presets.map(([v, label]) =>
      `<button type="button" data-range="${v}" aria-pressed="${cur === v}">${v === 'custom' ? icon('calendar') : ''}${v === 'custom' && cur === 'custom' ? customLabel() : label}</button>`).join('')}</div>
      <div class="popover" hidden>
        <div class="two">
          <div class="field"><label>开始日期</label><div class="input"><input type="date" aria-label="开始日期" data-from min="${isoDate(SERIES[0].date)}" max="${isoDate(TODAY)}"></div></div>
          <div class="field"><label>结束日期</label><div class="input"><input type="date" aria-label="结束日期" data-to min="${isoDate(SERIES[0].date)}" max="${isoDate(TODAY)}"></div></div>
        </div>
        <span class="err" hidden></span>
        <div class="popover-foot"><button type="button" class="btn" data-cancel>取消</button><button type="button" class="btn btn--primary" data-apply>应用</button></div>
      </div></div>`;
    slots.forEach((slot) => {
      slot.innerHTML = html;
      const pop = $('.popover', slot);
      $$('[data-range]', slot).forEach((b) => b.addEventListener('click', () => {
        if (b.dataset.range === 'custom') {
          const { start, end } = rangeIdx(state.route);
          $('[data-from]', pop).value = isoDate(SERIES[start].date);
          $('[data-to]', pop).value = isoDate(SERIES[end].date);
          pop.hidden = !pop.hidden;
          if (!pop.hidden) $('[data-from]', pop).focus();
          return;
        }
        state.range[state.route] = b.dataset.range;
        syncHash();
        renderPage();
      }));
      $('[data-cancel]', pop).addEventListener('click', () => (pop.hidden = true));
      $('[data-apply]', pop).addEventListener('click', () => {
        const from = new Date($('[data-from]', pop).value + 'T00:00');
        const to = new Date($('[data-to]', pop).value + 'T00:00');
        const err = $('.err', pop);
        const idx = (d) => Math.round((d - SERIES[0].date) / 864e5);
        const s = idx(from), e = idx(to);
        if (Number.isNaN(s) || Number.isNaN(e) || s > e || s < 0 || e > N - 1) {
          err.hidden = false;
          err.innerHTML = `${icon('crit', '')}请选择 ${md(SERIES[0].date)} 至今天之间的日期，开始不晚于结束。`;
          return;
        }
        state.custom[state.route] = { start: s, end: e };
        state.range[state.route] = 'custom';
        syncHash();
        renderPage();
      });
    });
  }

  /* ─── 页面：运营总览 ───────────────────────────────── */
  function renderOverview() {
    const r = state.range.overview;
    const title = r === '1' ? '今日经营' : r === '7' ? '近 7 天经营' : '近 30 天经营';
    renderEquation($('#ov-eq'), {
      title, page: 'overview',
      notes: { rev: '3 个自营站点，按渠道计费', cost: '5 个上游的余额消耗', fixed: '服务器与域名，按天摊销' },
      links: { rev: '#my', cost: '#stations', fixed: '#stations' },
    });

    const items = attentionItems();
    $('#attCount').textContent = items.length;
    $('#attList').innerHTML = items.map((it) => `<li>
      ${icon(LEVEL[it.level].icon, 'sym status--' + it.level)}
      <div><div><strong>${it.who}</strong> ${it.what}<span class="sr-only">，${LEVEL[it.level].label}</span></div><p>${it.desc}</p></div>
      <div class="actions"><button type="button" class="btn">${it.primary}</button><button type="button" class="btn btn--ghost">${it.secondary}</button></div>
    </li>`).join('');

    const st = activeStations().sort(byUrgency);
    const known = st.filter((s) => !s.failed);
    const failedN = st.length - known.length;
    $('#rwTotal').innerHTML = `可用余额合计 <b class="num">${cny(sum(known.map((s) => s.balance)))}</b>${failedN ? `<span class="caption">，不含 ${failedN} 个查询失败的上游</span>` : ''}`;
    const tick = (d) => `${(d / THRESH.max) * 100}%`;
    $('#runway').innerHTML = `
      <div class="runway-scale" aria-hidden="true"><span></span><div class="axis">
        <span class="axis-zero" style="left:0;transform:none">0</span><span style="left:${tick(THRESH.crit)}">${THRESH.crit} 天</span><span style="left:${tick(THRESH.warn)}">${THRESH.warn} 天</span><span style="left:100%;transform:translateX(-100%)">14 天</span>
      </div><span></span></div>
      <ul class="runway">${st.map((s) => {
        const bal = s.balanceUsd ? usd(s.balanceUsd) : cny(s.balance);
        const fillCls = s.level === 'crit' ? 'is-crit' : s.level === 'warn' ? 'is-warn' : '';
        const w = s.days == null ? 0 : Math.max(1.5, Math.min(s.days, THRESH.max) / THRESH.max * 100);
        const tipRows = s.failed ? [['状态', '查询失败'], ['最近成功', '13:52']]
          : [['余额', s.balanceUsd ? `${bal}，约 ${cny(s.balance, { dp: 0 })}` : bal], ['日均消耗', cny(s.burn)], ['可用', fmtDays(s.days)]];
        return `<li tabindex="0" data-tip='${tipHTML(s.name, tipRows)}'>
          <div class="who"><strong>${s.name}</strong><span class="num">${s.failed ? '余额未知' : bal}</span></div>
          <div class="track${s.failed ? ' is-unknown' : ''}">
            ${s.failed ? '' : `<span class="fill ${fillCls}" style="width:${w}%"></span>`}
            <span class="tick" style="left:${tick(THRESH.crit)}"></span><span class="tick" style="left:${tick(THRESH.warn)}"></span>
          </div>
          <div class="days num">${s.failed ? `<span class="muted">无法计算</span>${statusText('crit', '查询失败')}`
            : `<b>${fmtDays(s.days)}</b>${s.level === 'good' ? '' : statusText(s.level)}`}</div>
        </li>`;
      }).join('')}</ul>`;
    bindFloat($('#runway'));

    // 两个小面板跟随顶栏的时间范围；多天时按期内合计等比例折算演示数据
    const unconf = state.data === 'unconfigured';
    const rows = windowRows('overview');
    const oneDay = rows.length === 1;
    const revK = sum(rows.map((d) => SERIES[d.i].rev)) / 1248.60;
    const costK = sum(rows.map((d) => SERIES[d.i].cost)) / 830.21;
    $('#ov-rev-title').textContent = `${rangeLabel('overview')}收入`;
    $('#ov-cost-title').textContent = `${rangeLabel('overview')}用量成本`;
    if (unconf) {
      $('#ovRev').innerHTML = '<div class="empty-inline"><p>还没有设置自营站点，暂时无法统计收入。</p><a class="btn" href="#my">设置自营站点</a></div>';
    } else {
      hbars($('#ovRev'), SITES_TODAY.map((d) => ({ name: d.name, value: round2(d.value * revK) })), { color: 'var(--s1)', unitName: '收入' });
    }
    const costItems = st.map((s) => ({
      name: s.name,
      value: s.failed && oneDay ? null : round2(s.today * costK),
      note: '查询失败，未计入',
    })).sort((a, b) => (b.value ?? -1) - (a.value ?? -1));
    hbars($('#ovCost'), costItems, { color: 'var(--s2)', unitName: '用量成本' });
  }

  /* ─── 页面：上游资源 ───────────────────────────────── */
  function stationRows() {
    const all = STATIONS.map(stationView);
    const counts = {
      all: all.filter((s) => !s.archived).length,
      attention: all.filter((s) => !s.archived && s.level !== 'good').length,
      ok: all.filter((s) => !s.archived && s.level === 'good').length,
      archived: all.filter((s) => s.archived).length,
    };
    let rows = all.filter((s) => {
      if (state.stFilter === 'archived') return s.archived;
      if (s.archived) return false;
      if (state.stFilter === 'attention') return s.level !== 'good';
      if (state.stFilter === 'ok') return s.level === 'good';
      return true;
    });
    const q = state.stQuery.trim().toLowerCase();
    if (q) rows = rows.filter((s) => (s.name + s.host).toLowerCase().includes(q));
    if (state.stType) rows = rows.filter((s) => s.type === state.stType);
    rows.sort(byUrgency);
    return { rows, counts };
  }
  function renderStations() {
    const { rows, counts } = stationRows();
    const filters = [['all', '全部', counts.all], ['attention', '需处理', counts.attention], ['ok', '正常', counts.ok], ['archived', '已归档', counts.archived]];
    $('#stFilter').innerHTML = filters.map(([v, l, c]) => `<button type="button" data-f="${v}" aria-pressed="${state.stFilter === v}">${l}<span class="count num">${c}</span></button>`).join('');
    $$('#stFilter [data-f]').forEach((b) => b.addEventListener('click', () => { state.stFilter = b.dataset.f; renderStations(); }));

    const bal = (s) => (s.failed ? '<span class="muted">未知</span>' : s.balanceUsd ? `${usd(s.balanceUsd)}<span class="sub-money">约 ${cny(s.balance)}</span>` : cny(s.balance));
    const status = (s) => (s.archived ? statusTag('muted', '已归档') : s.failed ? statusTag('crit', '查询失败') : statusTag(s.level));
    const runwayCell = (s) => {
      if (s.archived) return '<span class="muted">—</span>';
      if (s.failed) return '<div class="cell-runway"><div class="track mini-track is-unknown"></div><span class="v muted">无法计算</span></div>';
      const w = Math.max(2, Math.min(s.days, THRESH.max) / THRESH.max * 100);
      const cls = s.level === 'crit' ? 'is-crit' : s.level === 'warn' ? 'is-warn' : '';
      return `<div class="cell-runway"><div class="track mini-track"><span class="fill ${cls}" style="width:${w}%"></span><span class="tick" style="left:${THRESH.crit / THRESH.max * 100}%"></span><span class="tick" style="left:${THRESH.warn / THRESH.max * 100}%"></span></div><span class="v">${fmtDays(s.days)}</span></div>`;
    };
    const actions = (s) => (s.archived
      ? `<button type="button" class="btn btn--ghost">${icon('restore')}恢复</button>`
      : `<button type="button" class="btn btn--ghost" data-edit="${s.id}">${icon('edit')}编辑</button><button type="button" class="icon-btn" aria-label="${s.name} 的更多操作">${icon('more')}</button>`);
    const synced = (s) => (s.failed ? `<span class="status status--crit">13:58 失败</span>` : `<span class="num">${s.synced}</span>`);

    if (!rows.length) {
      $('#stTable').innerHTML = `<tbody><tr><td class="empty-row">没有符合条件的上游资源。<button type="button" class="btn btn--ghost" id="clearFilters">清除筛选</button></td></tr></tbody>`;
      $('#stList').innerHTML = `<li class="empty-row">没有符合条件的上游资源。</li>`;
      $('#clearFilters')?.addEventListener('click', () => { state.stFilter = 'all'; state.stQuery = ''; state.stType = ''; $('#stSearch').value = ''; $('#stType').value = ''; renderStations(); });
      return;
    }
    $('#stTable').innerHTML = `
      <thead><tr>
        <th class="sticky-l">资源</th><th>状态</th><th class="r">余额</th><th class="r">日均消耗</th>
        <th aria-sort="ascending"><span class="th-sort">可用天数${icon('sort', '')}</span></th><th>最近同步</th><th class="sticky-r r">操作</th>
      </tr></thead>
      <tbody>${rows.map((s) => `<tr>
        <td class="sticky-l"><div class="res-name"><a href="#stations">${s.name}</a><span>${s.type}，${s.host}</span></div></td>
        <td>${status(s)}</td>
        <td class="r">${bal(s)}</td>
        <td class="r">${s.archived ? '<span class="muted">—</span>' : cny(s.burn)}</td>
        <td>${runwayCell(s)}</td>
        <td>${synced(s)}</td>
        <td class="sticky-r"><div class="row-actions">${actions(s)}</div></td>
      </tr>`).join('')}</tbody>`;
    $('#stList').innerHTML = rows.map((s) => `<li>
      <span class="m-top">${s.name}</span>${status(s)}
      <div class="m-sub"><span>余额 <b class="num">${s.failed ? '未知' : s.balanceUsd ? usd(s.balanceUsd) : cny(s.balance)}</b></span><span>可用 <b class="num">${s.archived ? '—' : fmtDays(s.days)}</b></span><span>同步 ${s.failed ? '13:58 失败' : s.synced}</span></div>
      ${s.archived ? '' : `<button type="button" class="btn btn--ghost m-edit" data-edit="${s.id}">${icon('edit')}编辑</button>`}
    </li>`).join('');
    $$('[data-edit]').forEach((b) => b.addEventListener('click', () => openDrawer(b.dataset.edit, b)));
  }

  /* ─── 抽屉表单 ────────────────────────────────────── */
  let drawerTrigger = null;
  let testState = 'ok'; // ok | stale | none | running
  let editing = null;
  function openDrawer(id, trigger) {
    drawerTrigger = trigger;
    editing = id ? STATIONS.find((s) => s.id === id) : null;
    const f = $('#stationForm');
    f.reset();
    $('#drawerTitle').textContent = editing ? `编辑上游资源：${editing.name}` : '新增上游资源';
    $('#f-name').value = editing?.name || '';
    $('#f-type').value = editing?.type || 'NewAPI';
    $('#f-url').value = editing ? 'https://' + editing.host : '';
    $('#f-uid').value = editing?.uid || '';
    $('#f-low').value = editing ? '200' : '';
    $('#f-token').placeholder = editing ? '已保存' : '';
    $('#tokenHelp').hidden = !editing;
    $('#tokenHelp').textContent = '留空则继续使用已保存的令牌';
    $('#saveBtn').textContent = editing ? '保存修改' : '添加资源';
    ['url', 'low'].forEach(clearErr);
    testState = editing ? (state.data === 'partial' && id === 'deepseek' ? 'failed' : 'ok') : 'none';
    renderTest();
    $('#dirty').hidden = true;
    const d = $('#drawer');
    d.hidden = false;
    void d.offsetWidth;
    document.body.classList.add('drawer-open');
    setTimeout(() => $('#f-name').focus(), 60);
  }
  function closeDrawer() {
    document.body.classList.remove('drawer-open');
    setTimeout(() => { $('#drawer').hidden = true; }, 200);
    drawerTrigger?.focus();
  }
  function renderTest() {
    const box = $('#testResult');
    const save = $('#saveBtn');
    const hint = $('#testHint');
    const btn = $('#testBtn');
    btn.disabled = testState === 'running';
    btn.textContent = testState === 'running' ? '正在测试…' : '测试连接';
    if (testState === 'ok') {
      const bal = editing?.balanceUsd ? usd(editing.balanceUsd) : cny(editing?.balance ?? 726.80);
      box.innerHTML = `<div class="test-result">${icon('check', '')}<b>连接正常</b><span>账户 relay_ops，余额 ${bal}，${editing ? '14:31 自动同步时验证' : `${hhmm(asOf)} 测试`}。</span></div>`;
      hint.textContent = '只有修改连接凭证时才需要重新测试';
    } else if (testState === 'failed') {
      box.innerHTML = `<div class="test-result test-result--bad">${icon('crit', '')}<b>连接失败：HTTP 401</b><span>接口拒绝了访问令牌。请到该上游后台重新生成令牌，粘贴到上方后再测试。</span></div>`;
      hint.textContent = '';
    } else if (testState === 'stale') {
      box.innerHTML = `<div class="test-result test-result--stale">${icon('warn', '')}<b>连接凭证已修改</b><span>保存前请重新测试，确认新的凭证可以查询余额。</span></div>`;
      hint.textContent = '';
    } else if (testState === 'none') {
      box.innerHTML = '';
      hint.textContent = '添加前需要测试一次连接';
    } else {
      box.innerHTML = '';
    }
    save.disabled = testState !== 'ok';
    save.title = save.disabled ? '请先测试连接' : '';
  }
  function setErr(name, msg) {
    const e = $('#err-' + name);
    e.hidden = false;
    e.innerHTML = `${icon('crit', '')}${msg}`;
    $('#f-' + name).closest('.input').classList.add('is-error');
    $('#f-' + name).setAttribute('aria-invalid', 'true');
  }
  function clearErr(name) {
    const e = $('#err-' + name);
    e.hidden = true;
    $('#f-' + name).closest('.input').classList.remove('is-error');
    $('#f-' + name).removeAttribute('aria-invalid');
  }
  function validateLow() {
    const v = $('#f-low').value.trim();
    if (v === '' || (/^\d+(\.\d{1,2})?$/.test(v))) { clearErr('low'); return true; }
    setErr('low', '请输入 0 或更大的金额，最多两位小数；留空表示不提醒。');
    return false;
  }
  function bindDrawer() {
    const f = $('#stationForm');
    f.addEventListener('input', (e) => {
      $('#dirty').hidden = false;
      if (e.target.matches('[data-conn]') && (testState === 'ok' || testState === 'failed')) { testState = 'stale'; renderTest(); }
      if (e.target.id === 'f-low') validateLow();
      if (e.target.id === 'f-url') clearErr('url');
      if (e.target.id === 'f-token') $('#tokenHelp').textContent = e.target.value ? '保存后替换原来的令牌' : '留空则继续使用已保存的令牌';
    });
    $('#testBtn').addEventListener('click', () => {
      if (!$('#f-url').value.trim()) { setErr('url', '请填写接口地址，例如 https://api.example.com'); $('#f-url').focus(); return; }
      testState = 'running';
      renderTest();
      setTimeout(() => { testState = 'ok'; renderTest(); }, 800);
    });
    f.addEventListener('submit', (e) => {
      e.preventDefault();
      if (!validateLow()) { $('#f-low').focus(); return; }
      if (testState !== 'ok') return;
      closeDrawer();
      toast(editing ? '已保存修改' : '已添加资源');
    });
    $('#drawerClose').addEventListener('click', closeDrawer);
    $('#drawerCancel').addEventListener('click', closeDrawer);
    $('#scrim').addEventListener('click', () => {
      if (document.body.classList.contains('drawer-open')) closeDrawer();
      if (document.body.classList.contains('nav-open')) setNav(false);
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Tab' && document.body.classList.contains('drawer-open')) {
        const nodes = $$('#drawer button:not(:disabled), #drawer input, #drawer select').filter((n) => n.offsetParent !== null);
        const first = nodes[0], last = nodes[nodes.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
        return;
      }
      if (e.key !== 'Escape') return;
      if (document.body.classList.contains('drawer-open')) closeDrawer();
      else if (document.body.classList.contains('nav-open')) setNav(false);
      $$('.popover').forEach((p) => (p.hidden = true));
    });
    $('#addStation').addEventListener('click', (e) => openDrawer(null, e.currentTarget));
  }

  let toastTimer = null;
  function toast(msg) {
    const t = $('#toast');
    t.innerHTML = `${icon('check', '')}${msg}`;
    t.classList.add('is-on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('is-on'), 2400);
  }

  /* ─── 页面：自营业务 ───────────────────────────────── */
  const USERS = [
    ['蓝鲸工作室', 'team-lanjing', 0.182, 18240, 4.26e7, '14:28'],
    ['codewave', 'u_1093', 0.141, 22810, 3.18e7, '14:31'],
    ['北辰科技', 'org-beichen', 0.117, 9640, 2.84e7, '14:02'],
    ['星图实验室', 'lab-xingtu', 0.094, 7120, 2.02e7, '13:47'],
    ['Mira', 'u_2087', 0.071, 11380, 1.36e7, '14:30'],
    ['阿杰', 'u_0412', 0.052, 5230, 9.8e6, '12:15'],
    ['demo-bot', 'bot_demo', 0.038, 30410, 7.1e6, '14:32'],
    ['南山设计', 'org-nanshan', 0.029, 2140, 5.6e6, '昨天'],
  ];
  function renderMy() {
    const unconf = state.data === 'unconfigured';
    $('#my-onboard').hidden = !unconf;
    $('#myTabsBar').hidden = unconf;
    $$('#page-my .tabpanel').forEach((p) => (p.hidden = unconf || p.id !== 'my-' + state.tab));
    $$('#page-my [role=tab]').forEach((t) => {
      const on = t.dataset.tab === state.tab;
      t.setAttribute('aria-selected', on);
      t.tabIndex = on ? 0 : -1;
    });
    if (unconf) {
      $('#my-onboard').innerHTML = `<div class="onboard">
        <div>
          <h2>还没有设置自营站点</h2>
          <p>自营业务会汇总你自己站点的下游收入，再减去上游用量成本和固定成本，得出每天的毛利。</p>
          <ol class="steps">
            <li><div><strong>在上游资源中找到你自己的站点</strong><span>编辑它，打开“这是我的自营站点”。</span></div></li>
            <li><div><strong>填写管理员访问令牌</strong><span>用于读取下游用户和渠道计费数据，只读，不会改动站点。</span></div></li>
            <li><div><strong>回到这里查看毛利</strong><span>首次同步约需 1 分钟，之后每 60 秒更新。</span></div></li>
          </ol>
          <a class="btn btn--primary btn--lg" href="#stations">前往上游资源设置</a>
        </div>
        <div class="onboard-figure" aria-hidden="true">
          <div class="eq-mini"><span>收入</span><b>${MINUS}</b><span>用量成本</span><b>${MINUS}</b><span>固定成本</span><b>=</b><span>毛利</span></div>
          <p class="caption" style="margin-top:12px">设置完成后，这里按天算出毛利，并列出消费最多的用户和模型。</p>
        </div>
      </div>`;
      return;
    }
    const rows = windowRows('my');
    const t = totals(rows);
    if (state.tab === 'overview') {
      renderEquation($('#my-eq'), {
        title: '期内经营', page: 'my',
        notes: { rev: '3 个自营站点', cost: '按渠道关联的上游计算', fixed: '每天 ¥40.00' },
      });
      trendPanel($('#my-trend'), 'my');
      forecastChart($('#myForecast'));
      $('#tuCaption').textContent = rangeLabel('my');
      hbars($('#myTopUsers'), USERS.slice(0, 5).map((u) => ({ name: u[0], value: round2(t.rev * u[2]) })), { color: 'var(--s1)', unitName: '消费' });
    } else if (state.tab === 'users') {
      $('#usersCaption').textContent = windowCaption('my');
      const q = ($('#userSearch').value || '').trim().toLowerCase();
      const list = USERS.filter((u) => !q || (u[0] + u[1]).toLowerCase().includes(q));
      $('#userTable').innerHTML = `<thead><tr><th>用户</th><th class="r">请求数</th><th class="r">Token</th><th class="r" aria-sort="descending"><span class="th-sort">消费${icon('sort-down', '')}</span></th><th class="r">占比</th><th>最近使用</th></tr></thead>
        <tbody>${list.length ? list.map((u) => `<tr>
          <td><div class="res-name"><a href="#my?tab=users">${u[0]}</a><span>${u[1]}</span></div></td>
          <td class="r">${nf0.format(u[3])}</td><td class="r">${wan(u[4])}</td>
          <td class="r">${cny(t.rev * u[2])}</td><td class="r">${pct(u[2])}</td><td class="num">${u[5]}</td>
        </tr>`).join('') : '<tr><td colspan="6" class="empty-row">没有找到这个用户。</td></tr>'}</tbody>`;
    } else {
      const models = [['claude-sonnet-5', 0.34], ['gpt-5.1', 0.24], ['deepseek-v4', 0.15], ['gemini-3-pro', 0.12], ['qwen3-max', 0.08], ['其他 9 个模型', 0.07]];
      hbars($('#myModels'), splitTotal(t.rev, models), { color: 'var(--s1)', unitName: '消费' });
      const ch = ['OpenRouter 主渠道', '硅基流动', '深度求索官方', '星河中转', '云桥 API'].map((n, i) => [n, COST_SHARE[i]]);
      $('#myChannels').innerHTML = '<div class="hb"></div><div class="partial-note">' + icon('info') + `<span>还有 2 个渠道没有关联上游资源，它们的成本 <b class="num">${cny(412.30)}</b> 没有计入用量成本。<a href="#reconciliation">去关联</a></span></div>`;
      hbars($('.hb', $('#myChannels')), splitTotal(t.cost, ch), { color: 'var(--s2)', unitName: '用量成本' });
    }
  }

  /* ─── 页面：成本与利润 ─────────────────────────────── */
  function renderAnalytics() {
    renderEquation($('#an-eq'), {
      title: '期内成本与利润', page: 'analytics',
      notes: { rev: '全部自营站点', cost: '全部上游的余额消耗', fixed: '服务器与域名' },
      links: { rev: '#my', cost: '#stations', fixed: '#settings' },
    });
    trendPanel($('#an-trend'), 'analytics');
    const t = totals(windowRows('analytics'));
    const mix = ['OpenRouter', '硅基流动', '深度求索', '星河中转', '云桥 API'].map((n, i) => [n, COST_SHARE[i]]);
    hbars($('#anMix'), splitTotal(t.cost, mix), { color: 'var(--s2)', unitName: '用量成本' });
    heatmap($('#anHeat'));
  }

  /* ─── 未出高保真的页面 ─────────────────────────────── */
  const STUBS = {
    usage: ['用量分析', '新增“按上游”分组：各上游的 token 用量堆叠柱，按上游上色，最多 8 个，其余合并为“其他”。出错时保留筛选栏，只在内容区给出原因和“重试”。', '#54-用量分析-usage'],
    reconciliation: ['渠道对账', '使用统一的时间范围选择器，选中即生效。金额不上色，“已确认 / 待确认 / 有差异”用状态标签表达；分组历史展开区不再嵌套横向滚动表格，操作列固定；时区改为下拉选择。', '#56-渠道对账-reconciliation'],
    notifications: ['告警中心', '分为“告警规则”和“通知渠道”两块。规则关闭时，其条件与渠道控件整体禁用；阈值用数字输入加单位；渠道为空时列出全部 10 种可选渠道，并提供“添加渠道”。', '#57-告警中心-notifications'],
    settings: ['系统设置', '分为刷新与数据、告警阈值、历史数据留存、账户安全、关于五组。每组底部有自己的“保存修改”，未保存时组标题旁显示“未保存”。余额阈值改为人民币。', '#58-系统设置-settings'],
  };

  /* ─── 路由与外壳 ───────────────────────────────────── */
  const PAGES = ['overview', 'stations', 'my', 'analytics'];
  function parseHash() {
    const [route, qs] = location.hash.replace(/^#/, '').split('?');
    const p = new URLSearchParams(qs || '');
    state.route = PAGES.includes(route) || STUBS[route] ? route : 'overview';
    if (p.get('range') && PRESETS[state.route]) {
      const v = p.get('range').replace(/d$/, '');
      if (PRESETS[state.route].some(([k]) => k === v)) state.range[state.route] = v;
    }
    if (state.route === 'my' && p.get('tab')) state.tab = p.get('tab');
  }
  function syncHash() {
    const p = new URLSearchParams();
    if (PRESETS[state.route] && state.range[state.route] !== 'custom') p.set('range', state.range[state.route] + 'd');
    if (state.route === 'my' && state.tab !== 'overview') p.set('tab', state.tab);
    const qs = p.toString();
    history.replaceState(null, '', '#' + state.route + (qs ? '?' + qs : ''));
  }
  function renderPage() {
    const route = state.route;
    const isStub = !PAGES.includes(route);
    $$('.page').forEach((p) => p.classList.toggle('is-active', p.id === (isStub ? 'page-stub' : 'page-' + route)));
    $$('#nav a').forEach((a) => (a.dataset.route === route ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current')));
    let title;
    if (isStub) {
      const s = STUBS[route] || STUBS.usage;
      title = s[0];
      $('#stubTitle').textContent = s[0];
      $('#stubText').textContent = s[1];
      $('#stubLink').href = '../ui-design-spec.md' + s[2];
    } else {
      title = $('#page-' + route).dataset.title;
    }
    $('#pageTitle').textContent = title;
    document.title = `${title}，炬元控制台改版稿`;
    renderRange();
    const count = attentionItems().length;
    $('#navCount').textContent = count;
    const ovLink = $('#nav a[data-route=overview]');
    ovLink.setAttribute('aria-label', `运营总览，${count} 项需要处理`);
    if (route === 'overview') renderOverview();
    else if (route === 'stations') renderStations();
    else if (route === 'my') renderMy();
    else if (route === 'analytics') renderAnalytics();
  }

  function setNav(open) {
    document.body.classList.toggle('nav-open', open);
    $('#menuBtn').setAttribute('aria-expanded', open);
    if (open) $('#nav a[aria-current]')?.focus();
    else if ($('#sider').contains(document.activeElement)) $('#menuBtn').focus();
  }
  function setTheme(t) {
    state.theme = t;
    document.documentElement.dataset.theme = t;
    $('#themeBtn').setAttribute('aria-label', t === 'dark' ? '切换到浅色模式' : '切换到深色模式');
    $$('[data-set-theme]').forEach((b) => b.setAttribute('aria-pressed', b.dataset.setTheme === t));
  }
  function setData(d) {
    state.data = d;
    $$('[data-set-state]').forEach((b) => b.setAttribute('aria-pressed', b.dataset.setState === d));
    renderPage();
  }

  function init() {
    parseHash();
    window.addEventListener('hashchange', () => { parseHash(); renderPage(); setNav(false); $('#content').scrollIntoView({ block: 'start' }); });
    $('#menuBtn').addEventListener('click', () => setNav(!document.body.classList.contains('nav-open')));
    $$('#nav a').forEach((a) => a.addEventListener('click', () => setNav(false)));
    $('#themeBtn').addEventListener('click', () => setTheme(state.theme === 'dark' ? 'light' : 'dark'));
    $$('[data-set-theme]').forEach((b) => b.addEventListener('click', () => setTheme(b.dataset.setTheme)));
    $$('[data-set-state]').forEach((b) => b.addEventListener('click', () => setData(b.dataset.setState)));
    $('#reviewFold').addEventListener('click', (e) => {
      const r = $('#review');
      r.classList.toggle('is-folded');
      const folded = r.classList.contains('is-folded');
      e.currentTarget.textContent = folded ? '展开' : '收起';
      e.currentTarget.setAttribute('aria-expanded', !folded);
    });

    // 刷新：保留旧数据、降低不透明度、图标旋转，不闪骨架
    $('#refreshBtn').addEventListener('click', () => {
      const btn = $('#refreshBtn');
      if (btn.classList.contains('is-spinning')) return;
      btn.classList.add('is-spinning');
      $('#content').classList.add('is-refreshing');
      setTimeout(() => {
        asOf = { h: asOf.h + (asOf.m === 59 ? 1 : 0), m: (asOf.m + 1) % 60 };
        $('#asOf').textContent = hhmm(asOf);
        renderPage();
        btn.classList.remove('is-spinning');
        $('#content').classList.remove('is-refreshing');
      }, 700);
    });

    $('#stSearch').addEventListener('input', (e) => { state.stQuery = e.target.value; renderStations(); });
    $('#stType').addEventListener('change', (e) => { state.stType = e.target.value; renderStations(); });
    $('#userSearch').addEventListener('input', () => renderMy());

    // 标签页：方向键切换
    const tabs = $$('#page-my [role=tab]');
    tabs.forEach((t, k) => {
      t.addEventListener('click', () => { state.tab = t.dataset.tab; syncHash(); renderMy(); });
      t.addEventListener('keydown', (e) => {
        if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
        const next = tabs[(k + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
        next.focus(); next.click();
      });
    });
    $$('[data-goto-tab]').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); state.tab = a.dataset.gotoTab; syncHash(); renderMy(); }));

    bindDrawer();
    const qp = new URLSearchParams(location.search);
    setTheme(qp.get('theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
    if (qp.get('state')) state.data = qp.get('state');
    $$('[data-set-state]').forEach((b) => b.setAttribute('aria-pressed', b.dataset.setState === state.data));
    renderPage();
  }

  init();
})();
