"use client";
// 利润怎么算：收入与成本怎么算、说明、转售 Key（含选择）、每个上游的成本明细。
// 默认收起：日常看等式就够了，想知道数字怎么来的才展开。
import { useState } from "react";
import { useRouter } from "next/navigation";
import { App, Button, Checkbox, Input } from "antd";
import { api } from "../../../lib/client";
import { rateSnapshotOf } from "../../../lib/profit";
import { failureSentence, failureText } from "../../../lib/error-copy";
import { STATION_TABS } from "../../../lib/brand";
import { BASIS_TITLE, COST_MODE_TEXT, EMPTY, SELL_PRICE_UNSET, formatMoney, formatSellPrice, formatZonedRange } from "../../../lib/format";
import { EmptyState, ErrorState } from "../../components/data-state";
import { ErrorDetail, noteOf } from "../../components/error-detail";
import { More } from "../../components/more";
import { Icon, Sym } from "../../components/icons";
import { CountBadge, Panel } from "../../components/panel";
import { StatusTag } from "../../components/status";
import { DataTable, ROLE_LABEL } from "./shared";
import type { OwnView } from "./shared";

// GET /api/own/admin-keys 的账号与 Key
type AdminToken = { name: string; status?: number; usedUsd: number | null; flagged: boolean };
type AdminAccount = { username: string; role: number; enumerable: boolean; error?: string; tokens: AdminToken[] };

// 只在这块出现的说法（design/ui-copy-spec.md §11）
const COPY = {
  unreadable: "读不到利润数据，计算明细也看不了。",
  notes: (n: number) => `，${n} 条说明`,
  incomplete: "利润数据不完整",
  estimated: "成本里有估算的数",
  note: "说明",
  resold: "转售 Key",
  pick: "选转售 Key",
  // 收起区按钮写它收着什么（ui-design-spec §4.11、ui-copy-spec §8.4）
  more: "收入和成本怎么算、转售 Key、各上游成本",
  costsTitle: "成本明细",
  costsCaption: "每个上游的成本按它自己的方式算",
  unread: "读不到",
  // 成本明细里某个上游读用量失败（改按余额变化估算）时，名字下面那句的开头
  usageUnread: "读不到用量",
};

// 自营站点的售价：设置了是「1 美元额度 = 7.2 元」，没设置是空串（界面写 SELL_PRICE_UNSET）
const sellPriceOf = (station: any) => (rateSnapshotOf(station).source === "configured" && formatSellPrice(station.cnyPerUsd)) || "";
const modeText = (mode: string) => COST_MODE_TEXT[mode as keyof typeof COST_MODE_TEXT] || "";

// 开合由概览传进来（等式里「利润怎么算」点过来要把它打开），用收起区 More 的受控用法
export function ProfitBasis({
  v,
  open,
  onOpenChange,
  reload,
}: {
  v: OwnView;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  reload: () => Promise<unknown>;
}) {
  const p = v.profit;
  const ok = p && !p.error;
  const warnings: string[] = ok ? p.warnings || [] : [];
  // 收入确认不了时原因在上面的利润等式里；这里成本、转售 Key 照常，下面的转售 Key 还能改（§8.1）
  // 收入、上游成本、固定成本的数都在上面的利润等式里，这里不再写一遍（同一个数一页只出现一次，ui-design-spec §1.4 第 2 条）
  const summary = ok ? (
    <>
      {(p.resoldKeys || []).length} 个转售 Key，{(p.costs || []).length} 个上游算进利润{warnings.length ? COPY.notes(warnings.length) : ""}。
    </>
  ) : (
    COPY.unreadable
  );
  const sellPrice = sellPriceOf(v.d.station) || SELL_PRICE_UNSET;
  const span = formatZonedRange(v.d.startMs, v.d.endMs, v.d.tz);

  return (
    <Panel title={BASIS_TITLE} sub={summary} body={!!ok}>
      {ok ? (
        <More label={COPY.more} open={open} onOpenChange={onOpenChange}>
          <section className="jy-my-section">
            <div className="jy-my-lines">
              <p>收入 = 普通用户消费 × 售价（{sellPrice}），不含管理员自用；标为转售 Key 的那部分算作收入。</p>
              <p>毛利 = 收入 − 上游成本；净利 = 毛利 − 固定成本。按用量算的上游算进上游成本；包月或按期付费的上游按天平摊，算进固定成本。</p>
              <p>每个上游的成本按它自己的方式算，统计 {span}。</p>
            </div>
            {warnings.length > 0 && (
              <div className={`jy-banner${p.complete ? " jy-banner--info" : ""}`} role="status">
                <Sym kind={p.complete ? "info" : "warn"} />
                <div className="jy-banner__body">
                  <strong>{!p.complete ? COPY.incomplete : p.estimated ? COPY.estimated : COPY.note}</strong>
                  <ul className="jy-my-list">
                    {warnings.map((w) => (
                      <li key={w}>{w}。</li>
                    ))}
                  </ul>
                </div>
              </div>
            )}
          </section>
          <ResoldSection v={v} reload={reload} />
          <CostSection p={p} />
        </More>
      ) : null}
    </Panel>
  );
}

