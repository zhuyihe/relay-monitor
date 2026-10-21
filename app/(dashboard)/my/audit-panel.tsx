"use client";
// 按明细细算：逐条看用量记录，补上汇总里没算的缓存和长对话用量。
// 开销大，默认收起，点了才请求；结果状态放在页面里，切标签页不丢。
import { Button } from "antd";
import { EMPTY, formatCompact, formatInt, formatMoney, formatZonedRange } from "../../../lib/format";
import { ErrorState } from "../../components/data-state";
import { Icon } from "../../components/icons";
import { Panel } from "../../components/panel";
import { Seg } from "../../components/seg";
import { AUDIT_TITLE, COL_TEXT, DataTable, TOKEN_NOTE, money, perM } from "./shared";

export const AUDIT_ROWS = [
  { value: "2000", label: "2 千条" },
  { value: "4000", label: "4 千条" },
  { value: "10000", label: "1 万条" },
  { value: "20000", label: "2 万条" },
];

export type AuditProps = {
  audit: any;
  auditing: boolean;
  auditError: Error | null;
  auditRows: number;
  setAuditRows: (n: number) => void;
  run: () => void;
  open: boolean;
  setOpen: (o: boolean) => void;
  rate: number;
  // 业务时区：看过的用量记录从几点到几点，按这个时区写
  tz?: string;
};

// 只在这块出现的说法（design/ui-copy-spec.md §11）
const COPY = {
  sub: "逐条看用量记录，补上概览没算进去的缓存和长对话用量。",
  rows: "看多少条",
  start: "开始细算",
  again: "重新细算",
  failed: "读不到用量记录",
  withCache: "Token（含缓存）",
  cache: "缓存",
  long: "长对话",
  cacheSplit: (read: number, write: number) => `读取 ${formatCompact(read)}，写入 ${formatCompact(write)}`,
  times: (n: number) => `${formatInt(n)} 次`,
};

// 倍率一格：「模型倍率 1.5、分组倍率 1、输出倍率 4」，命中价格档的再写「200k 档 12 次」
function ratioText(r: any) {
  const parts = [
    r.avgModelRatio != null ? `模型倍率 ${r.avgModelRatio}` : "",
    r.avgGroupRatio != null ? `分组倍率 ${r.avgGroupRatio}` : "",
    r.avgCompletionRatio != null ? `输出倍率 ${r.avgCompletionRatio}` : "",
  ].filter(Boolean);
  const tiers = (r.tiers || []).map((x: any) => `${x.name} 档 ${formatInt(x.requests)} 次`);
  const text = [parts.join("、"), tiers.join("、")].filter(Boolean).join("；");
  return text || EMPTY;
}

