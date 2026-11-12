// 推到钉钉群（自定义机器人，加签）：后台“投标商机”里配的每个推送群，各按自己选的业务方向、来源和要不要待确认，
// 一份公告里有对得上的项目就推一条（干什么、限价或预算、时间节点、资质业绩要求），@ 关注这些方向的提醒人；每天早上再推一次汇总。
// 安全阀 DINGTALK_PUSH_ENABLED 只有设成 true 才发。
// 每个群的每条消息在 opp_pushes 里占一行防重复（g<群>:notice:<公告>、g<群>:digest:<日期>）：明确失败的最多再试两次，
// 结果不明（超时、断网）的不自动重发。
import { createHmac } from "node:crypto";
import { config } from "@aihot/backend/config";
import { sql } from "@aihot/backend/db";
import { beijingDate } from "@aihot/contracts/time";
import type { NoticeDetails, PushMention, RequirementKind, SourceKey, Verdict } from "../types.ts";
import { activeGroups, loadGroup, type GroupRow } from "./groups.ts";
import { deadlineAt, deadlineOf, isExpired, loadNotice, noticeItems, packageLabel, sourceName, type ItemRow } from "./store.ts";

const MAX_ITEMS = 8;
export const MAX_PUSH_ATTEMPTS = 3;
/** 超过这么久才取到附件的公告不再实时推（比如推送刚打开时的旧公告），只进每日汇总。 */
const FRESH_HOURS = 48;

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

/** 占住一条消息：没发过的，或者明确失败且次数没用完的。 */
async function claim(key: string): Promise<boolean> {
  const rows = await sql`
    INSERT INTO opp_pushes (key, status, attempts) VALUES (${key}, 'sending', 1)
    ON CONFLICT (key) DO UPDATE SET status = 'sending', attempts = opp_pushes.attempts + 1, error = ''
      WHERE opp_pushes.status = 'failed' AND opp_pushes.attempts < ${MAX_PUSH_ATTEMPTS}
    RETURNING key`;
  return rows.length > 0;
}

type Outcome = "sent" | "failed" | "unknown" | "skipped";

/** 提醒人的手机号写进正文末尾，钉钉显示成 @姓名。 */
const withMentions = (text: string, mentions: PushMention[]) =>
  mentions.length ? `${text}\n\n提醒：${mentions.map((m) => `@${m.mobile}`).join(" ")}` : text;