// ---- 转售 Key ------------------------------------------------------------

function ResoldSection({ v, reload }: { v: OwnView; reload: () => Promise<unknown> }) {
  const { message } = App.useApp();
  const p = v.profit;
  const keys: any[] = p.resoldKeys || [];
  const price = sellPriceOf(v.d.station);
  const [mgrOpen, setMgrOpen] = useState(false);
  const [mgrLoading, setMgrLoading] = useState(false);
  const [mgrError, setMgrError] = useState<Error | null>(null);
  const [accounts, setAccounts] = useState<AdminAccount[] | null>(null);
  const [addInputs, setAddInputs] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  const fetchAccounts = async () => {
    setMgrLoading(true);
    setMgrError(null);
    try {
      const r = await api("/api/own/admin-keys");
      setAccounts(r.accounts);
    } catch (e: any) {
      setMgrError(e);
    } finally {
      setMgrLoading(false);
    }
  };

  const closeManager = () => {
    setMgrOpen(false);
    setAccounts(null);
    setMgrError(null);
  };
  // 「选转售 Key」是收起区：打开时读一次管理员账号的 Key，收起、取消、保存后都关上
  const onManager = (open: boolean) => {
    if (!open) return closeManager();
    setMgrOpen(true);
    fetchAccounts();
  };

  const toggleKey = (username: string, tokenName: string, checked: boolean) =>
    setAccounts((prev) =>
      (prev || []).map((a) =>
        a.username !== username ? a : { ...a, tokens: a.tokens.map((t) => (t.name === tokenName ? { ...t, flagged: checked } : t)) },
      ),
    );

  // 列不出 Key 的账号手动补 Key 名；同名不重复添加
  const addManualKey = (username: string) => {
    const name = (addInputs[username] || "").trim();
    if (!name) return;
    setAccounts((prev) =>
      (prev || []).map((a) => {
        if (a.username !== username) return a;
        if (a.tokens.some((t) => t.name === name)) return a;
        return { ...a, tokens: [...a.tokens, { name, flagged: true, usedUsd: null }] };
      }),
    );
    setAddInputs((m) => ({ ...m, [username]: "" }));
  };

  const saveResold = async () => {
    const list = (accounts || []).flatMap((a) =>
      a.tokens.filter((t) => t.flagged).map((t) => ({ username: a.username, tokenName: t.name })),
    );
    setSaving(true);
    try {
      await api("/api/own/admin-keys", { method: "PUT", body: { keys: list } });
      message.success(`已保存 ${list.length} 个转售 Key，正在重算利润…`);
      setMgrOpen(false);
      setAccounts(null);
      await reload();
    } catch (e: any) {
      message.error(failureText("保存失败", e));
    } finally {
      setSaving(false);
    }
  };

  const tokenLabel = (t: AdminToken, withUsed: boolean) => (
    <>
      {t.name || "（未命名）"}
      {withUsed && t.usedUsd != null && <span className="jy-caption"> 累计用 {formatMoney(t.usedUsd * v.rate)}</span>}
    </>
  );

  return (
    <section className="jy-my-section">
      <h3 className="jy-my-h3">
        {COPY.resold}
        <CountBadge count={keys.length} muted />
      </h3>
      {keys.length ? (
        <DataTable<any>
          compact
          caption="已标记的转售 Key"
          rows={keys}
          rowKey={(k) => `${k.username}/${k.tokenName}`}
          empty="还没有标记转售 Key。"
          defaultSort={{ key: "cny", dir: "desc" }}
          cols={[
            { key: "user", label: "账号", sort: (k) => k.username, render: (k) => k.username },
            { key: "token", label: "Key 名", sort: (k) => k.tokenName, render: (k) => k.tokenName },
            {
              key: "state",
              label: "状态",
              render: (k) => {
                if (!k.error) return <span className="jy-muted">卖给用户用，算进收入</span>;
                const note = noteOf(k);
                return (
                  <>
                    <StatusTag level="warn">{COPY.unread}</StatusTag>
                    <span className="jy-sub-money">{note.text}</span>
                    <ErrorDetail raw={note.raw} />
                  </>
                );
              },
            },
            // 收入确认不了时金额是 null，写「—」，不写成 0
            { key: "cny", label: "收入", num: true, sort: (k) => k.cny || 0, render: (k) => (k.cny == null ? EMPTY : formatMoney(k.cny)) },
          ]}
        />
      ) : (
        <div className="jy-my-lines">
          <p>还没有标记转售 Key。如果某个管理员或超级管理员账号的 Key 实际是卖给用户用的，点「{COPY.pick}」勾选它，它的消费就会算进收入。</p>
        </div>
      )}

      <More label={COPY.pick} open={mgrOpen} onOpenChange={onManager}>
        <div className="jy-my-mgr">
          {mgrLoading ? (
            <p className="jy-muted" aria-busy="true" style={{ margin: 0 }}>
              读取中…
            </p>
          ) : mgrError ? (
            <ErrorState what="读不到管理员账号的 Key" error={mgrError} onRetry={fetchAccounts} />
          ) : !accounts || !accounts.length ? (
            <EmptyState center={false} title="没有找到管理员或超级管理员账号" desc="转售 Key 只能从管理员和超级管理员的账号里选。" />
          ) : (
            <>
              <div className="jy-my-lines">
                <p>
                  勾选实际卖给用户用的 Key，它的消费会从「管理员自用」改算进「收入」（{price ? `按售价 ${price}` : SELL_PRICE_UNSET}）。不同账号可能有同名 Key，所以按「账号 + Key 名」区分。
                </p>
              </div>
              {accounts.map((a) => (
                <div key={a.username} className="jy-my-account">
                  <h4>
                    {a.username}
                    {ROLE_LABEL[a.role] && <span className="jy-tag jy-tag--type">{ROLE_LABEL[a.role]}</span>}
                  </h4>
                  {!a.enumerable && (
                    <div className="jy-my-lines">
                      <p>读不到这个账号的 Key 列表。如果它有转售 Key，请手动填 Key 名：</p>
                      <ErrorDetail raw={a.error} />
                    </div>
                  )}
                  {a.tokens.length ? (
                    <div className="jy-my-keys">
                      {a.tokens.map((t) => (
                        <Checkbox key={t.name} checked={t.flagged} onChange={(e) => toggleKey(a.username, t.name, e.target.checked)}>
                          {tokenLabel(t, a.enumerable)}
                        </Checkbox>
                      ))}
                    </div>
                  ) : a.enumerable ? (
                    <p className="jy-muted" style={{ margin: 0 }}>
                      这个账号没有 Key
                    </p>
                  ) : null}
                  {!a.enumerable && (
                    <div className="jy-my-add">
                      <Input
                        size="small"
                        placeholder="Key 名"
                        aria-label={`给 ${a.username} 手动添加 Key 名`}
                        value={addInputs[a.username] || ""}
                        onChange={(e) => setAddInputs((m) => ({ ...m, [a.username]: e.target.value }))}
                        onPressEnter={() => addManualKey(a.username)}
                      />
                      <Button size="small" icon={<Icon name="plus" />} onClick={() => addManualKey(a.username)}>
                        添加
                      </Button>
                    </div>
                  )}
                </div>
              ))}
              <div className="jy-my-mgr-foot">
                <Button type="primary" loading={saving} onClick={saveResold}>
                  保存并重算
                </Button>
                <Button onClick={closeManager}>取消</Button>
              </div>
            </>
          )}
        </div>
      </More>
    </section>
  );
}

