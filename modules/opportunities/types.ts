// 投标商机的数据约定：后端接口给页面的形状，以及采集服务（fetcher/）返回的形状。
// 页面只读这里的类型；字段的值都是来源原文（时间、金额照抄），没有的就是空串，不推测。

export type Verdict = "relevant" | "maybe" | "irrelevant" | "pending";
export type CeilingKind = "amount_wan" | "amount_yuan" | "percent" | "unknown";
/** 国网的两个平台由采集服务取附件；web 是其他招采平台（信源里打了“招标”“招标计划”标签的），一条资料一个项目。 */
export type SourceKey = "ecp" | "etp" | "web";

export const SOURCE_NAMES: Record<SourceKey, string> = { ecp: "国网电子商务平台", etp: "国网电工交易专区", web: "其他招采平台" };

/**
 * 来源筛选和推送群按“平台”分：国网两个平台的 key 是 ecp、etp；其他招采平台按信源名“平台·栏目”里的平台分，
 * key 就是平台名（南方电网供应链、三峡集团电子采购平台、中国电建阳光采购网……）。
 */
export interface PlatformOption { key: string; label: string }
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

/** 商务初审看的三类要求。 */
export type RequirementGroup = "qualification" | "performance" | "personnel";
export const REQUIREMENT_GROUP_LABELS: Record<RequirementGroup, string> = { qualification: "资质", performance: "业绩", personnel: "人员" };
export type MatchStatus = "met" | "unmet" | "unknown";
export const MATCH_STATUS_LABELS: Record<MatchStatus, string> = { met: "满足", unmet: "不满足", unknown: "需核实" };

/**
 * 项目的一条资质 / 业绩 / 人员要求：项目自己表格里写的（from = item），或公告正文里适用于它所在包的（from = notice）。
 * status、note 是和后台“我司资质”逐条对比的结果，还没比（或没填我司资质）时为 null 和空串。
 */
export interface ItemRequirement {
  group: RequirementGroup;
  text: string;
  from: "item" | "notice";
  status: MatchStatus | null;
  note: string;
}

/** 匹配度：有不满足的为低，有需核实的为中，都满足为高。 */
export type MatchLevel = "high" | "medium" | "low";
export const MATCH_LEVEL_LABELS: Record<MatchLevel, string> = { high: "高", medium: "中", low: "低" };
export interface EntityMatch { company: string; met: number; unmet: number; unknown: number }
/**
 * 按投标主体（集团下各公司）分别比对：company 是最合适的主体（不满足最少、满足最多），等级和条数是它的；
 * entities 是所有主体，按同样的顺序排。一个主体的要求只看它自己的资质、人员和业绩，不跨公司拼。
 */
export interface MatchSummary extends EntityMatch { level: MatchLevel; entities: EntityMatch[] }

/** “安徽博创信息科技有限公司” → “博创”：去掉开头的地名和结尾的“信息科技有限公司”这类，页面和推送上显示。 */
export function shortCompany(name: string): string {
  const s = name.replace(PLACE, "").replace(/(信息科技|信息技术|视讯科技|科技|技术|信息)?(股份)?(有限(责任)?)?公司$/, "");
  return s || name;
}
// 开头的地名：省份（带不带“省”）、省会和几个常见城市，或任意“××市”。
const PLACE = new RegExp(`^(${[
  "北京", "天津", "上海", "重庆", "河北", "山西", "辽宁", "吉林", "黑龙江", "江苏", "浙江", "安徽", "福建", "江西", "山东", "河南", "湖北", "湖南",
  "广东", "海南", "四川", "贵州", "云南", "陕西", "甘肃", "青海", "台湾", "内蒙古", "广西", "西藏", "宁夏", "新疆", "香港", "澳门",
  "合肥", "杭州", "南京", "武汉", "长沙", "成都", "昆明", "兰州", "西安", "郑州", "济南", "福州", "广州", "深圳", "南昌", "贵阳", "南宁", "银川",
].join("|")})(省|市|自治区)?|^[一-龥]{2,3}市`);

/** 从宜搭“资质/荣誉台账”同步来的一条。有效期是 YYYY-MM-DD，没写的为空串。 */
export interface CompanyQualification { id: string; company: string; kind: string; name: string; validFrom: string; validTo: string }
/** 最近一次宜搭同步：成功时 count 是条数，失败时 error 是原因。 */
export interface QualificationSync { at: string; count: number | null; error: string; warnings: string[] }

/**
 * 后台手填的我司条件（资质从宜搭同步，不在这里）：每行“公司：内容”，公司写简称或全称，
 * 例如“博创：一级建造师（机电） 3 人”。
 */
export interface CompanyProfile {
  /** 人员证书和人数。 */
  personnel: string[];
  /** 业绩，例如“博创：2024 年 国网某公司 变电站视频监控系统运维 120 万元”。 */
  performance: string[];
  /** 其他：体系认证、注册资本、信用等级等。 */
  other: string[];
}

/** 列表上的一条：一个具体项目（需求行），带它所属的批次和包。 */
export interface OpportunityCard {
  id: string;
  noticeId: string;
  source: SourceKey;
  /** 国网两个平台的名称，或其他招采平台的信源名。 */
  sourceName: string;
  /** 平台（见 PlatformOption）。 */
  platform: string;
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
  /** 资质、业绩、人员要求，按这个顺序。 */
  requirements: ItemRequirement[];
  /** 公告写了资格要求“详见招标文件”，公开部分没写全。 */
  requirementsInDocuments: boolean;
  /** 和我司资质的匹配度；没有要求可比、没填我司资质或还没比完时为 null。 */
  match: MatchSummary | null;
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
  /** 有公告的平台，给来源筛选用。 */
  platforms: PlatformOption[];
  /** 按一条信息表消息列出时（?sheet=）：它推到哪个群、什么时候。 */
  sheet: { title: string; sentAt: string } | null;
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
  /** 只推这些平台（PlatformOption 的 key）；空表示全部来源。 */
  sources: string[];
  /** 推不推待确认的项目（其他招采平台的待确认一律不推）。 */
  includeMaybe: boolean;
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
  company: CompanyProfile;
  /** 宜搭资质同步：配没配、最近一次结果、当前同步到的资质。 */
  qualifications: { configured: boolean; status: QualificationSync | null; rows: CompanyQualification[] };
  platforms: PlatformOption[];
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
