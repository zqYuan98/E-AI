// 访问统计的存取：记一次访问、后台的统计和导出、过期明细汇总后删除。日期都按北京时间算（contracts/time.ts）。
import { sql } from "@aihot/backend/db";
import { addDays, beijingDate, beijingMidnight, beijingTime, isValidDate } from "@aihot/contracts/time";
import { RANGES, RAW_DAYS, type UsageActivity, type UsageDay, type UsageEntry, type UsageMember, type UsagePage, type UsageReport } from "../types.ts";

export async function recordVisit(member: { id: number; name: string }, visit: { path: string; title: string; device: "mobile" | "desktop" }, now = new Date()): Promise<void> {
  await sql`INSERT INTO usage_visits (at, day, member_id, member_name, path, title, device)
    VALUES (${now}, ${beijingDate(now)}, ${member.id}, ${member.name}, ${visit.path}, ${visit.title}, ${visit.device})`;
}

export async function usageReport(q: { range?: number; day?: string; member?: number }, now = new Date()): Promise<UsageReport> {
  const today = beijingDate(now);
  const range = RANGES.find((r) => r === q.range) ?? 30;
  const from = addDays(today, -(range - 1));
  const day = q.day && isValidDate(q.day) && q.day <= today ? q.day : today;
  const memberId = q.member !== undefined && Number.isInteger(q.member) && q.member > 0 ? q.member : null;

  const [live, kept, [visitors], topPages, members, dayMembers, timeline] = await Promise.all([
    sql<UsageDay[]>`SELECT day::text AS day, count(*)::int AS views, count(DISTINCT member_id)::int AS visitors
      FROM usage_visits WHERE day >= ${from} AND day <= ${today} GROUP BY day`,
    sql<UsageDay[]>`SELECT day::text AS day, views, visitors FROM usage_daily WHERE day >= ${from} AND day <= ${today}`,
    sql<{ n: number }[]>`SELECT count(DISTINCT member_id)::int AS n FROM usage_visits WHERE day >= ${from}`,
    sql<UsagePage[]>`SELECT path, (array_agg(title ORDER BY at DESC))[1] AS title, count(*)::int AS views, count(DISTINCT member_id)::int AS visitors
      FROM usage_visits WHERE day >= ${from} GROUP BY path ORDER BY views DESC, path LIMIT 20`,
    sql<{ member_id: number; name: string; views: number; days: number; last_at: Date }[]>`
      SELECT member_id, (array_agg(member_name ORDER BY at DESC))[1] AS name,
        (count(*) FILTER (WHERE day >= ${from}))::int AS views, (count(DISTINCT day) FILTER (WHERE day >= ${from}))::int AS days, max(at) AS last_at
      FROM usage_visits GROUP BY member_id ORDER BY max(at) DESC`,
    sql<{ member_id: number; name: string; views: number; pages: number; last_at: Date }[]>`
      SELECT member_id, (array_agg(member_name ORDER BY at DESC))[1] AS name, count(*)::int AS views, count(DISTINCT path)::int AS pages, max(at) AS last_at
      FROM usage_visits WHERE day = ${day} GROUP BY member_id ORDER BY views DESC, member_id`,
    memberId === null ? Promise.resolve([]) : sql<{ at: Date; path: string; title: string; device: "mobile" | "desktop" }[]>`
      SELECT at, path, title, device FROM usage_visits WHERE day = ${day} AND member_id = ${memberId} ORDER BY at LIMIT 500`,
  ]);

  // 一天的明细要么还在 usage_visits，要么已汇总进 usage_daily，两边不会同时有。
  const byDay = new Map([...kept, ...live].map((d) => [d.day, d]));
  const trend: UsageDay[] = [];
  for (let d = from; d <= today; d = addDays(d, 1)) trend.push(byDay.get(d) ?? { day: d, views: 0, visitors: 0 });

  return {
    today, range, day, memberId,
    totals: { views: trend.reduce((sum, d) => sum + d.views, 0), visitors: visitors?.n ?? 0 },
    trend,
    dayMembers: dayMembers.map((r): UsageMember => ({ memberId: r.member_id, name: r.name, views: r.views, pages: r.pages, lastAt: r.last_at.toISOString() })),
    timeline: timeline.map((r): UsageEntry => ({ at: r.at.toISOString(), path: r.path, title: r.title, device: r.device })),
    topPages,
    members: members.map((r): UsageActivity => ({ memberId: r.member_id, name: r.name, views: r.views, days: r.days, lastAt: r.last_at.toISOString() })),
    retentionDays: RAW_DAYS,
  };
}

const EXPORT_ROWS = 100_000;
const bad = (message: string) => Object.assign(new Error(message), { statusCode: 400 });

/** 导出 from 到 to（含，北京时间日期）的明细，最多 180 天、10 万行。 */
export async function exportVisits(from: unknown, to: unknown): Promise<{ csv: string; rows: number; from: string; to: string }> {
  if (typeof from !== "string" || typeof to !== "string" || !isValidDate(from) || !isValidDate(to)) throw bad("from 和 to 要写成 YYYY-MM-DD");
  if (to < from) throw bad("结束日期不能早于开始日期");
  if ((beijingMidnight(to).getTime() - beijingMidnight(from).getTime()) / 86_400_000 >= RAW_DAYS) throw bad(`一次最多导出 ${RAW_DAYS} 天`);
  const rows = await sql<{ at: Date; member_name: string; path: string; title: string; device: string }[]>`
    SELECT at, member_name, path, title, device FROM usage_visits WHERE day >= ${from} AND day <= ${to} ORDER BY at LIMIT ${EXPORT_ROWS}`;
  const lines = [["日期", "时间", "成员", "页面", "标题", "设备"], ...rows.map((r) => [beijingDate(r.at), beijingTime(r.at), r.member_name, r.path, r.title, r.device === "mobile" ? "手机" : "电脑"])];
  // 带 BOM，Excel 才按 UTF-8 打开；以 = + - @ 开头的单元格前面补一个 '，打开时不会被当成公式。
  return { csv: `\uFEFF${lines.map((line) => line.map(cell).join(",")).join("\r\n")}\r\n`, rows: rows.length, from, to };
}

function cell(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

/** 明细只留 RAW_DAYS 天：过期的日子先汇总成当天的总量，再删明细，同一个事务。 */
export async function rollUpOldVisits(now: Date): Promise<{ usageDaysRolledUp: number; usageVisitsRemoved: number }> {
  const cutoff = addDays(beijingDate(now), -RAW_DAYS);
  return sql.begin(async (tx) => {
    const rolled = await tx`INSERT INTO usage_daily (day, views, visitors)
      SELECT day, count(*)::int, count(DISTINCT member_id)::int FROM usage_visits WHERE day < ${cutoff} GROUP BY day`;
    const removed = await tx`DELETE FROM usage_visits WHERE day < ${cutoff}`;
    return { usageDaysRolledUp: rolled.count, usageVisitsRemoved: removed.count };
  });
}
