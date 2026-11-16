// 后台“投标商机”的推送群：每天 08:30、17:30 各推一期盲投信息表；每个钉钉群推哪些业务方向和平台、要不要待确认，以及要 @ 的提醒人。
// 修改时 Webhook 和密钥留空就沿用原来的；页面上只看得到 Webhook 末尾几位。
import { useState, type ReactNode } from "react";
import { useAdminAction } from "@aihot/web/features/admin/action";
import { Badge, Button, Card, DataTable, Empty, Field, Input, ReasonDialog, Textarea, Time } from "@aihot/web/features/admin/ui";
import type { PlatformOption, PushGroup, PushGroupInput, PushMention } from "../types.ts";

const BLANK: PushGroupInput = { name: "", webhook: "", secret: "", enabled: true, lines: [], sources: [], includeMaybe: true, mentions: [] };

const formatMentions = (ms: PushMention[]) => ms.map((m) => `${m.name} ${m.mobile}${m.lines.length ? `：${m.lines.join("、")}` : ""}`).join("\n");

/** 每行一人：“姓名 手机号：方向、方向”，不写方向就是所有方向。方向要是业务口径里有的。 */
function parseMentions(text: string, known: string[]): { mentions: PushMention[]; error: string | null } {
  const mentions: PushMention[] = [];
  for (const [i, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line) continue;
    const m = /^(.+?)[\s,，]+(\d{11})\s*(?:[:：]\s*(.*))?$/.exec(line);
    if (!m) return { mentions, error: `提醒人第 ${i + 1} 行要写成“姓名 手机号：方向、方向”` };
    const lines = (m[3] ?? "").split(/[、,，;；]/).map((s) => s.trim()).filter(Boolean);
    const unknown = lines.find((l) => !known.includes(l));
    if (unknown) return { mentions, error: `提醒人第 ${i + 1} 行的方向“${unknown}”不在业务口径里` };
    mentions.push({ name: m[1]!.trim(), mobile: m[2]!, lines });
  }
  return { mentions, error: null };
}

const toggle = <T,>(list: T[], value: T, on: boolean) => (on ? [...list, value] : list.filter((v) => v !== value));

function Check({ checked, onChange, children }: { checked: boolean; onChange: (on: boolean) => void; children: ReactNode }) {
  return (
    <label className="inline-flex items-center gap-1.5 text-[13px] text-ink-2">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {children}
    </label>
  );
}

/** 平台的名称；以前的“其他招采平台”选项（web）已拆成各个平台，提示重选。 */
const platformName = (key: string, platforms: PlatformOption[]) =>
  platforms.find((p) => p.key === key)?.label ?? (key === "web" ? "其他招采平台（旧选项，请改选具体平台）" : key);

function scope(g: PushGroup, platforms: PlatformOption[]) {
  return [
    g.lines.length ? g.lines.join("、") : "全部方向",
    g.sources.length ? g.sources.map((s) => platformName(s, platforms)).join("、") : "全部来源",
    g.includeMaybe ? "含待确认" : "只推相关",
  ].join(" · ");
}

type Draft = { id: number | null; input: PushGroupInput; mentionsText: string };
type Action = { kind: "save"; id: number | null; input: PushGroupInput } | { kind: "delete"; group: PushGroup };

