// 投标商机列表：国网公告的附件自动拆成的具体项目（需求行），加上其他招采平台的公告（一条一个项目），按后台“投标商机”里的
// 业务口径筛过，默认看相关和待确认的。可按来源平台、业务方向和搜索词筛选，卡片或表格两种看法，表格可导出 Excel；
// 每个项目都列出资质、业绩、人员要求和与我司资质的匹配度。点开到所在批次的详情，定位到这一项。
// ?sheet= 是钉钉信息表消息里的链接：只列那一期推过的项目，表格看。
import { useLoaderData, useNavigation } from "react-router";
import { apiGet, cachedPage } from "@aihot/web/lib/api.server";
import { pageMeta } from "@aihot/web/lib/seo";
import { IntentLink } from "@aihot/web/components/ui/IntentLink";
import { EmptyState } from "@aihot/web/components/ui/Page";
import { PhoneBar } from "@aihot/web/components/shell/PhoneBar";
import type { Screen } from "@aihot/web/components/shell/screens";
import { Pagination } from "@aihot/web/features/feed/DayList";
import type { OpportunityCard, OpportunityListResponse } from "../types.ts";
import { ExpiredTag, MAYBE_HINT, MatchTag, Requirements, VerdictTag, ceilingText, keyFacts } from "./parts.tsx";

export const handle: Screen = { tab: "opportunities", name: "商机" };
export { pageHeaders as headers } from "@aihot/web/lib/api.server";

const VIEWS = [
  { key: "focus", label: "相关和待确认" },
  { key: "relevant", label: "相关" },
  { key: "maybe", label: "待确认" },
  { key: "all", label: "全部已筛选" },
] as const;
type View = (typeof VIEWS)[number]["key"];
type Layout = "cards" | "table";

interface Query { view: View; source: string | null; line: string | null; q: string | null; page: number; layout: Layout; sheet: string | null }

function readQuery(sp: URLSearchParams): Query {
  const view = VIEWS.find((v) => v.key === sp.get("view"))?.key ?? "focus";
  const page = Number(sp.get("page"));
  const sheet = sp.get("sheet")?.trim().slice(0, 60) || null;
  return {
    view,
    source: sp.get("source")?.trim().slice(0, 40) || null,
    line: sp.get("line")?.trim() || null,
    q: sp.get("q")?.trim().slice(0, 200) || null,
    page: Number.isInteger(page) && page > 1 ? page : 1,
    layout: sheet || sp.get("layout") === "table" ? "table" : "cards",
    sheet,
  };
}

/** 给接口的筛选参数（看法不影响数据）。 */
function apiParams(query: Query): URLSearchParams {
  const sp = new URLSearchParams();
  if (query.sheet) {
    sp.set("sheet", query.sheet);
    return sp;
  }
  sp.set("view", query.view);
  if (query.source) sp.set("source", query.source);
  if (query.line) sp.set("line", query.line);
  if (query.q) sp.set("q", query.q);
  return sp;
}

function href(query: Query) {
  const sp = new URLSearchParams();
  if (query.sheet) sp.set("sheet", query.sheet);
  if (query.view !== "focus") sp.set("view", query.view);
  if (query.source) sp.set("source", query.source);
  if (query.line) sp.set("line", query.line);
  if (query.q) sp.set("q", query.q);
  if (query.layout === "table" && !query.sheet) sp.set("layout", "table");
  if (query.page > 1) sp.set("page", String(query.page));
  return sp.size ? `/opportunities?${sp}` : "/opportunities";
}

export async function loader({ request }: { request: Request }) {
  const query = readQuery(new URL(request.url).searchParams);
  const api = apiParams(query);
  if (query.page > 1 && !query.sheet) api.set("page", String(query.page));
  const data = await apiGet<OpportunityListResponse>(`/api/site/opportunities?${api}`, { request, signal: request.signal });
  return cachedPage(60, { query, data });
}

export function meta() {
  return pageMeta({ title: "投标商机", description: "国网、南网等公开招采公告里，按公司业务口径筛出来的具体项目：买什么、谁买、限价或预算、时间、资质业绩人员要求和与我司资质的匹配度。", path: "/opportunities" });
}

