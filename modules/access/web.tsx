import { notifyAccessChange } from "@aihot/web/lib/access-browser";
import { useState } from "react";
import { useRouteLoaderData } from "react-router";
import type { AccessPrincipal } from "@aihot/contracts/access";
import { defineWebModule } from "@aihot/web/modules";

function MemberBar() {
  const { principal } = (useRouteLoaderData("root") ?? {}) as { principal?: AccessPrincipal };
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  if (!principal) return null;
  async function logout() {
    setBusy(true); setError("");
    try {
      const res = await fetch(principal!.kind === "member" ? "/api/access/logout" : "/api/auth/logout", {
        method: "POST", credentials: "same-origin", headers: { "x-csrf-token": principal!.csrf },
      });
      if (!res.ok && res.status !== 401) { setError("退出失败，请稍后重试。"); setBusy(false); return; }
      // A document navigation discards the router and component state, not just the session cookie.
      notifyAccessChange();
      window.location.replace("/login");
    } catch { setError("网络异常，未能退出，请重试。"); setBusy(false); }
  }
  return <section aria-label="当前成员" className="mb-5 flex flex-wrap items-center justify-between gap-2 border-b border-line py-3 text-[12px] text-ink-3">
    <span><span className="mr-2 font-medium text-accent">内部工作空间</span>{principal.name}</span>
    <span className="inline-flex items-center gap-4">
      {principal.kind === "member" && <a href="/account" className="text-ink-3 hover:text-ink">修改密码</a>}
      <button type="button" disabled={busy} onClick={logout} className="text-ink-3 hover:text-ink disabled:opacity-50">{busy ? "正在退出…" : "退出登录"}</button>
    </span>
    {error && <p role="alert" className="w-full text-hot">{error}</p>}
  </section>;
}
export const accessWeb = defineWebModule({
  name: "access", root: { Top: MemberBar },
  admin: { groups: [{ group: "访问控制", items: [{ to: "/admin/access", label: "成员管理" }] }] },
});
