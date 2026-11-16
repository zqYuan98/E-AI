// 推到钉钉群（自定义机器人，加签）：每天 08:30、17:30 给后台“投标商机”里配的每个推送群发一条“盲投信息表”，
// 列出这个群还没收到过的、筛完并抽完要素的项目，每个项目同样几项要素（采购人、地区、限价、时间、资质 / 业绩 / 人员要求、
// 与我司资质的匹配度、来源和详情链接），按截止时间排序，末尾附站内信息表（可导出 Excel）和 48 小时内截止的提醒，@ 关注这些方向的提醒人。
// 钉钉机器人的 markdown 在手机上不显示表格，所以消息里是固定顺序的要素清单，真正的表格在站内信息表页。
// 安全阀 DINGTALK_PUSH_ENABLED 只有设成 true 才发。
// opp_pushes 里每个群每期一行 g<群>:sheet:<日期>:am|pm（items 记它列的项目），收到过的公告各一行 g<群>:notice:<公告>。
// 明确失败的一期在本期内随每 5 分钟的处理最多再试两次，没推成的项目留到下一期；结果不明（超时、断网）的不重发。
import { createHmac } from "node:crypto";
import { config } from "@aihot/backend/config";
import { sql } from "@aihot/backend/db";
import { beijingDate, beijingTime } from "@aihot/contracts/time";
import { MATCH_LEVEL_LABELS, shortCompany, type OpportunityCard, type PushMention, type RequirementGroup, type SourceKey, type Verdict } from "../types.ts";
import { entitiesKey, loadEntities } from "./company.ts";
import { activeGroups, loadGroup, type GroupRow } from "./groups.ts";
import { byDeadline, card, cardColumns, deadlineAt, detailsSettled, sheetKey, type CardRow } from "./store.ts";

/** 消息里最多列这么多项目，其余在信息表页看。 */
const MAX_ITEMS = 10;
/** 只列最近这么多天发现的公告（新加的群不会一下收到一大堆旧的）。 */
const FRESH_DAYS = 7;
const SOON_HOURS = 48;
export const MAX_PUSH_ATTEMPTS = 3;

export const pushEnabled = () => process.env.DINGTALK_PUSH_ENABLED === "true";

class PushOutcomeUnknown extends Error {}

