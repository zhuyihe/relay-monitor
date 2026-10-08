import { createHash } from "node:crypto";

function localDate(ms, timezone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date(ms));
  const get = (type) => parts.find((part) => part.type === type)?.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export function reconciliationScopeFingerprint(rule, segments) {
  const scope = {
    upstreamStationId: rule.upstreamStationId,
    ownStationId: rule.ownStationId,
    tokenId: Number(rule.tokenId),
    tokenName: rule.tokenName,
    timezone: rule.timezone,
    channelIds: rule.channels.map((channel) => Number(channel.channelId)).sort((a, b) => a - b),
    segments: segments.map((segment) => ({
      id: segment.id,
      group: segment.group,
      ratio: segment.ratio,
      effectiveFrom: segment.effectiveFrom,
      effectiveTo: segment.effectiveTo,
    })),
  };
  return createHash("sha256").update(JSON.stringify(scope)).digest("hex").slice(0, 24);
}

export function reconciliationSnapshotIdentity(window, scopeFingerprint) {
  if (window.preset === "today") return `today:${localDate(window.startMs, window.timezone)}:${window.timezone}:${scopeFingerprint}`;
  if (window.preset === "7d") return `7d:${window.startMs}:${window.timezone}:${scopeFingerprint}`;
  return `${window.preset}:${window.startMs}:${window.endMs}:${window.timezone}:${scopeFingerprint}`;
}
