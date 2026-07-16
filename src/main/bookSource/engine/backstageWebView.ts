import { BrowserWindow } from "electron";
import type { BookSourceRecord } from "@shared/bookSource/types";
import {
  headersToLoadUrlExtraHeaders,
  resolveSourceRequestHeaders,
} from "./sourceRequestHeaders";
import { getWebViewUserAgent } from "./bookSourceUserAgent";
import {
  cookieHeaderForUrl,
  getDomainFromUrl,
  setCookieFromResponse,
} from "./cookieManager";
import type { JsExtensionHost } from "./jsExtensions";

export type BackstageWebViewOptions = {
  html?: string | null;
  url?: string | null;
  js?: string | null;
  source?: BookSourceRecord;
  host?: JsExtensionHost;
  headers?: Record<string, string>;
  delayMs?: number;
  timeoutMs?: number;
  injectResult?: unknown;
  overrideUrlRegex?: string | null;
  cacheFirst?: boolean;
};

const WEBVIEW_CONTEXT = `
var result = typeof window.result !== 'undefined' ? window.result : '';
var src = document.documentElement ? document.documentElement.outerHTML : '';
var baseUrl = location.href;
`;

/**
 * 对齐 Android WebView.evaluateJavascript：默认脚本是「表达式」求值。
 */
function buildWebViewEvalScript(userScript: string): string {
  const trimmed = userScript.trim() || "document.documentElement.outerHTML";
  const looksLikeStatementBlock =
    /\b(var|let|const|function|if|for|while|return|class|switch|try)\b/.test(
      trimmed,
    ) ||
    trimmed.includes(";") ||
    trimmed.includes("\n");
  const body = looksLikeStatementBlock
    ? trimmed
    : `return (${trimmed});`;

  return `
    (async function() {
      ${WEBVIEW_CONTEXT}
      try {
        const __out = await (async function() {
          ${body}
        })();
        if (__out === undefined || __out === null) return "";
        if (typeof __out === "object") return JSON.stringify(__out);
        return String(__out);
      } catch (e) {
        return "";
      }
    })()
  `;
}

/** 标记隐藏后台窗，避免被当成「末窗」挡 quit */
export const BACKSTAGE_WEBVIEW_FLAG = "__colortxtBackstageWebView";

const activeBackstageWindows = new Set<BrowserWindow>();

export function isBackstageWebViewWindow(win: BrowserWindow): boolean {
  return (win as unknown as Record<string, unknown>)[BACKSTAGE_WEBVIEW_FLAG] === true;
}

/** 末个可见窗关闭 / 退出前：强制拆掉后台 WebView，否则 process 不退出 */
export function destroyAllBackstageWebViews(): void {
  for (const win of [...activeBackstageWindows]) {
    try {
      if (!win.isDestroyed()) win.destroy();
    } catch {
      /* ignore */
    }
  }
  activeBackstageWindows.clear();
}

export function stripWebJsRule(rule: string): string {
  return rule.replace(/^@webjs:\s*/i, "").trim();
}

async function persistWebViewCookies(
  webContents: Electron.WebContents,
  pageUrl: string,
): Promise<void> {
  const cookies = await webContents.session.cookies.get({});
  for (const c of cookies) {
    const domain = c.domain?.replace(/^\./, "") ?? getDomainFromUrl(pageUrl);
    setCookieFromResponse(
      `https://${domain}/`,
      `${c.name}=${c.value}; Domain=${c.domain ?? domain}; Path=${c.path ?? "/"}`,
    );
  }
}

/** 将 CookieJar 写入 Electron session，供页面脚本/AJAX 使用 */
async function seedSessionCookies(
  webContents: Electron.WebContents,
  pageUrl: string,
): Promise<void> {
  const header = cookieHeaderForUrl(pageUrl);
  if (!header.trim()) return;
  const domain = getDomainFromUrl(pageUrl);
  const cookieUrl = `https://${domain}/`;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (!name) continue;
    try {
      await webContents.session.cookies.set({
        url: cookieUrl,
        name,
        value,
        path: "/",
      });
    } catch {
      /* ignore invalid cookie */
    }
  }
}

function isEmptyEvalResult(text: string): boolean {
  return !text || text === "null" || text === "undefined";
}

function attachTrustAnyCertificate(wc: Electron.WebContents): void {
  // 对齐 Legado BackstageWebView.onReceivedSslError → proceed()
  wc.on("certificate-error", (event, _url, _error, _cert, callback) => {
    event.preventDefault();
    callback(true);
  });
}

function registerBackstageWindow(win: BrowserWindow): void {
  (win as unknown as Record<string, unknown>)[BACKSTAGE_WEBVIEW_FLAG] = true;
  activeBackstageWindows.add(win);
  win.on("closed", () => {
    activeBackstageWindows.delete(win);
  });
}

function destroyBackstageWindow(win: BrowserWindow): void {
  activeBackstageWindows.delete(win);
  try {
    if (!win.isDestroyed()) win.destroy();
  } catch {
    /* ignore */
  }
}

