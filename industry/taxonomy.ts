// 这个行业的分类体系：类别、标签词表、公司（主体）名录，以及防止张冠李戴的身份词典。
// 模型按这里的词表打标签，主题页（topics.json）按标签归类，筛选栏按类别分组。
// 换行业时：类别的 key 会出现在网址里（/all?category=…），上线后就不要再改；标签和名录可以随时增减。

/**
 * 网页上的类别（筛选栏、卡片角标、RSS 分类订阅）。key 是网址和接口里的身份，上线后不要改。
 * section 是日报里的分节标题（几个类别可以共用一节，按这里的顺序排）；guide 告诉结构抽取模型这一类收什么、
 * 和相邻类别的边界在哪（总的归类原则写在 prompts/structure.md 里）。
 * commentary 标出评论类（教程、观点）：日报写过的事又有评论类的后续报道，只占一行快讯（报道它的信源够多时除外）。
 * 没归上类的资料在日报里放进第一个 key 为 industry 的类别所在的节（没有就放最后一节）。
 * tagColor 是飞书推送卡片里跟在标题后面的这一类小标签的颜色（飞书 text_tag 的颜色名）。
 * tagColor 是飞书推送卡片里跟在标题后面的这一类小标签的颜色（飞书 text_tag 的颜色名）。
 * feedLabel 是分类 RSS 标题里的名字（不写就用 label）。公开接口、RSS 和 MCP 里要把一类并进另一类发布，写在站点设置里（site/site.ts 的 PUBLIC_CATEGORIES）。
 */
export const CATEGORIES = [
  { key: "models", tagColor: "indigo", label: "大模型", feedLabel: "电力大模型", section: "大模型与平台", guide: "电力、能源行业大模型、智能体和 AI 平台本身的发布、版本升级、开放接入和能力变化，包括通用大模型厂商推出的电力专版、电网企业把通用大模型接入自家平台。只是在某个业务里用了大模型，归场景落地。" },
  { key: "applications", tagColor: "turquoise", label: "场景落地", feedLabel: "电力 AI 应用", section: "场景落地", guide: "AI 在发电、输电、变电、配电、用电、调度、营销、基建、安全管控等具体业务里投运或试运行，重点是做了什么、用在哪、有多大规模或效果。还只是招标采购的归招采申报，只是发布平台本身的归大模型。" },
  { key: "procurement", tagColor: "orange", label: "招采申报", feedLabel: "招采、前期与申报", section: "招采、前期与申报", guide: "与 AI 相关的招标公告、中标结果、采购意向，以及试点示范项目的申报、立项、评选和验收；另外收本站读者公司业务线（电力施工现场安全与质量）的商机：现场安全装备（布控球、视频监控终端、临近带电预警与防触电、边缘代理和边缘计算终端）、安全质量管控平台（作业风险管控、视频监督、智慧工地、数字化值班）相关的招标、中标、采购意向和招标计划，输变电工程的核准、可研批复、环评公示等前期信号，以及科技项目、首台套、示范工程、成果和案例征集等申报通知。项目已经投运并讲效果的归场景落地。" },
  { key: "policy", tagColor: "red", label: "政策标准", feedLabel: "政策与标准", section: "政策标准", guide: "国家和地方主管部门关于人工智能与能源、电力的政策文件、行动方案和监管要求，电网和发电企业的 AI 规划与专项行动，以及国标、行标、团标、企标的发布和征求意见。领导讲话没有新文件、新要求的，不归这里。" },
  { key: "compute", tagColor: "wathet", label: "算电协同", feedLabel: "算电协同", section: "算电协同", guide: "AI 算力与电力的关系：智算中心和数据中心的用电负荷、供电与绿电直供、算力与电力协同调度、相关电价、规划和项目。只是数据中心建设、和电力无关的，不归这里。" },
  { key: "industry", tagColor: "blue", label: "产业动态", feedLabel: "产业动态", section: "产业动态", guide: "已发生的企业经营活动：合作签约、融资并购、财报和业绩里的 AI 业务、组织与人事、产品商用和订单，以及会议上有具体发布的消息。没有具体发布的会议通稿、领导调研不算有效信息。" },
  { key: "research", tagColor: "violet", label: "研究进展", feedLabel: "研究进展", section: "研究进展", guide: "以新方法、实验和发现为核心的论文、技术报告、竞赛结果，以及开源模型、开源数据集和实验室成果。已经部署到生产业务并讲效果的归场景落地。" },
  { key: "opinion", tagColor: "purple", label: "观点解读", feedLabel: "观点解读", section: "观点解读", guide: "重点是作者的分析、判断、预测、经验复盘或访谈观点，包括政策解读和行业趋势文章。文章里报道了一项新的具体发生时，按那项发生归类。", commentary: true },
] as const satisfies ReadonlyArray<{ key: string; tagColor: string; label: string; feedLabel?: string; section: string; guide: string; commentary?: true }>;

