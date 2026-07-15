import iconv from "iconv-lite";
import type { BookSourceRecord } from "@shared/bookSource/types";
import { decodeHttpResponseBody } from "../../detectTextEncoding";
import {
  normalizeBookSourceBaseUrl,
  resolveAbsoluteUrl,
} from "@shared/bookSource/url";

import { createJsExtensionHost, type JsExtensionHost, isHttpGetKey } from "./jsExtensions";
import {
  buildSourceRequestHeaders,
  resolveSourceRequestHeaders,
} from "./sourceRequestHeaders";
import { appendBookSourceErrorLog } from "./bookSourceErrorLog";
import { toLegadoStrResponse } from "./legadoStrResponse";
import { cookieHeaderForUrl, setCookieFromResponse } from "./cookieManager";
import { DEFAULT_BOOK_SOURCE_USER_AGENT } from "./bookSourceUserAgent";
import { evalJs, evalJsAsync } from "./rhinoRuntime";
import { legadoJsonValueToString } from "./legadoJavaApi";
import { runBackstageWebView } from "./backstageWebView";
import { splitAtJsRule } from "./legadoRuleSplit";
import { parseLegadoUrlSuffixJson } from "./legadoCompositeRule";
import { withSourceRateLimit } from "./concurrentRateLimiter";
import {
  extractProxyFromHeaders,
  getBookSourceDispatcher,
} from "./httpProxy";

export type StrResponse = {
  url: string;
  body: string;
  headers: Record<string, string>;
  statusCode?: number;
  statusMessage?: string;
};

export type UrlFetchOptions = {
  charset?: string;
  method?: string;
  body?: string;
  bodyJs?: string;
  webJs?: string;
  webView?: boolean;
  webViewDelayTime?: number;
  headers?: Record<string, string>;
  /** Legado UrlOption.type：非空时响应正文改为 hex 字符串 */
  type?: string;
};

