// 投标商机的数据约定：后端接口给页面的形状，以及采集服务（fetcher/）返回的形状。
// 页面只读这里的类型；字段的值都是来源原文（时间、金额照抄），没有的就是空串，不推测。

export type Verdict = "relevant" | "maybe" | "irrelevant" | "pending";
export type CeilingKind = "amount_wan" | "amount_yuan" | "percent" | "unknown";
/** 国网的两个平台由采集服务取附件；web 是其他招采平台（信源里打了“招标”“招标计划”标签的），一条资料一个项目。 */
export type SourceKey = "ecp" | "etp" | "web";

export const SOURCE_NAMES: Record<SourceKey, string> = { ecp: "国网电子商务平台", etp: "国网电工交易专区", web: "其他招采平台" };
export const VERDICT_LABELS: Record<Verdict, string> = { relevant: "相关", maybe: "待确认", irrelevant: "无关", pending: "待筛选" };

export type RequirementKind = "qualification" | "performance" | "personnel" | "authorization" | "financial" | "credit" | "other";

/**
 * 模型从公告正文抽出的要素，每项的原话都在正文里核对过（核对不上的已去掉）。
 * 项目自己的表格没写资质、业绩、限价时，页面和推送用这些补上，标“公告通用要求”。没写的是空串。
 */
export interface NoticeDetails {
  projectName: string;
  buyer: string;
  /** “120 万元”。 */
  budget: string;
  agency: string;
  region: string;
  /** “接受联合体”“不接受联合体”或空。 */
  consortium: string;
  /** 公告原样的当地时间（YYYY-MM-DD HH:mm）。 */
  times: { docObtainEnd: string; signupDeadline: string; bidDeadline: string; opening: string };
  lots: Array<{ no: string; name: string; scope: string; budget: string }>;
  requirements: Array<{ kind: RequirementKind; text: string; quote: string; lots: string[] }>;
  /** 公告写了资格或技术要求“详见招标文件”，而那部分不在公开的正文里。 */
  detailsInDocuments: boolean;
}

/** 列表上的一条：一个具体项目（需求行），带它所属的批次和包。 */
export interface OpportunityCard {
  id: string;
  noticeId: string;
  source: SourceKey;
  /** 国网两个平台的名称，或其他招采平台的信源名。 */
  sourceName: string;
  noticeTitle: string;
  batch: string;
  projectName: string;
  /** “分标 xxx · 包3 · 子包 9-1”，没有的部分不写。 */
  packageLabel: string;
  packageName: string;
  buyer: string;
  location: string;
  /** 采购内容的前 160 字。 */
  scopeExcerpt: string;
  /** 原表的限价值，配合 ceilingKind 显示单位。 */
  ceiling: string;
  ceilingKind: CeilingKind;
  verdict: Verdict;
  /** 命中的业务方向（后台业务口径里的行名）。 */
  line: string;
  reason: string;
  /** 采购文件获取截止、开标（开启应答文件）时间，来源原文；来源没写的用公告正文里抽出的。 */
  fileDeadline: string;
  openingTime: string;
  /** 投标（响应）文件递交截止，从公告正文抽出。 */
  bidDeadline: string;
  /** 公告的预算（“120 万元”），项目自己没写限价时参考。 */
  noticeBudget: string;
  /** 获取截止（没有时看投标截止）已过，按北京时间比较。 */
  expired: boolean;
  discoveredAt: string;
  noticeUrl: string;
}

export interface OpportunityItem extends OpportunityCard {
  scope: string;
  qualifications: string;
  personnel: string;
  performance: string;
  budget: string;
  pricing: string;
  /** 原文位置：附件文件、工作表、行号。 */
  evidence: Array<{ file: string; sheet: string; row: number }>;
}

export interface OpportunityListResponse {
  items: OpportunityCard[];
  total: number;
  page: number;
  pages: number;
  /** 业务口径里的方向，给筛选用。 */
  lines: string[];
}

