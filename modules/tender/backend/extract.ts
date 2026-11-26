// 标讯要素：从招采公告的原文里认出公告阶段、投标截止、报名截止、金额（预算、最高限价或中标金额）、采购人、代理机构、
// 中标人、项目编号和地区。字段词表借鉴开源项目「招投标大师」（github.com/Lappercn/tender-master，MIT）的
// crawl/extract.py，按本站真实采集到的正文重写：只认带标签、紧挨着值的写法，认不准就不给，不猜；
// 每项都带原文里的那一小段，页面上可以核对。
// 纯函数：不联网、不调模型、不读库。规则改了就把 EXTRACTOR_VERSION 加一，定时任务会把已有的公告重新认一遍。

import type { Moment, Quoted, TenderFacts, TenderStage } from "../types.ts";

export type { Moment, Quoted, TenderFacts, TenderStage };

export const EXTRACTOR_VERSION = 2;

export interface TenderInput {
  /** 原文标题（不是改写后的标题）。 */
  title: string;
  /** 正文；没取到正文时传列表摘录。 */
  text: string | null;
  sourceName: string;
  /** 公开层的标签：“项目前期”“申报通知”帮着定阶段。 */
  tags?: readonly string[];
  publishedAt?: Date | null;
}

// ── 文本规整 ────────────────────────────────────────────────────────────────────────────

