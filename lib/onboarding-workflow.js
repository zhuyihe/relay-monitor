import { onboardingBaseUrl } from "./channel-onboarding.js";

export function onboardingMonitorIds(channel) {
  return [...new Set(channel.monitor?.links?.map((link) => link.stationId) || channel.monitor?.stationIds || [])];
}

export function sameOnboardingIdentity(left, right) {
  return !!left && !!right && left.provider === right.provider
    && !!onboardingBaseUrl(left.baseUrl) && onboardingBaseUrl(left.baseUrl) === onboardingBaseUrl(right.baseUrl)
    && String(left.accountId) === String(right.accountId);
}

// 这里只用已保存的信息预填表单，最终以服务端预览为准。
export function onboardingKeyContext(model, resourceId, identity, tokenId, ownSource, rules = []) {
  const account = model?.accounts.find((entry) => entry.resources.some((resource) => resource.id === resourceId));
  if (!account || !sameOnboardingIdentity(account.identity, identity)) return null;
  const scope = account.keys.find((entry) => entry.tokenId === Number(tokenId));
  if (!scope) return null;
  const associations = scope.associations.filter((entry) => entry.status === "active" && entry.ownStationId === ownSource?.stationId);
  if (scope.scopeAmbiguous || associations.length !== 1) return null;
  const association = associations[0];
  const rule = rules.find((entry) => entry.id === association.ruleId);
  if (!ownSource?.namespaceKey || !rule?.enabled || rule.archivedAt || rule.ownSource?.namespaceKey !== ownSource.namespaceKey) return null;
  return association;
}

export function retainOnboardingRequest(pending, intent) {
  return [...pending.filter((entry) => entry.requestId !== intent.requestId), intent];
}
