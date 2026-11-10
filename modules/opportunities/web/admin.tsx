// 后台“投标商机”：采集和推送的运行状态，业务口径（每行一个方向“方向名：词、词、词”，加排除词），最近抓到的公告。
// 业务口径决定哪些项目算相关或待确认；保存后从下一轮筛选起生效。
import { useState } from "react";
import { Link, useLoaderData, type LoaderFunctionArgs } from "react-router";
import { adminGet } from "@aihot/web/lib/admin.server";
import { useAdminAction } from "@aihot/web/features/admin/action";
import { AdminPage, Badge, Button, Card, DataTable, Empty, Field, ReasonDialog, Stat, Textarea, Time } from "@aihot/web/features/admin/ui";
import { SOURCE_NAMES, type BusinessProfile, type OpportunityAdmin } from "../types.ts";

export async function loader({ request }: LoaderFunctionArgs) {
  return adminGet<OpportunityAdmin>(request, "/api/admin/opportunities");
}
export const meta = () => [{ title: "投标商机" }, { name: "robots", content: "noindex, nofollow" }];

type Notice = OpportunityAdmin["notices"][number];
type Tone = "ok" | "warn" | "bad" | "muted";

const STATUS: Record<string, { label: string; tone: Tone }> = {
  pending: { label: "待取附件", tone: "muted" },
  parsed: { label: "已解析", tone: "ok" },
  partial: { label: "部分解析", tone: "warn" },
  no_file: { label: "没有公开附件", tone: "muted" },
  failed: { label: "取附件失败", tone: "bad" },
  blocked: { label: "需要人工", tone: "bad" },
};
const RETRYABLE = new Set(["failed", "blocked", "no_file", "partial", "parsed"]);

const splitWords = (text: string) => text.split(/[、,，;；\n]/).map((w) => w.trim()).filter(Boolean);

function formatLines(p: BusinessProfile) {
  return p.lines.map((l) => `${l.name}：${l.keywords.join("、")}`).join("\n");
}

/** 每行“方向名：词、词、词”；不合格的行给出原因。 */
function parseLines(text: string): { lines: BusinessProfile["lines"]; error: string | null } {
  const lines: BusinessProfile["lines"] = [];
  for (const [i, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line) continue;
    const [name, ...rest] = line.split(/[:：]/);
    const keywords = splitWords(rest.join("："));
    if (!name?.trim() || !rest.length) return { lines, error: `第 ${i + 1} 行要写成“方向名：词、词、词”` };
    if (!keywords.length) return { lines, error: `第 ${i + 1} 行“${name.trim()}”至少要有一个关键词` };
    lines.push({ name: name.trim(), keywords });
  }
  if (!lines.length) return { lines, error: "至少写一个业务方向" };
  return { lines, error: null };
}

function StatusRow({ ok, label, on, off, hint }: { ok: boolean; label: string; on: string; off: string; hint: string }) {
  return (
    <li className="flex flex-col gap-1 py-2.5 sm:flex-row sm:items-start sm:gap-3">
      <span className="w-24 shrink-0 text-[13px] text-ink-2">{label}</span>
      <span className="shrink-0"><Badge tone={ok ? "ok" : "warn"}>{ok ? on : off}</Badge></span>
      {!ok && <span className="min-w-0 break-words text-[12.5px] leading-relaxed text-ink-3">{hint}</span>}
    </li>
  );
}

function pushState(n: Notice) {
  if (n.pushedAt) return <span className="text-[12px] text-ink-3">已推送 <Time at={n.pushedAt} /></span>;
  if (n.backfill) return <Badge tone="muted" title="开始使用前已有的公告，只补进列表，不推送">补录不推送</Badge>;
  if (n.relevant + n.maybe > 0) return <Badge tone="warn">待推送</Badge>;
  return <span className="text-[12px] text-ink-4">无需推送</span>;
}

