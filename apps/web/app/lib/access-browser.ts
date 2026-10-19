// HTTP auth/no-store is the boundary. This additionally discards browser-held trees on identity changes.
interface Identity { id: string; csrf: string; adminCsrf?: string }

export function accessBootScript(identity: Identity | null, login: string, session: string) {
  const config = JSON.stringify({ identity, login, session }).replaceAll("<", "\\u003c");
  return `(${boot.toString()})(${config});`;
}

/** No identity, credentials or business data cross tabs or go into storage. */
export function notifyAccessChange() {
  try {
    const channel = new BroadcastChannel("aihot-access");
    channel.postMessage("recheck");
    channel.close();
  } catch { /* storage/focus also notify */ }
  try { localStorage.setItem("aihot:access-epoch", `${Date.now()}:${Math.random()}`); } catch { /* optional */ }
}

function boot({ identity, login, session }: { identity: Identity | null; login: string; session: string }) {
  const root = document.documentElement;
  const nativeFetch = window.fetch.bind(window);
  let leaving = false;
  let revision = 0;
  let checking: Promise<boolean> | null = null;
  const hide = () => root.setAttribute("data-access-paused", "");
  const go = (to: string) => { if (leaving) return; leaving = true; hide(); location.replace(to); };
  const signIn = () => /^\/admin(?:\/|$)/i.test(location.pathname)
    ? `/api/auth/login?return=${encodeURIComponent(location.pathname + location.search)}`
    : `${login}?returnTo=${encodeURIComponent(location.pathname + location.search)}`;
  function verify(): Promise<boolean> {
    return checking ??= check().finally(() => { checking = null; });
  }
  async function check(): Promise<boolean> {
    if (!identity || leaving) return false;
    const attempt = ++revision;
    // A routine check (timer, focus, after a request) leaves the page as it is: hiding it every time made it flicker.
    // The page is hidden when the tab goes to the background (below) and stays so until the check passes, and
    // go() hides it when the session is gone.
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
      if (attempt === revision) go(location.href);
      return false;
    }
  }
  try {
    const channel = new BroadcastChannel("aihot-access");
    channel.onmessage = () => { revision++; void verify(); };
    channel.postMessage("recheck");
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
  window.addEventListener("pageshow", event => { if (event.persisted) go(location.href); });
  if (!identity) return;
  window.addEventListener("popstate", () => go(location.href), true);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") { revision++; hide(); } else void verify(); });
  window.addEventListener("focus", () => { void verify(); });
  document.addEventListener("click", event => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const link = (event.target as Element | null)?.closest<HTMLAnchorElement>("a[href]");
    if (!link || link.download || (link.target && link.target !== "_self")) return;
    const url = new URL(link.href, location.href);
    if (url.origin !== location.origin || (url.pathname === location.pathname && url.search === location.search && url.hash)) return;
    event.preventDefault(); event.stopImmediatePropagation(); hide(); leaving = true;
    location.assign(url.href);
  }, true);
  for (const method of ["pushState", "replaceState"] as const) {
    const original = history[method].bind(history);
    history[method] = (state, title, url) => {
      if (url != null) {
        const target = new URL(String(url), location.href);
        if (target.pathname + target.search !== location.pathname + location.search) { go(target.href); return; }
      }
      original(state, title, url);
    };
  }
  window.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), location.href);
    const sameOrigin = url.origin === location.origin;
    const response = await nativeFetch(input, sameOrigin ? { ...init, cache: "no-store" } : init);
    if (sameOrigin) {
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