/** URL 后缀 JSON 选项：`,` + `{`，但勿匹配 Mustache 模板 `{{...}}` */
const PARAM_JSON_PATTERN = /,\s*(?=\{(?!\{))/;

const EMPTY_BODY_MD5_STUB = "D41D8CD98F00B204E9800998ECF8427E";

function hasGorgonHeader(headers?: Record<string, string>): boolean {
  return Boolean(headers?.["X-Gorgon"] ?? headers?.["x-gorgon"]);
}

/** 对齐 Legado NetworkUtils.encodedQuery：已编码 query 不再拆分重编码 */
function isLegadoEncodedQuery(query: string): boolean {
  return /%[0-9A-Fa-f]{2}/.test(query);
}

function augmentGorgonHeaders(
  headers: Record<string, string>,
  requestUrl: string,
): Record<string, string> {
  if (!hasGorgonHeader(headers)) return headers;
  const out = { ...headers };
  if (!out["X-SS-STUB"] && !out["x-ss-stub"]) {
    out["X-SS-STUB"] = EMPTY_BODY_MD5_STUB;
  }
  if (!out["X-SS-DP"] && !out["x-ss-dp"]) {
    out["X-SS-DP"] = requestUrl.match(/[?&]aid=(\d+)/)?.[1] ?? "1967";
  }
  if (!out["Cookie"]?.trim()) delete out["Cookie"];
  return out;
}

/** 对齐 Legado：仅剥离 `,{"method":…}` 类 UrlOption，勿切断 query 内逗号 */
function stripUrlOptionSuffix(url: string): string {
  const m = PARAM_JSON_PATTERN.exec(url);
  if (!m || m.index == null) return url.trim();
  const tail = url.slice(m.index + m[0].length).trimStart();
  if (!tail.startsWith("{")) return url.trim();
  return url.slice(0, m.index).trim();
}

function resolveGetRequestUrl(
  url: string,
  urlNoQuery: string,
  fieldMap: Map<string, string>,
  headers: Record<string, string>,
  method: string,
): string {
  const plainUrl = stripUrlOptionSuffix(url);
  // Legado POST：urlNoQuery 可带 query（product 等），勿剥成光 path
  if (method !== "GET") {
    if (urlNoQuery.includes("?")) return stripUrlOptionSuffix(urlNoQuery);
    if (plainUrl.includes("?")) return plainUrl;
    return stripUrlOptionSuffix(urlNoQuery);
  }
  if (hasGorgonHeader(headers) && plainUrl.includes("?")) return plainUrl;
  if (fieldMap.size > 0) return buildQueryUrl(urlNoQuery, fieldMap);
  if (plainUrl.includes("?")) return plainUrl;
  return urlNoQuery;
}

export function normalizeUrlFetchOptions(options: UrlFetchOptions): UrlFetchOptions {
  const normalized: UrlFetchOptions = { ...options };
  if (normalized.headers) {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(normalized.headers)) {
      headers[key] = legadoJsonValueToString(value);
    }
    normalized.headers = headers;
  }
  if (normalized.body != null && typeof normalized.body !== "string") {
    const bodyText = legadoJsonValueToString(normalized.body);
    if (bodyText) normalized.body = bodyText;
    else delete normalized.body;
  }
  if (normalized.headers && hasGorgonHeader(normalized.headers)) {
    if (!normalized.headers["Cookie"]?.trim()) delete normalized.headers["Cookie"];
  }
  return normalized;
}

export function splitUrlFetchOptions(ruleUrl: string): {
  urlPart: string;
  options: UrlFetchOptions;
} {
  const m = PARAM_JSON_PATTERN.exec(ruleUrl);
  if (!m || m.index == null) return { urlPart: ruleUrl, options: {} };
  const tail = ruleUrl.slice(m.index + 1).trim();
  if (!tail.startsWith("{")) return { urlPart: ruleUrl, options: {} };
  const parsed = parseLegadoUrlSuffixJson(tail);
  const options = normalizeUrlFetchOptions({
    headers: parsed.headers,
    method: parsed.method,
    body: parsed.body,
    charset: parsed.charset,
    type: parsed.type,
  });
  return { urlPart: ruleUrl.slice(0, m.index), options };
}

export function encodeSearchKey(key: string, charset?: string): string {
  const cs = charset?.trim().toLowerCase();
  if (!cs || cs === "utf-8" || cs === "utf8") {
    return encodeURIComponent(key);
  }

  const buf = iconv.encode(key, cs);
  return Array.from(buf)
    .map((b) => `%${b.toString(16).padStart(2, "0").toUpperCase()}`)
    .join("");
}

function isUtf8Charset(charset?: string): boolean {
  const cs = charset?.trim().toLowerCase();
  return !cs || cs === "utf-8" || cs === "utf8";
}

function hasUrlEncoded(str: string): boolean {
  return /%[0-9A-Fa-f]{2}/.test(str);
}

/** Legado EncoderUtils.escape */
function escapeFieldValue(value: string): string {
  let out = "";
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (
      (code >= 48 && code <= 57) ||
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122)
    ) {
      out += char;
      continue;
    }
    const prefix = code < 16 ? "%0" : code < 256 ? "%" : "%u";
    out += prefix + code.toString(16);
  }
  return out;
}

function encodeFieldValue(value: string, charset?: string): string {
  if (!value) return "";
  const cs = charset?.trim().toLowerCase();
  if (cs === "escape") return escapeFieldValue(value);
  if (!cs || cs === "utf-8" || cs === "utf8") {
    if (hasUrlEncoded(value)) return value;
    return encodeURIComponent(value);
  }

  return encodeSearchKey(value, cs);
}

function analyzeFields(
  fieldsTxt: string,
  charset?: string,
): Map<string, string> {
  const map = new Map<string, string>();
  for (const part of fieldsTxt.split("&")) {
    if (!part) continue;
    const eq = part.indexOf("=");
    const key = eq < 0 ? part : part.slice(0, eq);
    const value = eq < 0 ? "" : part.slice(eq + 1);
    map.set(key, encodeFieldValue(value, charset));
  }
  return map;
}

function isJsonOrXml(text: string): boolean {
  const t = text.trim();
  return t.startsWith("{") || t.startsWith("[") || t.startsWith("<");
}

