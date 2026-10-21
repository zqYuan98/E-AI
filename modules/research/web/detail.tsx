// 一篇研报：机构、日期、摘要、关键数据与观点（每条附研报原话），以及到研报网站阅读原文的链接。
import { useLoaderData } from "react-router";
import { SITE } from "@aihot/site";
import { cachedPage, loadOr404 } from "@aihot/web/lib/api.server";
import { pageMeta } from "@aihot/web/lib/seo";
import { IntentLink } from "@aihot/web/components/ui/IntentLink";
import { AsideCard, ReadingLayout } from "@aihot/web/components/ui/Page";
import { PhoneBar } from "@aihot/web/components/shell/PhoneBar";
import { IconExternal } from "@aihot/web/components/icons";
import type { ResearchDetail } from "../types.ts";

export { pageHeaders as headers } from "@aihot/web/lib/api.server";

export async function loader({ request, params }: { request: Request; params: { id?: string } }) {
  return cachedPage(300, await loadOr404<ResearchDetail>(`/api/site/research/${encodeURIComponent(params.id ?? "")}`, { request, signal: request.signal }));
}

export function meta({ loaderData }: { loaderData?: ResearchDetail }) {
  if (!loaderData) return pageMeta({ title: "研报库", path: "/research" });
  return pageMeta({ title: loaderData.title, description: loaderData.summary || `${SITE.name} 研报库`, path: `/research/${loaderData.id}` });
}

export default function ResearchDetailPage() {
  const r = useLoaderData<typeof loader>();
  const original = (
    <a href={r.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-[13px] text-accent hover:underline">
      到研报网站阅读完整报告 <IconExternal size={13} />
    </a>
  );
  return (
    <>
      <PhoneBar back={{ to: "/research", label: "研报库" }} title={r.title} />
      <ReadingLayout
        aside={
          <AsideCard title="研报信息">
            <dl className="space-y-2 text-[13px]">
              {([["机构", r.institution || null], ["日期", r.date], ["主题", r.topics.join("、") || null]] as Array<[string, string | null]>)
                .filter(([, v]) => v)
                .map(([k, v]) => (
                  <div key={k} className="flex gap-3">
                    <dt className="w-10 shrink-0 text-ink-4">{k}</dt>
                    <dd className="text-ink-2">{v}</dd>
                  </div>
                ))}
            </dl>
            <div className="mt-4">{original}</div>
            <p className="mt-3 text-[11.5px] leading-5 text-ink-4">版权归原机构所有。站内只有摘要和摘录，仅供公司内部参考，请勿外传。</p>
          </AsideCard>
        }
      >
        <article className="pt-3 lg:pt-1">
          <IntentLink to="/research" className="text-[12.5px] text-ink-4 hover:text-accent">← 研报库</IntentLink>
          <div className="mt-3 flex flex-wrap items-center gap-2 text-[11.5px] text-ink-4">
            {r.institution && <span className="rounded-mark bg-bg-sunk px-1.5 py-0.5 text-ink-3">{r.institution}</span>}
            {r.date && <span className="num">{r.date}</span>}
          </div>
          <h1 data-page-title="" className="mt-2 text-[24px] font-semibold leading-[1.4] text-ink">{r.title}</h1>
          {r.summary && <p className="mt-4 text-[15px] leading-[1.85] text-ink-2">{r.summary}</p>}
          {r.points.length > 0 ? (
            <section className="mt-8">
              <h2 className="text-[16px] font-bold text-ink">关键数据与观点</h2>
              <ol className="mt-3 space-y-3">
                {r.points.map((p, i) => (
                  <li key={i} className="border-l-2 border-line pl-4">
                    <p className="text-[14.5px] font-medium leading-[1.7] text-ink">{p.text}</p>
                    <blockquote className="mt-1 text-[13px] leading-[1.75] text-ink-3">“{p.quote}”</blockquote>
                  </li>
                ))}
              </ol>
            </section>
          ) : (
            <p className="mt-8 text-[13px] text-ink-3">这篇研报还没有整理要点。</p>
          )}
          <div className="mt-8 lg:hidden">{original}</div>
        </article>
      </ReadingLayout>
    </>
  );
}