/**
 * 这个行业最受关注的一类发布（AI 行业是新模型）：日报报头的“N 个新模型”、改分类后修订已出的报告都按它数。
 * category 是类别，tag 是标签，两者都对上才算；unit 接在数字后面。
 * 没有这样一类的行业设成 null，报头就不显示这个数。
 */
export const RELEASE: { category: string; tag: string; unit: string } | null = { category: "models", tag: "大模型发布", unit: "个大模型发布" };

/** 周报月报的总述可以直接写、不必在报道里找到出处的行业通用词（小写）。站名会自动算进去。 */
export const PLAIN_TERMS: readonly string[] = [
  "ai", "api", "gpu", "5g", "ceo", "ipo", "人工智能", "大模型", "智能体", "新型电力系统", "电网", "电力", "能源", "算力", "数字化",
];

/**
 * 内容理解一步给每篇资料判的“内容类型”（写在 prompts/content-understanding.md 里，改了类型要同步改那份提示词）。
 * 评分提示词（prompts/selection-score.md）按类型给五个维度不同的权重。
 */
export const ITEM_TYPES = [
  "model_release", "product_launch", "deployment_case", "procurement", "policy_standard", "research_paper", "industry_event", "opinion_analysis",
] as const;

// ── 标签词表 ────────────────────────────────────────────────────────────────────────────

/** 每篇资料的第一个标签必须是这些“分类标签”之一。 */
export const CATEGORY_TAGS = [
  "大模型发布", "产品/平台", "场景应用", "招标/中标", "试点示范", "政策/规划", "标准规范", "算电协同", "研究/论文", "开源/数据集",
  "行业动态", "观点/解读", "项目前期", "申报通知", "非AI/普通电力", "其他",
] as const;

/** 可选的主题标签。 */
export const TOPIC_TAGS = [
  "智能巡检", "无人机", "电力机器人", "AI视觉", "调度", "功率预测", "负荷预测", "设备运维", "输电", "变电", "配网", "新能源", "储能",
  "虚拟电厂", "电力市场", "营销客服", "安全生产", "基建施工", "数字孪生", "智能体", "知识库/RAG", "算力/数据中心", "网络与数据安全", "计量/用电",
  "视频监控", "近电预警", "边缘计算", "智慧工地", "质量管控",
] as const;

/**
 * 内容理解把第一个标签判成这些的，不进“全部动态”和精选（预筛宽召回漏过、模型自己也认定与本站主题无关的内容）；
 * 条目页照常保留，可以搜到。
 */
export const OFF_TOPIC_TAGS: readonly string[] = ["非AI/普通电力"];

/** 可选的实体标签（公司、机构、平台）。 */
export const ENTITY_TAGS = [
  "国家电网", "南方电网", "国家能源局", "国家发改委", "中电联", "国家能源集团", "华能", "大唐", "华电", "国家电投", "三峡集团", "华为", "百度", "阿里云", "DeepSeek",
] as const;

/** 模型常写的近义词，统一成词表里的写法。 */
export const TAG_SYNONYMS: Readonly<Record<string, string>> = {
  大模型: "大模型发布", 模型发布: "大模型发布", 模型: "大模型发布", 产品: "产品/平台", 平台: "产品/平台", 产品发布: "产品/平台", 产品更新: "产品/平台",
  应用: "场景应用", 案例: "场景应用", 落地: "场景应用", 应用案例: "场景应用", 招标: "招标/中标", 中标: "招标/中标", 采购: "招标/中标",
  招采: "招标/中标", 示范: "试点示范", 试点: "试点示范", 政策: "政策/规划", 规划: "政策/规划", 监管: "政策/规划", "政策/监管": "政策/规划",
  标准: "标准规范", 规范: "标准规范", 论文: "研究/论文", 研究: "研究/论文", "论文/研究": "研究/论文", 开源: "开源/数据集", 数据集: "开源/数据集",
  "开源/仓库": "开源/数据集", 合作: "行业动态", 融资: "行业动态", 收购: "行业动态", 签约: "行业动态", 公司动态: "行业动态", 企业动态: "行业动态",
  观点: "观点/解读", 解读: "观点/解读", 评论: "观点/解读", 访谈: "观点/解读", 趋势: "观点/解读", 非ai: "非AI/普通电力", "non-ai": "非AI/普通电力",
  巡检: "智能巡检", 机器人: "电力机器人", 视觉: "AI视觉", 图像识别: "AI视觉", 计算机视觉: "AI视觉", agent: "智能体", 智能代理: "智能体",
  rag: "知识库/RAG", 知识库: "知识库/RAG", 算力: "算力/数据中心", 数据中心: "算力/数据中心", 智算中心: "算力/数据中心", 网络安全: "网络与数据安全",
  数据安全: "网络与数据安全", 光伏: "新能源", 风电: "新能源", 电力现货: "电力市场", 电力交易: "电力市场", 客服: "营销客服", 营销: "营销客服",
  运维: "设备运维", 检修: "设备运维", 配电: "配网", 配电网: "配网", 输电线路: "输电", 变电站: "变电", 电网调度: "调度", 新能源功率预测: "功率预测",
};

