import type { ProfitPageResponse } from "../../lib/client";
import type { TrendDay, UsersRow } from "./users/users-format";

export type OverviewPeriod = "today" | "yesterday";
export type OverviewIncome = { amount: number | null; asOf: number | null; reason: string | null; channels: { channelId: number; amount: number }[] };
export type OverviewPageData = {
  unset?: boolean; preset: OverviewPeriod; day: string; today: string; now: number; tz: string;
  own: { id: string; name: string; rate: number };
  financial: OverviewIncome; profit: ProfitPageResponse | null;
  users: { ready: boolean; balanceReady: boolean; usageAt: number | null; balanceAt: number | null; paused: boolean; fresh: boolean;
    consumption: { amount: number | null; asOf: number | null };
    activity: { count: number; top: { username: string; cost: number }[] } | null;
    customers: (Omit<UsersRow, "today"> & { today: number | null })[]; trend: TrendDay[]; reminderCount: number | null; syncErrors: string[] };
  coverage: { day: string; total: number | null; asOf: number | null; covered: number | null; missing: number | null; ratio: number | null;
    counted: number | null; known: number | null; timeWindowState: "matched" | "unknown" | "different"; missingChannels: { channelId: number; name: string; amount: number; status: string }[] };
  upstreams: any[]; rules: any; settings: any; intervalMs: number; errors: Record<string, string>;
};
