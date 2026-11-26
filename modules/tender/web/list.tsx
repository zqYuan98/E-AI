// 招采申报列表：可投标（按截止时间由近到远，已截止的默认收起、一点就能看）、中标结果、项目前期、申报通知；
// 按地区（本站重点省份在前，可一起选中）和关键词筛选。每条点开是站内条目页，“原公告”去平台报名、下载文件。
import { useEffect, useState } from "react";
import { Form, useLoaderData, useSearchParams } from "react-router";
import { SITE } from "@aihot/site";
import { apiGet, cachedPage } from "@aihot/web/lib/api.server";
import { pageMeta } from "@aihot/web/lib/seo";
import { IntentLink } from "@aihot/web/components/ui/IntentLink";
import { PillTabs } from "@aihot/web/components/ui/Tabs";
import { EmptyState } from "@aihot/web/components/ui/Page";
import { PhoneBar } from "@aihot/web/components/shell/PhoneBar";
import { IconExternal } from "@aihot/web/components/icons";
import type { Screen } from "@aihot/web/components/shell/screens";
import { FOCUS, FOCUS_LABEL, FOCUS_REGIONS, STAGE_LABELS, VIEW_LABELS, type TenderListResponse, type TenderRow } from "../types.ts";
import { amountText, countdown, dayText, momentText, URGENCY_CLASS } from "./format.ts";

export const handle: Screen = { home: "me", name: "招采申报" };
export { pageHeaders as headers } from "@aihot/web/lib/api.server";

const KEYS = ["view", "region", "q", "past"] as const;

export async function loader({ request }: { request: Request }) {
  const params = new URL(request.url).searchParams;
  const query = new URLSearchParams();
  for (const k of KEYS) if (params.get(k)) query.set(k, params.get(k)!);
  return cachedPage(60, await apiGet<TenderListResponse>(`/api/site/procurement${query.size ? `?${query}` : ""}`, { request, signal: request.signal }));
}

export function meta() {
  return pageMeta({
    title: "招采申报",
    description: `${SITE.name} 整理的招标采购、中标结果、项目前期和申报通知：截止时间、预算、采购人从公告原文识别，按截止时间排好。`,
    path: "/procurement",
  });
}

/** The address with these filters changed (null removes one); moving between views starts without the past toggle. */
function hrefWith(params: URLSearchParams, change: Partial<Record<(typeof KEYS)[number], string | null>>): string {
  const next = new URLSearchParams(params);
  for (const [k, v] of Object.entries(change)) {
    if (v) next.set(k, v);
    else next.delete(k);
  }
  return `/procurement${next.size ? `?${next}` : ""}`;
}

