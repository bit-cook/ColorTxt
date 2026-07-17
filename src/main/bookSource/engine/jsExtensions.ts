import { createHash } from "node:crypto";
import type { BookSourceRecord } from "@shared/bookSource/types";
import { resolveWebLoginUrl } from "@shared/bookSource/url";
import {
  getCacheValue,
  getLoginInfo,
  getLoginHeader,
  getSourceVariable,
  putCacheValue,
  putLoginHeader,
  removeCacheValue,
  setLoginInfo,
  setSourceVariable,
} from "../store/bookSourceStore";
import {
  cookieHeaderForUrl,
  getCookieKey,
  getDomainFromUrl,
  removeDomainCookies,
  replaceCookieForUrl,
  setCookieForUrl,
  cookieStringToMap,
  mapToCookieString,
} from "./cookieManager";
import { ajaxAllStrResponses, fetchStrResponse, normalizeUrlFetchOptions, splitUrlFetchOptions } from "./analyzeUrl";
import { getWebViewUserAgent, getAndroidId } from "./bookSourceUserAgent";
import { appendBookSourceErrorLog } from "./bookSourceErrorLog";
import { getVerificationResult, isVerificationCancelled, getVerificationCodeResult } from "./sourceVerification";
import { toLegadoStrResponse, toLegadoConnectionResponse, toLegadoJsoupResponse } from "./legadoStrResponse";
import { sourceVariableCacheKey } from "./legadoCompositeRule";
import { assertJsEvalAlive, isBookSourceJsTimeoutError } from "./bookSourceJsTimeout";
import {
  aesBase64DecodeToString,
  aesDecodeToString,
  createSymmetricCrypto,
} from "./legadoCrypto";
import {
  desEncodeToBase64String,
  encodeLegadoUri,
  hMacBase64,
  hMacHex,
  legadoJsonValueToString,
  legadoRandomUUID,
  legadoS2t,
  legadoT2s,
  timeFormatUtc,
  timeFormat,
} from "./legadoJavaApi";
import { runBackstageWebView } from "./backstageWebView";
import { cacheFile, importScript, readTxtFile } from "./scriptImport";
import { updateConcurrentRate } from "./concurrentRateLimiter";
import { toNumChapter } from "./legadoStringUtils";
import { emitBookSourceToast } from "./bookSourceToast";

/** 对齐 Legado JsEncodeUtils.digestHex / Hutool DigestUtil.digester */
function normalizeDigestAlgorithm(algorithm: string): string {
  const key = algorithm.trim().toLowerCase().replace(/-/g, "");
  const map: Record<string, string> = {
    md5: "md5",
    sha1: "sha1",
    sha256: "sha256",
    sha384: "sha384",
    sha512: "sha512",
  };
  return map[key] ?? key;
}

function digestHex(data: unknown, algorithm: unknown): string {
  const algo = normalizeDigestAlgorithm(String(algorithm ?? "MD5"));
  try {
    return createHash(algo).update(String(data ?? ""), "utf8").digest("hex");
  } catch {
    return "";
  }
}

export type JsExtensionHost = {
  source: BookSourceRecord;
  sourceWrapper: Record<string, unknown>;
  javaBindings: Record<string, unknown>;
  cookieBindings: Record<string, unknown>;
  cacheBindings: Record<string, unknown>;
  log: (msg: string) => void;
  logs: string[];
};

const FILE_CACHE_PREFIX = "file:";
const memoryCaches = new Map<string, Map<string, unknown>>();

function memoryCacheFor(sourceUrl: string): Map<string, unknown> {
  let m = memoryCaches.get(sourceUrl);
  if (!m) {
    m = new Map();
    memoryCaches.set(sourceUrl, m);
  }
  return m;
}

function cacheValueToString(value: unknown): string {
  if (value == null) return "";
  if (Array.isArray(value)) return value.map((v) => String(v)).join(",");
  return String(value);
}

