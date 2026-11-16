// 我司条件：资质证书从宜搭“资质/荣誉台账”同步（yida.ts，过期的不算），人员证书、业绩和其他后台手填（settings 的
// opportunities.company），每行“公司：内容”。集团下有多家公司可以作为投标主体，比对时按公司分开（match.ts），
// 不把一家的资质和另一家的业绩拼在一起。都没有时不比。
import { createHash } from "node:crypto";
import { audit } from "@aihot/backend/audit";
import { sql } from "@aihot/backend/db";
import { beijingDate } from "@aihot/contracts/time";
import type { CompanyProfile, CompanyQualification } from "../types.ts";
import { loadQualifications } from "./yida.ts";

const KEY = "opportunities.company";
const FIELDS = ["personnel", "performance", "other"] as const;
const MAX_LINES = 300;
const MAX_CHARS = 200;
/** “博创：一级建造师 3 人”“博创:…”。 */
const LINE = /^([^：:]{1,30})[：:]\s*(.+)$/;

export const EMPTY_COMPANY: CompanyProfile = { personnel: [], performance: [], other: [] };

const clean = (s: unknown) => (typeof s === "string" ? s.replace(/[\u0000-\u001f\u007f]/g, "").trim() : "");
const bad = (message: string) => Object.assign(new Error(message), { statusCode: 400 });

/** 每类最多 300 条，每条最多 200 字，都要写成“公司：内容”；重复的去掉。 */
export function validateCompany(input: unknown): CompanyProfile {
  const raw = (input ?? {}) as Record<string, unknown>;
  const out = { ...EMPTY_COMPANY };
  for (const field of FIELDS) {
    const lines = [...new Set((Array.isArray(raw[field]) ? raw[field] : []).map(clean).filter(Boolean))];
    const long = lines.find((l) => l.length > MAX_CHARS);
    if (long) throw bad(`“${long.slice(0, 20)}…”超过 ${MAX_CHARS} 字，请拆成几条`);
    const loose = lines.find((l) => !LINE.test(l));
    if (loose) throw bad(`“${loose.slice(0, 30)}”要写成“公司：内容”，例如“博创：一级建造师（机电） 3 人”`);
    if (lines.length > MAX_LINES) throw bad(`每类最多 ${MAX_LINES} 条`);
    out[field] = lines;
  }
  return out;
}

export async function loadCompany(): Promise<CompanyProfile> {
  const [row] = await sql<{ value: unknown }[]>`SELECT value FROM settings WHERE key = ${KEY}`;
  if (!row) return EMPTY_COMPANY;
  try {
    return validateCompany(row.value);
  } catch {
    return EMPTY_COMPANY;
  }
}

export async function saveCompany(input: unknown, reason: string, actor: string): Promise<CompanyProfile> {
  const next = validateCompany(input);
  const before = await loadCompany();
  await sql`INSERT INTO settings (key, value, updated_by) VALUES (${KEY}, ${sql.json(next as never)}, ${actor})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`;
  await sql`UPDATE opp_notices SET match_failures = 0 WHERE match_failures > 0`;
  await audit(actor, "opportunities.company", "opportunities:company", reason || null, before, next);
  return next;
}

/** 一家公司（投标主体）用来比对的条件。 */
export interface Entity { company: string; qualifications: string[]; personnel: string[]; performance: string[]; other: string[] }

/** 手填行里的公司对到宜搭里的公司：全称相同，或写的是全称里的一段（“博创”→“安徽博创信息科技有限公司”）；对不上的单独算一家。 */
function resolve(prefix: string, companies: string[]): string {
  const p = prefix.trim();
  return companies.find((c) => c === p) ?? companies.find((c) => c.includes(p)) ?? p;
}

/** 有效期已过的资质不算；没写有效期的（荣誉多半没有）算。 */
const current = (q: CompanyQualification, today: string) => !q.validTo || q.validTo >= today;
const qualText = (q: CompanyQualification) => `${q.name}${q.kind && q.kind !== "资质" ? `（${q.kind}）` : ""}${q.validTo ? `（有效期至 ${q.validTo}）` : ""}`;

/** 各投标主体的条件：宜搭里的公司在前（按名称，资质在荣誉前），手填里另外写到的公司在后。 */
export function buildEntities(quals: CompanyQualification[], manual: CompanyProfile, today: string): Entity[] {
  const byName = new Map<string, Entity>();
  const entity = (company: string) => {
    let e = byName.get(company);
    if (!e) byName.set(company, e = { company, qualifications: [], personnel: [], performance: [], other: [] });
    return e;
  };
  const order = (q: CompanyQualification) => (q.kind === "资质" || !q.kind ? 0 : 1);
  const sorted = [...quals].sort((a, b) => a.company.localeCompare(b.company, "zh") || order(a) - order(b) || a.name.localeCompare(b.name, "zh"));
  for (const q of sorted) if (current(q, today)) entity(q.company).qualifications.push(qualText(q));
  const companies = [...new Set(quals.map((q) => q.company))];
  for (const field of FIELDS) {
    for (const line of manual[field]) {
      const m = LINE.exec(line);
      if (m) entity(resolve(m[1]!, companies))[field].push(m[2]!.trim());
    }
  }
  return [...byName.values()];
}

export async function loadEntities(now = new Date()): Promise<Entity[]> {
  return buildEntities(await loadQualifications(), await loadCompany(), beijingDate(now));
}

/** 比对结果对应哪一版条件（资质过期、同步到新资质、手填改了都会变）；什么都没有时为空串（不比）。 */
export function entitiesKey(entities: Entity[]): string {
  if (!entities.length) return "";
  return createHash("sha256").update(JSON.stringify(entities)).digest("hex").slice(0, 16);
}