function Row({ row, now }: { row: TenderRow; now: string }) {
  const f = row.facts;
  const due = f.deadline ?? null;
  const left = due ? countdown(due, now) : null;
  const meta = [
    f.winner && `${f.stage === "candidate" ? "第一候选人" : "中标人"} ${f.winner}`,
    f.amount && `${f.amount.label} ${amountText(f.amount.value)}`,
    f.purchaser && `采购人 ${f.purchaser}`,
    f.region,
  ].filter(Boolean) as string[];
  const quotes = [f.deadline, f.signup, f.amount].flatMap((q) => (q ? [q.quote] : []));
  return (
    <li className="card px-4 py-3.5 lg:px-5">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-ink-4">
        {left && <span className={`rounded-full px-2 py-px font-medium ${URGENCY_CLASS[left.urgency]}`}>{left.text}</span>}
        {due && <span className="num text-ink-3">{due.label} {momentText(due)}</span>}
        {f.signup && <span className="num">· {f.signup.label} {momentText(f.signup)}</span>}
        {!due && f.stage && <span className="text-ink-3">{STAGE_LABELS[f.stage]}</span>}
      </div>
      <IntentLink to={`/items/${row.id}`} className="mt-1.5 block text-[15.5px] font-semibold leading-[1.5] text-ink hover:text-accent">
        {row.title}
      </IntentLink>
      {meta.length > 0 && <p className="mt-1 text-[13px] leading-6 text-ink-2">{meta.join(" · ")}</p>}
      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-ink-4">
        <span>{row.source}</span>
        {row.publishedAt && <span className="num">发布 {dayText(row.publishedAt)}</span>}
        <a href={row.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-0.5 text-accent hover:underline">
          原公告 <IconExternal size={12} />
        </a>
        {quotes.length > 0 && (
          <details className="w-full">
            <summary className="cursor-pointer select-none hover:text-ink-2">核对公告原文</summary>
            <ul className="mt-1 space-y-0.5 text-[12.5px] leading-5 text-ink-3">{quotes.map((q) => <li key={q}>“{q}”</li>)}</ul>
          </details>
        )}
      </div>
    </li>
  );
}

export default function TenderList() {
  const data = useLoaderData<typeof loader>();
  const [params] = useSearchParams();
  // Countdowns start from the time the list was read (so the page and the browser agree), then follow the clock.
  const [now, setNow] = useState(data.now);
  useEffect(() => setNow(new Date().toISOString()), [data.now]);
  const timed = data.view === "open" || data.view === "call";
  const filtered = !!(data.region || data.q);
  const views = data.views.filter((v) => v.key !== "other" || v.count > 0 || data.view === "other");
  const focusCount = data.regions.filter((r) => FOCUS_REGIONS.includes(r.region)).reduce((n, r) => n + r.count, 0);
  const chip = (value: string | null, label: string, count?: number) => {
    const active = (data.region ?? null) === value;
    return (
      <IntentLink key={value ?? "all"} to={hrefWith(params, { region: value })} preventScrollReset
        className={`shrink-0 rounded-full border px-3 py-1 text-[12.5px] transition-colors ${active ? "border-accent bg-accent text-white" : "border-line bg-surface text-ink-3 hover:text-accent"}`}>
        {label}{count !== undefined && <span className={`num ml-1 ${active ? "text-white/80" : "text-ink-4"}`}>{count}</span>}
      </IntentLink>
    );
  };
  return (
    <div className="mx-auto max-w-[var(--page-max-reading)] pb-14">
      <PhoneBar back={{ to: "/more", label: "我的" }} title="招采申报" />
      <header className="pb-2 pt-3 lg:pt-1">
        <h1 data-page-title="" className="text-[24px] font-semibold leading-[1.3] text-ink">招采申报</h1>
        <p className="mt-1.5 text-[13px] leading-relaxed text-ink-3">
          招标采购、中标结果、项目前期和申报通知。截止时间、预算和采购人从公告原文自动识别，可以展开核对；以原公告和之后的变更公告为准。
        </p>
      </header>

      <div className="mt-4 space-y-2.5">
        <PillTabs
          size="sm"
          layoutId="tender-view"
          label="公告类别"
          active={data.view}
          items={views.map((v) => ({ key: v.key, label: VIEW_LABELS[v.key], count: v.count, to: hrefWith(params, { view: v.key === "open" ? null : v.key, past: null }) }))}
        />
        <Form method="get" action="/procurement" preventScrollReset className="flex gap-2">
          {KEYS.filter((k) => k !== "q" && params.get(k)).map((k) => <input key={k} type="hidden" name={k} value={params.get(k)!} />)}
          <input
            type="search" name="q" defaultValue={data.q ?? ""} maxLength={40} placeholder="搜标题、采购人或中标人，例如 布控球、国网宁夏"
            className="h-9 min-w-0 flex-1 rounded-full border border-line bg-surface px-4 text-[13.5px] text-ink outline-none focus:border-accent"
          />
          <button type="submit" className="h-9 shrink-0 rounded-full border border-line bg-surface px-4 text-[13px] text-ink-2 hover:text-accent">搜索</button>
        </Form>
        {(data.regions.length > 0 || data.region) && (
          // A phone keeps the regions on one line it can swipe, so the list starts on the first screen.
          <div className="scrollbar-none -mx-[var(--gutter-l)] flex gap-1.5 overflow-x-auto px-[var(--gutter-l)] lg:mx-0 lg:flex-wrap lg:px-0">
            {chip(null, "全部地区")}
            {(focusCount > 0 || data.region === FOCUS) && chip(FOCUS, FOCUS_LABEL, focusCount)}
            {data.regions.map((r) => chip(r.region, r.region, r.count))}
          </div>
        )}
        {filtered && <IntentLink to={hrefWith(params, { region: null, q: null })} preventScrollReset className="inline-block text-[12.5px] text-accent hover:underline">清除地区和关键词</IntentLink>}
      </div>

      <section className="mt-5" aria-label={VIEW_LABELS[data.view]}>
        {data.rows.length === 0 ? (
          <div className="card">
            <EmptyState title={filtered ? "没有符合条件的公告" : timed ? `现在没有还在报名期的${data.view === "call" ? "申报通知" : "招标公告"}` : `近 90 天没有${VIEW_LABELS[data.view]}`}>
              {filtered ? "换个地区或关键词试试。" : timed && data.hiddenPast > 0 ? `已截止的有 ${data.hiddenPast} 条，可以在下面展开。` : "新公告采集到以后会出现在这里。"}
            </EmptyState>
          </div>
        ) : (
          <ul className="space-y-3">
            {data.rows.map((r) => <Row key={r.id} row={r} now={now} />)}
          </ul>
        )}
        {timed && (data.hiddenPast > 0 || data.past) && (
          <div className="mt-4 text-center">
            <IntentLink to={hrefWith(params, { past: data.past ? null : "1" })} preventScrollReset className="text-[13px] text-accent hover:underline">
              {data.past ? "只看还没截止的" : `显示已截止的 ${data.hiddenPast} 条`}
            </IntentLink>
          </div>
        )}
      </section>
      <p className="mt-6 text-[12px] leading-5 text-ink-4">只收近 90 天发布的公告；没认出截止时间的招标公告，发布三周内都算可投标。</p>
    </div>
  );
}
