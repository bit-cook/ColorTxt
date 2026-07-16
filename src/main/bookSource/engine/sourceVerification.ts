import { app, BrowserView, BrowserWindow, ipcMain } from "electron";
import type { WebContents } from "electron";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { BookSourceRecord } from "@shared/bookSource/types";
import {
  BOOK_SOURCE_IPC,
  type BookSourceCaptchaReply,
  type BookSourceCaptchaRequest,
} from "@shared/bookSource/ipc";
import { resolveWebLoginUrl } from "@shared/bookSource/url";
import { fetchStrResponse, splitUrlFetchOptions } from "./analyzeUrl";
import type { JsExtensionHost } from "./jsExtensions";
import { getWebViewUserAgent } from "./bookSourceUserAgent";
import {
  headersToLoadUrlExtraHeaders,
  resolveSourceRequestHeaders,
} from "./sourceRequestHeaders";
import {
  getDomainFromUrl,
  setCookieFromResponse,
  cookieHeaderForUrl,
} from "./cookieManager";
import {
  clearLoginSessionAck,
  setLoginSessionAck,
} from "../store/bookSourceStore";
import { WINDOW_MIN_WIDTH, WINDOW_MIN_HEIGHT } from "../../windowBounds";

const FOOTER_PADDING = 10;
/** 内边距 10px × 2 + 按钮行高约 32px */
const FOOTER_HEIGHT = FOOTER_PADDING * 2 + 32;
const VERIFICATION_ACTION_CHANNEL = "bookSource:verificationAction";

/** 书源登录/验证窗口图标 */
function resolveLoginVerificationIconPath(): string {
  const fileName =
    process.platform === "win32" ? "user.ico" : "user.png";
  return app.isPackaged
    ? path.join(process.resourcesPath, fileName)
    : path.join(app.getAppPath(), "resources", fileName);
}

/** 对齐 Legado SourceVerificationHelp：用户取消验证 */
export class VerificationCancelledError extends Error {
  constructor(message = "验证结果为空") {
    super(message);
    this.name = "VerificationCancelledError";
  }
}

type Pending = {
  resolve: (body: string) => void;
  reject: (err: Error) => void;
};

type ActiveVerification =
  | {
      kind: "browser";
      win: BrowserWindow;
      toolbarIds: number[];
    }
  | {
      kind: "captcha";
      requestId: string;
    };

const pending = new Map<string, Pending>();
const captchaPending = new Map<string, Pending>();
const activeWindows = new Map<string, ActiveVerification>();
const toolbarActionHandlers = new Map<number, (confirmed: boolean) => void>();
const captchaFinishHandlers = new Map<
  string,
  (payload: { ok: boolean; code: string }) => void
>();

let verificationIpcReady = false;

function isAppRendererWindow(win: BrowserWindow): boolean {
  if (win.isDestroyed() || win.webContents.isDestroyed()) return false;
  const url = win.webContents.getURL();
  return !url.startsWith("data:") && url !== "about:blank";
}

function sendToAppRenderers(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!isAppRendererWindow(win)) continue;
    win.webContents.send(channel, payload);
  }
}

function sendCaptchaRequest(payload: BookSourceCaptchaRequest): void {
  sendToAppRenderers(BOOK_SOURCE_IPC.captchaRequest, payload);
}

function sendCaptchaDismiss(requestId: string): void {
  sendToAppRenderers(BOOK_SOURCE_IPC.captchaDismiss, { requestId });
}

function ensureVerificationIpc(): void {
  if (verificationIpcReady) return;
  verificationIpcReady = true;
  ipcMain.on(VERIFICATION_ACTION_CHANNEL, (event, confirmed: unknown) => {
    toolbarActionHandlers.get(event.sender.id)?.(confirmed === true);
  });
  ipcMain.handle(BOOK_SOURCE_IPC.captchaReply, (_event, payload: unknown) => {
    const p =
      payload && typeof payload === "object"
        ? (payload as Partial<BookSourceCaptchaReply>)
        : {};
    const requestId = typeof p.requestId === "string" ? p.requestId : "";
    if (!requestId) return { ok: false };
    const handler = captchaFinishHandlers.get(requestId);
    if (!handler) return { ok: false };
    captchaFinishHandlers.delete(requestId);
    handler({
      ok: p.ok === true,
      code: typeof p.code === "string" ? p.code : "",
    });
    return { ok: true };
  });
}

