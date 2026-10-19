import { notifyAccessChange } from "@aihot/web/lib/access-browser";
import { useState, type FormEvent } from "react";
import { useLoaderData, type LoaderFunctionArgs } from "react-router";
import { adminGet } from "@aihot/web/lib/admin.server";
import { useAdminAction } from "@aihot/web/features/admin/action";
import { AdminPage, Card, Badge } from "@aihot/web/features/admin/ui";
import { buttonClass } from "@aihot/web/components/ui/Controls";
import type { Member } from "../types";

export async function loader({ request }: LoaderFunctionArgs) {
  return adminGet<{ rows: Member[] }>(request, "/api/admin/access/members");
}
export const meta = () => [{ title: "成员管理" }, { name: "robots", content: "noindex, nofollow" }];
const field = "mt-1.5 h-10 w-full rounded-control border border-line-strong bg-surface px-3 text-[14px] text-ink focus:border-accent";
export default function Members() {
  const { rows } = useLoaderData<typeof loader>();
  const { run, busy } = useAdminAction();
  const [reset, setReset] = useState<Member | null>(null);
  const [error, setError] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>, member?: Member) {
    event.preventDefault(); setError("");
    const form = event.currentTarget; const values = new FormData(form);
    const password = String(values.get("password") ?? "");
    if (password.length < 12 || new TextEncoder().encode(password).length > 1024) { setError("密码至少 12 字符且不超过 1024 字节。"); return; }
    // Clear the password before awaiting; it is never held in React state or a URL.
    const input = form.elements.namedItem("password") as HTMLInputElement; input.value = "";
    const result = member
      ? await run("POST", `/api/admin/access/members/${member.id}/reset`, { password }, { success: "密码已重置，旧会话已失效" })
      : await run("POST", "/api/admin/access/members", { username: String(values.get("username")), name: String(values.get("name") || values.get("username")), password }, { success: "成员已创建" });
    if (result) { notifyAccessChange(); form.reset(); setReset(null); }
  }
  return <AdminPage title="成员管理" subtitle="成员可阅读内部资料，不能进入后台；登录后可在页面顶部“修改密码”。停用或重置密码会立即撤销已有会话，停用的成员可以恢复。">
    <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
      <Card title="已授权成员">
        {!rows.length && <p className="py-8 text-center text-[13px] text-ink-4">尚无成员，请创建第一个账号。</p>}
        <ul className="divide-y divide-line">{rows.map(member => <li key={member.id} className="flex flex-wrap items-center justify-between gap-4 py-4">
          <div className="min-w-0"><div className="flex items-center gap-2"><span className="break-words text-[14px] font-medium text-ink">{member.name}</span><Badge tone={member.disabled ? "muted" : "ok"}>{member.disabled ? "已停用" : "可用"}</Badge></div><p className="mt-1 break-all text-[12px] text-ink-4">{member.username}</p></div>
          <div className="flex gap-2"><button disabled={busy} onClick={() => { setReset(member); setError(""); }} className={buttonClass("secondary")}>重置密码</button>{member.disabled
            ? <button disabled={busy} className={buttonClass("secondary")} onClick={() => { if (window.confirm(`恢复 ${member.name}？恢复后可以用原密码登录；需要的话先重置密码。`)) void run("POST", `/api/admin/access/members/${member.id}/enable`, undefined, { success: "成员已恢复" }); }}>恢复</button>
            : <button disabled={busy} className={buttonClass("secondary")} onClick={() => { if (window.confirm(`停用 ${member.name}？其所有会话会立即失效。`)) void run("POST", `/api/admin/access/members/${member.id}/disable`, undefined, { success: "成员已停用" }).then(result => { if (result) notifyAccessChange(); }); }}>停用</button>}</div>
        </li>)}</ul>
      </Card>
      <Card title={reset ? `重置密码 · ${reset.name}` : "创建成员"}>
        <form key={reset?.id ?? "new"} onSubmit={event => submit(event, reset ?? undefined)} className="space-y-4">
          {!reset && <><label className="block text-[13px] text-ink-2">用户名<input className={field} name="username" required pattern="[A-Za-z0-9_.-]{3,64}" minLength={3} maxLength={64} autoComplete="off" /><span className="mt-1 block text-[11px] text-ink-4">3–64 位字母、数字或 ._-</span></label><label className="block text-[13px] text-ink-2">显示名称<input className={field} name="name" maxLength={120} autoComplete="off" /></label></>}
          <label className="block text-[13px] text-ink-2">{reset ? "新密码" : "初始密码"}<input className={field} name="password" type="password" autoComplete="new-password" required minLength={12} maxLength={1024} /><span className="mt-1 block text-[11px] text-ink-4">至少 12 字符。请通过安全渠道告知成员。</span></label>
          {error && <p role="alert" className="text-[12px] text-hot">{error}</p>}
          <div className="flex gap-2"><button disabled={busy} className={buttonClass("primary")} type="submit">{busy ? "处理中…" : reset ? "确认重置" : "创建成员"}</button>{reset && <button type="button" className={buttonClass("secondary")} onClick={() => setReset(null)}>取消</button>}</div>
        </form>
      </Card>
    </div>
  </AdminPage>;
}