/** 全角空格和各种空白并成一个空格；“釆”是网页上常见的“采”字误写。 */
export function normalize(s: string): string {
  return s.replace(/釆/g, "采").replace(/[\s　 ]+/g, " ").trim();
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** 网页常把一个词拆进几个标签，正文里字和字之间会多出一个空格：“采购 人”“名 称”。 */
const spaced = (word: string) => [...word].map(escape).join("\\s?");
const anyOf = (words: readonly string[]) => `(?:${words.map(spaced).join("|")})`;

// ── 日期 ────────────────────────────────────────────────────────────────────────────────

// 数字之间也可能夹一个空格：“202 6 年 1 2 月 1 7 日”“09 时00分”。
const N2 = "\\d(?:\\s?\\d)?";
const YEAR = "2\\s?0\\s?\\d\\s?\\d";
// 时刻整段认下来再解析（clock）：“09:30”“10:30:45”“9时30分”“10时整”“17时30”。“时”后面隔着空格的数字只有带“分”才算
// 分钟：“17时 4.2 文件获取”“17时 4 文件获取”里的 4 是条款编号。
const TIME = `(${N2}\\s*[:：]\\s*\\d\\s?\\d(?!\\d)(?:\\s*[:：]\\s*\\d\\s?\\d(?!\\d))?|${N2}\\s*[时点](?:\\s*${N2}\\s*分(?:\\s*${N2}\\s*秒)?|\\s*整|\\s*半|\\d\\d(?!\\d))?)`;
const DATE = `(${YEAR})\\s*(?:年|-|/|\\.)\\s*(${N2})\\s*(?:月|-|/|\\.)\\s*(${N2})(?!\\d)\\s*日?`
  + "(?:\\s*[（(](?:星期|周)[^）)]{1,3}[）)])?"
  + "(?:\\s*(上午|下午|中午|晚上))?"
  + `(?:\\s*${TIME})?`;
/** DATE 的捕获组：年、月、日、上下午、时刻。日期总是一个匹配的最后这几组。 */
const DATE_GROUPS = 5;
const digits = (s: string | undefined) => (s ?? "").replace(/\s/g, "");

/** “09:30”“10时整”“下午2:30”换成时、分、秒；不成立的时刻给 null，没写时刻给 undefined。 */
function clock(token: string | undefined, half: string | undefined): { h: number; m: number; s: number } | null | undefined {
  if (!token) return undefined;
  const t = digits(token);
  const colon = /^(\d{1,2})[:：](\d{2})(?:[:：](\d{2}))?$/.exec(t);
  const word = colon ? null : /^(\d{1,2})[时点](?:(\d{1,2})分(?:(\d{1,2})秒)?|(整)|(半)|(\d{2}))?$/.exec(t);
  let h: number, m: number, s: number;
  if (colon) [h, m, s] = [Number(colon[1]), Number(colon[2]), Number(colon[3] ?? 0)];
  else if (word) [h, m, s] = [Number(word[1]), word[5] ? 30 : Number(word[2] ?? word[6] ?? 0), Number(word[3] ?? 0)];
  else return null;
  if ((half === "下午" || half === "晚上") && h < 12) h += 12;
  // 中午 1 点是 13 点，中午 12 点还是 12 点。
  if (half === "中午" && h < 11) h += 12;
  // 24:00 是当天结束；24:30 之类不成立。
  if (h === 24 && m === 0 && s === 0) return { h, m, s };
  return h > 23 || m > 59 || s > 59 ? null : { h, m, s };
}

/** 一个日期匹配换成北京时间的时刻；不成立的日期或时刻给 null。 */
function moment(m: RegExpExecArray, at = 1): { iso: string; day: boolean; ms: number } | null {
  const y = Number(digits(m[at])), mo = Number(digits(m[at + 1])), d = Number(digits(m[at + 2]));
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const c = clock(m[at + 4], m[at + 3]);
  if (c === null) return null;
  const day = c === undefined;
  const ms = !c || c.h === 24 ? Date.UTC(y, mo - 1, d, 23 - 8, 59, 59) : Date.UTC(y, mo - 1, d, c.h - 8, c.m, c.s);
  const check = new Date(ms + 8 * 3600_000);
  if (check.getUTCDate() !== d) return null; // 2 月 30 日之类
  return { iso: new Date(ms).toISOString(), day, ms };
}

/** 截止时间要落在公告发布前后合理的范围里，否则多半认错了别的日期（业绩年限、工期）。 */
function plausible(ms: number, publishedAt: Date | null | undefined): boolean {
  if (publishedAt) return ms >= publishedAt.getTime() - 3 * 86_400_000 && ms <= publishedAt.getTime() + 400 * 86_400_000;
  const year = new Date(ms).getUTCFullYear();
  return year >= 2020 && year <= 2040;
}

/** 原文片段：从标签开始，到认出的值为止（不往后多带字，免得带出紧跟着的联系人），最长 90 字。 */
function quoteOf(text: string, start: number, end: number): string {
  const s = text.slice(start, Math.max(end, start)).trim();
  return s.length > 90 ? `${s.slice(0, 89)}…` : s;
}

// 投标文件递交截止的几种标准写法；“澄清、质疑、踏勘、保证金、获取文件”的截止不算。
const BID_LABEL = new RegExp(
  [
    `${anyOf(["投标", "响应", "报价", "申请", "竞价", "应答", "磋商响应"])}${spaced("文件")}(?:\\s?的)?\\s?${anyOf(["递交", "提交", "上传", "接收"])}(?:\\s?的)?\\s?${anyOf(["截止时间", "截止日期", "截至时间"])}`,
    `${anyOf(["递交", "提交", "上传"])}\\s?${anyOf(["投标", "响应", "报价", "申请", "竞价"])}${spaced("文件")}(?:\\s?的)?\\s?${anyOf(["截止时间", "截止日期", "截至时间"])}`,
    anyOf(["投标截止时间", "投标截止日期", "响应截止时间", "报价截止时间", "竞价截止时间", "递交截止时间", "提交截止时间", "截标时间"]),
  ].join("|"),
  "g",
);
const OPENING_LABEL = new RegExp(anyOf(["开标时间", "开启时间", "开标日期"]), "g");
const NOT_BID = /澄清|异议|质疑|答疑|踏勘|保证金|获取|购买|发售|下载|报名/;
// 政府采购公告概况里的写法：“并于 2026年12月03日 10:00（北京时间）前递交投标文件”。
const BID_AFTER = new RegExp(`于\\s*${DATE}\\s*(?:[（(]北京时间[）)])?\\s*(?:前|之前|以前)\\s*(?:将\\s*)?${anyOf(["递交", "提交", "上传"])}?\\s*${anyOf(["投标", "响应", "报价", "申请", "竞价"])}${spaced("文件")}`, "g");
// 申报通知的截止：“申报截止时间”“请于 2026年12月10日前报送”。
const CALL_LABEL = new RegExp(anyOf(["申报截止时间", "申报截止日期", "报送截止时间", "报送截止日期", "征集截止时间", "征集截止日期", "申报时间截止", "截止日期"]), "g");
const CALL_AFTER = new RegExp(`于\\s*${DATE}\\s*(?:[（(]北京时间[）)])?\\s*(?:前|之前|以前)\\s*(?:将[^。；;]{0,20}?)?${anyOf(["报送", "提交", "申报", "报至", "上报", "寄送", "发送"])}`, "g");
// 报名、获取招标文件的截止：“获取采购文件 时间：A 至 B”“招标文件购买截止时间 B”“报名截止时间 B”。
const SIGNUP_LABEL = new RegExp(
  [
    `${anyOf(["获取", "领取", "下载", "购买"])}\\s?${anyOf(["招标", "采购", "比选", "谈判", "磋商", "询价", "资格预审", "竞争性谈判", "竞争性磋商", "询比"])}?\\s?${spaced("文件")}`,
    `${anyOf(["招标", "采购", "比选", "谈判", "磋商", "询价", "资格预审"])}?\\s?${spaced("文件")}\\s?${anyOf(["获取", "发售", "购买", "领取", "下载"])}`,
    anyOf(["文件获取", "报名截止时间", "报名截止日期", "报名时间"]),
  ].join("|"),
  "g",
);
// 更正：“延期至 / 变更为 / 现为 新日期”，可以隔着分号接在旧日期后面（“原截止时间：A；现变更为 B”）。
const CHANGED_TO = new RegExp(`^[^。]{0,40}?(?:延期|延长|推迟|顺延|变更|调整|更改|改|现)\\s*(?:至|为|到)\\s*${DATE}`);
// 标签和日期之间隔着别的字段（“详见附件，开标时间：…”），这个日期就不是这个标签的。
const OTHER_FIELD = /详见|见附件|[，,；;]\s*(?:开标|开启|获取|报名|澄清|答疑|踏勘|递交|提交|公示|发布)/;
const RANGE_END = new RegExp(`^[^。；;]{0,24}?${DATE}[^。；;\\d]{0,12}?(?:至|到|—|–|~|～|-)\\s*${DATE}`);

/** 标签后面紧跟的第一个日期（同一句里，40 字以内，中间不隔别的字段）；后面写了“延期至 / 变更为 新日期”的取新日期。 */
function dateAfter(text: string, labelEnd: number): RegExpExecArray | null {
  const window = text.slice(labelEnd, labelEnd + 140);
  const m = new RegExp(`^([^。；;]{0,40}?)${DATE}`).exec(window);
  if (!m || OTHER_FIELD.test(m[1]!)) return null;
  const changed = CHANGED_TO.exec(window.slice(m[0].length));
  if (changed) {
    changed.index = labelEnd + m[0].length;
    return changed;
  }
  m.index = labelEnd;
  return m;
}

function firstMoment(text: string, labels: RegExp, label: (raw: string) => string, publishedAt: Date | null | undefined, skip?: RegExp): Moment | null {
  for (const l of text.matchAll(labels)) {
    const before = text.slice(Math.max(0, l.index! - 8), l.index! + l[0].length);
    if (skip?.test(before)) continue;
    const m = dateAfter(text, l.index! + l[0].length);
    if (!m) continue;
    const t = moment(m, m.length - DATE_GROUPS);
    if (!t || !plausible(t.ms, publishedAt)) continue;
    return { value: t.iso, day: t.day, label: label(l[0]), quote: quoteOf(text, l.index!, m.index + m[0].length) };
  }
  return null;
}

function reversedMoment(text: string, re: RegExp, label: string, publishedAt: Date | null | undefined): Moment | null {
  for (const m of text.matchAll(re)) {
    const t = moment(m as RegExpExecArray);
    if (!t || !plausible(t.ms, publishedAt)) continue;
    return { value: t.iso, day: t.day, label, quote: quoteOf(text, m.index!, m.index! + m[0].length) };
  }
  return null;
}

const bidLabel = (raw: string) => {
  const s = raw.replace(/\s/g, "");
  return /响应/.test(s) ? "响应截止" : /报价/.test(s) ? "报价截止" : /申请/.test(s) ? "申请截止" : /竞价/.test(s) ? "竞价截止" : "投标截止";
};

function bidDeadline(text: string, publishedAt: Date | null | undefined): Moment | null {
  return firstMoment(text, BID_LABEL, bidLabel, publishedAt, NOT_BID)
    ?? reversedMoment(text, BID_AFTER, "投标截止", publishedAt)
    ?? firstMoment(text, OPENING_LABEL, () => "开标", publishedAt);
}

function callDeadline(text: string, publishedAt: Date | null | undefined): Moment | null {
  return firstMoment(text, CALL_LABEL, () => "申报截止", publishedAt) ?? reversedMoment(text, CALL_AFTER, "申报截止", publishedAt);
}

function signupDeadline(text: string, publishedAt: Date | null | undefined): Moment | null {
  for (const l of text.matchAll(SIGNUP_LABEL)) {
    const end = l.index! + l[0].length;
    const window = text.slice(end, end + 90);
    const range = RANGE_END.exec(window);
    let m: RegExpExecArray | null = null;
    if (range) m = range;
    else if (/截止/.test(l[0]) || /^[^。；;]{0,6}截止/.test(window)) m = dateAfter(text, end);
    if (!m) continue;
    // 范围取后一个日期（日期总是匹配的最后几组）。
    const t = moment(m, m.length - DATE_GROUPS);
    if (!t || !plausible(t.ms, publishedAt)) continue;
    const quoteEnd = range ? end + range[0].length : m.index + m[0].length;
    return { value: t.iso, day: t.day, label: /报名/.test(l[0]) ? "报名截止" : "获取文件截止", quote: quoteOf(text, l.index!, quoteEnd) };
  }
  return null;
}

// ── 金额 ────────────────────────────────────────────────────────────────────────────────

const NUMBER = "(\\d{1,3}(?:[,，]\\d{3})+(?:\\.\\d+)?|\\d+(?:\\.\\d+)?)";
const UNIT = "(亿元|万元|元|万)";
// 数字到此为止，并且是一个人民币金额：后面不再连着数字或小数（“1 200”“123.45%”不能只认前半截），也不是百分比、
// 数量、区间（“120-150万元”）或外币（“100万美元”）。
const NUMBER_END = "(?![\\d.,，])(?!\\s\\d)"
  + "(?!\\s*(?:[万亿]\\s*)?(?:美元|美金|欧元|日元|港元|港币|英镑|USD|EUR)|\\s*[%％年个天月日台套件次份项]|\\s*[-~～—至到]\\s*\\d)";
// 标签后面紧跟金额：中间只能有单位括号、冒号、“为”和“人民币”“¥”。表头（“预计采购金额（万元） 最高投标限价…”）不算。
const amountAfter = (label: string) => new RegExp(
  `(${label})\\s*(?:[（(]\\s*${UNIT}\\s*[)）])?\\s*(?:[:：]|为|是|\\s)\\s*(?:人民币|RMB)?\\s*[¥￥]?\\s*${NUMBER}${NUMBER_END}\\s*${UNIT}?`,
  "g",
);
const BUDGET = amountAfter(`${anyOf(["项目", "采购", "招标"])}?${spaced("预算")}${anyOf(["金额", "总金额", "总额", "价", "资金"])}?`);
const CEILING = amountAfter(anyOf(["最高投标限价", "最高报价限价", "最高限价", "投标限价", "招标控制价", "采购控制价", "控制价", "拦标价"]));
const ESTIMATE = amountAfter(anyOf(["合同估算价", "估算价", "估算金额", "项目概算", "概算金额", "预计采购金额", "预估金额"]));
const AWARDED = amountAfter(anyOf(["中标（成交）金额", "中标(成交)金额", "中标金额", "中标价格", "中标价", "中标总价", "成交金额", "成交价格", "成交价", "中选金额", "中选价格", "投标总报价", "投标报价"]));

function yuan(n: string, unit: string | undefined): number | null {
  const v = Number(n.replace(/[,，]/g, ""));
  if (!Number.isFinite(v) || !unit) return null;
  const out = unit === "亿元" ? v * 1e8 : unit.startsWith("万") ? v * 1e4 : v;
  return out >= 100 && out <= 5e10 ? Math.round(out * 100) / 100 : null;
}

function amountBy(text: string, re: RegExp, label: (raw: string) => string): Quoted<number> | null {
  for (const m of text.matchAll(re)) {
    // m[1] 标签，m[2] 标签里的单位，m[3] 数字，m[4] 数字后的单位
    const v = yuan(m[3]!, m[4] ?? m[2]);
    if (v === null) continue;
    return { value: v, label: label(m[1]!), quote: quoteOf(text, m.index!, m.index! + m[0].length) };
  }
  return null;
}

function amountOf(text: string, stage: TenderStage | null): Quoted<number> | null {
  if (stage === "award" || stage === "candidate") {
    return amountBy(text, AWARDED, (raw) => (/成交/.test(raw) ? "成交金额" : /报价/.test(raw) ? "投标报价" : "中标金额"))
      ?? candidateAmount(text);
  }
  if (stage === "ended" || stage === "early" || stage === "call") return null;
  return amountBy(text, BUDGET, () => "预算") ?? amountBy(text, CEILING, () => "最高限价") ?? amountBy(text, ESTIMATE, () => "估算");
}

// ── 单位名称 ──────────────────────────────────────────────────────────────────────────────

const ORG = "([^\\s，,；;。：:、“”\"]{3,48})";
const ORG_END = /(?:公司|集团|局|院|所|中心|委员会|委|政府|办公室|办|大学|学院|学校|医院|厂|站|部|处|队|社|行|会|厅|馆|场|室|段|矿|园|基地)(?:[（(][^）)]{1,12}[）)])?$/;
const NOT_ORG = /详见|见附件|联系|电话|地址|名称|公告|采购人|代理机构|姓名|负责人/;

