// 招采申报在网页上的说法：日期、截止倒计时、金额。倒计时按接口给的“现在”算，服务器和浏览器渲染出来一样。
import type { Moment } from "../types.ts";

const DAY = 86_400_000;
/** The Beijing wall clock of a moment, read with getUTC*. */
const beijing = (ms: number) => new Date(ms + 8 * 3600_000);

/** “12月18日 09:00”；原文只写了日期的是“12月18日”。 */
export function momentText(m: Moment): string {
  const d = beijing(Date.parse(m.value));
  const day = `${d.getUTCMonth() + 1}月${d.getUTCDate()}日`;
  return m.day ? day : `${day} ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

export type Urgency = "past" | "urgent" | "soon" | "later";

/** 还剩多久，按北京时间的日历天数：已截止、今天截止、明天截止、还剩 N 天。 */
export function countdown(m: Moment, nowIso: string): { text: string; urgency: Urgency } {
  const end = Date.parse(m.value);
  const now = Date.parse(nowIso);
  if (end < now) return { text: "已截止", urgency: "past" };
  const days = Math.round((beijing(end).setUTCHours(0, 0, 0, 0) - beijing(now).setUTCHours(0, 0, 0, 0)) / DAY);
  if (days === 0) return { text: "今天截止", urgency: "urgent" };
  if (days === 1) return { text: "明天截止", urgency: "urgent" };
  return { text: `还剩 ${days} 天`, urgency: days <= 3 ? "soon" : "later" };
}

export const URGENCY_CLASS: Record<Urgency, string> = {
  past: "bg-bg-sunk text-ink-4",
  urgent: "bg-hot-soft text-hot",
  soon: "bg-amber/10 text-amber",
  later: "bg-accent-soft text-accent",
};

const trim = (n: number) => String(Math.round(n * 100) / 100);
/** “111 万元”“1.5 亿元”“8,000 元”。 */
export function amountText(yuan: number): string {
  if (yuan >= 1e8) return `${trim(yuan / 1e8)} 亿元`;
  if (yuan >= 1e4) return `${trim(yuan / 1e4)} 万元`;
  return `${Math.round(yuan).toLocaleString("zh-CN")} 元`;
}

/** “11月24日”：发布日期（北京时间）。 */
export function dayText(iso: string): string {
  const d = beijing(Date.parse(iso));
  return `${d.getUTCMonth() + 1}月${d.getUTCDate()}日`;
}