export default function OpportunitiesAdmin() {
  const { profile, defaults, status, notices, counts } = useLoaderData<typeof loader>();
  const { run, pending } = useAdminAction();
  const [linesText, setLinesText] = useState(formatLines(profile));
  const [excludeText, setExcludeText] = useState(profile.exclude.join("、"));
  const [error, setError] = useState<string | null>(null);
  const [action, setAction] = useState<{ kind: "save"; profile: BusinessProfile } | { kind: "run" } | { kind: "retry"; notice: Notice } | null>(null);

  const save = () => {
    const { lines, error } = parseLines(linesText);
    setError(error);
    if (!error) setAction({ kind: "save", profile: { lines, exclude: splitWords(excludeText) } });
  };
  const reset = () => {
    setLinesText(formatLines(defaults));
    setExcludeText(defaults.exclude.join("、"));
    setError(null);
  };

  return (
    <AdminPage
      title="投标商机"
      subtitle="自动抓取国网电子商务平台和电工交易专区的招采公告（下载附件拆成具体项目），并收录信源里打了“招标”“招标计划”标签的其他招采平台公告，按下面的业务口径筛出相关和待确认的，抽出预算、时间和资格业绩要求，推送到钉钉。"
      actions={
        <>
          <Button size="sm" busy={pending === "push-test"} disabled={!status.pushConfigured} title={status.pushConfigured ? undefined : "推送还没配置"}
            onClick={() => run("POST", "/api/admin/opportunities/push-test", undefined, { label: "push-test", success: "测试消息已发出，请到钉钉群里看", revalidate: false })}>
            发送测试推送
          </Button>
          <Button size="sm" tone="primary" disabled={!status.fetcherConfigured} onClick={() => setAction({ kind: "run" })}>立即采集一轮</Button>
        </>
      }
    >
      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="相关" value={counts.relevant} />
        <Stat label="待确认" value={counts.maybe} tone={counts.maybe ? "warn" : undefined} />
        <Stat label="待取附件" value={counts.pending} />
        <Stat label="取附件失败" value={counts.failed} tone={counts.failed ? "bad" : undefined} />
      </div>

      <Card title="运行状态" className="mb-5">
        <ul className="divide-y divide-line">
          <StatusRow ok={status.fetcherConfigured} label="采集服务" on="已配置" off="未配置" hint="在服务器 .env 填 OPPORTUNITIES_FETCHER_URL 和 OPPORTUNITIES_FETCHER_TOKEN，并启动 sgcc-fetcher 容器（docs/deploy.md 内网部署第 7 步）。" />
          <StatusRow ok={status.collectOn} label="定时采集" on="已打开" off="关着" hint="在服务器 .env 把 COLLECT_ENABLED 设为 true，才会定时抓新公告。" />
          <StatusRow ok={status.modelOn} label="模型判断" on="已打开" off="关着" hint="在服务器 .env 把 MODEL_CALLS_ENABLED 设为 true，模型才会逐个判断；关着时只按关键词筛。" />
          <StatusRow ok={status.pushConfigured && status.pushEnabled} label="钉钉推送" on="已打开" off={status.pushConfigured ? "没打开" : "未配置"}
            hint={status.pushConfigured ? "在服务器 .env 把 DINGTALK_PUSH_ENABLED 设为 true。" : "在服务器 .env 设置 DINGTALK_ROBOT_WEBHOOK、DINGTALK_ROBOT_SECRET 并把 DINGTALK_PUSH_ENABLED 设为 true。"} />
        </ul>
      </Card>

      <Card title="业务口径" className="mb-5" right={<Button size="sm" onClick={reset}>恢复默认</Button>}>
        <div className="grid gap-3">
          <Field label="业务方向" hint="每行一个方向：“方向名：词、词、词”。项目的名称、采购内容命中某行的词，就归到这个方向；方向名会显示在列表的筛选和推送里">
            <Textarea rows={Math.max(5, linesText.split("\n").length + 1)} value={linesText} onChange={(e) => setLinesText(e.target.value)} className="font-mono text-[12.5px]" />
          </Field>
          <Field label="排除词" hint="用顿号或逗号隔开。命中这些词的项目直接算无关，例如土建、物业">
            <Textarea rows={2} value={excludeText} onChange={(e) => setExcludeText(e.target.value)} className="font-mono text-[12.5px]" />
          </Field>
          {error && <p role="alert" className="text-[13px] text-hot">{error}</p>}
          <div className="flex justify-end">
            <Button tone="primary" onClick={save}>保存</Button>
          </div>
        </div>
      </Card>

      <Card title={`最近的国网公告（${notices.length}）`} pad={false}>
        {notices.length ? (
          <DataTable
            dense
            rows={notices}
            rowKey={(n) => n.id}
            columns={[
              {
                key: "t", label: "公告",
                render: (n) => (
                  <div className="min-w-[280px]">
                    <Link to={`/opportunities/${encodeURIComponent(n.id)}`} className="font-medium text-ink hover:text-accent">{n.title}</Link>
                    <div className="mt-0.5 text-[11.5px] text-ink-4">{SOURCE_NAMES[n.source]} · <Time at={n.discoveredAt} /></div>
                    {n.error && <div className="mt-0.5 break-words text-[12px] text-hot">{n.error}</div>}
                  </div>
                ),
              },
              { key: "s", label: "状态", render: (n) => <Badge tone={STATUS[n.status]?.tone ?? "muted"}>{STATUS[n.status]?.label ?? n.status}</Badge> },
              { key: "i", label: "项目", align: "right", render: (n) => n.itemCount },
              { key: "r", label: "相关 / 待确认", align: "right", render: (n) => `${n.relevant} / ${n.maybe}` },
              { key: "p", label: "推送", render: pushState },
              {
                key: "a", label: "", align: "right",
                render: (n) => RETRYABLE.has(n.status) ? <Button size="sm" onClick={() => setAction({ kind: "retry", notice: n })}>重新抓取</Button> : null,
              },
            ]}
          />
        ) : (
          <Empty>还没有抓到公告。采集服务配好、定时采集打开后会自动出现；也可以点右上角“立即采集一轮”。</Empty>
        )}
      </Card>

      <ReasonDialog
        open={action !== null}
        title={action?.kind === "save" ? "保存业务口径" : action?.kind === "run" ? "立即采集一轮" : action ? `重新抓取：${action.notice.title}` : ""}
        description={action?.kind === "save" ? "从下一轮筛选起按新口径判断。写一句原因，会记进审计日志。" : "写一句原因，会记进审计日志。"}
        busy={pending === "opportunities"}
        onClose={() => setAction(null)}
        onSubmit={async (reason) => {
          if (!action) return false;
          const label = "opportunities";
          if (action.kind === "save") {
            return (await run("POST", "/api/admin/opportunities/profile", { ...action.profile, reason }, { label, success: "已保存" })) !== null;
          }
          if (action.kind === "run") return (await run("POST", "/api/admin/opportunities/run", { reason }, { label, success: "已开始采集，稍后刷新看结果" })) !== null;
          return (await run("POST", `/api/admin/opportunities/${encodeURIComponent(action.notice.id)}/retry`, { reason }, { label, success: "已安排重新抓取" })) !== null;
        }}
      />
    </AdminPage>
  );
}
