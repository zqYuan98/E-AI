// 业务口径：公司做哪些方向（每个方向一组关键词）、哪些采购一律不看（排除词）。存在 settings 的 opportunities.profile，
// 后台“项目商机”里改；没改过用这里的默认值。关键词只做粗筛和模型不可用时的兜底，最终相关与否由模型按方向说明判断。
import { audit } from "@aihot/backend/audit";
import { sql } from "@aihot/backend/db";
import type { BusinessLine, BusinessProfile } from "../types.ts";

const KEY = "opportunities.profile";

// 默认口径对着一家做电力人工智能、数字化的公司：通用 IT 运维（桌面终端、机房值守、硬件维保）不算，
// 在真实批次里它们占了关键词命中的大半；需要时在后台加回来。
export const DEFAULT_PROFILE: BusinessProfile = {
  lines: [
    { name: "人工智能与大模型", keywords: ["人工智能", "AI", "大模型", "智能体", "算法", "机器学习", "深度学习", "知识图谱", "自然语言", "语音识别", "图像识别", "视觉识别", "智能识别", "算力", "智能问答", "智能客服", "辅助决策"] },
    { name: "数字化与信息系统", keywords: ["信息化", "数字化", "软件", "系统开发", "系统建设", "平台建设", "平台开发", "应用开发", "信息系统", "管理系统", "数据中台", "数据治理", "大数据", "数据分析", "数字孪生", "可视化", "云平台", "网络安全", "信息安全", "小程序"] },
    { name: "智能运检与监测", keywords: ["智能巡检", "巡检机器人", "机器人", "无人机巡检", "视频监控", "视频分析", "缺陷识别", "隐患识别", "智能运维", "智能运检", "物联网", "智能感知", "边缘计算"] },
    { name: "电网智能应用", keywords: ["负荷预测", "功率预测", "电力交易", "虚拟电厂", "源网荷储", "需求响应", "配网自动化", "用电信息采集", "能源管理", "智慧能源", "碳排放", "调度自动化"] },
  ],
  exclude: ["绿化", "保洁", "物业", "餐饮", "食堂", "会务", "车辆租赁", "车辆维修", "劳务分包", "装修", "办公家具", "被服", "劳保用品", "印刷", "保险", "法律服务", "审计服务", "住宿"],
};

const clean = (s: unknown) => (typeof s === "string" ? s.replace(/[\u0000-\u001f\u007f]/g, "").trim() : "");

/** 后台提交的口径：方向名 1–20 字、每个方向 1–60 个词，排除词最多 100 个；重复的去掉。 */
export function validateProfile(input: unknown): BusinessProfile {
  const bad = (message: string) => Object.assign(new Error(message), { statusCode: 400 });
  const raw = (input ?? {}) as { lines?: unknown; exclude?: unknown };
  if (!Array.isArray(raw.lines) || raw.lines.length === 0 || raw.lines.length > 20) throw bad("业务方向要有 1–20 个");
  const names = new Set<string>();
  const lines: BusinessLine[] = raw.lines.map((l) => {
    const line = (l ?? {}) as { name?: unknown; keywords?: unknown };
    const name = clean(line.name);
    if (!name || name.length > 20) throw bad("方向名要有 1–20 个字");
    if (names.has(name)) throw bad(`方向“${name}”重复了`);
    names.add(name);
    const keywords = [...new Set((Array.isArray(line.keywords) ? line.keywords : []).map(clean).filter((k) => k.length >= 1 && k.length <= 20))];
    if (keywords.length === 0 || keywords.length > 60) throw bad(`方向“${name}”要有 1–60 个关键词`);
    return { name, keywords };
  });
  const exclude = [...new Set((Array.isArray(raw.exclude) ? raw.exclude : []).map(clean).filter((k) => k.length >= 1 && k.length <= 20))];
  if (exclude.length > 100) throw bad("排除词最多 100 个");
  return { lines, exclude };
}

export async function loadProfile(): Promise<BusinessProfile> {
  const [row] = await sql<{ value: unknown }[]>`SELECT value FROM settings WHERE key = ${KEY}`;
  if (!row) return DEFAULT_PROFILE;
  try {
    return validateProfile(row.value);
  } catch {
    return DEFAULT_PROFILE;
  }
}

export async function saveProfile(input: unknown, reason: string, actor: string): Promise<BusinessProfile> {
  const next = validateProfile(input);
  const before = await loadProfile();
  await sql`INSERT INTO settings (key, value, updated_by) VALUES (${KEY}, ${sql.json(next as never)}, ${actor})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`;
  await audit(actor, "opportunities.profile", "opportunities:profile", reason || null, before, next);
  return next;
}

const norm = (s: string) => s.normalize("NFKC").replace(/\s+/g, "").toLowerCase();

/** 词出现在文字里。纯英文的词（AI）要求前后不是英文字母或数字，免得在别的单词里误中。 */
function contains(text: string, word: string): boolean {
  const w = norm(word);
  if (!w) return false;
  if (!/^[a-z0-9]+$/.test(w)) return text.includes(w);
  return new RegExp(`(^|[^a-z0-9])${w}($|[^a-z0-9])`).test(text);
}

export interface KeywordMatch {
  /** 命中排除词：直接判无关，不交给模型。 */
  excludedBy: string | null;
  /** 命中的方向和词，按方向顺序（项目名、包名和采购内容）。 */
  lines: Array<{ name: string; words: string[] }>;
  /** 只在项目名和包名里命中的方向：模型用不上时，只有这些算待确认。 */
  nameLines: Array<{ name: string; words: string[] }>;
}

/** 排除词只看项目名和包名（采购内容里顺带提到的不算）；方向关键词看项目名、包名和采购内容。 */
export function matchKeywords(profile: BusinessProfile, item: { project_name: string; package_name: string; scope: string }): KeywordMatch {
  const name = norm(`${item.project_name}\n${item.package_name}`);
  const all = norm(`${item.project_name}\n${item.package_name}\n${item.scope}`);
  const excludedBy = profile.exclude.find((w) => contains(name, w)) ?? null;
  const hits = (text: string) => profile.lines
    .map((l) => ({ name: l.name, words: l.keywords.filter((k) => contains(text, k)) }))
    .filter((l) => l.words.length > 0);
  return { excludedBy, lines: hits(all), nameLines: hits(name) };
}
