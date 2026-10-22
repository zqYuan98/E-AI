// 三个频道：收哪几类（代码里定），标题、介绍和筛选项（这里是默认值，管理员可以在后台“频道设置”里改）。
// 筛选项是标签或搜索词；标签必须是 industry/taxonomy.ts 词表里的词，改词表时一起看这里的默认值。
import { CATEGORIES, CATEGORY_TAGS, ENTITY_TAGS, OFF_TOPIC_TAGS, TOPIC_TAGS } from "@aihot/industry/taxonomy";

type CategoryKey = (typeof CATEGORIES)[number]["key"];

/** 一个筛选项：按标签筛，或者按搜索词搜（地区、单位这类没有标签的）。 */
export interface Chip { label: string; tag?: string; q?: string }
export interface ChipRow { label: string; chips: Chip[] }

/** 后台能改的部分。 */
export interface ChannelText { title: string; lead: string; rows: ChipRow[] }

export interface ChannelDefinition {
  path: string;
  /** 收哪几类；不止一类时页面上多一行分类，默认看全部这几类。 */
  categories: readonly CategoryKey[];
  /** 按标签热度自动给出的话题（只用主题标签）。 */
  autoTopics?: boolean;
  /** 手机底栏上有它自己的标签时，标签的 key（web.tsx）；没有的从“我的”进入。 */
  tab?: string;
  /** 标题旁的相关入口。 */
  link?: { to: string; label: string };
  searchHint: string;
  defaults: ChannelText;
}

const tags = (...names: string[]): Chip[] => names.map((tag) => ({ label: tag, tag }));

export const CHANNELS = {
  tenders: {
    path: "/tenders",
    tab: "tenders",
    categories: ["procurement"],
    searchHint: "搜地区、单位或设备，例如 云南、布控球",
    defaults: {
      title: "招标商机",
      lead: "招标公告、中标结果、采购意向、项目前期和申报通知，收录全部相关条目，不只精选。按阶段、业务线或 AI 方向筛选，搜地区、单位或设备名。",
      rows: [
        { label: "阶段", chips: tags("招标/中标", "项目前期", "申报通知", "试点示范") },
        { label: "业务线", chips: tags("视频监控", "近电预警", "边缘计算", "智慧工地", "质量管控", "安全生产") },
        { label: "AI", chips: tags("智能体", "AI视觉", "知识库/RAG") },
      ],
    },
  },
  "policy-news": {
    path: "/policy-news",
    categories: ["policy"],
    link: { to: "/policy", label: "政策文件库" },
    searchHint: "搜政策名、部门或关键词",
    defaults: {
      title: "政策动态",
      lead: "主管部门、电网和发电企业的政策、规划、监管要求，以及标准的发布和征求意见。整份文件的目标和条款在政策文件库里看。",
      rows: [{ label: "类型", chips: tags("政策/规划", "标准规范") }],
    },
  },
  trends: {
    path: "/trends",
    tab: "trends",
    categories: ["applications", "models", "compute", "industry", "research", "opinion"],
    autoTopics: true,
    link: { to: "/hot", label: "热点榜" },
    searchHint: "搜标题和摘要，例如 虚拟电厂",
    defaults: {
      title: "行业热点",
      lead: "电力 AI 的场景落地、大模型、算电协同、产业和研究动态。热门话题按最近一周的报道量自动更新。",
      rows: [{ label: "主题", chips: tags("智能体", "知识库/RAG", "数字孪生", "电力机器人", "功率预测") }],
    },
  },
} as const satisfies Record<string, ChannelDefinition>;

export type ChannelKey = keyof typeof CHANNELS;
export const CHANNEL_KEYS = Object.keys(CHANNELS) as ChannelKey[];

/** 自动话题最多几个。 */
export const AUTO_TOPIC_LIMIT = 8;

/** 筛选项可以用的标签：分类标签、主题标签和公司名（不含“非AI/普通电力”）。 */
export const CHIP_TAGS: readonly string[] = [...CATEGORY_TAGS, ...TOPIC_TAGS, ...ENTITY_TAGS].filter((t) => !OFF_TOPIC_TAGS.includes(t));
/** 自动话题只从主题标签里来。 */
export const AUTO_TOPIC_TAGS: readonly string[] = TOPIC_TAGS;

/** 页面拿到的一个频道：后台改过的文字和筛选项，以及自动话题。 */
export interface ChannelView extends ChannelText {
  key: ChannelKey;
  topics: Array<{ tag: string; recent: number; before: number }>;
}

/** 地址对应的频道（/tenders → tenders）。 */
export function channelAt(pathname: string): ChannelKey | null {
  const key = pathname.replace(/^\/|\/$/g, "");
  return key in CHANNELS ? (key as ChannelKey) : null;
}

/** 检查一份频道文字，返回中文的问题说明；没问题返回 null。 */
export function invalidText(text: ChannelText): string | null {
  if (!text.title?.trim() || text.title.trim().length > 12) return "标题要写，最多 12 个字";
  if ((text.lead ?? "").length > 200) return "介绍最多 200 个字";
  if (!Array.isArray(text.rows) || text.rows.length > 4) return "筛选最多 4 行";
  for (const row of text.rows) {
    if (!row.label?.trim() || row.label.trim().length > 8) return "每行要有名称，最多 8 个字";
    if (!row.chips?.length || row.chips.length > 12) return `“${row.label}”一行要有 1–12 个筛选项`;
    for (const chip of row.chips) {
      if (!chip.label?.trim() || chip.label.trim().length > 12) return `“${row.label}”里的筛选项要有名称，最多 12 个字`;
      if (!!chip.tag === !!chip.q) return `“${chip.label}”要么按标签筛，要么按搜索词搜，只能选一种`;
      if (chip.tag && !CHIP_TAGS.includes(chip.tag)) return `“${chip.tag}”不是词表里的标签`;
      if (chip.q && (chip.q.trim().length === 0 || chip.q.length > 40)) return `“${chip.label}”的搜索词要写，最多 40 个字`;
    }
  }
  return null;
}

/** 地址里的筛选，限定在这个频道提供的范围内。category 为空表示频道收的全部几类。 */
export interface ChannelQuery { category: string | null; tag: string | null; q: string | null; page: number }

export function readQuery(key: ChannelKey, view: ChannelView, params: URLSearchParams): ChannelQuery {
  const def: ChannelDefinition = CHANNELS[key];
  const asked = params.get("category") ?? "";
  const category = (def.categories as readonly string[]).includes(asked) ? asked : def.categories.length > 1 ? null : def.categories[0]!;
  const offered = new Set([...view.rows.flatMap((r) => r.chips.map((c) => c.tag)), ...view.topics.map((t) => t.tag)]);
  const tag = offered.has(params.get("tag") ?? "") ? params.get("tag") : null;
  const q = params.get("q")?.trim().slice(0, 200) || null;
  const page = Math.min(Math.max(Number(params.get("page")) || 1, 1), 50);
  return { category, tag, q, page };
}

export const categoryLabel = (key: string) => CATEGORIES.find((c) => c.key === key)?.label ?? key;
