// 后台“投标商机”的我司资质：资质证书从宜搭“资质/荣誉台账”同步（先“试读”看字段认得对不对，再“立即同步”；每天 07:30 自动同步），
// 人员证书、业绩和其他在这里手填，每行“公司：内容”。比对按公司分开，给出建议的投标主体。
import { useState } from "react";
import { useAdminAction } from "@aihot/web/features/admin/action";
import { Badge, Button, Card, DataTable, Field, ReasonDialog, Textarea, Time } from "@aihot/web/features/admin/ui";
import { shortCompany, type CompanyProfile, type CompanyQualification, type OpportunityAdmin } from "../types.ts";

const FIELDS: Array<{ key: keyof CompanyProfile; label: string; placeholder: string }> = [
  { key: "personnel", label: "人员证书", placeholder: "博创：一级建造师（机电工程） 3 人\n博诺思：高级工程师 12 人" },
  { key: "performance", label: "业绩", placeholder: "博创：2024 年 国网某省电力公司 变电站视频监控系统运维 120 万元" },
  { key: "other", label: "其他", placeholder: "博创：注册资本 5000 万元" },
];
const joinLines = (c: CompanyProfile) => Object.fromEntries(FIELDS.map((f) => [f.key, c[f.key].join("\n")])) as Record<keyof CompanyProfile, string>;
const splitLines = (t: string) => t.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

interface Preview { count: number; companies: string[]; fields: Record<string, string>; sample: CompanyQualification[]; warnings: string[] }

const validity = (q: CompanyQualification) => (q.validFrom || q.validTo ? `${q.validFrom || "—"} ~ ${q.validTo || "—"}` : "—");

function QualTable({ rows }: { rows: CompanyQualification[] }) {
  return (
    <DataTable dense rows={rows} rowKey={(q) => q.id} columns={[
      { key: "c", label: "所属公司", render: (q) => <span className="text-[12.5px]">{q.company}</span> },
      { key: "k", label: "类型", render: (q) => <span className="text-[12.5px] text-ink-3">{q.kind || "—"}</span> },
      { key: "n", label: "名称", render: (q) => <span className="text-[12.5px] text-ink">{q.name}</span> },
      { key: "v", label: "有效期", render: (q) => <span className="num text-[12px] text-ink-3">{validity(q)}</span> },
    ]} />
  );
}

