import { ADMIN, SITE } from "@aihot/site";
import { useRef, useState } from "react";
import type { Route } from "./+types/settings";
import type { AdminSettings } from "@aihot/contracts/admin";
import { adminGet } from "../../lib/admin.server";
import { useAdminAction } from "../../features/admin/action";
import { bj, num } from "../../features/admin/format";
import { AdminPage, Badge, Button, Card, DataTable, Field, Input, ReasonDialog } from "../../features/admin/ui";
import { toast } from "../../features/admin/toast";


export async function loader({ request }: Route.LoaderArgs) {
  return adminGet<AdminSettings>(request, "/api/admin/settings");
}

export const meta: Route.MetaFunction = () => [{ title: `设置 · ${SITE.name} 后台` }];

function QrSlot({ slot, label, src }: { slot: "wechatQr" | "feishuQr"; label: string; src: string | null }) {
  const { run, pending } = useAdminAction();
  const input = useRef<HTMLInputElement>(null);
  return (
    <div className="flex items-center gap-4">
      {src ? <img src={src} alt={label} className="size-28 rounded-card bg-white object-contain p-1.5 ring-1 ring-line" /> : <div className="flex size-28 shrink-0 items-center justify-center rounded-card bg-surface text-sm text-ink-4 ring-1 ring-line">未设置</div>}
      <div>
        <div className="text-[14px] font-medium text-ink">{label}</div>
        <div className="mt-0.5 break-all font-mono text-[11.5px] text-ink-4">{src}</div>
        <input
          ref={input}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          className="hidden"
          onChange={async (e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (!file) return;
            if (file.size > 2 * 1024 * 1024) return toast("图片最大 2MB", "error");
            const image = await new Promise<string>((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () => resolve(String(reader.result));
              reader.onerror = reject;
              reader.readAsDataURL(file);
            });
            await run("POST", "/api/admin/settings/contact-qr", { slot, image }, { label: `qr-${slot}`, success: `${label}已更换，关于页 5 分钟内更新` });
          }}
        />
        <Button className="mt-2" size="sm" busy={pending === `qr-${slot}`} onClick={() => input.current?.click()}>更换图片</Button>
      </div>
    </div>
  );
}

function BudgetRow({ b }: { b: AdminSettings["budgets"][number] }) {
  const { run, pending } = useAdminAction();
  const [v, setV] = useState({ perMinute: b.per_minute, perHour: b.per_hour, perDay: b.per_day });
  const [open, setOpen] = useState(false);
  const changed = v.perMinute !== b.per_minute || v.perHour !== b.per_hour || v.perDay !== b.per_day;
  return (
    <tr className="border-b border-line/70 last:border-0">
      <td className="px-3 py-2 font-mono text-[12.5px]">{b.service}</td>
      {(["perMinute", "perHour", "perDay"] as const).map((k) => (
        <td key={k} className="px-3 py-2">
          <Input type="number" min={0} className="!w-24 !py-1 text-right" value={v[k]} onChange={(e) => setV({ ...v, [k]: Number(e.target.value) })} />
        </td>
      ))}
      <td className="num px-3 py-2 text-right text-ink-3">{num(b.used_hour)} / {num(b.used_day)}</td>
      <td className="px-3 py-2 text-right">
        <Button size="sm" tone="primary" disabled={!changed} onClick={() => setOpen(true)}>保存</Button>
        <ReasonDialog
          open={open}
          title={`调整 ${b.service} 的请求上限`}
          description={`上限是付费请求的熔断：超过后请求暂停并按窗口重试。填 0 表示立即停用这个服务。${ADMIN.budgetNote ?? ""}`}
          confirmLabel="保存"
          busy={pending === "budget"}
          onClose={() => setOpen(false)}
          onSubmit={async (reason) => (await run("PUT", `/api/admin/budgets/${encodeURIComponent(b.service)}`, { ...v, reason }, { label: "budget", success: "上限已更新" })) !== null}
        />
      </td>
    </tr>
  );
}

