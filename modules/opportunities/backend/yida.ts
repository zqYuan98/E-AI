// 我司资质从宜搭同步：只读“资质/荣誉台账”表单（类型、资质/荣誉名称、所属公司、有效期），每天 07:30 一次，后台也能手动同步；
// 正式同步前可以先“试读”，看认出的字段和前几条对不对。附件（扫描件）不读，名称字段就够比对。
// 凭据：钉钉企业内部应用（DINGTALK_APP_KEY / DINGTALK_APP_SECRET，要开通“宜搭表单数据读权限”）换访问令牌，
// 加宜搭的应用编码、应用秘钥、读数据用的账号（接口按这个人在宜搭里的查看权限返回）和表单 UUID。
// 字段先按标题认；取不到标题时按取值认：取值只有“资质 / 荣誉”的是类型，多数带“公司”的是所属公司，日期区间是有效期。
import { audit } from "@aihot/backend/audit";
import { credential } from "@aihot/backend/config";
import { sql } from "@aihot/backend/db";
import { beijingDate } from "@aihot/contracts/time";
import type { CompanyQualification, QualificationSync } from "../types.ts";

const API = "https://api.dingtalk.com";
const STATUS_KEY = "opportunities.yida_sync";
const PAGE_SIZE = 100;
const MAX_PAGES = 50;

export interface YidaConfig { appKey: string; appSecret: string; appType: string; systemToken: string; userId: string; formUuid: string }

/** 六项都配了才同步。 */
export function yidaConfig(): YidaConfig | null {
  const get = (name: string) => credential("integrations", name);
  const c = {
    appKey: get("DINGTALK_APP_KEY"), appSecret: get("DINGTALK_APP_SECRET"), appType: get("YIDA_APP_TYPE"),
    systemToken: get("YIDA_SYSTEM_TOKEN"), userId: get("YIDA_USER_ID"), formUuid: get("YIDA_QUALIFICATION_FORM"),
  };
  return Object.values(c).every(Boolean) ? (c as YidaConfig) : null;
}

/** 钉钉或宜搭拒绝了请求；message 里带它给的错误码和原因（权限没开、秘钥不对、账号没有查看权限……）。 */
export class YidaError extends Error {}

async function call(url: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(20_000) });
  } catch {
    throw new YidaError("连不上钉钉开放平台（api.dingtalk.com），请检查服务器网络");
  }
  const body = await res.json().catch(() => null) as Record<string, unknown> | null;
  if (!res.ok || !body) throw new YidaError(`钉钉拒绝：${res.status} ${String(body?.code ?? "")} ${String(body?.message ?? "").slice(0, 200)}`.trim());
  return body;
}

// 访问令牌两小时有效，提前五分钟换新；凭据换过或被拒时丢掉重取。
let token: { key: string; value: string; until: number } | null = null;

async function accessToken(c: YidaConfig): Promise<string> {
  if (token && token.key === c.appKey && token.until > Date.now()) return token.value;
  const body = await call(`${API}/v1.0/oauth2/accessToken`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ appKey: c.appKey, appSecret: c.appSecret }),
  });
  if (typeof body.accessToken !== "string") throw new YidaError("钉钉没有返回访问令牌，请检查 DINGTALK_APP_KEY / DINGTALK_APP_SECRET");
  token = { key: c.appKey, value: body.accessToken, until: Date.now() + Math.max(60, (Number(body.expireIn) || 7200) - 300) * 1000 };
  return token.value;
}

const headers = async (c: YidaConfig) => ({ "content-type": "application/json", "x-acs-dingtalk-access-token": await accessToken(c) });

/** 组件标题：字符串，或 {"zh_CN": "..."} 这样的多语言对象（也可能是它的 JSON 字符串）。 */
function labelText(label: unknown): string {
  if (typeof label === "string") {
    if (!label.startsWith("{")) return label;
    try { return labelText(JSON.parse(label)); } catch { return label; }
  }
  if (label && typeof label === "object") {
    const l = label as Record<string, unknown>;
    return String(l.zh_CN ?? l.zh ?? l.value ?? l.en_US ?? "");
  }
  return "";
}

