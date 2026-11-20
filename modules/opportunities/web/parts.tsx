// 商机列表和批次详情共用的小件：判断标签、匹配度、资质 / 业绩 / 人员要求、限价带单位、几个时间。时间和金额照来源原文显示，不换算时区。
import type { CeilingKind, ItemRequirement, MatchStatus, MatchSummary, OpportunityCard, RequirementGroup, Verdict } from "../types.ts";
import { MATCH_LEVEL_LABELS, MATCH_STATUS_LABELS, REQUIREMENT_GROUP_LABELS, VERDICT_LABELS, missingRequirement, shortCompany } from "../types.ts";

/** 限价配上单位：比例写成百分数（0.98 → 98%），没认出单位的照原文。 */
export function ceilingText(value: string, kind: CeilingKind): string {
  const v = value.trim();
  if (!v) return "";
  if (kind === "unknown" || /[元%％]$/.test(v)) return v;
  if (kind === "amount_wan") return `${v} 万元`;
  if (kind === "amount_yuan") return `${v} 元`;
  const n = Number(v);
  if (!Number.isFinite(n)) return v;
  return n <= 1 ? `${Number((n * 100).toFixed(4))}%` : `${v}%`;
}

const VERDICT_TONES: Partial<Record<Verdict, string>> = {
  relevant: "bg-accent-soft text-accent",
  maybe: "bg-amber-soft text-amber-ink",
};

export const MAYBE_HINT = "关键词命中或模型拿不准，请人工看一眼";

export function VerdictTag({ verdict }: { verdict: Verdict }) {
  return (
    <span title={verdict === "maybe" ? MAYBE_HINT : undefined}
      className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[11.5px] font-semibold ${VERDICT_TONES[verdict] ?? "bg-bg-sunk text-ink-3"}`}>
      {VERDICT_LABELS[verdict]}
    </span>
  );
}

export function ExpiredTag() {
  return <span className="inline-flex shrink-0 items-center rounded-full bg-bg-sunk px-2 py-0.5 text-[11.5px] text-ink-4">已截止</span>;
}

/** 限价（项目没写时看公告预算）和几个时间：没有的不写。 */
export function keyFacts(o: Pick<OpportunityCard, "ceiling" | "ceilingKind" | "noticeBudget" | "fileDeadline" | "bidDeadline" | "openingTime">): Array<[string, string]> {
  const ceiling = ceilingText(o.ceiling, o.ceilingKind);
  return ([
    ["最高限价", ceiling],
    ["公告预算", ceiling ? "" : o.noticeBudget],
    ["采购文件获取截止", o.fileDeadline],
    ["投标截止", o.bidDeadline],
    ["开标时间", o.openingTime !== o.bidDeadline ? o.openingTime : ""],
  ] as Array<[string, string]>).filter(([, v]) => v);
}

/** 公告的解析状态，说给读者听；已解析的不用说。 */
export const NOTICE_STATUS_NOTES: Record<string, string> = {
  pending: "附件还在下载和解析，稍后刷新再看；现在以原公告为准。",
  partial: "附件部分内容未能解析，以原公告为准。",
  no_file: "这条公告没有公开附件，项目明细请看原公告。",
  failed: "附件下载或解析失败，系统会再试；现在以原公告为准。",
  blocked: "原网站需要人工验证，暂时取不到附件，请打开原公告查看。",
};

const LEVEL_TONES: Record<MatchSummary["level"], string> = {
  high: "bg-accent-soft text-accent",
  medium: "bg-amber-soft text-amber-ink",
  low: "bg-hot-soft text-hot",
  unknown: "bg-bg-sunk text-ink-3",
};

const counts = (m: { met: number; unmet: number; unknown: number }) =>
  [m.met && `满足 ${m.met}`, m.unmet && `不满足 ${m.unmet}`, m.unknown && `需核实 ${m.unknown}`].filter(Boolean).join(" · ");

/** 匹配度：等级和建议的投标主体（各公司结果一样时不建议）；没比的不显示。 */
export function MatchTag({ match }: { match: MatchSummary | null }) {
  if (!match) return null;
  const title = match.level === "unknown"
    ? "我司资料里找不到能对上的，也没有明确不满足的，需人工核实"
    : `${match.company ? `建议投标主体 ${match.company}` : "各公司结果相同"}：${counts(match)}。系统初判，以商务核实为准`;
  return (
    <span title={title} className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[11.5px] font-semibold ${LEVEL_TONES[match.level]}`}>
      {match.level === "unknown" ? "资料不足" : `匹配度 ${MATCH_LEVEL_LABELS[match.level]}`}{match.company && ` · ${shortCompany(match.company)}`}
    </span>
  );
}

