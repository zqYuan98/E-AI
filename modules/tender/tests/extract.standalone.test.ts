// 标讯要素抽取：用各平台真实公告的写法（节选，去掉了联系人姓名和电话）核对每一项，也核对那些容易认错的地方。
import assert from "node:assert/strict";
import { test } from "node:test";
import { extractTender, stageOf, type Moment } from "../backend/extract.ts";

const PUBLISHED = new Date("2026-11-20T02:00:00Z");
/** 北京时间的“年-月-日 时:分”。 */
const bj = (m: Moment | null) => m && new Date(new Date(m.value).getTime() + 8 * 3600_000).toISOString().slice(0, 16).replace("T", " ");
const run = (title: string, text: string, sourceName = "中国政府采购网", tags: string[] = []) =>
  extractTender({ title, text, sourceName, tags, publishedAt: PUBLISHED });

test("政府采购询价公告：概况里的“于…前提交响应文件”、响应截止、获取文件区间、预算、采购人和代理机构", () => {
  const f = run("四川省自贡市消防救援支队设备（布控球、单兵图传）采购项目询价公告", `项目概况 采购项目的潜在供应商应在四川省自贡市沿滩区获取采购文件，并于2026年11月26日 10点00分（北京时间）前提交响应文件。
    一、项目基本情况 项目编号：SCDHFZC-2026199 项目名称：四川省自贡市消防救援支队设备采购项目 采购方式：询价 预算金额：44.600000 万元（人民币） 最高限价（如有）：44.600000 万元（人民币）
    三、获取采购文件 时间：2026年11月20日 至 2026年11月24日，每天上午9:00至12:00，下午14:30至17:00。（北京时间，法定节假日除外）
    四、响应文件提交 截止时间：2026年11月26日 10点00分（北京时间） 五、开启 时间：2026年11月26日 10点00分（北京时间）
    八、凡对本次采购提出询问，请按以下方式联系。 1.采购人信息 名 称：自贡市消防救援支队 地址：四川省自贡市自流井区 2.采购代理机构信息 名 称：四川德海工程项目管理咨询有限公司 地 址：四川省自贡市沿滩区`);
  assert.equal(f.stage, "tender");
  assert.equal(bj(f.deadline), "2026-11-26 10:00");
  assert.equal(f.deadline!.label, "响应截止");
  assert.match(f.deadline!.quote, /响应文件提交 截止时间：2026年11月26日 10点00分/);
  assert.equal(bj(f.signup), "2026-11-24 23:59");
  assert.equal(f.signup!.day, true, "只写了日期：按当天结束算");
  assert.deepEqual([f.amount?.value, f.amount?.label], [446000, "预算"]);
  assert.equal(f.purchaser, "自贡市消防救援支队");
  assert.equal(f.agent, "四川德海工程项目管理咨询有限公司");
  assert.equal(f.projectNo, "SCDHFZC-2026199");
  assert.equal(f.region, "四川");
});

test("竞争性磋商：概况表里不带冒号的“采购单位 X”、行政区域、¥ 万元预算；两个包的最高限价不当成一个数", () => {
  const f = run("晋中经济技术开发区智慧工地管理系统维护服务竞争性磋商公告", `公告信息： 采购项目名称 智慧工地管理系统维护及等级保护测评服务 品目 采购单位 晋中经济技术开发区管理委员会园区建设管理部 行政区域 山西省 公告时间 2026年11月24日 10:41
    获取采购文件时间 2026年11月24日至2026年12月01日 每日上午:00:00 至 00至12:00:00 预算金额 ￥111.000000万元（人民币）
    一、项目基本情况 项目编号：1407912026CCS00012 预算金额（元）：1110000 最高限价（元）：810000,300000
    四、响应文件提交 截止时间：2026年12月07日 09:00（北京时间）`);
  assert.equal(f.purchaser, "晋中经济技术开发区管理委员会园区建设管理部");
  assert.equal(f.region, "山西");
  assert.equal(f.amount?.value, 1110000);
  assert.equal(bj(f.deadline), "2026-12-07 09:00");
  assert.equal(bj(f.signup), "2026-12-01 23:59");
  assert.equal(f.projectNo, "1407912026CCS00012");
});

