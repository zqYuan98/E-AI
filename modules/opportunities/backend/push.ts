// 推到钉钉群（自定义机器人，加签）：一份公告里有对得上的项目就推一条（干什么、限价或预算、时间节点、资质业绩要求），
// 每天早上再推一次汇总。
// 安全阀 DINGTALK_PUSH_ENABLED 只有设成 true 才发；地址和加签密钥在 .env 的 DINGTALK_ROBOT_WEBHOOK / DINGTALK_ROBOT_SECRET。
// 每条消息在 opp_pushes 里占一行防重复：明确失败的最多再试两次，结果不明（超时、断网）的不自动重发。
import { createHmac } from "node:crypto";
import { config, credential } from "@aihot/backend/config";
import { sql } from "@aihot/backend/db";
import { beijingDate } from "@aihot/contracts/time";
import type { NoticeDetails, RequirementKind, SourceKey } from "../types.ts";
import { deadlineAt, deadlineOf, isExpired, loadNotice, noticeItems, packageLabel, sourceName, type ItemRow } from "./store.ts";

const WEBHOOK = /^https:\/\/oapi\.dingtalk\.com\/robot\/send\?access_token=[A-Za-z0-9]{20,128}$/;
const MAX_ITEMS = 8;
const MAX_ATTEMPTS = 3;
/** 超过这么久才取到附件的公告不再实时推（比如推送刚打开时的旧公告），只进每日汇总。 */
const FRESH_HOURS = 48;

export function pushStatus() {
  const webhook = credential("integrations", "DINGTALK_ROBOT_WEBHOOK");
  return {
    pushConfigured: !!webhook && WEBHOOK.test(webhook) && !!credential("integrations", "DINGTALK_ROBOT_SECRET"),
    pushEnabled: process.env.DINGTALK_PUSH_ENABLED === "true",
  };
}

class PushOutcomeUnknown extends Error {}

