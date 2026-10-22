// 后台“频道设置”：招标商机、政策动态、行业热点的标题、介绍和筛选项。筛选项每行一组，写成“行名：项、项、项”，
// 一项是词表里的标签，或者“显示名=标签”“显示名=搜:关键词”。行业热点的热门话题是自动的，这里不用写。
import { useState } from "react";
import { useLoaderData, type LoaderFunctionArgs } from "react-router";
import { adminGet } from "@aihot/web/lib/admin.server";
import { useAdminAction } from "@aihot/web/features/admin/action";
import { AdminPage, Badge, Button, Card, Field, Input, ReasonDialog, Textarea } from "@aihot/web/features/admin/ui";
import type { ChannelKey, ChannelText, ChipRow } from "../channels.ts";

interface AdminChannel { key: ChannelKey; path: string; defaults: ChannelText; current: ChannelText; customized: boolean }

export async function loader({ request }: LoaderFunctionArgs) {
  return adminGet<{ channels: AdminChannel[]; tags: string[] }>(request, "/api/admin/channels");
}
export const meta = () => [{ title: "频道设置" }, { name: "robots", content: "noindex, nofollow" }];

function formatRows(rows: ChipRow[]): string {
  return rows.map((r) => `${r.label}：${r.chips.map((c) => (c.q ? `${c.label}=搜:${c.q}` : c.label === c.tag ? c.tag : `${c.label}=${c.tag}`)).join("、")}`).join("\n");
}

function parseRows(text: string): ChipRow[] {
  return text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((line) => {
    const [label, ...rest] = line.split(/[:：]/);
    const chips = rest.join("：").split(/[、,，]/).map((i) => i.trim()).filter(Boolean).map((item) => {
      const [name, ...value] = item.split("=");
      if (!value.length) return { label: name!.trim(), tag: name!.trim() };
      const target = value.join("=").trim();
      const q = /^搜[:：]/.test(target) ? target.replace(/^搜[:：]/, "").trim() : null;
      return q ? { label: name!.trim(), q } : { label: name!.trim(), tag: target };
    });
    return { label: (label ?? "").trim(), chips };
  });
}

function ChannelForm({ c, onSave, onReset }: { c: AdminChannel; onSave: (text: ChannelText) => void; onReset: () => void }) {
  const [title, setTitle] = useState(c.current.title);
  const [lead, setLead] = useState(c.current.lead);
  const [rows, setRows] = useState(formatRows(c.current.rows));
  return (
    <Card
      title={<span className="inline-flex items-center gap-2">{c.current.title}<span className="font-mono text-[12px] text-ink-4">{c.path}</span>{c.customized ? <Badge tone="info">已改过</Badge> : <Badge tone="muted">默认</Badge>}</span>}
      right={c.customized ? <Button size="sm" onClick={onReset}>恢复默认</Button> : undefined}
      className="mb-5"
    >
      <div className="grid gap-3">
        <Field label="标题" hint="页面上的大标题，最多 12 个字；侧栏和手机底栏的名字不随它变"><Input value={title} maxLength={12} onChange={(e) => setTitle(e.target.value)} /></Field>
        <Field label="介绍" hint="标题下面的一段话，最多 200 个字"><Textarea rows={2} value={lead} maxLength={200} onChange={(e) => setLead(e.target.value)} /></Field>
        <Field label="筛选项" hint="每行一组：“行名：项、项、项”。一项写词表里的标签；要换个显示名写“显示名=标签”；按关键词搜写“显示名=搜:关键词”。最多 4 行，每行最多 12 项">
          <Textarea rows={Math.max(3, c.current.rows.length + 1)} value={rows} onChange={(e) => setRows(e.target.value)} className="font-mono text-[12.5px]" />
        </Field>
        <div className="flex justify-end">
          <Button tone="primary" onClick={() => onSave({ title, lead, rows: parseRows(rows) })}>保存</Button>
        </div>
      </div>
    </Card>
  );
}

export default function ChannelsAdmin() {
  const { channels, tags } = useLoaderData<typeof loader>();
  const { run, pending } = useAdminAction();
  const [action, setAction] = useState<{ key: ChannelKey; text: ChannelText | null } | null>(null);

  return (
    <AdminPage title="频道设置" subtitle="招标商机、政策动态、行业热点三个频道的标题、介绍和筛选项。保存后一分钟内生效。">
      {channels.map((c) => (
        <ChannelForm key={`${c.key}:${c.customized}:${JSON.stringify(c.current)}`} c={c}
          onSave={(text) => setAction({ key: c.key, text })} onReset={() => setAction({ key: c.key, text: null })} />
      ))}
      <Card title="能用的标签" className="mb-5">
        <p className="mb-2 text-[12.5px] text-ink-3">筛选项里的标签必须是下面这些（模型给每条资料打的就是这些词）。没有合适标签的，用“显示名=搜:关键词”。</p>
        <div className="flex flex-wrap gap-1.5">{tags.map((t) => <span key={t} className="rounded-mark bg-bg-sunk px-1.5 py-0.5 text-[12px] text-ink-2">{t}</span>)}</div>
      </Card>
      <ReasonDialog
        open={action !== null}
        title={action?.text ? "保存频道设置" : "恢复默认设置"}
        description="写一句原因，会记进审计日志。"
        busy={pending === "channels"}
        onClose={() => setAction(null)}
        onSubmit={async (reason) => {
          if (!action) return false;
          const path = action.text ? `/api/admin/channels/${action.key}` : `/api/admin/channels/${action.key}/reset`;
          return (await run("POST", path, action.text ? { text: action.text, reason } : { reason }, { label: "channels", success: "已保存" })) !== null;
        }}
      />
    </AdminPage>
  );
}
