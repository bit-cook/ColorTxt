import type {
  BookSourceRecord,
  SearchBookItem,
  Book,
  BookChapter,
  BookInfoSeed,
} from "@shared/bookSource/types";
import { splitBookMetaTags } from "@shared/bookSource/bookMetaTags";
import {
  coerceBook,
  stripNumericIdPrefix,
  toEngineBook,
} from "@shared/bookSource/bookModel";
import { normalizeBookSourceBaseUrl, resolveAbsoluteUrl } from "@shared/bookSource/url";
import { wordCountFormat } from "@shared/bookSource/wordCountFormat";
import { formatLegadoBookAuthor } from "@shared/bookSource/formatBookAuthor";
import {
  splitUrlAndRuleVariables,
  extractUrlFetchOptionsSuffix,
  containsCompositeEvalRule,
  parseLegadoUrlSuffixJson,
  isPlainRuleObject,
  readJsonField,
  readJsonNestedValue,
} from "./legadoCompositeRule";
import { resolveBookCoverDisplayUrl, resolveCoverSourceUrl } from "./coverImage";
import {
  formatLegadoBookIntro,
  formatLegadoLastChapterDisplay,
  ensureLegadoIntroLeadingTitle,
  stripEmbeddedAuthorFromDetailName,
  formatLegadoChapterContent,
  unescapeLegadoHtmlEntities,
  resolveBookInfoField,
  expandBookInfoRegexTemplates,
  bookInfoSelectorNeedsCompositeResolver,
  stripLegadoKindLabelNoise,
} from "./bookInfoRules";
import { applyRuleRegex, splitRuleRegexSuffix } from "./legadoDefaultRule";
import { AnalyzeRule } from "./analyzeRule";
import { AnalyzeUrl, ajaxAllStrResponses, splitUrlFetchOptions } from "./analyzeUrl";
import { createJsExtensionHost } from "./jsExtensions";
import { evalJsAsync } from "./rhinoRuntime";
import { runLoginCheckJs, awaitLoginForSearchPage, isVerificationCancelled } from "./loginCheck";
import { ensureBookSourceJsLib } from "./sharedJsScope";
import { appendBookSourceErrorLog } from "./bookSourceErrorLog";
import { timeFormat } from "./legadoJavaApi";

function runJsLib(
  source: BookSourceRecord,
  host: ReturnType<typeof createJsExtensionHost>,
): void {
  ensureBookSourceJsLib(source, host);
}

/** ruleBookInfo / ruleSearch.kind：含 {{java.*}}、{{$..path}} 等复合表达式时走详情专用解析 */
async function resolveBookInfoKindParts(
  ar: AnalyzeRule,
  rule: string | undefined | null,
  mContent?: unknown,
): Promise<string[]> {
  const trimmed = rule?.trim();
  if (!trimmed) return [];
  const saved = ar.currentContent;
  if (mContent !== undefined) {
    ar.setContent(mContent, ar.currentBaseUrl);
  }
  const finalizeKindParts = (parts: string[]) =>
    parts.map(stripLegadoKindLabelNoise).filter(Boolean);
  try {
    const { baseRule, regex } = splitRuleRegexSuffix(trimmed);

    if (!bookInfoSelectorNeedsCompositeResolver(baseRule)) {
      const list = await ar.getStringList(baseRule, mContent ?? saved);
      if (!regex?.pattern) return finalizeKindParts(list);
      const expanded = expandBookInfoRegexTemplates(ar, regex);
      return finalizeKindParts(
        list.map((s) => applyRuleRegex(s.trim(), expanded).trim()),
      );
    }

    const useBookInfoResolver =
      (containsCompositeEvalRule(trimmed) &&
        !/^@js:/i.test(trimmed) &&
        !/^<js>/i.test(trimmed)) ||
      trimmed.includes("@get:");
    if (useBookInfoResolver) {
      const raw = (await resolveBookInfoField(ar, trimmed)).trim();
      return raw ? finalizeKindParts(splitBookMetaTags(raw)) : [];
    }
    return finalizeKindParts(await ar.getStringList(trimmed, mContent ?? saved));
  } finally {
    if (mContent !== undefined) {
      ar.setContent(saved, ar.currentBaseUrl);
    }
  }
}

