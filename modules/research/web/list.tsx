// 研报库列表：搜索标题、机构、摘要和要点，按主题筛选。研报原文在研报网站上看，站内只有摘要和要点。
import { useLoaderData, useSearchParams } from "react-router";
import { SITE } from "@aihot/site";
import { apiGet, cachedPage } from "@aihot/web/lib/api.server";
import { pageMeta } from "@aihot/web/lib/seo";
import { IntentLink } from "@aihot/web/components/ui/IntentLink";
import { EmptyState } from "@aihot/web/components/ui/Page";
import { PhoneBar } from "@aihot/web/components/shell/PhoneBar";
import type { Screen } from "@aihot/web/components/shell/screens";
import type { ResearchCard, ResearchListResponse } from "../types.ts";

export const handle: Screen = { home: "me", name: "研报库" };
export { pageHeaders as headers } from "@aihot/web/lib/api.server";

export async function loader({ request }: { request: Request }) {
  const params = new URL(request.url).searchParams;
  const query = new URLSearchParams();
  for (const k of ["q", "topic"]) if (params.get(k)) query.set(k, params.get(k)!);
  return cachedPage(300, await apiGet<ResearchListResponse>(`/api/site/research${query.size ? `?${query}` : ""}`, { request, signal: request.signal }));
}

export function meta() {
  return pageMeta({ title: "研报库", description: `${SITE.name} 整理的电力与人工智能研究报告：机构、日期、摘要和带原话的关键数据与观点。`, path: "/research" });
}

function Card({ r }: { r: ResearchCard }) {
  return (
    <IntentLink to={`/research/${r.id}`} className="card card-hover block px-5 py-4">
      <div className="flex flex-wrap items-center gap-2 text-[11.5px] text-ink-4">
        {r.institution && <span className="rounded bg-bg-sunk px-1.5 py-0.5 text-ink-3">{r.institution}</span>}
        {r.date && <span className="num">{r.date}</span>}
        {r.pointCount > 0 && <span>{r.pointCount} 条要点</span>}
      </div>
      <h3 className="mt-2 text-[15.5px] font-semibold leading-[1.5] text-ink">{r.title}</h3>
      {r.summary && <p className="mt-1.5 line-clamp-3 text-[13px] leading-[1.75] text-ink-3">{r.summary}</p>}
      {r.topics.length > 0 && (
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          {r.topics.map((t) => <span key={t} className="text-[11.5px] text-accent">#{t}</span>)}
        </div>
      )}
    </IntentLink>
  );
}

export default function ResearchList() {
  const { reports, topics } = useLoaderData<typeof loader>();
  const [params] = useSearchParams();
  const current = params.get("topic");
  const chip = (topic: string | null, label: string) => {
    const next = new URLSearchParams(params);
    if (topic) next.set("topic", topic);
    else next.delete("topic");
    const active = current === topic;
    return (
      <IntentLink key={label} to={`/research${next.size ? `?${next}` : ""}`} preventScrollReset
        className={`rounded-full border px-3 py-1 text-[12.5px] transition-colors ${active ? "border-accent bg-accent text-white" : "border-line bg-surface text-ink-3 hover:text-accent"}`}>
        {label}
      </IntentLink>
    );
  };
  return (
    <div className="mx-auto max-w-[var(--page-max-reading)] pb-14">
      <PhoneBar back={{ to: "/more", label: "我的" }} title="研报库" />
      <header className="pb-2 pt-3 lg:pt-1">
        <h1 data-page-title="" className="text-[24px] font-semibold leading-[1.3] text-ink">研报库</h1>
        <p className="mt-1.5 text-[13px] leading-relaxed text-ink-3">
          电力与人工智能相关的研究报告。站内是摘要和关键数据、观点（每条附研报原话）；完整报告请点开后到研报网站阅读，版权归原机构所有，请勿外传。
        </p>
      </header>

      <div className="mt-4 space-y-2.5">
        <form method="get" action="/research" className="flex gap-2">
          {current && <input type="hidden" name="topic" value={current} />}
          <input type="search" name="q" defaultValue={params.get("q") ?? ""} maxLength={40} placeholder="搜标题、机构、摘要或要点，例如 虚拟电厂、算力"
            className="h-9 min-w-0 flex-1 rounded-full border border-line bg-surface px-4 text-[13.5px] text-ink outline-none focus:border-accent" />
          <button type="submit" className="h-9 shrink-0 rounded-full border border-line bg-surface px-4 text-[13px] text-ink-2 hover:text-accent">搜索</button>
        </form>
        {topics.length > 0 && <div className="flex flex-wrap gap-1.5">{[chip(null, "全部主题"), ...topics.map((t) => chip(t.topic, `${t.topic} ${t.count}`))]}</div>}
      </div>

      <section className="mt-6">
        {reports.length === 0 ? (
          <EmptyState title={params.get("q") || current ? "没有符合条件的研报" : "研报库还是空的"}>
            {params.get("q") || current ? "换一个关键词或主题试试。" : "管理员在后台“研报库管理”里导入研报后，会出现在这里。"}
          </EmptyState>
        ) : (
          <ul className="grid gap-3 lg:grid-cols-2">
            {reports.map((r) => <li key={r.id}><Card r={r} /></li>)}
          </ul>
        )}
      </section>
    </div>
  );
}
