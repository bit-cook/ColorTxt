import { createHash } from "node:crypto";
import { session, type Session } from "electron";
import { decodeHttpResponseBody } from "../../detectTextEncoding";
import { cookieHeaderForUrl, setCookieFromResponse } from "./cookieManager";
import {
  DEFAULT_BOOK_SOURCE_USER_AGENT,
  getWebViewUserAgent,
} from "./bookSourceUserAgent";
import {
  getDefaultBookSourceProxy,
  parseLegadoProxy,
} from "./httpProxy";

const MAX_BYTES = 8 * 1024 * 1024;

export type ChromiumNetFetchResult = {
  url: string;
  body: string;
  statusCode: number;
  statusMessage?: string;
  headers: Record<string, string>;
};

type SessionEntry = {
  ses: Session;
  proxyReady: Promise<void>;
};

const sessionByProxyKey = new Map<string, SessionEntry>();

function proxyCacheKey(proxy?: string | null): string {
  const text = String(proxy ?? "").trim() || getDefaultBookSourceProxy() || "";
  return text || "__direct__";
}

/**
 * 书源专用 session：Chromium 网络栈 + 忽略坏证书；按代理分区缓存。
 * 不用 defaultSession，避免 setCertificateVerifyProc 影响应用其它窗口。
 */
function getBookSourceNetSession(proxy?: string | null): SessionEntry {
  const key = proxyCacheKey(proxy);
  const existing = sessionByProxyKey.get(key);
  if (existing) return existing;

  const partition = `persist:colortxt-bs-net-${createHash("md5")
    .update(key)
    .digest("hex")
    .slice(0, 12)}`;
  const ses = session.fromPartition(partition);
  // 对齐 Legado SSLHelper.unsafe* / undici rejectUnauthorized:false
  ses.setCertificateVerifyProc((_request, callback) => {
    callback(0);
  });

  const parsed = parseLegadoProxy(
    key === "__direct__" ? "" : key,
  );
  const proxyReady = parsed
    ? ses.setProxy({ proxyRules: parsed.uri }).then(() => undefined)
    : ses.setProxy({ mode: "direct" }).then(() => undefined);

  const entry: SessionEntry = { ses, proxyReady };
  sessionByProxyKey.set(key, entry);
  return entry;
}

/**
 * 书源 HTTP：Electron `session.fetch`（Chromium TLS/HTTP2 指纹）。
 * 显式 `webView:true` / `java.webView` 仍走隐藏窗；此处不再做自动 webView 回退。
 */
export async function fetchViaChromiumNet(opts: {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string | Buffer | Uint8Array | null;
  charset?: string;
  timeoutMs?: number;
  proxy?: string | null;
  /** 未带 Cookie 头时是否附加 CookieJar（对齐 enabledCookieJar） */
  useCookieJar?: boolean;
  redirect?: RequestRedirect;
}): Promise<ChromiumNetFetchResult> {
  const method = (opts.method ?? "GET").toUpperCase();
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (!headers["User-Agent"] && !headers["user-agent"]) {
    headers["User-Agent"] = getWebViewUserAgent() || DEFAULT_BOOK_SOURCE_USER_AGENT;
  }
  if (
    opts.useCookieJar &&
    !headers.Cookie?.trim() &&
    !headers.cookie?.trim()
  ) {
    const ck = cookieHeaderForUrl(opts.url);
    if (ck) headers.Cookie = ck;
  }

  const init: RequestInit = {
    method,
    headers,
    redirect: opts.redirect ?? "follow",
    signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000),
  };
  if (method !== "GET" && method !== "HEAD" && opts.body != null) {
    // Electron/Chromium fetch 的 BodyInit；Node Buffer 需转为 Uint8Array
    init.body = (
      Buffer.isBuffer(opts.body)
        ? new Uint8Array(opts.body)
        : opts.body instanceof Uint8Array
          ? opts.body
          : opts.body
    ) as BodyInit;
  }

  const { ses, proxyReady } = getBookSourceNetSession(opts.proxy);
  await proxyReady;

  const res = await ses.fetch(opts.url, init);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_BYTES) {
    throw new Error(`Chromium net 响应过大 (${buf.length} > ${MAX_BYTES})`);
  }
  const contentType = res.headers.get("content-type") ?? undefined;
  const body = decodeHttpResponseBody(buf, {
    charset: opts.charset,
    contentType,
  });

  const outHeaders: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    outHeaders[k] = v;
  });
  const setCookie = res.headers.getSetCookie?.() ?? [];
  if (setCookie.length > 0) {
    setCookieFromResponse(opts.url, setCookie);
  } else {
    const sc = res.headers.get("set-cookie");
    if (sc) setCookieFromResponse(opts.url, sc);
  }

  return {
    url: res.url || opts.url,
    body,
    statusCode: res.status,
    statusMessage: res.statusText,
    headers: outHeaders,
  };
}
