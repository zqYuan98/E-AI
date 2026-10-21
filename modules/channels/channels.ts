// 三个频道各收哪几类、用哪些标签筛选。分类和标签都是 industry/taxonomy.ts 里的词，改词表时一起改这里。
import { CATEGORIES, CATEGORY_TAGS, TOPIC_TAGS } from "@aihot/industry/taxonomy";

type CategoryKey = (typeof CATEGORIES)[number]["key"];
type Tag = (typeof CATEGORY_TAGS)[number] | (typeof TOPIC_TAGS)[number];

export interface Channel {
  path: string;
  title: string;
  lead: string;
  /** 收哪几类；不止一类时用标签切换，第一类是默认。 */
  categories: readonly CategoryKey[];
  /** 标签筛选，每行一组，一次只选一个标签。 */
  tagRows: ReadonlyArray<{ label: string; tags: readonly Tag[] }>;
  /** 手机底栏上有它自己的标签时，标签的 key（web.tsx）；没有的从“我的”进入。 */
  tab?: string;
  /** 标题旁的相关入口。 */
  link?: { to: string; label: string };
  searchHint: string;
}

export const CHANNELS = {
  tenders: {
    path: "/tenders",
    title: "招标商机",
    tab: "tenders",
    lead: "招标公告、中标结果、采购意向、项目前期和申报通知，收录全部相关条目，不只精选。按阶段或业务线筛选，搜地区、单位或设备名。",
    categories: ["procurement"],
    tagRows: [
      { label: "阶段", tags: ["招标/中标", "项目前期", "申报通知", "试点示范"] },
      { label: "业务线", tags: ["视频监控", "近电预警", "边缘计算", "智慧工地", "质量管控", "安全生产"] },
    ],
    searchHint: "搜地区、单位或设备，例如 云南、布控球",
  },
  "policy-news": {
    path: "/policy-news",
    title: "政策动态",
    lead: "主管部门、电网和发电企业的政策、规划、监管要求，以及标准的发布和征求意见。整份文件的目标和条款在政策文件库里看。",
    categories: ["policy"],
    tagRows: [{ label: "类型", tags: ["政策/规划", "标准规范"] }],
    link: { to: "/policy", label: "政策文件库" },
    searchHint: "搜政策名、部门或关键词",
  },
  trends: {
    path: "/trends",
    title: "行业热点",
    tab: "trends",
    lead: "电力 AI 的场景落地、大模型、算电协同、产业和研究动态。",
    categories: ["applications", "models", "compute", "industry", "research", "opinion"],
    tagRows: [],
    link: { to: "/hot", label: "热点榜" },
    searchHint: "搜标题和摘要，例如 虚拟电厂",
  },
} as const satisfies Record<string, Channel>;

export type ChannelKey = keyof typeof CHANNELS;

/** 地址对应的频道（/tenders → tenders）。 */
export function channelAt(pathname: string): ChannelKey | null {
  const key = pathname.replace(/^\/|\/$/g, "");
  return key in CHANNELS ? (key as ChannelKey) : null;
}

/** 地址里的筛选，限定在这个频道提供的范围内。 */
export interface ChannelQuery { category: string; tag: string | null; q: string | null; page: number }

export function readQuery(channel: Channel, params: URLSearchParams): ChannelQuery {
  const category = (channel.categories as readonly string[]).includes(params.get("category") ?? "") ? params.get("category")! : channel.categories[0]!;
  const tag = channel.tagRows.some((r) => (r.tags as readonly string[]).includes(params.get("tag") ?? "")) ? params.get("tag") : null;
  const q = params.get("q")?.trim().slice(0, 200) || null;
  const page = Math.min(Math.max(Number(params.get("page")) || 1, 1), 50);
  return { category, tag, q, page };
}

export const categoryLabel = (key: string) => CATEGORIES.find((c) => c.key === key)?.label ?? key;
