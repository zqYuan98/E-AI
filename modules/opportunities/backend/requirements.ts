// 一个项目的资质、业绩、人员要求，给商务一眼看清、和我司资质对比：项目自己表格里写的（国网需求一览表的资质、业绩、人员列），
// 加上公告正文里抽出的、适用于它所在包的通用要求（details.ts，原话核对过）。都照原文，不推测；没写的就没有。
// 和各投标主体条件的对比结果（match.ts）按序号存着，要求的文字变了（重新抓取、重新抽取）就不再用旧结果。
// 每份公告都有的套话（“须取得法律法规规定的有效许可证”这类）和只说“见附件 / 采购文件”的指引不列、不比，公告要素里照样看得到原文。
import { createHash } from "node:crypto";
import type { EntityMatch, ItemRequirement, MatchStatus, MatchSummary, NoticeDetails, RequirementGroup } from "../types.ts";

const GROUPS: RequirementGroup[] = ["qualification", "performance", "personnel"];

// 套话：国网等公告通用条件里的许可证、强制认证、产品试验报告，看不出这个项目要什么资质。只认短句，
// 免得把后面跟着具体资质的长句（“有效许可证：承装（修、试）电力设施许可证四级”）一起丢掉。
const BOILERPLATE = [/规定的有效许可证/, /要求的(国家)?强制(性产品)?认证/, /产品\S{0,4}(试验|检测|检验)报告/];
// 指引：整句只是说要求写在别处（“人员要求按采购公告附件需求一览表提供”“详见招标文件”）；后面还跟着具体要求的不算。
const POINTER = /^(\S{0,8}要求)?(按|详见|见|参见)\S{0,12}(附件|需求一览表|采购文件|招标文件|谈判文件|磋商文件)\S{0,6}$/;

/** 不列、不比的要求：套话或指引。 */
export function isBoilerplate(text: string): boolean {
  const t = text.replace(/\s+/g, "");
  return (t.length <= 50 && BOILERPLATE.some((re) => re.test(t))) || POINTER.test(t);
}

export interface RequirementSource {
  package: string; package_name: string; qualifications: string; performance: string; personnel: string;
}

/**
 * 存在 opp_items.match 里的对比结果：reqs 是对比时要求列表的指纹，companies 是比过的主体，
 * checks 与要求一一对应：met / unmet 是满足、不满足的主体序号（companies 的下标），其余主体需核实。
 */
export interface StoredMatch { reqs: string; companies: string[]; checks: Array<{ met: number[]; unmet: number[]; note: string }> }

const shown = (s: string) => s.trim() !== "" && s.trim() !== "/" && s.trim() !== "无";
const norm = (s: string) => s.normalize("NFKC").replace(/\s+/g, "").toLowerCase();
const num = (s: string) => /(\d+)/.exec(s.normalize("NFKC"))?.[1] ?? null;

// 有的网省模板把资质和业绩写在同一列（“专用资格要求/业绩资质要求”），按其中“业绩要求：”这样的小标题拆开。
const PERFORMANCE_HEAD = /(^|[\n；;。])\s*(?:\d+[.、．)）]\s*)?(?:供应商|投标人|响应人)?业绩(?:要求)?[:：]/;

/** 一列里同时写了资质和业绩时拆成两段；没有“业绩要求：”小标题的不拆。 */
export function splitCombined(text: string): { qualifications: string; performance: string } {
  const m = PERFORMANCE_HEAD.exec(text);
  if (!m) return { qualifications: text, performance: "" };
  const head = text.slice(0, m.index + m[1]!.length).replace(/[\n；;。\s]+$/, "");
  return { qualifications: head.replace(/^\s*(?:\d+[.、．)）]\s*)?(?:资质|资格)(?:要求)?[:：]\s*/, ""), performance: text.slice(m.index + m[0].length).trim() };
}

