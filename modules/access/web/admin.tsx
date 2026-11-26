import { notifyAccessChange } from "@aihot/web/lib/access-browser";
import { useRef, useState, type FormEvent } from "react";
import { useLoaderData, type LoaderFunctionArgs } from "react-router";
import { adminGet } from "@aihot/web/lib/admin.server";
import { useAdminAction } from "@aihot/web/features/admin/action";
import { toast } from "@aihot/web/features/admin/toast";
import { AdminPage, Card, Badge, ReasonDialog } from "@aihot/web/features/admin/ui";
import { buttonClass } from "@aihot/web/components/ui/Controls";
import type { Member } from "../types";

export async function loader({ request }: LoaderFunctionArgs) {
  return adminGet<{ rows: Member[] }>(request, "/api/admin/access/members");
}
export const meta = () => [{ title: "成员管理" }, { name: "robots", content: "noindex, nofollow" }];
const field = "mt-1.5 h-10 w-full rounded-control border border-line-strong bg-surface px-3 text-[14px] text-ink focus:border-accent";
const small = "rounded-control px-2 py-1 text-[12px] text-ink-3 ring-1 ring-line hover:bg-bg-sunk hover:text-ink";

/** 16 characters without the look-alikes (0/O, 1/l/I): about 93 bits, easy to read out or type. */
const READABLE = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
function generatePassword(length = 16): string {
  const out: string[] = [];
  const bytes = new Uint8Array(64);
  while (out.length < length) {
    crypto.getRandomValues(bytes);
    // Values past the largest multiple of the alphabet would favour its first letters.
    for (const b of bytes) if (b < 256 - (256 % READABLE.length) && out.length < length) out.push(READABLE[b % READABLE.length]!);
  }
  return out.join("");
}