function buildQueryUrl(base: string, fieldMap: Map<string, string>): string {
  if (fieldMap.size === 0) return base;
  const query = Array.from(fieldMap.entries())
    .map(([k, v]) => `${encodeURIComponent(k)}=${v}`)
    .join("&");
  return `${base}?${query}`;
}

function buildFormBody(
  fieldMap: Map<string, string>,
  charset?: string,
): string | Buffer {
  const body = Array.from(fieldMap.entries())
    .map(([k, v]) => `${encodeURIComponent(k)}=${v}`)
    .join("&");
  if (!isUtf8Charset(charset)) {
    return iconv.encode(body, charset!.trim());
  }
  return body;
}

/** fetch BodyInit 不接受 Node Buffer，需转为 Uint8Array */
function toFetchBody(body: string | Buffer | undefined): BodyInit | undefined {
  if (body == null) return undefined;
  if (Buffer.isBuffer(body)) return new Uint8Array(body);
  return body;
}

/** 书源 HTTP 正文上限，防止异常响应把主进程内存撑爆（界面卡死） */
const BOOK_SOURCE_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

async function readResponseBytesCapped(
  res: Response,
  maxBytes: number,
  meta: { logs?: string[]; url?: string; sourceName?: string },
): Promise<Buffer> {
  const lenHeader = res.headers.get("content-length");
  if (lenHeader) {
    const n = Number(lenHeader);
    if (Number.isFinite(n) && n > maxBytes) {
      try {
        res.body?.cancel();
      } catch {
        /* ignore */
      }
      const msg = `响应过大 (${n} > ${maxBytes} bytes): ${meta.url ?? ""}`;
      meta.logs?.push(`[HTTP] ${msg}`);
      throw new Error(msg);
    }
  }

  if (!res.body) {
    return Buffer.from(await res.arrayBuffer());
  }

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          /* ignore */
        }
        const msg = `响应超过 ${maxBytes} bytes，已中止: ${meta.url ?? ""}`;
        meta.logs?.push(`[HTTP] ${msg}`);
        throw new Error(msg);
      }
      chunks.push(value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* ignore */
    }
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c)));
}

function decodeResponseBody(
  raw: Buffer,
  charset?: string,
  contentType?: string | null,
): string {
  return decodeHttpResponseBody(raw, { charset, contentType });
}

export type AnalyzeUrlOptions = {
  mUrl: string;
  key?: string;
  page?: number;
  baseUrl?: string;
  source?: BookSourceRecord;
  headers?: Record<string, string>;
  method?: string;
  body?: string;
  host?: JsExtensionHost;
  logs?: string[];

  /** ruleContent.webJs 等场景传入，优先于 URL 内嵌 webJs */
  webJs?: string;
  /** 正文 sourceRegex（预留） */
  sourceRegex?: string;

  /** 与 AnalyzeRule 共享，对齐 Legado RuleData.variableMap */
  ruleVariables?: Record<string, string>;
};

export class AnalyzeUrl {
  ruleUrl = "";
  url = "";
  body: string | null = null;
  headerMap: Record<string, string> = {};
  private host: JsExtensionHost;
  private source?: BookSourceRecord;
  private key?: string;
  private page?: number;
  private baseUrl: string;
  private urlFetchOptions: UrlFetchOptions = {};
  private method = "GET";
  private urlNoQuery = "";
  private fieldMap = new Map<string, string>();
  private urlReady = false;
  private headersResolved = false;
  private extraHeaders: Record<string, string> = {};

  /** searchUrl @js 中 java.put 写入的变量（与 bookList 规则共享） */
  private ruleVariables: Record<string, string>;
  private extraWebJs?: string;
  private sourceRegex?: string;