async function deliver(g: GroupRow, key: string, title: string, text: string, mentions: PushMention[]): Promise<Outcome> {
  if (!(await claim(key))) return "skipped";
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
 * 群选了方向或来源时只要这些，没归到方向的项目只推到不限方向的群。
 */
export function wants(g: Pick<GroupRow, "lines" | "sources" | "include_maybe">, source: SourceKey, i: { verdict: Verdict; line: string }): boolean {
  if (i.verdict !== "relevant" && i.verdict !== "maybe") return false;
  if (i.verdict === "maybe" && (!g.include_maybe || source === "web")) return false;
  if (g.sources.length && !g.sources.includes(source)) return false;
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
const shown = (s: string) => s.trim() !== "" && s.trim() !== "/";
// 钉钉 markdown 里这些字符会改变排版；项目原文里出现时转义掉。
const md = (s: string) => s.replace(/([\\`*_[\]#>|])/g, "\\$1");

/**
 * 站内页面的链接包成钉钉的跳转链接：电脑上在钉钉侧边栏、手机上在钉钉里打开，登录页能向钉钉要免登码。
 * 普通网址在电脑版钉钉里会用系统浏览器打开，那里只能输账号密码。原文等站外链接不包。
 */
export const sitePage = (path: string) =>
  `dingtalk://dingtalkclient/page/link?url=${encodeURIComponent(`${config.siteUrl}${path}`)}&pc_slide=true`;

type Notice = NonNullable<Awaited<ReturnType<typeof loadNotice>>>;

/** 干什么：项目自己的采购内容；其他平台的资料有标包时用标包范围。 */
function scopeText(i: ItemRow, n: Notice): string {
  const lots = (n.details?.lots ?? []).map((l) => [l.name, l.scope].filter(Boolean).join("：")).filter(Boolean);
  return n.source === "web" && lots.length ? lots.join("；") : i.scope;
}

function itemBlock(k: number, i: ItemRow, n: Notice): string {
  const ceiling = formatCeiling(i.ceiling, i.ceiling_kind);
  const facts = [n.source === "web" ? "" : packageLabel(i), ceiling && `限价 ${ceiling}`, i.location]
    .filter((s) => s && shown(s)).map(md).join(" ｜ ");
  const scope = scopeText(i, n);
  const lines = [
    `**${k}. ${md(i.project_name)}**${i.verdict === "maybe" ? "（待确认）" : ""}`,
    facts,
    shown(scope) && scope.trim() !== i.project_name.trim() ? `采购内容：${md(short(scope, 90))}` : "",
    i.line || i.reason ? `${md(i.line)}${i.line && i.reason ? "：" : ""}${md(short(i.reason, 60))}` : "",
    shown(i.qualifications) ? `资质要求：${md(short(i.qualifications, 70))}` : "",
    shown(i.performance) ? `业绩要求：${md(short(i.performance, 70))}` : "",
    shown(i.personnel) ? `人员要求：${md(short(i.personnel, 50))}` : "",
  ];
  return lines.filter(Boolean).join("\n\n");
}

const REQUIREMENT_GROUPS: Array<[string, RequirementKind]> = [
  ["资质", "qualification"], ["业绩", "performance"], ["人员", "personnel"], ["授权", "authorization"], ["财务", "financial"],
];

/** 公告正文里对所有包都适用的要求（营业执照、信用这类通用条件不列）。 */
function commonBlock(d: NoticeDetails | null): string {
  if (!d) return "";
  const lines = REQUIREMENT_GROUPS.map(([label, kind]) => {
    const texts = d.requirements.filter((r) => r.kind === kind).map((r) => r.text);
    return texts.length ? `${label}：${md(short(texts.join("；"), 140))}` : "";
  }).filter(Boolean);
  if (d.detailsInDocuments) lines.push("资格和技术要求另见招标文件，公告里没有写全。");
  return lines.length ? ["**公告通用要求**", ...lines].join("\n\n") : "";
}

/** 时间节点：获取截止、报名截止、投标截止、开标，来源原文或从公告正文抽出。 */
function timesLine(n: Notice): string {
  const t = n.details?.times;
  return [
    n.file_deadline && `获取截止：**${md(n.file_deadline)}**`,
    t?.signupDeadline && `报名截止：**${md(t.signupDeadline)}**`,
    t?.bidDeadline && `投标截止：**${md(t.bidDeadline)}**`,
    n.opening_time && n.opening_time !== t?.bidDeadline && `开标：${md(n.opening_time)}`,
  ].filter(Boolean).join(" ｜ ");
}

const order = (a: ItemRow, b: ItemRow) => (a.verdict === b.verdict ? a.ordinal - b.ordinal : a.verdict === "relevant" ? -1 : 1);

/** 一份公告发给一个群的消息，只列这个群要的项目。 */
function noticeMessage(n: Notice, items: ItemRow[]): { title: string; text: string } {
  const relevant = items.filter((i) => i.verdict === "relevant").length;
  const headline = relevant > 0 ? `${relevant} 个相关项目${items.length > relevant ? `，${items.length - relevant} 个待确认` : ""}` : `${items.length} 个待确认项目`;
  const d = n.details;
  const common = commonBlock(d);
  const text = [
    `#### 投标商机：${headline}`,
    `**${md(n.title)}**`,
    [md(sourceName(n)), n.buyer && `采购人：${md(n.buyer)}`, n.batch && `批次 ${md(n.batch)}`].filter(Boolean).join(" ｜ "),
    timesLine(n),
    [d?.budget && `预算 ${md(d.budget)}`, d?.consortium, d?.region && md(d.region)].filter(Boolean).join(" ｜ "),
    "---",
    ...items.slice(0, MAX_ITEMS).map((i, k) => itemBlock(k + 1, i, n)),
    items.length > MAX_ITEMS ? `另有 ${items.length - MAX_ITEMS} 个对得上的项目，点下面查看。` : "",
    common ? `---\n\n${common}` : "",
    n.source === "web"
      ? `[查看详情 →](${sitePage(`/opportunities/${encodeURIComponent(n.id)}`)}) ｜ [原文](${n.url})`
      : `[查看本批次全部 ${n.item_count} 个项目 →](${sitePage(`/opportunities/${encodeURIComponent(n.id)}`)})`,
  ].filter(Boolean).join("\n\n");
  return { title: `投标商机｜${short(items[0]!.project_name, 24)}${items.length > 1 ? `等 ${items.length} 项` : ""}`, text };
}

/**
 * 一份公告筛完、抽完要素后，推给每个要它的群。没开、没有群、存量公告、已经截止，或已经推过，都不发；
 * 群加上（或重新启用）之前发现的公告不推给这个群。每个群都推过或不需要推以后记 pushed_at，
 * 有群明确失败、还能再试的，等下一轮再试。
 */
export async function pushNotice(id: string, now = new Date()): Promise<string> {
  if (!pushEnabled()) return "disabled";
  const groups = (await activeGroups()).filter((g) => g.realtime);
  if (!groups.length) return "disabled";
  const n = await loadNotice(id);
  if (!n || n.backfill) return "skipped";
  if (now.getTime() - n.discovered_at.getTime() > FRESH_HOURS * 3600_000) return "stale";
  if (isExpired(deadlineOf(n), now)) return "expired";
  const all = (await noticeItems(id)).sort(order);
  const results: Outcome[] = [];
  for (const g of groups) {
    if (n.discovered_at < g.enabled_at) continue;
    const items = all.filter((i) => wants(g, n.source, i));
    if (!items.length) continue;
    const { title, text } = noticeMessage(n, items);
    results.push(await deliver(g, `g${g.id}:notice:${id}`, title, text, mentionsFor(g, items.map((i) => i.line))));
  }
  if (!results.includes("failed")) await sql`UPDATE opp_notices SET pushed_at = now() WHERE id = ${id}`;
  return results.includes("sent") ? "sent" : results.includes("failed") ? "failed" : results.includes("unknown") ? "unknown" : results.length ? "skipped" : "none";
}

interface DigestRow extends ItemRow { title: string; file_deadline: string; source: SourceKey; details: NoticeDetails | null; fetched_at: Date | null }

function digestMessage(rows: DigestRow[], now: Date): string | null {
  const due = (r: DigestRow) => deadlineAt(deadlineOf(r));
  const soon = rows.filter((r) => {
    const at = due(r);
    return at !== null && at.getTime() >= now.getTime() && at.getTime() - now.getTime() <= 72 * 3600_000;
  }).sort((a, b) => due(a)!.getTime() - due(b)!.getTime());
  const fresh = rows.filter((r) => r.fetched_at && r.fetched_at.getTime() <= now.getTime() && now.getTime() - r.fetched_at.getTime() <= 24 * 3600_000);
  if (soon.length === 0 && fresh.length === 0) return null;
  return [
    `#### 投标商机日报 ${beijingDate(now)}`,
    fresh.length ? `过去 24 小时新发现 **${fresh.length}** 个对得上的项目（${new Set(fresh.map((r) => r.notice_id)).size} 份公告）。` : "过去 24 小时没有新发现对得上的项目。",
    soon.length ? `**3 天内截止（${soon.length} 项）：**` : "",
    ...soon.slice(0, 12).map((r, k) => `${k + 1}. ${md(short(r.project_name, 40))}${r.verdict === "maybe" ? "（待确认）" : ""} ｜ ${md(deadlineOf(r))} 截止 ｜ [详情](${sitePage(`/opportunities/${encodeURIComponent(r.notice_id)}#item-${r.id}`)})`),
    soon.length > 12 ? `另有 ${soon.length - 12} 项，见[投标商机](${sitePage("/opportunities")})。` : "",
    `[打开投标商机 →](${sitePage("/opportunities")})`,
  ].filter(Boolean).join("\n\n");
}

/** 每日汇总，每个要汇总的群一份：过去 24 小时新发现的、这个群要的项目，以及其中 3 天内截止的。两样都没有就不发。 */
export async function pushDigest(now = new Date()): Promise<Record<string, string>> {
  if (!pushEnabled()) return { skipped: "push disabled" };
  const groups = (await activeGroups()).filter((g) => g.digest);
  if (!groups.length) return { skipped: "no digest groups" };
  const rows = await sql<DigestRow[]>`
    SELECT i.*, i.id::text AS id, n.title, n.file_deadline, n.source, n.details, n.fetched_at
    FROM opp_items i JOIN opp_notices n ON n.id = i.notice_id
    WHERE i.verdict IN ('relevant', 'maybe') AND n.discovered_at > now() - interval '30 days'`;
  const out: Record<string, string> = {};
  for (const g of groups) {
    const mine = rows.filter((r) => wants(g, r.source, r));
    const text = digestMessage(mine, now);
    out[`g${g.id}`] = text === null ? "none"
      : await deliver(g, `g${g.id}:digest:${beijingDate(now)}`, `投标商机日报 ${beijingDate(now)}`, text, mentionsFor(g, mine.map((r) => r.line)));
  }
  return out;
}

/** 后台“测试”：给一个群发一条说明文字并 @ 它的提醒人，不占用商机消息的防重复记录。 */
export async function pushTest(id: number): Promise<void> {
  const g = await loadGroup(id);
  if (!pushEnabled()) throw Object.assign(new Error("推送安全阀没有打开（服务器 .env 里 DINGTALK_PUSH_ENABLED=true）"), { statusCode: 400 });
  const text = `#### 投标商机推送测试\n\n“${md(g.name)}”已接通。发现与公司业务对得上的招标项目时会推到这里。\n\n[打开投标商机 →](${sitePage("/opportunities")})`;
  try {
    await send(g, "投标商机推送测试", withMentions(text, g.mentions), g.mentions.map((m) => m.mobile));
  } catch (error) {
    throw Object.assign(new Error((error as Error).message), { statusCode: 400 });
  }
}