/** 表单各组件的标题；拿不到时返回空（后面按取值认字段）。 */
async function fieldLabels(c: YidaConfig): Promise<{ labels: Map<string, string>; warning: string }> {
  try {
    const q = new URLSearchParams({ appType: c.appType, systemToken: c.systemToken, userId: c.userId, formUuid: c.formUuid, language: "zh_CN" });
    const body = await call(`${API}/v1.0/yida/forms/formFields?${q}`, { headers: await headers(c) });
    const list = (Array.isArray(body.result) ? body.result : []) as Array<Record<string, unknown>>;
    return { labels: new Map(list.map((f) => [String(f.fieldId ?? ""), labelText(f.label)]).filter(([id, l]) => id && l) as Array<[string, string]>), warning: "" };
  } catch (error) {
    return { labels: new Map(), warning: `取不到字段标题（${(error as Error).message}），按取值认字段` };
  }
}

/** 表单的全部记录（每页 100 条，最多 5000 条）。 */
async function allRecords(c: YidaConfig): Promise<Array<{ id: string; data: Record<string, unknown> }>> {
  const out: Array<{ id: string; data: Record<string, unknown> }> = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const body = await call(`${API}/v1.0/yida/forms/instances/search`, {
      method: "POST", headers: await headers(c),
      body: JSON.stringify({ appType: c.appType, systemToken: c.systemToken, userId: c.userId, formUuid: c.formUuid, language: "zh_CN", currentPage: page, pageSize: PAGE_SIZE }),
    });
    const data = (Array.isArray(body.data) ? body.data : []) as Array<Record<string, unknown>>;
    for (const r of data) out.push({ id: String(r.formInstanceId ?? r.formInstId ?? r.instanceId ?? ""), data: (r.formData ?? {}) as Record<string, unknown> });
    if (data.length < PAGE_SIZE || out.length >= Number(body.totalCount ?? Infinity)) break;
  }
  return out;
}

