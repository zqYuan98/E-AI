// 模型按 industry/prompts/tender-extract.md 从公告正文抽出来的东西（模块之间不互相引用，这里只收本模块用到的字段）。
// 写得宽松：某个字段不合格式时置空，不让整份作废；原话核对在 details.ts 做。
import { z } from "zod";

const REQUIREMENT_KINDS = ["qualification", "performance", "personnel", "authorization", "financial", "credit", "other"] as const;

const Quote = z.string().max(600);
/** 一个字段的值和原话；公告没写或格式不对时为 null。 */
const quoted = <T extends z.ZodType>(value: T) => z.object({ value, quote: Quote }).nullable().catch(null);
const LocalTime = z.string().regex(/^\d{4}-\d{2}-\d{2}( \d{2}:\d{2})?$/);
const nullable = <T extends z.ZodType>(t: T) => t.nullable().catch(null);

export const DetailsSchema = z.object({
  projectName: quoted(z.string().max(200)),
  buyer: quoted(z.string().max(100)),
  agency: quoted(z.string().max(100)),
  region: quoted(z.object({ province: z.string().max(20), city: nullable(z.string().max(20)) })),
  budgetWan: quoted(z.number().positive()),
  allowsConsortium: quoted(z.boolean()),
  times: z.object({
    docObtainEnd: quoted(LocalTime),
    signupDeadline: quoted(LocalTime),
    bidDeadline: quoted(LocalTime),
    opening: quoted(LocalTime),
  }).catch({ docObtainEnd: null, signupDeadline: null, bidDeadline: null, opening: null }),
  // 一条标包或要求格式不对时只丢那一条。
  lots: z.array(z.object({
    no: nullable(z.string().max(40)),
    name: z.string().max(200),
    quote: Quote,
    scope: quoted(z.string().max(400)),
    budgetWan: quoted(z.number().positive()),
  }).nullable().catch(null)).max(200).catch([]).transform((a) => a.filter((x) => x !== null)),
  requirements: z.array(z.object({
    kind: z.enum(REQUIREMENT_KINDS).catch("other"),
    text: z.string().max(200),
    quote: Quote,
    lots: nullable(z.array(z.string().max(40)).max(50)),
  }).nullable().catch(null)).max(60).catch([]).transform((a) => a.filter((x) => x !== null)),
  detailsInDocuments: z.boolean().catch(false),
});
export type Extracted = z.infer<typeof DetailsSchema>;
