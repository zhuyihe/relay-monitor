// 自包含的首页接口夹具；合成客户与供应商只供测试及本地截图，正式首页不读取本文件。
const snapshot = {
  "capturedAt": "2026-11-22T02:22:02.027Z",
  "balanceAt": 1795314063027,
  "usageAt": 1795314063027,
  "weekUsers": 22,
  "today": {
    "spend": 4775.92026,
    "financialAt": 1795314121000,
    "active": 11,
    "covered": 4688.700822,
    "cost": 4140.5686372705,
    "margin": 548.1321847294994,
    "profitAt": "2026-11-22T02:16:57.000Z"
  },
  "yesterday": {
    "spend": 20506.255596000003,
    "financialAt": "2026-11-21T16:00:00.000Z",
    "active": 15,
    "covered": 19850.781218,
    "missing": 655.474378,
    "cost": 16985.72512323,
    "margin": 2865.056094769996,
    "profitAt": "2026-11-22T01:37:00.000Z",
    "topCustomers": [
      {
        "username": "sample-a",
        "cost": 9296.433317999998
      },
      {
        "username": "sample-b",
        "cost": 2570.9512019999997
      },
      {
        "username": "sample-c",
        "cost": 2406.891119999999
      }
    ]
  },
  "customers": [
    {
      "id": 101,
      "username": "sample-a",
      "today": 3458.7532119999996,
      "balanceUsd": 20907.012826,
      "days": 2,
      "runwayState": "ok",
      "big": true
    },
    {
      "id": 102,
      "username": "sample-b",
      "today": 560.993056,
      "balanceUsd": 16619.836206,
      "days": 0.5,
      "runwayState": "soon",
      "big": true
    },
    {
      "id": 103,
      "username": "sample-c",
      "today": 259.348994,
      "balanceUsd": 6329.910592,
      "days": 9.3,
      "runwayState": "ok",
      "big": false
    },
    {
      "id": 104,
      "username": "sample-d",
      "today": 171.65529,
      "balanceUsd": 5988.72689,
      "days": 1.6,
      "runwayState": "ok",
      "big": false
    },
    {
      "id": 105,
      "username": "sample-e",
      "today": 106.49302800000001,
      "balanceUsd": 2719.74745,
      "days": null,
      "runwayState": "warming",
      "big": false
    },
    {
      "id": 106,
      "username": "sample-f",
      "today": 85.76548000000001,
      "balanceUsd": 851.724906,
      "days": 0.2,
      "runwayState": "soon",
      "big": false
    },
    {
      "id": 107,
      "username": "sample-g",
      "today": 56.860071999999995,
      "balanceUsd": 875.969666,
      "days": 0.9,
      "runwayState": "ok",
      "big": false
    },
    {
      "id": 108,
      "username": "sample-h",
      "today": 14.76856,
      "balanceUsd": 447.427622,
      "days": 3,
      "runwayState": "ok",
      "big": false
    },
    {
      "id": 109,
      "username": "sample-i",
      "today": 7.449924,
      "balanceUsd": 846.344864,
      "days": 14.9,
      "runwayState": "ok",
      "big": false
    },
    {
      "id": 110,
      "username": "sample-j",
      "today": 0.026948,
      "balanceUsd": 7462.20512,
      "days": 0.2,
      "runwayState": "soon",
      "big": true
    },
    {
      "id": 111,
      "username": "sample-k",
      "today": 0.00898,
      "balanceUsd": 6664.550248,
      "days": 723.7,
      "runwayState": "ok",
      "big": false
    }
  ],
  "suppliers": [
    {
      "name": "示例上游 A",
      "shortName": "示例上游 A",
      "balance": 4460.3,
      "days": 0.4,
      "balanceAt": "2026-11-22T02:21:03.172Z",
      "currency": "$"
    },
    {
      "name": "示例上游 B",
      "shortName": "示例上游 B",
      "balance": 657.16,
      "days": 40.9,
      "balanceAt": "2026-11-22T02:21:03.192Z",
      "currency": "$"
    },
    {
      "name": "示例上游 C",
      "shortName": "示例上游 C",
      "balance": 415.44,
      "days": 0.5,
      "balanceAt": "2026-11-22T02:21:03.152Z",
      "currency": "$"
    },
    {
      "name": "示例上游 D",
      "shortName": "示例上游 D",
      "balance": 3913.68,
      "days": 2.9,
      "balanceAt": "2026-11-22T02:21:03.174Z",
      "currency": "¥"
    },
    {
      "name": "示例上游 E",
      "shortName": "示例上游 E",
      "balance": 33370.57,
      "days": 1.7,
      "balanceAt": "2026-11-22T02:21:03.199Z",
      "currency": "¥"
    },
    {
      "name": "示例上游 F",
      "shortName": "示例上游 F",
      "balance": 6469.44,
      "days": 2.2,
      "balanceAt": "2026-11-22T02:21:03.122Z",
      "currency": "¥"
    },
    {
      "name": "示例上游 G",
      "shortName": "示例上游 G",
      "balance": 1034.87,
      "days": 1.9,
      "balanceAt": "2026-11-22T02:21:03.437Z",
      "currency": "¥"
    },
    {
      "name": "示例上游 H",
      "shortName": "示例上游 H",
      "balance": 42051.53,
      "days": 6.2,
      "balanceAt": "2026-11-22T02:21:03.765Z",
      "currency": "$"
    }
  ],
  "trend": [
    {
      "day": "2026-11-15",
      "cost": 1269.055694,
      "users": 3
    },
    {
      "day": "2026-11-16",
      "cost": 4253.8191959999995,
      "users": 5
    },
    {
      "day": "2026-11-17",
      "cost": 3321.1749699999996,
      "users": 9
    },
    {
      "day": "2026-11-18",
      "cost": 42789.168642000004,
      "users": 9
    },
    {
      "day": "2026-11-19",
      "cost": 124151.90029399999,
      "users": 13
    },
    {
      "day": "2026-11-20",
      "cost": 133449.818574,
      "users": 15
    },
    {
      "day": "2026-11-21",
      "cost": 20469.246979999993,
      "users": 15
    },
    {
      "day": "2026-11-22",
      "cost": 4722.123543999998,
      "users": 11
    }
  ],
  "missingChannels": [
    {
      "id": 25,
      "name": "示例渠道 A",
      "amount": 591.187692,
      "reason": "尚未进入对账"
    },
    {
      "id": 39,
      "name": "示例渠道 B",
      "amount": 57.871024,
      "reason": "尚未进入对账"
    },
    {
      "id": 29,
      "name": "示例渠道 C",
      "amount": 6.41351,
      "reason": "尚未进入对账"
    },
    {
      "id": 27,
      "name": "示例渠道 D",
      "amount": 0.002152,
      "reason": "尚未进入对账"
    }
  ],
  "closedWeekUsers": 22
};