function TargetToggle({ t }: { t: AdminSettings["targets"][number] }) {
  const { run, pending } = useAdminAction();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" tone={t.enabled ? "danger" : "primary"} onClick={() => setOpen(true)}>{t.enabled ? "停用" : "启用"}</Button>
      <ReasonDialog
        open={open}
        title={`${t.enabled ? "停用" : "启用"}：${t.note ?? t.key}`}
        description={t.enabled ? "停用后新的推送不再发往这个群。" : "启用时间会被记录：启用之前的内容不会补推。开发与彩排环境即使启用也不会真的发出。"}
        danger={t.enabled}
        confirmLabel={t.enabled ? "停用" : "启用"}
        busy={pending === "target"}
        onClose={() => setOpen(false)}
        onSubmit={async (reason) => (await run("POST", `/api/admin/notify-targets/${encodeURIComponent(t.key)}`, { enabled: !t.enabled, reason }, { label: "target", success: "已更新" })) !== null}
      />
    </>
  );
}

const SWITCHES = {
  collect: { label: "信源采集", on: "按计划抓取各信源的新内容", off: "已暂停：不再抓取新内容，已抓到的照常处理", env: "COLLECT_ENABLED" },
  models: { label: "模型调用", on: "预筛、评分、写作、归组、日报等都在调用模型", off: "已暂停：调用模型的工作排队等待，恢复后自动继续，不会算作失败", env: "MODEL_CALLS_ENABLED" },
} as const;

/** Pause and resume collection and model calls; the server's .env still has to allow them. */
function RunSwitches({ switches }: { switches: AdminSettings["switches"] }) {
  const { run, pending } = useAdminAction();
  const [target, setTarget] = useState<AdminSettings["switches"][number] | null>(null);
  return (
    <Card title="运行开关" className="mb-5">
      <div className="grid gap-3 sm:grid-cols-2">
        {switches.map((w) => {
          const meta = SWITCHES[w.name];
          return (
            <div key={w.name} className="flex items-start justify-between gap-3 rounded-card p-3 ring-1 ring-line">
              <div>
                <div className="flex items-center gap-2 text-[14px] font-medium text-ink">
                  {meta.label}
                  {!w.allowed ? <Badge tone="bad">服务器已禁用</Badge> : w.running ? <Badge tone="ok">运行中</Badge> : <Badge tone="warn">已暂停</Badge>}
                </div>
                <p className="mt-1 text-[12.5px] leading-5 text-ink-3">
                  {!w.allowed ? <>服务器 .env 里 <span className="font-mono">{meta.env}</span> 不是 true，后台不能打开。</> : w.running ? meta.on : meta.off}
                </p>
              </div>
              {w.allowed && <Button size="sm" tone={w.running ? "secondary" : "primary"} onClick={() => setTarget(w)}>{w.running ? "暂停" : "恢复"}</Button>}
            </div>
          );
        })}
      </div>
      <ReasonDialog
        open={!!target}
        title={target ? `${target.running ? "暂停" : "恢复"}${SWITCHES[target.name].label}` : ""}
        description="最多 15 秒内生效，不需要重启。"
        confirmLabel={target?.running ? "暂停" : "恢复"}
        busy={pending === "switch"}
        onClose={() => setTarget(null)}
        onSubmit={async (reason) => (await run("POST", `/api/admin/run-switches/${target!.name}`, { on: !target!.running, reason }, { label: "switch", success: target!.running ? "已暂停" : "已恢复" })) !== null}
      />
    </Card>
  );
}

const EMBEDDING_VENDORS: Array<{ name: string; baseUrl: string; model: string; dims: number }> = [
  { name: "硅基流动 bge-m3", baseUrl: "https://api.siliconflow.cn/v1", model: "BAAI/bge-m3", dims: 0 },
  { name: "阿里云百炼 text-embedding-v4", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "text-embedding-v4", dims: 1024 },
  { name: "OpenAI text-embedding-3-small", baseUrl: "https://api.openai.com/v1", model: "text-embedding-3-small", dims: 0 },
];