function createCacheBindings(source: BookSourceRecord) {
  const url = source.bookSourceUrl;
  const mem = () => memoryCacheFor(url);

  return {
    get: (key: string) => getCacheValue(url, key),
    put: (key: string, value: unknown, _saveTime?: number) => {
      putCacheValue(url, key, cacheValueToString(value));
    },
    /** Legado CacheManager.getFile：大体积/文件型缓存（ACache） */
    getFile: (key: string) => {
      const v = getCacheValue(url, `${FILE_CACHE_PREFIX}${key}`);
      if (v == null || v.trim() === "") return null;
      return v;
    },
    putFile: (key: string, value: unknown, _saveTime?: number) => {
      const stored = cacheValueToString(value);
      const cacheKey = `${FILE_CACHE_PREFIX}${key}`;
      if (!stored) {
        removeCacheValue(url, cacheKey);
        return;
      }
      putCacheValue(url, cacheKey, stored);
    },
    delete: (key: string) => {
      removeCacheValue(url, key);
      removeCacheValue(url, `${FILE_CACHE_PREFIX}${key}`);
      mem().delete(key);
    },
    getFromMemory: (key: string) => mem().get(key) ?? null,
    putMemory: (key: string, value: unknown) => {
      mem().set(key, value);
    },
    deleteMemory: (key: string) => {
      mem().delete(key);
    },
    getInt: (key: string) => {
      const v = getCacheValue(url, key);
      if (v == null) return null;
      const n = Number.parseInt(v, 10);
      return Number.isFinite(n) ? n : null;
    },
    getLong: (key: string) => {
      const v = getCacheValue(url, key);
      if (v == null) return null;
      const n = Number.parseInt(v, 10);
      return Number.isFinite(n) ? n : null;
    },
    getDouble: (key: string) => {
      const v = getCacheValue(url, key);
      if (v == null) return null;
      const n = Number.parseFloat(v);
      return Number.isFinite(n) ? n : null;
    },
    getFloat: (key: string) => {
      const v = getCacheValue(url, key);
      if (v == null) return null;
      const n = Number.parseFloat(v);
      return Number.isFinite(n) ? n : null;
    },
  };
}

function loadPersistedLoginInfo(sourceUrl: string): Record<string, string> {
  try {
    return getLoginInfo(sourceUrl);
  } catch {
    return {};
  }
}

function mergeLoginInfo(
  persisted: Record<string, string>,
  override?: Record<string, string>,
): Record<string, string> {
  if (!override) return persisted;
  return { ...persisted, ...override };
}

/** 对齐 Legado BaseSource.getLoginInfoMap：无有效字段时返回 null */
function hasNonEmptyLoginField(info: Record<string, string>): boolean {
  return Object.values(info).some((v) => v != null && String(v).trim() !== "");
}

/** Legado Map 风格：result.get / source.getLoginInfoMap().get */
export function wrapLegadoMapLike<T extends Record<string, string>>(
  data: T,
): T & { get(key: string): string } {
  return {
    ...data,
    get(key: string) {
      return data[key] ?? "";
    },
  };
}

function parseLoginHeaderMap(raw: string | null | undefined): Record<string, string> {
  const text = raw?.trim();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        out[k] = String(v ?? "");
      }
      return out;
    }
  } catch {
    /* query string */
  }
  const out: Record<string, string> = {};
  for (const part of text.split(/[&;]/)) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