export function PushGroups({ groups, lines, platforms, pushEnabled }: { groups: PushGroup[]; lines: string[]; platforms: PlatformOption[]; pushEnabled: boolean }) {
  const { run, pending } = useAdminAction();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [action, setAction] = useState<Action | null>(null);

  const edit = (g: PushGroup | null) => {
    setError(null);
    setDraft(g
      ? { id: g.id, input: { ...BLANK, ...g, webhook: "", secret: "" }, mentionsText: formatMentions(g.mentions) }
      : { id: null, input: BLANK, mentionsText: "" });
  };
  const set = (patch: Partial<PushGroupInput>) => setDraft((d) => d && { ...d, input: { ...d.input, ...patch } });
  const save = () => {
    if (!draft) return;
    const { mentions, error } = parseMentions(draft.mentionsText, lines);
    const input = { ...draft.input, mentions };
    const problem = error
      ?? (!input.name.trim() ? "填一个群名，方便认出是哪个群" : null)
      ?? (draft.id === null && !input.webhook.trim() ? "填机器人的 Webhook 地址" : null)
      ?? (draft.id === null && !input.secret.trim() ? "填机器人的加签密钥" : null);
    setError(problem);
    if (!problem) setAction({ kind: "save", id: draft.id, input });
  };
  // 业务口径改过以后，群里原来选的方向（和已经没有公告的平台）也列出来，方便取消。
  const options = draft ? [...new Set([...lines, ...draft.input.lines])] : lines;
  const sourceOptions = draft ? [...new Set([...platforms.map((p) => p.key), ...draft.input.sources])] : [];

  return (
    <Card title={`推送群（${groups.length}）`} className="mb-5" pad={false} right={!draft && <Button size="sm" onClick={() => edit(null)}>添加推送群</Button>}>
      {groups.length ? (
        <DataTable
          dense
          rows={groups}
          rowKey={(g) => g.id}
          columns={[
            {
              key: "n", label: "群",
              render: (g) => (
                <div className="min-w-[140px]">
                  <div className="font-medium text-ink">{g.name}</div>
                  <div className="mt-0.5 font-mono text-[11.5px] text-ink-4">{g.webhookHint}</div>
                </div>
              ),
            },
            {
              key: "s", label: "推什么",
              render: (g) => (
                <div className="min-w-[220px] text-[12.5px] leading-relaxed text-ink-2">
                  <div>{scope(g, platforms)}</div>
                  <div className="text-ink-4">每天 08:30、17:30 推盲投信息表</div>
                </div>
              ),
            },
            {
              key: "m", label: "提醒人",
              render: (g) => g.mentions.length
                ? <span className="text-[12.5px] text-ink-2" title={g.mentions.map((m) => `${m.name}：${m.lines.length ? m.lines.join("、") : "全部方向"}`).join("\n")}>{g.mentions.map((m) => m.name).join("、")}</span>
                : <span className="text-[12px] text-ink-4">不 @ 人</span>,
            },
            {
              key: "st", label: "状态",
              render: (g) => (
                <div className="flex flex-col items-start gap-1 text-[12px] text-ink-3">
                  <Badge tone={g.enabled ? "ok" : "muted"}>{g.enabled ? "启用" : "停用"}</Badge>
                  <span>已推 {g.sent} 期{g.lastSentAt && <>，最近 <Time at={g.lastSentAt} /></>}</span>
                  {g.problems > 0 && <Badge tone="bad" title={g.lastError}>7 天内 {g.problems} 期没推成</Badge>}
                </div>
              ),
            },
            {
              key: "a", label: "", align: "right",
              render: (g) => (
                <div className="flex justify-end gap-1.5">
                  <Button size="sm" busy={pending === `test-${g.id}`} disabled={!pushEnabled} title={pushEnabled ? "发一条测试消息到这个群" : "推送安全阀没打开"}
                    onClick={() => run("POST", `/api/admin/opportunities/groups/${g.id}/test`, undefined, { label: `test-${g.id}`, success: "测试消息已发出，请到钉钉群里看", revalidate: false })}>
                    测试
                  </Button>
                  <Button size="sm" onClick={() => edit(g)}>编辑</Button>
                  <Button size="sm" onClick={() => setAction({ kind: "delete", group: g })}>删除</Button>
                </div>
              ),
            },
          ]}
        />
      ) : !draft && (
        <Empty>还没有推送群。在钉钉群的“群设置 → 机器人”里添加“自定义机器人”，安全设置选“加签”，把 Webhook 和密钥填到这里。</Empty>
      )}

      {draft && (
        <div className="grid gap-3 border-t border-line p-4">
          <div className="text-[14px] font-medium text-ink">{draft.id === null ? "添加推送群" : `编辑：${draft.input.name}`}</div>
          <div className="grid gap-3 md:grid-cols-3">
            <Field label="群名" hint="只在后台显示，例如“商务部投标群”">
              <Input value={draft.input.name} maxLength={30} onChange={(e) => set({ name: e.target.value })} />
            </Field>
            <Field label="Webhook" hint={draft.id === null ? "机器人的 Webhook 地址" : "不改就留空"}>
              <Input value={draft.input.webhook} placeholder="https://oapi.dingtalk.com/robot/send?access_token=…" onChange={(e) => set({ webhook: e.target.value })} className="font-mono text-[12px]" />
            </Field>
            <Field label="加签密钥" hint={draft.id === null ? "SEC 开头的那串" : "不改就留空"}>
              <Input type="password" autoComplete="off" value={draft.input.secret} onChange={(e) => set({ secret: e.target.value })} className="font-mono text-[12px]" />
            </Field>
          </div>
          <Field label="业务方向" hint="只推这些方向的项目；都不选就是全部方向">
            <div className="flex flex-wrap gap-x-4 gap-y-1.5">
              {options.map((l) => <Check key={l} checked={draft.input.lines.includes(l)} onChange={(on) => set({ lines: toggle(draft.input.lines, l, on) })}>{l}</Check>)}
            </div>
          </Field>
          <Field label="来源平台" hint="都不选就是全部来源；有公告的平台才会列出">
            <div className="flex flex-wrap gap-x-4 gap-y-1.5">
              {sourceOptions.map((s) => <Check key={s} checked={draft.input.sources.includes(s)} onChange={(on) => set({ sources: toggle(draft.input.sources, s, on) })}>{platformName(s, platforms)}</Check>)}
            </div>
          </Field>
          <Field label="推送" hint="每天 08:30、17:30 各推一期盲投信息表，列出上一期以后新筛出的项目">
            <div className="flex flex-wrap gap-x-4 gap-y-1.5">
              <Check checked={draft.input.includeMaybe} onChange={(on) => set({ includeMaybe: on })}>也推待确认的项目（其他招采平台的待确认不推）</Check>
              <Check checked={draft.input.enabled} onChange={(on) => set({ enabled: on })}>启用</Check>
            </div>
          </Field>
          <Field label="提醒人" hint="每行一人：“姓名 手机号：方向、方向”。信息表里有他关注方向的新项目时 @ 他；不写方向就是有新项目就 @。手机号要是他钉钉绑定的，人要在这个群里">
            <Textarea rows={Math.max(3, draft.mentionsText.split("\n").length + 1)} value={draft.mentionsText}
              placeholder={`张三 13800000000：${lines.slice(0, 2).join("、")}\n李四 13900000000`}
              onChange={(e) => setDraft({ ...draft, mentionsText: e.target.value })} className="font-mono text-[12.5px]" />
          </Field>
          <p className="text-[12.5px] text-ink-3">新加或重新启用的群，只列从那时起发现的公告，之前的不补发。</p>
          {error && <p role="alert" className="text-[13px] text-hot">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button onClick={() => { setDraft(null); setError(null); }}>取消</Button>
            <Button tone="primary" onClick={save}>保存</Button>
          </div>
        </div>
      )}

      <ReasonDialog
        open={action !== null}
        title={action?.kind === "save" ? (action.id === null ? `添加推送群：${action.input.name}` : `保存推送群：${action.input.name}`) : action ? `删除推送群：${action.group.name}` : ""}
        description={action?.kind === "delete" ? "这个群不再收到推送，它的推送记录一起删掉。写一句原因，会记进审计日志。" : "写一句原因，会记进审计日志。"}
        busy={pending === "push-group"}
        onClose={() => setAction(null)}
        onSubmit={async (reason) => {
          if (!action) return false;
          const label = "push-group";
          if (action.kind === "delete") {
            return (await run("POST", `/api/admin/opportunities/groups/${action.group.id}/delete`, { reason }, { label, success: "已删除" })) !== null;
          }
          const path = action.id === null ? "/api/admin/opportunities/groups" : `/api/admin/opportunities/groups/${action.id}`;
          const ok = (await run("POST", path, { ...action.input, reason }, { label, success: "已保存" })) !== null;
          if (ok) setDraft(null);
          return ok;
        }}
      />
    </Card>
  );
}