/** 组件取值转成文字：下拉、关联表单、成员这类是数组或对象，取它们的文字。 */
function text(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") {
    if (/^[[{]/.test(v.trim())) {
      try { return text(JSON.parse(v)); } catch { return v.trim(); }
    }
    return v.trim();
  }
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return v.map(text).filter(Boolean).join("、");
  const o = v as Record<string, unknown>;
  return text(o.title ?? o.text ?? o.name ?? o.label ?? o.value ?? "");
}

const toDate = (v: unknown): string => {
  const n = typeof v === "string" && /^\d{10,}$/.test(v) ? Number(v) : v;
  if (typeof n === "number" && n > 0) return beijingDate(new Date(n));
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : "";
};

/** 有效期：日期区间组件的 [开始, 结束]（毫秒时间戳或日期字符串）；单个日期当作截止。 */
function range(v: unknown): [string, string] {
  let x = v;
  if (typeof x === "string" && x.trim().startsWith("[")) {
    try { x = JSON.parse(x); } catch { /* 照原样 */ }
  }
  if (Array.isArray(x)) return [toDate(x[0]), toDate(x[1])];
  return ["", toDate(x)];
}

type Role = "kind" | "name" | "company" | "valid";
const ROLE_LABELS: Record<Role, RegExp> = { kind: /^类型$|类别/, name: /名称/, company: /公司|主体/, valid: /有效期/ };
const ROLE_NAMES: Record<Role, string> = { kind: "类型", name: "资质/荣誉名称", company: "所属公司", valid: "有效期" };

/** 认字段：先按标题，再按取值。返回每个角色对应的组件 ID。 */
export function pickFields(records: Array<{ data: Record<string, unknown> }>, labels: Map<string, string>): Record<Role, string | null> {
  const keys = [...new Set(records.flatMap((r) => Object.keys(r.data)))].filter((k) => !/_(id|value)$/.test(k));
  const used = new Set<string>();
  const out = {} as Record<Role, string | null>;
  const take = (role: Role, test: (k: string) => boolean) => {
    const k = keys.find((x) => !used.has(x) && test(x)) ?? null;
    if (k) used.add(k);
    out[role] = k;
  };
  const values = (k: string) => records.map((r) => text(r.data[k])).filter(Boolean);
  for (const role of ["valid", "kind", "company", "name"] as Role[]) take(role, (k) => ROLE_LABELS[role].test(labels.get(k) ?? ""));
  if (!out.valid) take("valid", (k) => /^(cascadeDate|dateRange)/i.test(k));
  if (!out.kind) take("kind", (k) => { const v = values(k); return v.length > 0 && v.every((x) => /^(资质|荣誉)$/.test(x)); });
  if (!out.company) take("company", (k) => { const v = values(k); return v.length > 0 && v.filter((x) => x.includes("公司")).length * 2 > v.length; });
  if (!out.name) take("name", (k) => /^textField/i.test(k) && values(k).length > 0);
  return out;
}

export function mapRecords(records: Array<{ id: string; data: Record<string, unknown> }>, fields: Record<Role, string | null>): CompanyQualification[] {
  return records.flatMap((r) => {
    const name = fields.name ? text(r.data[fields.name]) : "";
    const company = fields.company ? text(r.data[fields.company]) : "";
    if (!r.id || !name || !company) return [];
    const [validFrom, validTo] = fields.valid ? range(r.data[fields.valid]) : ["", ""];
    return [{ id: r.id, company, kind: fields.kind ? text(r.data[fields.kind]) : "", name, validFrom, validTo }];
  });
}

export interface SyncPreview {
  count: number;
  companies: string[];
  /** 认出的字段：角色 → “组件 ID（标题）”，没认出的为空串。 */
  fields: Record<string, string>;
  sample: CompanyQualification[];
  warnings: string[];
}

/**
 * 读一遍台账。dryRun 只返回认出的字段和前 10 条，不落库；否则整表替换（宜搭里删掉的这里也删掉），记下同步时间。
 * 必需的字段（名称、所属公司）没认出来时不落库，免得把已有的清空。
 */
export async function syncQualifications(opts: { dryRun?: boolean; actor?: string; reason?: string } = {}): Promise<SyncPreview> {
  const c = yidaConfig();
  if (!c) throw Object.assign(new YidaError("宜搭同步没有配置：服务器 .env 要有 DINGTALK_APP_KEY、DINGTALK_APP_SECRET、YIDA_APP_TYPE、YIDA_SYSTEM_TOKEN、YIDA_USER_ID、YIDA_QUALIFICATION_FORM"), { statusCode: 400 });
  try {
    const [{ labels, warning }, records] = await Promise.all([fieldLabels(c), allRecords(c)]);
    const fields = pickFields(records, labels);
    const rows = mapRecords(records, fields);
    const warnings = [warning, ...(["name", "company", "valid", "kind"] as Role[]).filter((r) => !fields[r]).map((r) => `没认出“${ROLE_NAMES[r]}”字段`)].filter(Boolean);
    if (records.length && rows.length < records.length) warnings.push(`${records.length - rows.length} 条记录缺名称或所属公司，没有同步`);
    const preview: SyncPreview = {
      count: rows.length,
      companies: [...new Set(rows.map((r) => r.company))],
      fields: Object.fromEntries((Object.keys(ROLE_NAMES) as Role[]).map((r) => [ROLE_NAMES[r], fields[r] ? `${fields[r]}${labels.get(fields[r]!) ? `（${labels.get(fields[r]!)}）` : ""}` : ""])),
      sample: rows.slice(0, 10),
      warnings,
    };
    if (opts.dryRun) return preview;
    if (!fields.name || !fields.company) throw new YidaError(`没认出${!fields.name ? "名称" : "所属公司"}字段，没有同步；先点“试读”看看读到了什么`);
    await sql.begin(async (tx) => {
      await tx`DELETE FROM opp_company_quals`;
      for (const r of rows) {
        await tx`INSERT INTO opp_company_quals (id, company, kind, name, valid_from, valid_to)
          VALUES (${r.id}, ${r.company}, ${r.kind}, ${r.name}, ${r.validFrom}, ${r.validTo})`;
      }
    });
    await saveStatus({ at: new Date().toISOString(), count: rows.length, error: "", warnings });
    if (opts.actor) await audit(opts.actor, "opportunities.yida_sync", "opportunities:company", opts.reason || null, null, { count: rows.length, companies: preview.companies });
    return preview;
  } catch (error) {
    if (error instanceof YidaError) token = null;
    if (!opts.dryRun) await saveStatus({ at: new Date().toISOString(), count: null, error: (error as Error).message.slice(0, 300), warnings: [] });
    throw Object.assign(error as Error, { statusCode: (error as { statusCode?: number }).statusCode ?? 400 });
  }
}

async function saveStatus(s: QualificationSync): Promise<void> {
  await sql`INSERT INTO settings (key, value, updated_by) VALUES (${STATUS_KEY}, ${sql.json(s as never)}, 'system')
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
}

export async function syncStatus(): Promise<QualificationSync | null> {
  const [row] = await sql<{ value: QualificationSync }[]>`SELECT value FROM settings WHERE key = ${STATUS_KEY}`;
  return row?.value ?? null;
}

export async function loadQualifications(): Promise<CompanyQualification[]> {
  return sql<CompanyQualification[]>`SELECT id, company, kind, name, valid_from AS "validFrom", valid_to AS "validTo"
    FROM opp_company_quals ORDER BY company, kind, name`;
}