function org(raw: string | undefined): string | null {
  if (!raw) return null;
  const s = raw.replace(/[（(](?:盖章|公章|签章)[）)]$/, "").trim();
  return s.length >= 4 && ORG_END.test(s) && !NOT_ORG.test(s) ? s : null;
}

/** “采购人：X”“招标人为 X”“采购人信息 名称：X”，以及概况表里不带冒号的“采购单位 X”。 */
function orgBy(text: string, labels: readonly string[], bare: readonly string[] = []): string | null {
  const label = anyOf(labels);
  const forms = [
    new RegExp(`${label}(?:\\s?名\\s?称)?\\s*(?:[:：]|为|是)\\s*${ORG}`, "g"),
    new RegExp(`${label}\\s?信\\s?息\\s*名\\s?称\\s*[:：]\\s*${ORG}`, "g"),
    ...(bare.length ? [new RegExp(`${anyOf(bare)}\\s+${ORG}`, "g")] : []),
  ];
  for (const re of forms) {
    for (const m of text.matchAll(re)) {
      const found = org(m[1]);
      if (found) return found;
    }
  }
  return null;
}

// “X 受 Y（的）委托”：招标代理机构 X 替采购人 Y 发的公告，两个都认出来。
// 委托方取最短的一段，“的委托”里的“的”不算进名称。
const DELEGATED = new RegExp(`${ORG}\\s*受\\s*([^\\s，,；;。：:、“”"]{3,48}?)\\s*(?:的)?\\s*委托`);