function Chip({ to, active, children }: { to: string; active: boolean; children: React.ReactNode }) {
  return (
    <IntentLink to={to} preventScrollReset aria-current={active ? "true" : undefined}
      className={`rounded-full border px-3 py-1 text-[12.5px] transition-colors ${active ? "border-accent bg-accent text-white" : "border-line bg-surface text-ink-3 hover:text-accent"}`}>
      {children}
    </IntentLink>
  );
}

const itemHref = (o: OpportunityCard) => `/opportunities/${encodeURIComponent(o.noticeId)}#item-${o.id}`;

function Card({ o }: { o: OpportunityCard }) {
  const facts = keyFacts(o);
  const pkg = [o.packageLabel, o.packageName].filter(Boolean).join(" · ");
  const where = [o.buyer, o.location].filter(Boolean).join(" · ");
  return (
    <IntentLink to={itemHref(o)} className={`card card-hover block h-full px-5 py-4 ${o.expired ? "opacity-70" : ""}`}>
      <div className="flex flex-wrap items-center gap-2 text-[11.5px] text-ink-4">
        <VerdictTag verdict={o.verdict} />
        <MatchTag match={o.match} />
        {o.expired && <ExpiredTag />}
        {o.line && <span className="text-accent">#{o.line}</span>}
        <span>{o.sourceName}</span>
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
      <div className="mt-2.5 border-t border-line pt-2.5"><Requirements o={o} compact /></div>
      {o.noticeTitle !== o.projectName && (
        <p className="mt-2 line-clamp-1 break-all text-[11.5px] text-ink-4" title={o.noticeTitle}>{[o.batch, o.noticeTitle].filter(Boolean).join(" · ")}</p>
      )}
    </IntentLink>
  );
}

/** 表格看法：一行一个项目，列与信息表推送的要素一致，方便商务逐行初审。窄屏左右滑动。 */
function Table({ items }: { items: OpportunityCard[] }) {
  const th = "whitespace-nowrap px-3 py-2 text-left text-[12px] font-medium text-ink-4";
  const td = "px-3 py-2.5 align-top";
  return (
    <div className="overflow-x-auto rounded-panel border border-line bg-surface">
      <table className="w-full min-w-[1080px] border-collapse text-[12.5px]">
        <thead className="border-b border-line bg-bg-sunk">
          <tr>
            <th className={th}>#</th>
            <th className={th}>项目</th>
            <th className={th}>限价 / 预算</th>
            <th className={th}>时间</th>
            <th className={`${th} w-[34%]`}>资质 · 业绩 · 人员</th>
            <th className={th}>匹配度</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {items.map((o, k) => {
            const limit = ceilingText(o.ceiling, o.ceilingKind) || o.noticeBudget;
            return (
              <tr key={o.id} className={o.expired ? "opacity-60" : ""}>
                <td className={`${td} num text-ink-4`}>{k + 1}</td>
                <td className={`${td} min-w-[240px]`}>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <VerdictTag verdict={o.verdict} />
                    {o.expired && <ExpiredTag />}
                  </div>
                  <IntentLink to={itemHref(o)} className="mt-1 block break-words font-semibold leading-[1.5] text-ink hover:text-accent">
                    {o.projectName || o.packageName || o.noticeTitle}
                  </IntentLink>
                  <p className="mt-0.5 break-words text-ink-3">{[o.buyer, o.location].filter(Boolean).join(" · ")}</p>
                  <p className="mt-0.5 break-words text-[11.5px] text-ink-4">{[o.sourceName, o.line && `#${o.line}`].filter(Boolean).join(" · ")}</p>
                </td>
                <td className={`${td} num whitespace-nowrap text-ink-2`}>{limit || <span className="text-ink-4">未写明</span>}</td>
                <td className={`${td} num whitespace-nowrap text-ink-2`}>
                  {o.fileDeadline && <div><span className="text-ink-4">获取 </span>{o.fileDeadline}</div>}
                  {o.bidDeadline && <div><span className="text-ink-4">投标 </span>{o.bidDeadline}</div>}
                  {!o.fileDeadline && !o.bidDeadline && <span className="text-ink-4">未写明</span>}
                </td>
                <td className={td}><Requirements o={o} compact /></td>
                <td className={`${td} whitespace-nowrap`}>{o.match ? <MatchTag match={o.match} /> : <span className="text-ink-4" title="没有要求可比，或后台还没填我司资质、还没比对完">—</span>}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export default function OpportunityList() {
  const { query, data } = useLoaderData<typeof loader>();
  const navigation = useNavigation();
  const busy = navigation.state === "loading" && navigation.location?.pathname === "/opportunities";
  const to = (change: Partial<Query>) => href({ ...query, page: 1, ...change });
  const filtered = !!(query.source || query.line || query.q);
  const exportHref = `/api/site/opportunities/export.csv?${apiParams(query)}`;

  return (
    <div className={`mx-auto pb-14 ${query.layout === "table" ? "max-w-[1200px]" : "max-w-[var(--page-max-reading)]"}`}>
      <PhoneBar title="投标商机" />
      <header className="pb-2 pt-3 lg:pt-1">
        <h1 data-page-title="" className="text-[24px] font-semibold leading-[1.3] text-ink">{query.sheet ? "盲投信息表" : "投标商机"}</h1>
        {query.sheet ? (
          <p className="mt-1.5 text-[13px] leading-relaxed text-ink-3">
            {data.sheet ? `${data.sheet.title}推送的 ${data.total} 个项目，按截止时间排序。` : "没有找到这一期信息表，可能链接不完整。"}
            匹配度是系统按后台“我司资质”逐条初判的，以商务核实为准。<IntentLink to="/opportunities" className="text-accent hover:underline">查看全部商机</IntentLink>
          </p>
        ) : (
          <p className="mt-1.5 text-[13px] leading-relaxed text-ink-3">
            系统自动抓取国网的招采公告并下载附件拆成具体项目和包，同时收录南网、三峡、电建等其他招采平台的公告，按公司的业务口径筛选：
            “相关”是对得上业务的，“待确认”是{MAYBE_HINT}。资质、业绩、人员要求取自项目需求表和公告正文，匹配度按后台“我司资质”逐条初判。
            每天 08:30、17:30 推送盲投信息表到钉钉群。时间、金额照原文，投标前请以原公告为准。
          </p>
        )}
      </header>

      {!query.sheet && (
        <div className="mt-4 space-y-2.5">
          <form method="get" action="/opportunities" role="search" className="flex gap-2">
            {query.view !== "focus" && <input type="hidden" name="view" value={query.view} />}
            {query.source && <input type="hidden" name="source" value={query.source} />}
            {query.line && <input type="hidden" name="line" value={query.line} />}
            {query.layout === "table" && <input type="hidden" name="layout" value="table" />}
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
            {data.platforms.map((p) => <Chip key={p.key} to={to({ source: p.key })} active={query.source === p.key}>{p.label}</Chip>)}
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
      )}

      <section aria-busy={busy} className={`mt-6 transition-opacity duration-200 ${busy ? "opacity-50" : ""}`}>
        {data.items.length === 0 ? (
          <EmptyState title={query.sheet ? "这一期信息表没有项目" : filtered ? "没有符合条件的项目" : "暂时还没有筛出的项目"}>
            {query.sheet
              ? "可能链接不完整，或这一期本来就没有新项目。"
              : filtered
                ? "换一个关键词或筛选试试。"
                : "系统会定时抓取新发布的招采公告，自动解析、按业务口径筛选；有对得上的项目会出现在这里，并推送到钉钉。"}
          </EmptyState>
        ) : (
          <>
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-[12.5px] text-ink-4">
              <span>{!query.q && <>共 <span className="num">{data.total}</span> 个项目</>}</span>
              <span className="flex items-center gap-1.5">
                {!query.sheet && (
                  <>
                    <Chip to={to({ layout: "cards", page: query.page })} active={query.layout === "cards"}>卡片</Chip>
                    <Chip to={to({ layout: "table", page: query.page })} active={query.layout === "table"}>表格</Chip>
                  </>
                )}
                <a href={exportHref} download className="rounded-full border border-line bg-surface px-3 py-1 text-[12.5px] text-ink-3 hover:text-accent"
                  title={query.sheet ? "导出这一期的全部项目" : "按当前筛选导出，最多 2000 个项目"}>
                  导出 Excel
                </a>
              </span>
            </div>
            {query.layout === "table" ? (
              <Table items={data.items} />
            ) : (
              <ul className="grid gap-3 lg:grid-cols-2">
                {data.items.map((o) => <li key={o.id} className="min-w-0"><Card o={o} /></li>)}
              </ul>
            )}
          </>
        )}
      </section>
      {!query.sheet && <Pagination page={data.page} pageCount={data.pages} href={(p) => href({ ...query, page: p })} />}
    </div>
  );
}
