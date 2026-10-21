import { useState } from "react";
import { Link } from "react-router";
import type { Route } from "./+types/models";
import type { AdminModels } from "@aihot/contracts/admin";
import { SITE } from "@aihot/site";
import { adminGet } from "../../lib/admin.server";
import { useAdminAction } from "../../features/admin/action";
import { bj, money, num } from "../../features/admin/format";
import { AdminPage, Badge, Button, Card, DataTable, Empty, Field, FilterChips, Input, ReasonDialog, Select, Textarea } from "../../features/admin/ui";
import { webModules } from "../../site-modules";



export async function loader({ request }: Route.LoaderArgs) {
  const days = new URL(request.url).searchParams.get("days") ?? "7";
  return adminGet<AdminModels>(request, `/api/admin/models?days=${encodeURIComponent(days)}`);
}

export const meta: Route.MetaFunction = () => [{ title: `模型与评测 · ${SITE.name} 后台` }];

const SOURCE_LABEL = { admin: "后台切换", env: "环境变量", default: "代码默认" } as const;

/** A cost the provider did not report and no price covers: a link to the prices when a module keeps them. */
function Unpriced() {
  const prices = webModules().find((m) => m.admin?.prices)?.admin?.prices;
  if (prices) return <Link to={prices} className="whitespace-nowrap text-ink-4 hover:text-accent">未定价</Link>;
  return <span className="whitespace-nowrap text-ink-4" title="服务商没有返回费用，按 token 数和你的模型单价自己估算">未定价</span>;
}
type Provider = AdminModels["providers"][number];
interface ProviderForm { key: string; label: string; model: string; baseUrl: string; apiKey: string; extra: string; reasoningTokens: string; maxConcurrency: string; jsonMode: boolean; vision: boolean; enabled: boolean }
const BLANK: ProviderForm = { key: "", label: "", model: "", baseUrl: "", apiKey: "", extra: "", reasoningTokens: "", maxConcurrency: "", jsonMode: true, vision: false, enabled: true };
// Addresses of common OpenAI-compatible services; the page only fills the address in, the model name and key are the admin's.
const VENDORS: Array<{ name: string; baseUrl: string }> = [
  { name: "硅基流动", baseUrl: "https://api.siliconflow.cn/v1" },
  { name: "阿里云百炼", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1" },
  { name: "智谱", baseUrl: "https://open.bigmodel.cn/api/paas/v4" },
  { name: "月之暗面 Kimi", baseUrl: "https://api.moonshot.cn/v1" },
  { name: "火山方舟", baseUrl: "https://ark.cn-beijing.volces.com/api/v3" },
  { name: "DeepSeek", baseUrl: "https://api.deepseek.com/v1" },
  { name: "OpenAI", baseUrl: "https://api.openai.com/v1" },
];
const toForm = (p: Provider): ProviderForm => ({
  key: p.key, label: p.label, model: p.model, baseUrl: p.baseUrl, apiKey: "", extra: p.extra ? JSON.stringify(p.extra) : "",
  reasoningTokens: p.reasoningTokens ? String(p.reasoningTokens) : "", maxConcurrency: p.maxConcurrency ? String(p.maxConcurrency) : "", jsonMode: p.jsonMode, vision: p.vision, enabled: p.enabled,
});
const secs = (ms: number | null) => (ms == null ? "—" : ms >= 10_000 ? `${Math.round(ms / 1000)} s` : `${(ms / 1000).toFixed(1)} s`);

export default function ModelsAdmin({ loaderData: m }: Route.ComponentProps) {
  const { run, pending } = useAdminAction();
  const [target, setTarget] = useState<AdminModels["capabilities"][number] | null>(null);
  const [choice, setChoice] = useState<string>("");
  // Whole-site provider change: pick a model, test it, then move every step to it.
  const [all, setAll] = useState<string>(m.choices[0]?.key ?? "default");
  const [allOpen, setAllOpen] = useState(false);
  const [checked, setChecked] = useState<{ model: string; ok: boolean; ms: number; error: string | null } | null>(null);
  // Providers entered on this page: add, edit, stop, remove.
  const [form, setForm] = useState<{ isNew: boolean; values: ProviderForm } | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [toggling, setToggling] = useState<Provider | null>(null);
  const [removing, setRemoving] = useState<Provider | null>(null);
  const setField = <K extends keyof ProviderForm>(name: K, value: ProviderForm[K]) => setForm((f) => (f ? { ...f, values: { ...f.values, [name]: value } } : f));
  const testModelKey = async (model: string) => {
    setAll(model);
    const r = await run<{ model: string; ok: boolean; ms: number; error: string | null }>("POST", "/api/admin/model-test", { model }, { label: "check", revalidate: false });
    if (r) setChecked(r);
  };
  const labelOf = (key: string) => m.capabilities.find((c) => `capability:${c.key}` === key)?.label ?? key;

  return (
    <AdminPage
      title="模型与评测"
      subtitle="每项能力当前用哪个模型、来自哪里（后台切换 > 环境变量 > 代码默认），以及近期的成功率、耗时与费用。切换只影响之后的新任务，已有结果不重算；换精选模型前先看 SelectBench 同批对比。"
      actions={<FilterChips param="days" options={[{ value: "1", label: "24 小时" }, { value: "", label: "7 天" }, { value: "30", label: "30 天" }]} />}
    >
      <Card
        title="模型服务商"
        className="mb-5"
        right={<Button size="sm" tone="primary" onClick={() => { setFormError(null); setForm({ isNew: true, values: BLANK }); }}>添加服务商</Button>}
        pad={false}
      >
        <p className="px-4 pt-3 text-[13px] leading-6 text-ink-3">
          任何 OpenAI 兼容的接口都可以加。密钥加密保存在服务器上，保存后页面看不到、只能重新填写；每次改动都写入审计记录。
        </p>
        {m.providers.length ? (
          <DataTable
            dense
            rows={m.providers}
            rowKey={(p) => p.key}
            columns={[
              { key: "n", label: "名称", render: (p) => <span className="whitespace-nowrap">{p.label}<span className="ml-1.5 font-mono text-[11.5px] text-ink-4">{p.key}</span></span> },
              { key: "m", label: "模型", render: (p) => <span className="font-mono text-[12px]">{p.model}{p.maxConcurrency ? <span className="ml-1.5 text-ink-4">并发 ≤{p.maxConcurrency}</span> : null}</span> },
              { key: "u", label: "地址", render: (p) => <span className="font-mono text-[11.5px] text-ink-3">{p.baseUrl || "—"}</span> },
              { key: "k", label: "密钥", render: (p) => (p.keyReadable ? <span className="font-mono text-[11.5px] text-ink-3">{p.keyHint}</span> : <Badge tone="bad" title="服务器的 SESSION_SECRET 变过，原来保存的密钥打不开，请重新填写">需重新填密钥</Badge>) },
              { key: "s", label: "状态", render: (p) => (p.source === "env" ? <Badge tone="info" title="在服务器的 MODEL_PROVIDERS 里配置，页面只能看和测试">环境变量</Badge> : p.enabled ? <Badge tone="ok">启用</Badge> : <Badge tone="muted">已停用</Badge>) },
              { key: "y", label: "在用的步骤", render: (p) => (p.usedBy.length ? <span className="text-[12px] text-ink-2">{p.usedBy.join("、")}</span> : <span className="text-ink-4">—</span>) },
              {
                key: "a",
                label: "",
                align: "right",
                render: (p) => (
                  <span className="inline-flex gap-1.5">
                    <Button size="sm" busy={pending === "check"} disabled={!p.enabled || !p.keyReadable} onClick={() => testModelKey(p.key)}>测试</Button>
                    {p.source === "admin" && <Button size="sm" onClick={() => { setFormError(null); setForm({ isNew: false, values: toForm(p) }); }}>编辑</Button>}
                    {p.source === "admin" && <Button size="sm" onClick={() => setToggling(p)}>{p.enabled ? "停用" : "启用"}</Button>}
                    {p.source === "admin" && <Button size="sm" tone="danger" onClick={() => setRemoving(p)}>删除</Button>}
                  </span>
                ),
              },
            ]}
          />
        ) : (
          <Empty>还没有添加服务商。点右上角“添加服务商”，填地址、模型名和密钥即可。</Empty>
        )}
      </Card>

      <Card title="更换模型服务商（整体切换）" className="mb-5">
        <p className="mb-3 text-[13px] leading-6 text-ink-3">
          当前服务商额度用完或要换一家时：先“测试连通”确认地址、密钥和余额可用，再“全部步骤切换”。
        </p>
        {m.providersError && (
          <p className="mb-3 text-[13px] leading-6 text-hot">
            <span className="font-mono">MODEL_PROVIDERS</span> 配置有误，其中的模型没有加载：{m.providersError}
          </p>
        )}
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-[260px]">
            <Field label="模型">
              <Select value={all} onChange={(e) => { setAll(e.target.value); setChecked(null); }}>
                {m.choices.map((x) => <option key={x.key} value={x.key}>{x.key}（{x.service}）</option>)}
              </Select>
            </Field>
          </div>
          <Button busy={pending === "check"} onClick={async () => { const r = await run<{ model: string; ok: boolean; ms: number; error: string | null }>("POST", "/api/admin/model-test", { model: all }, { label: "check", revalidate: false }); if (r) setChecked(r); }}>测试连通</Button>
          <Button tone="primary" disabled={checked?.model !== all || !checked.ok} title={checked?.ok ? undefined : "先测试连通"} onClick={() => setAllOpen(true)}>全部步骤切换到它</Button>
        </div>
        {checked && (
          <p className={`mt-3 text-[13px] ${checked.ok ? "text-ink-2" : "text-hot"}`}>
            {checked.ok ? `${checked.model} 可用，耗时 ${secs(checked.ms)}。` : `${checked.model} 调用失败：${checked.error}`}
          </p>
        )}
      </Card>

      <div className="grid grid-cols-1 gap-5">
        {m.capabilities.map((c) => {
          const total = c.usage.reduce((a, u) => a + u.calls, 0);
          return (
            <Card
              key={c.key}
              title={
                <span className="inline-flex flex-wrap items-center gap-2">
                  {c.label}
                  <span className="font-mono text-[12px] font-normal text-ink-3 [overflow-wrap:anywhere]">{c.current.model}</span>
                  <Badge tone={c.current.source === "admin" ? "accent" : "muted"}>{SOURCE_LABEL[c.current.source]}</Badge>
                  {c.fallback && <span className="text-xs font-normal text-ink-3">
                    备用 {c.fallback.model} · {c.fallback.primaryPaused
                      ? c.fallback.backupPaused ? "主备均暂停，等待恢复" : "正在接续"
                      : c.fallback.backupPaused ? "暂不可用" : "就绪"}
                    {c.fallback.nextProbeAt && ` · ${bj(c.fallback.nextProbeAt)} 后随新请求复查主模型`}
                  </span>}
                </span>
              }
              right={
                <Button
                  size="sm"
                  onClick={() => {
                    setTarget(c);
                    setChoice(c.current.model);
                  }}
                >
                  切换
                </Button>
              }
              pad={false}
            >
              {c.usage.length ? (
                <DataTable
                  dense
                  rows={c.usage}
                  rowKey={(u) => `${u.purpose}|${u.model}|${u.promptVersion}`}
                  columns={[
                    { key: "m", label: "模型", render: (u) => <span className="whitespace-nowrap font-mono text-[12px]">{u.model}</span> },
                    { key: "v", label: "提示版本", render: (u) => <span className="whitespace-nowrap font-mono text-[11.5px] text-ink-3">{u.promptVersion ?? "—"}</span> },
                    { key: "p", label: "用途", render: (u) => <span className="whitespace-nowrap font-mono text-[11.5px] text-ink-3">{u.purpose}</span> },
                    { key: "c", label: "调用", align: "right", render: (u) => num(u.calls) },
                    {
                      key: "ok",
                      label: "成功率",
                      align: "right",
                      render: (u) => {
                        const rate = u.calls ? u.ok / u.calls : 0;
                        return <span className={rate < 0.95 ? "text-hot" : ""} title={`失败 ${u.failed} · 结果未知 ${u.unknown}`}>{`${Math.round(rate * 1000) / 10}%`}</span>;
                      },
                    },
                    { key: "l", label: "耗时 p50 / p95", align: "right", render: (u) => <span className="whitespace-nowrap">{`${secs(u.p50)} / ${secs(u.p95)}`}</span> },
                    { key: "t", label: "输入 / 输出 token", align: "right", render: (u) => <span className="whitespace-nowrap">{`${num(u.tokensIn)} / ${num(u.tokensOut)}`}</span> },
                    {
                      key: "$",
                      label: "费用",
                      align: "right",
                      render: (u) =>
                        u.actualCost !== null ? (
                          `${money(u.actualCost)}${u.currency && u.currency !== "CNY" ? ` ${u.currency}` : ""}`
                        ) : u.estimate ? (
                          <span title="按用量 × 单价推算">≈ {money(u.estimate.amount)}{u.estimate.currency !== "CNY" ? ` ${u.estimate.currency}` : ""}</span>
                        ) : (
                          <Unpriced />
                        ),
                    },
                  ]}
                />
              ) : (
                <Empty>{m.days} 天内没有调用{total === 0 && c.vision ? "（只在有图片时使用）" : ""}</Empty>
              )}
            </Card>
          );
        })}
      </div>

      <div className="mt-5 grid grid-cols-1 gap-5 xl:grid-cols-2">
        <Card title="切换记录" pad={false}>
          {m.history.length ? (
            <DataTable
              dense
              rows={m.history}
              rowKey={(h) => `${h.at}|${h.subject}`}
              columns={[
                { key: "at", label: "时间", render: (h) => <span className="num whitespace-nowrap">{bj(h.at)}</span> },
                { key: "c", label: "能力", render: (h) => labelOf(h.subject) },
                { key: "m", label: "变化", render: (h) => <span className="font-mono text-[12px]">{h.before?.model ?? "—"} → {h.after?.model ?? "—"}</span> },
                { key: "r", label: "原因", render: (h) => (h.reason ? <span className="text-ink-3">{h.reason}</span> : <span className="text-ink-4">—</span>) },
                { key: "a", label: "操作人", render: (h) => h.actor },
              ]}
            />
          ) : (
            <Empty>还没有在后台切换过模型</Empty>
          )}
        </Card>
        <Card title="同批样本对比（SelectBench）" right={<Link to="/admin/selectbench" className="text-accent">全部运行</Link>} pad={false}>
          {m.benches.length ? (
            <DataTable
              dense
              rows={m.benches}
              rowKey={(b) => b.id}
              columns={[
                { key: "l", label: "运行", render: (b) => <Link to={`/admin/selectbench/${b.id}`} className="text-ink hover:text-accent">{b.label}</Link> },
                { key: "m", label: "模型", render: (b) => <span className="font-mono text-[11.5px] text-ink-3">{b.models.join("、")}</span> },
                { key: "n", label: "样本", align: "right", render: (b) => num(b.sample_size) },
                { key: "at", label: "时间", render: (b) => <span className="num whitespace-nowrap">{bj(b.created_at)}</span> },
              ]}
            />
          ) : (
            <Empty>还没有导入对比运行</Empty>
          )}
        </Card>
      </div>

      <ReasonDialog
        open={!!form}
        title={form?.isNew ? "添加模型服务商" : `编辑：${form?.values.key ?? ""}`}
        description="保存后立即可以测试；worker 最多 30 秒内也会用上。"
        confirmLabel="保存"
        busy={pending === "provider"}
        onClose={() => setForm(null)}
        onSubmit={async (reason) => {
          if (!form) return false;
          const v = form.values;
          let extra: Record<string, unknown> | null = null;
          if (v.extra.trim()) {
            try {
              const parsed = JSON.parse(v.extra);
              if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
              extra = parsed;
            } catch { setFormError("额外请求字段要写成 JSON 对象，例如 {\"enable_thinking\": false}"); return false; }
          }
          const tokens = v.reasoningTokens.trim();
          if (tokens && !/^\d+$/.test(tokens)) { setFormError("推理额度要写成非负整数，例如 4000"); return false; }
          const concurrency = v.maxConcurrency.trim();
          if (concurrency && !/^([1-9]|[1-5]\d|6[0-4])$/.test(concurrency)) { setFormError("最大并发要写成 1–64 的整数，不限制就留空"); return false; }
          setFormError(null);
          const body = {
            label: v.label, model: v.model, baseUrl: v.baseUrl, ...(v.apiKey ? { apiKey: v.apiKey } : {}), extra,
            reasoningTokens: tokens ? Number(tokens) : null, maxConcurrency: concurrency ? Number(concurrency) : null, jsonMode: v.jsonMode, vision: v.vision, enabled: v.enabled, reason,
          };
          const r = await run("PUT", `/api/admin/model-providers/${encodeURIComponent(v.key)}`, body, { label: "provider", success: form.isNew ? "已添加" : "已保存" });
          return r !== null;
        }}
      >
        {form && (
          <>
            {form.isNew && (
              <Field label="常用服务商（只填地址）">
                <Select value="" onChange={(e) => { const vendor = VENDORS.find((x) => x.baseUrl === e.target.value); if (vendor) { setField("baseUrl", vendor.baseUrl); if (!form.values.label) setField("label", vendor.name); } }}>
                  <option value="">选择后自动填写下面的地址</option>
                  {VENDORS.map((x) => <option key={x.baseUrl} value={x.baseUrl}>{x.name}</option>)}
                </Select>
              </Field>
            )}
            <Field label="标识" hint="小写字母、数字、. _ -，创建后不能改；在模型下拉里显示这个名字">
              <Input value={form.values.key} disabled={!form.isNew} onChange={(e) => setField("key", e.target.value.trim().toLowerCase())} placeholder="例如 sf-deepseek" maxLength={49} />
            </Field>
            <Field label="名称"><Input value={form.values.label} onChange={(e) => setField("label", e.target.value)} placeholder="例如 硅基流动 DeepSeek" maxLength={60} /></Field>
            <Field label="接口地址" hint="到 /chat/completions 之前的部分，例如 https://api.siliconflow.cn/v1">
              <Input value={form.values.baseUrl} onChange={(e) => setField("baseUrl", e.target.value)} placeholder="https://…/v1" />
            </Field>
            <Field label="模型名" hint="服务商文档里的模型 ID，例如 deepseek-ai/DeepSeek-V3">
              <Input value={form.values.model} onChange={(e) => setField("model", e.target.value)} />
            </Field>
            <Field label="API 密钥" hint={form.isNew ? "只保存加密后的内容，保存后不能再查看" : "不填就保留原来的密钥；填了会替换"}>
              <Input type="password" autoComplete="off" value={form.values.apiKey} onChange={(e) => setField("apiKey", e.target.value.trim())} placeholder={form.isNew ? "sk-…" : "不修改请留空"} />
            </Field>
            <div className="flex flex-wrap gap-x-5 gap-y-2 text-[13px] text-ink-2">
              <label className="inline-flex items-center gap-2"><input type="checkbox" checked={form.values.jsonMode} onChange={(e) => setField("jsonMode", e.target.checked)} />支持 JSON 模式</label>
              <label className="inline-flex items-center gap-2"><input type="checkbox" checked={form.values.vision} onChange={(e) => setField("vision", e.target.checked)} />能看图</label>
              <label className="inline-flex items-center gap-2"><input type="checkbox" checked={form.values.enabled} onChange={(e) => setField("enabled", e.target.checked)} />启用</label>
            </div>
            <Field label="额外请求字段（可选，JSON）" hint="比如关掉推理：{&quot;enable_thinking&quot;: false}">
              <Textarea rows={2} value={form.values.extra} onChange={(e) => setField("extra", e.target.value)} />
            </Field>
            <Field label="最大并发（可选）" hint="同时最多发几个请求；服务商报 429、Concurrency limit exceeded 时填，例如 4。留空不限制">
              <Input inputMode="numeric" value={form.values.maxConcurrency} onChange={(e) => setField("maxConcurrency", e.target.value)} />
            </Field>
            <Field label="推理额度（可选）" hint="推理模型先想再答，额外给推理留的输出 token；调用报 finish_reason=length 时填，例如 4000">
              <Input inputMode="numeric" value={form.values.reasoningTokens} onChange={(e) => setField("reasoningTokens", e.target.value)} />
            </Field>
            {formError && <p role="alert" className="text-[13px] text-hot">{formError}</p>}
          </>
        )}
      </ReasonDialog>

      <ReasonDialog
        open={!!toggling}
        title={`${toggling?.enabled ? "停用" : "启用"}：${toggling?.label ?? ""}`}
        description={toggling?.enabled && toggling.usedBy.length ? `正在被这些步骤使用：${toggling.usedBy.join("、")}。停用后它们会回到各自的默认模型。` : "停用后不会再被调用，随时可以重新启用。"}
        confirmLabel={toggling?.enabled ? "停用" : "启用"}
        busy={pending === "provider"}
        onClose={() => setToggling(null)}
        onSubmit={async (reason) => {
          if (!toggling) return false;
          const p = toggling;
          const r = await run("PUT", `/api/admin/model-providers/${encodeURIComponent(p.key)}`, {
            label: p.label, model: p.model, baseUrl: p.baseUrl, extra: p.extra, reasoningTokens: p.reasoningTokens, maxConcurrency: p.maxConcurrency, jsonMode: p.jsonMode, vision: p.vision, enabled: !p.enabled, reason,
          }, { label: "provider", success: p.enabled ? "已停用" : "已启用" });
          return r !== null;
        }}
      />

      <ReasonDialog
        open={!!removing}
        danger
        title={`删除：${removing?.label ?? ""}`}
        description={removing?.usedBy.length ? `还有步骤在用它：${removing.usedBy.join("、")}。先把这些步骤切换到别的模型，才能删除。` : "删除后密钥也一并删除，不能恢复。"}
        confirmLabel="删除"
        busy={pending === "provider"}
        onClose={() => setRemoving(null)}
        onSubmit={async (reason) => (await run("POST", `/api/admin/model-providers/${encodeURIComponent(removing!.key)}/delete`, { reason }, { label: "provider", success: "已删除" })) !== null}
      />

      <ReasonDialog
        open={allOpen}
        title={`全部步骤切换到 ${all}`}
        description="每一步各记一条切换记录，只影响之后的新任务；需要看图的步骤，模型不支持时会跳过。之后可逐步骤再调整。"
        confirmLabel="全部切换"
        busy={pending === "all"}
        onClose={() => setAllOpen(false)}
        onSubmit={async (reason) => {
          const r = await run<{ switched: string[]; skipped: string[] }>("POST", "/api/admin/model-switch-all", { model: all, reason }, { label: "all", success: "已切换，下一次调用生效" });
          return r !== null;
        }}
      />

      <ReasonDialog
        open={!!target}
        title={`切换模型：${target?.label ?? ""}`}
        description="只影响之后的新任务。选“恢复默认”会回到环境变量或代码默认。"
        confirmLabel="切换"
        busy={pending === "switch"}
        onClose={() => setTarget(null)}
        onSubmit={async (reason) =>
          (await run("POST", `/api/admin/models/${target!.key}`, { model: choice === "__default" ? null : choice, reason }, { label: "switch", success: "已切换，下一次调用生效" })) !== null
        }
      >
        <Field label="模型">
          <Select value={choice} onChange={(e) => setChoice(e.target.value)}>
            {m.choices
              .filter((x) => !target?.vision || x.vision)
              .map((x) => (
                <option key={x.key} value={x.key}>
                  {x.key}（{x.service}）
                </option>
              ))}
            <option value="__default">恢复默认（{target?.env} 或 {target?.defaultModel}）</option>
          </Select>
        </Field>
      </ReasonDialog>
    </AdminPage>
  );
}