export function CompanyCard({ company, qualifications }: Pick<OpportunityAdmin, "company" | "qualifications">) {
  const { run, pending } = useAdminAction();
  const [text, setText] = useState(joinLines(company));
  const [preview, setPreview] = useState<Preview | null>(null);
  const [action, setAction] = useState<"save" | "sync" | null>(null);
  const { configured, status, rows } = qualifications;
  const today = new Date().toISOString().slice(0, 10);
  const byCompany = [...new Set(rows.map((q) => q.company))].map((c) => {
    const mine = rows.filter((q) => q.company === c);
    return { company: c, rows: mine, current: mine.filter((q) => !q.validTo || q.validTo >= today).length };
  });

  const dryRun = async () => {
    setPreview(await run<Preview>("POST", "/api/admin/opportunities/qualifications/sync", { dryRun: true }, { label: "yida-preview", revalidate: false }));
  };

  return (
    <Card title="我司资质" className="mb-5">
      <p className="mb-3 text-[12.5px] leading-relaxed text-ink-3">
        项目的资质、业绩、人员要求会按集团下每家公司分别对比，标出满足、不满足或需核实，给出建议的投标主体和匹配度（有不满足为低，有需核实为中，都满足为高）。
        一家公司只看它自己的条件，不跨公司拼。清单里没有的一律按“需核实”。条件变了以后，还没截止的项目会重新比对。
      </p>

      <div className="rounded-panel border border-line p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="text-[13.5px] font-medium text-ink">资质证书（从宜搭“资质/荣誉台账”同步，每天 07:30）</div>
          <div className="flex gap-1.5">
            <Button size="sm" disabled={!configured} busy={pending === "yida-preview"} onClick={dryRun} title="只读一遍、不保存，看字段认得对不对">试读</Button>
            <Button size="sm" tone="primary" disabled={!configured} onClick={() => setAction("sync")}>立即同步</Button>
          </div>
        </div>
        <div className="mt-2 text-[12.5px] leading-relaxed text-ink-3">
          {!configured ? (
            <span className="text-amber-ink">还没配置：服务器 .env 要填 YIDA_APP_TYPE、YIDA_SYSTEM_TOKEN、YIDA_USER_ID、YIDA_QUALIFICATION_FORM，并给钉钉应用开通“宜搭表单数据读权限”（docs/deploy.md）。</span>
          ) : status === null ? (
            "还没同步过。先点“试读”确认字段，再点“立即同步”。"
          ) : status.error ? (
            <span className="text-hot">最近一次同步失败（<Time at={status.at} />）：{status.error}</span>
          ) : (
            <span>最近同步 <Time at={status.at} />，{status.count} 条，{byCompany.length} 家公司。</span>
          )}
          {status?.warnings?.map((w, i) => <div key={i} className="text-amber-ink">{w}</div>)}
        </div>

        {preview && (
          <div className="mt-3 rounded-mark bg-bg-sunk p-3 text-[12.5px]">
            <div className="font-medium text-ink">试读结果（没有保存）：读到 {preview.count} 条，{preview.companies.length} 家公司</div>
            <ul className="mt-1 space-y-0.5 text-ink-3">
              {Object.entries(preview.fields).map(([role, field]) => (
                <li key={role}>{role}：{field ? <span className="font-mono text-ink-2">{field}</span> : <Badge tone="bad">没认出</Badge>}</li>
              ))}
            </ul>
            {preview.warnings.map((w, i) => <div key={i} className="mt-1 text-amber-ink">{w}</div>)}
            {preview.sample.length > 0 && <div className="mt-2"><QualTable rows={preview.sample} /></div>}
            <p className="mt-2 text-ink-4">名称、所属公司、有效期都对的话，点“立即同步”。不对请把这段截图发给开发。</p>
          </div>
        )}

        {byCompany.length > 0 && (
          <div className="mt-3 space-y-1.5">
            {byCompany.map((c) => (
              <details key={c.company} className="rounded-mark border border-line px-3 py-1.5">
                <summary className="cursor-pointer text-[13px] text-ink-2">
                  {c.company}<span className="ml-2 text-[12px] text-ink-4">{c.rows.length} 条，有效 {c.current} 条</span>
                </summary>
                <div className="mt-2"><QualTable rows={c.rows} /></div>
              </details>
            ))}
          </div>
        )}
      </div>

      <div className="mt-4 text-[13.5px] font-medium text-ink">人员证书、业绩和其他（手填）</div>
      <p className="mt-1 text-[12.5px] text-ink-3">
        每行写成“公司：内容”。公司写简称或全称都行，简称要能在宜搭的公司全称里找到（“博创”对上“安徽博创信息科技有限公司”）
        {byCompany.length > 0 && <>：{byCompany.map((c) => shortCompany(c.company)).join("、")}</>}。
      </p>
      <div className="mt-2 grid gap-3 md:grid-cols-3">
        {FIELDS.map((f) => (
          <Field key={f.key} label={f.label}>
            <Textarea rows={Math.max(4, text[f.key].split("\n").length + 1)} value={text[f.key]} placeholder={f.placeholder}
              onChange={(e) => setText({ ...text, [f.key]: e.target.value })} className="text-[12.5px]" />
          </Field>
        ))}
      </div>
      <div className="mt-3 flex justify-end">
        <Button tone="primary" onClick={() => setAction("save")}>保存手填内容</Button>
      </div>

      <ReasonDialog
        open={action !== null}
        title={action === "sync" ? "从宜搭同步资质" : "保存人员证书、业绩和其他"}
        description={action === "sync"
          ? "用宜搭台账整表替换现在的资质（宜搭里删掉的这里也删掉），还没截止的项目会按新资质重新比对。写一句原因，会记进审计日志。"
          : "还没截止的项目会按新内容重新比对（每 5 分钟一批）。写一句原因，会记进审计日志。"}
        busy={pending === "company"}
        onClose={() => setAction(null)}
        onSubmit={async (reason) => {
          if (action === "sync") {
            const ok = (await run("POST", "/api/admin/opportunities/qualifications/sync", { reason }, { label: "company", success: "已同步" })) !== null;
            if (ok) setPreview(null);
            return ok;
          }
          const body = { personnel: splitLines(text.personnel), performance: splitLines(text.performance), other: splitLines(text.other), reason };
          return (await run("POST", "/api/admin/opportunities/company", body, { label: "company", success: "已保存" })) !== null;
        }}
      />
    </Card>
  );
}
