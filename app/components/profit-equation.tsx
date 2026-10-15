// 利润等式（招牌组件），两行：收入 − 上游成本 = 毛利；毛利 − 固定成本 = 净利。
// 数据不全时带 ≈ 并在下方说明原因；收入算不出来（没设置自营站点、超出范围、读取失败）时
// 收入、毛利和净利留空，下方说明原因和下一步，两项成本照常显示。
import Link from "next/link";
import type { ReactNode } from "react";
import { MINUS, formatMoney, formatPct, splitTotal } from "../../lib/format";
import { Icon } from "./icons";
import { StatusText } from "./status";

export type EqTerm = {
  value: number | null;
  // 按已有数据估算（部分缺失）
  approx?: boolean;
  note?: ReactNode;
  href?: string;
};

function MoneyHero({ value, approx }: { value: number; approx?: boolean }) {
  const s = formatMoney(value, { symbol: "" });
  const neg = s.startsWith(MINUS);
  return (
    <>
      {approx && <span className="approx">≈</span>}
      {neg ? MINUS : ""}
      <span className="unit">¥</span>
      {neg ? s.slice(1) : s}
    </>
  );
}

function Term({
  label,
  color,
  term,
  empty = "—",
  op,
  kind,
  loading,
}: {
  label: string;
  color?: string;
  term: EqTerm;
  empty?: string;
  op?: string;
  // gross：第一行的结果；net：第二行的结果（主结论）；carry：第二行开头承接的毛利，窄屏账单式里隐藏
  kind?: "gross" | "net" | "carry";
  loading?: boolean;
}) {
  const plain = !kind;
  const cls = [
    "jy-eq-term",
    term.approx && plain ? "is-partial" : "",
    kind === "gross" || kind === "net" ? "jy-eq-result" : "",
    kind ? `is-${kind}` : "",
  ].filter(Boolean).join(" ");
  const inner = (
    <>
      <span className="jy-eq-label">
        {color && <i className="jy-swatch" style={{ background: color }} />}
        {label}
      </span>
      <span className="jy-eq-value">
        {loading ? (
          <span className="jy-skeleton" style={{ display: "inline-block", width: 132, height: 28, verticalAlign: "middle" }} />
        ) : term.value == null ? (
          <span className="jy-eq-empty">{empty}</span>
        ) : (
          <MoneyHero value={term.value} approx={term.approx} />
        )}
      </span>
      {term.approx && plain && <span className="jy-partial-strip jy-hatch" aria-hidden="true" />}
      <span className="jy-eq-note">{loading ? null : term.note}</span>
    </>
  );
  if (term.href && !loading) {
    return (
      <Link href={term.href} className={cls} data-op={op}>
        {inner}
      </Link>
    );
  }
  return (
    <div className={cls} data-op={op} aria-hidden={kind === "carry" ? true : undefined}>
      {inner}
    </div>
  );
}

const Op = ({ ch, spoken }: { ch: string; spoken: string }) => (
  <span className="jy-eq-op">
    <span aria-hidden="true">{ch}</span>
    <span className="sr-only">{spoken}</span>
  </span>
);

const isLoss = (v: number | null) => v != null && v < 0 && Math.abs(v) >= 0.005;

