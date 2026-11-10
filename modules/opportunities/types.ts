// 项目商机的数据约定：后端接口给页面的形状，以及采集服务（fetcher/）返回的形状。
// 页面只读这里的类型；字段的值都是来源原文（时间、金额照抄），没有的就是空串，不推测。

export type Verdict = "relevant" | "maybe" | "irrelevant" | "pending";
export type CeilingKind = "amount_wan" | "amount_yuan" | "percent" | "unknown";
export type SourceKey = "ecp" | "etp";

export const SOURCE_NAMES: Record<SourceKey, string> = { ecp: "国网电子商务平台", etp: "国网电工交易专区" };
export const VERDICT_LABELS: Record<Verdict, string> = { relevant: "相关", maybe: "待确认", irrelevant: "无关", pending: "待筛选" };

/** 列表上的一条：一个具体项目（需求行），带它所属的批次和包。 */
export interface OpportunityCard {
  id: string;
  noticeId: string;
  source: SourceKey;
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
  /** 采购文件获取截止、开标（开启应答文件）时间，来源原文。 */
  fileDeadline: string;
  openingTime: string;
  /** 文件获取截止已过（按北京时间比较）。 */
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
  title: string;
  batch: string;
  buyer: string;
  published: string;
  fileDeadline: string;
  openingTime: string;
  url: string;
  /** pending 待取附件 · parsed 已解析 · partial 部分解析 · no_file 没有公开附件 · failed 取附件失败 · blocked 需要人工 */
  status: string;
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

export interface OpportunityAdmin {
  profile: BusinessProfile;
  defaults: BusinessProfile;
  status: {
    fetcherConfigured: boolean;
    pushConfigured: boolean;
    pushEnabled: boolean;
    collectOn: boolean;
    modelOn: boolean;
  };
  notices: Array<{
    id: string; source: SourceKey; title: string; status: string; error: string; url: string;
    itemCount: number; relevant: number; maybe: number; discoveredAt: string; pushedAt: string | null; backfill: boolean;
  }>;
  counts: { pending: number; failed: number; relevant: number; maybe: number };
}

/** 采集服务 POST /discover 返回的一条公告。 */
export interface FetcherNotice {
  source: SourceKey;
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
  /** Word 公告正文的开头（附件里没有需求表时用）。 */
  text?: string;
}
