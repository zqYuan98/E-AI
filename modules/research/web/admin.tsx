// 后台“研报库管理”：单篇填写或批量导入（JSON），已有研报的隐藏和删除。同一个链接再导入就是更新。
import { useState } from "react";
import { Link, useLoaderData, type LoaderFunctionArgs } from "react-router";
import { adminGet } from "@aihot/web/lib/admin.server";
import { useAdminAction } from "@aihot/web/features/admin/action";
import { AdminPage, Badge, Button, Card, DataTable, Empty, Field, Input, ReasonDialog, Textarea } from "@aihot/web/features/admin/ui";
import { RESEARCH_TOPICS } from "../types.ts";

interface Row { id: number; title: string; institution: string; date: string | null; topics: string[]; pointCount: number; url: string; hidden: boolean; createdBy: string }
interface ImportResult { created: number; updated: number; errors: Array<{ index: number; title: string | null; message: string }> }

export async function loader({ request }: LoaderFunctionArgs) {
  return adminGet<{ reports: Row[] }>(request, "/api/admin/research");
}
export const meta = () => [{ title: "研报库管理" }, { name: "robots", content: "noindex, nofollow" }];

const EXAMPLE = `[
  {
    "title": "研报标题",
    "institution": "发布机构",
    "date": "2026-10-15",
    "url": "https://www.djyanbao.com/…",
    "summary": "200 字以内的摘要",
    "points": [{ "text": "要点概括", "quote": "研报里的一句原话" }],
    "topics": ["电力大模型", "虚拟电厂"]
  }
]`;

const BLANK = { title: "", institution: "", date: "", url: "", summary: "", topics: "", points: "" };

