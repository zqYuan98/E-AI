// 推到钉钉群（自定义机器人，加签）：一份公告里有对得上的项目就推一条，每天早上再推一次汇总。
// 安全阀 DINGTALK_PUSH_ENABLED 只有设成 true 才发；地址和加签密钥在 .env 的 DINGTALK_ROBOT_WEBHOOK / DINGTALK_ROBOT_SECRET。
// 每条消息在 opp_pushes 里占一行防重复：明确失败的最多再试两次，结果不明（超时、断网）的不自动重发。
import { createHmac } from "node:crypto";
import { config, credential } from "@aihot/backend/config";
import { sql } from "@aihot/backend/db";
import { beijingDate } from "@aihot/contracts/time";
import { SOURCE_NAMES, type SourceKey } from "../types.ts";
import { deadlineAt, isExpired, loadNotice, noticeItems, packageLabel, type ItemRow } from "./store.ts";

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

function itemBlock(n: number, i: ItemRow): string {
  const facts = [packageLabel(i), formatCeiling(i.ceiling, i.ceiling_kind) && `限价 ${formatCeiling(i.ceiling, i.ceiling_kind)}`, i.location]
    .filter((s) => s && shown(s)).map(md).join(" ｜ ");
  const lines = [
    `**${n}. ${md(i.project_name)}**${i.verdict === "maybe" ? "（待确认）" : ""}`,
    facts,
    i.line || i.reason ? `${md(i.line)}${i.line && i.reason ? "：" : ""}${md(short(i.reason, 60))}` : "",
    shown(i.performance) ? `业绩要求：${md(short(i.performance, 70))}` : "",
    shown(i.qualifications) ? `资质要求：${md(short(i.qualifications, 70))}` : "",
  ];
  return lines.filter(Boolean).join("\n\n");
}

const order = (a: ItemRow, b: ItemRow) => (a.verdict === b.verdict ? a.ordinal - b.ordinal : a.verdict === "relevant" ? -1 : 1);

/** 一份公告筛完后推一条。没开、没配、存量公告、全都截止了，或已经推过，都不发。 */
export async function pushNotice(id: string, now = new Date()): Promise<string> {
  const status = pushStatus();
  if (!status.pushEnabled || !status.pushConfigured) return "disabled";
  const n = await loadNotice(id);
  if (!n || n.backfill) return "skipped";
  if (now.getTime() - n.discovered_at.getTime() > FRESH_HOURS * 3600_000) return "stale";
  if (isExpired(n.file_deadline, now)) return "expired";
  const items = (await noticeItems(id)).filter((i) => i.verdict === "relevant" || i.verdict === "maybe").sort(order);
  if (items.length === 0) return "none";
  const relevant = items.filter((i) => i.verdict === "relevant").length;
  const headline = relevant > 0 ? `${relevant} 个相关项目${items.length > relevant ? `，${items.length - relevant} 个待确认` : ""}` : `${items.length} 个待确认项目`;
  const text = [
    `#### 国网新商机：${headline}`,
    `**${md(n.title)}**`,
    [SOURCE_NAMES[n.source], n.buyer && `采购人：${md(n.buyer)}`, n.batch && `批次 ${md(n.batch)}`].filter(Boolean).join(" ｜ "),
    [n.file_deadline && `采购文件获取截止：**${md(n.file_deadline)}**`, n.opening_time && `开标：${md(n.opening_time)}`].filter(Boolean).join(" ｜ "),
    "---",
    ...items.slice(0, MAX_ITEMS).map((i, k) => itemBlock(k + 1, i)),
    items.length > MAX_ITEMS ? `另有 ${items.length - MAX_ITEMS} 个对得上的项目，点下面查看。` : "",
    `[查看本批次全部 ${n.item_count} 个项目 →](${config.siteUrl}/opportunities/${encodeURIComponent(id)})`,
  ].filter(Boolean).join("\n\n");
  const result = await deliver(`notice:${id}`, `国网商机｜${short(items[0]!.project_name, 24)}${items.length > 1 ? `等 ${items.length} 项` : ""}`, text);
  if (result === "sent") await sql`UPDATE opp_notices SET pushed_at = now() WHERE id = ${id}`;
  return result;
}

interface DigestRow extends ItemRow { title: string; file_deadline: string; source: SourceKey }

/** 每日汇总：过去 24 小时新发现的对得上的项目，以及 3 天内采购文件获取截止的。两样都没有就不发。 */
export async function pushDigest(now = new Date()): Promise<string> {
  const status = pushStatus();
  if (!status.pushEnabled || !status.pushConfigured) return "disabled";
  const rows = await sql<DigestRow[]>`
    SELECT i.*, i.id::text AS id, n.title, n.file_deadline, n.source, n.discovered_at AS notice_discovered
    FROM opp_items i JOIN opp_notices n ON n.id = i.notice_id
    WHERE i.verdict IN ('relevant', 'maybe') AND n.file_deadline <> '' AND n.discovered_at > now() - interval '30 days'`;
  const soon = rows.filter((r) => {
    const at = deadlineAt(r.file_deadline);
    return at !== null && at.getTime() >= now.getTime() && at.getTime() - now.getTime() <= 72 * 3600_000;
  }).sort((a, b) => deadlineAt(a.file_deadline)!.getTime() - deadlineAt(b.file_deadline)!.getTime());
  const [fresh] = await sql<{ items: number; notices: number }[]>`
    SELECT count(*)::int AS items, count(DISTINCT i.notice_id)::int AS notices
    FROM opp_items i JOIN opp_notices n ON n.id = i.notice_id
    WHERE i.verdict IN ('relevant', 'maybe') AND n.fetched_at > now() - interval '24 hours'`;
  if (soon.length === 0 && !fresh?.items) return "none";
  const text = [
    `#### 国网商机日报 ${beijingDate(now)}`,
    fresh?.items ? `过去 24 小时新发现 **${fresh.items}** 个对得上的项目（${fresh.notices} 个批次）。` : "过去 24 小时没有新发现对得上的项目。",
    soon.length ? `**3 天内采购文件获取截止（${soon.length} 项）：**` : "",
    ...soon.slice(0, 12).map((r, k) => `${k + 1}. ${md(short(r.project_name, 40))}${r.verdict === "maybe" ? "（待确认）" : ""} ｜ ${md(r.file_deadline)} 截止 ｜ [详情](${config.siteUrl}/opportunities/${encodeURIComponent(r.notice_id)}#item-${r.id})`),
    soon.length > 12 ? `另有 ${soon.length - 12} 项，见[项目商机](${config.siteUrl}/opportunities)。` : "",
    `[打开项目商机 →](${config.siteUrl}/opportunities)`,
  ].filter(Boolean).join("\n\n");
  return deliver(`digest:${beijingDate(now)}`, `国网商机日报 ${beijingDate(now)}`, text);
}

/** 后台“发送测试推送”：只发一条说明文字，不占用商机消息的防重复记录。 */
export async function pushTest(): Promise<void> {
  const status = pushStatus();
  if (!status.pushConfigured) throw Object.assign(new Error("还没有配置钉钉机器人（DINGTALK_ROBOT_WEBHOOK、DINGTALK_ROBOT_SECRET）"), { statusCode: 400 });
  if (!status.pushEnabled) throw Object.assign(new Error("推送安全阀没有打开（DINGTALK_PUSH_ENABLED=true）"), { statusCode: 400 });
  await send("项目商机推送测试", `#### 项目商机推送测试\n\n钉钉群机器人已接通。发现与公司业务对得上的国网项目时会推到这里。\n\n[打开项目商机 →](${config.siteUrl}/opportunities)`);
}
