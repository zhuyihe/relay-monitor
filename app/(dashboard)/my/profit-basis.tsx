"use client";
// 利润口径：收入与成本怎么算、口径提示、转售 Key（含管理器）、每个上游的成本明细。
// 默认收起：日常看等式就够了，核对口径时才展开。
import { useState } from "react";
import { useRouter } from "next/navigation";
import { App, Button, Checkbox, Input } from "antd";
import { api } from "../../../lib/client";
import { formatMoney } from "../../../lib/format";
import { EmptyState, ErrorState } from "../../components/data-state";
import { Icon, Sym } from "../../components/icons";
import { CountBadge, Panel } from "../../components/panel";
import { StatusTag } from "../../components/status";
import { DataTable, MODE_LABEL, ROLE_LABEL, productErrorMessage } from "./shared";
import type { OwnView } from "./shared";

// GET /api/own/admin-keys 的账号与 Key
type AdminToken = { name: string; status?: number; usedUsd: number | null; flagged: boolean };
type AdminAccount = { username: string; role: number; enumerable: boolean; error?: string; tokens: AdminToken[] };

export function ProfitBasis({
  v,
  open,
  onToggle,
  reload,
}: {
  v: OwnView;
  open: boolean;
  onToggle: () => void;
  reload: () => Promise<unknown>;
}) {
  const p = v.profit;
  const ok = p && !p.error;
  const warnings: string[] = ok ? p.warnings || [] : [];
  const summary = ok ? (
    <>
      收入 <b>{formatMoney(p.incomeCny)}</b>，成本 <b>{formatMoney(p.totalCostCny)}</b>，{(p.resoldKeys || []).length} 个转售 Key，
      {(p.costs || []).length} 个上游计入成本{warnings.length ? `，${warnings.length} 条口径提示` : ""}。
    </>
  ) : (
    "利润数据暂时取不到，口径明细也无法显示。"
  );

  return (
    <Panel
      title="利润口径"
      className={open ? undefined : "jy-my-collapsed"}
      extra={
        <Button size="small" aria-expanded={open} icon={<Icon name={open ? "collapse" : "expand"} />} onClick={onToggle}>
          {open ? "收起" : "展开"}
        </Button>
      }
      sub={summary}
      body={open && ok}
    >
      {open && ok ? (
        <>
          <section className="jy-my-section">
            <div className="jy-my-lines">
              <p>收入 = 普通用户消费 × 售价汇率，不含管理员和 root 自用；已标记为转售的管理员 Key 算作收入。</p>
              <p>成本按各上游自己的口径计入，统计窗口 {+Number(p.windowDays || 0).toFixed(2)} 天。</p>
            </div>
            {warnings.length > 0 && (
              <div className={`jy-banner${p.complete ? " jy-banner--info" : ""}`} role="status">
                <Sym kind={p.complete ? "info" : "warn"} />
                <div>
                  <strong>{!p.complete ? "利润数据尚不完整" : p.estimated ? "成本中包含估算值" : "口径提示"}</strong>
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
        </>
      ) : null}
    </Panel>
  );
}

// ---- 转售 Key ------------------------------------------------------------

function ResoldSection({ v, reload }: { v: OwnView; reload: () => Promise<unknown> }) {
  const { message } = App.useApp();
  const p = v.profit;
  const keys: any[] = p.resoldKeys || [];
  const [mgrOpen, setMgrOpen] = useState(false);
  const [mgrLoading, setMgrLoading] = useState(false);
  const [mgrError, setMgrError] = useState<string | null>(null);
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
      setMgrError(productErrorMessage(e));
    } finally {
      setMgrLoading(false);
    }
  };

  const closeManager = () => {
    setMgrOpen(false);
    setAccounts(null);
    setMgrError(null);
  };
  const toggleManager = () => {
    if (mgrOpen) return closeManager();
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
      message.error(productErrorMessage(e));
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
        转售 Key
        <CountBadge count={keys.length} muted />
        <span className="spacer" />
        <Button size="small" aria-expanded={mgrOpen} onClick={toggleManager}>
          {mgrOpen ? "收起" : "管理转售 Key"}
        </Button>
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
              render: (k) =>
                k.error ? (
                  <>
                    <StatusTag level="warn">查询失败</StatusTag>
                    <span className="jy-sub-money">{k.error}</span>
                  </>
                ) : (
                  <span className="jy-muted">转售给下游，计入收入</span>
                ),
            },
            { key: "cny", label: "期内收入", num: true, sort: (k) => k.cny || 0, render: (k) => formatMoney(k.cny || 0) },
          ]}
        />
      ) : (
        <div className="jy-my-lines">
          <p>还没有标记转售 Key。若某个管理员或 root 账号的 API Key 实际给了下游，点「管理转售 Key」勾选它，它的消费就会计入收入。</p>
        </div>
      )}

      {mgrOpen && (
        <div className="jy-my-mgr">
          {mgrLoading ? (
            <p className="jy-muted" aria-busy="true" style={{ margin: 0 }}>
              正在拉取管理员账号的 Key…
            </p>
          ) : mgrError ? (
            <ErrorState title="管理员账号的 Key 拉取失败" error={mgrError} onRetry={fetchAccounts} />
          ) : !accounts || !accounts.length ? (
            <EmptyState center={false} title="没有找到管理员或 root 账号" desc="转售 Key 只能从 role ≥ 10 的账号里选。" />
          ) : (
            <>
              <div className="jy-my-lines">
                <p>
                  勾选实际转售给下游的 Key，它在期内的消费会从「管理员自用（成本）」改计入「收入 × 售价汇率」。Key
                  名可能跨账号重名，所以按「账号 + Key 名」定位。
                </p>
              </div>
              {accounts.map((a) => (
                <div key={a.username} className="jy-my-account">
                  <h4>
                    {a.username}
                    <span className="jy-tag jy-tag--type">{ROLE_LABEL[a.role] || `role ${a.role}`}</span>
                  </h4>
                  {!a.enumerable && (
                    <div className="jy-my-lines">
                      <p>此账号无法自动列出 Key（{a.error || "接口限制"}）。若它有转售 Key，请手动填 Key 名：</p>
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
                      该账号没有 API Key
                    </p>
                  ) : null}
                  {!a.enumerable && (
                    <div className="jy-my-add">
                      <Input
                        size="small"
                        placeholder="Key 名（token_name）"
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
      )}
    </section>
  );
}

// ---- 成本明细 ------------------------------------------------------------

function CostSection({ p }: { p: any }) {
  const router = useRouter();
  const costs: any[] = p.costs || [];
  const warnMode = (c: any) => c.mode === "history" || c.note === "已到期" || c.note === "已全部到期";
  return (
    <section className="jy-my-section">
      <h3 className="jy-my-h3">
        成本明细
        <CountBadge count={costs.length} muted />
        <span className="jy-caption">按各上游口径计入期内成本</span>
      </h3>
      {costs.length ? (
        <DataTable<any>
          caption="计入毛利的上游与期内成本"
          rows={costs}
          rowKey={(c, i) => `${c.stationId ?? c.name}-${i}`}
          empty="没有计入毛利的上游"
          defaultSort={{ key: "cny", dir: "desc" }}
          cols={[
            {
              key: "name",
              label: "上游",
              sort: (c) => c.name,
              render: (c) => (
                <div className="jy-res-name">
                  <b style={{ fontWeight: 500 }}>{c.name}</b>
                  {c.error && <span title={c.error}>{c.error}</span>}
                </div>
              ),
            },
            {
              key: "mode",
              label: "口径",
              sort: (c) => MODE_LABEL[c.mode] || c.mode,
              render: (c) => (
                <span style={{ display: "inline-flex", gap: 6, flexWrap: "wrap" }}>
                  <span className={`jy-tag ${c.mode === "history" ? "jy-tag--warn" : "jy-tag--type"}`}>
                    {MODE_LABEL[c.mode] || c.mode}
                    {c.mode === "history" ? " ≈" : ""}
                  </span>
                  {c.note && <span className={`jy-tag ${warnMode(c) ? "jy-tag--warn" : "jy-tag--muted"}`}>{c.note}</span>}
                </span>
              ),
            },
            { key: "ch", label: "渠道", render: (c) => <span className="jy-muted">{(c.channels || []).join("、")}</span> },
            { key: "cny", label: "期内成本", num: true, sort: (c) => c.cny, render: (c) => formatMoney(c.cny), foot: formatMoney(p.totalCostCny) },
          ]}
        />
      ) : (
        <EmptyState
          center={false}
          title="没有计入毛利的上游"
          desc="用量成本暂按 ¥0 计。在上游资源里把上游设为计入利润成本后，这里会列出每个上游的期内成本。"
          action={<Button onClick={() => router.push("/stations")}>去上游资源设置</Button>}
        />
      )}
    </section>
  );
}
