import { shell } from "electron";
import * as cheerio from "cheerio";
import type { BookSourceRecord } from "@shared/bookSource/types";
import type { AnalyzeUrl, StrResponse } from "./analyzeUrl";
import {
  fromLegadoCheckResult,
  toLegadoStrResponse,
  toLegadoConnectionResponse,
} from "./legadoStrResponse";
import {
  createJsExtensionHost,
  wrapLegadoMapLike,
  type JsExtensionHost,
} from "./jsExtensions";
import {
  getVerificationResult,
  isVerificationCancelled,
  resolveLoginPageUrl,
  VerificationCancelledError,
} from "./sourceVerification";
import {
  clearLoginSessionAck,
  getLoginHeader,
  getLoginSessionAck,
  putLoginHeader,
  removeLoginHeader,
  setLoginInfo,
} from "../store/bookSourceStore";
import { evalJs, evalJsAsync } from "./rhinoRuntime";

function buildLoginJava(
  analyzeUrl: AnalyzeUrl,
  host: JsExtensionHost,
  source: BookSourceRecord,
): Record<string, unknown> {
  const base = { ...host.javaBindings };
  return {
    ...base,
    // 与 AnalyzeUrl 同步：initUrl() 后须读到新 ruleUrl/url（勿快照）
    get ruleUrl() {
      return analyzeUrl.ruleUrl;
    },
    get url() {
      return analyzeUrl.url;
    },
    initUrl: () => {
      analyzeUrl.initUrl();
      return analyzeUrl;
    },
    getHeaderMap: () => ({ ...analyzeUrl.headerMap }),
    getStrResponse: async () => {
      const res = await analyzeUrl.getStrResponse();
      return toLegadoStrResponse(res, { statusCode: res.statusCode });
    },
    getResponse: async () => {
      const res = await analyzeUrl.getStrResponse();
      return toLegadoConnectionResponse(res, { statusCode: res.statusCode });
    },
    startBrowser: (url: string, title: string) => {
      void getVerificationResult(source.bookSourceUrl, url, title, {
        refetchAfterSuccess: false,
        source,
        host,
      }).catch(() => undefined);
    },
    startBrowserAwait: async (
      url: string,
      title: string,
      refetchAfterSuccess = false,
    ) => {
      const body = await getVerificationResult(source.bookSourceUrl, url, title, {
        refetchAfterSuccess: refetchAfterSuccess === true,
        source,
        host,
      });
      return toLegadoStrResponse({ url, body, headers: {} });
    },
    putLoginHeader: (headerJson: string) => {
      putLoginHeader(source.bookSourceUrl, headerJson);
    },
    getLoginHeader: () => getLoginHeader(source.bookSourceUrl),
  };
}

export async function runLoginCheckJs(
  analyzeUrl: AnalyzeUrl,
  source: BookSourceRecord,
  res: StrResponse,
  key: string,
  logs: string[],
): Promise<StrResponse> {
  const raw = source.loginCheckJs?.trim();
  if (!raw) return res;

  const host = createJsExtensionHost(source, logs);
  const legadoResult = toLegadoStrResponse(res);
  const java = buildLoginJava(analyzeUrl, host, source);

  try {
    const checked = await evalJsAsync(
      raw,
      {
        source,
        host,
        java,
        key,
        page: 1,
        result: legadoResult,
        baseUrl: source.bookSourceUrl,
      },
      { legadoAsync: true },
    );
    return fromLegadoCheckResult(checked, res);
  } catch (e) {
    if (isVerificationCancelled(e)) throw e;
    const msg = e instanceof Error ? e.message : String(e);
    logs.push(`loginCheckJs 错误: ${msg}`);
    return res;
  }
}

/**
 * 无 loginCheckJs 但配置了 loginUrl：搜索命中登录页时弹窗等待。
 * （Legado 仅跑 loginCheckJs；此处为未写检查脚本时的启发式。）
 * 用户取消则抛出 VerificationCancelledError，由上层跳过该书源。
 */
export async function awaitLoginForSearchPage(
  source: BookSourceRecord,
  res: StrResponse,
  analyzeUrl: AnalyzeUrl,
  logs: string[],
): Promise<StrResponse> {
  if (source.loginCheckJs?.trim()) return res;
  if (!source.loginUrl?.trim()) return res;
  if (!isLikelyLoginPage(res.body)) return res;

  // 仅认书源级登录确认 / 登录头；域名下匿名 Cookie 不算已登录
  if (hasLoginSession(source)) {
    logs.push(
      `检测到登录页特征但已有登录会话，跳过弹窗：${source.bookSourceName}`,
    );
    return res;
  }
  // 页头/弹层常残留登录 HTML，但书列表已能解析则视为非登录墙
  if (pageAlreadyHasCssBookList(source, res.body)) {
    logs.push(
      `检测到登录页特征但已命中书列表，跳过弹窗：${source.bookSourceName}`,
    );
    return res;
  }

  const host = createJsExtensionHost(source, logs);
  const loginPageUrl = resolveLoginPageUrl(source);
  logs.push(`检测到登录页，等待验证：${source.bookSourceName}`);

  await getVerificationResult(
    source.bookSourceUrl,
    loginPageUrl,
    `登录 · ${source.bookSourceName}`,
    { refetchAfterSuccess: false, source, host },
  );

  return analyzeUrl.getStrResponse();
}

