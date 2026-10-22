// 频道设置：后台改过的标题、介绍和筛选项存在 settings 的 channels.config 里（没改过的频道用 channels.ts 的默认值），
// 和行业热点的自动话题（公开读取层按标签热度算，不调用模型）。
import { sql } from "@aihot/backend/db";
import { audit } from "@aihot/backend/audit";
import { loadTrendingTags } from "@aihot/backend/publication/trending";
import { AUTO_TOPIC_LIMIT, AUTO_TOPIC_TAGS, CHANNEL_KEYS, CHANNELS, CHIP_TAGS, invalidText, type ChannelKey, type ChannelText, type ChannelView } from "../channels.ts";

const KEY = "channels.config";

export class ChannelError extends Error {
  readonly statusCode = 400;
}

async function overrides(): Promise<Partial<Record<ChannelKey, ChannelText>>> {
  const [row] = await sql<{ value: Partial<Record<ChannelKey, ChannelText>> }[]>`SELECT value FROM settings WHERE key = ${KEY}`;
  return row?.value ?? {};
}

/** 频道现在的文字和筛选项：后台改过且仍然有效的用改过的，否则用默认值（词表删掉了某个标签时退回默认）。 */
function effective(key: ChannelKey, saved: Partial<Record<ChannelKey, ChannelText>>): ChannelText {
  const text = saved[key];
  return text && !invalidText(text) ? text : CHANNELS[key].defaults;
}

export function isChannelKey(key: string): key is ChannelKey {
  return (CHANNEL_KEYS as string[]).includes(key);
}

export async function channelView(key: ChannelKey): Promise<ChannelView> {
  const text = effective(key, await overrides());
  const def = CHANNELS[key];
  const pinned = new Set(text.rows.flatMap((r) => r.chips.map((c) => c.tag)));
  // Topics already offered in a row are not offered twice.
  const topics = "autoTopics" in def && def.autoTopics
    ? (await loadTrendingTags({ categories: def.categories, tags: AUTO_TOPIC_TAGS, limit: AUTO_TOPIC_LIMIT + pinned.size }))
      .filter((t) => !pinned.has(t.tag)).slice(0, AUTO_TOPIC_LIMIT)
    : [];
  return { key, ...text, topics };
}

/** 后台页面：每个频道的默认值、现在的设置、是否改过，以及能用的标签。 */
export async function channelsAdmin() {
  const saved = await overrides();
  return {
    channels: CHANNEL_KEYS.map((key) => ({ key, path: CHANNELS[key].path, defaults: CHANNELS[key].defaults, current: effective(key, saved), customized: !!saved[key] })),
    tags: CHIP_TAGS,
  };
}

function cleanText(input: unknown): ChannelText {
  const t = (input ?? {}) as Partial<ChannelText>;
  const text: ChannelText = {
    title: String(t.title ?? "").trim(),
    lead: String(t.lead ?? "").trim(),
    rows: Array.isArray(t.rows) ? t.rows.map((r) => ({
      label: String(r?.label ?? "").trim(),
      chips: Array.isArray(r?.chips) ? r.chips.map((c) => ({
        label: String(c?.label ?? "").trim(),
        ...(c?.tag ? { tag: String(c.tag).trim() } : {}),
        ...(c?.q ? { q: String(c.q).trim() } : {}),
      })) : [],
    })) : [],
  };
  const problem = invalidText(text);
  if (problem) throw new ChannelError(problem);
  return text;
}

async function write(next: Partial<Record<ChannelKey, ChannelText>>, actor: string) {
  await sql`INSERT INTO settings (key, value, updated_by) VALUES (${KEY}, ${sql.json(next as never)}, ${actor})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`;
}

export async function saveChannel(key: ChannelKey, input: unknown, reason: string, actor: string) {
  if (!reason.trim()) throw new ChannelError("请写明修改原因");
  const text = cleanText(input);
  const saved = await overrides();
  const before = effective(key, saved);
  await write({ ...saved, [key]: text }, actor);
  await audit(actor, "channels.save", `channel:${key}`, reason, before, text);
  return { key, current: text };
}

export async function resetChannel(key: ChannelKey, reason: string, actor: string) {
  if (!reason.trim()) throw new ChannelError("请写明修改原因");
  const saved = await overrides();
  if (!saved[key]) return { key, current: CHANNELS[key].defaults };
  const { [key]: before, ...rest } = saved;
  await write(rest, actor);
  await audit(actor, "channels.reset", `channel:${key}`, reason, before, CHANNELS[key].defaults);
  return { key, current: CHANNELS[key].defaults };
}