export async function runBackstageWebView(
  opts: BackstageWebViewOptions,
): Promise<string> {
  // 对齐 Legado BackstageWebView.getStrResponse：withTimeout(60000)
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const pageUrl = (opts.url?.trim() || "about:blank").split(",")[0]!.trim();
  const html = opts.html?.trim() ?? "";
  const userScript = opts.js?.trim() || "document.documentElement.outerHTML";
  // 对齐 Legado BackstageWebView：onPageFinished 后 `1000 + webViewDelayTime` 再执行 JS
  const delayMs = 1000 + Math.max(0, opts.delayMs ?? 0);

  let headers = { ...(opts.headers ?? {}) };
  if (opts.source) {
    headers = {
      ...(await resolveSourceRequestHeaders(opts.source, {
        baseUrl: pageUrl.startsWith("http") ? pageUrl : opts.source.bookSourceUrl,
        host: opts.host,
        logs: opts.host?.logs,
      })),
      ...headers,
    };
  }
  // 对齐 Legado CookieManager：WebView 请求带上 CookieJar（部分书源 AJAX 正文依赖登录态）
  if (pageUrl.startsWith("http") && !headers.Cookie?.trim() && !headers.cookie?.trim()) {
    const ck = cookieHeaderForUrl(pageUrl);
    if (ck) headers.Cookie = ck;
  }
  const userAgent =
    headers["User-Agent"] ??
    headers["user-agent"] ??
    getWebViewUserAgent();

  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 800,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      // 对齐 Legado blockNetworkImage：挡图片，减轻多余 HTTPS 握手失败噪音
      javascript: true,
      images: false,
    },
  });
  registerBackstageWindow(win);

  const run = async (): Promise<string> => {
    const wc = win.webContents;
    wc.setUserAgent(userAgent);
    attachTrustAnyCertificate(wc);
    if (pageUrl.startsWith("http")) {
      await seedSessionCookies(wc, pageUrl);
    }

    if (opts.overrideUrlRegex) {
      const re = new RegExp(opts.overrideUrlRegex);
      return await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("webView 跳转匹配超时")),
          timeoutMs,
        );
        const onNav = (_event: Electron.Event, url: string) => {
          if (!re.test(url)) return;
          clearTimeout(timer);
          cleanup();
          resolve(url);
        };
        const cleanup = () => {
          wc.removeListener("will-navigate", onNav);
          wc.removeListener("did-navigate", onNav);
        };
        wc.on("will-navigate", onNav);
        wc.on("did-navigate", onNav);
        void loadWebViewContent(wc, pageUrl, html, headers).catch((err) => {
          clearTimeout(timer);
          cleanup();
          reject(err);
        });
      });
    }

    await loadWebViewContent(wc, pageUrl, html, headers, timeoutMs);

    if (delayMs > 0) {
      await new Promise((r) => setTimeout(r, delayMs));
    }

    if (opts.injectResult != null) {
      const json = JSON.stringify(opts.injectResult);
      await wc.executeJavaScript(`window.result = ${json};`);
    }

    const wrappedScript = buildWebViewEvalScript(userScript);

    // 对齐 Legado EvalJsRunnable：非空且非 "null" 即返回；否则最多再试 30 次（间隔 1s）
    let last = "";
    for (let retry = 0; ; retry++) {
      const raw = await wc.executeJavaScript(wrappedScript, true);
      last = typeof raw === "string" ? raw : String(raw ?? "");
      if (!isEmptyEvalResult(last)) break;
      if (retry >= 30) {
        throw new Error("webView js 执行超时（空结果）");
      }
      await new Promise((r) => setTimeout(r, 1000));
    }

    if (pageUrl.startsWith("http")) {
      await persistWebViewCookies(wc, pageUrl);
    }
    return last;
  };

  const work = run();
  // 超时后仍会 destroy 窗口；吞掉后到的拒绝，避免 unhandledRejection
  void work.catch(() => {});
  let overallTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<string>((_, reject) => {
        overallTimer = setTimeout(
          () => reject(new Error("webView 总体超时")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (overallTimer) clearTimeout(overallTimer);
    destroyBackstageWindow(win);
  }
}

async function loadWebViewContent(
  wc: Electron.WebContents,
  pageUrl: string,
  html: string,
  headers: Record<string, string>,
  timeoutMs = 60_000,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("webView 页面加载超时")),
      timeoutMs,
    );
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    const fail = (_: unknown, code: number, desc: string) => {
      if (code === -3) return;
      clearTimeout(timer);
      reject(new Error(`webView 加载失败: ${desc || code}`));
    };
    wc.once("did-finish-load", done);
    wc.once("did-fail-load", fail);

    if (html) {
      void wc
        .loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`, {
          baseURLForDataURL: pageUrl.startsWith("http") ? pageUrl : undefined,
        })
        .catch((err) => {
          clearTimeout(timer);
          reject(err);
        });
      return;
    }
    if (pageUrl.startsWith("http")) {
      const extraHeaders = headersToLoadUrlExtraHeaders(
        Object.fromEntries(
          Object.entries(headers).filter(([k]) => !/^user-agent$/i.test(k)),
        ),
      );
      void wc
        .loadURL(pageUrl, extraHeaders ? { extraHeaders } : undefined)
        .catch((err) => {
          clearTimeout(timer);
          reject(err);
        });
      return;
    }
    void wc.loadURL("about:blank").catch((err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}
