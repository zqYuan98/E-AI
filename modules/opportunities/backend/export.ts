// 盲投信息表导出成 Excel（.xlsx）：一行一个项目，列和钉钉信息表的要素一致，商务按要素初审。
// 列宽、表头冻结和筛选、自动换行都设好；项目名点开是站内详情，“原公告”点开是来源网站。长文字截短，全文在详情里看。
import { config } from "@aihot/backend/config";
import { MATCH_STATUS_LABELS, REQUIREMENT_GROUP_LABELS, VERDICT_LABELS, missingRequirement, type OpportunityCard, type RequirementGroup } from "../types.ts";
import { formatCeiling, matchText } from "./push.ts";
import { xlsx, type Cell, type Sheet } from "./xlsx.ts";

type Row = OpportunityCard & { scope: string };

const short = (s: string, n: number) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};
// 正文里说“采什么”的那句：“采购范围：……”“项目概况为……”。
const SCOPE_HEAD = /(采购范围|采购内容|招标范围|服务范围|服务内容|项目概况|建设内容|项目内容)(及[^：:，。]{0,12})?[：:为是\s]\s*/;

/**
 * 采购内容摘要：需求表里写的照用；整份公告当一个项目的（其他平台、国网只有 Word 公告的），从正文里找“采购范围：”后面那句，
 * 找不到就去掉开头重复的项目名再截短。
 */
function summary(c: Row): string {
  const text = c.scope.replace(/\s+/g, " ").trim();
  if (c.source !== "web" && text.length <= 300) return short(text, 100);
  const m = SCOPE_HEAD.exec(text);
  const after = m ? text.slice(m.index + m[0].length) : "";
  if (after && !/^(详见|见|按)/.test(after)) return short(after, 100);
  const name = (c.projectName || c.noticeTitle).replace(/\s+/g, " ").trim();
  return short(name && text.startsWith(name) ? text.slice(name.length).replace(/^[\s:：,，。]+/, "") : text, 100);
}

/** “2026-11-17 12:00:00” → “2026-11-17 12:00”。 */
const minute = (s: string) => s.replace(/^(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}):\d{2}$/, "$1");

/** 一类要求：每条一行，比对过的前面标满足 / 不满足 / 需核实（不满足的带上差在哪里）。 */
function requirements(c: Row, group: RequirementGroup): string {
  const rs = c.requirements.filter((r) => r.group === group);
  if (!rs.length) return missingRequirement(c.requirementsInDocuments);
  return rs.map((r) => {
    const tag = r.status ? `[${MATCH_STATUS_LABELS[r.status]}${r.status === "unmet" && r.note ? `：${r.note}` : ""}] ` : "";
    return `${tag}${short(r.text, 150)}`;
  }).join("\n");
}

const COLUMNS: Array<{ header: string; width: number; value: (c: Row, k: number, companyOn: boolean) => Cell }> = [
  { header: "序号", width: 6, value: (_c, k) => k + 1 },
  { header: "判断", width: 7, value: (c) => VERDICT_LABELS[c.verdict] },
  { header: "截止时间", width: 19, value: (c) => [c.fileDeadline && `获取 ${minute(c.fileDeadline)}`, c.bidDeadline && `投标 ${minute(c.bidDeadline)}`].filter(Boolean).join("\n") || "未写明" },
  {
    header: "项目名称（点开看详情）", width: 38,
    value: (c) => ({
      text: [c.projectName || c.noticeTitle, [c.packageLabel, c.packageName].filter(Boolean).join(" · ")].filter(Boolean).join("\n"),
      link: `${config.siteUrl}/opportunities/${encodeURIComponent(c.noticeId)}#item-${c.id}`,
    }),
  },
  { header: "采购人 / 地区", width: 22, value: (c) => [c.buyer, c.location].filter(Boolean).join("\n") },
  { header: "来源", width: 16, value: (c) => c.sourceName },
  { header: "业务方向", width: 12, value: (c) => c.line },
  { header: "限价 / 预算", width: 13, value: (c) => formatCeiling(c.ceiling, c.ceilingKind) || (c.noticeBudget && `预算 ${c.noticeBudget}`) || "未写明" },
  { header: "采购内容（摘要）", width: 36, value: (c) => summary(c) },
  { header: `${REQUIREMENT_GROUP_LABELS.qualification}要求`, width: 42, value: (c) => requirements(c, "qualification") },
  { header: `${REQUIREMENT_GROUP_LABELS.performance}要求`, width: 42, value: (c) => requirements(c, "performance") },
  { header: `${REQUIREMENT_GROUP_LABELS.personnel}要求`, width: 32, value: (c) => requirements(c, "personnel") },
  { header: "匹配度", width: 26, value: (c, _k, on) => matchText(c, on) },
  { header: "原公告", width: 8, value: (c) => (c.noticeUrl ? { text: "打开", link: c.noticeUrl } : "") },
];

/** companyOn：有我司资质可比（没有时匹配度一列写“没有我司资质”）。 */
export function opportunitiesXlsx(rows: Row[], companyOn: boolean): Buffer {
  const sheet: Sheet = {
    name: "盲投信息表",
    columns: COLUMNS.map((c) => ({ header: c.header, width: c.width })),
    rows: rows.map((r, k) => COLUMNS.map((c) => c.value(r, k, companyOn))),
  };
  return xlsx(sheet);
}

/** 下载的文件名：按信息表导出的带上日期和早晚。 */
export function exportFilename(sheetKey: string | undefined): string {
  const m = /:sheet:(\d{4}-\d{2}-\d{2}):(am|pm)$/.exec(sheetKey ?? "");
  return m ? `盲投信息表-${m[1]}-${m[2] === "am" ? "早间" : "晚间"}.xlsx` : "投标商机.xlsx";
}
