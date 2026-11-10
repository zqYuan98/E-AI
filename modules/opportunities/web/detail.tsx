// 一份招采公告：公告信息、解析情况、从公告正文抽出的要素（预算、时间、通用资格业绩要求），筛出的相关和待确认项目逐个写全
// （锚点 item-<id>，列表点进来定位到这里），其余项目只列名称和包。
import { useLoaderData } from "react-router";
import { cachedPage, loadOr404 } from "@aihot/web/lib/api.server";
import { pageMeta } from "@aihot/web/lib/seo";
import { IntentLink } from "@aihot/web/components/ui/IntentLink";
import { AsideCard, ReadingLayout } from "@aihot/web/components/ui/Page";
import { PhoneBar } from "@aihot/web/components/shell/PhoneBar";
import type { Screen } from "@aihot/web/components/shell/screens";
import { IconExternal } from "@aihot/web/components/icons";
import { VERDICT_LABELS, type NoticeDetails, type OpportunityItem, type OpportunityNoticeDetail, type RequirementKind } from "../types.ts";
import { ExpiredTag, MAYBE_HINT, NOTICE_STATUS_NOTES, VerdictTag, ceilingText } from "./parts.tsx";

export const handle: Screen = { tab: "opportunities" };
export { pageHeaders as headers } from "@aihot/web/lib/api.server";

export async function loader({ request, params }: { request: Request; params: { id?: string } }) {
  return cachedPage(60, await loadOr404<OpportunityNoticeDetail>(`/api/site/opportunities/${encodeURIComponent(params.id ?? "")}`, { request, signal: request.signal }));
}

export function meta({ loaderData }: { loaderData?: OpportunityNoticeDetail }) {
  if (!loaderData) return pageMeta({ title: "投标商机", path: "/opportunities" });
  const n = loaderData.notice;
  return pageMeta({ title: n.title, description: [n.buyer, n.batch, `${n.itemCount} 个项目`].filter(Boolean).join(" · "), path: `/opportunities/${n.id}` });
}