export function AuditPanel({ audit, auditing, auditError, auditRows, setAuditRows, run, open, setOpen, rate, tz }: AuditProps) {
  const t = audit?.totals || {};
  const longLabel = audit?.longContextTokens ? `${COPY.long}（${formatCompact(audit.longContextTokens)} Token 以上）` : COPY.long;
  const range = audit?.fromMs && audit?.toMs ? formatZonedRange(audit.fromMs, audit.toMs, tz) : EMPTY;
  return (
    <Panel
      title={AUDIT_TITLE}
      className={open ? undefined : "jy-my-collapsed"}
      extra={
        <Button size="small" aria-expanded={open} icon={<Icon name={open ? "collapse" : "expand"} />} onClick={() => setOpen(!open)}>
          {open ? "收起" : "展开"}
        </Button>
      }
      sub={COPY.sub}
      body={open}
    >
      {open ? (
        <>
          <div className="jy-my-toolbar">
            <Seg<string>
              size="sm"
              label={COPY.rows}
              value={String(auditRows)}
              onChange={(x) => setAuditRows(Number(x))}
              options={AUDIT_ROWS}
            />
            <Button type="primary" loading={auditing} onClick={run}>
              {audit ? COPY.again : COPY.start}
            </Button>
          </div>
          {auditError && <ErrorState what={COPY.failed} error={auditError} onRetry={run} />}
          {!audit ? (
            !auditError && (
              <div className="jy-my-lines">
                <p>
                  上面各表的 Token 不含缓存；缓存占大头的模型会显示成「Token 很少、消费很大」。点「{COPY.start}」，会逐条看这个时间范围里最近{" "}
                  {formatInt(auditRows)} 条用量记录，算出 Token（含缓存）、缓存和长对话的占比。
                </p>
              </div>
            )
          ) : (
            <>
              <dl className="jy-my-stats">
                <div>
                  <dt>{COL_TEXT.tokens}</dt>
                  <dd>
                    {formatCompact(t.billedTokens || 0)}
                    <small>只算输入和输出</small>
                  </dd>
                </div>
                <div>
                  <dt>{COPY.withCache}</dt>
                  <dd>
                    {formatCompact(t.trueTokens || 0)}
                    <small>加上缓存</small>
                  </dd>
                </div>
                <div>
                  <dt>{COPY.cache}</dt>
                  <dd>
                    {formatCompact((t.cacheReadTokens || 0) + (t.cacheWriteTokens || 0))}
                    <small>{COPY.cacheSplit(t.cacheReadTokens || 0, t.cacheWriteTokens || 0)}</small>
                  </dd>
                </div>
                <div>
                  <dt>{longLabel}</dt>
                  <dd>
                    {COPY.times(t.longRequests || 0)}
                    <small>{formatMoney((t.longCost || 0) * rate)}</small>
                  </dd>
                </div>
              </dl>
              <div className="jy-my-lines">
                <p>
                  看了 {formatInt(audit.scanned)}
                  {audit.total != null ? ` / ${formatInt(audit.total)}` : ""} 条用量记录
                  {range !== EMPTY ? `（${range}）` : ""}。
                  {audit.truncated ? "条数到了上限，只算了最近的这部分。" : ""}
                </p>
              </div>
              <DataTable<any>
                scroll
                tall
                caption="按模型的细算结果"
                rows={audit.byModel || []}
                rowKey={(r) => String(r.model)}
                defaultSort={{ key: "cost", dir: "desc" }}
                empty="这个时间范围内没有用量记录。"
                cols={[
                  {
                    key: "model",
                    label: "模型",
                    sort: (r) => r.model,
                    render: (r) => (
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                        {r.model}
                        {r.anthropicPct >= 50 && (
                          <span className="jy-tag jy-tag--warn" title="这个模型的缓存另外收费，不在 Token（不含缓存）里">
                            缓存另算
                          </span>
                        )}
                      </span>
                    ),
                  },
                  { key: "req", label: COL_TEXT.requests, num: true, sort: (r) => r.requests, render: (r) => formatInt(r.requests) },
                  { key: "billed", label: COL_TEXT.tokens, title: TOKEN_NOTE, num: true, sort: (r) => r.billedTokens, render: (r) => formatCompact(r.billedTokens) },
                  { key: "true", label: COPY.withCache, num: true, sort: (r) => r.trueTokens, render: (r) => formatCompact(r.trueTokens) },
                  {
                    key: "cache",
                    label: COPY.cache,
                    num: true,
                    sort: (r) => (r.cacheReadTokens || 0) + (r.cacheWriteTokens || 0),
                    render: (r) => (
                      <span title={COPY.cacheSplit(r.cacheReadTokens || 0, r.cacheWriteTokens || 0)}>
                        {formatCompact((r.cacheReadTokens || 0) + (r.cacheWriteTokens || 0))}
                      </span>
                    ),
                  },
                  {
                    key: "long",
                    label: longLabel,
                    num: true,
                    sort: (r) => r.longRequests || 0,
                    render: (r) =>
                      r.longRequests ? (
                        <>
                          {COPY.times(r.longRequests)}<span className="jy-sub-money">{formatMoney(r.longCost * rate)}</span>
                        </>
                      ) : (
                        <span className="jy-muted">{EMPTY}</span>
                      ),
                  },
                  { key: "cost", label: COL_TEXT.cost, num: true, sort: (r) => r.cost, render: (r) => money(r.cost * rate) },
                  {
                    key: "perM",
                    label: `${COL_TEXT.perM}（含缓存）`,
                    title: "每百万 Token（含缓存）的价格",
                    num: true,
                    sort: (r) => (r.trueTokens > 0 ? r.cost / r.trueTokens : null),
                    render: (r) => perM(r.cost * rate, r.trueTokens),
                  },
                  {
                    key: "ratio",
                    label: "倍率",
                    render: (r) => <span className="jy-muted">{ratioText(r)}</span>,
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
