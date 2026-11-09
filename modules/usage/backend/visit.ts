// 浏览器报来的一次访问：校验、清洗、限频。身份不在这里认，由 server.ts 向访问模块的会话接口问。
import { z } from "zod";

/** 后台、接口和登录页不记：管理员不计入，登录页没有成员。 */
const NOT_COUNTED = /^\/(?:admin|api|login)(?:\/|$)/i;

const Visit = z.object({
  // 只收路径：查询参数里可能有搜索词，不存。
  path: z.string().max(200).regex(/^\/[^\s?#]*$/).refine((path) => !NOT_COUNTED.test(path)),
  title: z.string().max(300).optional(),
}).strict();

export function parseVisit(raw: unknown): { path: string; title: string } | null {
  const parsed = Visit.safeParse(raw);
  if (!parsed.success) return null;
  return { path: parsed.data.path, title: (parsed.data.title ?? "").replace(/\p{Cc}/gu, " ").trim().slice(0, 120) };
}

export function deviceOf(userAgent: string | undefined): "mobile" | "desktop" {
  return /Mobi|Android|iPhone|iPad|iPod/i.test(userAgent ?? "") ? "mobile" : "desktop";
}

const WINDOW_MS = 60_000;
const LIMIT = 60;
const seen = new Map<number, number[]>();

/** 每个成员每分钟最多记 60 次，多出来的丢掉；成员数有限，这张表不会无限长。 */
export function allowVisit(memberId: number, now = Date.now()): boolean {
  const recent = (seen.get(memberId) ?? []).filter((t) => now - t < WINDOW_MS);
  const allowed = recent.length < LIMIT;
  if (allowed) recent.push(now);
  seen.set(memberId, recent);
  return allowed;
}