  constructor(opts: AnalyzeUrlOptions) {
    this.source = opts.source;
    this.key = opts.key;
    this.page = opts.page;
    this.baseUrl = normalizeBookSourceBaseUrl(opts.baseUrl ?? "");
    this.host =
      opts.host ??
      createJsExtensionHost(opts.source ?? emptySource(), opts.logs ?? []);
    this.extraHeaders = { ...(opts.headers ?? {}) };
    this.headerMap = {
      ...buildSourceRequestHeaders(opts.source),
      ...this.extraHeaders,
    };
    this.ruleUrl = opts.mUrl;
    this.ruleVariables = opts.ruleVariables ?? {};
    this.extraWebJs = opts.webJs?.trim() || undefined;
    this.sourceRegex = opts.sourceRegex?.trim() || undefined;
  }

  getRuleVariables(): Record<string, string> {
    return this.ruleVariables;
  }

  /** 供 bookList 中 java.ajax(u) 使用：含 fetch 选项的完整 URL 字符串 */
  getAjaxUrl(): string {
    const opts = this.urlFetchOptions;
    if (!opts || Object.keys(opts).length === 0) return this.url;
    return `${this.url},${JSON.stringify(opts)}`;
  }

  putVariable(key: string, value: unknown): string {
    const s = String(value ?? "");
    this.ruleVariables[key] = s;
    return s;
  }

  getVariable(key: string): string {
    return this.ruleVariables[key] ?? "";
  }

  buildAnalyzeUrlJava(): Record<string, unknown> {
    const au = this;
    const base = this.host.javaBindings;
    const baseGet = base.get as (arg: unknown, header?: unknown) => unknown;
    return {
      ...base,
      ruleUrl: this.ruleUrl,
      url: this.url || this.baseUrl,
      put: (key: string, value: unknown) => au.putVariable(key, value),
      get: (key: unknown, header?: unknown) => {
        const text = String(key ?? "").trim();
        if (isHttpGetKey(key, header)) {
          return baseGet(key, header);
        }
        const variable = au.getVariable(text);
        if (variable) return variable;
        return baseGet(key);
      },
    };
  }

  private syncUrlVariable(): void {
    if (this.url) {
      this.ruleVariables.url = this.getAjaxUrl();
    }
  }

  private async resolveHeaderMap(): Promise<void> {
    if (this.headersResolved) return;
    this.headersResolved = true;
    if (!this.source) return;
    const resolved = await resolveSourceRequestHeaders(this.source, {
      baseUrl: this.baseUrl || this.source.bookSourceUrl,
      host: this.host,
    });
    this.headerMap = { ...resolved, ...this.extraHeaders };
  }

  private async ensureUrlReady(): Promise<void> {
    if (this.urlReady) return;
    await this.resolveHeaderMap();
    await this.analyzeJs();
    await this.replaceKeyPageJs();
    this.analyzeUrl();
    this.syncUrlVariable();
    this.urlReady = true;
  }

