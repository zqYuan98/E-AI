// 政策规划库的接口数据（api 和网页共用）。
export const POLICY_LEVELS = { national: "国家部委", sgcc: "国家电网", csg: "南方电网", generation: "发电集团", local: "地方", other: "其他" } as const;
export type PolicyLevel = keyof typeof POLICY_LEVELS;

export const POLICY_TYPES = ["规划", "行动方案", "指导意见", "通知公告", "管理办法", "标准规范", "白皮书报告", "会议部署", "政策解读", "其他"] as const;
export type PolicyType = (typeof POLICY_TYPES)[number];

export const AI_RELEVANCE = { core: "AI 专项", partial: "含 AI 条款", none: "未涉及 AI" } as const;
export type AiRelevance = keyof typeof AI_RELEVANCE;

/** 一个量化目标：原文怎么写的，原句是什么。 */
export interface PolicyTarget { metric: string; value: string; year: string | null; quote: string }
/** 一条任务或 AI 条款：概括和原句。 */
export interface PolicyClause { text: string; quote: string }

export interface PolicyDocCard {
  id: number;
  name: string;
  docType: PolicyType;
  level: PolicyLevel;
  issuers: string[];
  docNo: string | null;
  /** 原文写明的印发日期；没有时用来源发布日期。 */
  date: string | null;
  summary: string;
  aiRelevance: AiRelevance;
  targetCount: number;
  aiClauseCount: number;
}

export interface PolicyTargetRow extends PolicyTarget { docId: number; docName: string; level: PolicyLevel }

export interface PolicyListResponse { docs: PolicyDocCard[]; targets: PolicyTargetRow[] }

export interface PolicyReport { title: string; source: string; url: string; role: string; itemId: string | null; at: string | null }

export interface PolicyDocDetail extends PolicyDocCard {
  targets: PolicyTarget[];
  tasks: PolicyClause[];
  aiClauses: PolicyClause[];
  url: string;
  reports: PolicyReport[];
}
