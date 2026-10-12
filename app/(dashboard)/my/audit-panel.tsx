"use client";
// 日志精算：翻消费日志明细，补上看板漏计的缓存读写与长上下文请求。
// 开销大，默认收起，点了才请求；结果状态放在页面里，切标签页不丢。
import { Button } from "antd";
import { EMPTY, formatCompact, formatInt, formatMoney } from "../../../lib/format";
import { ErrorState } from "../../components/data-state";
import { Icon } from "../../components/icons";
import { Panel } from "../../components/panel";
import { Seg } from "../../components/seg";
import { DataTable, TOKEN_NOTE, money, perM } from "./shared";

export const AUDIT_ROWS = [
  { value: "2000", label: "2 千条" },
  { value: "4000", label: "4 千条" },
  { value: "10000", label: "1 万条" },
  { value: "20000", label: "2 万条" },
];

export type AuditProps = {
  audit: any;
  auditing: boolean;
  auditError: string | null;
  auditRows: number;
  setAuditRows: (n: number) => void;
  run: () => void;
  open: boolean;
  setOpen: (o: boolean) => void;
  rate: number;
};

const when = (ms: number) => new Date(ms).toLocaleString("zh-CN", { hour12: false });

export function AuditPanel({ audit, auditing, auditError, auditRows, setAuditRows, run, open, setOpen, rate }: AuditProps) {
  const t = audit?.totals || {};
  const longLabel = audit ? `长上下文（≥${formatCompact(audit.longContextTokens)}）` : "长上下文";
  return (
    <Panel
      title="日志精算"
      className={open ? undefined : "jy-my-collapsed"}
      extra={
        <Button size="small" aria-expanded={open} icon={<Icon name={open ? "collapse" : "expand"} />} onClick={() => setOpen(!open)}>
          {open ? "收起" : "展开"}
        </Button>
      }
      sub="翻消费日志明细，补上看板漏计的缓存读、缓存写与长上下文请求。"
      body={open}
    >
      {open ? (
        <>
          <div className="jy-my-toolbar">
            <Seg<string>
              size="sm"
              label="扫描条数"
              value={String(auditRows)}
              onChange={(x) => setAuditRows(Number(x))}
              options={AUDIT_ROWS}
            />
            <Button type="primary" loading={auditing} onClick={run}>
              {audit ? "重新精算" : "开始精算"}
            </Button>
          </div>
          {auditError && <ErrorState title="精算失败" error={auditError} onRetry={run} />}
          {!audit ? (
            !auditError && (
              <div className="jy-my-lines">
                <p>
                  看板的 token 只有 prompt + completion；Claude 这类缓存占九成的模型会显示成「token 近零、消费很大」。点「开始精算」按当前范围翻最近{" "}
                  {formatInt(auditRows)} 条消费日志，算出真实 token、缓存读写与长上下文占比。
                </p>
              </div>
            )
          ) : (
            <>
              <dl className="jy-my-stats">
                <div>
                  <dt>计费 Token</dt>
                  <dd>
                    {formatCompact(t.billedTokens || 0)}
                    <small>看板口径</small>
                  </dd>
                </div>
                <div>
                  <dt>真实 Token</dt>
                  <dd>
                    {formatCompact(t.trueTokens || 0)}
                    <small>含缓存读写</small>
                  </dd>
                </div>
                <div>
                  <dt>缓存读 Token</dt>
                  <dd>
                    {formatCompact(t.cacheReadTokens || 0)}
                    <small>缓存写 {formatCompact(t.cacheWriteTokens || 0)}</small>
                  </dd>
                </div>
                <div>
                  <dt>{longLabel}</dt>
                  <dd>
                    {formatInt(t.longRequests || 0)} 次<small>{formatMoney((t.longCost || 0) * rate)}</small>
                  </dd>
                </div>
              </dl>
              <div className="jy-my-lines">
                <p>
                  已扫描 {formatInt(audit.scanned)}
                  {audit.total != null ? ` / ${formatInt(audit.total)}` : ""} 条日志
                  {audit.fromMs ? `，覆盖 ${when(audit.fromMs)} 至 ${when(audit.toMs)}` : ""}。
                  {audit.truncated ? "已按条数上限截断，只统计最近的这部分。" : ""}
                </p>
              </div>
              <DataTable<any>
                scroll
                tall
                caption="按模型的日志精算结果"
                rows={audit.byModel || []}
                rowKey={(r) => String(r.model)}
                defaultSort={{ key: "cost", dir: "desc" }}
                empty="这个时间范围内没有消费日志。"
                cols={[
                  {
                    key: "model",
                    label: "模型",
                    sort: (r) => r.model,
                    render: (r) => (
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                        {r.model}
                        {r.anthropicPct >= 50 && (
                          <span className="jy-tag jy-tag--warn" title="Claude 语义：缓存读写在 prompt_tokens 之外额外计费">
                            缓存额外计费
                          </span>
                        )}
                      </span>
                    ),
                  },
                  { key: "req", label: "请求数", num: true, sort: (r) => r.requests, render: (r) => formatInt(r.requests) },
                  { key: "billed", label: "计费 Token", title: TOKEN_NOTE, num: true, sort: (r) => r.billedTokens, render: (r) => formatCompact(r.billedTokens) },
                  { key: "true", label: "真实 Token", num: true, sort: (r) => r.trueTokens, render: (r) => formatCompact(r.trueTokens) },
                  { key: "cr", label: "缓存读", num: true, sort: (r) => r.cacheReadTokens, render: (r) => formatCompact(r.cacheReadTokens) },
                  { key: "cw", label: "缓存写", num: true, sort: (r) => r.cacheWriteTokens, render: (r) => formatCompact(r.cacheWriteTokens) },
                  {
                    key: "long",
                    label: longLabel,
                    num: true,
                    sort: (r) => r.longRequests || 0,
                    render: (r) =>
                      r.longRequests ? (
                        <>
                          {formatInt(r.longRequests)} 次<span className="jy-sub-money">{formatMoney(r.longCost * rate)}</span>
                        </>
                      ) : (
                        <span className="jy-muted">{EMPTY}</span>
                      ),
                  },
                  { key: "cost", label: "消费", num: true, sort: (r) => r.cost, render: (r) => money(r.cost * rate) },
                  {
                    key: "perM",
                    label: "¥/M 真实",
                    title: "¥ / 百万真实 token（含缓存）",
                    num: true,
                    sort: (r) => (r.trueTokens > 0 ? r.cost / r.trueTokens : null),
                    render: (r) => perM(r.cost * rate, r.trueTokens),
                  },
                  {
                    key: "ratio",
                    label: "计价倍率",
                    render: (r) => (
                      <span className="jy-muted">
                        {r.avgModelRatio != null ? `模型×${r.avgModelRatio}` : EMPTY}
                        {r.avgGroupRatio != null ? ` 分组×${r.avgGroupRatio}` : ""}
                        {r.avgCompletionRatio != null ? ` 输出×${r.avgCompletionRatio}` : ""}
                        {r.tiers?.length ? `，${r.tiers.map((x: any) => `${x.name}×${x.requests}`).join(" ")}` : ""}
                      </span>
                    ),
                  },
                ]}
              />
            </>
          )}
        </>
      ) : null}
    </Panel>
  );
}
