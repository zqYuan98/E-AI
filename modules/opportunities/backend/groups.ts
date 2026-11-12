// 推送群：每个钉钉群一个自定义机器人（安全设置选“加签”），后台“投标商机”里添加、修改、停用。每个群自己选推哪些业务方向和来源、
// 要不要待确认、实时推送和每日汇总要不要，以及提醒人：消息里有他关注方向的项目时按手机号 @ 他。
// Webhook 和加签密钥只在后端，后台页面只看得到 Webhook 末尾几位；审计里也不记它们。
import { audit } from "@aihot/backend/audit";
import { sql } from "@aihot/backend/db";
import type { PushGroup, PushGroupInput, PushMention, SourceKey } from "../types.ts";

export const WEBHOOK = /^https:\/\/oapi\.dingtalk\.com\/robot\/send\?access_token=[A-Za-z0-9]{20,128}$/;
const SOURCES: SourceKey[] = ["ecp", "etp", "web"];
const MAX_GROUPS = 20;
const MAX_MENTIONS = 50;

export interface GroupRow {
  id: number; name: string; webhook: string; secret: string; enabled: boolean; lines: string[]; sources: SourceKey[];
  include_maybe: boolean; realtime: boolean; digest: boolean; mentions: PushMention[]; enabled_at: Date;
}

const bad = (message: string) => Object.assign(new Error(message), { statusCode: 400 });
const clean = (s: unknown) => (typeof s === "string" ? s.replace(/[\u0000-\u001f\u007f]/g, "").trim() : "");
const names = (v: unknown) => [...new Set((Array.isArray(v) ? v : []).map(clean).filter((s) => s.length >= 1 && s.length <= 20))].slice(0, 20);

/** 后台提交的推送群。修改时 Webhook、密钥留空就沿用原来的。 */
export function validateGroup(input: unknown, current: GroupRow | null): Omit<GroupRow, "id" | "enabled_at"> {
  const raw = (input ?? {}) as Record<string, unknown>;
  const name = clean(raw.name);
  if (!name || name.length > 30) throw bad("群名要有 1–30 个字");
  const webhook = clean(raw.webhook) || current?.webhook || "";
  if (!WEBHOOK.test(webhook)) throw bad("Webhook 要是钉钉机器人的地址：https://oapi.dingtalk.com/robot/send?access_token=…");
  const secret = clean(raw.secret) || current?.secret || "";
  if (!secret || secret.length > 128) throw bad("要填机器人的加签密钥（安全设置选“加签”时给出的 SEC 开头那串）");
  const sources = names(raw.sources).filter((s): s is SourceKey => (SOURCES as string[]).includes(s));
  const mobiles = new Set<string>();
  const mentions = (Array.isArray(raw.mentions) ? raw.mentions : []).map((m): PushMention => {
    const r = (m ?? {}) as Record<string, unknown>;
    const who = clean(r.name);
    const mobile = clean(r.mobile);
    if (!who || who.length > 20) throw bad("提醒人的姓名要有 1–20 个字");
    if (!/^1\d{10}$/.test(mobile)) throw bad(`“${who}”的手机号要是 11 位`);
    if (mobiles.has(mobile)) throw bad(`手机号 ${mobile} 重复了`);
    mobiles.add(mobile);
    return { name: who, mobile, lines: names(r.lines) };
  });
  if (mentions.length > MAX_MENTIONS) throw bad(`一个群最多 ${MAX_MENTIONS} 个提醒人`);
  return {
    name, webhook, secret, enabled: raw.enabled !== false, lines: names(raw.lines), sources,
    include_maybe: raw.includeMaybe !== false, realtime: raw.realtime !== false, digest: raw.digest !== false, mentions,
  };
}

/** 后台看到的样子，审计也记这个：不带 Webhook 全文和密钥。 */
function view(g: GroupRow): Omit<PushGroup, "sent" | "lastSentAt" | "problems" | "lastError"> {
  return {
    id: g.id, name: g.name, webhookHint: `…${g.webhook.slice(-6)}`, enabled: g.enabled, lines: g.lines, sources: g.sources,
    includeMaybe: g.include_maybe, realtime: g.realtime, digest: g.digest, mentions: g.mentions, enabledAt: g.enabled_at.toISOString(),
  };
}