export interface OpportunityNotice {
  id: string;
  source: SourceKey;
  sourceName: string;
  title: string;
  batch: string;
  buyer: string;
  published: string;
  fileDeadline: string;
  openingTime: string;
  url: string;
  /** pending 待取附件 · parsed 已解析 · partial 部分解析 · no_file 没有公开附件 · failed 取附件失败 · blocked 需要人工 */
  status: string;
  /** 从公告正文抽出的要素；还没抽或公告没有正文时为 null。 */
  details: NoticeDetails | null;
  warnings: string[];
  itemCount: number;
  packageCount: number;
  discoveredAt: string;
}

export interface OpportunityNoticeDetail {
  notice: OpportunityNotice;
  /** 相关和待确认的项目，完整字段。 */
  items: OpportunityItem[];
  /** 本批次其余项目（无关或待筛选），只给名称和包。 */
  others: Array<{ id: string; projectName: string; packageLabel: string; verdict: Verdict }>;
}

export interface BusinessLine { name: string; keywords: string[] }
export interface BusinessProfile { lines: BusinessLine[]; exclude: string[] }

/** 提醒人：消息里有他关注方向的项目时 @ 他（钉钉按手机号认人，他要在这个群里）。lines 为空表示所有方向。 */
export interface PushMention { name: string; mobile: string; lines: string[] }

/** 后台提交的推送群。修改时 webhook、secret 留空表示不改。 */
export interface PushGroupInput {
  name: string;
  webhook: string;
  secret: string;
  enabled: boolean;
  /** 只推这些业务方向的项目；空表示全部方向。 */
  lines: string[];
  /** 只推这些来源；空表示全部来源。 */
  sources: SourceKey[];
  /** 推不推待确认的项目（其他招采平台的待确认一律不实时推）。 */
  includeMaybe: boolean;
  realtime: boolean;
  digest: boolean;
  mentions: PushMention[];
}

/** 后台看到的推送群：Webhook 只给末尾几位，密钥不给。 */
export interface PushGroup extends Omit<PushGroupInput, "webhook" | "secret"> {
  id: number;
  webhookHint: string;
  enabledAt: string;
  sent: number;
  lastSentAt: string | null;
  /** 最近 7 天失败或结果不明的消息数，和最后一次的原因。 */
  problems: number;
  lastError: string;
}

export interface OpportunityAdmin {
  profile: BusinessProfile;
  defaults: BusinessProfile;
  status: {
    fetcherConfigured: boolean;
    pushEnabled: boolean;
    collectOn: boolean;
    modelOn: boolean;
  };
  groups: PushGroup[];
  notices: Array<{
    id: string; source: SourceKey; title: string; status: string; error: string; url: string;
    itemCount: number; relevant: number; maybe: number; discoveredAt: string; backfill: boolean;
    /** 推送处理完的时间（每个群推过了，或者没有群要这条）。 */
    pushedAt: string | null;
    /** 推到了哪些群。 */
    pushedGroups: string[];
  }>;
  counts: { pending: number; failed: number; relevant: number; maybe: number };
}

/** 采集服务 POST /discover 返回的一条公告。 */
export interface FetcherNotice {
  source: "ecp" | "etp";
  external_id: string;
  url: string;
  title: string;
  category: "procurement" | "tender" | "";
  buyer: string;
  batch: string;
  published: string;
  metadata: Record<string, string>;
}

/** 采集服务 POST /fetch 返回的一个需求行。 */
export interface FetcherItem {
  batch: string; section: string; section_name: string; package: string; subpackage: string; package_name: string;
  project_name: string; buyer: string; location: string; scope: string; qualifications: string; personnel: string;
  performance: string; ceiling: string; ceiling_kind: string; budget: string; pricing: string;
  warnings: string[];
  evidence: Array<{ file: string; sheet: string; row: number }>;
}

export interface FetcherResult {
  notice: FetcherNotice;
  sha256: string;
  complete: boolean;
  warnings: string[];
  items: FetcherItem[];
  /** Word 公告的正文（最多 3 万字）：抽通用要求和时间；附件里没有需求表时也按它判断。 */
  text?: string;
}
