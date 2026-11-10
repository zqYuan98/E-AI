// 调国网采集服务（fetcher/，同一 compose 里的内部容器）：它用真实浏览器打开国网公告、下载公告文件并解析里面的 Excel。
// 地址和令牌在 .env 的 OPPORTUNITIES_FETCHER_URL / OPPORTUNITIES_FETCHER_TOKEN；没配时项目商机不采集。
import { credential } from "@aihot/backend/config";
import type { FetcherNotice, FetcherResult, SourceKey } from "../types.ts";

export class FetcherError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  constructor(code: string, message: string, retryable: boolean) {
    super(message);
    this.code = code;
    this.retryable = retryable;
  }
}

export function fetcherUrl(): string | null {
  const url = credential("integrations", "OPPORTUNITIES_FETCHER_URL");
  return url && /^https?:\/\/[^/?#\s]+$/.test(url.replace(/\/+$/, "")) ? url.replace(/\/+$/, "") : null;
}

async function call<T>(path: string, body: unknown, timeoutMs: number): Promise<T> {
  const base = fetcherUrl();
  const token = credential("integrations", "OPPORTUNITIES_FETCHER_TOKEN");
  if (!base || !token) throw new FetcherError("not_configured", "采集服务没有配置", false);
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new FetcherError("network", "采集服务没有响应", true);
  }
  const payload = await res.json().catch(() => null) as { error?: { code?: string; message?: string; retryable?: boolean } } | null;
  if (!res.ok) {
    const e = payload?.error;
    throw new FetcherError(String(e?.code ?? `http_${res.status}`), String(e?.message ?? `采集服务返回 ${res.status}`).slice(0, 300), e?.retryable ?? res.status >= 500);
  }
  return payload as T;
}

export async function discover(source: SourceKey, category: "procurement" | "tender", limit: number): Promise<FetcherNotice[]> {
  const out = await call<{ notices?: FetcherNotice[] }>("/discover", { source, category, limit }, 200_000);
  return Array.isArray(out.notices) ? out.notices : [];
}

export async function fetchNotice(url: string): Promise<FetcherResult> {
  return call<FetcherResult>("/fetch", { url }, 360_000);
}