  private async analyzeJs(): Promise<void> {
    let result = this.ruleUrl;
    const trimmed = this.ruleUrl.trim();
    if (trimmed.startsWith("@js:") && !trimmed.includes("<js>")) {
      const { jsPart, rest } = splitAtJsRule(trimmed);
      const js = jsPart.replace(/^@js:\n?/, "");
      result = String(
        await evalJsAsync(js, {
          source: this.source,
          result,
          baseUrl: this.baseUrl,
          key: this.key,
          page: this.page,
          host: this.host,
          java: this.buildAnalyzeUrlJava(),
        }),
      );
      if (rest) result = rest.replace("@result", String(result));
      this.ruleUrl = result;
      return;
    }
    let start = 0;
    const re = /<js>([\s\S]*?)<\/js>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(this.ruleUrl))) {
      if (m.index > start) {
        const part = this.ruleUrl.slice(start, m.index).trim();
        if (part) result = part.replace("@result", String(result));
      }
      const js = m[1] ?? "";
      result = String(
        await evalJsAsync(js, {
          source: this.source,
          result,
          baseUrl: this.baseUrl,
          key: this.key,
          page: this.page,
          host: this.host,
          java: this.buildAnalyzeUrlJava(),
        }),
      );
      start = m.index + m[0].length;
    }
    if (this.ruleUrl.length > start) {
      const part = this.ruleUrl.slice(start).trim();
      if (part) result = part.replace("@result", String(result));
    }
    this.ruleUrl = result;
  }

  private async applyTemplateAsync(text: string): Promise<string> {
    let out = typeof text === "string" ? text : text == null ? "" : String(text);
    if (this.key != null) {
      out = out.replace(/\{\{key\}\}/g, this.key);
    }
    if (this.page != null) {
      out = out.replace(/\{\{page\}\}/g, String(this.page));
    }
    if (this.source) {
      out = out.replace(
        /\{\{source\.key\}\}/g,
        encodeURIComponent(this.source.bookSourceUrl),
      );
    }
    if (out.includes("{{")) {
      const re = /\{\{([\s\S]*?)\}\}/g;
      let cursor = 0;
      let rebuilt = "";
      let m: RegExpExecArray | null;
      while ((m = re.exec(out)) !== null) {
        rebuilt += out.slice(cursor, m.index);
        const js = m[1] ?? "";
        const v = await evalJsAsync(js, {
          source: this.source,
          result: out,
          baseUrl: this.baseUrl,
          key: this.key,
          page: this.page,
          host: this.host,
          java: this.buildAnalyzeUrlJava(),
        });
        if (typeof v === "number" && v % 1 === 0) {
          rebuilt += String(Math.trunc(v));
        } else {
          rebuilt += String(v ?? "");
        }
        cursor = m.index + m[0].length;
      }
      rebuilt += out.slice(cursor);
      out = rebuilt;
    }
    if (this.page != null) {
      out = out.replace(/<([^>]+)>/g, (_, inner) => {
        const pages = String(inner).split(",");
        const idx = Math.max(0, this.page! - 1);
        return (pages[idx] ?? pages[pages.length - 1] ?? "").trim();
      });
    }
    return out;
  }

  private async replaceKeyPageJs(): Promise<void> {
    const split = splitUrlFetchOptions(this.ruleUrl);
    this.urlFetchOptions = { ...split.options };
    this.ruleUrl = await this.applyTemplateAsync(split.urlPart);
    if (typeof this.urlFetchOptions.body === "string" && this.urlFetchOptions.body) {
      this.urlFetchOptions.body = await this.applyTemplateAsync(
        this.urlFetchOptions.body,
      );
    }
  }

  private analyzeUrl(): void {
    let u = this.ruleUrl.trim();
    if (u.startsWith("data:")) {
      this.parseDataUrl(u);
      return;
    }
    if (!/^https?:\/\//i.test(u)) {
      u = resolveAbsoluteUrl(this.baseUrl, u);
    }
    const charset = this.urlFetchOptions.charset;
    this.method =
      this.urlFetchOptions.method?.toUpperCase() === "POST" ? "POST" : "GET";

    // Legado：POST 保留 URL 上的 query（如 Lofter ?product=…），表单在 body；
    // GET 才把 query 拆进 fieldMap。
    if (this.method === "POST") {
      this.url = u;
      this.urlNoQuery = u;
      this.fieldMap = new Map();
      if (this.urlFetchOptions.body != null) {
        const postBody = this.urlFetchOptions.body;
        if (!isJsonOrXml(postBody)) {
          this.fieldMap = analyzeFields(postBody, charset);
          this.body = null;
        } else {
          this.body = postBody;
        }
      }
      return;
    }

    const qPos = u.indexOf("?");
    if (qPos >= 0) {
      this.urlNoQuery = u.slice(0, qPos);
      const queryPart = u.slice(qPos + 1);
      const signedGet = hasGorgonHeader(this.urlFetchOptions.headers);
      if (signedGet || isLegadoEncodedQuery(queryPart)) {
        this.url = u;
        this.fieldMap = new Map();
      } else {
        this.fieldMap = analyzeFields(queryPart, charset);
        this.url = buildQueryUrl(this.urlNoQuery, this.fieldMap);
      }
    } else {
      this.urlNoQuery = u;
      this.url = u;
    }
  }

  private parseDataUrl(u: string): void {
    const m = u.match(/^data:([^;,]+)?(?:;([^,]*))?,(.*)$/i);
    if (!m) {
      this.url = u;
      return;
    }
    const dataType = m[1] ?? "";
    const meta = m[2] ?? "";
    let payload = m[3] ?? "";
    if (meta.includes("base64")) {
      payload = Buffer.from(payload, "base64").toString("utf8");
    }
    this.body = payload;
    this.url = u;
    this.type = dataType;
  }
  type?: string;

  /** Legado：UrlOption.type 非空时 body 为 hex（供 java.hexDecodeToString） */
  private applyTypeHexBody(body: string): string {
    const optionType = this.urlFetchOptions.type?.trim();
    if (!optionType) return body;
    return Buffer.from(body, "utf8").toString("hex");
  }

  async getStrResponse(opts?: { skipRateLimit?: boolean }): Promise<StrResponse> {
    return withSourceRateLimit(
      this.source,
      () => this.getStrResponseInner(),
      opts?.skipRateLimit === true,
    );
  }

  private async getStrResponseInner(): Promise<StrResponse> {
    await this.ensureUrlReady();
    if (this.url.startsWith("data:")) {
      if (this.body == null) {
        throw new Error(`无效 data URL（缺少正文）: ${this.url.slice(0, 96)}`);
      }
      return {
        url: this.url,
        body: this.applyTypeHexBody(this.body),
        headers: {},
      };
    }

    const webJs =
      this.extraWebJs ||
      this.urlFetchOptions.webJs?.trim() ||
      undefined;
    const useWebView = this.urlFetchOptions.webView === true;

    if (useWebView && this.method === "GET") {
      const webBody = await runBackstageWebView({
        url: this.url,
        js: webJs || "document.documentElement.outerHTML",
        source: this.source,
        host: this.host,
        delayMs: this.urlFetchOptions.webViewDelayTime ?? undefined,
      });
      const body = this.urlFetchOptions.type?.trim()
        ? this.applyTypeHexBody(webBody)
        : webBody;
      return { url: this.url, body, headers: {} };
    }

    let res = await fetchStrResponse(this.url, {
      source: this.source,
      headers: { ...this.headerMap, ...this.urlFetchOptions.headers },
      method: this.method,
      body: this.body ?? undefined,
      fieldMap: this.fieldMap,
      urlNoQuery: this.urlNoQuery,
      charset: this.urlFetchOptions.charset,
      host: this.host,
      logs: this.host.logs,
      skipRateLimit: true,
    });
    const bodyJs = this.urlFetchOptions.bodyJs?.trim();
    if (bodyJs) {
      const nextBody = await evalJsAsync(bodyJs, {
        source: this.source,
        result: res.body,
        baseUrl: this.baseUrl,
        key: this.key,
        page: this.page,
        host: this.host,
        java: this.buildAnalyzeUrlJava(),
      });
      if (nextBody != null && nextBody !== "") {
        res = { ...res, body: String(nextBody) };
      }
    }
    if (webJs) {
      const webBody = await runBackstageWebView({
        html: res.body,
        url: res.url,
        js: webJs,
        source: this.source,
        host: this.host,
        delayMs: this.urlFetchOptions.webViewDelayTime ?? undefined,
      });
      if (webBody) {
        res = { ...res, body: webBody };
      }
    }
    if (this.sourceRegex) {
      const re = new RegExp(this.sourceRegex);
      const m = res.body.match(re);
      if (m?.[0]) {
        res = { ...res, body: m[0] };
      }
    }
    if (this.urlFetchOptions.type?.trim()) {
      return { ...res, body: this.applyTypeHexBody(res.body) };
    }
    return res;
  }

  /** loginCheckJs：重新解析 URL 并再次请求 */
  initUrl(): this {
    this.urlReady = false;
    this.headersResolved = false;
    return this;
  }

  evalJS(script: string, result?: unknown): unknown {
    return evalJs(script, {
      source: this.source,
      result,
      baseUrl: this.baseUrl,
      key: this.key,
      page: this.page,
      host: this.host,
    });
  }
}

