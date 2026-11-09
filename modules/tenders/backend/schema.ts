// 模型从一份招采公告里抽出来的东西。格式和天枢商务投标助手的 NoticeExtraction 一致（天枢按它核对原话、初筛），
// 这里写得宽松：某个字段不合格式时置空，不让整条作废。原话核对在天枢做，这里只存模型的原样结果。
import { z } from "zod";

export const NOTICE_KINDS = [
  "招标公告", "资格预审公告", "竞争性谈判", "竞争性磋商", "询价", "比选", "单一来源",
  "采购意向", "招标计划", "更正公告", "澄清公告", "延期公告", "终止公告",
  "中标候选人公示", "中标结果", "其他",
] as const;

const REQUIREMENT_KINDS = ["qualification", "performance", "personnel", "authorization", "financial", "credit", "other"] as const;

const Quote = z.string().max(600);
/** 一个字段的值和原话；公告没写或格式不对时为 null。 */
const quoted = <T extends z.ZodType>(value: T) => z.object({ value, quote: Quote }).nullable().catch(null);
const LocalTime = z.string().regex(/^\d{4}-\d{2}-\d{2}( \d{2}:\d{2})?$/);
const nullable = <T extends z.ZodType>(t: T) => t.nullable().catch(null);

const Requirement = z.object({
  kind: z.enum(REQUIREMENT_KINDS).catch("other"),
  text: z.string().max(200),
  quote: Quote,
  lots: nullable(z.array(z.string().max(40)).max(50)),
  qualification: nullable(z.object({ name: z.string().max(80), minLevel: nullable(z.string().max(20)) })),
  performance: nullable(z.object({
    category: z.string().max(80),
    since: nullable(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)),
    withinYears: nullable(z.number().int().positive()),
    minCount: nullable(z.number().int().positive()),
    minAmountWan: nullable(z.number().positive()),
  })),
});

const Lot = z.object({
  no: nullable(z.string().max(40)),
  name: z.string().max(200),
  quote: Quote,
  scope: quoted(z.string().max(400)),
  budgetWan: quoted(z.number().positive()),
  deliveryPlace: quoted(z.string().max(100)),
  deliveryPeriod: quoted(z.string().max(100)),
});

export const ExtractSchema = z.object({
  kind: z.enum(NOTICE_KINDS).catch("其他"),
  projectName: quoted(z.string().max(200)),
  projectCode: quoted(z.string().max(80)),
  buyer: quoted(z.string().max(100)),
  agency: quoted(z.string().max(100)),
  region: quoted(z.object({ province: z.string().max(20), city: nullable(z.string().max(20)) })),
  budgetWan: quoted(z.number().positive()),
  allowsConsortium: quoted(z.boolean()),
  times: z.object({
    docObtainStart: quoted(LocalTime),
    docObtainEnd: quoted(LocalTime),
    signupDeadline: quoted(LocalTime),
    bidDeadline: quoted(LocalTime),
    opening: quoted(LocalTime),
  }),
  // 一条标包或要求格式不对时只丢那一条。
  lots: z.array(Lot.nullable().catch(null)).max(200).catch([]).transform((a) => a.filter((x) => x !== null)),
  requirements: z.array(Requirement.nullable().catch(null)).max(60).catch([]).transform((a) => a.filter((x) => x !== null)),
  detailsInDocuments: z.boolean().catch(false),
});
export type Extracted = z.infer<typeof ExtractSchema>;