export default function ResearchAdmin() {
  const { reports } = useLoaderData<typeof loader>();
  const { run, pending } = useAdminAction();
  const [json, setJson] = useState("");
  const [form, setForm] = useState(BLANK);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [action, setAction] = useState<{ kind: "hide" | "show" | "delete"; row: Row } | null>(null);

  const submit = async (items: unknown) => {
    setError(null);
    const r = await run<ImportResult>("POST", "/api/admin/research/import", { reports: items }, { label: "import" });
    if (r) setResult(r);
    return r;
  };
  const importJson = async () => {
    let items: unknown;
    try { items = JSON.parse(json); } catch { return setError("不是合法的 JSON，请检查括号和引号"); }
    if ((await submit(items))?.errors.length === 0) setJson("");
  };
  // 单篇填写：要点每行一条，“概括｜原话”。
  const addOne = async () => {
    const points = form.points.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => {
      const [text, ...quote] = l.split(/[｜|]/);
      return { text: text!.trim(), quote: quote.join("｜").trim() };
    });
    if (points.some((p) => !p.quote)) return setError("要点每行写成“概括｜原话”，原话不能空");
    const item = {
      title: form.title, institution: form.institution, date: form.date || null, url: form.url, summary: form.summary, points,
      topics: form.topics.split(/[,，、\s]+/).map((t) => t.trim()).filter(Boolean),
    };
    if ((await submit([item]))?.errors.length === 0) setForm(BLANK);
  };
  const set = (k: keyof typeof BLANK) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));

  return (
    <AdminPage title="研报库管理" subtitle="录入研报的标题、机构、日期、摘要和带原话的要点，同事在站内浏览和搜索，点链接到研报网站看原文。不存 PDF 和全文；原话只摘一句，最长 200 字。">
      <div className="grid gap-5 xl:grid-cols-2">
        <Card title="单篇填写">
          <div className="space-y-3">
            <Field label="标题"><Input value={form.title} onChange={set("title")} maxLength={300} /></Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="机构"><Input value={form.institution} onChange={set("institution")} maxLength={100} /></Field>
              <Field label="发布日期"><Input type="date" value={form.date} onChange={set("date")} /></Field>
            </div>
            <Field label="原文链接" hint="研报网站上这篇报告的页面地址"><Input value={form.url} onChange={set("url")} placeholder="https://www.djyanbao.com/…" /></Field>
            <Field label="摘要"><Textarea rows={3} value={form.summary} onChange={set("summary")} maxLength={800} /></Field>
            <Field label="要点（可选）" hint="每行一条：概括｜研报里的一句原话"><Textarea rows={4} value={form.points} onChange={set("points")} placeholder="2030 年虚拟电厂调节能力目标｜到2030年，全国虚拟电厂调节能力达到5000万千瓦以上" /></Field>
            <Field label="主题（可选）" hint={`逗号分隔，常用：${RESEARCH_TOPICS.join("、")}`}><Input value={form.topics} onChange={set("topics")} /></Field>
            <Button tone="primary" busy={pending === "import"} disabled={!form.title.trim() || !form.url.trim()} onClick={addOne}>保存</Button>
          </div>
        </Card>
        <Card title="批量导入（JSON）">
          <p className="mb-3 text-[13px] leading-6 text-ink-3">一次最多 200 篇。不合格的会逐条列出原因，其余照常保存；同一个链接再导入就是更新。</p>
          <Textarea rows={14} value={json} onChange={(e) => setJson(e.target.value)} placeholder={EXAMPLE} className="font-mono text-[12px]" />
          <div className="mt-3"><Button tone="primary" busy={pending === "import"} disabled={!json.trim()} onClick={importJson}>导入</Button></div>
        </Card>
      </div>

      {(error || result) && (
        <Card className="mt-5" title="导入结果">
          {error && <p role="alert" className="text-[13px] text-hot">{error}</p>}
          {result && (
            <>
              <p className="text-[13px] text-ink-2">新增 {result.created} 篇，更新 {result.updated} 篇{result.errors.length ? `，${result.errors.length} 篇没导入：` : "。"}</p>
              {result.errors.length > 0 && (
                <ul className="mt-2 space-y-1 text-[12.5px] text-hot">
                  {result.errors.map((e) => <li key={e.index}>第 {e.index + 1} 篇{e.title ? `《${e.title}》` : ""}：{e.message}</li>)}
                </ul>
              )}
            </>
          )}
        </Card>
      )}

      <Card className="mt-5" title={`研报（${reports.length}）`} pad={false}>
        {reports.length ? (
          <DataTable
            dense
            rows={reports}
            rowKey={(r) => r.id}
            columns={[
              { key: "t", label: "研报", render: (r) => <div className="min-w-[260px]"><Link to={`/research/${r.id}`} className="font-medium text-ink hover:text-accent">{r.title}</Link><div className="mt-0.5 text-[11.5px] text-ink-4">{[r.institution, r.date, r.topics.join("、")].filter(Boolean).join(" · ")}</div></div> },
              { key: "p", label: "要点", align: "right", render: (r) => <span className="num">{r.pointCount}</span> },
              { key: "b", label: "录入", render: (r) => <span className="text-[12px] text-ink-4">{r.createdBy}</span> },
              {
                key: "a", label: "", align: "right",
                render: (r) => (
                  <span className="inline-flex gap-1.5">
                    {r.hidden && <Badge>已隐藏</Badge>}
                    <Button size="sm" onClick={() => setAction({ kind: r.hidden ? "show" : "hide", row: r })}>{r.hidden ? "显示" : "隐藏"}</Button>
                    <Button size="sm" tone="danger" onClick={() => setAction({ kind: "delete", row: r })}>删除</Button>
                  </span>
                ),
              },
            ]}
          />
        ) : (
          <Empty>还没有研报。上面单篇填写，或者粘贴 JSON 批量导入。</Empty>
        )}
      </Card>

      <ReasonDialog
        open={!!action}
        danger={action?.kind === "delete"}
        title={action ? `${{ hide: "隐藏", show: "重新显示", delete: "删除" }[action.kind]}：${action.row.title}` : ""}
        description={action?.kind === "delete" ? "删除后不能恢复，只能重新导入。" : action?.kind === "hide" ? "隐藏后同事看不到，数据保留。" : undefined}
        confirmLabel={action ? { hide: "隐藏", show: "显示", delete: "删除" }[action.kind] : "确认"}
        busy={pending === "row"}
        onClose={() => setAction(null)}
        onSubmit={async (reason) => {
          const a = action!;
          const path = a.kind === "delete" ? "delete" : "hidden";
          const r = await run("POST", `/api/admin/research/${a.row.id}/${path}`, { hidden: a.kind === "hide", reason }, { label: "row", success: "已完成" });
          return r !== null;
        }}
      />
    </AdminPage>
  );
}
