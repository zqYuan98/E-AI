// 后台“访问统计”：最近一段时间每天的访问次数和人数、按天看每个成员访问了哪些页面、热门页面、成员活跃度，明细可导出。
// 只统计成员；管理员自己的访问不计入。个人明细只保留 180 天，更早的只剩每天的总量。
import { Form, Link, useLoaderData, type LoaderFunctionArgs } from "react-router";
import { addDays, beijingTime } from "@aihot/contracts/time";
import { adminGet } from "@aihot/web/lib/admin.server";
import { AdminPage, Badge, Card, DataTable, FilterChips, Stat, Time, type Column } from "@aihot/web/features/admin/ui";
import { buttonClass } from "@aihot/web/components/ui/Controls";
import { RAW_DAYS, type UsageActivity, type UsageDay, type UsageEntry, type UsageMember, type UsagePage, type UsageReport } from "../types.ts";

interface AccessMember { id: number; name: string; disabled: boolean }

export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const query = new URLSearchParams();
  for (const key of ["range", "day", "member"]) {
    const value = url.searchParams.get(key);
    if (value) query.set(key, value);
  }
  // 成员名单来自访问模块的接口：用它找出还没有访问过的账号。读不到就只列有过访问的。
  const [report, members] = await Promise.all([
    adminGet<UsageReport>(request, `/api/admin/usage?${query}`),
    adminGet<{ rows: AccessMember[] }>(request, "/api/admin/access/members").then((r) => r.rows, () => [] as AccessMember[]),
  ]);
  return { report, members };
}
export const meta = () => [{ title: "访问统计" }, { name: "robots", content: "noindex, nofollow" }];

const DEVICE = { mobile: "手机", desktop: "电脑" } as const;
const RANGE_OPTIONS = [{ value: "7", label: "近 7 天" }, { value: "", label: "近 30 天" }, { value: "90", label: "近 90 天" }, { value: "365", label: "近一年" }];

/** 一天一根柱子，高度是访问次数；光标停在柱子上看当天的次数和人数。 */
function TrendBars({ trend }: { trend: UsageDay[] }) {
  const W = 720;
  const H = 150;
  const top = Math.max(1, ...trend.map((d) => d.views));
  const step = W / trend.length;
  const bar = Math.max(1, step - (trend.length > 120 ? 0 : 2));
  const shown = [trend[0], trend[Math.floor(trend.length / 2)], trend[trend.length - 1]].filter((d): d is UsageDay => !!d);
  return (
    <figure>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="每天的访问次数" className="w-full" preserveAspectRatio="none">
        {trend.map((d, i) => {
          const h = (d.views / top) * (H - 8);
          return <rect key={d.day} x={i * step} y={H - h} width={bar} height={h} rx={1} className="fill-accent/70"><title>{`${d.day}：${d.views} 次，${d.visitors} 人`}</title></rect>;
        })}
      </svg>
      <figcaption className="num mt-1.5 flex justify-between text-[11.5px] text-ink-4">
        {shown.map((d) => <span key={d.day}>{d.day.slice(5)}</span>)}
        <span>最高 {top} 次/天</span>
      </figcaption>
    </figure>
  );
}

