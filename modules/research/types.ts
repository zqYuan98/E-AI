// 研报库的接口数据（api 和网页共用）。只有元数据、摘要和带原话的要点；原文到研报网站（洞见等）上看。

/** 一条要点：概括，和研报里的一句原话。 */
export interface ResearchPoint { text: string; quote: string }

export interface ResearchCard {
  id: number;
  title: string;
  institution: string;
  /** 研报发布日期 YYYY-MM-DD。 */
  date: string | null;
  summary: string;
  topics: string[];
  pointCount: number;
}

export interface ResearchDetail extends ResearchCard {
  url: string;
  points: ResearchPoint[];
}

export interface ResearchListResponse {
  reports: ResearchCard[];
  /** 现有研报里出现过的主题和篇数，筛选用。 */
  topics: Array<{ topic: string; count: number }>;
}

/** 建议的主题标签（录入时可选，也可以写别的）。 */
export const RESEARCH_TOPICS = [
  "电力大模型", "智能巡检", "调度与预测", "新型电力系统", "虚拟电厂", "算电协同", "数据中心与算力",
  "储能", "电力市场", "新能源", "国家电网", "南方电网", "发电集团", "政策解读",
] as const;