export function createJsExtensionHost(
  source: BookSourceRecord,
  logs: string[] = [],
  loginDataOverride?: Record<string, string>,
): JsExtensionHost {
  const loginInfo = mergeLoginInfo(
    loadPersistedLoginInfo(source.bookSourceUrl),
    loginDataOverride,
  );

  const loginInfoMap = () => {
    if (!hasNonEmptyLoginField(loginInfo)) return null;
    return {
      ...loginInfo,
      get(key: string) {
        return loginInfo[key] ?? "";
      },
    };
  };

  const host: JsExtensionHost = {
    source,
    logs,
    log(msg: string) {
      logs.push(msg);
    },
    sourceWrapper: {},
    javaBindings: {},
    cookieBindings: {},
    cacheBindings: {},
  };

  host.sourceWrapper = {
    getKey: () => source.bookSourceUrl,
    // Legado Rhino 将 getKey() 暴露为 source.key；书源 JS 普遍使用 source.key
    key: source.bookSourceUrl,
    bookSourceUrl: source.bookSourceUrl,
    bookSourceName: source.bookSourceName,
    header: source.header ?? "",
    loginUrl: source.loginUrl ?? "",
    loginCheckJs: source.loginCheckJs ?? "",
    bookSourceComment: source.bookSourceComment ?? "",
    getLoginInfoMap: loginInfoMap,
    getLoginHeaderMap: () => {
      const map = parseLoginHeaderMap(getLoginHeader(source.bookSourceUrl));
      if (!Object.keys(map).length) return null;
      return wrapLegadoMapLike(map);
    },
    getLoginInfo: () => loginInfo,
    get: (key: string) =>
      getCacheValue(source.bookSourceUrl, sourceVariableCacheKey(source.bookSourceUrl, key)) ??
      "",
    put: (key: string, value: unknown) => {
      const s = String(value ?? "");
      putCacheValue(
        source.bookSourceUrl,
        sourceVariableCacheKey(source.bookSourceUrl, key),
        s,
      );
      return s;
    },
    getVariable: () => getSourceVariable(source.bookSourceUrl),
    setVariable: (value: unknown) => {
      const s = value == null ? "" : String(value);
      setSourceVariable(source.bookSourceUrl, s || null);
      return s;
    },
    putConcurrent: (value: unknown) => {
      const s = String(value ?? "");
      source.concurrentRate = s;
      updateConcurrentRate(source.bookSourceUrl, s);
      return s;
    },
    getLoginHeader: () => {
      const header = getLoginHeader(source.bookSourceUrl);
      if (header?.trim()) return header;
      const parts = Object.entries(loginInfo).map(([k, v]) => `${k}=${v}`);
      return parts.join("&");
    },
    variableComment: source.variableComment ?? "",
  };

  host.cacheBindings = createCacheBindings(source);

  host.cookieBindings = {
    getKey: (domain: string, name: string) => getCookieKey(domain, name) ?? "",
    getCookie: (domain: string) => {
      const d = getDomainFromUrl(domain.includes("://") ? domain : `https://${domain}`);
      return cookieHeaderForUrl(`https://${d}/`);
    },
    removeCookie: (urlOrKey: string) => {
      const domain = getDomainFromUrl(
        urlOrKey.includes("://") ? urlOrKey : `https://${urlOrKey}`,
      );
      removeDomainCookies(domain);
    },
    setCookie: (url: string, cookie?: unknown) => {
      const value = cookie == null ? "" : String(cookie);
      setCookieForUrl(String(url ?? ""), value);
      return value;
    },
    replaceCookie: (url: string, cookie: unknown) => {
      replaceCookieForUrl(String(url ?? ""), String(cookie ?? ""));
    },
    cookieToMap: (cookie: unknown) => cookieStringToMap(String(cookie ?? "")),
    mapToCookie: (map: unknown) => {
      if (map && typeof map === "object" && !Array.isArray(map)) {
        return mapToCookieString(map as Record<string, string>);
      }
      return "";
    },
  };

  host.javaBindings = {
    ajax: (url: unknown) => hostAjax(host, url),
    ajaxAll: (urlList: unknown, skipRateLimit?: unknown) =>
      hostAjaxAll(host, urlList, skipRateLimit),
    importScript: (path: unknown) =>
      importScript(String(path ?? ""), source, host),
    cacheFile: (url: unknown, saveTime?: unknown) =>
      cacheFile(String(url ?? ""), Number(saveTime) || 0, source, host),
    readTxtFile: (path: unknown, charset?: unknown) =>
      readTxtFile(
        String(path ?? ""),
        charset != null && String(charset).trim() ? String(charset) : "utf8",
      ),
    get: (arg: unknown, header?: unknown) => {
      const text = String(arg ?? "").trim();
      if (isHttpGetKey(arg, header)) {
        return legadoHttpGet(host, text, header);
      }
      return (
        getCacheValue(
          source.bookSourceUrl,
          sourceVariableCacheKey(source.bookSourceUrl, text),
        ) ?? ""
      );
    },
    connect: (url: unknown, header?: unknown) =>
      legadoHttpConnect(host, String(url ?? ""), header),
    post: (url: unknown, body: unknown, header?: unknown) =>
      legadoHttpPost(host, String(url ?? ""), body, header),
    log: (msg: unknown) => host.log(String(msg)),
    toast: (msg: unknown) => {
      const text = String(msg ?? "");
      host.log(`[toast] ${text}`);
      emitBookSourceToast(text, false);
    },
    longToast: (msg: unknown) => {
      const text = String(msg ?? "");
      host.log(`[toast] ${text}`);
      emitBookSourceToast(text, true);
    },
    base64Encode: (s: unknown) =>
      Buffer.from(String(s), "utf8").toString("base64"),
    base64Decode: (s: unknown) =>
      Buffer.from(String(s), "base64").toString("utf8"),
    hexDecodeToString: (hex: unknown) => {
      const h = String(hex ?? "").trim().replace(/\s+/g, "");
      if (!h) return "";
      if (!/^[0-9a-fA-F]+$/.test(h) || h.length % 2 !== 0) {
        throw new Error(`hexDecodeToString: invalid hex input (${h.slice(0, 24)})`);
      }
      return Buffer.from(h, "hex").toString("utf8");
    },
    md5Encode: (s: unknown) =>
      createHash("md5").update(String(s)).digest("hex"),
    md5Encode16: (s: unknown) =>
      createHash("md5").update(String(s)).digest("hex").slice(8, 24),
    base64DecodeToByteArray: (s: unknown) =>
      Array.from(Buffer.from(String(s ?? ""), "base64")),
    createSymmetricCrypto: (
      transformation: unknown,
      key: unknown,
      iv?: unknown,
    ) => createSymmetricCrypto(transformation, key, iv),
    aesDecodeToString: (
      data: unknown,
      key: unknown,
      transformation: unknown,
      iv: unknown,
    ) => aesDecodeToString(data, key, transformation, iv),
    aesBase64DecodeToString: (
      data: unknown,
      key: unknown,
      transformation: unknown,
      iv: unknown,
    ) => aesBase64DecodeToString(data, key, transformation, iv),
    digestHex: (data: unknown, algorithm: unknown) =>
      digestHex(data, algorithm),
    HMacHex: (data: unknown, algorithm: unknown, key: unknown) =>
      hMacHex(data, algorithm, key),
    HMacBase64: (data: unknown, algorithm: unknown, key: unknown) =>
      hMacBase64(data, algorithm, key),
    encodeURI: (str: unknown, charset?: unknown) =>
      encodeLegadoUri(str, charset),
    desEncodeToBase64String,
    t2s: (text: unknown) => legadoT2s(text),
    s2t: (text: unknown) => legadoS2t(text),
    randomUUID: () => legadoRandomUUID(),
    timeFormatUTC: (time: unknown, format: unknown, offsetHours: unknown) =>
      timeFormatUtc(time, format, offsetHours),
    getUserAgent: () => getWebViewUserAgent(),
    /**
     * 洛雅橙分叉 API（官方 Legado 无）。
     * 部分书源用 `typeof java.readBookConfig == "undefined"` 做客户端校验；
     * Rhino 上对应 `getReadBookConfig()`，会以属性名 `readBookConfig` 可见。
     * 返回空配置 JSON，仅保证存在性，不模拟阅读排版。
     * @link https://github.com/Luoyacheng/legado-E
     */
    getReadBookConfig: () => "{}",
    readBookConfig: () => "{}",
    getReadBookConfigMap: () => ({}),
    getThemeMode: () => "0",
    getThemeConfig: () => "{}",
    getThemeConfigMap: () => ({}),
    getString: (_rule: string, content?: string) => content ?? "",
    getCookie: (domain: string) => {
      const d = getDomainFromUrl(domain.includes(".") ? `https://${domain}` : domain);
      return cookieHeaderForUrl(`https://${d}/`);
    },
    timeFormat: (ts: unknown) => timeFormat(ts),
    put: (key: string, value: unknown) => {
      const s = String(value ?? "");
      putCacheValue(
        source.bookSourceUrl,
        sourceVariableCacheKey(source.bookSourceUrl, key),
        s,
      );
      return s;
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
    startBrowser: (url: string, title: string) => {
      void getVerificationResult(source.bookSourceUrl, url, title, {
        refetchAfterSuccess: false,
        source,
        host,
      }).catch(() => undefined);
    },
    putLoginHeader: (headerJson: string) => {
      putLoginHeader(source.bookSourceUrl, String(headerJson));
    },
    getLoginHeader: () => getLoginHeader(source.bookSourceUrl) ?? "",
    setVariable: (key: string, value: string) => {
      loginInfo[key] = value;
      setLoginInfo(source.bookSourceUrl, loginInfo);
    },
    getVariable: (key: string) => loginInfo[key] ?? "",
    getWebViewUA: () => getWebViewUserAgent(),
    androidId: () => getAndroidId(),
    getVerificationCode: async (imageUrl: unknown) => {
      const url = String(imageUrl ?? "").trim();
      if (!url) return "";
      return getVerificationCodeResult(source.bookSourceUrl, url, {
        source,
        host,
      });
    },
    toNumChapter: (s: unknown) => toNumChapter(s == null ? null : String(s)),
    webView: async (
      html: unknown,
      url: unknown,
      js: unknown,
      cacheFirst = false,
    ) => {
      const pageUrl = url != null ? String(url) : "";
      const script = js != null ? String(js) : "";
      const out = await runBackstageWebView({
        html: html != null ? String(html) : "",
        url: pageUrl,
        js: script,
        source,
        host,
        cacheFirst: cacheFirst === true,
      });
      // loginCheckJs：`java.webView(null, url, "document.cookie")` 返回值写回 CookieJar
      if (
        pageUrl.startsWith("http") &&
        /^\s*document\.cookie\s*$/i.test(script.trim()) &&
        out.trim()
      ) {
        setCookieForUrl(pageUrl.split(",")[0]!.trim(), out);
      }
      return out;
    },
    webViewGetOverrideUrl: async (
      html: unknown,
      url: unknown,
      js: unknown,
      overrideUrlRegex: unknown,
      cacheFirst = false,
      delayTime = 0,
    ) =>
      runBackstageWebView({
        html: html != null ? String(html) : "",
        url: url != null ? String(url) : "",
        js: js != null ? String(js) : "",
        source,
        host,
        cacheFirst: cacheFirst === true,
        delayMs: Number(delayTime) || 0,
        overrideUrlRegex: String(overrideUrlRegex ?? ""),
      }),
  };

  return host;
}

function parseHeaderArg(header?: unknown): Record<string, string> | undefined {
  if (header == null || header === "") return undefined;
  if (typeof header === "object" && !Array.isArray(header)) {
    const obj = header as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(obj)) {
      out[k] = legadoJsonValueToString(v);
    }
    return out;
  }
  const text = String(header).trim();
  if (!text) return undefined;
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) {
      out[k] = legadoJsonValueToString(v);
    }
    return out;
  } catch {
    return undefined;
  }
}

