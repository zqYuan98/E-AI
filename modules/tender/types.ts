// 招采申报的数据（api 和网页共用）：一篇招采类资料认出来的要素，和列表页要的东西。

/**
 * 公告阶段。plan 招标计划、采购意向；tender 招标、采购、询价、谈判、磋商、资格预审；change 变更、澄清、延期；
 * candidate 中标候选人公示；award 中标、成交结果；ended 终止、流标、废标；early 核准、批复、环评等项目前期；
 * call 申报、征集通知。
 */
export type TenderStage = "plan" | "tender" | "change" | "candidate" | "award" | "ended" | "early" | "call";

export const STAGE_LABELS: Record<TenderStage, string> = {
  plan: "招标计划", tender: "招标采购", change: "变更澄清", candidate: "候选人公示", award: "中标结果", ended: "终止流标", early: "项目前期", call: "申报通知",
};

/** 认出来的一项：值、原文里的叫法和那一小段原文。 */
export interface Quoted<T> {
  value: T;
  label: string;
  quote: string;
}

/** 一个时间点（北京时间）：ISO 字符串；day 表示原文只写了日期，按当天结束算。 */
export type Moment = Quoted<string> & { day: boolean };

export interface TenderFacts {
  stage: TenderStage | null;
  /** 投标（响应、报价、申请）文件递交截止；申报通知里是申报截止。 */
  deadline: Moment | null;
  /** 报名或获取招标文件的截止。 */
  signup: Moment | null;
  /** 金额（元）：招标时是预算、最高限价或估算价，结果公告里是中标或成交金额。 */
  amount: Quoted<number> | null;
  purchaser: string | null;
  agent: string | null;
  winner: string | null;
  projectNo: string | null;
  region: string | null;
}

/** 列表的几个视图。“其他”是认不出阶段的招采类资料（例如采购动态的报道），有才出现。 */
export type TenderView = "open" | "result" | "early" | "call" | "other";
export const VIEWS: readonly TenderView[] = ["open", "result", "early", "call", "other"];
export const VIEW_LABELS: Record<TenderView, string> = { open: "可投标", result: "中标结果", early: "项目前期", call: "申报通知", other: "其他" };

/** 本站业务的重点省份（industry/prompts/selection-score.md 写的皖甘宁滇）：地区筛选排在最前，可以一起选中。 */
export const FOCUS_REGIONS: readonly string[] = ["安徽", "甘肃", "宁夏", "云南"];
/** 地区筛选里代表“重点省份”的值，和它的名字。 */
export const FOCUS = "focus";
export const FOCUS_LABEL = "重点省份（皖甘宁滇）";

export interface TenderRow {
  /** 站内条目：/items/:id。 */
  id: string;
  title: string;
  /** 原公告：报名、下载招标文件都要去那里。 */
  url: string;
  source: string;
  publishedAt: string | null;
  timelineAt: string;
  selected: boolean;
  facts: TenderFacts;
}

export interface TenderListResponse {
  view: TenderView;
  /** 省份、FOCUS，或者不限（null）。 */
  region: string | null;
  q: string | null;
  /** 可投标、申报通知里是否也列出已截止的。 */
  past: boolean;
  /** 每个视图在当前地区和关键词下的条数（可投标、申报通知只数没截止的）。 */
  views: Array<{ key: TenderView; count: number }>;
  /** 当前视图里出现过的地区和条数，重点省份在前。 */
  regions: Array<{ region: string; count: number }>;
  rows: TenderRow[];
  /** 当前视图里已截止、没有列出的条数（past 为 false 时）。 */
  hiddenPast: number;
  /** 读的时刻：倒计时按它算，服务器和浏览器渲染出来一样。 */
  now: string;
}