export async function fetchStrResponse(
  urlStr: string,
  opts: {
    source?: BookSourceRecord;
    headers?: Record<string, string>;
    method?: string;
    body?: string;
    charset?: string;
    fieldMap?: Map<string, string>;
    urlNoQuery?: string;
    host?: JsExtensionHost;
    logs?: string[];
    redirect?: RequestRedirect;
    skipRateLimit?: boolean;
    proxy?: string;
  } = {},
): Promise<StrResponse> {
  return withSourceRateLimit(
    opts.source,
    () => fetchStrResponseInner(urlStr, opts),
    opts.skipRateLimit === true,
  );
}

async function fetchStrResponseInner(
  urlStr: string,
  opts: {
    source?: BookSourceRecord;
    headers?: Record<string, string>;
    method?: string;
    body?: string;
    charset?: string;
    fieldMap?: Map<string, string>;
    urlNoQuery?: string;
    host?: JsExtensionHost;
    logs?: string[];
    redirect?: RequestRedirect;
    proxy?: string;
  } = {},
): Promise<StrResponse> {
  let url = urlStr.trim();
  let method = opts.method ?? "GET";
  let body = opts.body;
  let charset = opts.charset;
  let fieldMap = opts.fieldMap ?? new Map<string, string>();
  let urlNoQuery = opts.urlNoQuery ?? url;
  let headers = { ...opts.headers };
  if (opts.source) {
    const resolved = await resolveSourceRequestHeaders(opts.source, {
      baseUrl: normalizeBookSourceBaseUrl(opts.source.bookSourceUrl),
      host: opts.host,
      logs: opts.logs,
    });
    headers = { ...resolved, ...headers };
  }
  const extracted = extractProxyFromHeaders(headers);
  headers = extracted.headers;
  const proxy = opts.proxy?.trim() || extracted.proxy;
  const dispatcher = getBookSourceDispatcher(proxy);

  const split = splitUrlFetchOptions(url);
  if (split.options && Object.keys(split.options).length > 0) {
    url = split.urlPart;
    urlNoQuery = split.urlPart;
    headers = { ...headers, ...split.options.headers };
    if (split.options.method) method = split.options.method;
    if (split.options.body != null) body = split.options.body;
    if (split.options.charset) charset = split.options.charset;
    const isPost = method.toUpperCase() === "POST";
    const qPos = url.indexOf("?");
    // Legado：仅 GET 拆 query；POST 保留 ?product=… 并在 body 提交表单
    if (qPos >= 0 && !isPost) {
      urlNoQuery = url.slice(0, qPos);
      fieldMap = analyzeFields(url.slice(qPos + 1), charset);
    } else if (isPost && typeof body === "string" && body && !body.trim().startsWith("{") && !body.trim().startsWith("<")) {
      fieldMap = analyzeFields(body, charset);
      body = undefined;
    }
  }

  if (url.startsWith("data:")) {
    const au = new AnalyzeUrl({
      mUrl: url,
      source: opts.source,
      host: opts.host,
    });
    return au.getStrResponse({ skipRateLimit: true });
  }

  if (!/^https?:\/\//i.test(urlNoQuery)) {
    throw new Error(`无效 URL: ${urlNoQuery}`);
  }
  let requestUrl = resolveGetRequestUrl(url, urlNoQuery, fieldMap, headers, method);
  headers = augmentGorgonHeaders(headers, requestUrl);
  if (opts.source?.enabledCookieJar) {
    const ck = cookieHeaderForUrl(requestUrl);
    if (ck) headers.Cookie = headers.Cookie ? `${headers.Cookie}; ${ck}` : ck;
  }

  if (!headers["User-Agent"] && !headers["user-agent"]) {
    headers["User-Agent"] = DEFAULT_BOOK_SOURCE_USER_AGENT;
  }
  let requestBody: string | Buffer | undefined;
  if (method !== "GET" && method !== "HEAD") {
    if (fieldMap.size > 0 && !body) {
      requestBody = buildFormBody(fieldMap, charset);
    } else if (body != null) {
      requestBody = !isUtf8Charset(charset)
        ? iconv.encode(body, charset!.trim())
        : body;
    }
    if (
      requestBody &&
      !headers["Content-Type"] &&
      !headers["content-type"]
    ) {
      // 对齐 Legado：JSON body 用 postJson（application/json），否则 form-urlencoded
      const bodyText =
        typeof requestBody === "string"
          ? requestBody.trim()
          : "";
      headers["Content-Type"] =
        bodyText.startsWith("{") || bodyText.startsWith("[")
          ? "application/json; charset=UTF-8"
          : "application/x-www-form-urlencoded";
    }
  }

  const res = await (async () => {
    try {
      return await fetch(requestUrl, {
        method,
        headers,
        body: toFetchBody(requestBody),
        redirect: opts.redirect ?? "follow",
        signal: AbortSignal.timeout(15_000),
        dispatcher,
      } as RequestInit & { dispatcher?: unknown });
    } catch (e) {
      appendBookSourceErrorLog(opts.logs ?? [], e, {
        phase: "HTTP 请求",
        sourceName: opts.source?.bookSourceName,
        sourceUrl: opts.source?.bookSourceUrl,
        url: requestUrl,
        method,
      });
      throw e;
    }
  })();
  const raw = await readResponseBytesCapped(res, BOOK_SOURCE_MAX_RESPONSE_BYTES, {
    logs: opts.logs,
    url: requestUrl,
    sourceName: opts.source?.bookSourceName,
  });
  const text = decodeResponseBody(
    raw,
    charset,
    res.headers.get("content-type"),
  );
  if (!text.trim() && hasGorgonHeader(headers)) {
    opts.logs?.push(
      `[HTTP] X-Gorgon 请求返回空响应 (${res.status})：${requestUrl.slice(0, 120)}`,
    );
  }
  const resHeaders: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    resHeaders[k] = v;
  });
  const setCookie = res.headers.getSetCookie?.() ?? [];
  if (setCookie.length > 0) {
    setCookieFromResponse(requestUrl, setCookie);
  } else {
    const sc = res.headers.get("set-cookie");
    if (sc) setCookieFromResponse(requestUrl, sc);
  }
  return {
    url: res.url,
    body: text,
    headers: resHeaders,
    statusCode: res.status,
    statusMessage: res.statusText,
  };
}