function delegation(text: string): { agent: string | null; purchaser: string | null } {
  const m = DELEGATED.exec(text);
  return { agent: org(m?.[1]), purchaser: org(m?.[2]) };
}

const PURCHASER = ["采购人", "招标人", "采购单位", "招标单位", "建设单位", "项目业主", "业主单位", "发包人", "采购方"];
const AGENT = ["采购代理机构", "招标代理机构", "代理机构", "招标代理", "采购代理", "采购机构"];
const WINNER = ["中标人", "中标单位", "中标供应商", "成交供应商", "成交人", "成交单位", "中选人", "中选单位", "第一中标候选人", "第一成交候选人", "第一候选人", "联合体牵头人"];

const CANDIDATE = new RegExp(`${anyOf(["第一中标候选人", "第一成交候选人", "第一候选人"])}\\s*(?:[:：]|为)?\\s*${ORG}\\s*(?:${anyOf(["投标报价", "报价"])}\\s*[:：]?\\s*)?[¥￥]?\\s*${NUMBER}${NUMBER_END}\\s*${UNIT}`);

const CCGP_RESULT = new RegExp(`${spaced("供应商名称")}\\s+${spaced("供应商地址")}\\s+${anyOf(["中标（成交）金额", "中标(成交)金额", "中标金额", "成交金额"])}(?:\\s+${spaced("评审价格")})?\\s+${ORG}\\s+\\S{2,60}?\\s+[¥￥]?\\s*${NUMBER}${NUMBER_END}\\s*${UNIT}`);

