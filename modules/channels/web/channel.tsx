// 频道页（招标商机、政策动态、行业热点）共用的页面：“全部动态”里这几类的条目，按分类、标签或搜索词筛选、翻页。
// 数据就是引擎的 /api/site/pool，和“全部动态”同一个读取层；频道只决定收哪几类、给哪些筛选（后台可改）和自动话题。
// 每个频道一个路由文件（tenders.tsx 等），声明它在手机底栏属于哪个标签，loader 在 channel.server.ts。
import { Link, useLoaderData, useNavigation } from "react-router";
import type { PoolResponse } from "@aihot/contracts/site";
import { pageMeta } from "@aihot/web/lib/seo";
import { IntentLink } from "@aihot/web/components/ui/IntentLink";
import { EmptyState } from "@aihot/web/components/ui/Page";
import { PhoneBar } from "@aihot/web/components/shell/PhoneBar";
import { DayList, Pagination } from "@aihot/web/features/feed/DayList";
import { CHANNELS, categoryLabel, type ChannelDefinition, type ChannelKey, type ChannelQuery, type ChannelView, type Chip as ChipSpec } from "../channels.ts";

interface Loaded { key: ChannelKey; view: ChannelView; query: ChannelQuery; data: PoolResponse }

export function meta({ data, location }: { data?: Loaded; location: { pathname: string } }) {
  if (!data) return pageMeta({ title: "频道", path: location.pathname });
  return pageMeta({ title: data.view.title, description: data.view.lead, path: CHANNELS[data.key].path });
}

/** 频道收不止一类时，默认看全部这几类（category 为空）。 */
const defaultCategoryOf = (def: ChannelDefinition) => (def.categories.length > 1 ? null : def.categories[0]!);

function href(path: string, query: ChannelQuery, defaultCategory: string | null) {
  const sp = new URLSearchParams();
  if (query.category && query.category !== defaultCategory) sp.set("category", query.category);
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
  const { key, view, query, data } = useLoaderData() as Loaded;
  const channel: ChannelDefinition = CHANNELS[key];
  const navigation = useNavigation();
  const busy = navigation.state === "loading" && navigation.location?.pathname === channel.path;
  const defaultCategory = defaultCategoryOf(channel);
  const to = (change: Partial<typeof query>) => href(channel.path, { ...query, page: 1, ...change }, defaultCategory);
  const filtered = !!(query.tag || query.q);
  // A chip filters by its tag, or searches its words (and then shows as the search).
  const chipTo = (chip: ChipSpec) => to(chip.tag ? { tag: chip.tag, q: null } : { tag: null, q: chip.q! });
  const chipOn = (chip: ChipSpec) => (chip.tag ? query.tag === chip.tag : !query.tag && query.q === chip.q);

  return (
    <div className="mx-auto max-w-[var(--page-max-reading)] pb-14">
      <PhoneBar back={channel.tab ? undefined : { to: "/more", label: "我的" }} title={view.title} />
      <header className="pb-2 pt-3 lg:pt-1">
        <div className="flex items-baseline justify-between gap-3">
          <h1 data-page-title="" className="text-[24px] font-semibold leading-[1.3] text-ink">{view.title}</h1>
          {channel.link && <Link to={channel.link.to} className="shrink-0 text-[13px] text-accent hover:underline">{channel.link.label} →</Link>}
        </div>
        {view.lead && <p className="mt-1.5 text-[13px] leading-relaxed text-ink-3">{view.lead}</p>}
      </header>

      <div className="mt-4 space-y-2.5">
        <form method="get" action={channel.path} className="flex gap-2">
          {query.category && query.category !== defaultCategory && <input type="hidden" name="category" value={query.category} />}
          {query.tag && <input type="hidden" name="tag" value={query.tag} />}
          <input type="search" name="q" defaultValue={query.q ?? ""} maxLength={200} placeholder={channel.searchHint}
            className="h-9 min-w-0 flex-1 rounded-full border border-line bg-surface px-4 text-[13.5px] text-ink outline-none focus:border-accent" />
          <button type="submit" className="h-9 shrink-0 rounded-full border border-line bg-surface px-4 text-[13px] text-ink-2 hover:text-accent">搜索</button>
        </form>
        {channel.categories.length > 1 && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="mr-1 text-[12px] text-ink-4">分类</span>
            <Chip to={to({ category: null })} active={!query.category}>全部</Chip>
            {channel.categories.map((c) => <Chip key={c} to={to({ category: c })} active={query.category === c}>{categoryLabel(c)}</Chip>)}
          </div>
        )}
        {view.topics.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="mr-1 text-[12px] text-ink-4" title="按最近 7 天的报道量自动更新">热门话题</span>
            {view.topics.map((t) => (
              <Chip key={t.tag} to={to({ tag: t.tag, q: null })} active={query.tag === t.tag}>
                {t.tag}<span className="num ml-1 opacity-70">{t.recent}{t.recent > t.before ? "↑" : ""}</span>
              </Chip>
            ))}
          </div>
        )}
        {view.rows.map((row, i) => (
          <div key={row.label} className="flex flex-wrap items-center gap-1.5">
            <span className="mr-1 text-[12px] text-ink-4">{row.label}</span>
            {i === 0 && view.topics.length === 0 && <Chip to={to({ tag: null, q: null })} active={!filtered}>全部</Chip>}
            {row.chips.map((c) => <Chip key={c.label} to={chipTo(c)} active={chipOn(c)}>{c.label}</Chip>)}
          </div>
        ))}
        {query.tag && (
          <p className="text-[12.5px] text-ink-3">
            正在看“{query.tag}” · <Link to={to({ tag: null })} className="text-accent hover:underline">取消</Link>
          </p>
        )}
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