async function send(title: string, text: string): Promise<void> {
  const webhook = credential("integrations", "DINGTALK_ROBOT_WEBHOOK")!;
  const secret = credential("integrations", "DINGTALK_ROBOT_SECRET")!;
  const timestamp = Date.now();
  const sign = createHmac("sha256", secret).update(`${timestamp}\n${secret}`).digest("base64");
  let res: Response;
  try {
    res = await fetch(`${webhook}&timestamp=${timestamp}&sign=${encodeURIComponent(sign)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ msgtype: "markdown", markdown: { title, text } }),
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
      WHERE opp_pushes.status = 'failed' AND opp_pushes.attempts < ${MAX_ATTEMPTS}
    RETURNING key`;
  return rows.length > 0;
}

async function deliver(key: string, title: string, text: string): Promise<"sent" | "failed" | "unknown" | "skipped"> {
  if (!(await claim(key))) return "skipped";
  try {
    await send(title, text);
    await sql`UPDATE opp_pushes SET status = 'sent', sent_at = now() WHERE key = ${key}`;
    return "sent";
  } catch (error) {
    const status = error instanceof PushOutcomeUnknown ? "unknown" : "failed";
    await sql`UPDATE opp_pushes SET status = ${status}, error = ${String((error as Error).message).slice(0, 300)} WHERE key = ${key}`;
    return status;
  }
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

/** 一份公告筛完、抽完要素后推一条。没开、没配、存量公告、已经截止，或已经推过，都不发；其他平台的资料只推“相关”的。 */
export async function pushNotice(id: string, now = new Date()): Promise<string> {
  const status = pushStatus();
  if (!status.pushEnabled || !status.pushConfigured) return "disabled";
  const n = await loadNotice(id);
  if (!n || n.backfill) return "skipped";
  if (now.getTime() - n.discovered_at.getTime() > FRESH_HOURS * 3600_000) return "stale";
  if (isExpired(deadlineOf(n), now)) return "expired";
  const items = (await noticeItems(id)).filter((i) => i.verdict === "relevant" || (i.verdict === "maybe" && n.source !== "web")).sort(order);
  if (items.length === 0) return "none";
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
      ? `[查看详情 →](${config.siteUrl}/opportunities/${encodeURIComponent(id)}) ｜ [原文](${n.url})`
      : `[查看本批次全部 ${n.item_count} 个项目 →](${config.siteUrl}/opportunities/${encodeURIComponent(id)})`,
  ].filter(Boolean).join("\n\n");
  const result = await deliver(`notice:${id}`, `投标商机｜${short(items[0]!.project_name, 24)}${items.length > 1 ? `等 ${items.length} 项` : ""}`, text);
  if (result === "sent") await sql`UPDATE opp_notices SET pushed_at = now() WHERE id = ${id}`;
  return result;
}

interface DigestRow extends ItemRow { title: string; file_deadline: string; source: SourceKey; details: NoticeDetails | null }

/** 每日汇总：过去 24 小时新发现的对得上的项目，以及 3 天内截止的。两样都没有就不发。 */
export async function pushDigest(now = new Date()): Promise<string> {
  const status = pushStatus();
  if (!status.pushEnabled || !status.pushConfigured) return "disabled";
  const rows = await sql<DigestRow[]>`
    SELECT i.*, i.id::text AS id, n.title, n.file_deadline, n.source, n.details
    FROM opp_items i JOIN opp_notices n ON n.id = i.notice_id
    WHERE (i.verdict = 'relevant' OR (i.verdict = 'maybe' AND n.source <> 'web')) AND n.discovered_at > now() - interval '30 days'`;
  const due = (r: DigestRow) => deadlineAt(deadlineOf(r));
  const soon = rows.filter((r) => {
    const at = due(r);
    return at !== null && at.getTime() >= now.getTime() && at.getTime() - now.getTime() <= 72 * 3600_000;
  }).sort((a, b) => due(a)!.getTime() - due(b)!.getTime());
  const [fresh] = await sql<{ items: number; notices: number }[]>`
    SELECT count(*)::int AS items, count(DISTINCT i.notice_id)::int AS notices
    FROM opp_items i JOIN opp_notices n ON n.id = i.notice_id
    WHERE (i.verdict = 'relevant' OR (i.verdict = 'maybe' AND n.source <> 'web')) AND n.fetched_at > now() - interval '24 hours'`;
  if (soon.length === 0 && !fresh?.items) return "none";
  const text = [
    `#### 投标商机日报 ${beijingDate(now)}`,
    fresh?.items ? `过去 24 小时新发现 **${fresh.items}** 个对得上的项目（${fresh.notices} 份公告）。` : "过去 24 小时没有新发现对得上的项目。",
    soon.length ? `**3 天内截止（${soon.length} 项）：**` : "",
    ...soon.slice(0, 12).map((r, k) => `${k + 1}. ${md(short(r.project_name, 40))}${r.verdict === "maybe" ? "（待确认）" : ""} ｜ ${md(deadlineOf(r))} 截止 ｜ [详情](${config.siteUrl}/opportunities/${encodeURIComponent(r.notice_id)}#item-${r.id})`),
    soon.length > 12 ? `另有 ${soon.length - 12} 项，见[投标商机](${config.siteUrl}/opportunities)。` : "",
    `[打开投标商机 →](${config.siteUrl}/opportunities)`,
  ].filter(Boolean).join("\n\n");
  return deliver(`digest:${beijingDate(now)}`, `投标商机日报 ${beijingDate(now)}`, text);
}

/** 后台“发送测试推送”：只发一条说明文字，不占用商机消息的防重复记录。 */
export async function pushTest(): Promise<void> {
  const status = pushStatus();
  if (!status.pushConfigured) throw Object.assign(new Error("还没有配置钉钉机器人（DINGTALK_ROBOT_WEBHOOK、DINGTALK_ROBOT_SECRET）"), { statusCode: 400 });
  if (!status.pushEnabled) throw Object.assign(new Error("推送安全阀没有打开（DINGTALK_PUSH_ENABLED=true）"), { statusCode: 400 });
  await send("投标商机推送测试", `#### 投标商机推送测试\n\n钉钉群机器人已接通。发现与公司业务对得上的招标项目时会推到这里。\n\n[打开投标商机 →](${config.siteUrl}/opportunities)`);
}