/** 政府采购网结果公告里只有一个采购包时的供应商表；多个包各有中标人，只报一个会误导，就不报。 */
function ccgpResult(text: string): { winner: string; amount: Quoted<number> } | null {
  if (/采购包\s?2|包\s?2\s?[:：]/.test(text)) return null;
  const m = CCGP_RESULT.exec(text);
  const winner = org(m?.[1]);
  const v = m ? yuan(m[2]!, m[3]) : null;
  return winner && v !== null ? { winner, amount: { value: v, label: "中标金额", quote: quoteOf(text, m!.index, m!.index + m![0].length) } } : null;
}

function candidateAmount(text: string): Quoted<number> | null {
  const m = CANDIDATE.exec(text);
  if (!m || !org(m[1])) return null;
  const v = yuan(m[2]!, m[3]);
  return v === null ? null : { value: v, label: "投标报价", quote: quoteOf(text, m.index, m.index + m[0].length) };
}

// ── 项目编号 ──────────────────────────────────────────────────────────────────────────────

const PROJECT_NO = new RegExp(`${anyOf(["招标项目编号", "采购项目编号", "项目招标编号", "项目编号", "招标编号", "采购编号", "项目代码", "标段编号"])}\\s*(?:为)?\\s*[:：]?\\s*([A-Za-z0-9][A-Za-z0-9\\-_/.]{4,48})`);