/** The embeddings service for grouping reports of one event (recall); the key is sealed and never shown again. */
function EmbeddingService({ e }: { e: AdminSettings["embedding"] }) {
  const { run, pending } = useAdminAction();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ baseUrl: "", model: "", dims: "0", apiKey: "", enabled: true });
  const [error, setError] = useState<string | null>(null);
  const [checked, setChecked] = useState<{ ok: boolean; ms: number; dims: number | null; error: string | null } | null>(null);
  const fromEnv = e.inUse?.source === "env";
  const edit = () => {
    const s = e.stored;
    setForm({ baseUrl: s?.baseUrl ?? "", model: s?.model ?? "", dims: String(s?.dims ?? 0), apiKey: "", enabled: s?.enabled ?? true });
    setError(null);
    setOpen(true);
  };
  return (
    <Card
      title="向量服务（事件归组）"
      className="mb-5"
      right={!fromEnv && <Button size="sm" tone={e.stored ? "secondary" : "primary"} onClick={edit}>{e.stored ? "编辑" : "配置"}</Button>}
    >
      <p className="text-[13px] leading-6 text-ink-3">
        把讲同一件事的多篇报道归到一起、算热度，靠文字向量判断相似。没有配置时只能按字面重合度判断，同一事件的报道常常归不到一起，热点榜会偏低。
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-[13px]">
        {e.inUse ? (
          <>
            <Badge tone="ok">使用中</Badge>
            <span className="font-mono text-[12px] text-ink-2">{e.inUse.model}</span>
            <span className="font-mono text-[11.5px] text-ink-4">{e.inUse.baseUrl}</span>
            {fromEnv && <Badge tone="info">服务器环境变量配置，页面只读</Badge>}
            {!fromEnv && e.stored && <span className="font-mono text-[11.5px] text-ink-3">密钥 {e.stored.keyHint}</span>}
          </>
        ) : e.stored && !e.stored.enabled ? (
          <Badge tone="warn">已停用</Badge>
        ) : e.stored ? (
          <Badge tone="bad" title="服务器的 SESSION_SECRET 变过，原来保存的密钥打不开">需重新填密钥</Badge>
        ) : (
          <Badge tone="warn">未配置</Badge>
        )}
        {e.inUse && (
          <Button size="sm" busy={pending === "embed-check"} onClick={async () => { const r = await run<{ ok: boolean; ms: number; dims: number | null; error: string | null }>("POST", "/api/admin/embedding/test", {}, { label: "embed-check", revalidate: false }); if (r) setChecked(r); }}>测试连通</Button>
        )}
      </div>
      {checked && <p className={`mt-2 text-[13px] ${checked.ok ? "text-ink-2" : "text-hot"}`}>{checked.ok ? `可用，返回 ${checked.dims} 维向量，耗时 ${(checked.ms / 1000).toFixed(1)} 秒。` : `调用失败：${checked.error}`}</p>}
      <ReasonDialog
        open={open}
        title={e.stored ? "编辑向量服务" : "配置向量服务"}
        description="保存后最多 30 秒内生效；之后新进来的报道开始用向量归组。换模型会让已有向量重新计算。"
        confirmLabel="保存"
        busy={pending === "embed"}
        onClose={() => setOpen(false)}
        onSubmit={async (reason) => {
          const dims = form.dims.trim() === "" ? 0 : Number(form.dims);
          if (!Number.isInteger(dims) || dims < 0) { setError("维度要写成非负整数；不确定就填 0，让模型自己决定"); return false; }
          setError(null);
          const r = await run("PUT", "/api/admin/embedding", { baseUrl: form.baseUrl, model: form.model, dims, ...(form.apiKey ? { apiKey: form.apiKey } : {}), enabled: form.enabled, reason }, { label: "embed", success: "已保存" });
          return r !== null;
        }}
      >
        <Field label="常用服务（自动填写地址、模型和维度）">
          <select className="h-9 w-full rounded-control bg-surface px-2.5 text-[13.5px] ring-1 ring-line-strong" value="" onChange={(ev) => { const v = EMBEDDING_VENDORS.find((x) => x.name === ev.target.value); if (v) setForm((f) => ({ ...f, baseUrl: v.baseUrl, model: v.model, dims: String(v.dims) })); }}>
            <option value="">选择后自动填写</option>
            {EMBEDDING_VENDORS.map((v) => <option key={v.name} value={v.name}>{v.name}</option>)}
          </select>
        </Field>
        <Field label="接口地址" hint="到 /embeddings 之前的部分"><Input value={form.baseUrl} onChange={(ev) => setForm((f) => ({ ...f, baseUrl: ev.target.value }))} placeholder="https://…/v1" /></Field>
        <Field label="模型名"><Input value={form.model} onChange={(ev) => setForm((f) => ({ ...f, model: ev.target.value }))} placeholder="例如 BAAI/bge-m3" /></Field>
        <Field label="向量维度" hint="0 表示用模型默认的维度（bge-m3 填 0）"><Input inputMode="numeric" value={form.dims} onChange={(ev) => setForm((f) => ({ ...f, dims: ev.target.value }))} /></Field>
        <Field label="API 密钥" hint={e.stored ? "不填就保留原来的密钥" : "只保存加密后的内容，保存后不能再查看"}>
          <Input type="password" autoComplete="off" value={form.apiKey} onChange={(ev) => setForm((f) => ({ ...f, apiKey: ev.target.value.trim() }))} placeholder={e.stored ? "不修改请留空" : "sk-…"} />
        </Field>
        <label className="inline-flex items-center gap-2 text-[13px] text-ink-2"><input type="checkbox" checked={form.enabled} onChange={(ev) => setForm((f) => ({ ...f, enabled: ev.target.checked }))} />启用</label>
        {error && <p role="alert" className="text-[13px] text-hot">{error}</p>}
      </ReasonDialog>
    </Card>
  );
}

