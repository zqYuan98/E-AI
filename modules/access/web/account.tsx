// 成员自己修改密码：要输入当前密码；改好后所有会话（包括这一个）都结束，用新密码重新登录。
import { notifyAccessChange } from "@aihot/web/lib/access-browser";
import { useState, type FormEvent } from "react";
import { useRouteLoaderData } from "react-router";
import type { AccessPrincipal } from "@aihot/contracts/access";
import { SITE } from "@aihot/site";
import { PRIVATE_HEADERS } from "@aihot/web/lib/access";
import { buttonClass } from "@aihot/web/components/ui/Controls";

export const headers = () => PRIVATE_HEADERS;
export const meta = () => [{ title: `修改密码 · ${SITE.name}` }, { name: "robots", content: "noindex, nofollow" }];

const field = "mt-2 h-11 w-full rounded-control border border-line-strong bg-surface px-3 text-[15px] outline-none focus:border-accent";
const MESSAGES: Record<number, string> = { 400: "新密码至少 12 个字符，且不能和当前密码相同。", 403: "当前密码不正确。", 429: "请稍后再试。" };

export default function Account() {
  const { principal } = (useRouteLoaderData("root") ?? {}) as { principal?: AccessPrincipal };
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  if (principal?.kind !== "member") {
    return <main className="mx-auto max-w-[420px] py-12"><h1 className="text-[22px] font-semibold text-ink">修改密码</h1><p className="mt-3 text-[14px] leading-7 text-ink-3">这里修改成员账号的密码。管理员密码在服务器上设置。</p></main>;
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    const form = event.currentTarget;
    const values = new FormData(form);
    const current = String(values.get("current") ?? "");
    const next = String(values.get("next") ?? "");
    if (next.length < 12) return setError("新密码至少 12 个字符。");
    if (next !== String(values.get("confirm") ?? "")) return setError("两次输入的新密码不一致。");
    // Passwords are never kept in React state; the inputs are cleared before the request.
    for (const name of ["current", "next", "confirm"]) (form.elements.namedItem(name) as HTMLInputElement).value = "";
    setBusy(true);
    try {
      const res = await fetch("/api/access/password", {
        method: "POST", credentials: "same-origin",
        headers: { "content-type": "application/json", "x-csrf-token": principal!.csrf },
        body: JSON.stringify({ current, next }),
      });
      if (!res.ok) { setError(MESSAGES[res.status] ?? "暂时无法修改，请稍后重试。"); setBusy(false); return; }
      notifyAccessChange();
      window.location.replace("/login");
    } catch {
      setError("网络异常，请重试。");
      setBusy(false);
    }
  }
  return <main className="mx-auto max-w-[420px] py-10">
    <h1 className="text-[22px] font-semibold text-ink">修改密码</h1>
    <p className="mt-2 text-[13px] leading-6 text-ink-3">{principal.name}。改好后所有设备上的登录都会退出，请用新密码重新登录。</p>
    <form onSubmit={submit} className="card mt-6 space-y-5 p-6">
      <label className="block text-[13px] font-medium text-ink-2">当前密码<input name="current" type="password" autoComplete="current-password" required maxLength={1024} className={field} /></label>
      <label className="block text-[13px] font-medium text-ink-2">新密码<input name="next" type="password" autoComplete="new-password" required minLength={12} maxLength={1024} className={field} /><span className="mt-1 block text-[11.5px] font-normal text-ink-4">至少 12 个字符</span></label>
      <label className="block text-[13px] font-medium text-ink-2">再输一次新密码<input name="confirm" type="password" autoComplete="new-password" required minLength={12} maxLength={1024} className={field} /></label>
      {error && <p role="alert" className="text-[13px] text-hot">{error}</p>}
      <button disabled={busy} className={`${buttonClass("primary", "lg")} w-full`} type="submit">{busy ? "正在修改…" : "修改密码"}</button>
    </form>
  </main>;
}
