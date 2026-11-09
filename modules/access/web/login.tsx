import { useEffect, useRef, useState } from "react";
import { data, redirectDocument, useActionData, useLoaderData, type ActionFunctionArgs, type LoaderFunctionArgs } from "react-router";
import { safeReturnPath, originAllowed } from "@aihot/contracts/access";
import { SITE } from "@aihot/site";
import { API_BASE_URL } from "@aihot/web/lib/api.server";
import { PRIVATE_HEADERS } from "@aihot/web/lib/access";
import { siteUrl } from "@aihot/web/lib/seo";
import { Wordmark } from "@aihot/site/brand/Logo.tsx";
import { buttonClass } from "@aihot/web/components/ui/Controls";

const access = { loginPath: "/login" };
type Dingtalk = { corpId: string; clientId: string };
export async function loader({ request }: LoaderFunctionArgs) {
  const returnTo = safeReturnPath(new URL(request.url).searchParams.get("returnTo"), access);
  // Without the api's answer the page still offers the password.
  const options = await fetch(`${API_BASE_URL}/api/access/options`, { cache: "no-store", signal: AbortSignal.timeout(3000) })
    .then((res) => (res.ok ? res.json() as Promise<{ dingtalk: Dingtalk | null }> : null), () => null);
  return { returnTo, dingtalk: options?.dingtalk ?? null };
}
export const headers = () => PRIVATE_HEADERS;
export const meta = () => [{ title: `成员登录 · ${SITE.name}` }, { name: "robots", content: "noindex, nofollow" }];

export async function action({ request }: ActionFunctionArgs) {
  const fail = (error: string, status: number) => data({ error }, { status, headers: PRIVATE_HEADERS });
  if (request.method !== "POST") return fail("请使用登录表单提交。", 405);
  if (!originAllowed(request.headers.get("origin") ?? undefined, [siteUrl()])) return fail("请从本站登录页面重新提交。", 403);
  if (!request.headers.get("content-type")?.startsWith("application/x-www-form-urlencoded")) return fail("登录信息格式不正确。", 400);
  // A bounded form read; never echo, return, or log submitted credentials.
  const reader = request.body?.getReader();
  if (!reader) return fail("请输入用户名和密码。", 400);
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 8192) { await reader.cancel(); return fail("登录信息过长。", 413); }
    chunks.push(value);
  }
  const form = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
  const code = form.get("dingtalkCode");
  try {
    const res = await fetch(`${API_BASE_URL}/api/access/${code ? "dingtalk" : "login"}`, {
      method: "POST", redirect: "manual", cache: "no-store",
      // server.ts has replaced x-forwarded-for with the visitor's address; sign-in limits count per visitor.
      headers: { "content-type": "application/json", origin: request.headers.get("origin")!, cookie: request.headers.get("cookie") ?? "", "x-forwarded-for": request.headers.get("x-forwarded-for") ?? "" },
      body: JSON.stringify({ ...(code ? { code } : { username: form.get("username"), password: form.get("password") }), returnTo: safeReturnPath(form.get("returnTo"), access) }),
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(15000)]),
    });
    // A short Retry-After is a busy password check, not this visitor's attempt limit.
    const busy = res.status === 429 && Number(res.headers.get("retry-after")) <= 5;
    if (!res.ok && code) {
      const detail = res.status === 403 ? ((await res.json().catch(() => null)) as { detail?: string } | null)?.detail : null;
      return fail(detail ?? (res.status === 429 ? "登录尝试过多，请 15 分钟后再试。" : "钉钉登录没有成功，请稍后重试，或用账号密码登录。"), res.status >= 500 ? 503 : res.status);
    }
    if (!res.ok) return fail(busy ? "同时登录的人较多，请几秒后重试。" : res.status === 429 ? "登录尝试过多，请 15 分钟后再试。" : res.status === 401 ? "用户名或密码不正确。" : res.status === 403 ? "登录请求被拒绝，请重新打开本站。" : "暂时无法登录，请稍后重试。", res.status >= 500 ? 503 : res.status);
    const body = await res.json() as { redirect?: string };
    const headers = new Headers(PRIVATE_HEADERS);
    for (const cookie of res.headers.getSetCookie()) headers.append("Set-Cookie", cookie);
    return redirectDocument(safeReturnPath(body.redirect, access), { status: 303, headers });
  } catch { return fail("身份服务暂不可用，请稍后重试。", 503); }
}