export default function SettingsAdmin({ loaderData: s }: Route.ComponentProps) {
  return (
    <AdminPage title="设置" subtitle="不改代码即可替换的运营设置。每次修改都写入审计记录。">
      <RunSwitches switches={s.switches} />
      <EmbeddingService e={s.embedding} />
      <div className="grid gap-5 xl:grid-cols-2">
        <Card title="关于页二维码">
          <div className="space-y-5">
            <QrSlot slot="wechatQr" label="微信公众号二维码" src={s.contact.wechatQr} />
            <QrSlot slot="feishuQr" label="飞书群二维码" src={s.contact.feishuQr} />
          </div>
        </Card>
        <Card title="通知目的地" pad={false}>
          <DataTable
            rows={s.targets}
            rowKey={(t) => t.key}
            columns={[
              { key: "k", label: "目的地", render: (t) => <div><div className="font-medium text-ink">{t.note ?? t.key}</div><div className="font-mono text-[11.5px] text-ink-4">{t.key} · {t.config_ref}</div></div> },
              { key: "e", label: "状态", render: (t) => (t.enabled ? <Badge tone="ok">启用于 {bj(t.enabled_at)}</Badge> : <Badge>停用</Badge>) },
              { key: "d", label: "7 天投递", align: "right", render: (t) => num(t.deliveries_7d) },
              { key: "a", label: "", align: "right", render: (t) => <TargetToggle t={t} /> },
            ]}
          />
        </Card>
      </div>
      <Card className="mt-5" title="付费请求上限" right={<span>已用：近 1 小时 / 近 24 小时</span>} pad={false}>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-[13px]">
            <thead>
              <tr className="border-b border-line text-left text-[12px] text-ink-3">
                <th className="px-3 py-2 font-medium">服务</th>
                <th className="px-3 py-2 font-medium">每分钟</th>
                <th className="px-3 py-2 font-medium">每小时</th>
                <th className="px-3 py-2 font-medium">每天</th>
                <th className="px-3 py-2 text-right font-medium">已用</th>
                <th />
              </tr>
            </thead>
            <tbody>{s.budgets.map((b) => <BudgetRow key={`${b.service}-${b.updated_at}`} b={b} />)}</tbody>
          </table>
        </div>
      </Card>
    </AdminPage>
  );
}
