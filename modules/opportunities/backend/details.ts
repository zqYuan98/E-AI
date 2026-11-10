// 公告要素：模型从公告正文里抽预算、关键时间、资格（资质、业绩、人员）和标包，每项带原话；程序逐条核对原话确实在正文里，
// 对不上的去掉（时间还要核对日期在原话里，金额要核对数字在原话里）。提示词和格式沿用招采公告抽取
// （industry/prompts/tender-extract.md），格式在 details-schema.ts。
// 只抽有相关或待确认项目的公告；推送等它抽完，模型不行时最多等到取到附件 6 小时（见 run.ts）。
import { createHash } from "node:crypto";
import { sql } from "@aihot/backend/db";
import { chatJson } from "@aihot/backend/providers/llm";
import { BudgetExceededError, ProviderRejectedError, ReceiptBusyError } from "@aihot/backend/providers/receipts";
import { modelFor } from "@aihot/backend/editorial/models";
import { promptText, promptVersion } from "@aihot/backend/editorial/prompts";
import { logError } from "@aihot/backend/lib/log-error";
import { modelCallsOn } from "@aihot/backend/operations/switches";
import { DetailsSchema, type Extracted } from "./details-schema.ts";
import { SOURCE_NAMES, type NoticeDetails, type SourceKey } from "../types.ts";

const MAX_TEXT = 30_000;
/** 每轮最多抽几份（一份几十秒）。 */
const PER_RUN = 4;
export const MAX_DETAIL_FAILURES = 3;

type Quoted<T> = { value: T; quote: string } | null;

const norm = (s: string) => s.normalize("NFKC").replace(/\s+/g, "");
const numbers = (s: string) => (s.normalize("NFKC").replace(/,/g, "").match(/\d+(?:\.\d+)?/g) ?? []).map(Number);
const wan = (n: number) => `${+n.toFixed(4)} 万元`;

/** 只留原话能在正文里找到的字段；时间的月、日和金额的数字（万元、元或亿元写法）也要在原话里。 */
export function verified(out: Extracted, text: string): NoticeDetails {
  const body = norm(text);
  const found = (quote: string | null | undefined) => !!quote && norm(quote).length >= 4 && body.includes(norm(quote));
  const pick = <T,>(f: Quoted<T>): T | null => (f && found(f.quote) ? f.value : null);
  const time = (f: Quoted<string>) => {
    const value = pick(f);
    if (!value) return "";
    const [, month, day] = value.split(/[- :]/).map(Number);
    const inQuote = numbers(f!.quote);
    return inQuote.includes(month!) && inQuote.includes(day!) ? value : "";
  };
  const amount = (f: Quoted<number>) => {
    const value = pick(f);
    if (value === null) return "";
    const close = (a: number, b: number) => Math.abs(a - b) <= Math.max(1e-6, Math.abs(b) * 1e-6);
    return numbers(f!.quote).some((n) => close(n, value) || close(n, value * 10_000) || close(n * 10_000, value)) ? wan(value) : "";
  };
  const region = pick(out.region);
  const consortium = pick(out.allowsConsortium);
  return {
    projectName: pick(out.projectName) ?? "",
    buyer: pick(out.buyer) ?? "",
    budget: amount(out.budgetWan),
    agency: pick(out.agency) ?? "",
    region: region ? [region.province, region.city].filter(Boolean).join(" ") : "",
    consortium: consortium === null ? "" : consortium ? "接受联合体" : "不接受联合体",
    times: {
      docObtainEnd: time(out.times.docObtainEnd),
      signupDeadline: time(out.times.signupDeadline),
      bidDeadline: time(out.times.bidDeadline),
      opening: time(out.times.opening),
    },
    lots: out.lots.filter((l) => found(l.quote)).slice(0, 50)
      .map((l) => ({ no: l.no ?? "", name: l.name, scope: pick(l.scope) ?? "", budget: amount(l.budgetWan) })),
    requirements: out.requirements.filter((r) => found(r.quote)).slice(0, 30)
      .map((r) => ({ kind: r.kind, text: r.text, quote: r.quote.slice(0, 300), lots: r.lots ?? [] })),
    detailsInDocuments: out.detailsInDocuments,
  };
}

interface Candidate { id: string; source: SourceKey; source_name: string; title: string; url: string; published: string; doc_text: string }

async function extractOne(n: Candidate, model: string): Promise<NoticeDetails> {
  const text = `${n.title}\n${n.doc_text}`;
  const res = await chatJson({
    model,
    purpose: "opportunity_details",
    subject: `opportunity:${n.id}:details`,
    attemptTag: createHash("sha256").update(text).digest("hex").slice(0, 16),
    promptVersion: promptVersion("tender-extract"),
    system: promptText("tender-extract"),
    user: [
      `【来源】${n.source_name || SOURCE_NAMES[n.source]}`,
      `【发布时间】${n.published || "未知"}`,
      `【原文地址】${n.url}`,
      `【公告】\n${text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}\n（后文未提供）` : text}`,
    ].join("\n"),
    schema: DetailsSchema,
    temperature: 0.1,
    maxTokens: 6000,
  });
  return verified(res.data, text);
}

/** 抽一小批：筛完、有对得上的项目、还没抽过的公告。来源没写的获取截止、开标时间和采购人用抽出来的补上。 */
export async function extractDetails(): Promise<{ extracted: number; failed: number }> {
  const result = { extracted: 0, failed: 0 };
  if (!(await modelCallsOn())) return result;
  const rows = await sql<Candidate[]>`
    SELECT id, source, source_name, title, url, published, doc_text FROM opp_notices n
    WHERE screened AND details IS NULL AND doc_text <> '' AND details_failures < ${MAX_DETAIL_FAILURES}
      AND EXISTS (SELECT 1 FROM opp_items i WHERE i.notice_id = n.id AND i.verdict IN ('relevant', 'maybe'))
    ORDER BY discovered_at DESC LIMIT ${PER_RUN}`;
  if (rows.length === 0) return result;
  const model = await modelFor("opportunities");
  for (const n of rows) {
    try {
      const d = await extractOne(n, model);
      await sql`UPDATE opp_notices SET details = ${sql.json(d as never)},
          file_deadline = CASE WHEN file_deadline = '' THEN ${d.times.docObtainEnd} ELSE file_deadline END,
          opening_time = CASE WHEN opening_time = '' THEN ${d.times.opening} ELSE opening_time END,
          buyer = CASE WHEN buyer = '' THEN ${d.buyer} ELSE buyer END
        WHERE id = ${n.id}`;
      result.extracted += 1;
    } catch (error) {
      console.error(JSON.stringify({ level: "warn", msg: "opportunity details failed", noticeId: n.id, err: logError(error) }));
      // 服务拒绝（余额、限流）、预算熔断、回执占用：不是这份公告的问题，整批停下，下一轮再来，不计失败次数。
      if (error instanceof ProviderRejectedError || error instanceof BudgetExceededError || error instanceof ReceiptBusyError) break;
      await sql`UPDATE opp_notices SET details_failures = details_failures + 1 WHERE id = ${n.id}`;
      result.failed += 1;
    }
  }
  return result;
}
