// 当前登录的账号：名字，和对它能做的事（成员改密码、管理员进后台、退出登录）。桌面在侧栏底部，手机在“我的”页顶部，
// 不占每一页的顶部。
import { notifyAccessChange } from "@aihot/web/lib/access-browser";
import { useState } from "react";
import { Link, useRouteLoaderData } from "react-router";
import type { AccessPrincipal } from "@aihot/contracts/access";
import { defineWebModule } from "@aihot/web/modules";

function Account({ place }: { place: "sidebar" | "more" }) {
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
  const member = principal.kind === "member";
  const actions = (
    <>
      {/* The admin is another sign-in: a new document there checks the admin's session from the start. */}
      {member ? <Link to="/account" className="hover:text-ink">修改密码</Link> : <Link to="/admin" reloadDocument className="hover:text-ink">进入后台</Link>}
      <button type="button" disabled={busy} onClick={logout} className="hover:text-ink disabled:opacity-50">{busy ? "正在退出…" : "退出登录"}</button>
    </>
  );
  const alert = error && <p role="alert" className="mt-1.5 text-hot">{error}</p>;
  if (place === "sidebar") {
    return (
      <section aria-label="当前成员" className="mx-1 border-t border-line px-1 pt-2.5 text-[12px] text-ink-3">
        <div className="truncate font-medium text-ink-2" title={principal.name}>{principal.name}</div>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">{actions}</div>
        {alert}
      </section>
    );
  }
  // The desktop sidebar already holds it.
  return (
    <section aria-label="当前成员" className="card mb-5 px-4 py-3.5 text-[14px] text-ink-3 lg:hidden">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-[16px] font-semibold text-ink">{principal.name}</div>
          <div className="mt-0.5 text-[12.5px] text-ink-4">{member ? "成员账号" : "管理员"}</div>
        </div>
        <div className="flex shrink-0 items-center gap-4">{actions}</div>
      </div>
      {alert}
    </section>
  );
}

export const accessWeb = defineWebModule({
  name: "access",
  account: Account,
  admin: { groups: [{ group: "访问控制", items: [{ to: "/admin/access", label: "成员管理" }] }] },
});