function warnSuspiciousKindTags(
  kindParts: string[],
  logs: string[],
  sourceName: string,
): void {
  for (const tag of kindParts) {
    const t = tag.trim();
    if (/^\$\.?\.?[\w[*]/.test(t) || /\{\{/.test(t)) {
      logs.push(`[${sourceName}] 分类标签未正确解析: ${t}`);
    }
  }
}

function isJsonSearchBody(body: unknown): boolean {
  if (typeof body !== "string") return false;
  const t = body.trim();
  if (!t.startsWith("{") && !t.startsWith("[")) return false;
  try {
    JSON.parse(t);
    return true;
  } catch {
    return false;
  }
}

function isJsonIntroRule(rule: string): boolean {
  const t = rule.trim();
  return (
    t.startsWith("$.") ||
    t.startsWith("$[") ||
    t.startsWith("$..") ||
    /^@json:/i.test(t)
  );
}

/** 搜索页补拉简介上限，避免对 API 书源触发过多详情请求 */
const SEARCH_INTRO_FILL_MAX = 24;

/** JSON 搜索列表无 intro 规则时，按 ruleBookInfo 逐条补拉详情简介（如 SF/安轻 API 书源） */
async function fillSearchIntrosFromBookInfo(
  source: BookSourceRecord,
  items: SearchBookItem[],
  listRule: BookListRuleBlock,
  searchBody: unknown,
  host: ReturnType<typeof createJsExtensionHost>,
  logs: string[],
): Promise<void> {
  if (listRule.intro?.trim()) return;
  const infoIntroRule = source.ruleBookInfo?.intro?.trim();
  if (!infoIntroRule || !isJsonIntroRule(infoIntroRule)) return;
  if (!isJsonSearchBody(searchBody)) return;

  const pending = items
    .filter((item) => !item.intro?.trim() && /^https?:\/\//i.test(item.bookUrl))
    .slice(0, SEARCH_INTRO_FILL_MAX);
  if (!pending.length) return;

  const silentHost = createJsExtensionHost(source, []);

  for (const item of pending) {
    const urlStr = ensureBookUrlWithHeaders(item.bookUrl, host);
    try {
      const res = await new AnalyzeUrl({
        mUrl: urlStr,
        baseUrl: source.bookSourceUrl,
        source,
        host: silentHost,
      }).getStrResponse();
      const body = res.body?.trim() ?? "";
      if (!body) continue;

      const detailAr = new AnalyzeRule(source, logs, host)
        .setContent(body, item.bookUrl)
        .setBook({ name: item.name, author: item.author, bookUrl: item.bookUrl });
      const introRaw = (await resolveBookInfoField(detailAr, infoIntroRule)).trim();
      const intro = formatLegadoBookIntro(introRaw);
      if (intro) item.intro = intro;
    } catch {
      /* 补拉失败静默跳过，不影响搜索主流程 */
    }
  }
}

/** 简介规则误取到分类 tag 时，回退到 .book-intro / .introduce */
function isLegadoGetIntroRule(rule: string | undefined): boolean {
  return Boolean(rule?.trim() && /@get:\{?\s*intro\s*\}?/i.test(rule));
}

async function resolveBookIntroText(
  ar: AnalyzeRule,
  introRule: string | undefined,
  kindParts: string[],
): Promise<string> {
  let introRaw = (await resolveBookInfoField(ar, introRule)).trim();
  if (!introRaw && introRule?.includes(".introduce")) {
    introRaw = (await ar.getPlainString(".introduce@html")).trim();
  }
  let intro = formatLegadoBookIntro(introRaw);
  if (!intro || !kindParts.length || isLegadoGetIntroRule(introRule)) return intro;
  const lines = intro.split(/\n+/).map((s) => s.trim()).filter(Boolean);
  if (!lines.length) return intro;
  const kindSet = new Set(kindParts.map((k) => k.trim()).filter(Boolean));
  if (!lines.every((l) => kindSet.has(l))) return intro;
  for (const altRule of [
    ".book-info@.book-intro@html",
    ".introduce@html",
  ]) {
    const altRaw = (await ar.getPlainString(altRule)).trim();
    if (!altRaw) continue;
    const alt = formatLegadoBookIntro(altRaw);
    if (alt) return alt;
  }
  return intro;
}

export async function searchBook(
  source: BookSourceRecord,
  key: string,
  page = 1,
  logs: string[] = [],
): Promise<SearchBookItem[]> {
  const searchUrl = source.searchUrl?.trim();
  if (!searchUrl) throw new Error("搜索 url 不能为空");
  const host = createJsExtensionHost(source, logs);
  runJsLib(source, host);
  const ruleVariables: Record<string, string> = {};
  const analyzeUrl = new AnalyzeUrl({
    mUrl: searchUrl,
    key,
    page,
    baseUrl: source.bookSourceUrl,
    source,
    host,
    logs,
    ruleVariables,
  });
  let res = await analyzeUrl.getStrResponse();
  if (source.loginCheckJs?.trim()) {
    try {
      res = await runLoginCheckJs(analyzeUrl, source, res, key, logs);
    } catch (e) {
      if (isVerificationCancelled(e)) {
        logs.push("用户取消登录，跳过该书源");
        return [];
      }
      throw e;
    }
  } else {
    try {
      res = await awaitLoginForSearchPage(source, res, analyzeUrl, logs);
    } catch (e) {
      if (isVerificationCancelled(e)) {
        logs.push("用户取消登录，跳过该书源");
        return [];
      }
      throw e;
    }
  }
  if (!res.body?.trim()) {
    logs.push(
      `[search] 接口返回空响应 (HTTP ${res.statusCode ?? "?"})。` +
        "番茄等源需有效 X-Gorgon 签名；若 Legado 可用而此处不行，可能是接口校验升级或需填写登录 Token",
    );
    return [];
  }
  return await analyzeBookList(
    source,
    res.body,
    res.url,
    analyzeUrl.url,
    analyzeUrl.ruleUrl,
    ruleVariables,
    logs,
    host,
    "search",
  ).catch((e) => {
    if (isVerificationCancelled(e)) {
      logs.push("用户取消登录，跳过该书源");
      return [];
    }
    appendBookSourceErrorLog(logs, e, {
      phase: "搜索列表解析",
      sourceName: source.bookSourceName,
      sourceUrl: source.bookSourceUrl,
      url: analyzeUrl.url,
      extra: `关键词: ${key}，页码: ${page}`,
    });
    throw e;
  });
}

export async function exploreBook(
  source: BookSourceRecord,
  exploreCategoryUrl: string,
  page = 1,
  logs: string[] = [],
): Promise<SearchBookItem[]> {
  const host = createJsExtensionHost(source, logs);
  runJsLib(source, host);
  const ruleVariables: Record<string, string> = {};
  const analyzeUrl = new AnalyzeUrl({
    mUrl: exploreCategoryUrl,
    page,
    baseUrl: source.bookSourceUrl,
    source,
    host,
    logs,
    ruleVariables,
  });
  let res = await analyzeUrl.getStrResponse();
  if (source.loginCheckJs?.trim()) {
    try {
      res = await runLoginCheckJs(analyzeUrl, source, res, "", logs);
    } catch (e) {
      if (isVerificationCancelled(e)) {
        logs.push("用户取消登录，跳过该书源");
        return [];
      }
      throw e;
    }
  } else {
    try {
      res = await awaitLoginForSearchPage(source, res, analyzeUrl, logs);
    } catch (e) {
      if (isVerificationCancelled(e)) {
        logs.push("用户取消登录，跳过该书源");
        return [];
      }
      throw e;
    }
  }
  return analyzeBookList(
    source,
    res.body,
    res.url,
    analyzeUrl.url,
    analyzeUrl.ruleUrl,
    ruleVariables,
    logs,
    host,
    "explore",
  ).catch((e) => {
    if (isVerificationCancelled(e)) {
      logs.push("用户取消登录，跳过该书源");
      return [];
    }
    appendBookSourceErrorLog(logs, e, {
      phase: "发现列表解析",
      sourceName: source.bookSourceName,
      sourceUrl: source.bookSourceUrl,
      url: exploreCategoryUrl,
      extra: `页码: ${page}`,
    });
    throw e;
  });
}

type BookListRuleBlock = NonNullable<BookSourceRecord["ruleSearch"]>;

async function analyzeBookList(
  source: BookSourceRecord,
  body: string,
  baseUrl: string,
  requestUrl: string,
  ruleUrl: string,
  ruleVariables: Record<string, string>,
  logs: string[],
  host: ReturnType<typeof createJsExtensionHost>,
  mode: "search" | "explore" = "search",
): Promise<SearchBookItem[]> {
  let rule: BookListRuleBlock;
  if (mode === "explore") {
    const exploreRule = source.ruleExplore;
    rule =
      exploreRule?.bookList?.trim()
        ? exploreRule
        : (source.ruleSearch ?? {});
  } else {
    rule = source.ruleSearch ?? {};
  }
  if (!rule?.bookList) return [];
  const ar = new AnalyzeRule(source, logs, host)
    .setContent(body, baseUrl)
    .setRequestContext(ruleUrl, requestUrl || baseUrl)
    .setRuleData({ variable: ruleVariables });
  if (source.bookUrlPattern?.trim()) {
    try {
      if (new RegExp(source.bookUrlPattern).test(baseUrl)) {
        logs.push("链接为详情页，按 ruleBookInfo 解析");
        const item = await parseInfoSearchItem(
          source,
          ar,
          body,
          baseUrl,
          requestUrl,
          ruleUrl,
          logs,
        );
        return item ? [item] : [];
      }
    } catch {
      /* ignore invalid pattern */
    }
  }
  let bookListRule = rule.bookList;
  let reverse = false;
  if (bookListRule.startsWith("-")) {
    reverse = true;
    bookListRule = bookListRule.slice(1);
  }
  if (bookListRule.startsWith("+")) {
    bookListRule = bookListRule.slice(1);
  }
  const elements = await ar.getElements(bookListRule, body);
  if (elements.length === 0) {
    logs.push(
      `[${mode}] bookList 未解析到书籍条目（请求 ${requestUrl || baseUrl}）`,
    );
  }
  const items: SearchBookItem[] = [];
  if (elements.length === 0 && !source.bookUrlPattern?.trim()) {
    logs.push("列表为空，按详情页解析（ruleBookInfo）");
    const item = await parseInfoSearchItem(
      source,
      ar,
      body,
      baseUrl,
      requestUrl,
      ruleUrl,
      logs,
    );
    if (item) items.push(item);
    return items;
  }
  for (const el of elements) {
    const item = await parseSearchItem(
      source,
      ar,
      el,
      baseUrl,
      requestUrl,
      items.length,
      rule,
      logs,
    );
    if (item) items.push(item);
  }
  if (reverse) items.reverse();
  const seen = new Set<string>();
  const deduped = items.filter((item) => {
    const k = `${item.name}::${item.author}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  await fillSearchIntrosFromBookInfo(source, deduped, rule, body, host, logs);
  return deduped;
}

/** 列表为空或链接即详情页时，按 ruleBookInfo 解析（对齐 Legado BookList.getInfoItem） */
async function parseInfoSearchItem(
  source: BookSourceRecord,
  ar: AnalyzeRule,
  body: unknown,
  baseUrl: string,
  requestUrl: string,
  ruleUrl: string,
  logs: string[],
): Promise<SearchBookItem | null> {
  const rule = source.ruleBookInfo ?? {};
  ar.setContent(body, baseUrl).setRedirectUrl(baseUrl);
  if (rule.init?.trim()) {
    const initEl = await ar.getElement(rule.init);
    if (initEl != null) ar.setContent(initEl, baseUrl);
  }
  const nameRaw = (await resolveBookInfoField(ar, rule.name)).trim();
  if (!nameRaw || isLikelyBadDetailName(nameRaw)) return null;
  const authorRaw = (await resolveBookInfoField(ar, rule.author)).trim();
  const author =
    authorRaw && !isLikelyBadDetailName(authorRaw)
      ? formatLegadoBookAuthor(authorRaw) || "未知"
      : "未知";
  const name = stripEmbeddedAuthorFromDetailName(nameRaw, author);
  const requestedAbs = resolveAbsoluteUrl(
    requestUrl || normalizeBookSourceBaseUrl(source.bookSourceUrl),
    ruleUrl,
  );
  const bookUrl =
    baseUrl && requestedAbs && baseUrl !== requestedAbs
      ? baseUrl
      : requestedAbs || baseUrl;
  const kindParts = rule.kind
    ? await resolveBookInfoKindParts(ar, rule.kind)
    : [];
  const kind = kindParts.length ? kindParts.join(",") : undefined;
  const rawWordCount = await resolveBookInfoField(ar, rule.wordCount);
  const wordCount = wordCountFormat(rawWordCount) || undefined;
  const introRaw = await resolveBookInfoField(ar, rule.intro);
  const intro = formatLegadoBookIntro(introRaw) || undefined;
  const rawCover = await resolveBookInfoField(ar, rule.coverUrl);
  const coverSourceUrl =
    resolveCoverSourceUrl(source, rawCover, baseUrl, logs) ?? undefined;
  const coverUrl =
    (coverSourceUrl
      ? await resolveBookCoverDisplayUrl(source, rawCover, baseUrl, logs)
      : undefined) ?? undefined;
  const lastChapter =
    formatLegadoLastChapterDisplay(await resolveBookInfoField(ar, rule.lastChapter)) ||
    undefined;
  return {
    id: `${source.bookSourceUrl}::${bookUrl}::info`,
    name,
    author,
    kind,
    wordCount,
    lastChapter,
    intro,
    coverUrl,
    coverSourceUrl,
    bookUrl,
    origin: source.bookSourceUrl,
    originName: source.bookSourceName,
  };
}

/**
 * 对齐 Legado `BookList.getSearchItem` 字段顺序：
 * name → author → kind → wordCount → lastChapter → intro → coverUrl → bookUrl
 *（kind 须在 bookUrl 之前写入 AnalyzeRule.book，供 `{{book.kind}}` 使用）
 */
async function parseSearchItem(
  source: BookSourceRecord,
  ar: AnalyzeRule,
  el: unknown,
  baseUrl: string,
  requestUrl: string,
  index: number,
  rule: BookListRuleBlock,
  logs: string[],
): Promise<SearchBookItem | null> {
  const savedContent = ar.currentContent;
  const savedBaseUrl = ar.currentBaseUrl;
  ar.setContent(el, baseUrl);
  try {
    const name = await ar.getString(rule.name, el);
    if (!name) return null;
    const author =
      formatLegadoBookAuthor(await ar.getString(rule.author, el)) || "未知";

    const kindParts = rule.kind
      ? await resolveBookInfoKindParts(ar, rule.kind, el)
      : [];
    warnSuspiciousKindTags(kindParts, logs, source.bookSourceName);
    const kind = kindParts.length ? kindParts.join(",") : undefined;

    // 先绑定 name/author/kind，再解析后续依赖 book.* 的字段（对齐 Legado setRuleData）
    ar.setBook({ name, author, kind: kind ?? "" });

    const rawWordCount = await ar.getString(rule.wordCount, el);
    const wordCount = wordCountFormat(rawWordCount) || undefined;
    const lastChapter =
      formatLegadoLastChapterDisplay(await ar.getString(rule.lastChapter, el)) ||
      undefined;

    const introRaw = (await ar.getString(rule.intro, el)).trim();
    const intro = introRaw ? formatLegadoBookIntro(introRaw) || undefined : undefined;

    // 列表不预拉封面（搜索/发现条目多）；由渲染侧 useBookshelfCoverUrls 懒解析
    const rawCover = await ar.getUrl(rule.coverUrl ?? "", el);
    const coverSourceUrl =
      resolveCoverSourceUrl(source, rawCover, baseUrl, logs) ?? undefined;
    const coverUrl = coverSourceUrl;

    const hasBookUrlRule = Boolean(rule.bookUrl?.trim());
    let bookUrl = await ar.getUrl(rule.bookUrl ?? "", el);
    if (!bookUrl) {
      if (hasBookUrlRule) {
        logs.push(
          `[${source.bookSourceName}] 「${name}」详情 URL 规则解析失败（请查看 JS 错误）`,
        );
        return null;
      }
      bookUrl = requestUrl || baseUrl;
    }
    if (hasBookUrlRule && (bookUrl.includes("@js:") || bookUrl.includes("<js>"))) {
      logs.push(
        `[${source.bookSourceName}] 「${name}」详情 URL 未正确执行 JS 规则，已跳过`,
      );
      return null;
    }

    ar.setBook({ name, author, kind: kind ?? "", bookUrl });

    return {
      id: `${source.bookSourceUrl}::${bookUrl}::${index}`,
      name,
      author,
      kind,
      wordCount,
      lastChapter,
      intro,
      coverUrl,
      coverSourceUrl,
      bookUrl,
      origin: source.bookSourceUrl,
      originName: source.bookSourceName,
    };
  } finally {
    ar.setContent(savedContent, savedBaseUrl);
  }
}

export type { Book, BookChapter };

function ensureBookUrlWithHeaders(
  bookUrl: string,
  host: ReturnType<typeof createJsExtensionHost>,
): string {
  if (extractUrlFetchOptionsSuffix(bookUrl)) return bookUrl;
  const get = host.javaBindings.get as ((k: string) => string) | undefined;
  const stored = get?.("headers")?.trim() ?? "";
  if (!stored) return bookUrl;
  const { url: path } = splitUrlAndRuleVariables(bookUrl);
  const raw = stored.startsWith("{") ? stored : `{${stored}}`;
  const opts = parseLegadoUrlSuffixJson(raw);
  const tail = opts.headers
    ? JSON.stringify({ headers: opts.headers })
    : raw;
  return `${path},${tail}`;
}

/** 从 UrlOption POST body 取出 bookId */
function extractJsonBookIdFromUrlOption(url: string): string {
  const suffix = extractUrlFetchOptionsSuffix(url);
  if (!suffix.startsWith(",")) return "";
  const opts = parseLegadoUrlSuffixJson(suffix.slice(1).trim());
  const body = opts.body?.trim() ?? "";
  if (!body) return "";
  try {
    const parsed = JSON.parse(body) as { bookId?: unknown };
    const id = parsed.bookId;
    if (id != null && String(id).trim()) return String(id).trim();
  } catch {
    /* body 可能仍带未展开模板 */
  }
  return body.match(/"bookId"\s*:\s*"(\d+)"/)?.[1] ?? "";
}

/**
 * 仅当 book.kind 为空时从 tocUrl/bookUrl 兜底（正常路径靠详情/列表已干净的 kind）。
 */
export function resolveBookKindForChapterRules(
  kind: string | undefined,
  tocUrl: string,
  bookUrl: string,
): string {
  const fromKind = kind?.trim();
  if (fromKind) return stripNumericIdPrefix(fromKind);
  const fromToc =
    tocUrl.match(/[?&]bookId=([^&]+)/i)?.[1] ??
    tocUrl.match(/[?&]book_id=([^&]+)/i)?.[1];
  if (fromToc?.trim()) {
    return stripNumericIdPrefix(decodeURIComponent(fromToc.trim()));
  }
  const fromBookUrl =
    bookUrl.match(/[?&](?:bookId|book_id|resourceId)=([^&]+)/i)?.[1];
  if (fromBookUrl?.trim()) {
    return stripNumericIdPrefix(decodeURIComponent(fromBookUrl.trim()));
  }
  return "";
}

/**
 * 目录阶段未带 kind 时，章节 URL 里 BookID 可能为空或带 90000001_。
 * 拉取正文前用短 id 回填。
 */
export function repairChapterUrlBookId(chapterUrl: string, bookId: string): string {
  const id = stripNumericIdPrefix(bookId);
  if (!id || !/ads-read/i.test(chapterUrl)) return chapterUrl;
  const comma = chapterUrl.indexOf(",{");
  if (comma < 0) return chapterUrl;
  const urlPart = chapterUrl.slice(0, comma);
  const optRaw = chapterUrl.slice(comma + 1);
  let opts: Record<string, unknown>;
  try {
    opts = JSON.parse(optRaw) as Record<string, unknown>;
  } catch {
    return chapterUrl;
  }
  const body = opts.body;
  if (typeof body !== "string" || !body.includes("BookID")) return chapterUrl;
  const nextBody = body.replace(
    /"BookID"\s*:\s*(?:""|null|"[^"]*")/,
    `"BookID":"${id}"`,
  );
  if (nextBody === body) return chapterUrl;
  return `${urlPart},${JSON.stringify({ ...opts, body: nextBody })}`;
}

function syncLegadoHeadersForRules(
  ar: AnalyzeRule,
  host: ReturnType<typeof createJsExtensionHost>,
  bookUrl: string,
  variables: Record<string, string>,
): void {
  let wrapped = "";
  const split = splitUrlFetchOptions(bookUrl);
  if (split.options.headers && Object.keys(split.options.headers).length > 0) {
    wrapped = JSON.stringify({ headers: split.options.headers });
  } else if (variables.headers) {
    try {
      const parsed = JSON.parse(variables.headers) as unknown;
      if (
        parsed &&
        typeof parsed === "object" &&
        "headers" in (parsed as Record<string, unknown>)
      ) {
        wrapped = variables.headers;
      } else {
        wrapped = JSON.stringify({ headers: parsed });
      }
    } catch {
      wrapped = variables.headers;
    }
  }
  if (!wrapped) {
    const get = host.javaBindings.get as ((k: string) => string) | undefined;
    const fromStore = get?.("headers") ?? "";
    if (fromStore) wrapped = fromStore;
  }
  if (!wrapped) return;
  ar.putStored("headers", wrapped);
  const put = host.javaBindings.put as ((k: string, v: unknown) => string) | undefined;
  put?.("headers", wrapped);
  variables.headers = wrapped;
}

/** 七猫等 API 书源：updateTime 规则为空时从 update_time 或 lastChapter 拼接段提取 */
function resolveBookUpdateTimeFallback(
  ar: AnalyzeRule,
  lastChapterRaw: string,
): string {
  const content = ar.currentContent;
  if (isPlainRuleObject(content)) {
    const raw = readJsonField(content, "update_time").trim();
    const ts = Number(raw);
    if (Number.isFinite(ts) && ts > 0) {
      return timeFormat(ts > 1e12 ? ts : ts * 1000);
    }
  }
  const m = lastChapterRaw.match(
    /[·•]\s*(\d{4}[/-]\d{1,2}[/-]\d{1,2}(?:\s+\d{1,2}:\d{2})?)/,
  );
  if (m?.[1]) return m[1].replace(/-/g, "/");
  const fromIntro = lastChapterRaw.match(
    /更新时间[：:]\s*(\d{4}[/-]\d{1,2}[/-]\d{1,2}(?:\s+\d{1,2}:\d{2})?)/,
  );
  if (fromIntro?.[1]) return fromIntro[1].replace(/-/g, "/");
  return "";
}

function isLikelyBadDetailName(parsed: string): boolean {
  const p = parsed.trim().toLowerCase();
  if (!p) return true;
  return /404|not\s*found|403|500|502|503|bad gateway|error|禁止|拒绝|异常/.test(p);
}

function bookInfoLooksEmpty(body: string): boolean {
  const t = body.trim();
  if (!t.startsWith("{")) return !t;
  try {
    const j = JSON.parse(t) as {
      data?: { bookInfo?: { resourceName?: string; author?: string; summary?: string } };
    };
    const info = j.data?.bookInfo;
    if (!info) return true;
    return !String(info.resourceName ?? "").trim() && !String(info.author ?? "").trim();
  } catch {
    return false;
  }
}

function bookInfoInitFailed(body: string, initRule?: string | null): boolean {
  const t = body.trim();
  if (!t) return true;
  if (t.startsWith("<") && /404|not\s*found|error/i.test(t.slice(0, 800))) return true;
  const init = initRule?.trim() ?? "";
  if (!init) return false;
  // JS init（如 `<js>…</js>`）由 init 规则处理，不能按 JSONPath 校验
  if (/^<js>/i.test(init) || /^@js:/i.test(init)) {
    // data:;base64 + UrlOption.type 会先得到 hex 正文，交由 init JS hexDecode，不能当失败
    if (/^[0-9a-fA-F]+$/.test(t) && t.length % 2 === 0) return false;
    // SPA hash 书链（如 uc.cn/#!/…）请求不到片段，只会拿到站点 HTML；
    // init 常只用 java.get('bid') 拼 tocUrl，不依赖正文 → 勿当失败
    if (!t.startsWith("{") && !t.startsWith("[")) {
      if (!t) return true;
      if (t.startsWith("<") && /404|not\s*found|error/i.test(t.slice(0, 800))) {
        return true;
      }
      return false;
    }
    try {
      const data = JSON.parse(t) as Record<string, unknown>;
      const meta = data.meta as Record<string, unknown> | undefined;
      if (meta?.status != null && Number(meta.status) !== 200) return true;
      const code = data.code;
      if (code != null && Number(code) !== 0 && Number(code) !== 200) return true;
      return false;
    } catch {
      return true;
    }
  }
  if (!t.startsWith("{")) return false;
  try {
    const data = JSON.parse(t) as Record<string, unknown>;
    if (init.startsWith("$.") || init.startsWith("$[")) {
      const nested = readJsonNestedValue(data, init);
      return nested == null || nested === "" || typeof nested !== "object";
    }
    const path = init.replace(/^\$\.?/, "").split(".").filter(Boolean);
    let cur: unknown = data;
    for (const key of path) {
      if (cur == null || typeof cur !== "object") return true;
      cur = (cur as Record<string, unknown>)[key];
    }
    return cur == null || typeof cur !== "object";
  } catch {
    return true;
  }
}

function tryParseJsonBookInfoContent(body: string): unknown {
  const t = body.trim();
  if (!t.startsWith("{") && !t.startsWith("[")) return body;
  try {
    return JSON.parse(t) as unknown;
  } catch {
    return body;
  }
}

/** ruleBookInfo.init 可能返回 JSON 子对象（如 data.book），不可 String() 成 [object Object] */
async function applyBookInfoInitContent(
  ar: AnalyzeRule,
  initRule: string | undefined | null,
  body: string,
  base: string,
): Promise<void> {
  const parsed = tryParseJsonBookInfoContent(body);
  ar.setContent(parsed, base);

  const init = initRule?.trim() ?? "";
  if (!init) return;

  let initEl = await ar.getElement(init, parsed);
  if ((initEl == null || initEl === "") && isPlainRuleObject(parsed)) {
    const nested = readJsonNestedValue(parsed, init);
    if (nested != null && nested !== "") initEl = nested;
  }
  if (initEl == null || initEl === "") return;

  if (typeof initEl === "object") {
    ar.setContent(initEl, base);
    return;
  }

  const text = typeof initEl === "string" ? initEl : String(initEl);
  ar.setContent(tryParseJsonBookInfoContent(text), base);
}

export async function getBookInfo(
  source: BookSourceRecord,
  bookUrl: string,
  name: string,
  author: string,
  logs: string[] = [],
  seed: BookInfoSeed = {},
): Promise<Book> {
  const host = createJsExtensionHost(source, logs);
  runJsLib(source, host);
  const resolvedBookUrl = ensureBookUrlWithHeaders(bookUrl, host);
  const { url: bookPageUrl, variables } = splitUrlAndRuleVariables(resolvedBookUrl);
  const listIntro = seed.intro?.trim() ?? "";
  if (listIntro) variables.intro = listIntro;
  const book: Book = {
    name,
    author,
    bookUrl,
    tocUrl: "",
    intro: listIntro,
    kind: seed.kind?.trim() ?? "",
    coverUrl: seed.coverUrl?.trim() ?? "",
    wordCount: seed.wordCount?.trim() ?? "",
    lastChapter: seed.lastChapter?.trim() ?? "",
    variable: { ...variables },
  };
  const ar = new AnalyzeRule(source, logs, host)
    .setBook(toEngineBook(book))
    .setRuleData({ variable: { ...variables } });
  syncLegadoHeadersForRules(ar, host, resolvedBookUrl, variables);
  ar.setRuleData({ variable: { ...variables } });
  const analyzeUrl = new AnalyzeUrl({
    mUrl: resolvedBookUrl,
    baseUrl: source.bookSourceUrl,
    source,
    host,
    logs,
    ruleVariables: variables,
  });
  let res = await analyzeUrl.getStrResponse();
  // resourceId 为 90000001_数字 时 bookInfo 常空，去掉前缀重试
  if (
    /[?&]resourceId=\d+_\d+/i.test(resolvedBookUrl) &&
    bookInfoLooksEmpty(res.body)
  ) {
    const stripped = resolvedBookUrl.replace(/([?&]resourceId=)\d+_/i, "$1");
    if (stripped !== resolvedBookUrl) {
      logs.push(`详情 resourceId 含前缀且响应空，重试: ${stripped.slice(0, 120)}`);
      res = await new AnalyzeUrl({
        mUrl: stripped,
        baseUrl: source.bookSourceUrl,
        source,
        host,
        logs,
        ruleVariables: variables,
      }).getStrResponse();
      // 后续 tocUrl 拼 $..resourceID 须用短 id
      book.bookUrl = stripped;
    }
  }
  const base = res.url;
  const redirectUrl = res.url;
  const rule = source.ruleBookInfo ?? {};
  const detailInitFailed = bookInfoInitFailed(res.body, rule.init);
  if (detailInitFailed) {
    logs.push(`详情页响应异常（可能缺少签名 headers），URL: ${base}`);
  }
  ar.setRedirectUrl(redirectUrl);
  await applyBookInfoInitContent(ar, rule.init, res.body, base);
  const detailNameRaw = (await resolveBookInfoField(ar, rule.name)).trim();
  const detailAuthorRaw = (await resolveBookInfoField(ar, rule.author)).trim();
  const detailAuthor = formatLegadoBookAuthor(
    isLikelyBadDetailName(detailAuthorRaw) || !detailAuthorRaw
      ? author
      : detailAuthorRaw,
  ) || "未知";
  let detailName = isLikelyBadDetailName(detailNameRaw) ? name : detailNameRaw;
  detailName = stripEmbeddedAuthorFromDetailName(detailName, detailAuthor);
  const kindParts = rule.kind ? await resolveBookInfoKindParts(ar, rule.kind) : [];
  const parsedKind = kindParts.length ? kindParts.join(",") : "";
  // 详情落地一次规范化 kind
  const kind = stripNumericIdPrefix(parsedKind || book.kind || "");
  book.kind = kind;
  book.name = detailName;
  book.author = detailAuthor;
  ar.setBook(toEngineBook(book));
  const rawWordCount = await resolveBookInfoField(ar, rule.wordCount);
  const wordCount =
    wordCountFormat(rawWordCount) || book.wordCount || undefined;
  const lastChapterRaw = (await resolveBookInfoField(ar, rule.lastChapter)).trim();
  const parsedLastChapter = formatLegadoLastChapterDisplay(lastChapterRaw) || "";
  const lastChapter = parsedLastChapter || book.lastChapter || undefined;
  const parsedIntro = await resolveBookIntroText(ar, rule.intro, kindParts);
  let intro = parsedIntro || listIntro || book.intro;
  intro = ensureLegadoIntroLeadingTitle(intro, detailName);
  const rawCover = await resolveBookInfoField(ar, rule.coverUrl);
  const coverFetchRaw = rawCover.trim() || book.coverUrl || "";
  const coverSourceUrl =
    resolveCoverSourceUrl(source, rawCover, redirectUrl, logs) ||
    resolveCoverSourceUrl(source, book.coverUrl, redirectUrl, logs) ||
    undefined;
  const resolvedCover =
    (coverSourceUrl
      ? await resolveBookCoverDisplayUrl(source, coverFetchRaw, redirectUrl, logs)
      : undefined) ?? "";
  const coverUrl = resolvedCover || book.coverUrl;
  let updateTime = (await resolveBookInfoField(ar, rule.updateTime)).trim();
  const kindDate = kindParts.find((t) => /^\d{4}[/-]\d{1,2}[/-]\d{1,2}/.test(t));
  if (!updateTime && kindDate) updateTime = kindDate.replace(/T.*/, "").replace(/-/g, "/");
  if (!updateTime) {
    const m = kind.match(/\d{4}[/-]\d{1,2}[/-]\d{1,2}/);
    if (m) updateTime = m[0].replace(/-/g, "/");
  }
  if (!updateTime) updateTime = resolveBookUpdateTimeFallback(ar, lastChapterRaw);
  if (!updateTime && intro) {
    const m = intro.match(
      /更新时间[：:]\s*(\d{4}[/-]\d{1,2}[/-]\d{1,2}(?:\s+\d{1,2}:\d{2})?)/,
    );
    if (m?.[1]) updateTime = m[1].replace(/-/g, "/");
  }
  // Legado BookInfo：tocUrl 用 getString(..., isUrl=true) → 多 URL 时取首条
  let tocUrl = "";
  if (rule.tocUrl?.trim()) {
    const rawToc = (await resolveBookInfoField(ar, rule.tocUrl)).trim();
    if (rawToc) {
      if (/,\s*\{/.test(rawToc)) {
        tocUrl = ar.resolveAbsoluteRuleUrl(rawToc);
      } else {
        const first =
          rawToc
            .split(/[\r\n]+/)
            .map((s) => s.trim())
            .find(Boolean) ?? "";
        tocUrl = first ? ar.resolveAbsoluteRuleUrl(first) : "";
      }
    }
  }
  if (tocUrl && /[?&]bid=$/i.test(tocUrl)) {
    const bidFromBookUrl =
      bookPageUrl.match(/[?&]bid=([^&]+)/i)?.[1] ??
      bookUrl.match(/[?&]bid=([^&]+)/i)?.[1];
    if (bidFromBookUrl) {
      tocUrl = tocUrl.replace(/([?&]bid=)$/i, `$1${bidFromBookUrl}`);
    }
  }
  if (tocUrl && /[?&]bookId=$/i.test(tocUrl)) {
    const bookIdFromUrl =
      bookPageUrl.match(/[?&]book_id=([^&]+)/i)?.[1] ??
      bookUrl.match(/[?&]book_id=([^&]+)/i)?.[1] ??
      resolvedBookUrl.match(/[?&]book_id=([^&]+)/i)?.[1] ??
      bookPageUrl.match(/[?&]bookid=(\d+)/i)?.[1] ??
      bookUrl.match(/[?&]bookid=(\d+)/i)?.[1] ??
      resolvedBookUrl.match(/[?&]bookid=(\d+)/i)?.[1];
    if (bookIdFromUrl) {
      tocUrl = tocUrl.replace(/([?&]bookId=)$/i, `$1${bookIdFromUrl}`);
    }
  }
  // POST body 里 `"bookId":""`（UrlOption）：从详情 URL 选项回填
  if (tocUrl && /"bookId"\s*:\s*""/.test(tocUrl)) {
    const bookId =
      extractJsonBookIdFromUrlOption(resolvedBookUrl) ||
      extractJsonBookIdFromUrlOption(bookUrl) ||
      (typeof ar.currentContent === "object" &&
      ar.currentContent &&
      "bookId" in (ar.currentContent as object)
        ? String((ar.currentContent as { bookId?: unknown }).bookId ?? "")
        : "");
    if (bookId) {
      tocUrl = tocUrl.replace(/"bookId"\s*:\s*""/g, `"bookId":"${bookId}"`);
    }
  }
  if (/^@js:/i.test(tocUrl) || /^<js>/i.test(tocUrl)) {
    logs.push("目录 URL 规则未正确执行 JS，请检查 ruleBookInfo.tocUrl");
    tocUrl = "";
  }
  if (/\[object\s+Object\]/i.test(tocUrl)) {
    tocUrl = "";
  }
  if (tocUrl && !/^https?:\/\//i.test(tocUrl) && !tocUrl.startsWith("data:")) {
    tocUrl = resolveAbsoluteUrl(
      normalizeBookSourceBaseUrl(redirectUrl || base),
      tocUrl,
    );
  }
  const bidMatch = bookUrl.match(/\/chapters\/([^/?#,]+)/);
  const idFromQuery =
    resolvedBookUrl.match(/[?&](?:id|bid|book_id|bookid)=([^&]+)/i)?.[1];
  const bid = bidMatch?.[1] ?? idFromQuery;
  if (bid) {
    ar.putStored("bid", bid);
  }
  const detail: Book = {
    name: detailName,
    author: detailAuthor,
    intro,
    coverUrl,
    coverSourceUrl,
    kind,
    wordCount,
    lastChapter,
    updateTime: updateTime || undefined,
    tocUrl: tocUrl ? ensureBookUrlWithHeaders(tocUrl, host) : tocUrl,
    bookUrl: String(book.bookUrl || resolvedBookUrl),
    origin: seed.origin,
    originName: seed.originName,
    variable: book.variable,
  };
  if (!detail.tocUrl?.trim()) {
    detail.tocUrl = ensureBookUrlWithHeaders(String(book.bookUrl || resolvedBookUrl), host);
  }
  return detail;
}

function dedupeChapters(chapters: BookChapter[]): BookChapter[] {
  const seen = new Set<string>();
  const out: BookChapter[] = [];
  for (const ch of chapters) {
    const key = `${ch.url}\0${ch.title}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ch);
  }
  return out;
}

async function applyTocFormatJs(
  chapters: BookChapter[],
  formatJs: string,
  source: BookSourceRecord,
  host: ReturnType<typeof createJsExtensionHost>,
): Promise<void> {
  const gIntRef = { value: 0 };
  for (let i = 0; i < chapters.length; i++) {
    const chapter = chapters[i]!;
    const script = `
var index = ${i + 1};
var title = ${JSON.stringify(chapter.title)};
var gInt = ${gIntRef.value};
${formatJs.trim()}
`;
    try {
      const out = await evalJsAsync(script, {
        source,
        host,
        chapter,
        result: chapter.title,
        baseUrl: source.bookSourceUrl,
      });
      if (out != null && String(out).trim()) {
        chapter.title = String(out).trim();
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      host.log(`格式化标题出错: ${msg}`);
    }
  }
}

function parseTocListRule(chapterListRule: string): {
  listRule: string;
  reversePrefix: boolean;
} {
  let listRule = chapterListRule;
  let reversePrefix = false;
  if (listRule.startsWith("-")) {
    reversePrefix = true;
    listRule = listRule.slice(1);
  } else if (listRule.startsWith("+")) {
    listRule = listRule.slice(1);
  }
  return { listRule, reversePrefix };
}

async function applyContentReplaceRegex(
  ar: AnalyzeRule,
  content: string,
  replaceRegex: string,
): Promise<string> {
  const normalized = content
    .split(/\r?\n/)
    .map((l) => l.trim())
    .join("\n");
  const lines = replaceRegex
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const hashLineMode =
    lines.length > 0 && lines.every((l) => l.includes("##"));
  if (hashLineMode) {
    let out = normalized;
    for (const line of lines) {
      if (line.startsWith("##")) {
        const { regex } = splitRuleRegexSuffix(line);
        if (regex?.pattern) {
          out = applyContentRuleRegex(out, {
            pattern: expandContentRegexPlaceholders(ar, regex.pattern),
            replacement: expandContentRegexPlaceholders(
              ar,
              regex.replacement ?? "",
            ),
            replaceFirst: regex.replaceFirst,
          });
        }
        continue;
      }
      const segs = line.split("##");
      if (segs.length >= 2 && segs[0]) {
        try {
          const pat = expandContentRegexPlaceholders(ar, segs[0]!);
          const repl = expandContentRegexPlaceholders(ar, segs[1] ?? "");
          out = out.replace(new RegExp(pat, "g"), repl);
        } catch {
          /* ignore invalid regex */
        }
      }
    }
    return out;
  }
  return ar.getString(replaceRegex, normalized);
}

/** 正文 replaceRegex 行内 {{title}} 等占位 */
function expandContentRegexPlaceholders(ar: AnalyzeRule, text: string): string {
  return text
    .replace(/\{\{([\s\S]*?)\}\}/g, (_, expr: string) => {
      const key = String(expr).trim();
      if (key === "book.name") return ar.getStored("bookName");
      return ar.getStored(key);
    })
    .replace(/@get:\{([^}]+)\}/gi, (_, key: string) =>
      ar.getStored(String(key).trim()),
    );
}

/** 正文 replaceRegex：对齐 Legado，`.` 默认不匹配换行 */
function applyContentRuleRegex(
  value: string,
  regex: { pattern: string; replacement: string; replaceFirst?: boolean },
): string {
  if (!regex.pattern) return value;
  try {
    if (regex.replaceFirst) {
      const re = new RegExp(regex.pattern);
      const m = value.match(re);
      if (!m?.[0]) return value;
      return m[0].replace(re, regex.replacement ?? "");
    }
    return value.replace(new RegExp(regex.pattern, "g"), regex.replacement ?? "");
  } catch {
    return value;
  }
}

async function fetchContentPage(
  source: BookSourceRecord,
  host: ReturnType<typeof createJsExtensionHost>,
  logs: string[],
  rule: NonNullable<BookSourceRecord["ruleContent"]>,
  body: string,
  pageUrl: string,
  redirectUrl: string,
  book: Record<string, unknown>,
  chapter: Record<string, unknown>,
  variables: Record<string, string>,
  nextChapterUrl?: string,
  getNextPageUrl = true,
): Promise<{ content: string; nextUrls: string[] }> {
  const contentBaseUrl = String(chapter.url ?? pageUrl);
  const ar = new AnalyzeRule(source, logs, host)
    .setContent(body, contentBaseUrl)
    .setRedirectUrl(redirectUrl)
    .setBook({ ...book, variable: { ...variables } })
    .setChapter(chapter)
    .setRuleData({ variable: { ...variables } })
    .setNextChapterUrl(nextChapterUrl);
  let content = await ar.getString(rule.content, body);
  if (/<[a-z][\s\S]*>/i.test(content)) {
    content = formatLegadoChapterContent(content);
    if (content.includes("&")) {
      content = unescapeLegadoHtmlEntities(content);
    }
  }
  let nextUrls: string[] = [];
  if (getNextPageUrl && rule.nextContentUrl?.trim()) {
    nextUrls = await ar.getUrlList(rule.nextContentUrl, body);
  }
  return { content, nextUrls };
}

export async function getChapterList(
  source: BookSourceRecord,
  bookInput: Book,
  logs: string[] = [],
): Promise<BookChapter[]> {
  const host = createJsExtensionHost(source, logs);
  runJsLib(source, host);
  const rule = source.ruleToc ?? {};
  const bookUrl = bookInput.bookUrl?.trim() || "";
  const tocUrl = (bookInput.tocUrl || bookUrl).trim();
  const resolvedBookUrl = ensureBookUrlWithHeaders(bookUrl, host);
  let resolvedTocUrl = ensureBookUrlWithHeaders(tocUrl, host);
  const { url: bookPageUrl, variables } = splitUrlAndRuleVariables(resolvedBookUrl);
  const { url: fetchTocUrl, variables: tocVars } =
    splitUrlAndRuleVariables(resolvedTocUrl);
  Object.assign(variables, tocVars);
  let kind = stripNumericIdPrefix(bookInput.kind);
  if (!kind) {
    kind = resolveBookKindForChapterRules("", fetchTocUrl, bookPageUrl);
  }
  const book = toEngineBook(
    coerceBook({
      ...bookInput,
      kind,
      bookUrl: bookPageUrl,
      tocUrl: fetchTocUrl,
    }),
  );
  const ar = new AnalyzeRule(source, logs, host)
    .setBook(book)
    .setRuleData({ variable: { ...variables } });
  syncLegadoHeadersForRules(ar, host, resolvedBookUrl, variables);
  syncLegadoHeadersForRules(ar, host, resolvedTocUrl, variables);
  ar.setRuleData({ variable: { ...variables } });
  const bidMatch = bookPageUrl.match(/\/chapters\/([^/?#,]+)/);
  const idFromQuery =
    bookPageUrl.match(/[?&]book_id=([^&]+)/i)?.[1] ??
    fetchTocUrl.match(/[?&]bookId=([^&]+)/i)?.[1] ??
    bookPageUrl.match(/[?&](?:id|bid)=([^&]+)/i)?.[1] ??
    fetchTocUrl.match(/[?&]bid=([^&]+)/i)?.[1];
  const bid = bidMatch?.[1] ?? idFromQuery;
  if (bid) {
    ar.putStored("bid", bid);
    variables.bid = bid;
    ar.setRuleData({ variable: { ...variables } });
  }
  if (rule.preUpdateJs?.trim()) {
    const au = new AnalyzeUrl({
      mUrl: resolvedTocUrl,
      baseUrl: bookPageUrl,
      source,
      host,
      logs,
      ruleVariables: variables,
    });
    await evalJsAsync(rule.preUpdateJs, {
      source,
      result: fetchTocUrl,
      baseUrl: source.bookSourceUrl,
      host,
      java: au.buildAnalyzeUrlJava(),
    });
  }
  const analyzeUrl = new AnalyzeUrl({
    mUrl: resolvedTocUrl,
    baseUrl: bookPageUrl,
    source,
    host,
    logs,
    ruleVariables: variables,
  });
  const res = await analyzeUrl.getStrResponse();
  let body = res.body;
  let redirectUrl = res.url;
  // bookId 误带 90000001_ 前缀时 all-chapter 返回空 rows，去掉前缀再试
  if (
    body.trim().startsWith("{") &&
    /"rows"\s*:\s*\[\s*\]/.test(body) &&
    /[?&]bookId=\d+_\d+/i.test(fetchTocUrl)
  ) {
    const stripped = fetchTocUrl.replace(
      /([?&]bookId=)\d+_/i,
      "$1",
    );
    if (stripped !== fetchTocUrl) {
      logs.push(`目录 bookId 含前缀且 rows 为空，重试: ${stripped.slice(0, 120)}`);
      const retry = await new AnalyzeUrl({
        mUrl: stripped,
        baseUrl: bookPageUrl,
        source,
        host,
        logs,
        ruleVariables: variables,
      }).getStrResponse();
      body = retry.body;
      redirectUrl = retry.url;
      resolvedTocUrl = stripped;
      book.tocUrl = stripped;
    }
  }
  const chapters: BookChapter[] = [];
  const { listRule, reversePrefix } = parseTocListRule(rule.chapterList ?? "");
  const collect = async (b: string, base: string, redirect: string) => {
    const ar = new AnalyzeRule(source, logs, host)
      .setContent(b, base)
      .setRedirectUrl(redirect)
      .setBook(book)
      .setRuleData({ variable: { ...variables } });
    const list = await ar.getElements(listRule, b);
    if (!list.length && b.trim().startsWith("{")) {
      try {
        const parsed = JSON.parse(b) as {
          errors?: { title?: string; details?: string };
          data?: { chapter_lists?: unknown };
        };
        if (parsed.errors) {
          logs.push(
            `目录接口错误: ${parsed.errors.title ?? parsed.errors.details ?? "验签或权限失败"}`,
          );
        } else if (!parsed.data?.chapter_lists && /fanqie|fqnovel|novel\/api/i.test(base)) {
          logs.push("目录接口未返回 chapter_lists 字段");
        }
      } catch {
        /* ignore */
      }
    }
    for (const el of list) {
      ar.setContent(el, redirect);
      const chapterCtx = { title: "", url: "", tag: "" };
      ar.setChapter(chapterCtx);
      const title = await ar.getString(rule.chapterName, el);
      let url = rule.chapterUrl
        ? await ar.getUrl(rule.chapterUrl, el)
        : "";
      const updateTag = rule.updateTime
        ? await ar.getString(rule.updateTime, el)
        : "";
      if (updateTag && !chapterCtx.tag) chapterCtx.tag = updateTag;
      const isVolume = isTruthy(await ar.getString(rule.isVolume, el));
      if (!title) continue;
      if (!url) {
        if (isVolume) url = `${title}${chapters.length}`;
        else url = base;
      }
      if (!url && !isVolume) continue;
      chapters.push({
        title,
        url: url || base,
        isVolume,
        isVip: isTruthy(await ar.getString(rule.isVip, el)),
        isPay: isTruthy(await ar.getString(rule.isPay, el)),
      });
    }
  };
  await collect(body, res.url, redirectUrl);
  if (rule.nextTocUrl?.trim()) {
    // nextTocUrl 里常按 baseUrl 匹配 UrlOption（如 limit=500）；须用带 option 的原 toc URL，不能只用 res.url
    const tocRuleBaseUrl = resolvedTocUrl || fetchTocUrl || res.url;
    const ar = new AnalyzeRule(source, logs, host)
      .setContent(body, tocRuleBaseUrl)
      .setRedirectUrl(redirectUrl)
      .setBook(book)
      .setRuleData({ variable: { ...variables } });
    const nextList = await ar.getUrlList(rule.nextTocUrl);
    /** 须保留 UrlOption（Lofter offset=… 在 POST body）；仅剥末尾空白 */
    const tocVisitKey = (u: string) => u.trim();
    if (nextList.length === 1) {
      let next = nextList[0]!;
      const visited = new Set<string>([tocVisitKey(resolvedTocUrl), tocVisitKey(fetchTocUrl)]);
      while (next && !visited.has(tocVisitKey(next))) {
        visited.add(tocVisitKey(next));
        const nextRes = await new AnalyzeUrl({
          mUrl: next,
          baseUrl: bookPageUrl,
          source,
          host,
          logs,
          ruleVariables: variables,
        }).getStrResponse();
        await collect(nextRes.body, nextRes.url, nextRes.url);
        const arNext = new AnalyzeRule(source, logs, host)
          .setContent(nextRes.body, next)
          .setRedirectUrl(nextRes.url)
          .setBook(book)
          .setRuleData({ variable: { ...variables } });
        const more = await arNext.getUrlList(rule.nextTocUrl);
        next = more[0] ?? "";
      }
    } else if (nextList.length > 1) {
      const responses = await ajaxAllStrResponses(host, nextList);
      for (const resp of responses) {
        const pageBody = resp.body();
        const pageUrl = resp.url();
        if (pageBody) await collect(pageBody, pageUrl, pageUrl);
      }
    }
  }
  if (!reversePrefix) {
    chapters.reverse();
  }
  let list = dedupeChapters(chapters);
  if (rule.formatJs?.trim()) {
    await applyTocFormatJs(list, rule.formatJs, source, host);
  }
  if (!list.length) {
    logs.push(
      `未解析到章节（tocUrl: ${fetchTocUrl.slice(0, 120)}${fetchTocUrl.length > 120 ? "…" : ""}）`,
    );
  }
  return list;
}

export async function getChapterContent(
  source: BookSourceRecord,
  chapterUrl: string,
  bookInput: Book | Record<string, unknown>,
  chapter: Record<string, unknown>,
  logs: string[] = [],
  nextChapterUrl?: string,
): Promise<string> {
  const host = createJsExtensionHost(source, logs);
  runJsLib(source, host);
  const coerced = coerceBook(bookInput as Partial<Book>);
  const resolvedBookUrl = ensureBookUrlWithHeaders(coerced.bookUrl, host);
  const resolvedTocUrl = ensureBookUrlWithHeaders(
    coerced.tocUrl || coerced.bookUrl,
    host,
  );
  const { url: bookPageUrl, variables } = splitUrlAndRuleVariables(resolvedBookUrl);
  const { variables: tocVars } = splitUrlAndRuleVariables(resolvedTocUrl);
  Object.assign(variables, tocVars);
  let kind = stripNumericIdPrefix(coerced.kind);
  if (!kind) {
    kind = resolveBookKindForChapterRules("", resolvedTocUrl, bookPageUrl);
  }
  const book = toEngineBook(
    coerceBook({
      ...coerced,
      kind,
      bookUrl: bookPageUrl,
      tocUrl: resolvedTocUrl,
    }),
  );
  const fetchChapterUrl = repairChapterUrlBookId(chapterUrl, kind);
  if (fetchChapterUrl !== chapterUrl) {
    chapter = { ...chapter, url: fetchChapterUrl };
  }
  const arInit = new AnalyzeRule(source, logs, host)
    .setBook(book)
    .setChapter(chapter)
    .setRuleData({ variable: { ...variables } });
  syncLegadoHeadersForRules(arInit, host, resolvedBookUrl, variables);
  syncLegadoHeadersForRules(arInit, host, resolvedTocUrl, variables);
  const bidMatch = bookPageUrl.match(/\/chapters\/([^/?#,]+)/);
  const idFromQuery =
    bookPageUrl.match(/[?&](?:id|bid|bookid)=([^&]+)/i)?.[1] ??
    resolvedTocUrl.match(/[?&](?:id|bid|bookid)=([^&]+)/i)?.[1];
  const bid = bidMatch?.[1] ?? idFromQuery;
  if (bid) {
    arInit.putStored("bid", bid);
    variables.bid = bid;
    arInit.setRuleData({ variable: { ...variables } });
  }
  const rule = source.ruleContent ?? {};
  const titleRule = rule.title?.trim() || rule.chapterName?.trim() || "";
  const analyzeUrl = new AnalyzeUrl({
    mUrl: fetchChapterUrl,
    baseUrl: source.bookSourceUrl,
    source,
    host,
    logs,
    ruleVariables: variables,
    webJs: rule.webJs?.trim() || undefined,
    sourceRegex: rule.sourceRegex?.trim() || undefined,
  });
  const res = await analyzeUrl.getStrResponse();
  const body = res.body;
  const redirectUrl = res.url;
  const contentParts: string[] = [];

  const first = await fetchContentPage(
    source,
    host,
    logs,
    rule,
    body,
    res.url,
    redirectUrl,
    { ...book, kind, bookUrl: bookPageUrl, tocUrl: resolvedTocUrl },
    chapter,
    variables,
    nextChapterUrl,
    true,
  );
  contentParts.push(first.content);

  if (first.nextUrls.length === 1) {
    let next = first.nextUrls[0]!;
    const visited = new Set<string>();
    while (next && !visited.has(next)) {
      if (nextChapterUrl) {
        const absNext = new AnalyzeRule(source, logs, host)
          .setRedirectUrl(redirectUrl)
          .resolveAbsoluteRuleUrl(next);
        const absChapterNext = new AnalyzeRule(source, logs, host)
          .setRedirectUrl(redirectUrl)
          .resolveAbsoluteRuleUrl(nextChapterUrl);
        if (absNext === absChapterNext) break;
      }
      visited.add(next);
      const nextRes = await new AnalyzeUrl({
        mUrl: next,
        baseUrl: source.bookSourceUrl,
        source,
        host,
        logs,
        ruleVariables: variables,
        webJs: rule.webJs?.trim() || undefined,
        sourceRegex: rule.sourceRegex?.trim() || undefined,
      }).getStrResponse();
      const page = await fetchContentPage(
        source,
        host,
        logs,
        rule,
        nextRes.body,
        nextRes.url,
        nextRes.url,
        { ...book, bookUrl: bookPageUrl, tocUrl: resolvedTocUrl },
        chapter,
        variables,
        nextChapterUrl,
        true,
      );
      contentParts.push(page.content);
      next = page.nextUrls[0] ?? "";
    }
  } else if (first.nextUrls.length > 1) {
    const responses = await ajaxAllStrResponses(host, first.nextUrls);
    for (const resp of responses) {
      const pageBody = resp.body();
      const pageUrl = resp.url();
      if (!pageBody) continue;
      const page = await fetchContentPage(
        source,
        host,
        logs,
        rule,
        pageBody,
        pageUrl,
        pageUrl,
        { ...book, bookUrl: bookPageUrl, tocUrl: resolvedTocUrl },
        chapter,
        variables,
        nextChapterUrl,
        false,
      );
      contentParts.push(page.content);
    }
  }

  let content = contentParts.filter(Boolean).join("\n");
  const ar = new AnalyzeRule(source, logs, host)
    .setContent(body, res.url)
    .setRedirectUrl(redirectUrl)
    .setBook(book)
    .setChapter(chapter)
    .setNextChapterUrl(nextChapterUrl);

  if (rule.subContent?.trim()) {
    try {
      const raw = await ar.getString(rule.subContent, body);
      if (raw.trim()) {
        let sub = raw.trim();
        if (/^https?:\/\//i.test(sub)) {
          const subRes = await new AnalyzeUrl({
            mUrl: sub,
            baseUrl: source.bookSourceUrl,
            source,
            host,
            logs,
          }).getStrResponse();
          sub = subRes.body;
        }
        if (sub.trim()) {
          content = content ? `${content}\n\n${sub.trim()}` : sub.trim();
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      host.log(`获取副文出错: ${msg}`);
    }
  }

  if (rule.replaceRegex?.trim()) {
    content = await applyContentReplaceRegex(ar, content, rule.replaceRegex);
  }

  if (titleRule) {
    try {
      const t = await ar.getString(titleRule, body);
      if (t.trim()) {
        chapter.title = t.trim();
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      host.log(`获取标题出错: ${msg}`);
    }
  }

  // 对齐 Legado ContentProcessor：去掉正文开头与章节名重复的标题行
  content = stripLeadingDuplicateChapterTitle(
    content,
    String(chapter.title ?? ""),
    String(book.name ?? ""),
  );

  return content.trim();
}

/**
 * Legado ContentProcessor「去除重复标题」：正文开头与章节名重复的一行。
 * 离线缓存读取路径也会调用，避免旧缓存仍带标题。
 */
export function stripLeadingDuplicateChapterTitle(
  content: string,
  chapterTitle: string,
  bookName = "",
): string {
  const title = chapterTitle.trim();
  if (!title || !content || content === "null") return content;
  try {
    const escapeRegex = (s: string) =>
      s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const titlePat = escapeRegex(title).replace(/\s+/g, "\\s*");
    const namePat = bookName.trim() ? escapeRegex(bookName.trim()) : "";
    const prefix = namePat
      ? `^(?:\\s|\\p{P}|${namePat})*${titlePat}\\s*`
      : `^(?:\\s|\\p{P})*${titlePat}\\s*`;
    return content.replace(new RegExp(prefix, "u"), "");
  } catch {
    return content;
  }
}

/** 对齐 Legado `String.isTrue()`：非空且非 false/no/not/0 */
function isTruthy(s: string): boolean {
  const v = s.trim().toLowerCase();
  if (!v) return false;
  return v !== "false" && v !== "no" && v !== "not" && v !== "0";
}