export function isHttpGetKey(arg: unknown, header?: unknown): boolean {
  const text = String(arg ?? "").trim();
  return (
    header !== undefined ||
    /^https?:\/\//i.test(text) ||
    text.startsWith("//")
  );
}

async function legadoHttpConnect(
  host: JsExtensionHost,
  urlStr: string,
  header?: unknown,
): Promise<ReturnType<typeof toLegadoConnectionResponse>> {
  const { urlPart, options } = splitUrlFetchOptions(urlStr);
  const headers = {
    ...(parseHeaderArg(header) ?? {}),
    ...(options.headers ?? {}),
  };
  const method = options.method?.toUpperCase() || "GET";
  return legadoHttpRequest(
    host,
    method,
    urlPart,
    options.body,
    Object.keys(headers).length ? headers : header,
    "follow",
  );
}

async function legadoHttpGet(
  host: JsExtensionHost,
  urlStr: string,
  header?: unknown,
): Promise<ReturnType<typeof toLegadoJsoupResponse>> {
  const startTime = Date.now();
  const headers = parseHeaderArg(header);
  const res = await fetchStrResponse(urlStr, {
    source: host.source,
    headers,
    method: "GET",
    host,
    logs: host.logs,
    redirect: "manual",
  });
  return toLegadoJsoupResponse(res, {
    statusCode: res.statusCode,
    startTime,
    message: res.statusMessage,
  });
}