// 钉钉的 JSAPI，只在钉钉里打开时加载。
const JSAPI = "https://g.alicdn.com/dingding/dingtalk-jsapi/3.0.25/dingtalk.open.js";
type AuthCode = { code?: string; authCode?: string };
type DD = {
  ready: (fn: () => void) => void;
  error: (fn: (error: unknown) => void) => void;
  runtime?: { permission?: { requestAuthCode?: (o: { corpId: string; onSuccess: (r: AuthCode) => void; onFail: (e: unknown) => void }) => void } };
  requestAuthCode?: (o: { corpId: string; clientId: string; success: (r: AuthCode) => void; fail: (e: unknown) => void }) => void;
};

/** 在钉钉里向钉钉要本人的免登码。 */
function dingtalkCode({ corpId, clientId }: Dingtalk): Promise<string> {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = JSAPI;
    script.onerror = () => reject(new Error("jsapi"));
    script.onload = () => {
      const dd = (window as unknown as { dd?: DD }).dd;
      if (!dd) return reject(new Error("jsapi"));
      const done = (r: AuthCode) => (r.code ?? r.authCode ? resolve((r.code ?? r.authCode)!) : reject(new Error("no code")));
      dd.error(reject);
      dd.ready(() => {
        const legacy = dd.runtime?.permission?.requestAuthCode;
        if (legacy) legacy({ corpId, onSuccess: done, onFail: reject });
        else if (dd.requestAuthCode) dd.requestAuthCode({ corpId, clientId, success: done, fail: reject });
        else reject(new Error("no requestAuthCode"));
      });
    };
    document.head.appendChild(script);
    setTimeout(() => reject(new Error("timeout")), 15_000);
  });
}

export default function MemberLogin() {
  const { returnTo, dingtalk } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const form = useRef<HTMLFormElement>(null);
  const [code, setCode] = useState("");
  const [state, setState] = useState<"idle" | "signing" | "failed">("idle");
  // 在钉钉里自动登录；登录没成功（页面带着错误回来）时不再自动重试，留给账号密码。
  useEffect(() => {
    if (!dingtalk || result || !/DingTalk/i.test(navigator.userAgent)) return;
    setState("signing");
    dingtalkCode(dingtalk).then(setCode, () => setState("failed"));
  }, [dingtalk, result]);
  useEffect(() => { if (code) form.current?.requestSubmit(); }, [code]);
  // A refusal comes back as the action's error: the form then shows it.
  if (state === "signing" && !result) return <main className="flex min-h-dvh items-center justify-center bg-bg px-4 text-[14px] text-ink-3">
    <p role="status">正在通过钉钉登录…</p>
    <form ref={form} method="post" hidden><input type="hidden" name="dingtalkCode" value={code} /><input type="hidden" name="returnTo" value={returnTo} /></form>
  </main>;
  return <main className="flex min-h-dvh items-center justify-center bg-bg px-4 py-12">
    <div className="w-full max-w-[390px]">
      <Wordmark size={30} className="text-ink" />
      <p className="mt-8 text-[12px] font-medium tracking-widest text-accent">内部资料 · 成员访问</p>
      <h1 className="mt-2 text-[28px] font-semibold tracking-tight text-ink">登录工作空间</h1>
      <p className="mt-3 text-[14px] leading-7 text-ink-3">使用管理员分配的账号阅读资讯与政策规划。没有账号？请联系站点管理员。</p>
      <form method="post" className="card mt-7 space-y-5 p-6">
        <input type="hidden" name="returnTo" value={returnTo} />
        <label className="block text-[13px] font-medium text-ink-2">用户名<input name="username" autoComplete="username" required maxLength={64} className="mt-2 h-11 w-full rounded-control border border-line-strong bg-surface px-3 text-[15px] outline-none focus:border-accent" /></label>
        <label className="block text-[13px] font-medium text-ink-2">密码<input name="password" type="password" autoComplete="current-password" required maxLength={1024} className="mt-2 h-11 w-full rounded-control border border-line-strong bg-surface px-3 text-[15px] outline-none focus:border-accent" /></label>
        {result && "error" in result && <p role="alert" className="text-[13px] leading-6 text-hot">{result.error}</p>}
        {state === "failed" && <p role="alert" className="text-[13px] leading-6 text-hot">没有拿到钉钉的登录授权，请重新打开应用，或用账号密码登录。</p>}
        <button className={`${buttonClass("primary", "lg")} w-full`} type="submit">登录</button>
      </form>
      <p className="mt-5 text-[12px] leading-6 text-ink-4">本工作空间不开放匿名阅读。使用结束后请退出，勿在共享设备上保存密码。</p>
      <a href="/admin/login" className="mt-5 inline-block text-[13px] text-ink-3 underline underline-offset-4">管理员入口</a>
    </div>
  </main>;
}
