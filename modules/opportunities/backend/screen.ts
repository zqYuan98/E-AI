// 筛选：一份公告拆出的项目，先按业务口径的排除词去掉一定无关的，其余分批交给模型判断相关 / 待确认 / 无关。
// 模型临时出错（中转站高峰期 503、限流、预算到顶）时这份公告先不推，下一轮再筛；已经答过的批次复用回执，不重复花钱。
// 取到附件 6 小时后模型还是不行，或者模型调用被关掉，就按关键词兜底：项目名或包名命中方向关键词的记“待确认”，其余无关。
import { createHash } from "node:crypto";
import { z } from "zod";
import { sql } from "@aihot/backend/db";
import { chatJson } from "@aihot/backend/providers/llm";
import { modelFor } from "@aihot/backend/editorial/models";
import { promptText, promptVersion } from "@aihot/backend/editorial/prompts";
import { logError } from "@aihot/backend/lib/log-error";
import { modelCallsOn } from "@aihot/backend/operations/switches";
import type { BusinessProfile, Verdict } from "../types.ts";
import { loadProfile, matchKeywords } from "./profile.ts";
import { noticeItems, type ItemRow } from "./store.ts";

/** 一次交给模型的项目数，和每个项目采购内容的长度。 */
const CHUNK = 60;
const SCOPE_CHARS = 150;
/** 一份公告最多交给模型这么多项目；更多的（极少见）其余按关键词处理。 */
const MAX_MODEL_ITEMS = 600;
/** 取到附件后这么久模型还筛不了，就按关键词兜底推送，不再等。 */
const WAIT_FOR_MODEL_MS = 6 * 3600_000;

const VERDICTS = { 相关: "relevant", 待确认: "maybe", 无关: "irrelevant" } as const;

const Answer = z.object({
  items: z.array(z.object({
    n: z.number().int(),
    verdict: z.enum(["相关", "待确认", "无关"]),
    line: z.string().max(40).catch(""),
    why: z.string().max(200).catch(""),
  }).nullable().catch(null)).max(CHUNK * 2).catch([]),
});

interface Decision { verdict: Verdict; line: string; reason: string; matched_by: string }

function systemPrompt(profile: BusinessProfile): string {
  const lines = profile.lines.map((l) => `- **${l.name}**：${l.keywords.join("、")}`).join("\n");
  return promptText("opportunity-screen", { lines, exclude: profile.exclude.length ? profile.exclude.join("、") : "（无）" });
}

function itemText(n: number, i: ItemRow): string {
  const scope = i.scope.length > SCOPE_CHARS ? `${i.scope.slice(0, SCOPE_CHARS)}…` : i.scope;
  return [`#${n} 项目：${i.project_name}`, `分标/包：${[i.section_name, i.package, i.package_name].filter(Boolean).join(" / ")}`,
    scope ? `采购内容：${scope}` : null].filter(Boolean).join("\n");
}

function byKeywords(profile: BusinessProfile, i: ItemRow): Decision {
  const m = matchKeywords(profile, i);
  if (m.excludedBy) return { verdict: "irrelevant", line: "", reason: `排除词：${m.excludedBy}`, matched_by: "exclude" };
  // 采购内容里顺带提到的词（施工里的“交换机”、试验里的“在线监测”）不算，只认项目名和包名。
  const first = m.nameLines[0];
  if (!first) return { verdict: "irrelevant", line: "", reason: "", matched_by: "keyword" };
  return { verdict: "maybe", line: first.name, reason: `关键词命中：${first.words.slice(0, 3).join("、")}（未经模型判断）`, matched_by: "keyword" };
}

async function askModel(noticeId: string, chunk: ItemRow[], index: number, profile: BusinessProfile, model: string): Promise<Map<string, Decision>> {
  const user = chunk.map((i, k) => itemText(k + 1, i)).join("\n\n");
  const res = await chatJson({
    model,
    purpose: "opportunity_screen",
    subject: `opportunity:${noticeId}:${index}`,
    attemptTag: createHash("sha256").update(`${JSON.stringify(profile)}\n${user}`).digest("hex").slice(0, 16),
    promptVersion: promptVersion("opportunity-screen"),
    system: systemPrompt(profile),
    user,
    schema: Answer,
    temperature: 0.1,
    maxTokens: 6000,
  });
  const names = new Set(profile.lines.map((l) => l.name));
  const out = new Map<string, Decision>();
  for (const a of res.data.items) {
    if (!a) continue;
    const item = chunk[a.n - 1];
    if (!item || out.has(item.id)) continue;
    const verdict = VERDICTS[a.verdict];
    out.set(item.id, { verdict, line: verdict !== "irrelevant" && names.has(a.line) ? a.line : "", reason: a.why.trim(), matched_by: "model" });
  }
  return out;
}

/** 筛一份公告。返回各结论的数量；模型用没用上记在 model 里。模型临时出错、还在等待期内时返回 deferred，不落结论。 */
export async function screenNotice(noticeId: string, now = new Date()): Promise<{ relevant: number; maybe: number; irrelevant: number; model: boolean } | { deferred: true }> {
  const profile = await loadProfile();
  const items = await noticeItems(noticeId);
  const decisions = new Map<string, Decision>();
  const toModel: ItemRow[] = [];
  for (const i of items) {
    const k = byKeywords(profile, i);
    if (k.matched_by === "exclude") decisions.set(i.id, k);
    else if (toModel.length < MAX_MODEL_ITEMS) toModel.push(i);
  }
  let usedModel = false;
  if (toModel.length > 0 && (await modelCallsOn())) {
    const model = await modelFor("opportunities");
    for (let start = 0, index = 0; start < toModel.length; start += CHUNK, index += 1) {
      const chunk = toModel.slice(start, start + CHUNK);
      try {
        for (const [id, d] of await askModel(noticeId, chunk, index, profile, model)) decisions.set(id, d);
        usedModel = true;
      } catch (error) {
        const [n] = await sql<{ fetched_at: Date | null }[]>`
          UPDATE opp_notices SET screen_failures = screen_failures + 1 WHERE id = ${noticeId} RETURNING fetched_at`;
        const waited = now.getTime() - (n?.fetched_at ?? now).getTime();
        console.error(JSON.stringify({ level: "warn", msg: "opportunity screen model failed", noticeId, waitedMinutes: Math.round(waited / 60_000), err: logError(error) }));
        if (waited < WAIT_FOR_MODEL_MS) return { deferred: true };
        // 等够了：这一批和后面的按关键词兜底，不让推送一直等模型。
        break;
      }
    }
  }
  for (const i of items) if (!decisions.has(i.id)) decisions.set(i.id, byKeywords(profile, i));
  const tally = { relevant: 0, maybe: 0, irrelevant: 0 };
  await sql.begin(async (tx) => {
    for (const i of items) {
      const d = decisions.get(i.id)!;
      if (d.verdict !== "pending") tally[d.verdict] += 1;
      await tx`UPDATE opp_items SET verdict = ${d.verdict}, line = ${d.line}, reason = ${d.reason.slice(0, 200)}, matched_by = ${d.matched_by}
        WHERE id = ${i.id}::bigint`;
    }
    await tx`UPDATE opp_notices SET screened = true WHERE id = ${noticeId}`;
  });
  return { ...tally, model: usedModel };
}
