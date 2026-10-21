// 频道页（招标商机、政策动态、行业热点）共用的页面：“全部动态”里这几类的条目，按分类或标签筛选、搜索、翻页。
// 数据就是引擎的 /api/site/pool，和“全部动态”同一个读取层；频道只决定收哪几类、给哪些筛选。
// 每个频道一个路由文件（tenders.tsx 等），只声明它在手机底栏属于哪个标签。
import { Link, useLoaderData, useNavigation } from "react-router";
import type { PoolResponse } from "@aihot/contracts/site";
import { apiGet, cachedPage } from "@aihot/web/lib/api.server";
import { pageMeta } from "@aihot/web/lib/seo";
import { IntentLink } from "@aihot/web/components/ui/IntentLink";
import { EmptyState } from "@aihot/web/components/ui/Page";
import { PhoneBar } from "@aihot/web/components/shell/PhoneBar";
import { DayList, Pagination } from "@aihot/web/features/feed/DayList";
import { CHANNELS, categoryLabel, channelAt, type Channel, type ChannelKey } from "../channels.ts";

export { pageHeaders as headers } from "@aihot/web/lib/api.server";

/** What the address asks for, kept to what the channel offers. */
function readQuery(channel: Channel, params: URLSearchParams) {
  const category = (channel.categories as readonly string[]).includes(params.get("category") ?? "") ? params.get("category")! : channel.categories[0]!;
  const tag = channel.tagRows.some((r) => (r.tags as readonly string[]).includes(params.get("tag") ?? "")) ? params.get("tag") : null;
  const q = params.get("q")?.trim().slice(0, 200) || null;
  const page = Math.min(Math.max(Number(params.get("page")) || 1, 1), 50);
  return { category, tag, q, page };
}

export async function loader({ request }: { request: Request }) {
  const url = new URL(request.url);
  const key = channelAt(url.pathname);
  if (!key) throw new Response("Not found", { status: 404 });
  const query = readQuery(CHANNELS[key], url.searchParams);
  const api = new URLSearchParams({ category: query.category });
  if (query.tag) api.set("tag", query.tag);
  if (query.q) api.set("q", query.q);
  if (query.page > 1) api.set("page", String(query.page));
  const data = await apiGet<PoolResponse>(`/api/site/pool?${api}`, { request, signal: request.signal });
  return cachedPage(60, { key, query, data });
}

export function meta({ location }: { location: { pathname: string } }) {
  const key = channelAt(location.pathname);
  const channel = key ? CHANNELS[key] : null;
  return pageMeta({ title: channel?.title ?? "频道", description: channel?.lead, path: channel?.path ?? location.pathname });
}

function href(path: string, query: { category: string; tag: string | null; q: string | null; page: number }, defaultCategory: string) {
  const sp = new URLSearchParams();
  if (query.category !== defaultCategory) sp.set("category", query.category);
  if (query.tag) sp.set("tag", query.tag);
  if (query.q) sp.set("q", query.q);
  if (query.page > 1) sp.set("page", String(query.page));
  return sp.size ? `${path}?${sp}` : path;
}

function Chip({ to, active, children }: { to: string; active: boolean; children: React.ReactNode }) {
  return (
    <IntentLink to={to} preventScrollReset aria-current={active ? "true" : undefined}
      className={`rounded-full border px-3 py-1 text-[12.5px] transition-colors ${active ? "border-accent bg-accent text-white" : "border-line bg-surface text-ink-3 hover:text-accent"}`}>
      {children}
    </IntentLink>
  );
}

export default function ChannelPage() {
  const { key, query, data } = useLoaderData<typeof loader>() as { key: ChannelKey; query: ReturnType<typeof readQuery>; data: PoolResponse };
  const channel: Channel = CHANNELS[key];
  const navigation = useNavigation();
  const busy = navigation.state === "loading" && navigation.location?.pathname === channel.path;
  const defaultCategory = channel.categories[0]!;
  const to = (change: Partial<typeof query>) => href(channel.path, { ...query, page: 1, ...change }, defaultCategory);
  const filtered = !!(query.tag || query.q);

  return (
    <div className="mx-auto max-w-[var(--page-max-reading)] pb-14">
      <PhoneBar back={channel.tab ? undefined : { to: "/more", label: "我的" }} title={channel.title} />
      <header className="pb-2 pt-3 lg:pt-1">
        <div className="flex items-baseline justify-between gap-3">
          <h1 data-page-title="" className="text-[24px] font-semibold leading-[1.3] text-ink">{channel.title}</h1>
          {channel.link && <Link to={channel.link.to} className="shrink-0 text-[13px] text-accent hover:underline">{channel.link.label} →</Link>}
        </div>
        <p className="mt-1.5 text-[13px] leading-relaxed text-ink-3">{channel.lead}</p>
      </header>

      <div className="mt-4 space-y-2.5">
        <form method="get" action={channel.path} className="flex gap-2">
          {query.category !== defaultCategory && <input type="hidden" name="category" value={query.category} />}
          {query.tag && <input type="hidden" name="tag" value={query.tag} />}
          <input type="search" name="q" defaultValue={query.q ?? ""} maxLength={200} placeholder={channel.searchHint}
            className="h-9 min-w-0 flex-1 rounded-full border border-line bg-surface px-4 text-[13.5px] text-ink outline-none focus:border-accent" />
          <button type="submit" className="h-9 shrink-0 rounded-full border border-line bg-surface px-4 text-[13px] text-ink-2 hover:text-accent">搜索</button>
        </form>
        {channel.categories.length > 1 && (
          <div className="flex flex-wrap gap-1.5">
            {channel.categories.map((c) => <Chip key={c} to={to({ category: c, tag: null })} active={query.category === c}>{categoryLabel(c)}</Chip>)}
          </div>
        )}
        {channel.tagRows.map((row, i) => (
          <div key={row.label} className="flex flex-wrap items-center gap-1.5">
            <span className="mr-1 text-[12px] text-ink-4">{row.label}</span>
            {i === 0 && <Chip to={to({ tag: null })} active={!query.tag}>全部</Chip>}
            {row.tags.map((t) => <Chip key={t} to={to({ tag: t })} active={query.tag === t}>{t}</Chip>)}
          </div>
        ))}
        {query.q && (
          <p className="text-[12.5px] text-ink-3">
            搜索“{query.q}”：找到 <span className="num">{data.total >= 2000 ? "2000+" : data.total}</span> 条 · <Link to={to({ q: null })} className="text-accent hover:underline">清除搜索</Link>
          </p>
        )}
      </div>

      <section className={`mt-6 transition-opacity duration-200 ${busy ? "opacity-50" : ""}`}>
        {data.items.length === 0 ? (
          <EmptyState title={filtered ? "没有符合条件的内容" : "这里暂时还没有内容"}>
            {filtered ? "换一个关键词或筛选试试。" : "信源抓到并处理完相关资料后，会出现在这里。"}
          </EmptyState>
        ) : (
          <DayList items={data.items} todayCount={query.q ? null : data.todayCount} />
        )}
      </section>
      <Pagination page={data.page} pageCount={data.pageCount} href={(p) => href(channel.path, { ...query, page: p }, defaultCategory)} />
    </div>
  );
}