export default function UsageAdmin() {
  const { report, members } = useLoaderData<typeof loader>();
  const { today, range, day, memberId } = report;
  const href = (next: { day?: string; member?: number | null }) => {
    const q = new URLSearchParams();
    if (range !== 30) q.set("range", String(range));
    if ((next.day ?? day) !== today) q.set("day", next.day ?? day);
    if (next.member) q.set("member", String(next.member));
    return `?${q}`;
  };

  const todayTotals = report.trend.at(-1);
  const exportFrom = addDays(today, -(Math.min(range, RAW_DAYS) - 1));
  const picked = report.dayMembers.find((m) => m.memberId === memberId);

  // 账号都在名单里：没访问过的排在有访问的后面，停用的账号标出来。
  const seen = new Set(report.members.map((m) => m.memberId));
  const idle = members.filter((m) => !seen.has(m.id));
  const activity: Array<UsageActivity | (AccessMember & { never: true })> = [...report.members, ...idle.map((m) => ({ ...m, never: true as const }))];
  const disabled = new Set(members.filter((m) => m.disabled).map((m) => m.id));

  const dayColumns: Column<UsageMember>[] = [
    { key: "name", label: "成员", render: (m) => <Link className="font-medium text-accent hover:underline" to={href({ member: m.memberId })} preventScrollReset>{m.name}</Link> },
    { key: "views", label: "访问次数", align: "right", render: (m) => <span className="num">{m.views}</span> },
    { key: "pages", label: "不同页面", align: "right", render: (m) => <span className="num">{m.pages}</span> },
    { key: "last", label: "最后访问", render: (m) => <Time at={m.lastAt} /> },
  ];
  const timelineColumns: Column<UsageEntry>[] = [
    { key: "at", label: "时间", render: (e) => <span className="num">{beijingTime(e.at)}</span> },
    { key: "page", label: "页面", render: (e) => <div className="min-w-0"><div className="truncate">{e.title || e.path}</div><div className="truncate text-[11.5px] text-ink-4">{e.path}</div></div> },
    { key: "device", label: "设备", render: (e) => DEVICE[e.device] },
  ];
  const pageColumns: Column<UsagePage>[] = [
    { key: "page", label: "页面", render: (p) => <div className="min-w-0"><div className="truncate">{p.title || p.path}</div><div className="truncate text-[11.5px] text-ink-4">{p.path}</div></div> },
    { key: "views", label: "访问次数", align: "right", render: (p) => <span className="num">{p.views}</span> },
    { key: "visitors", label: "人数", align: "right", render: (p) => <span className="num">{p.visitors}</span> },
  ];
  const activityColumns: Column<(typeof activity)[number]>[] = [
    { key: "name", label: "成员", render: (m) => {
      const id = "memberId" in m ? m.memberId : m.id;
      return <span className="inline-flex items-center gap-2">{m.name}{"never" in m && <Badge>从未访问</Badge>}{disabled.has(id) && <Badge tone="warn">已停用</Badge>}</span>;
    } },
    { key: "views", label: "范围内次数", align: "right", render: (m) => <span className="num">{"views" in m ? m.views : 0}</span> },
    { key: "days", label: "活跃天数", align: "right", render: (m) => <span className="num">{"days" in m ? m.days : 0}</span> },
    { key: "last", label: "最近访问", render: (m) => <Time at={"lastAt" in m ? m.lastAt : null} /> },
  ];

  return (
    <AdminPage
      title="访问统计"
      subtitle={`成员每打开一个页面记一次，不记管理员自己的访问，也不记搜索词和 IP。个人访问明细保留 ${report.retentionDays} 天，更早的只剩每天的总量。`}
      actions={<a className={buttonClass("secondary")} href={`/api/admin/usage/export?from=${exportFrom}&to=${today}`} download>导出明细（近 {Math.min(range, RAW_DAYS)} 天）</a>}
    >
      <div className="space-y-5">
        <FilterChips param="range" options={RANGE_OPTIONS} />
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat label="访问次数" value={report.totals.views} hint={`近 ${range} 天`} />
          <Stat label="访问人数" value={report.totals.visitors} hint={range > RAW_DAYS ? `只数最近 ${RAW_DAYS} 天` : `近 ${range} 天有访问的成员`} />
          <Stat label="今天" value={todayTotals?.views ?? 0} hint={`${todayTotals?.visitors ?? 0} 人`} />
          <Stat label="平均每天" value={Math.round(report.totals.views / report.trend.length)} hint="次" />
        </div>

        <Card title="每天的访问次数">
          <TrendBars trend={report.trend} />
        </Card>

        <Card title="按天看谁访问了什么">
          <Form method="get" className="mb-3 flex flex-wrap items-center gap-2 px-3 text-[12.5px] text-ink-3">
            {range !== 30 && <input type="hidden" name="range" value={range} />}
            <label htmlFor="usage-day">日期</label>
            <input id="usage-day" type="date" name="day" defaultValue={day} max={today} className="h-9 rounded-full border border-line-strong bg-surface px-3 text-[12.5px] text-ink-2" />
            <button type="submit" className={`${buttonClass("secondary")} whitespace-nowrap`}>查看</button>
          </Form>
          <DataTable rows={report.dayMembers} columns={dayColumns} rowKey={(m) => m.memberId} empty={`${day} 没有成员访问`} />
          {memberId !== null && (
            <div className="mt-4 border-t border-line pt-4">
              <div className="mb-2 flex items-center justify-between text-[13px] text-ink-2">
                <span>{picked?.name ?? `成员 ${memberId}`} 在 {day} 的访问</span>
                <Link className="text-ink-3 hover:text-ink" to={href({ member: null })} preventScrollReset>收起</Link>
              </div>
              <DataTable rows={report.timeline} columns={timelineColumns} rowKey={(e) => e.at + e.path} dense empty="这一天没有访问" />
            </div>
          )}
        </Card>

        <Card title="热门页面" right={<span className="text-[12px] text-ink-4">近 {Math.min(range, RAW_DAYS)} 天，前 20</span>}>
          <DataTable rows={report.topPages} columns={pageColumns} rowKey={(p) => p.path} dense empty="还没有访问记录" />
        </Card>
        <Card title="成员活跃度">
          <DataTable rows={activity} columns={activityColumns} rowKey={(m) => ("memberId" in m ? m.memberId : m.id)} dense empty="还没有访问记录" />
        </Card>
      </div>
    </AdminPage>
  );
}