async function legadoHttpPost(
  host: JsExtensionHost,
  urlStr: string,
  body: unknown,
  header?: unknown,
): Promise<ReturnType<typeof toLegadoJsoupResponse>> {
  const startTime = Date.now();
  const headers = parseHeaderArg(header);
  const res = await fetchStrResponse(urlStr, {
    source: host.source,
    headers,
    method: "POST",
    body: coerceHttpBody(body),
    host,
    logs: host.logs,
    redirect: "manual",
  });
  return toLegadoJsoupResponse(res, {
    statusCode: res.statusCode,
    startTime,
    message: res.statusMessage,
  });
}

function coerceHttpBody(body: unknown): string | undefined {
  if (body == null || body === "") return undefined;
  if (typeof body === "string") return body;
  if (typeof body === "object") {
    try {
      return JSON.stringify(body);
    } catch {
      return undefined;
    }
  }
  return String(body);
}

async function legadoHttpRequest(
  host: JsExtensionHost,
  method: string,
  urlStr: string,
  body?: unknown,
  header?: unknown,
  redirect: "follow" | "manual" = "manual",
): Promise<ReturnType<typeof toLegadoConnectionResponse>> {
  assertJsEvalAlive();
  const startTime = Date.now();
  const headers = parseHeaderArg(header);
  const res = await fetchStrResponse(urlStr, {
    source: host.source,
    headers,
    method,
    body: coerceHttpBody(body),
    host,
    logs: host.logs,
    redirect,
  });
  assertJsEvalAlive();
  return toLegadoConnectionResponse(res, {
    statusCode: res.statusCode,
    startTime,
    message: res.statusMessage,
  });
}