function projectNoOf(text: string, title: string): string | null {
  const m = PROJECT_NO.exec(text) ?? PROJECT_NO.exec(title);
  const v = m?.[1]?.replace(/[.\-_/]+$/, "");
  return v && /\d/.test(v) && v.length >= 6 ? v : null;
}

// ── 地区 ────────────────────────────────────────────────────────────────────────────────

/**
 * 省级地区和用来认它的词（省名、省会和主要城市；本站重点省份皖甘宁滇的地级市都列上）。和常用词撞车的地名
 * 带上“市”“州”再认（大理石、白银、黄山、来宾、日照、中山路）。
 */
const REGIONS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["安徽", ["安徽", "皖", "合肥", "芜湖", "蚌埠", "淮南", "马鞍山", "淮北", "铜陵", "安庆", "黄山市", "滁州", "阜阳", "宿州", "六安", "亳州", "池州", "宣城"]],
  ["甘肃", ["甘肃", "兰州", "嘉峪关", "金昌", "白银市", "天水", "武威", "张掖", "平凉", "酒泉", "庆阳", "定西", "陇南", "临夏", "甘南"]],
  ["宁夏", ["宁夏", "银川", "石嘴山", "吴忠", "固原", "中卫"]],
  ["云南", ["云南", "滇", "昆明", "曲靖", "玉溪", "保山市", "昭通", "丽江", "普洱", "临沧", "楚雄", "红河州", "文山州", "文山市", "西双版纳", "大理州", "大理市", "大理白族", "德宏", "怒江", "迪庆"]],
  ["北京", ["北京"]], ["天津", ["天津"]], ["上海", ["上海"]], ["重庆", ["重庆"]],
  ["内蒙古", ["内蒙古", "呼和浩特", "包头", "鄂尔多斯", "赤峰", "通辽", "呼伦贝尔", "巴彦淖尔", "乌兰察布", "锡林郭勒", "阿拉善"]],
  ["新疆", ["新疆", "乌鲁木齐", "克拉玛依", "吐鲁番", "哈密", "昌吉", "伊犁", "阿克苏", "喀什", "和田", "巴州", "巴音郭楞", "塔城", "阿勒泰"]],
  ["西藏", ["西藏", "拉萨", "日喀则", "林芝"]],
  ["青海", ["青海", "西宁", "海东", "格尔木", "海西州"]],
  ["陕西", ["陕西", "西安", "宝鸡", "咸阳", "渭南", "延安", "榆林", "汉中", "安康市", "商洛", "铜川"]],
  ["山西", ["山西", "太原", "大同", "朔州", "忻州", "阳泉", "吕梁", "晋中", "长治市", "晋城", "临汾", "运城"]],
  ["河北", ["河北", "石家庄", "唐山", "秦皇岛", "邯郸", "邢台", "保定", "张家口", "承德", "沧州", "廊坊", "衡水", "雄安"]],
  ["山东", ["山东", "济南", "青岛", "淄博", "枣庄", "东营", "烟台", "潍坊", "济宁", "泰安", "威海", "日照市", "临沂", "德州", "聊城", "滨州", "菏泽"]],
  ["河南", ["河南", "郑州", "开封", "洛阳", "平顶山", "安阳", "鹤壁", "新乡", "焦作", "濮阳", "许昌", "漯河", "三门峡", "南阳", "商丘", "信阳", "周口", "驻马店"]],
  ["江苏", ["江苏", "南京", "无锡", "徐州", "常州", "苏州", "南通", "连云港", "淮安", "盐城", "扬州", "镇江", "泰州", "宿迁"]],
  ["浙江", ["浙江", "杭州", "宁波", "温州", "嘉兴", "湖州", "绍兴", "金华", "衢州", "舟山", "台州", "丽水"]],
  ["福建", ["福建", "福州", "厦门", "莆田", "三明", "泉州", "漳州", "南平", "龙岩", "宁德"]],
  ["江西", ["江西", "南昌", "景德镇", "萍乡", "九江", "新余", "鹰潭", "赣州", "吉安", "宜春", "抚州", "上饶"]],
  ["湖北", ["湖北", "武汉", "黄石", "十堰", "宜昌", "襄阳", "鄂州", "荆门", "孝感", "荆州", "黄冈", "咸宁", "随州", "恩施"]],
  ["湖南", ["湖南", "长沙", "株洲", "湘潭", "衡阳", "邵阳", "岳阳", "常德", "张家界", "益阳", "郴州", "永州", "怀化", "娄底", "湘西"]],
  ["广东", ["广东", "广州", "深圳", "珠海", "汕头", "佛山", "韶关", "湛江", "肇庆", "江门", "茂名", "惠州", "梅州", "汕尾", "河源", "阳江", "清远", "东莞", "中山市", "潮州", "揭阳", "云浮"]],
  ["广西", ["广西", "南宁", "柳州", "桂林", "梧州", "北海市", "防城港", "钦州", "贵港", "玉林", "百色", "贺州", "河池", "来宾市", "崇左"]],
  ["海南", ["海南", "海口", "三亚", "儋州"]],
  ["贵州", ["贵州", "贵阳", "六盘水", "遵义", "安顺", "毕节", "铜仁", "黔"]],
  ["四川", ["四川", "成都", "自贡", "攀枝花", "泸州", "德阳", "绵阳", "广元", "遂宁", "内江", "乐山", "南充", "眉山", "宜宾", "广安", "达州", "雅安", "巴中", "资阳", "阿坝", "甘孜", "凉山"]],
  ["辽宁", ["辽宁", "沈阳", "大连", "鞍山", "抚顺", "本溪", "丹东", "锦州", "营口", "阜新", "辽阳", "盘锦", "铁岭", "朝阳市", "葫芦岛"]],
  ["吉林", ["吉林", "长春", "四平", "辽源", "通化", "白山市", "松原", "白城", "延边"]],
  ["黑龙江", ["黑龙江", "哈尔滨", "齐齐哈尔", "鸡西", "鹤岗", "双鸭山", "大庆", "伊春市", "佳木斯", "七台河", "牡丹江", "黑河市", "绥化", "大兴安岭"]],
  ["香港", ["香港"]], ["澳门", ["澳门"]],
];
/** 单字简称（皖、滇、黔）只在开头或括号里算，避免“完成”“滇池”之类以外的误认。 */
const SHORT = new Set(["皖", "滇", "黔"]);