async function send(g: Pick<GroupRow, "webhook" | "secret">, title: string, text: string, atMobiles: string[]): Promise<void> {
  const timestamp = Date.now();
  const sign = createHmac("sha256", g.secret).update(`${timestamp}\n${g.secret}`).digest("base64");
  let res: Response;
  try {
    res = await fetch(`${g.webhook}&timestamp=${timestamp}&sign=${encodeURIComponent(sign)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ msgtype: "markdown", markdown: { title, text }, at: { atMobiles, isAtAll: false } }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new PushOutcomeUnknown("钉钉没有响应，不确定是否已发出");
  }
  const body = await res.json().catch(() => null) as { errcode?: number; errmsg?: string } | null;
  if (!res.ok || body?.errcode !== 0) throw new Error(`钉钉拒绝：${res.status} ${body?.errcode ?? ""} ${String(body?.errmsg ?? "").slice(0, 120)}`);
}

/** 占住一条消息：没发过的，或者明确失败且次数没用完的。记下它列的项目。 */
async function claim(key: string, items: string[]): Promise<boolean> {
  const rows = await sql`
    INSERT INTO opp_pushes (key, status, attempts, items) VALUES (${key}, 'sending', 1, ${sql.json(items)})
    ON CONFLICT (key) DO UPDATE SET status = 'sending', attempts = opp_pushes.attempts + 1, error = '', items = EXCLUDED.items
      WHERE opp_pushes.status = 'failed' AND opp_pushes.attempts < ${MAX_PUSH_ATTEMPTS}
    RETURNING key`;
  return rows.length > 0;
}

type Outcome = "sent" | "failed" | "unknown" | "skipped";

/** 提醒人的手机号写进正文末尾，钉钉显示成 @姓名。 */
const withMentions = (text: string, mentions: PushMention[]) =>
  mentions.length ? `${text}\n\n提醒：${mentions.map((m) => `@${m.mobile}`).join(" ")}` : text;

async function deliver(g: GroupRow, key: string, title: string, text: string, mentions: PushMention[], items: string[]): Promise<Outcome> {
  if (!(await claim(key, items))) return "skipped";
  try {
    await send(g, title, withMentions(text, mentions), mentions.map((m) => m.mobile));
    await sql`UPDATE opp_pushes SET status = 'sent', sent_at = now() WHERE key = ${key}`;
    return "sent";
  } catch (error) {
    const status = error instanceof PushOutcomeUnknown ? "unknown" : "failed";
    await sql`UPDATE opp_pushes SET status = ${status}, error = ${String((error as Error).message).slice(0, 300)} WHERE key = ${key}`;
    return status;
  }
}

/**
 * 这个群要不要这个项目：相关的都要，待确认的看群的设置（其他招采平台的待确认不推，只在列表里看）；
 * 群选了方向或平台时只要这些，没归到方向的项目只推到不限方向的群。
 */
export function wants(g: Pick<GroupRow, "lines" | "sources" | "include_maybe">, n: { source: SourceKey; platform: string }, i: { verdict: Verdict; line: string }): boolean {
  if (i.verdict !== "relevant" && i.verdict !== "maybe") return false;
  if (i.verdict === "maybe" && (!g.include_maybe || n.source === "web")) return false;
  if (g.sources.length && !g.sources.includes(n.platform)) return false;
  return !g.lines.length || g.lines.includes(i.line);
}

/** 要 @ 的提醒人：关注的方向里有这次的项目，或者没限方向的。 */
export function mentionsFor(g: Pick<GroupRow, "mentions">, lines: Iterable<string>): PushMention[] {
  const hit = new Set(lines);
  return g.mentions.filter((m) => !m.lines.length || m.lines.some((l) => hit.has(l)));
}

/** 限价带单位：万元、元照写；折扣率 0.98 写成 98%。 */
export function formatCeiling(value: string, kind: string): string {
  const v = value.trim();
  if (!v || v === "/") return "";
  if (kind === "amount_wan") return `${v} 万元`;
  if (kind === "amount_yuan") return `${v} 元`;
  if (kind === "percent") {
    const n = Number(v);
    return Number.isFinite(n) && n <= 1 ? `折扣率 ${+(n * 100).toFixed(4)}%` : `折扣率 ${v}${v.endsWith("%") ? "" : "%"}`;
  }
  return v;
}

const short = (s: string, n: number) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};
// 钉钉 markdown 里这些字符会改变排版；项目原文里出现时转义掉。
const md = (s: string) => s.replace(/([\\`*_[\]#>|])/g, "\\$1");
/** “2026-11-17 12:00:00” → “11-17 12:00”；不是这个格式的照原文。 */
const when = (s: string) => /^\d{4}-(\d{2}-\d{2})(?:[ T](\d{2}:\d{2}))?/.exec(s.trim())?.slice(1).filter(Boolean).join(" ") ?? s;

/**
 * 站内页面的链接包成钉钉的跳转链接：电脑上在钉钉侧边栏、手机上在钉钉里打开，登录页能向钉钉要免登码。
 * 普通网址在电脑版钉钉里会用系统浏览器打开，那里只能输账号密码。原文等站外链接不包。
 */
export const sitePage = (path: string) =>
  `dingtalk://dingtalkclient/page/link?url=${encodeURIComponent(`${config.siteUrl}${path}`)}&pc_slide=true`;

/** 最近一期：17:30 以后是当天晚间，08:30 以后是当天早间，更早是前一天晚间（北京时间）。 */
export function sheetSlot(now: Date): { date: string; slot: "am" | "pm"; label: string } {
  const hm = beijingTime(now);
  if (hm >= "17:30") return { date: beijingDate(now), slot: "pm", label: "晚间" };
  if (hm >= "08:30") return { date: beijingDate(now), slot: "am", label: "早间" };
  return { date: beijingDate(new Date(now.getTime() - 86_400_000)), slot: "pm", label: "晚间" };
}

const GROUP_LINES: Array<[string, RequirementGroup]> = [["资质", "qualification"], ["业绩", "performance"], ["人员", "personnel"]];

/** 一类要求一行：没写的写“未写明”（公告说详见招标文件的写“详见招标文件”）。 */
function requirementLine(c: OpportunityCard, label: string, group: RequirementGroup): string {
  const rs = c.requirements.filter((r) => r.group === group);
  if (!rs.length) return `${label}：${c.requirementsInDocuments ? "详见招标文件" : "未写明"}`;
  return `${label}：${md(short(rs.map((r) => r.text).join("；"), 60))}`;
}

/** 匹配度：建议的投标主体、等级和条数，有不满足的写出第一条差在哪里。companyOn：有我司资质可比（宜搭同步到了或手填了）。 */
export function matchText(c: OpportunityCard, companyOn: boolean): string {
  const m = c.match;
  if (!m) return !c.requirements.length ? "无可比要求" : companyOn ? "待比对" : "没有我司资质";
  const parts = [m.met && `满足 ${m.met}`, m.unmet && `不满足 ${m.unmet}`, m.unknown && `需核实 ${m.unknown}`].filter(Boolean).join("，");
  const gap = c.requirements.find((r) => r.status === "unmet");
  return `${MATCH_LEVEL_LABELS[m.level]}，建议${shortCompany(m.company)}（${parts}${gap?.note ? `；${gap.note}` : ""}）`;
}

const detailPath = (c: OpportunityCard) => `/opportunities/${encodeURIComponent(c.noticeId)}#item-${c.id}`;

function itemBlock(k: number, c: OpportunityCard, companyOn: boolean): string {
  const limit = formatCeiling(c.ceiling, c.ceilingKind) || (c.noticeBudget && `预算 ${c.noticeBudget}`);
  const times = [c.fileDeadline && `获取截止 ${when(c.fileDeadline)}`, c.bidDeadline && `投标截止 ${when(c.bidDeadline)}`].filter(Boolean).join(" ｜ ");
  return [
    `**${k}. [${md(short(c.projectName || c.noticeTitle, 60))}](${sitePage(detailPath(c))})**${c.verdict === "maybe" ? "（待确认）" : ""}`,
    [`采购人：${md(c.buyer) || "未写明"}`, c.location && `地区：${md(c.location)}`, `限价：${md(limit || "未写明")}`].filter(Boolean).join(" ｜ "),
    `时间：${md(times || "未写明")}`,
    ...GROUP_LINES.map(([label, group]) => requirementLine(c, label, group)),
    `匹配度：${md(matchText(c, companyOn))} ｜ ${md(c.sourceName)}`,
  ].join("\n\n");
}

function sheetMessage(slot: ReturnType<typeof sheetSlot>, fresh: OpportunityCard[], soon: OpportunityCard[], key: string, companyOn: boolean): { title: string; text: string } {
  const relevant = fresh.filter((c) => c.verdict === "relevant").length;
  const text = [
    `#### 盲投信息表｜${slot.date} ${slot.label}`,
    fresh.length
      ? `上次推送以来新筛出 **${fresh.length}** 个项目（相关 ${relevant}${fresh.length > relevant ? `，待确认 ${fresh.length - relevant}` : ""}），按截止时间排序。`
      : "上次推送以来没有新筛出的项目。",
    ...(fresh.length ? ["---", ...fresh.slice(0, MAX_ITEMS).map((c, k) => itemBlock(k + 1, c, companyOn))] : []),
    fresh.length > MAX_ITEMS ? `另有 ${fresh.length - MAX_ITEMS} 个项目，见信息表。` : "",
    fresh.length ? `[打开信息表（${fresh.length} 个项目，可导出 Excel）→](${sitePage(`/opportunities?sheet=${encodeURIComponent(key)}`)})` : "",
    soon.length ? `---\n\n**${SOON_HOURS} 小时内截止（之前推过）：**` : "",
    ...soon.slice(0, 8).map((c, k) => `${k + 1}. [${md(short(c.projectName, 40))}](${sitePage(detailPath(c))}) ｜ ${md(when(c.fileDeadline || c.bidDeadline))} 截止`),
    `[打开投标商机 →](${sitePage("/opportunities")})`,
  ].filter(Boolean).join("\n\n");
  return { title: `盲投信息表 ${slot.date} ${slot.label}${fresh.length ? `（${fresh.length} 项）` : ""}`, text };
}

type SheetRow = CardRow & { ready: boolean };

/**
 * 推一期信息表，每个群一条。定时（08:30、17:30）调用时推这一期；retry 时（每 5 分钟的处理）只重推这一期明确失败、次数没用完的群。
 * 每个群列的是它要的、还没收到过的项目：公告筛完、要素抽完（我司资质填了的还要比对完，模型不行时最多等到取到附件 6 小时），
 * 不是存量，没截止，在这个群加上（或重新启用）以后、最近 7 天内发现的。
 */
export async function pushSheet(now = new Date(), opts: { retry?: boolean } = {}): Promise<Record<string, string>> {
  if (!pushEnabled()) return { skipped: "push disabled" };
  const groups = await activeGroups();
  if (!groups.length) return { skipped: "no groups" };
  const slot = sheetSlot(now);
  const keys = new Map(groups.map((g) => [g.id, sheetKey(g.id, slot.date, slot.slot)]));
  const existing = new Map((await sql<{ key: string; status: string; attempts: number }[]>`
    SELECT key, status, attempts FROM opp_pushes WHERE key = ANY(${[...keys.values()]})`).map((r) => [r.key, r]));
  const todo = opts.retry
    ? groups.filter((g) => { const r = existing.get(keys.get(g.id)!); return r?.status === "failed" && r.attempts < MAX_PUSH_ATTEMPTS; })
    : groups.filter((g) => !existing.has(keys.get(g.id)!));
  if (!todo.length) return { skipped: "nothing due" };

  const key = entitiesKey(await loadEntities(now));
  const rows = await sql<SheetRow[]>`
    SELECT ${cardColumns()}, (n.screened AND ${detailsSettled()} AND (${key} = '' OR n.match_failures >= 3 OR n.fetched_at < now() - interval '6 hours'
        OR NOT EXISTS (SELECT 1 FROM opp_items j WHERE j.notice_id = n.id AND j.verdict IN ('relevant', 'maybe') AND j.match_key <> ${key}))) AS ready
    FROM opp_items i JOIN opp_notices n ON n.id = i.notice_id
    WHERE i.verdict IN ('relevant', 'maybe') AND NOT n.backfill AND n.discovered_at > now() - make_interval(days => ${FRESH_DAYS})`;
  const cards = rows.map((r) => ({ c: card(r, now), ready: r.ready, discoveredAt: r.discovered_at })).filter((x) => !x.c.expired);
  const received = new Set((await sql<{ key: string }[]>`
    SELECT key FROM opp_pushes WHERE key LIKE 'g%:notice:%' AND status <> 'failed' AND created_at > now() - make_interval(days => ${FRESH_DAYS * 2})`).map((r) => r.key));

  const out: Record<string, string> = {};
  for (const g of todo) {
    const got = (c: OpportunityCard) => received.has(`g${g.id}:notice:${c.noticeId}`);
    const mine = cards.filter((x) => x.discoveredAt >= g.enabled_at && wants(g, x.c, x.c));
    const fresh = mine.filter((x) => x.ready && !got(x.c)).map((x) => x.c).sort(byDeadline);
    const soon = mine.filter((x) => got(x.c)).map((x) => x.c).filter((c) => {
      const at = deadlineAt(c.fileDeadline || c.bidDeadline);
      return at !== null && at.getTime() - now.getTime() <= SOON_HOURS * 3600_000;
    }).sort(byDeadline);
    const k = keys.get(g.id)!;
    const { title, text } = sheetMessage(slot, fresh, soon, k, key !== "");
    const outcome = await deliver(g, k, title, text, fresh.length ? mentionsFor(g, fresh.map((c) => c.line)) : [], fresh.map((c) => c.id));
    // 发出去了（或不确定发没发）的公告记作这个群收到过，下一期不再列；明确失败的留到重试或下一期。
    if (outcome === "sent" || outcome === "unknown") {
      const notices = [...new Set(fresh.map((c) => `g${g.id}:notice:${c.noticeId}`))];
      await sql`INSERT INTO opp_pushes (key, status, attempts, sent_at)
        SELECT k, ${outcome}, 1, now() FROM unnest(${notices}::text[]) AS k
        ON CONFLICT (key) DO UPDATE SET status = EXCLUDED.status, sent_at = EXCLUDED.sent_at, error = ''`;
    }
    out[`g${g.id}`] = outcome;
  }
  return out;
}

/** 后台“测试”：给一个群发一条说明文字并 @ 它的提醒人，不占用信息表的防重复记录。 */
export async function pushTest(id: number): Promise<void> {
  const g = await loadGroup(id);
  if (!pushEnabled()) throw Object.assign(new Error("推送安全阀没有打开（服务器 .env 里 DINGTALK_PUSH_ENABLED=true）"), { statusCode: 400 });
  const text = `#### 投标商机推送测试\n\n“${md(g.name)}”已接通。每天 08:30、17:30 会把新筛出的投标项目做成盲投信息表推到这里。\n\n[打开投标商机 →](${sitePage("/opportunities")})`;
  try {
    await send(g, "投标商机推送测试", withMentions(text, g.mentions), g.mentions.map((m) => m.mobile));
  } catch (error) {
    throw Object.assign(new Error((error as Error).message), { statusCode: 400 });
  }
}