test("国能e招：“递交的截止时间（投标截止时间，下同）及开标时间为”、购买文件截止、“招标人为”", () => {
  const f = run("新疆电力花园电厂安全设施及锅炉房大门改造工程公开招标项目招标公告", `新疆电力花园电厂安全设施及锅炉房大门改造工程公开招标，项目招标编号为：CEZB260409782，招标人为国网能源哈密煤电有限公司，项目单位为：国网能源哈密煤电有限公司花园电厂分公司，资金来源为自筹。
    【3】业绩要求：2021年12月至投标截止日（以合同签订时间为准），投标人须至少具有合同业绩2份。
    4.3 招标文件购买开始时间2026-11-27 09:00:00，招标文件购买截止时间2026-12-03 18:00:00。 4.4 招标文件每套售价人民币70元
    6.1 投标文件递交的截止时间（投标截止时间，下同）及开标时间为2026-12-18 09:00:00（北京时间），投标人应在投标截止时间前通过平台递交。`, "国能e招·招标公告");
  assert.equal(bj(f.deadline), "2026-12-18 09:00");
  assert.equal(f.deadline!.label, "投标截止");
  assert.equal(bj(f.signup), "2026-12-03 18:00");
  assert.equal(f.purchaser, "国网能源哈密煤电有限公司");
  assert.equal(f.projectNo, "CEZB260409782");
  assert.equal(f.region, "新疆");
  assert.equal(f.amount, null, "售价 70 元不是预算");
});

test("南网：数字被拆开的日期照样认；“要求澄清招标文件截止时间”不是投标截止；表头里的金额不认", () => {
  const f = run("南方电网数字电网集团（广东）有限公司地区网络修理维护技术服务框架公开招标采购招标公告", `标包名称 预计采购金额（万元） 最高投标限价（万元） 最大中标数量 工期/服务期 1 地区机房网络资产修理维护 标包1 230 230
    4.3 投标人要求澄清招标文件截止 时间： 2026年12月08日09时00分00秒 5. 投标文件的递交 5.2投标文件递交截止时间 ： 2026年12月1 8 日09时00分00秒 6. 开标时间及地点 本项目通过南方电网供应链统一服务平台线上方式开标。 6.1开标时间： 2026年12月18日09时00分00秒
    3.联系方式 招 标 人： 南方电网数字电网集团（广东）有限公司 地 址： 广东省广州市 招标代理机构： 南方电网供应链（广东）有限公司`, "南方电网供应链·招标公告");
  assert.equal(bj(f.deadline), "2026-12-18 09:00");
  assert.match(f.deadline!.quote, /投标文件递交截止时间/);
  assert.equal(f.amount, null);
  assert.equal(f.purchaser, "南方电网数字电网集团（广东）有限公司");
  assert.equal(f.agent, "南方电网供应链（广东）有限公司");
  assert.equal(f.region, "广东");
});

test("三峡：文件获取区间的结束时刻后面紧跟条款编号（“17时 4.2”），不当成 17:04；项目所在地区", () => {
  const f = run("三峡枢纽安防指挥系统自主可控改造一期招标公告", `第一章 招标公告 （招标编号： T261100131450 ） 项目所在地区： 湖北省宜昌市 一、招标条件
    四、招标文件的获取 4.1 文件获取时间：2026年11月27日9时至2026年12月2日17时 4.2 文件获取费用：招标文件仅提供电子版，售价人民币 500元
    六、投标文件的递交 6.1 递交截止时间： 202 6 年 12 月 1 7 日 10时00分 （即投标截止时间及开标时间，下同）。
    十、联系方式 招标人：中国长江三峡集团有限公司 地址：湖北省宜昌市夷陵区`, "三峡集团电子采购平台·招标公告");
  assert.equal(bj(f.signup), "2026-12-02 17:00");
  assert.equal(f.signup!.day, false);
  assert.equal(bj(f.deadline), "2026-12-17 10:00");
  assert.equal(f.projectNo, "T261100131450");
  assert.equal(f.purchaser, "中国长江三峡集团有限公司");
  assert.equal(f.region, "湖北");
});