/** 一段文字里最早出现的地区。 */
function regionIn(s: string): string | null {
  let best: { name: string; at: number } | null = null;
  for (const [name, words] of REGIONS) {
    for (const w of words) {
      const at = SHORT.has(w) ? (s.startsWith(w) ? 0 : s.search(new RegExp(`[（(【\\[]${w}`)) + 1 || -1) : s.indexOf(w);
      if (at >= 0 && (!best || at < best.at)) best = { name, at };
    }
  }
  return best?.name ?? null;
}

const REGION_LABEL = new RegExp(`${anyOf(["行政区域", "项目所在地区", "项目所在地", "所在地区", "项目地点", "建设地点"])}\\s*[:：]?\\s*([${"\\u4e00-\\u9fff"}]{2,12})`);

function regionOf(text: string, title: string, purchaser: string | null, sourceName: string): string | null {
  const labeled = REGION_LABEL.exec(text)?.[1];
  return (labeled && regionIn(labeled)) || (purchaser && regionIn(purchaser)) || regionIn(title) || regionIn(sourceName) || null;
}

// ── 阶段 ────────────────────────────────────────────────────────────────────────────────

/** 先认结果、终止和变更（它们的标题里也常有“招标”“采购”），再认招标采购，最后才是前期和申报。 */
export function stageOf(title: string, tags: readonly string[] = []): TenderStage | null {
  const t = normalize(title).replace(/\s/g, "");
  if (/终止|中止|流标|废标|采购失败|招标失败|项目取消/.test(t)) return "ended";
  if (/变更|更正|澄清|补遗|答疑|延期|修改(?:公告|通知)/.test(t)) return "change";
  if (/候选人/.test(t)) return "candidate";
  if (/中标|成交|中选|结果公[告示]|采购结果|评标结果|入围结果/.test(t)) return "award";
  if (/招标计划|采购计划|采购意向|需求公示|招标预告/.test(t)) return "plan";
  if (tags.includes("项目前期")) return "early";
  if (tags.includes("申报通知")) return "call";
  if (/招标|采购|询价|询比|比选|谈判|磋商|单一来源|资格预审|竞价|邀请/.test(t)) return "tender";
  if (/核准|批复|环评|环境影响|可行性研究|可研|选址意见|用地预审|开工/.test(t)) return "early";
  if (/申报|征集|遴选|评选|推荐.*通知|认定/.test(t)) return "call";
  return null;
}

// ── 合起来 ──────────────────────────────────────────────────────────────────────────────

export function extractTender(input: TenderInput): TenderFacts {
  const title = normalize(input.title);
  const text = normalize(input.text ?? "");
  const stage = stageOf(title, input.tags);
  const open = stage === "tender" || stage === "change" || stage === null;
  const result = stage === "award" || stage === "candidate";
  const delegated = delegation(text);
  const purchaser = orgBy(text, PURCHASER, ["采购单位", "采购人", "招标人"]) ?? delegated.purchaser;
  const table = result ? ccgpResult(text) : null;
  return {
    stage,
    deadline: stage === "call" ? callDeadline(text, input.publishedAt) : open ? bidDeadline(text, input.publishedAt) : null,
    signup: open ? signupDeadline(text, input.publishedAt) : null,
    amount: amountOf(text, stage) ?? table?.amount ?? null,
    purchaser,
    agent: orgBy(text, AGENT, ["代理机构名称"]) ?? delegated.agent,
    winner: result ? orgBy(text, WINNER, ["第一中标候选人", "第一候选人"]) ?? table?.winner ?? null : null,
    projectNo: projectNoOf(text, title),
    region: regionOf(text, title, purchaser, input.sourceName),
  };
}