/** 公告里只适用于某些包的要求，是否适用于这个项目：包号或包名对得上。项目没有包（整份公告一个项目）时都适用。 */
export function appliesTo(lots: string[], item: Pick<RequirementSource, "package" | "package_name">): boolean {
  if (!lots.length || !shown(item.package)) return true;
  const pkg = norm(item.package);
  const pkgNum = num(item.package);
  return lots.some((l) => norm(l) === pkg || (!!item.package_name && norm(l) === norm(item.package_name)) || (pkgNum !== null && num(l) === pkgNum));
}

/** 项目的要求列表（不含对比结果），按资质、业绩、人员排；同一类里先项目自己的，再公告通用的，文字相同的只留一条。 */
export function itemRequirements(item: RequirementSource, details: NoticeDetails | null): Array<Omit<ItemRequirement, "status" | "note">> {
  const own: Record<RequirementGroup, string> = { qualification: item.qualifications, performance: item.performance, personnel: item.personnel };
  if (!shown(own.performance) && shown(own.qualification)) {
    const split = splitCombined(own.qualification);
    own.qualification = split.qualifications;
    own.performance = split.performance;
  }
  const out: Array<Omit<ItemRequirement, "status" | "note">> = [];
  for (const group of GROUPS) {
    const seen = new Set<string>();
    const add = (text: string, from: "item" | "notice") => {
      const t = text.trim();
      if (!shown(t) || seen.has(norm(t)) || isBoilerplate(t)) return;
      seen.add(norm(t));
      out.push({ group, text: t, from });
    };
    add(own[group], "item");
    for (const r of details?.requirements ?? []) if (r.kind === group && appliesTo(r.lots, item)) add(r.text, "notice");
  }
  return out;
}

export const requirementsHash = (reqs: Array<Pick<ItemRequirement, "group" | "text">>) =>
  createHash("sha256").update(JSON.stringify(reqs.map((r) => [r.group, r.text]))).digest("hex").slice(0, 16);

const statusOf = (c: StoredMatch["checks"][number], k: number): MatchStatus => (c.unmet.includes(k) ? "unmet" : c.met.includes(k) ? "met" : "unknown");

/**
 * 各主体按“不满足少、满足多”排，第一个就是建议的投标主体；所有主体结果一样时不建议（company 为空串），免得按名字顺序挑出一家。
 * 等级按排第一的算：有不满足为低，一条都没满足为资料不足，有需核实为中，都满足为高。
 */
export function summarize(m: StoredMatch): MatchSummary | null {
  if (!m.companies.length || !m.checks.length) return null;
  const entities: EntityMatch[] = m.companies.map((company, k) => {
    const s = m.checks.map((c) => statusOf(c, k));
    return { company, met: s.filter((x) => x === "met").length, unmet: s.filter((x) => x === "unmet").length, unknown: s.filter((x) => x === "unknown").length };
  }).sort((a, b) => a.unmet - b.unmet || b.met - a.met);
  const best = entities[0]!;
  const tie = entities.every((e) => e.met === best.met && e.unmet === best.unmet);
  const level = best.unmet ? "low" : best.met === 0 ? "unknown" : best.unknown ? "medium" : "high";
  return { ...best, company: tie ? "" : best.company, level, entities };
}

/** 要求列表配上排第一的主体的对比结果（各主体一样时就是它们共同的结果）；对比时的要求和现在的对不上（指纹不同）就当没比过。 */
export function withMatch(item: RequirementSource & { match: StoredMatch | null }, details: NoticeDetails | null): { requirements: ItemRequirement[]; match: MatchSummary | null } {
  const reqs = itemRequirements(item, details);
  const m = item.match && item.match.reqs === requirementsHash(reqs) && item.match.checks.length === reqs.length && Array.isArray(item.match.companies) ? item.match : null;
  const match = m ? summarize(m) : null;
  const k = match && m ? m.companies.indexOf(match.entities[0]!.company) : -1;
  const requirements = reqs.map((r, j) => ({ ...r, status: m && k >= 0 ? statusOf(m.checks[j]!, k) : null, note: m?.checks[j]?.note ?? "" }));
  return { requirements, match };
}
