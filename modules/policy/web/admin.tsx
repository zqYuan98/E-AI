// 后台“政策库管理”：粘贴网址导入（worker 每分钟处理几条），看导入结果；文件的隐藏、删除和重新抽取。
import { useState } from "react";
import { Link, useLoaderData, type LoaderFunctionArgs } from "react-router";
import { adminGet } from "@aihot/web/lib/admin.server";
import { useAdminAction } from "@aihot/web/features/admin/action";
import { AdminPage, Badge, Button, Card, DataTable, Empty, ReasonDialog, Textarea } from "@aihot/web/features/admin/ui";
import { AI_RELEVANCE } from "../types.ts";

interface Doc { id: number; name: string; levelLabel: string; docType: string; docNo: string | null; date: string | null; aiRelevance: keyof typeof AI_RELEVANCE; targets: number; aiClauses: number; links: number; hidden: boolean }
interface Import { id: number; url: string; status: "pending" | "document" | "not_document" | "failed"; docId: number | null; docName: string | null; error: string | null; requestedBy: string; updatedAt: string }
interface Data { docs: Doc[]; imports: Import[]; pending: number; failed: number; seeds: number }

export async function loader({ request }: LoaderFunctionArgs) {
  return adminGet<Data>(request, "/api/admin/policy");
}
export const meta = () => [{ title: "政策库管理" }, { name: "robots", content: "noindex, nofollow" }];

const STATUS: Record<Import["status"], { label: string; tone: "muted" | "ok" | "warn" | "bad" }> = {
  pending: { label: "排队中", tone: "muted" },
  document: { label: "已入库", tone: "ok" },
  not_document: { label: "不是政策规划文件", tone: "warn" },
  failed: { label: "失败", tone: "bad" },
};
type Action = { kind: "hide" | "show" | "delete" | "reextract"; doc: Doc };
const ACTION = {
  hide: { title: "隐藏", hint: "隐藏后不在政策库里显示，数据保留，随时可以再显示。", path: "hidden", body: { hidden: true } },
  show: { title: "重新显示", hint: "重新出现在政策库里。", path: "hidden", body: { hidden: false } },
  delete: { title: "删除", hint: "删除这份文件；它的资料不会再被自动收回来。要恢复只能重新导入原文网址。", path: "delete", body: {} },
  reextract: { title: "重新抽取", hint: "用当前的模型和提示词把这份文件的资料重新读一遍，几分钟内完成。", path: "reextract", body: {} },
} as const;

