import { AI_RELEVANCE, POLICY_LEVELS, type AiRelevance } from "../types.ts";

export const levelLabel = (level: string) => POLICY_LEVELS[level as keyof typeof POLICY_LEVELS] ?? level;

/** AI 相关程度的角标颜色。 */
export const AI_TONE: Record<AiRelevance, string> = { core: "bg-accent text-white", partial: "bg-accent/10 text-accent", none: "bg-bg-sunk text-ink-4" };
export const aiLabel = (r: AiRelevance) => AI_RELEVANCE[r];

export const ROLE_LABEL: Record<string, string> = { original: "原文", interpretation: "解读", report: "报道" };
