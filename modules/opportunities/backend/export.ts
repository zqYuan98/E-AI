// 盲投信息表导出成 CSV：带 BOM，Excel 直接双击打开不乱码；一行一个项目，列与推送消息的要素一致，商务按要素初审。
import { config } from "@aihot/backend/config";
import { MATCH_STATUS_LABELS, REQUIREMENT_GROUP_LABELS, VERDICT_LABELS, type OpportunityCard, type RequirementGroup } from "../types.ts";
import { formatCeiling, matchText } from "./push.ts";

// 以这些字符开头的格子 Excel 会当公式算；招采原文是外部内容，前面加一个单引号当文字。
const cell = (v: string) => {
  const t = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  return /[",\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
};

const requirementText = (c: OpportunityCard, group: RequirementGroup) => {
  const rs = c.requirements.filter((r) => r.group === group);
  if (!rs.length) return c.requirementsInDocuments ? "详见招标文件" : "未写明";
  return rs.map((r) => (r.status ? `【${MATCH_STATUS_LABELS[r.status]}${r.note ? `：${r.note}` : ""}】${r.text}` : r.text)).join("\n");
};

const columns = (companyOn: boolean): Array<[string, (c: OpportunityCard & { scope: string }, k: number) => string]> => [
  ["序号", (_c, k) => String(k + 1)],
  ["判断", (c) => VERDICT_LABELS[c.verdict]],
  ["业务方向", (c) => c.line],
  ["来源", (c) => c.sourceName],
  ["项目名称", (c) => c.projectName || c.noticeTitle],
  ["分标/包", (c) => [c.packageLabel, c.packageName].filter(Boolean).join(" · ")],
  ["采购人", (c) => c.buyer],
  ["地区", (c) => c.location],
  ["采购内容", (c) => c.scope],
  ["最高限价", (c) => formatCeiling(c.ceiling, c.ceilingKind)],
  ["公告预算", (c) => c.noticeBudget],
  ["采购文件获取截止", (c) => c.fileDeadline],
  ["投标截止", (c) => c.bidDeadline],
  ["开标时间", (c) => c.openingTime],
  [`${REQUIREMENT_GROUP_LABELS.qualification}要求`, (c) => requirementText(c, "qualification")],
  [`${REQUIREMENT_GROUP_LABELS.performance}要求`, (c) => requirementText(c, "performance")],
  [`${REQUIREMENT_GROUP_LABELS.personnel}要求`, (c) => requirementText(c, "personnel")],
  ["匹配度", (c) => matchText(c, companyOn)],
  ["详情", (c) => `${config.siteUrl}/opportunities/${encodeURIComponent(c.noticeId)}#item-${c.id}`],
  ["原公告", (c) => c.noticeUrl],
];

/** companyOn：后台填了我司资质（没填时匹配度一列写“未填我司资质”）。 */
export function opportunitiesCsv(rows: Array<OpportunityCard & { scope: string }>, companyOn: boolean): string {
  const cols = columns(companyOn);
  const lines = [cols.map(([h]) => h), ...rows.map((r, k) => cols.map(([, f]) => f(r, k)))];
  return `\uFEFF${lines.map((l) => l.map(cell).join(",")).join("\r\n")}\r\n`;
}