export default function PolicyAdmin() {
  const data = useLoaderData<typeof loader>();
  const { run, pending } = useAdminAction();
  const [urls, setUrls] = useState("");
  const [action, setAction] = useState<Action | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const docs = data.docs.filter((d) => showHidden || !d.hidden);
  const hiddenCount = data.docs.filter((d) => d.hidden).length;
  const submit = async (body: { urls?: string; seeds?: boolean }) => {
    const r = await run<{ queued: number; skipped: number }>("POST", "/api/admin/policy/imports", body, { label: "import" });
    if (r) setUrls("");
    return r;
  };

  return (
    <AdminPage title="政策库管理" subtitle="导入国家部委、两网和发电集团的政策规划文件；模型抽取文号、日期、目标和 AI 条款，原话核对不上的不保存。">
      <Card title="导入原文网址" className="mb-5">
        <p className="mb-3 text-[13px] leading-6 text-ink-3">
          每行一个原文页面的网址（政府网站、两网官网的正文页）。登记后每分钟处理几条：抓正文、调用模型抽取、入库，结果在下面的“导入记录”里。需要“模型调用”在运行中（设置页）。
        </p>
        <Textarea rows={5} value={urls} onChange={(e) => setUrls(e.target.value)} placeholder={"https://www.nea.gov.cn/…\nhttps://www.gov.cn/zhengce/…"} />
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button tone="primary" busy={pending === "import"} disabled={!urls.trim()} onClick={() => submit({ urls })}>导入</Button>
          <Button busy={pending === "import"} onClick={() => submit({ seeds: true })}>导入首批种子（{data.seeds} 个网址）</Button>
          {data.pending > 0 && <Badge>排队 {data.pending}</Badge>}
          {data.failed > 0 && <Badge tone="bad">失败 {data.failed}</Badge>}
        </div>
      </Card>

      <Card title={`文件（${data.docs.length - hiddenCount}${hiddenCount ? ` · 已隐藏 ${hiddenCount}` : ""}）`} className="mb-5" pad={false}
        right={hiddenCount > 0 && <label className="inline-flex items-center gap-1.5"><input type="checkbox" checked={showHidden} onChange={(e) => setShowHidden(e.target.checked)} />显示已隐藏</label>}>
        {docs.length ? (
          <DataTable
            dense
            rows={docs}
            rowKey={(d) => d.id}
            columns={[
              { key: "n", label: "文件", render: (d) => <div className="min-w-[260px]"><Link to={`/policy/${d.id}`} className="font-medium text-ink hover:text-accent">{d.name}</Link><div className="mt-0.5 text-[11.5px] text-ink-4">{[d.levelLabel, d.docType, d.docNo, d.date].filter(Boolean).join(" · ")}</div></div> },
              { key: "ai", label: "AI", render: (d) => <Badge tone={d.aiRelevance === "core" ? "accent" : d.aiRelevance === "partial" ? "info" : "muted"}>{AI_RELEVANCE[d.aiRelevance]}</Badge> },
              { key: "t", label: "目标 / AI 条款", align: "right", render: (d) => <span className="num">{d.targets} / {d.aiClauses}</span> },
              { key: "l", label: "资料", align: "right", render: (d) => <span className="num">{d.links}</span> },
              {
                key: "a", label: "", align: "right",
                render: (d) => (
                  <span className="inline-flex gap-1.5">
                    {d.hidden ? <Badge>已隐藏</Badge> : null}
                    <Button size="sm" onClick={() => setAction({ kind: "reextract", doc: d })}>重新抽取</Button>
                    <Button size="sm" onClick={() => setAction({ kind: d.hidden ? "show" : "hide", doc: d })}>{d.hidden ? "显示" : "隐藏"}</Button>
                    <Button size="sm" tone="danger" onClick={() => setAction({ kind: "delete", doc: d })}>删除</Button>
                  </span>
                ),
              },
            ]}
          />
        ) : (
          <Empty>还没有文件。上面粘贴原文网址导入，或者导入首批种子。</Empty>
        )}
      </Card>

      <Card title="导入记录（最近 100 条）" pad={false}>
        {data.imports.length ? (
          <DataTable
            dense
            rows={data.imports}
            rowKey={(r) => r.id}
            columns={[
              { key: "u", label: "网址", render: (r) => <a href={r.url} target="_blank" rel="noopener noreferrer" className="break-all font-mono text-[11.5px] text-ink-3 hover:text-accent">{r.url}</a> },
              { key: "s", label: "结果", render: (r) => <Badge tone={STATUS[r.status].tone}>{STATUS[r.status].label}</Badge> },
              { key: "d", label: "文件 / 原因", render: (r) => (r.docId ? <Link to={`/policy/${r.docId}`} className="text-[12.5px] text-ink-2 hover:text-accent">{r.docName ?? `#${r.docId}`}</Link> : <span className="text-[12px] text-ink-3">{r.error ?? "—"}</span>) },
              { key: "a", label: "", align: "right", render: (r) => (r.status === "failed" ? <Button size="sm" busy={pending === `retry-${r.id}`} onClick={() => run("POST", `/api/admin/policy/imports/${r.id}/retry`, {}, { label: `retry-${r.id}`, success: "已重新排队" })}>重试</Button> : null) },
            ]}
          />
        ) : (
          <Empty>还没有导入过</Empty>
        )}
      </Card>

      <ReasonDialog
        open={!!action}
        danger={action?.kind === "delete"}
        title={action ? `${ACTION[action.kind].title}：${action.doc.name}` : ""}
        description={action ? ACTION[action.kind].hint : undefined}
        confirmLabel={action ? ACTION[action.kind].title : "确认"}
        busy={pending === "doc"}
        onClose={() => setAction(null)}
        onSubmit={async (reason) => {
          const a = action!;
          const r = await run("POST", `/api/admin/policy/docs/${a.doc.id}/${ACTION[a.kind].path}`, { ...ACTION[a.kind].body, reason }, { label: "doc", success: a.kind === "reextract" ? "已排队，几分钟内完成" : "已完成" });
          return r !== null;
        }}
      />
    </AdminPage>
  );
}