/** 推送用：打开的群。 */
export async function activeGroups(): Promise<GroupRow[]> {
  return sql<GroupRow[]>`SELECT * FROM opp_push_groups WHERE enabled ORDER BY id`;
}

export async function loadGroup(id: number): Promise<GroupRow> {
  const [g] = Number.isInteger(id) ? await sql<GroupRow[]>`SELECT * FROM opp_push_groups WHERE id = ${id}` : [];
  if (!g) throw bad("这个推送群不存在，请刷新页面");
  return g;
}

/** 后台列表：每个群推过多少条、最近一次，以及最近 7 天的失败。 */
export async function listGroups(): Promise<PushGroup[]> {
  const rows = await sql<(GroupRow & { sent: number; last_sent_at: Date | null; problems: number; last_error: string | null })[]>`
    SELECT g.*,
      (SELECT count(*) FROM opp_pushes p WHERE p.key LIKE 'g' || g.id || ':%' AND p.status = 'sent')::int AS sent,
      (SELECT max(sent_at) FROM opp_pushes p WHERE p.key LIKE 'g' || g.id || ':%') AS last_sent_at,
      (SELECT count(*) FROM opp_pushes p WHERE p.key LIKE 'g' || g.id || ':%' AND p.status IN ('failed', 'unknown')
        AND p.created_at > now() - interval '7 days')::int AS problems,
      (SELECT error FROM opp_pushes p WHERE p.key LIKE 'g' || g.id || ':%' AND p.status IN ('failed', 'unknown')
        ORDER BY created_at DESC LIMIT 1) AS last_error
    FROM opp_push_groups g ORDER BY g.id`;
  return rows.map((g) => ({ ...view(g), sent: g.sent, lastSentAt: g.last_sent_at?.toISOString() ?? null, problems: g.problems, lastError: g.last_error ?? "" }));
}

export async function createGroup(input: unknown, reason: string, actor: string): Promise<void> {
  const g = validateGroup(input, null);
  const [{ n }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM opp_push_groups`;
  if (n >= MAX_GROUPS) throw bad(`最多 ${MAX_GROUPS} 个推送群`);
  const [row] = await sql<GroupRow[]>`
    INSERT INTO opp_push_groups (name, webhook, secret, enabled, lines, sources, include_maybe, realtime, digest, mentions)
    VALUES (${g.name}, ${g.webhook}, ${g.secret}, ${g.enabled}, ${sql.json(g.lines)}, ${sql.json(g.sources)}, ${g.include_maybe},
      ${g.realtime}, ${g.digest}, ${sql.json(g.mentions as never)})
    RETURNING *`;
  await audit(actor, "opportunities.push_group.create", `opportunities:push_group:${row!.id}`, reason || null, null, view(row!));
}

/** 从停用改回启用时 enabled_at 记成现在：停用期间发现的公告不补发。 */
export async function updateGroup(id: number, input: unknown, reason: string, actor: string): Promise<void> {
  const before = await loadGroup(id);
  const g = validateGroup(input, before);
  const [row] = await sql<GroupRow[]>`
    UPDATE opp_push_groups SET name = ${g.name}, webhook = ${g.webhook}, secret = ${g.secret}, enabled = ${g.enabled},
      lines = ${sql.json(g.lines)}, sources = ${sql.json(g.sources)}, include_maybe = ${g.include_maybe}, realtime = ${g.realtime},
      digest = ${g.digest}, mentions = ${sql.json(g.mentions as never)},
      enabled_at = CASE WHEN ${g.enabled} AND NOT enabled THEN now() ELSE enabled_at END, updated_at = now()
    WHERE id = ${id} RETURNING *`;
  await audit(actor, "opportunities.push_group.update", `opportunities:push_group:${id}`, reason || null, view(before), view(row!));
}

/** 删掉群和它的推送记录。 */
export async function deleteGroup(id: number, reason: string, actor: string): Promise<void> {
  const before = await loadGroup(id);
  await sql.begin(async (tx) => {
    await tx`DELETE FROM opp_pushes WHERE key LIKE ${`g${id}:%`}`;
    await tx`DELETE FROM opp_push_groups WHERE id = ${id}`;
  });
  await audit(actor, "opportunities.push_group.delete", `opportunities:push_group:${id}`, reason || null, view(before), null);
}