test("变更公告：截止时间延期时取新的时间", () => {
  const f = run("云南省昆明市官渡区虚拟电厂项目（一期）EPC工程总承包变更公告", `原投标截止时间为2026年12月10日9时30分，现延期至2026年12月20日9时30分，开标时间相应顺延。招标人：昆明市官渡区城市建设投资有限公司`, "云南公共资源交易·电力招标公告");
  assert.equal(f.stage, "change");
  assert.equal(bj(f.deadline), "2026-12-20 09:30");
  assert.equal(f.region, "云南");
});

test("结果公告：中标人与中标金额；政府采购网的单一供应商结果表；代理机构“受…委托”认出采购人", () => {
  const award = run("银川市兴庆区城中村改造项目（二期）电力改迁设计中标结果公示", `宁夏智信晟隆工程咨询有限责任公司 受 宁夏房地产开发集团有限公司 的委托 ，对 该项目进行公开招标。 二 、中标结果： 中标人名称：宁夏泓钰工程设计有限公司 中标金额： 1118295.50元（壹佰壹拾壹万捌仟贰佰玖拾伍元伍角整）`, "宁夏公共资源交易·检索「电力」");
  assert.equal(award.stage, "award");
  assert.equal(award.winner, "宁夏泓钰工程设计有限公司");
  assert.deepEqual([award.amount?.value, award.amount?.label], [1118295.5, "中标金额"]);
  assert.equal(award.purchaser, "宁夏房地产开发集团有限公司");
  assert.equal(award.agent, "宁夏智信晟隆工程咨询有限责任公司");
  assert.equal(award.deadline, null, "结果公告没有投标截止");

  const ccgp = run("淄博市智慧工地监管平台服务项目成交结果公告", `采购包1: 供应商名称 供应商地址 中标（成交）金额 评审价格 淄博万通房产信息有限公司 山东省淄博市张店区人民路188号 978,000.00元 淄博市智慧工地监管平台服务项目（总价）：978000元 1.采购单位信息 名称： 淄博市建筑工程质量安全环保监督站`);
  assert.equal(ccgp.winner, "淄博万通房产信息有限公司");
  assert.equal(ccgp.amount?.value, 978000);
  assert.equal(ccgp.purchaser, "淄博市建筑工程质量安全环保监督站");

  const twoPacks = run("某项目成交结果公告", `采购包1: 供应商名称 供应商地址 中标（成交）金额 评审价格 甲公司 地址一 100,000.00元 采购包2: 供应商名称 供应商地址 中标（成交）金额 评审价格 乙公司 地址二 200,000.00元`);
  assert.equal(twoPacks.winner, null, "两个包各有中标人，只报一个会误导");

  const delegated = run("国电电力光伏项目EPC工程总承包工程公开招标中标结果公告", `国家能源集团国际工程咨询有限公司受北京国电电力新能源技术有限公司的委托，就该项目进行公开招标`, "国能e招·中标公告");
  assert.equal(delegated.purchaser, "北京国电电力新能源技术有限公司");
  assert.equal(delegated.agent, "国家能源集团国际工程咨询有限公司");
});

test("候选人公示：第一中标候选人和他的投标报价", () => {
  const f = run("城中村改造项目（二期）电力改迁设计中标候选人公示", `一、评标委员会推荐的中标候选人名单及其排序 中标候选人排名 单位名称 投标报价 工期 第一中标候选人 宁夏泓钰工程设计有限公司 1118295.50元 30天 合格 第二中标候选人 宁夏朔源电力设计咨询有限公司 1230125.00元`);
  assert.equal(f.stage, "candidate");
  assert.equal(f.winner, "宁夏泓钰工程设计有限公司");
  assert.deepEqual([f.amount?.value, f.amount?.label], [1118295.5, "投标报价"]);
});

test("申报通知：申报截止和“请于…前报送”", () => {
  const a = run("关于开展2026年度能源领域首台（套）重大技术装备申报工作的通知", `请各单位于2026年12月15日前将申报材料报送至能源局科技装备司。`, "国家能源局·通知");
  assert.equal(a.stage, "call");
  assert.equal(bj(a.deadline), "2026-12-15 23:59");
  assert.equal(a.deadline!.label, "申报截止");
  const b = run("关于征集电力安全生产先进技术的通知", `申报截止时间：2026年12月31日17:00`, "中电联·通知公告");
  assert.equal(bj(b.deadline), "2026-12-31 17:00");
});