// ── 公司与主体 ──────────────────────────────────────────────────────────────────────────

/**
 * 公司主题：id → 显示名、卡片上显示的标签（null 表示只用 entity:<id> 归类）、别名。
 * aliases 给结构抽取模型看；orgNames 是这家公司发消息时开头用的组织名（公司、实验室、团队），
 * 在它自己的主题页上读者知道说的是谁，可以省去；otherNames 是公司的其他称呼（官方账号名、子品牌）。
 * 所有这些名字都用来认出说的是哪家公司，比如把事实的主体对到发布方。
 */
export const ENTITIES: Record<string, { name: string; displayTag: string | null; aliases: string[]; orgNames?: string[]; otherNames?: string[] }> = {
  sgcc: { name: "国家电网", displayTag: "国家电网", aliases: ["国家电网", "国网", "State Grid", "光明电力大模型"], otherNames: ["国家电网有限公司", "国家电网报", "国网能源研究院", "中国电力科学研究院", "国网信通产业集团", "国网智能电网研究院"] },
  csg: { name: "南方电网", displayTag: "南方电网", aliases: ["南方电网", "南网", "China Southern Power Grid", "大瓦特"], otherNames: ["中国南方电网有限责任公司", "南方电网报", "南网数研院", "南方电网数字电网集团", "南方电网科学研究院"] },
  nea: { name: "国家能源局", displayTag: "国家能源局", aliases: ["国家能源局", "能源局", "NEA"] },
  ndrc: { name: "国家发改委", displayTag: "国家发改委", aliases: ["国家发展改革委", "国家发改委", "发改委", "NDRC"] },
  miit: { name: "工业和信息化部", displayTag: null, aliases: ["工业和信息化部", "工信部", "MIIT"] },
  cec: { name: "中电联", displayTag: "中电联", aliases: ["中国电力企业联合会", "中电联", "CEC"] },
  "chn-energy": { name: "国家能源集团", displayTag: "国家能源集团", aliases: ["国家能源集团", "国家能源投资集团", "CHN Energy"] },
  huaneng: { name: "华能", displayTag: "华能", aliases: ["中国华能", "华能集团", "华能"] },
  datang: { name: "大唐", displayTag: "大唐", aliases: ["中国大唐", "大唐集团"] },
  huadian: { name: "华电", displayTag: "华电", aliases: ["中国华电", "华电集团"] },
  spic: { name: "国家电投", displayTag: "国家电投", aliases: ["国家电投", "国家电力投资集团", "SPIC"] },
  ctg: { name: "三峡集团", displayTag: "三峡集团", aliases: ["中国三峡集团", "三峡集团", "长江电力"] },
  powerchina: { name: "中国电建", displayTag: null, aliases: ["中国电建", "中国电力建设集团", "POWERCHINA"] },
  ceec: { name: "中国能建", displayTag: null, aliases: ["中国能建", "中国能源建设集团", "CEEC"] },
  nari: { name: "国电南瑞", displayTag: null, aliases: ["国电南瑞", "南瑞集团", "南瑞", "NARI"] },
  xjgc: { name: "许继电气", displayTag: null, aliases: ["许继电气", "许继集团", "许继"] },
  longshine: { name: "朗新科技", displayTag: null, aliases: ["朗新科技", "朗新"] },
  ygsoft: { name: "远光软件", displayTag: null, aliases: ["远光软件", "远光"] },
  huawei: { name: "华为", displayTag: "华为", aliases: ["华为", "Huawei", "盘古", "华为数字能源", "华为云"] },
  baidu: { name: "百度", displayTag: "百度", aliases: ["百度", "Baidu", "文心", "百度智能云"] },
  alibaba: { name: "阿里云", displayTag: "阿里云", aliases: ["阿里云", "阿里巴巴", "通义", "千问", "Qwen"] },
  tencent: { name: "腾讯", displayTag: null, aliases: ["腾讯", "腾讯云", "混元", "Tencent"] },
  iflytek: { name: "科大讯飞", displayTag: null, aliases: ["科大讯飞", "讯飞", "星火", "iFLYTEK"] },
  deepseek: { name: "DeepSeek", displayTag: "DeepSeek", aliases: ["DeepSeek", "深度求索"] },
  nvidia: { name: "NVIDIA", displayTag: null, aliases: ["NVIDIA", "英伟达"] },
};