export function overviewFixture(preset = "today") {
  const selected = snapshot[preset], yesterday = snapshot.yesterday;
  return {
    preset, day: preset === "today" ? "2026-11-22" : "2026-11-21", today: "2026-11-22", now: Date.parse(snapshot.capturedAt), tz: "Asia/Shanghai",
    own: { id: "own", name: "初光云序", rate: 1 },
    financial: { amount: selected.spend, asOf: Number.isFinite(selected.financialAt) ? selected.financialAt : Date.parse(selected.financialAt), channels: [], reason: null },
    profit: { asOf: selected.profitAt, accountingTotals: { income: selected.covered, actual: selected.cost, gross: selected.margin, fixedCost: 0, net: selected.margin }, displayCurrency: "USD" },
    users: { consumption: { amount: preset === "today" ? snapshot.customers.reduce((total, user) => total + user.today, 0) : snapshot.trend.find(day => day.day === "2026-11-21").cost, asOf: snapshot.usageAt }, ready: true, balanceReady: true, usageAt: snapshot.usageAt, balanceAt: snapshot.balanceAt, paused: false, fresh: true, syncErrors: [],
      activity: { count: selected.active, top: preset === "yesterday" ? yesterday.topCustomers : snapshot.customers.slice(0, 3).map(user => ({ username: user.username, cost: user.today })) },
      customers: snapshot.customers, trend: snapshot.trend.map(day => ({ ...day, available: true, top: day.day === "2026-11-21" ? yesterday.topCustomers : [], newUsers: 0, newTop: [] })), reminderCount: 3 },
    coverage: { day: "2026-11-21", total: yesterday.spend, asOf: Date.parse(yesterday.financialAt), covered: yesterday.covered, missing: yesterday.missing, ratio: yesterday.covered / yesterday.spend, counted: 12, known: 40, timeWindowState: "matched",
      missingChannels: snapshot.missingChannels.map(channel => ({ channelId: channel.id, name: channel.name, amount: channel.amount, status: "unlinked" })) },
    upstreams: snapshot.suppliers.map((station, index) => ({ id: `supplier-${index}`, name: station.name, type: "newapi", cnyPerUsd: station.currency === "$" ? 1 : null,
      prediction: { etaDays: station.days, burnPerDay: station.days ? station.balance / station.days : 0 }, balance: { ok: true, remaining: station.balance, checkedAt: station.balanceAt } })),
    settings: { refreshIntervalSec: 60, lowBalanceUsd: 5 }, rules: { etaDays: 3 }, intervalMs: 60000, errors: {},
  };
}
