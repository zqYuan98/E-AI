// 商机列表和批次详情共用的小件：判断标签、限价带单位、两个时间。时间和金额照来源原文显示，不换算时区。
import type { CeilingKind, OpportunityCard, Verdict } from "../types.ts";
import { VERDICT_LABELS } from "../types.ts";

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
  return <span className="inline-flex shrink-0 items-center rounded-full bg-bg-sunk px-2 py-0.5 text-[11.5px] text-ink-4">文件获取已截止</span>;
}

/** 限价和两个时间：没有的不写。 */
export function keyFacts(o: Pick<OpportunityCard, "ceiling" | "ceilingKind" | "fileDeadline" | "openingTime">): Array<[string, string]> {
  return ([
    ["最高限价", ceilingText(o.ceiling, o.ceilingKind)],
    ["采购文件获取截止", o.fileDeadline],
    ["开标（开启应答文件）时间", o.openingTime],
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
