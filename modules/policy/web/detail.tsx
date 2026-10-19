// 一份政策规划文件：要素、目标指标、重点任务、AI 条款（每条附原话），以及它的原文、解读和报道。
import { useLoaderData } from "react-router";
import { SITE } from "@aihot/site";
import { cachedPage, loadOr404 } from "@aihot/web/lib/api.server";
import { pageMeta } from "@aihot/web/lib/seo";
import { IntentLink } from "@aihot/web/components/ui/IntentLink";
import { AsideCard, ReadingLayout } from "@aihot/web/components/ui/Page";
import { PhoneBar } from "@aihot/web/components/shell/PhoneBar";
import { IconExternal } from "@aihot/web/components/icons";
import type { PolicyClause, PolicyDocDetail } from "../types.ts";
import { AI_TONE, ROLE_LABEL, aiLabel, levelLabel } from "./labels.ts";

export { pageHeaders as headers } from "@aihot/web/lib/api.server";

export async function loader({ request, params }: { request: Request; params: { id?: string } }) {
  return cachedPage(300, await loadOr404<PolicyDocDetail>(`/api/site/policy/${encodeURIComponent(params.id ?? "")}`, { request, signal: request.signal }));
}

export function meta({ loaderData }: { loaderData?: PolicyDocDetail }) {
  if (!loaderData) return pageMeta({ title: "政策规划库", path: "/policy" });
  return pageMeta({ title: loaderData.name, description: loaderData.summary || `${SITE.name} 政策规划库`, path: `/policy/${loaderData.id}` });
}

function Clauses({ title, items }: { title: string; items: PolicyClause[] }) {
  if (items.length === 0) return null;
  return (
    <section className="mt-8">
      <h2 className="text-[16px] font-bold text-ink">{title}</h2>
      <ol className="mt-3 space-y-3">
        {items.map((c, i) => (
          <li key={i} className="border-l-2 border-line pl-4">
            <p className="text-[14.5px] font-medium leading-[1.7] text-ink">{c.text}</p>
            <blockquote className="mt-1 text-[13px] leading-[1.75] text-ink-3">“{c.quote}”</blockquote>
          </li>
        ))}
      </ol>
    </section>
  );
}

export default function PolicyDetail() {
  const d = useLoaderData<typeof loader>();
  const facts: Array<[string, string | null]> = [
    ["发文单位", d.issuers.join("、") || null],
    ["文号", d.docNo],
    ["日期", d.date],
    ["层级", levelLabel(d.level)],
    ["类型", d.docType],
  ];
  return (
    <>
      <PhoneBar back={{ to: "/policy", label: "政策规划" }} title={d.name} />
      <ReadingLayout
        aside={
          <>
            <AsideCard title="文件信息">
              <dl className="space-y-2 text-[13px]">
                {facts
                  .filter(([, v]) => v)
                  .map(([k, v]) => (
                    <div key={k} className="flex gap-3">
                      <dt className="w-14 shrink-0 text-ink-4">{k}</dt>
                      <dd className="text-ink-2">{v}</dd>
                    </div>
                  ))}
              </dl>
              <a href={d.url} target="_blank" rel="noopener noreferrer" className="mt-4 inline-flex items-center gap-1 text-[13px] text-accent hover:underline">
                查看原文 <IconExternal size={13} />
              </a>
            </AsideCard>
            {d.reports.length > 0 && (
              <AsideCard title="原文、解读与报道">
                <ul className="space-y-3 text-[13px]">
                  {d.reports.map((r, i) => (
                    <li key={i}>
                      <span className="mr-1.5 rounded bg-bg-sunk px-1 py-0.5 text-[11px] text-ink-4">{ROLE_LABEL[r.role] ?? r.role}</span>
                      {r.itemId ? (
                        <IntentLink to={`/items/${r.itemId}`} className="text-ink-2 hover:text-accent">{r.title}</IntentLink>
                      ) : (
                        <a href={r.url} target="_blank" rel="noopener noreferrer" className="text-ink-2 hover:text-accent">{r.title}</a>
                      )}
                      <span className="mt-0.5 block text-[11.5px] text-ink-4">
                        {r.source}
                        {r.at ? ` · ${r.at.slice(0, 10)}` : ""}
                      </span>
                    </li>
                  ))}
                </ul>
              </AsideCard>
            )}
          </>
        }
      >
        <article className="pt-3 lg:pt-1">
          <IntentLink to="/policy" className="text-[12.5px] text-ink-4 hover:text-accent">← 政策规划库</IntentLink>
          <div className="mt-3 flex flex-wrap items-center gap-2 text-[11.5px]">
            <span className="rounded bg-bg-sunk px-1.5 py-0.5 text-ink-3">{levelLabel(d.level)}</span>
            <span className="rounded bg-bg-sunk px-1.5 py-0.5 text-ink-3">{d.docType}</span>
            <span className={`rounded px-1.5 py-0.5 ${AI_TONE[d.aiRelevance]}`}>{aiLabel(d.aiRelevance)}</span>
          </div>
          <h1 data-page-title="" className="mt-2 text-[24px] font-semibold leading-[1.4] text-ink">{d.name}</h1>
          {d.summary && <p className="mt-4 text-[15px] leading-[1.85] text-ink-2">{d.summary}</p>}

          {d.targets.length > 0 && (
            <section className="mt-8">
              <h2 className="text-[16px] font-bold text-ink">目标与关键数据</h2>
              <ul className="mt-3 divide-y divide-line-soft rounded-card border border-line bg-surface">
                {d.targets.map((t, i) => (
                  <li key={i} className="px-4 py-3">
                    <p className="text-[14px] text-ink">
                      {t.year && <span className="num mr-2 text-ink-4">{t.year}</span>}
                      {t.metric}：<span className="font-semibold">{t.value}</span>
                    </p>
                    <p className="mt-1 text-[12.5px] leading-[1.7] text-ink-4">“{t.quote}”</p>
                  </li>
                ))}
              </ul>
            </section>
          )}
          <Clauses title="人工智能相关条款" items={d.aiClauses} />
          <Clauses title="重点任务" items={d.tasks} />
        </article>
      </ReadingLayout>
    </>
  );
}