export default function Members() {
  const { rows } = useLoaderData<typeof loader>();
  const { run, busy, pending } = useAdminAction();
  const [reset, setReset] = useState<Member | null>(null);
  const [error, setError] = useState("");
  const [visible, setVisible] = useState(false);
  const [toggle, setToggle] = useState<Member | null>(null);
  const formCard = useRef<HTMLDivElement>(null);
  const passwordInput = () => formCard.current?.querySelector<HTMLInputElement>('input[name="password"]') ?? null;

  async function submit(event: FormEvent<HTMLFormElement>, member?: Member) {
    event.preventDefault(); setError("");
    const form = event.currentTarget; const values = new FormData(form);
    const password = String(values.get("password") ?? "");
    if (password.length < 12 || new TextEncoder().encode(password).length > 1024) { setError("密码至少 12 字符且不超过 1024 字节。"); return; }
    // The password stays in its input only (never React state or a URL); it is cleared once the server took it.
    const result = member
      ? await run("POST", `/api/admin/access/members/${member.id}/reset`, { password }, { success: "密码已重置，旧会话已失效" })
      : await run("POST", "/api/admin/access/members", { username: String(values.get("username")), name: String(values.get("name") || values.get("username")), password }, { success: "成员已创建" });
    if (result) { notifyAccessChange(); form.reset(); setReset(null); setVisible(false); }
  }
  function startReset(member: Member) {
    setReset(member); setError(""); setVisible(false);
    // On a phone the form sits below the list: bring it into view, ready to type.
    requestAnimationFrame(() => {
      formCard.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
      passwordInput()?.focus();
    });
  }
  function generate() {
    const input = passwordInput();
    if (!input) return;
    input.value = generatePassword();
    setVisible(true);
  }
  async function copy() {
    const value = passwordInput()?.value ?? "";
    if (!value) return toast("先填写或生成密码", "info");
    try {
      await navigator.clipboard.writeText(value);
      toast("密码已复制，请通过安全渠道发给成员", "ok");
    } catch {
      setVisible(true);
      toast("没能复制，请手动选中密码复制", "error");
    }
  }
  return <AdminPage title="成员管理" subtitle="成员可阅读内部资料，不能进入后台；成员在侧栏底部（手机在“我的”页）修改自己的密码。停用或重置密码会立即撤销已有会话，停用的成员可以恢复。">
    <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
      <Card title="已授权成员">
        {!rows.length && <p className="py-8 text-center text-[13px] text-ink-4">还没有成员，在右侧（手机在下方）创建第一个账号。</p>}
        <ul className="divide-y divide-line">{rows.map(member => <li key={member.id} className="flex flex-wrap items-center justify-between gap-4 py-4">
          <div className="min-w-0"><div className="flex items-center gap-2"><span className="break-words text-[14px] font-medium text-ink">{member.name}</span><Badge tone={member.disabled ? "muted" : "ok"}>{member.disabled ? "已停用" : "可用"}</Badge></div><p className="mt-1 break-all text-[12px] text-ink-4">{member.username}</p></div>
          <div className="flex gap-2"><button disabled={busy} onClick={() => startReset(member)} className={buttonClass("secondary")}>重置密码</button>
            <button disabled={busy} className={buttonClass("secondary")} onClick={() => setToggle(member)}>{member.disabled ? "恢复" : "停用"}</button></div>
        </li>)}</ul>
      </Card>
      <div ref={formCard}>
        <Card title={reset ? `重置密码 · ${reset.name}` : "创建成员"}>
          <form key={reset?.id ?? "new"} onSubmit={event => submit(event, reset ?? undefined)} className="space-y-4">
            {!reset && <><label className="block text-[13px] text-ink-2">用户名<input className={field} name="username" required pattern="[A-Za-z0-9_.-]{3,64}" minLength={3} maxLength={64} autoComplete="off" /><span className="mt-1 block text-[11px] text-ink-4">3–64 位字母、数字或 ._-</span></label><label className="block text-[13px] text-ink-2">显示名称<input className={field} name="name" maxLength={120} autoComplete="off" placeholder="不填就用用户名" /></label></>}
            <label className="block text-[13px] text-ink-2">{reset ? "新密码" : "初始密码"}<input className={field} name="password" type={visible ? "text" : "password"} autoComplete="new-password" required minLength={12} maxLength={1024} spellCheck={false} /></label>
            <div className="-mt-2 flex flex-wrap items-center gap-2">
              <button type="button" className={small} onClick={generate}>生成</button>
              <button type="button" className={small} onClick={() => setVisible(v => !v)}>{visible ? "隐藏" : "显示"}</button>
              <button type="button" className={small} onClick={copy}>复制</button>
              <span className="text-[11px] text-ink-4">至少 12 字符，保存后通过安全渠道告知成员</span>
            </div>
            {error && <p role="alert" className="text-[12px] text-hot">{error}</p>}
            <div className="flex gap-2"><button disabled={busy} className={buttonClass("primary")} type="submit">{busy ? "处理中…" : reset ? "确认重置" : "创建成员"}</button>{reset && <button type="button" className={buttonClass("secondary")} onClick={() => { setReset(null); setVisible(false); }}>取消</button>}</div>
          </form>
        </Card>
      </div>
    </div>
    <ReasonDialog
      open={!!toggle}
      note={false}
      requireReason={false}
      danger={!toggle?.disabled}
      title={toggle ? `${toggle.disabled ? "恢复" : "停用"} ${toggle.name}？` : ""}
      description={toggle?.disabled ? "恢复后可以用原密码登录；需要的话先重置密码。" : "停用后其所有会话立即失效，不能再登录；停用的成员可以随时恢复。"}
      confirmLabel={toggle?.disabled ? "恢复" : "停用"}
      busy={pending !== null}
      onClose={() => setToggle(null)}
      onSubmit={async () => {
        const member = toggle!;
        const result = await run("POST", `/api/admin/access/members/${member.id}/${member.disabled ? "enable" : "disable"}`, undefined, { success: member.disabled ? "成员已恢复" : "成员已停用" });
        if (result && !member.disabled) notifyAccessChange();
        return result !== null;
      }}
    />
  </AdminPage>;
}
