// 项目商机列表：国网公告的附件自动拆成的具体项目（需求行），按后台“项目商机”里的业务口径筛过，
// 默认看相关和待确认的。可按来源、业务方向和搜索词筛选；点开到所在批次的详情，定位到这一项。
import { useLoaderData, useNavigation } from "react-router";
import { apiGet, cachedPage } from "@aihot/web/lib/api.server";
import { pageMeta } from "@aihot/web/lib/seo";
import { IntentLink } from "@aihot/web/components/ui/IntentLink";
import { EmptyState } from "@aihot/web/components/ui/Page";
import { PhoneBar } from "@aihot/web/components/shell/PhoneBar";
import type { Screen } from "@aihot/web/components/shell/screens";
import { Pagination } from "@aihot/web/features/feed/DayList";
import { SOURCE_NAMES, type OpportunityCard, type OpportunityListResponse, type SourceKey } from "../types.ts";
import { ExpiredTag, MAYBE_HINT, VerdictTag, keyFacts } from "./parts.tsx";

export const handle: Screen = { tab: "opportunities", name: "商机" };
export { pageHeaders as headers } from "@aihot/web/lib/api.server";

const VIEWS = [
  { key: "focus", label: "相关和待确认" },
  { key: "relevant", label: "相关" },
  { key: "maybe", label: "待确认" },
  { key: "all", label: "全部已筛选" },
] as const;
type View = (typeof VIEWS)[number]["key"];

interface Query { view: View; source: SourceKey | null; line: string | null; q: string | null; page: number }

function readQuery(sp: URLSearchParams): Query {
  const view = VIEWS.find((v) => v.key === sp.get("view"))?.key ?? "focus";
  const source = sp.get("source");
  const page = Number(sp.get("page"));
  return {
    view,
    source: source && source in SOURCE_NAMES ? (source as SourceKey) : null,
    line: sp.get("line")?.trim() || null,
    q: sp.get("q")?.trim().slice(0, 200) || null,
    page: Number.isInteger(page) && page > 1 ? page : 1,
  };
}

function href(query: Query) {
  const sp = new URLSearchParams();
  if (query.view !== "focus") sp.set("view", query.view);
  if (query.source) sp.set("source", query.source);
  if (query.line) sp.set("line", query.line);
  if (query.q) sp.set("q", query.q);
  if (query.page > 1) sp.set("page", String(query.page));
  return sp.size ? `/opportunities?${sp}` : "/opportunities";
}

export async function loader({ request }: { request: Request }) {
  const query = readQuery(new URL(request.url).searchParams);
  const api = new URLSearchParams({ view: query.view });
  if (query.source) api.set("source", query.source);
  if (query.line) api.set("line", query.line);
  if (query.q) api.set("q", query.q);
  if (query.page > 1) api.set("page", String(query.page));
  const data = await apiGet<OpportunityListResponse>(`/api/site/opportunities?${api}`, { request, signal: request.signal });
  return cachedPage(60, { query, data });
}

export function meta() {
  return pageMeta({ title: "项目商机", description: "国网公开招采公告里，按公司业务口径筛出来的具体项目：买什么、谁买、限价、时间和资格要求。", path: "/opportunities" });
}

function Chip({ to, active, children }: { to: string; active: boolean; children: React.ReactNode }) {
  return (
    <IntentLink to={to} preventScrollReset aria-current={active ? "true" : undefined}
      className={`rounded-full border px-3 py-1 text-[12.5px] transition-colors ${active ? "border-accent bg-accent text-white" : "border-line bg-surface text-ink-3 hover:text-accent"}`}>
      {children}
    </IntentLink>
  );
}