/**
 * 身份词典：摘要和标题里出现的公司，必须在原文里也出现过，否则退回原标题、丢掉摘要（防止模型张冠李戴）。
 * 行业没有这个问题时可以留空数组。
 */
export const IDENTITY_LEXICON: ReadonlyArray<{ id: string; name: string; patterns: RegExp[] }> = [
  { id: "sgcc", name: "国家电网", patterns: [/国家电网|国网|state\s?grid|光明电力大模型/i] },
  { id: "csg", name: "南方电网", patterns: [/南方电网|南网|southern\s?power\s?grid|大瓦特/i] },
  { id: "chn-energy", name: "国家能源集团", patterns: [/国家能源集团|国家能源投资集团|chn\s?energy/i] },
  { id: "huaneng", name: "华能", patterns: [/华能/] },
  { id: "datang", name: "大唐", patterns: [/大唐/] },
  { id: "huadian", name: "华电", patterns: [/华电/] },
  { id: "spic", name: "国家电投", patterns: [/国家电投|国家电力投资|\bspic\b/i] },
  { id: "ctg", name: "三峡集团", patterns: [/三峡集团|中国三峡|长江电力/] },
  { id: "powerchina", name: "中国电建", patterns: [/中国电建|电力建设集团|powerchina/i] },
  { id: "ceec", name: "中国能建", patterns: [/中国能建|能源建设集团|\bceec\b/i] },
  { id: "nari", name: "国电南瑞", patterns: [/南瑞|\bnari\b/i] },
  { id: "xjgc", name: "许继", patterns: [/许继/] },
  { id: "longshine", name: "朗新科技", patterns: [/朗新/] },
  { id: "ygsoft", name: "远光软件", patterns: [/远光软件/] },
  { id: "huawei", name: "华为", patterns: [/华为|huawei|盘古/i] },
  { id: "baidu", name: "百度", patterns: [/百度|baidu|文心|\bernie\b/i] },
  { id: "alibaba", name: "阿里云 / 通义", patterns: [/阿里|alibaba|通义|千问|\bqwen/i] },
  { id: "tencent", name: "腾讯", patterns: [/腾讯|tencent|混元|hunyuan/i] },
  { id: "iflytek", name: "科大讯飞", patterns: [/讯飞|iflytek|星火大模型/i] },
  { id: "deepseek", name: "DeepSeek", patterns: [/deepseek|深度求索/i] },
  { id: "zhipu", name: "智谱", patterns: [/智谱|\bglm-?[4-9]/i] },
  { id: "doubao", name: "字节豆包", patterns: [/豆包|doubao|字节跳动|bytedance|火山引擎/i] },
  { id: "sensetime", name: "商汤", patterns: [/商汤|sensetime/i] },
  { id: "nvidia", name: "NVIDIA", patterns: [/nvidia|英伟达/i] },
  { id: "openai", name: "OpenAI", patterns: [/openai|chatgpt/i] },
];

/** 这些域名上的文章，发布方就是对应的公司（托管平台如 GitHub、arXiv 不算）。 */
export const PUBLISHER_DOMAINS: ReadonlyArray<{ entityId: string; domains: readonly string[] }> = [
  { entityId: "sgcc", domains: ["sgcc.com.cn"] },
  { entityId: "csg", domains: ["csg.cn"] },
  { entityId: "nea", domains: ["nea.gov.cn"] },
  { entityId: "ndrc", domains: ["ndrc.gov.cn"] },
  { entityId: "miit", domains: ["miit.gov.cn"] },
  { entityId: "cec", domains: ["cec.org.cn"] },
  { entityId: "chn-energy", domains: ["chnenergy.com.cn", "ceic.com"] },
  { entityId: "huaneng", domains: ["chng.com.cn"] },
  { entityId: "datang", domains: ["china-cdt.com"] },
  { entityId: "huadian", domains: ["chd.com.cn"] },
  { entityId: "spic", domains: ["spic.com.cn"] },
  { entityId: "ctg", domains: ["ctg.com.cn"] },
  { entityId: "powerchina", domains: ["powerchina.cn"] },
  { entityId: "ceec", domains: ["ceec.net.cn"] },
  { entityId: "huawei", domains: ["huawei.com"] },
];

/** 原文里的这些写法也算提到了对应公司。 */
export const IDENTITY_CONTEXT_ALIASES: ReadonlyArray<{ entityId: string; pattern: RegExp }> = [
  { entityId: "sgcc", pattern: /国网\S{1,6}(?:电力|公司)/ },
  { entityId: "csg", pattern: /(?:广东|广西|云南|贵州|海南|深圳)电网/ },
];