export function ProfitEquation({
  title,
  caption,
  extra,
  revenue,
  upstream,
  fixed,
  gross,
  net,
  reasons = [],
  unconfigured = false,
  configureHref = "/my",
  revenueEmpty = "未设置",
  profitNote,
  notice,
  loading = false,
  partialTail = "实际净利会比这里低。",
}: {
  title: ReactNode;
  caption?: ReactNode;
  extra?: ReactNode;
  revenue: EqTerm;
  // 按用量计费的上游实际扣费
  upstream: EqTerm;
  // 包月/包年付费的摊销
  fixed: EqTerm;
  // 默认按收入 − 上游成本、毛利 − 固定成本现算；接口给了就用接口的，避免两边舍入不一致
  gross?: number | null;
  net?: number | null;
  // 数据不完整的原因，每条一句，句号结尾
  reasons?: ReactNode[];
  // 收入算不出来：收入、毛利、净利留空
  unconfigured?: boolean;
  configureHref?: string;
  // 以下三项只在 unconfigured 时使用，默认是"没有设置自营站点"的说法
  revenueEmpty?: string;
  profitNote?: ReactNode;
  notice?: ReactNode;
  loading?: boolean;
  // 不完整说明的最后一句；缺的是成本时利润偏高，缺的是汇率等时方向不定
  partialTail?: ReactNode;
}) {
  const rev = unconfigured ? null : revenue.value;
  const grossApprox = !!((!unconfigured && revenue.approx) || upstream.approx || reasons.length > 0);
  const netApprox = grossApprox || !!fixed.approx;
  const partial = netApprox;
  const g =
    gross !== undefined
      ? gross
      : rev == null || upstream.value == null
        ? null
        : rev - upstream.value;
  const n =
    net !== undefined
      ? net
      : g == null || fixed.value == null
        ? null
        : g - fixed.value;

  const resultNote = (v: number | null, rateLabel: string, approx: boolean): ReactNode => {
    if (unconfigured) return profitNote ?? "设置自营站点后计算";
    if (isLoss(v)) return <StatusText level="crit">亏损</StatusText>;
    if (rev && v != null) return `${rateLabel} ${approx ? "≈ " : ""}${formatPct(v / rev)}`;
    return undefined;
  };

  const showFlow = !loading && !unconfigured && !isLoss(n) && rev != null && rev > 0 && n != null && upstream.value != null;
  const flow = showFlow
    ? splitTotal(100, [upstream.value / rev, (fixed.value || 0) / rev, n / rev])
    : null;
  const a = partial ? "≈ " : "";
  const per = (v: number) => formatMoney(v);
  const grossValue = unconfigured ? null : g;

  return (
    <section className="jy-panel jy-equation" aria-label={typeof title === "string" ? title : undefined}>
      <div className="jy-eq-head">
        <h2>{title}</h2>
        {caption != null && <span className="jy-caption">{caption}</span>}
        {extra != null && (
          <>
            <span className="spacer" />
            {extra}
          </>
        )}
      </div>
      <div className="jy-eq-row">
        <Term
          label="收入"
          color="var(--jy-s1)"
          term={unconfigured ? { value: null, note: revenue.note ?? "没有自营站点", href: revenue.href } : revenue}
          empty={revenueEmpty}
          loading={loading}
        />
        <Op ch={MINUS} spoken="减" />
        <Term
          label="上游成本"
          color="var(--jy-s2)"
          term={{ ...upstream, note: upstream.approx && upstream.note == null ? "部分数据缺失" : upstream.note }}
          op={MINUS}
          loading={loading}
        />
        <Op ch="=" spoken="等于" />
        <Term
          label="毛利"
          term={{ value: grossValue, approx: grossApprox, note: resultNote(g, "毛利率", grossApprox) }}
          op="="
          kind="gross"
          loading={loading}
        />
        <Term label="毛利" term={{ value: grossValue, approx: grossApprox }} kind="carry" loading={loading} />
        <Op ch={MINUS} spoken="减" />
        <Term label="固定成本" color="var(--jy-s3)" term={fixed} op={MINUS} loading={loading} />
        <Op ch="=" spoken="等于" />
        <Term
          label="净利"
          term={{ value: unconfigured ? null : n, approx: netApprox, note: resultNote(n, "净利率", netApprox) }}
          op="="
          kind="net"
          loading={loading}
        />
      </div>
      {unconfigured && !loading && (
        <div className="jy-partial-note">
          <Icon name="info" />
          <span>
            {notice ?? (
              <>
                还没有设置自营站点，所以收入、毛利和净利暂时无法计算；上游成本和固定成本照常统计。
                <Link href={configureHref} className="jy-link">
                  设置自营站点
                </Link>
              </>
            )}
          </span>
        </div>
      )}
      {flow && (
        <div className="jy-flow" aria-label="每 100 元收入的去向">
          <div className="jy-flow-bar" aria-hidden="true">
            <span style={{ flex: Math.max(0, flow[0]), background: "var(--jy-s2)" }} />
            <span style={{ flex: Math.max(0, flow[1]), background: "var(--jy-s3)" }} />
            <span style={{ flex: Math.max(0, flow[2]), background: "var(--jy-s1)" }} />
          </div>
          <div className="jy-flow-legend">
            <span>每 ¥100 收入中</span>
            <span>
              <i className="jy-swatch" style={{ background: "var(--jy-s2)" }} />
              上游成本 <b>{a}{per(flow[0])}</b>
            </span>
            <span>
              <i className="jy-swatch" style={{ background: "var(--jy-s3)" }} />
              固定成本 <b>{per(flow[1])}</b>
            </span>
            <span>
              <i className="jy-swatch" style={{ background: "var(--jy-s1)" }} />
              留作净利 <b>{a}{per(flow[2])}</b>
            </span>
          </div>
        </div>
      )}
      {partial && !loading && (
        <div className="jy-partial-note">
          <Icon name="info" />
          <span>
            数据不完整，带 ≈ 的数字是按已有数据算出的。
            {reasons.map((r, i) => (
              <span key={i}>{r}</span>
            ))}
            {partialTail}
          </span>
        </div>
      )}
    </section>
  );
}
