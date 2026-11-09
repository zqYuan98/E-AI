/** 个人明细保留的天数；更早的只剩每天的总量。 */
export const RAW_DAYS = 180;
/** 后台可选的统计范围（天）。 */
export const RANGES = [7, 30, 90, 365] as const;

export interface UsageDay { day: string; views: number; visitors: number }
export interface UsageMember { memberId: number; name: string; views: number; pages: number; lastAt: string }
export interface UsageActivity { memberId: number; name: string; views: number; days: number; lastAt: string }
export interface UsagePage { path: string; title: string; views: number; visitors: number }
export interface UsageEntry { at: string; path: string; title: string; device: "mobile" | "desktop" }

export interface UsageReport {
  /** 北京时间的今天。 */
  today: string;
  range: number;
  /** 下面“按天看”选的那一天，和它里面选中的成员。 */
  day: string;
  memberId: number | null;
  /** 范围内的访问次数；访问人数只数还留着明细的日子。 */
  totals: { views: number; visitors: number };
  /** 范围内每天一项，没人访问的日子补 0。 */
  trend: UsageDay[];
  /** 选中那天每个成员的访问，次数多的在前。 */
  dayMembers: UsageMember[];
  /** 选中的成员那天按时间的访问。 */
  timeline: UsageEntry[];
  /** 范围内访问最多的页面。 */
  topPages: UsagePage[];
  /** 有过访问的成员，最近访问的在前；views 和 days 只数范围内的。 */
  members: UsageActivity[];
  retentionDays: number;
}
