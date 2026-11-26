// HTTP auth/no-store is the boundary. This additionally discards browser-held trees on identity changes:
// another tab signing out or in, a session revoked meanwhile, a page restored from the back/forward cache.
// Reading itself is left alone: links, filters and Back stay in the document, and a check that cannot
// reach the server (offline, timeout) leaves the page as it is instead of reloading it and losing input.
// The page is covered while it is checked only when it may be in front of someone else: another tab said the
// sign-in changed, the tab comes back after a long time away, or it returns from the back/forward cache.
interface Identity { id: string; csrf: string; adminCsrf?: string }

export function accessBootScript(identity: Identity | null, login: string, session: string) {
  const config = JSON.stringify({ identity, login, session }).replaceAll("<", "\\u003c");
  return `(${boot.toString()})(${config});`;
}

/** The boot script names its document here; notices from a document are not meant for itself. */
type AccessWindow = Window & { aihotAccessDocument?: string };

/**
 * Tells the other tabs that a sign-in changed (no identity, credentials or business data cross tabs or go into
 * storage). This tab does not hear its own notice: a caller that ended its own session navigates itself, and
 * its check would otherwise send it somewhere else first (the sign-in page with this page to return to); one
 * that changed someone else's account has nothing to recheck here.
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
  let hiddenSince = 0;
  /** Away longer than this, the tab may be in front of someone else when it comes back. */
  const AWAY_MS = 10 * 60_000;
  /** React Router's record of view transitions: the paths the reader went between. */
  const TRAIL = "remix-router-transitions";
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
  /** Covers the page until a check that starts now passes. */
  function recheckCovered() {
    hide();
    revision++;
    void verify();
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
      // The admin's own session matters while an admin page is open; reading pages answer to the reading identity.
      if (identity.adminCsrf && /^\/admin(?:\/|$)/i.test(location.pathname)) {
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
      if ((event.data as { from?: unknown } | null)?.from !== thisDocument) recheckCovered();
    };
    channel.postMessage({ from: thisDocument });
  } catch { /* visibility/pageshow still work */ }
  window.addEventListener("storage", event => { if (event.key === "aihot:access-epoch") recheckCovered(); });
  try { localStorage.setItem("aihot:access-epoch", `${Date.now()}:${Math.random()}`); } catch { /* optional */ }
  for (const kind of ["localStorage", "sessionStorage"] as const) {
    try {
      const store = window[kind];
      for (const key of Object.keys(store)) {
        if ((/^aihot[-:]/.test(key) && key !== "aihot-theme" && key !== "aihot:access-epoch") || key === TRAIL) store.removeItem(key);
      }
    } catch { /* storage is optional */ }
  }
  // The router writes that trail when the document goes away; here it is never written.
  try {
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (this: Storage, key: string, value: string) {
      if (key !== TRAIL) setItem.call(this, key, value);
    };
  } catch { /* storage is optional */ }
  window.addEventListener("pagehide", () => {
    if (identity) hide();
    // Password fields by what they hold, not by type: one shown in plain text is still a password.
    for (const input of document.querySelectorAll<HTMLInputElement>('input[type="password"], input[autocomplete$="-password"]')) input.value = "";
  });
  // A document restored from the back/forward cache was hidden on its way out (pagehide) and stays hidden
  // until its session is checked again; the sign-in page itself is loaded afresh.
  window.addEventListener("pageshow", event => {
    if (!event.persisted) return;
    if (!identity) { go(location.href); return; }
    recheckCovered();
  });
  if (!identity) return;
  // A quick switch to another window is checked without covering the page; a long time away is checked first.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") { hiddenSince = Date.now(); return; }
    if (hiddenSince && Date.now() - hiddenSince > AWAY_MS) recheckCovered();
    else void verify();
  });
  window.addEventListener("focus", () => { void verify(); });
  window.addEventListener("popstate", () => { void verify(); });
  // Back online: a page covered while it could not be checked is checked (and shown) again.
  window.addEventListener("online", () => { void verify(); });
  window.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), location.href);
    const sameOrigin = url.origin === location.origin;
    const response = await nativeFetch(input, sameOrigin ? { ...init, cache: "no-store" } : init);
    if (sameOrigin && !endsSession(url.pathname)) {
      if (response.status === 401) go(signIn());
      if (response.status === 403) go(location.href);
      // A session change during a delayed business response cannot repopulate the old document: the check is
      // newer than the response (a check already running starts over).
      revision++;
      if (!await verify()) throw new Error("Session must be checked in a new document");
    }
    return response;
  };
  window.setInterval(() => { if (document.visibilityState === "visible") void verify(); }, 30000);
  void verify();
}