async function hostAjaxAll(
  host: JsExtensionHost,
  urlList: unknown,
  skipRateLimit?: unknown,
): Promise<ReturnType<typeof toLegadoStrResponse>[]> {
  assertJsEvalAlive();
  const results = await ajaxAllStrResponses(host, urlList, skipRateLimit);
  assertJsEvalAlive();
  return results;
}

async function hostAjax(host: JsExtensionHost, url: unknown): Promise<string> {
  assertJsEvalAlive();
  let urlStr: string;
  let options: { headers?: Record<string, string>; method?: string; body?: string } = {};
  if (Array.isArray(url)) {
    urlStr = String(url[0] ?? "");
  } else {
    urlStr = String(url ?? "");
  }
  const split = splitUrlFetchOptions(urlStr);
  if (split.options.headers && Object.keys(split.options.headers).length > 0) {
    urlStr = split.urlPart;
    options = normalizeUrlFetchOptions(split.options);
  } else if (split.options.method || split.options.body) {
    urlStr = split.urlPart;
    options = normalizeUrlFetchOptions(split.options);
  }
  try {
    const res = await fetchStrResponse(urlStr, {
      source: host.source,
      headers: options.headers,
      method: options.method,
      body: options.body,
      host,
      logs: host.logs,
    });
    assertJsEvalAlive();
    return res.body;
  } catch (e) {
    if (isBookSourceJsTimeoutError(e)) throw e;
    appendBookSourceErrorLog(host.logs, e, {
      phase: "java.ajax",
      sourceName: host.source.bookSourceName,
      url: urlStr,
      method: options.method,
    });
    const msg = e instanceof Error ? e.message : String(e);
    return msg;
  }
}

export async function openBrowserLogin(
  source: BookSourceRecord,
  title?: string,
): Promise<{ ok: boolean; cancelled?: boolean }> {
  const pageUrl = resolveWebLoginUrl(source);
  const winTitle =
    title?.trim() || `登录 · ${source.bookSourceName}`;
  try {
    await getVerificationResult(source.bookSourceUrl, pageUrl, winTitle, {
      refetchAfterSuccess: false,
      source,
    });
    return { ok: true };
  } catch (e) {
    if (isVerificationCancelled(e)) {
      return { ok: false, cancelled: true };
    }
    throw e;
  }
}

import { evalJs } from "./rhinoRuntime";

export function runLoginUrl(source: BookSourceRecord, logs: string[]): void {
  const loginUrl = source.loginUrl?.trim();
  if (!loginUrl) return;
  const host = createJsExtensionHost(source, logs);
  evalJs(loginUrl, { source, host });
}
