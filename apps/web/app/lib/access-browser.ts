// HTTP auth/no-store is the boundary. This additionally discards browser-held trees on identity changes:
// another tab signing out or in, a session revoked meanwhile, a page restored from the back/forward cache.
// Reading itself is left alone: links, filters and Back stay in the document, and a check that cannot
// reach the server (offline, timeout) leaves the page as it is instead of reloading it and losing input.
interface Identity { id: string; csrf: string; adminCsrf?: string }

export function accessBootScript(identity: Identity | null, login: string, session: string) {
  const config = JSON.stringify({ identity, login, session }).replaceAll("<", "\\u003c");
  return `(${boot.toString()})(${config});`;
}

/** The boot script names its document here; notices from a document are not meant for itself. */
type AccessWindow = Window & { aihotAccessDocument?: string };

/**
 * Tells the other tabs that this browser's sign-in changed (no identity, credentials or business data cross
 * tabs or go into storage). The caller navigates this tab itself: it does not hear its own notice, or its own
 * check could send it somewhere else first (the sign-in page with this page to return to).
 */
export function notifyAccessChange() {
  try {
    const channel = new BroadcastChannel("aihot-access");
    channel.postMessage({ from: (window as AccessWindow).aihotAccessDocument ?? null });
    channel.close();
  } catch { /* storage/focus also notify */ }
  try { localStorage.setItem("aihot:access-epoch", `${Date.now()}:${Math.random()}`); } catch { /* optional */ }
}

function boot({ identity, login, session }: { identity: Identity | null; login: string; session: string }) {
  const root = document.documentElement;
  const nativeFetch = window.fetch.bind(window);
  const thisDocument = Math.random().toString(36).slice(2);
  (window as Window & { aihotAccessDocument?: string }).aihotAccessDocument = thisDocument;
  let leaving = false;
  let revision = 0;
  let checking: Promise<boolean> | null = null;
  const hide = () => root.setAttribute("data-access-paused", "");
  const go = (to: string) => { if (leaving) return; leaving = true; hide(); location.replace(to); };
  const signIn = () => /^\/admin(?:\/|$)/i.test(location.pathname)
    ? `/api/auth/login?return=${encodeURIComponent(location.pathname + location.search)}`
    : `${login}?returnTo=${encodeURIComponent(location.pathname + location.search)}`;
  // Requests that end the session themselves; their callers tell the other tabs and go to the sign-in page.
  const endsSession = (path: string) => /^\/api\/(?:access\/(?:logout|password)|auth\/logout)$/.test(path);
  function verify(): Promise<boolean> {
    return checking ??= check().finally(() => { checking = null; });
  }
  async function check(): Promise<boolean> {
    if (!identity || leaving) return false;
    const attempt = ++revision;
    // Only a definite answer acts: no session goes to sign in, another identity loads the page again for it.
    // A routine check (timer, focus, after a request) leaves a visible page as it is; a page hidden on its way
    // back from the back/forward cache (pageshow below) is shown once a check passes.
    try {
      const res = await nativeFetch(session, { cache: "no-store", credentials: "same-origin", redirect: "manual", signal: AbortSignal.timeout(5000) });
      const current = res.ok ? await res.json() : null;
      if (leaving) return false;
      if (attempt !== revision) return check();
      if (res.status === 401) { go(signIn()); return false; }
      if (!res.ok || current.id !== identity.id || current.csrf !== identity.csrf) { go(location.href); return false; }
      if (identity.adminCsrf) {
        const admin = await nativeFetch("/api/admin/me", { cache: "no-store", credentials: "same-origin", redirect: "manual", signal: AbortSignal.timeout(5000) });
        const me = admin.ok ? await admin.json() : null;
        if (leaving) return false;
        if (attempt !== revision) return check();
        if (admin.status === 401 || admin.status === 403) { go(signIn()); return false; }
        if (!admin.ok || me.dev !== false || me.csrf !== identity.adminCsrf) { go(location.href); return false; }
      }
      if (document.visibilityState !== "hidden") root.removeAttribute("data-access-paused");
      return true;
    } catch {
      // Unreachable (offline, timeout): nothing new can load without the server either. Reloading here
      // would only throw away what the reader is typing.
      return false;
    }
  }
  try {
    const channel = new BroadcastChannel("aihot-access");
    channel.onmessage = (event: MessageEvent) => {
      if ((event.data as { from?: unknown } | null)?.from === thisDocument) return;
      revision++;
      void verify();
    };
    channel.postMessage({ from: thisDocument });
  } catch { /* visibility/pageshow still work */ }
  window.addEventListener("storage", event => { if (event.key === "aihot:access-epoch") { revision++; void verify(); } });
  try { localStorage.setItem("aihot:access-epoch", `${Date.now()}:${Math.random()}`); } catch { /* optional */ }
  for (const kind of ["localStorage", "sessionStorage"] as const) {
    try {
      const store = window[kind];
      for (const key of Object.keys(store)) {
        if (/^aihot[-:]/.test(key) && key !== "aihot-theme" && key !== "aihot:access-epoch") store.removeItem(key);
      }
    } catch { /* storage is optional */ }
  }
  window.addEventListener("pagehide", () => {
    if (identity) hide();
    for (const input of document.querySelectorAll<HTMLInputElement>('input[type="password"]')) input.value = "";
  });
  // A document restored from the back/forward cache was hidden on its way out (pagehide) and stays hidden
  // until its session is checked again; the sign-in page itself is loaded afresh.
  window.addEventListener("pageshow", event => {
    if (!event.persisted) return;
    if (!identity) { go(location.href); return; }
    hide();
    revision++;
    void verify();
  });
  if (!identity) return;
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") void verify(); });
  window.addEventListener("focus", () => { void verify(); });
  window.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), location.href);
    const sameOrigin = url.origin === location.origin;
    const response = await nativeFetch(input, sameOrigin ? { ...init, cache: "no-store" } : init);
    if (sameOrigin && !endsSession(url.pathname)) {
      if (response.status === 401) go(signIn());
      if (response.status === 403) go(location.href);
      // A session change during a delayed business response cannot repopulate the old document.
      if (!await verify()) throw new Error("Session must be checked in a new document");
    }
    return response;
  };
  window.setInterval(() => { if (document.visibilityState === "visible") void verify(); }, 30000);
  void verify();
}