function verificationToolbarHtml(): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<style>
  * { box-sizing: border-box; }
  html, body {
    margin: 0;
    height: 100%;
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
    font-size: 13px;
    background: var(--bg, #f3f3f3);
    color: var(--fg, #222);
    user-select: none;
  }
  .bar {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 8px;
    height: 100%;
    padding: ${FOOTER_PADDING}px;
    border-top: 1px solid var(--border, rgba(0,0,0,.12));
  }
  button {
    padding: 6px 14px;
    border-radius: 6px;
    border: 1px solid var(--border, rgba(0,0,0,.15));
    background: var(--btn-bg, #fff);
    color: inherit;
    cursor: pointer;
  }
  button:hover { background: var(--btn-hover, #ebebeb); }
  button.primary {
    background: #409eff;
    border-color: #409eff;
    color: #fff;
  }
  button.primary:hover { background: #79bbff; border-color: #79bbff; }
  @media (prefers-color-scheme: dark) {
    html, body {
      --bg: #2b2b2b;
      --fg: #eee;
      --border: rgba(255,255,255,.12);
      --btn-bg: #3a3a3a;
      --btn-hover: #444;
    }
    button.primary { background: #409eff; border-color: #409eff; }
    button.primary:hover { background: #3375b9; border-color: #3375b9; }
  }
</style>
</head>
<body>
  <div class="bar">
    <button type="button" id="cancel">取消</button>
    <button type="button" class="primary" id="ok">完成</button>
  </div>
  <script>
    const { ipcRenderer } = require("electron");
    const channel = ${JSON.stringify(VERIFICATION_ACTION_CHANNEL)};
    function send(ok) { ipcRenderer.send(channel, ok); }
    document.getElementById("ok").onclick = () => send(true);
    document.getElementById("cancel").onclick = () => send(false);
  </script>
</body>
</html>`;
}

export function clearVerificationResult(sourceKey: string): void {
  settlePending(sourceKey, "", false);
  settlePendingCode(sourceKey, "");
  closeVerificationWindow(sourceKey);
}

function closeVerificationWindow(sourceKey: string): void {
  const existing = activeWindows.get(sourceKey);
  if (!existing) return;
  activeWindows.delete(sourceKey);
  if (existing.kind === "browser") {
    for (const id of existing.toolbarIds) {
      toolbarActionHandlers.delete(id);
    }
    if (!existing.win.isDestroyed()) {
      existing.win.removeAllListeners("close");
      existing.win.close();
    }
    return;
  }
  captchaFinishHandlers.delete(existing.requestId);
  sendCaptchaDismiss(existing.requestId);
}

export function hasActiveVerification(sourceKey?: string): boolean {
  if (sourceKey) return activeWindows.has(sourceKey);
  return activeWindows.size > 0;
}

/** 取消搜索时关闭所有验证窗并 reject 等待中的 Promise */
export function dismissAllActiveVerifications(): void {
  for (const sourceKey of [...activeWindows.keys()]) {
    settlePending(sourceKey, "", false);
    settlePendingCode(sourceKey, "");
    closeVerificationWindow(sourceKey);
  }
}

async function persistSessionCookies(
  webContents: WebContents,
  pageUrl: string,
): Promise<void> {
  const cookies = await webContents.session.cookies.get({});
  for (const c of cookies) {
    const domain = c.domain?.replace(/^\./, "") ?? getDomainFromUrl(pageUrl);
    setCookieFromResponse(
      `https://${domain}/`,
      `${c.name}=${c.value}; Domain=${c.domain}; Path=${c.path ?? "/"}`,
    );
  }
}

async function readVerificationBody(
  webContents: WebContents,
  url: string,
  refetchAfterSuccess: boolean,
  source?: BookSourceRecord,
  host?: JsExtensionHost,
): Promise<string> {
  await persistSessionCookies(webContents, url);
  if (refetchAfterSuccess) {
    const res = await fetchStrResponse(url, { source, host });
    return res.body;
  }
  const html = await webContents.executeJavaScript(
    "document.documentElement.outerHTML",
  );
  return typeof html === "string" ? html : "";
}

function settlePending(sourceKey: string, body: string, confirmed = true): void {
  const p = pending.get(sourceKey);
  if (!p) return;
  pending.delete(sourceKey);
  if (!body.trim() && !confirmed) {
    p.reject(new VerificationCancelledError());
  } else if (!body.trim()) {
    // 用户已确认验证完成：Cookie 已写入即可，正文可为空
    p.resolve("");
  } else {
    p.resolve(body);
  }
}

function syncLoginSessionAckAfterVerification(
  sourceKey: string,
  confirmed: boolean,
): void {
  if (!confirmed || !sourceKey.trim()) return;
  // 登录窗点确认后：有 Cookie 记为已确认；登出后 Cookie 被清空则清除标记
  const ck = cookieHeaderForUrl(sourceKey);
  if (ck.trim()) setLoginSessionAck(sourceKey);
  else clearLoginSessionAck(sourceKey);
}

async function finishVerification(
  content: WebContents,
  sourceKey: string,
  url: string,
  refetchAfterSuccess: boolean,
  source?: BookSourceRecord,
  host?: JsExtensionHost,
  confirmed = true,
): Promise<void> {
  if (content.isDestroyed()) {
    syncLoginSessionAckAfterVerification(sourceKey, confirmed);
    settlePending(sourceKey, "", confirmed);
    return;
  }
  try {
    const body = await readVerificationBody(
      content,
      url,
      refetchAfterSuccess,
      source,
      host,
    );
    syncLoginSessionAckAfterVerification(sourceKey, confirmed);
    settlePending(sourceKey, body, confirmed);
  } catch {
    syncLoginSessionAckAfterVerification(sourceKey, confirmed);
    settlePending(sourceKey, "", confirmed);
  }
}

function layoutVerificationViews(
  win: BrowserWindow,
  footer: BrowserView,
  content: BrowserView,
): void {
  const [width, height] = win.getContentSize();
  const contentHeight = Math.max(0, height - FOOTER_HEIGHT);
  content.setBounds({ x: 0, y: 0, width, height: contentHeight });
  footer.setBounds({
    x: 0,
    y: contentHeight,
    width,
    height: FOOTER_HEIGHT,
  });
}

function showVerificationWindow(win: BrowserWindow): void {
  if (win.isDestroyed()) return;
  win.show();
  win.focus();
  win.moveTop();
  win.setAlwaysOnTop(true, "floating");
  win.once("focus", () => {
    if (!win.isDestroyed()) win.setAlwaysOnTop(false);
  });
}

function parseVerificationUrl(raw: string): string {
  const trimmed = raw.trim();
  const comma = trimmed.indexOf(",");
  if (comma > 0 && trimmed.slice(comma + 1).trim().startsWith("{")) {
    return trimmed.slice(0, comma).trim();
  }
  return trimmed;
}

function openVerificationWindow(
  sourceKey: string,
  url: string,
  title: string,
  refetchAfterSuccess: boolean,
  source?: BookSourceRecord,
  host?: JsExtensionHost,
): void {
  void openVerificationWindowAsync(
    sourceKey,
    url,
    title,
    refetchAfterSuccess,
    source,
    host,
  ).catch((err) => {
    host?.log(
      `[验证] 打开失败: ${err instanceof Error ? err.message : String(err)}`,
    );
    settlePending(sourceKey, "", false);
  });
}

async function openVerificationWindowAsync(
  sourceKey: string,
  url: string,
  title: string,
  refetchAfterSuccess: boolean,
  source?: BookSourceRecord,
  host?: JsExtensionHost,
): Promise<void> {
  ensureVerificationIpc();

  const pageUrl = parseVerificationUrl(url);
  host?.log(`[验证] 打开浏览器: ${pageUrl}`);

  // 每次验证都使用新窗口（旧窗 finished 后按钮失效，不可复用）
  closeVerificationWindow(sourceKey);

  let finished = false;
  const win = new BrowserWindow({
    title: title || "验证",
    width: 960,
    height: 720,
    minWidth: WINDOW_MIN_WIDTH,
    minHeight: WINDOW_MIN_HEIGHT,
    autoHideMenuBar: true,
    show: true,
    center: true,
    icon: resolveLoginVerificationIconPath(),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });
  win.removeMenu();
  win.setMenuBarVisibility(false);

  const footer = new BrowserView({
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      sandbox: false,
    },
  });
  const content = new BrowserView({
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  win.addBrowserView(content);
  win.addBrowserView(footer);
  layoutVerificationViews(win, footer, content);

  const requestHeaders = source
    ? await resolveSourceRequestHeaders(source, {
        host,
        logs: host?.logs,
        baseUrl: pageUrl,
      })
    : {};
  const userAgent =
    requestHeaders["User-Agent"] ??
    requestHeaders["user-agent"] ??
    getWebViewUserAgent();
  const extraHeaders = headersToLoadUrlExtraHeaders(
    Object.fromEntries(
      Object.entries(requestHeaders).filter(([k]) => !/^user-agent$/i.test(k)),
    ),
  );
  content.webContents.setUserAgent(userAgent);

  const finish = async (confirmed: boolean) => {
    if (finished) return;
    finished = true;
    toolbarActionHandlers.delete(footer.webContents.id);
    activeWindows.delete(sourceKey);
    if (confirmed && !content.webContents.isDestroyed()) {
      await finishVerification(
        content.webContents,
        sourceKey,
        url,
        refetchAfterSuccess,
        source,
        host,
        true,
      );
    } else {
      settlePending(sourceKey, "", false);
    }
    if (!win.isDestroyed()) win.close();
  };

  const safeFinish = (confirmed: boolean) => {
    void finish(confirmed).catch((err) => {
      if (isVerificationCancelled(err)) return;
      host?.log(
        `[验证] 结束失败: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  };

  toolbarActionHandlers.set(footer.webContents.id, (confirmed) => {
    safeFinish(confirmed);
  });

  activeWindows.set(sourceKey, {
    kind: "browser",
    win,
    toolbarIds: [footer.webContents.id],
  });

  const syncCookies = () => {
    const pageUrl = content.webContents.getURL();
    if (pageUrl && !pageUrl.startsWith("about:")) {
      void persistSessionCookies(content.webContents, pageUrl);
    }
  };
  content.webContents.on("did-navigate", syncCookies);
  content.webContents.on("did-navigate-in-page", syncCookies);
  content.webContents.on(
    "did-fail-load",
    (_ev, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame || !validatedURL || validatedURL.startsWith("about:")) return;
      host?.log(
        `[验证] 无法打开 ${validatedURL}（${errorDescription || errorCode}）`,
      );
    },
  );

  win.on("resize", () => layoutVerificationViews(win, footer, content));
  win.on("close", () => {
    toolbarActionHandlers.delete(footer.webContents.id);
    if (!finished) safeFinish(false);
    else activeWindows.delete(sourceKey);
  });

  void footer.webContents.loadURL(
    `data:text/html;charset=utf-8,${encodeURIComponent(verificationToolbarHtml())}`,
  );
  // 推迟到下一轮事件循环，确保 getVerificationResult 的 Promise 已被 await 挂接
  queueMicrotask(() => {
    void content.webContents
      .loadURL(pageUrl, extraHeaders ? { extraHeaders } : undefined)
      .catch((err) => {
        host?.log(
          `[验证] 页面加载失败: ${err instanceof Error ? err.message : String(err)}`,
        );
        // 对齐 Legado：加载失败仍保留窗口，由用户手动完成或取消
      });
  });

  // 仅含 BrowserView 时 ready-to-show 可能永不触发，须立即显示
  showVerificationWindow(win);
  setTimeout(() => {
    if (!win.isDestroyed() && !win.isVisible()) showVerificationWindow(win);
  }, 400);
}

/**
 * 对齐 Legado SourceVerificationHelp.getVerificationResult：
 * 打开浏览器并阻塞当前搜索任务，其它书源并行继续。
 */
export function getVerificationResult(
  sourceKey: string,
  url: string,
  title: string,
  options: {
    refetchAfterSuccess?: boolean;
    source?: BookSourceRecord;
    host?: JsExtensionHost;
  } = {},
): Promise<string> {
  clearVerificationResult(sourceKey);
  const refetch = options.refetchAfterSuccess !== false;

  return new Promise((resolve, reject) => {
    pending.set(sourceKey, { resolve, reject });
    openVerificationWindow(
      sourceKey,
      url,
      title,
      refetch,
      options.source,
      options.host,
    );
  });
}

async function fetchCaptchaImageDataUrl(
  imageUrl: string,
  source?: BookSourceRecord,
  host?: JsExtensionHost,
): Promise<string> {
  let url = imageUrl.trim();
  let method = "GET";
  let body: string | undefined;
  let headers: Record<string, string> = {};
  if (source) {
    headers = await resolveSourceRequestHeaders(source, {
      host,
      logs: host?.logs,
      baseUrl: parseVerificationUrl(url),
    });
  }
  const split = splitUrlFetchOptions(url);
  if (split.options && Object.keys(split.options).length > 0) {
    url = split.urlPart;
    headers = { ...headers, ...split.options.headers };
    if (split.options.method) method = split.options.method;
    if (split.options.body != null) body = split.options.body;
  }
  if (source?.enabledCookieJar) {
    const ck = cookieHeaderForUrl(url);
    if (ck) headers.Cookie = headers.Cookie ? `${headers.Cookie}; ${ck}` : ck;
  }
  if (!headers["User-Agent"] && !headers["user-agent"]) {
    headers["User-Agent"] = getWebViewUserAgent();
  }
  if (
    body &&
    !headers["Content-Type"] &&
    !headers["content-type"]
  ) {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
  }
  const res = await fetch(url, {
    method,
    headers,
    body: method === "GET" || method === "HEAD" ? undefined : body,
    redirect: "follow",
  });
  const buffer = Buffer.from(await res.arrayBuffer());
  const setCookie = res.headers.getSetCookie?.() ?? [];
  if (setCookie.length > 0) {
    setCookieFromResponse(url, setCookie);
  } else {
    const sc = res.headers.get("set-cookie");
    if (sc) setCookieFromResponse(url, sc);
  }
  const contentType = res.headers.get("content-type") ?? "image/png";
  return `data:${contentType.split(";")[0]};base64,${buffer.toString("base64")}`;
}

function settlePendingCode(sourceKey: string, code: string): void {
  const p = captchaPending.get(sourceKey);
  if (!p) return;
  captchaPending.delete(sourceKey);
  if (!code.trim()) {
    p.reject(new VerificationCancelledError());
  } else {
    p.resolve(code.trim());
  }
}

async function openCaptchaInAppAsync(
  sourceKey: string,
  imageUrl: string,
  options: {
    source?: BookSourceRecord;
    host?: JsExtensionHost;
  } = {},
): Promise<void> {
  ensureVerificationIpc();
  const { source, host } = options;
  closeVerificationWindow(sourceKey);

  host?.log(`[验证] 打开验证码: ${parseVerificationUrl(imageUrl)}`);
  let imageDataUrl: string;
  try {
    imageDataUrl = await fetchCaptchaImageDataUrl(imageUrl, source, host);
  } catch (e) {
    host?.log(
      `[验证] 验证码图片加载失败: ${e instanceof Error ? e.message : String(e)}`,
    );
    settlePendingCode(sourceKey, "");
    return;
  }

  const requestId = randomUUID();
  const sourceName = source?.bookSourceName ?? "";
  let finished = false;

  const finish = (payload: { ok: boolean; code: string }) => {
    if (finished) return;
    finished = true;
    captchaFinishHandlers.delete(requestId);
    activeWindows.delete(sourceKey);
    if (payload.ok && payload.code.trim()) {
      host?.log(`[验证] 验证码已提交 (${payload.code.trim().length} 位)`);
      settlePendingCode(sourceKey, payload.code);
    } else {
      host?.log("[验证] 验证码已取消");
      settlePendingCode(sourceKey, "");
    }
    sendCaptchaDismiss(requestId);
  };

  captchaFinishHandlers.set(requestId, finish);
  activeWindows.set(sourceKey, { kind: "captcha", requestId });
  sendCaptchaRequest({ requestId, sourceName, imageDataUrl });
}

/**
 * 对齐 Legado JsExtensions.getVerificationCode：图片验证码对话框，返回用户输入。
 */
export function getVerificationCodeResult(
  sourceKey: string,
  imageUrl: string,
  options: {
    source?: BookSourceRecord;
    host?: JsExtensionHost;
  } = {},
): Promise<string> {
  clearVerificationResult(sourceKey);
  return new Promise((resolve, reject) => {
    captchaPending.set(sourceKey, { resolve, reject });
    void openCaptchaInAppAsync(sourceKey, imageUrl, options).catch((err) => {
      options.host?.log(
        `[验证] 验证码窗口失败: ${err instanceof Error ? err.message : String(err)}`,
      );
      settlePendingCode(sourceKey, "");
    });
  });
}

export function isVerificationCancelled(err: unknown): boolean {
  return err instanceof VerificationCancelledError;
}

export function resolveLoginPageUrl(source: BookSourceRecord): string {
  return resolveWebLoginUrl(source);
}