function Card({ o }: { o: OpportunityCard }) {
  const facts = keyFacts(o);
  const pkg = [o.packageLabel, o.packageName].filter(Boolean).join(" · ");
  const where = [o.buyer, o.location].filter(Boolean).join(" · ");
  return (
    <IntentLink to={`/opportunities/${encodeURIComponent(o.noticeId)}#item-${o.id}`}
      className={`card card-hover block h-full px-5 py-4 ${o.expired ? "opacity-70" : ""}`}>
      <div className="flex flex-wrap items-center gap-2 text-[11.5px] text-ink-4">
        <VerdictTag verdict={o.verdict} />
        {o.expired && <ExpiredTag />}
        {o.line && <span className="text-accent">#{o.line}</span>}
        <span>{SOURCE_NAMES[o.source]}</span>
      </div>
      <h3 className="mt-2 break-words text-[15.5px] font-semibold leading-[1.5] text-ink">{o.projectName || o.packageName || o.noticeTitle}</h3>
      {pkg && <p className="mt-0.5 break-words text-[12.5px] text-ink-3">{pkg}</p>}
      {where && <p className="mt-0.5 break-words text-[12.5px] text-ink-3">{where}</p>}
      {o.scopeExcerpt && <p className="mt-1.5 line-clamp-2 break-words text-[13px] leading-[1.7] text-ink-2">{o.scopeExcerpt}</p>}
      {facts.length > 0 && (
        <dl className="mt-2.5 grid gap-1 text-[12.5px]">
          {facts.map(([k, v]) => (
            <div key={k} className="flex min-w-0 gap-2">
              <dt className="shrink-0 text-ink-4">{k}</dt>
              <dd className="num min-w-0 break-words text-ink-2">{v}</dd>
            </div>
          ))}
        </dl>
      )}
      {o.reason && <p className="mt-2 line-clamp-2 break-words text-[12px] leading-[1.6] text-ink-4">推荐理由：{o.reason}</p>}
      <p className="mt-2 line-clamp-1 break-all text-[11.5px] text-ink-4" title={o.noticeTitle}>{[o.batch, o.noticeTitle].filter(Boolean).join(" · ")}</p>
    </IntentLink>
  );
}

export default function OpportunityList() {
  const { query, data } = useLoaderData<typeof loader>();
  const navigation = useNavigation();
  const busy = navigation.state === "loading" && navigation.location?.pathname === "/opportunities";
  const to = (change: Partial<Query>) => href({ ...query, page: 1, ...change });
  const filtered = !!(query.source || query.line || query.q);

  return (
    <div className="mx-auto max-w-[var(--page-max-reading)] pb-14">
      <PhoneBar title="项目商机" />
      <header className="pb-2 pt-3 lg:pt-1">
        <h1 data-page-title="" className="text-[24px] font-semibold leading-[1.3] text-ink">项目商机</h1>
        <p className="mt-1.5 text-[13px] leading-relaxed text-ink-3">
          系统自动抓取国网的招采公告，下载附件拆成具体项目和包，再按公司的业务口径筛选：“相关”是对得上业务的，“待确认”是{MAYBE_HINT}。
          业务口径由管理员在后台“项目商机”里维护。时间、金额照原文，投标前请以原公告为准。
        </p>
      </header>

      <div className="mt-4 space-y-2.5">
        <form method="get" action="/opportunities" role="search" className="flex gap-2">
          {query.view !== "focus" && <input type="hidden" name="view" value={query.view} />}
          {query.source && <input type="hidden" name="source" value={query.source} />}
          {query.line && <input type="hidden" name="line" value={query.line} />}
          <input type="search" name="q" defaultValue={query.q ?? ""} maxLength={200} aria-label="搜索项目" placeholder="搜项目名、采购内容或单位，例如 巡检、配电"
            className="h-9 min-w-0 flex-1 rounded-full border border-line bg-surface px-4 text-[13.5px] text-ink outline-none focus:border-accent" />
          <button type="submit" className="h-9 shrink-0 rounded-full border border-line bg-surface px-4 text-[13px] text-ink-2 hover:text-accent">搜索</button>
        </form>
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="mr-1 text-[12px] text-ink-4">判断</span>
          {VIEWS.map((v) => <Chip key={v.key} to={to({ view: v.key })} active={query.view === v.key}>{v.label}</Chip>)}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="mr-1 text-[12px] text-ink-4">来源</span>
          <Chip to={to({ source: null })} active={!query.source}>全部</Chip>
          {(Object.keys(SOURCE_NAMES) as SourceKey[]).map((s) => <Chip key={s} to={to({ source: s })} active={query.source === s}>{SOURCE_NAMES[s]}</Chip>)}
        </div>
        {data.lines.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="mr-1 text-[12px] text-ink-4">业务方向</span>
            <Chip to={to({ line: null })} active={!query.line}>全部</Chip>
            {data.lines.map((l) => <Chip key={l} to={to({ line: l })} active={query.line === l}>{l}</Chip>)}
          </div>
        )}
        {query.q && (
          <p className="text-[12.5px] text-ink-3">
            搜索“{query.q}”：找到 <span className="num">{data.total}</span> 个项目 · <IntentLink to={to({ q: null })} className="text-accent hover:underline">清除搜索</IntentLink>
          </p>
        )}
      </div>

      <section aria-busy={busy} className={`mt-6 transition-opacity duration-200 ${busy ? "opacity-50" : ""}`}>
        {data.items.length === 0 ? (
          <EmptyState title={filtered ? "没有符合条件的项目" : "暂时还没有筛出的项目"}>
            {filtered
              ? "换一个关键词或筛选试试。"
              : "系统会定时抓取国网新发布的招采公告，自动解析附件、按业务口径筛选；有对得上的项目会出现在这里，并推送到钉钉。"}
          </EmptyState>
        ) : (
          <>
            {!query.q && <p className="mb-3 text-[12.5px] text-ink-4">共 <span className="num">{data.total}</span> 个项目</p>}
            <ul className="grid gap-3 lg:grid-cols-2">
              {data.items.map((o) => <li key={o.id} className="min-w-0"><Card o={o} /></li>)}
            </ul>
          </>
        )}
      </section>
      <Pagination page={data.page} pageCount={data.pages} href={(p) => href({ ...query, page: p })} />
    </div>
  );
}