export function hasLoginSession(source: BookSourceRecord): boolean {
  if (getLoginHeader(source.bookSourceUrl)?.trim()) return true;
  return getLoginSessionAck(source.bookSourceUrl);
}

function isLikelyLoginPage(body: string): boolean {
  const s = body.slice(0, 16000);
  const markers = [
    "账号登录",
    "发送验证码",
    "忘记密码",
    "登录账号即代表",
    "注册账号",
    "class=\"login",
    "id=\"login",
    "用户登录",
    "Just a moment",
    "百度安全验证",
    "var buid",
    "人机验证",
    "确认您是真人",
  ];
  let hit = 0;
  for (const m of markers) {
    if (s.includes(m)) hit += 1;
  }
  return hit >= 1;
}

/**
 * 搜索/发现页嵌了登录弹层，但 CSS 书列表已能命中时视为非登录墙。
 * 仅处理简单 CSS 选择器（如 `div.matchbook > div.view||ul.clearfix > li`）。
 */
function pageAlreadyHasCssBookList(
  source: BookSourceRecord,
  body: string,
): boolean {
  const rules = [
    source.ruleSearch?.bookList,
    source.ruleExplore?.bookList,
  ];
  let $: cheerio.CheerioAPI | null = null;
  for (const rule of rules) {
    const raw = rule?.trim();
    if (!raw) continue;
    for (const part of raw.split("||")) {
      const sel = part.trim().split("@")[0]?.trim() ?? "";
      if (!sel) continue;
      // 跳过 XPath / JsonPath / JS
      if (
        sel.startsWith("//")
        || sel.startsWith("$.")
        || sel.startsWith("@js")
        || sel.startsWith("<js>")
        || sel.includes("{{")
      ) {
        continue;
      }
      try {
        $ ??= cheerio.load(body);
        if ($(sel).length > 0) return true;
      } catch {
        /* ignore invalid selector */
      }
    }
  }
  return false;
}

export function runSourceLogin(
  source: BookSourceRecord,
  loginData: Record<string, string>,
  logs: string[] = [],
): void {
  if (Object.keys(loginData).length === 0) {
    setLoginInfo(source.bookSourceUrl, {});
    return;
  }
  setLoginInfo(source.bookSourceUrl, loginData);
  runLoginJs(source, loginData, logs);
}

export async function runLoginUiButton(
  source: BookSourceRecord,
  loginData: Record<string, string>,
  action: string,
  logs: string[] = [],
): Promise<void> {
  const actionTrim = action.trim();
  if (!actionTrim) return;

  if (/^https?:\/\//i.test(actionTrim)) {
    void shell.openExternal(actionTrim);
    return;
  }

  const host = createJsExtensionHost(source, logs, loginData);
  const loginJs = extractLoginJs(source.loginUrl) ?? "";
  const script = `${loginJs}\n${actionTrim}`;
  const legadoResult = wrapLegadoMapLike(loginData);
  await evalJsAsync(script, {
    source,
    host,
    book: legadoResult,
    result: legadoResult,
  });
}

function runLoginJs(
  source: BookSourceRecord,
  loginData: Record<string, string>,
  logs: string[],
): void {
  const loginJs = extractLoginJs(source.loginUrl);
  if (!loginJs) return;

  const host = createJsExtensionHost(source, logs, loginData);
  const legadoResult = wrapLegadoMapLike(loginData);
  const script = `${loginJs}
if (typeof login === 'function') {
  login.apply(this);
} else {
  throw new Error('书源未实现 login 函数');
}`;
  evalJs(script, { source, host, book: legadoResult, result: legadoResult });
}

export function clearSourceLoginSession(sourceUrl: string): void {
  setLoginInfo(sourceUrl, {});
  removeLoginHeader(sourceUrl);
  clearLoginSessionAck(sourceUrl);
}

export { VerificationCancelledError, isVerificationCancelled };

function extractLoginJs(loginUrl?: string | null): string | null {
  const raw = loginUrl?.trim();
  if (!raw) return null;
  if (raw.startsWith("@js:")) return raw.slice(4);
  if (raw.startsWith("<js>")) {
    return raw.slice(4, raw.lastIndexOf("<"));
  }
  return raw;
}
