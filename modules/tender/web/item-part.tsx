// 条目页标题下的“标讯要素”：截止时间和还剩几天、金额、采购人或中标人、项目编号，可以展开核对公告原文。
// 什么也没认出来时不出现。倒计时在浏览器里按现在的时间算：条目页有缓存，服务器上算的天数会过时。
import { useEffect, useState, type ReactNode } from "react";
import type { ItemPagePart } from "@aihot/web/modules";
import { STAGE_LABELS, type Moment, type TenderFacts } from "../types.ts";
import { amountText, countdown, momentText, URGENCY_CLASS } from "./format.ts";

function Line({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex gap-3">
      <dt className="w-[6.5em] shrink-0 text-ink-4">{label}</dt>
      <dd className="min-w-0 break-words text-ink">{children}</dd>
    </div>
  );
}

function When({ m, now }: { m: Moment; now: string | null }) {
  const left = now ? countdown(m, now) : null;
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <span className="num font-medium">{momentText(m)}</span>
      {left && <span className={`rounded-full px-2 py-px text-[12px] font-medium ${URGENCY_CLASS[left.urgency]}`}>{left.text}</span>}
    </span>
  );
}

function Block({ data }: { data: unknown }) {
  const f = data as TenderFacts;
  const [now, setNow] = useState<string | null>(null);
  useEffect(() => setNow(new Date().toISOString()), []);
  if (!f.deadline && !f.signup && !f.amount && !f.purchaser && !f.winner) return null;
  const quotes = [f.deadline, f.signup, f.amount].flatMap((q) => (q ? [q.quote] : []));
  return (
    <section aria-label="标讯要素" className="mt-5 rounded-card border border-line bg-surface px-4 py-3.5 text-[14px] leading-6">
      <div className="mb-2 flex flex-wrap items-center gap-x-2 text-[12px] text-ink-4">
        <span className="font-semibold text-accent">标讯要素</span>
        {f.stage && <span>{STAGE_LABELS[f.stage]}</span>}
        {f.region && <span>· {f.region}</span>}
      </div>
      <dl className="space-y-1">
        {f.deadline && <Line label={f.deadline.label}><When m={f.deadline} now={now} /></Line>}
        {f.signup && <Line label={f.signup.label}><When m={f.signup} now={now} /></Line>}
        {f.amount && <Line label={f.amount.label}><span className="num font-medium">{amountText(f.amount.value)}</span></Line>}
        {f.winner && <Line label={f.stage === "candidate" ? "第一候选人" : "中标人"}>{f.winner}</Line>}
        {f.purchaser && <Line label="采购人">{f.purchaser}</Line>}
        {f.agent && <Line label="代理机构">{f.agent}</Line>}
        {f.projectNo && <Line label="项目编号"><span className="mono">{f.projectNo}</span></Line>}
      </dl>
      {quotes.length > 0 && (
        <details className="mt-2 text-[12.5px] text-ink-3">
          <summary className="cursor-pointer select-none text-ink-4 hover:text-ink-2">核对公告原文</summary>
          <ul className="mt-1 space-y-1">{quotes.map((q) => <li key={q}>“{q}”</li>)}</ul>
        </details>
      )}
      <p className="mt-1.5 text-[11.5px] leading-5 text-ink-4">从公告原文自动识别，以原文和之后的变更公告为准。</p>
    </section>
  );
}

const part: ItemPagePart = { Block };
export default part;