test("公告阶段：结果、终止、变更先于招标认；“检修改造”不是修改公告；标签定项目前期和申报", () => {
  const cases: Array<[string, string[], string | null]> = [
    ["XX变电站检修改造工程招标公告", [], "tender"],
    ["中标结果变更公告", [], "change"],
    ["第一中标候选人公示", [], "candidate"],
    ["XX项目中标结果通知公示", [], "award"],
    ["XX设备采购项目流标公告", [], "ended"],
    ["2026年第四季度采购意向公开", [], "plan"],
    ["自治区发展改革委关于西吉县新庄20MW分散式风电项目核准的批复", [], "early"],
    ["XX330千伏输变电工程环境影响报告表拟审批公示", ["项目前期"], "early"],
    ["关于开展2026年度科技项目申报工作的通知", [], "call"],
    ["XX单一来源采购公示", [], "tender"],
    ["国网发布2026年电力大模型规划", [], null],
  ];
  for (const [title, tags, stage] of cases) assert.equal(stageOf(title, tags), stage, title);
});

test("认不准就不给：没有金额的“详见”、单位不明的数字、离发布时间太远的日期、和常用词撞车的地名", () => {
  const f = run("某大理石地面铺设工程招标公告", `预算金额：详见招标文件。项目预算 300 。投标截止时间：2024年1月5日 9:00。保证金：2万元`, "某交易平台");
  assert.equal(f.amount, null);
  assert.equal(f.deadline, null, "比发布早了将近两年，多半是别的日期");
  assert.equal(f.region, null, "大理石不是大理");
});

test("时刻：下午换算成 24 小时制；只写日期的按当天结束；不存在的日期不认", () => {
  assert.equal(bj(run("某项目询价公告", "报价截止时间：2026年12月3日下午2:30").deadline), "2026-12-03 14:30");
  assert.equal(bj(run("某项目招标公告", "投标截止时间：2026-12-03").deadline), "2026-12-03 23:59");
  assert.equal(run("某项目招标公告", "投标截止时间：2026年2月30日 9:00").deadline, null);
});

test("时刻整段认：秒、句号结尾、中午、无效时刻、“时”后面隔空格的条款编号", () => {
  const exact = (m: Moment | null) => m && new Date(new Date(m.value).getTime() + 8 * 3600_000).toISOString().slice(0, 19).replace("T", " ");
  assert.equal(bj(run("某项目招标公告", "投标截止时间：2026年12月17日 18:45. 交电子文件").deadline), "2026-12-17 18:45");
  assert.equal(exact(run("某项目招标公告", "投标截止时间：2026年12月17日 10:30:45（北京时间）").deadline), "2026-12-17 10:30:45");
  assert.equal(bj(run("某项目招标公告", "投标截止时间：2026年12月17日 中午1点").deadline), "2026-12-17 13:00");
  assert.equal(run("某项目招标公告", "投标截止时间：2026年12月17日 24:30").deadline, null, "不成立的时刻不认");
  assert.equal(bj(run("某项目招标公告", "获取文件截止时间：2026年12月17日 17时 4 文件获取").signup), "2026-12-17 17:00");
});

test("更正隔着分号也取新的；“详见附件，开标时间：…”不把开标时间当投标截止", () => {
  const changed = run("某项目变更公告", "原投标截止时间：2026-12-17 10:00；现变更为2026-12-18 15:00。");
  assert.equal(bj(changed.deadline), "2026-12-18 15:00");
  const opening = run("某项目招标公告", "投标截止时间：详见附件，开标时间：2026年12月17日 11:00。");
  assert.equal(opening.deadline?.label, "开标", "如实标成开标时间");
  assert.equal(bj(opening.deadline), "2026-12-17 11:00");
});

test("金额要整段读完：拆开的数字、百分比、数量、外币和区间都不当成一个人民币金额；引文不带出后面的联系人", () => {
  for (const text of ["预算金额（万元）：1 200。", "预算金额（元）：123.45%。", "预算金额（万元）：1000个。", "预算金额：100万美元。", "预算金额（万元）：120-150万元。"]) {
    assert.equal(run("某项目招标公告", text).amount, null, text);
  }
  const f = run("某项目招标公告", "预算金额：100万元，联系人李雷，电话0951-0000000。");
  assert.equal(f.amount?.value, 1_000_000);
  assert.doesNotMatch(f.amount!.quote, /李雷|电话/);
});