/** 有值才出现的一组“名称：值”。 */
function Facts({ rows }: { rows: Array<[string, string]> }) {
  const shown = rows.filter(([, v]) => v);
  if (!shown.length) return null;
  return (
    <dl className="space-y-1.5 text-[13px]">
      {shown.map(([k, v]) => (
        <div key={k} className="flex min-w-0 gap-3">
          <dt className="w-[7.5em] shrink-0 text-ink-4">{k}</dt>
          <dd className="num min-w-0 break-words text-ink-2">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function Block({ title, text }: { title: string; text: string }) {
  if (!text) return null;
  return (
    <div className="mt-4">
      <h4 className="text-[13px] font-semibold text-ink">{title}</h4>
      <p className="mt-1 whitespace-pre-line break-words text-[13.5px] leading-[1.8] text-ink-2">{text}</p>
    </div>
  );
}

const REQUIREMENT_LABELS: Record<RequirementKind, string> = {
  qualification: "资质", performance: "业绩", personnel: "人员", authorization: "授权", financial: "财务", credit: "信用", other: "其他",
};

/** 公告正文抽出的要素：各包都适用的预算、时间和通用要求；每条要求可展开看原文。 */
function NoticeFacts({ d }: { d: NoticeDetails }) {
  const groups = (Object.keys(REQUIREMENT_LABELS) as RequirementKind[])
    .map((kind) => [kind, d.requirements.filter((r) => r.kind === kind)] as const).filter(([, rs]) => rs.length > 0);
  return (
    <section className="card mt-6 px-5 py-4">
      <h2 className="text-[16px] font-bold text-ink">公告要素</h2>
      <p className="mt-1 text-[12px] leading-5 text-ink-4">系统从公告正文抽出，每条都核对过原文。这里是各包都适用的通用要求，单个项目自己的要求见下面的项目。</p>
      <div className="mt-3">
        <Facts rows={[
          ["预算", d.budget],
          ["获取截止", d.times.docObtainEnd],
          ["报名截止", d.times.signupDeadline],
          ["投标截止", d.times.bidDeadline],
          ["开标时间", d.times.opening],
          ["联合体", d.consortium],
          ["地区", d.region],
          ["代理机构", d.agency],
        ]} />
      </div>
      {d.lots.length > 0 && (
        <div className="mt-4">
          <h4 className="text-[13px] font-semibold text-ink">标包</h4>
          <ul className="mt-1 space-y-1 text-[13.5px] leading-[1.7] text-ink-2">
            {d.lots.map((l, i) => (
              <li key={i} className="break-words">
                {[l.no, l.name].filter(Boolean).join(" ")}
                {l.scope && <span className="text-ink-3">：{l.scope}</span>}
                {l.budget && <span className="num text-ink-3">（预算 {l.budget}）</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
      {groups.map(([kind, rs]) => (
        <div key={kind} className="mt-4">
          <h4 className="text-[13px] font-semibold text-ink">{REQUIREMENT_LABELS[kind]}要求</h4>
          <ul className="mt-1 space-y-1.5 text-[13.5px] leading-[1.7] text-ink-2">
            {rs.map((r, i) => (
              <li key={i} className="break-words">
                {r.text}
                {r.lots.length > 0 && <span className="text-ink-4">（{r.lots.join("、")}）</span>}
                <details className="text-[12px] text-ink-4">
                  <summary className="cursor-pointer">原文</summary>
                  <p className="mt-0.5 whitespace-pre-line break-words">{r.quote}</p>
                </details>
              </li>
            ))}
          </ul>
        </div>
      ))}
      {d.detailsInDocuments && <p className="mt-3 text-[12.5px] text-amber-ink">资格和技术要求另见招标文件，公告里没有写全。</p>}
    </section>
  );
}

function Item({ o }: { o: OpportunityItem }) {
  const pkg = [o.packageLabel, o.packageName].filter(Boolean).join(" · ");
  return (
    <article id={`item-${o.id}`} className={`card scroll-mt-20 px-5 py-4 target:ring-2 target:ring-accent ${o.expired ? "opacity-75" : ""}`}>
      <div className="flex flex-wrap items-center gap-2 text-[11.5px] text-ink-4">
        <VerdictTag verdict={o.verdict} />
        {o.expired && <ExpiredTag />}
        {o.line && <span className="text-accent">#{o.line}</span>}
      </div>
      <h3 className="mt-2 break-words text-[16px] font-semibold leading-[1.5] text-ink">{o.projectName || o.packageName || "（原表没写项目名）"}</h3>
      {pkg && <p className="mt-0.5 break-words text-[12.5px] text-ink-3">{pkg}</p>}
      {(o.reason || o.verdict === "maybe") && (
        <p className={`mt-2.5 rounded-mark px-3 py-2 text-[12.5px] leading-[1.7] ${o.verdict === "maybe" ? "bg-amber-soft text-amber-ink" : "bg-accent-soft text-ink-2"}`}>
          {o.line && <span className="font-semibold">{o.line}：</span>}
          {o.reason || MAYBE_HINT}
          {o.verdict === "maybe" && o.reason && <span className="block text-[12px] opacity-80">{MAYBE_HINT}。</span>}
        </p>
      )}
      <div className="mt-3">
        <Facts rows={[
          ["项目单位", o.buyer],
          ["地点", o.location],
          ["最高限价", ceilingText(o.ceiling, o.ceilingKind)],
          ["预算", o.budget],
          ["报价方式", o.pricing],
          ["采购文件获取截止", o.fileDeadline],
          ["投标截止", o.bidDeadline],
          ["开标时间", o.openingTime !== o.bidDeadline ? o.openingTime : ""],
        ]} />
      </div>
      <Block title="采购内容" text={o.scope} />
      <Block title="资质要求" text={o.qualifications} />
      <Block title="业绩要求" text={o.performance} />
      <Block title="人员要求" text={o.personnel} />
      {o.evidence.length > 0 && (
        <ul className="mt-4 space-y-0.5 border-t border-line pt-2.5 text-[11.5px] leading-[1.6] text-ink-4">
          {o.evidence.map((e, i) => (
            <li key={i} className="break-all">原文位置：{[e.file, e.sheet, e.row ? `第 ${e.row} 行` : ""].filter(Boolean).join(" / ")}</li>
          ))}
        </ul>
      )}
    </article>
  );
}

export default function OpportunityDetail() {
  const { notice: n, items, others } = useLoaderData<typeof loader>();
  const note = NOTICE_STATUS_NOTES[n.status];
  const official = n.url && (
    <a href={n.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-[13px] text-accent hover:underline">
      打开原公告 <IconExternal size={13} />
    </a>
  );
  return (
    <>
      <PhoneBar back={{ to: "/opportunities", label: "商机" }} title={n.title} />
      <ReadingLayout
        aside={
          <AsideCard title="公告信息">
            <Facts rows={[
              ["来源", n.sourceName],
              ["采购单位", n.buyer],
              ["批次", n.batch],
              ["发布时间", n.published],
              ["采购文件获取截止", n.fileDeadline],
              ["投标截止", n.details?.times.bidDeadline ?? ""],
              ["开标时间", n.openingTime],
              ["项目数", n.itemCount ? `${n.itemCount} 个${n.packageCount ? `，${n.packageCount} 个包` : ""}` : ""],
            ]} />
            {official && <div className="mt-4">{official}</div>}
            <p className="mt-3 text-[11.5px] leading-5 text-ink-4">{n.source === "web" ? "要素由系统从公告正文自动抽取并核对原文" : "项目明细由系统从公告附件自动解析"}，时间、金额照原文；报名和投标以原公告为准。</p>
          </AsideCard>
        }
      >
        <article className="pt-3 lg:pt-1">
          <IntentLink to="/opportunities" className="text-[12.5px] text-ink-4 hover:text-accent">← 投标商机</IntentLink>
          <div className="mt-3 flex flex-wrap items-center gap-2 text-[11.5px] text-ink-4">
            <span className="rounded-mark bg-bg-sunk px-1.5 py-0.5 text-ink-3">{n.sourceName}</span>
            {n.published && <span className="num">{n.published}</span>}
          </div>
          <h1 data-page-title="" className="mt-2 break-words text-[22px] font-semibold leading-[1.45] text-ink">{n.title}</h1>
          {(n.buyer || n.batch) && <p className="mt-1.5 break-words text-[13px] text-ink-3">{[n.buyer, n.batch].filter(Boolean).join(" · ")}</p>}
          {(note || n.warnings.length > 0) && (
            <div role="note" className="mt-4 rounded-mark bg-amber-soft px-3.5 py-2.5 text-[13px] leading-[1.7] text-amber-ink">
              {note ?? "解析时有几处需要留意，以原公告为准。"}
              {n.warnings.length > 0 && (
                <details className="mt-1 text-[12px]">
                  <summary className="cursor-pointer">解析提示（{n.warnings.length}）</summary>
                  <ul className="mt-1 list-disc space-y-0.5 pl-5">{n.warnings.map((w, i) => <li key={i} className="break-words">{w}</li>)}</ul>
                </details>
              )}
            </div>
          )}
          <div className="mt-4 lg:hidden">{official}</div>
          {n.details && <NoticeFacts d={n.details} />}

          <section className="mt-6">
            <h2 className="text-[16px] font-bold text-ink">筛出的项目{items.length > 0 && <span className="num ml-1.5 text-[13px] font-normal text-ink-4">{items.length} 个</span>}</h2>
            {items.length > 0 ? (
              <ol className="mt-3 space-y-3">{items.map((o) => <li key={o.id}><Item o={o} /></li>)}</ol>
            ) : (
              <p className="mt-3 text-[13px] leading-relaxed text-ink-3">这份公告没有对得上业务口径的项目{n.status === "parsed" || n.status === "partial" ? "" : "，或附件还没解析出来"}。</p>
            )}
          </section>

          {others.length > 0 && (
            <details className="mt-6 rounded-panel border border-line px-4 py-3">
              <summary className="cursor-pointer text-[13.5px] font-medium text-ink-2">本批次其余 {others.length} 个项目</summary>
              <p className="mt-2 text-[12px] text-ink-4">没筛进来的项目只列名称；需要细看请打开原公告。</p>
              <ul className="mt-2 divide-y divide-line text-[13px]">
                {others.map((o) => (
                  <li key={o.id} className="flex min-w-0 items-baseline justify-between gap-3 py-1.5">
                    <span className="min-w-0 break-words text-ink-2">{[o.projectName || "（未写项目名）", o.packageLabel].filter(Boolean).join(" · ")}</span>
                    <span className="shrink-0 text-[12px] text-ink-4">{VERDICT_LABELS[o.verdict]}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </article>
      </ReadingLayout>
    </>
  );
}