function emptySource(): BookSourceRecord {
  return {
    bookSourceUrl: "",
    bookSourceName: "",
    bookSourceType: 0,
  };
}

/** Legado java.ajaxAll：并发请求，返回 StrResponse 数组 */
export async function ajaxAllStrResponses(
  host: JsExtensionHost,
  urlList: unknown,
  skipRateLimit?: unknown,
): Promise<ReturnType<typeof toLegadoStrResponse>[]> {
  const urls = Array.isArray(urlList)
    ? urlList.map((u) => String(u ?? ""))
    : Array.from(urlList as Iterable<unknown>).map((u) => String(u ?? ""));
  const skip = skipRateLimit === true;
  const results: ReturnType<typeof toLegadoStrResponse>[] = new Array(urls.length);
  const workers = Math.min(Math.max(urls.length, 1), 8);
  let cursor = 0;

  async function worker(): Promise<void> {
    while (true) {
      const index = cursor++;
      if (index >= urls.length) return;
      const urlStr = urls[index]!;
      try {
        const res = await new AnalyzeUrl({
          mUrl: urlStr,
          baseUrl: host.source.bookSourceUrl,
          source: host.source,
          host,
          logs: host.logs,
        }).getStrResponse({ skipRateLimit: skip });
        results[index] = toLegadoStrResponse(res, {
          statusCode: res.statusCode,
          message: res.statusMessage,
        });
      } catch (e) {
        appendBookSourceErrorLog(host.logs, e, {
          phase: "java.ajaxAll",
          sourceName: host.source.bookSourceName,
          url: urlStr,
        });
        const msg = e instanceof Error ? e.stack ?? e.message : String(e);
        results[index] = toLegadoStrResponse(
          { url: urlStr, body: msg, headers: {} },
          { statusCode: 500, message: "error" },
        );
      }
    }
  }

  await Promise.all(Array.from({ length: workers }, () => worker()));
  return results;
}