/** 详情里：每家公司（投标主体）对这个项目的满足情况，建议的排第一。 */
export function EntityList({ match }: { match: MatchSummary }) {
  return (
    <ul className="mt-1 space-y-0.5 text-[12.5px] text-ink-3">
      {match.entities.map((e, k) => (
        <li key={e.company} className={k === 0 ? "font-medium text-ink-2" : ""}>
          {k === 0 && match.company ? "建议 " : ""}{e.company}：{counts(e) || "—"}
        </li>
      ))}
    </ul>
  );
}

const STATUS_TONES: Record<MatchStatus, string> = { met: "text-accent", unmet: "text-hot", unknown: "text-amber-ink" };

function StatusMark({ r }: { r: ItemRequirement }) {
  if (!r.status) return null;
  return <span className={`mr-1 font-semibold ${STATUS_TONES[r.status]}`} title={r.note || undefined}>[{MATCH_STATUS_LABELS[r.status]}]</span>;
}

const GROUPS: RequirementGroup[] = ["qualification", "performance", "personnel"];

/** 一类要求没写时的说法：公告说详见招标文件的照说，否则“未写明”。 */

/**
 * 资质、业绩、人员三行，每行都在（没写的写“公告未写明”或“见采购文件（需下载）”），商务一眼看清。compact 用在列表卡片和表格里：每行最多两行字；
 * 完整的用在详情里：每条一行，带对比说明和出处。
 */
export function Requirements({ o, compact = false }: { o: Pick<OpportunityCard, "requirements" | "requirementsInDocuments">; compact?: boolean }) {
  return (
    <dl className={compact ? "grid gap-1 text-[12.5px]" : "space-y-2.5 text-[13.5px]"}>
      {GROUPS.map((g) => {
        const rs = o.requirements.filter((r) => r.group === g);
        return (
          <div key={g} className={compact ? "flex min-w-0 gap-2" : ""}>
            <dt className={compact ? "shrink-0 text-ink-4" : "text-[13px] font-semibold text-ink"}>{REQUIREMENT_GROUP_LABELS[g]}{compact ? "" : "要求"}</dt>
            {rs.length === 0 ? (
              <dd className={`text-ink-4 ${compact ? "" : "mt-0.5"}`}>{missingRequirement(o.requirementsInDocuments)}</dd>
            ) : compact ? (
              <dd className="line-clamp-2 min-w-0 break-words text-ink-2">
                {rs.map((r, k) => <span key={k}>{k > 0 && "；"}<StatusMark r={r} />{r.text}</span>)}
              </dd>
            ) : (
              <dd className="mt-0.5">
                <ul className="space-y-1 leading-[1.75] text-ink-2">
                  {rs.map((r, k) => (
                    <li key={k} className="whitespace-pre-line break-words">
                      <StatusMark r={r} />{r.text}
                      {(r.note || r.from === "notice") && (
                        <span className="block text-[12px] text-ink-4">{[r.note, r.from === "notice" ? "出自公告正文的通用要求" : ""].filter(Boolean).join(" · ")}</span>
                      )}
                    </li>
                  ))}
                </ul>
              </dd>
            )}
          </div>
        );
      })}
    </dl>
  );
}