// ---- 成本明细 ------------------------------------------------------------

function CostSection({ p }: { p: any }) {
  const router = useRouter();
  const costs: any[] = p.costs || [];
  // 固定成本全部到期按笔数判断，不认 note 的文字
  const warnMode = (c: any) => c.mode === "history" || (c.total > 0 && c.expired === c.total);
  return (
    <section className="jy-my-section">
      <h3 className="jy-my-h3">
        {COPY.costsTitle}
        <CountBadge count={costs.length} muted />
        <span className="jy-caption">{COPY.costsCaption}</span>
      </h3>
      {costs.length ? (
        <DataTable<any>
          caption="算进利润的上游和成本"
          rows={costs}
          rowKey={(c, i) => `${c.stationId ?? c.name}-${i}`}
          empty="没有算进利润的上游"
          defaultSort={{ key: "cny", dir: "desc" }}
          cols={[
            {
              key: "name",
              label: "上游",
              sort: (c) => c.name,
              render: (c) => {
                const note = c.error ? noteOf(c) : null;
                return (
                  <div className="jy-res-name">
                    <b style={{ fontWeight: 500 }}>{c.name}</b>
                    {note && <span>{failureSentence(COPY.usageUnread, note.text)}</span>}
                    {note && <ErrorDetail raw={note.raw} />}
                  </div>
                );
              },
            },
            {
              key: "mode",
              label: "怎么算的",
              sort: (c) => modeText(c.mode),
              render: (c) => (
                <span style={{ display: "inline-flex", gap: 6, flexWrap: "wrap" }}>
                  {modeText(c.mode) && (
                    <span className={`jy-tag ${c.mode === "history" ? "jy-tag--warn" : "jy-tag--type"}`}>
                      {modeText(c.mode)}
                      {c.mode === "history" ? " ≈" : ""}
                    </span>
                  )}
                  {c.note && <span className={`jy-tag ${warnMode(c) ? "jy-tag--warn" : "jy-tag--muted"}`}>{c.note}</span>}
                </span>
              ),
            },
            { key: "ch", label: "渠道", render: (c) => <span className="jy-muted">{(c.channels || []).join("、")}</span> },
            { key: "cny", label: "成本", num: true, sort: (c) => c.cny, render: (c) => formatMoney(c.cny), foot: formatMoney(p.totalCostCny) },
          ]}
        />
      ) : (
        <EmptyState
          center={false}
          title="没有算进利润的上游"
          desc="上游成本和固定成本暂按 ¥0 算。在上游资源里把上游设成算进利润后，这里会列出每个上游的成本。"
          action={<Button onClick={() => router.push("/stations")}>{STATION_TABS.list}</Button>}
        />
      )}
    </section>
  );
}
