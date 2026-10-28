// 系统自己试读上游（上游监控简化第 2 条）：「这把 Key 属于哪个上游账号」「能读到完整账单」「按哪个时区算一天」不再让人去点「测试读取」。
// 加上游、改登录信息以后马上试一次，之后一天一次；试失败了按退避再试（30 分钟、1 小时、2 小时、6 小时封顶），不跟着每次刷新去读。
// 试的内容和编辑页「测试读取」一样：读 Key 目录和账号身份（身份没确认过就自己确认），再拿一把已经绑了的 Key 试读一次完整账单（记下账单能力和时区）。
// 登录信息不对这类失败不在这里说：余额读不到时已经有「登录信息不对或过期了」那条需处理。自营站点、只用 Key 的上游不在这几类确认里。
import { ACCOUNT_TYPE_VALUES, storedIdentity } from "../lib/channel-onboarding.js";

const DAY_MS = 24 * 3600 * 1000;
export const AUTO_VERIFY_BACKOFF_MS = Object.freeze([30 * 60 * 1000, 3600 * 1000, 2 * 3600 * 1000, 6 * 3600 * 1000]);

export function createAutoVerifier(rt, { now = () => Date.now() } = {}) {
  // 上游 id → { nextAt, failures, running }；重启后每个上游先试一次
  const states = new Map();
  const eligible = (station) => station && !station.archivedAt && !station.isOwn && station.monitorEnabled !== false && ACCOUNT_TYPE_VALUES.includes(station.type);

  async function readOnce(station) {
    const reconciliation = rt.reconciliation, onboarding = rt.channelOnboarding;
    if (!reconciliation || !onboarding) throw new Error("NOT_READY");
    const read = await reconciliation.getUpstreamKeys(station.id, { force: true });
    if (read?.identity && !storedIdentity(rt.store.get(station.id) || station)) {
      await onboarding.confirmResourceIdentity(station.id, { identity: read.identity, resourceVersion: read.resourceVersion });
    }
    const rules = await reconciliation.listRules();
    const rule = rules.find((item) => item.upstreamStationId === station.id && item.enabled && !item.archivedAt && item.tokenId != null);
    if (rule) await reconciliation.getUpstreamKeys(station.id, { force: true, tokenId: rule.tokenId, ...(rule.timezone ? { timezone: rule.timezone } : {}) });
  }

  // 试一个上游；返回有没有成。同一个上游同时只试一次
  async function verify(station) {
    if (!eligible(station)) return false;
    const state = states.get(station.id) || { nextAt: 0, failures: 0, running: false };
    if (state.running) return false;
    state.running = true; states.set(station.id, state);
    try {
      await readOnce(station);
      state.failures = 0; state.nextAt = now() + DAY_MS;
      return true;
    } catch {
      state.nextAt = now() + AUTO_VERIFY_BACKOFF_MS[Math.min(state.failures, AUTO_VERIFY_BACKOFF_MS.length - 1)];
      state.failures += 1;
      return false;
    } finally { state.running = false; }
  }

  // 到点的上游各试一次（轮询每轮调用，没到点的不读）
  async function verifyDue() {
    const at = now();
    for (const station of rt.store.list()) {
      if (!eligible(station)) continue;
      if ((states.get(station.id)?.nextAt ?? 0) > at) continue;
      await verify(station);
    }
  }

  // 加上游、改了登录信息：马上排到第一位，不等一天
  function verifySoon(station) {
    states.delete(station?.id);
    return verify(station).catch(() => false);
  }

  return { verify, verifyDue, verifySoon, states };
}
