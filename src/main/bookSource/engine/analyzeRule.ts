import * as cheerio from "cheerio";
import { JSONPath } from "jsonpath-plus";
import type { BookSourceRecord } from "@shared/bookSource/types";
import { normalizeBookSourceBaseUrl, resolveAbsoluteUrl } from "@shared/bookSource/url";
import { createJsExtensionHost, type JsExtensionHost } from "./jsExtensions";
import { selectXPath } from "./htmlXPath";
import {
  applyRuleRegex as applyRuleRegexImpl,
  elementsToHtmlList,
  extractFromElement,
  extractFromContentRoot,
  isLegadoExtractType,
  isLegadoAttrExtract,
  hasLegadoSegmentIndex,
  loadCheerioHtml,
  parseLegadoResultExtract,
  parseLegadoSelectorSegment,
  pickElements,
  pickLegadoResultByIndex,
  queryLegadoSelectorSegment,
  splitRuleRegexSuffix,
  trimLegadoRulePreservingRegexReplace,
  normalizeTagListTextRule,
  extractIndexedSpanTextFromListItems,
  extractTagListLabelsFromHtml,
  isTagListTextRule,
  isTagListContainerTextRule,
  tagListContainerTextFromHtml,
  legadoCollectResultTexts,
  legadoJoinResultTexts,
  type RuleRegexSuffix,
} from "./legadoDefaultRule";
import {
  isLegadoAttrSelectorSegment,
  queryLegadoAttrSelector,
} from "./legadoAttrSelector";
import { cheerioToJsoupList } from "./legadoJsoupShim";
import {
  looksLikeLegadoRegexRule,
  parseRegexRuleList,
  regexGetElement,
  regexGetElements,
} from "./analyzeByRegex";
import { isVerificationCancelled } from "./sourceVerification";
import { evalJs, evalJsAsync, evalJsExpression } from "./rhinoRuntime";
import { legadoJsList } from "./legadoJsList";
import {
  isLegadoJsRule,
  looksLikeLegadoJs,
  shouldSplitOrAlternatives,
  splitLegadoCompoundRule,
  splitSourceRule,
  stripLegadoJsRuleMarkers,
  wrapLegadoJsRule,
} from "./legadoRuleSplit";
import {
  expandLegadoGetRefs,
  isLegadoTemplateOnlyRule,
  isPureMustacheTemplateRule,
  legadoTemplateNeedsJsEval,
  legadoJsonPathFromRule,
  coerceLegadoMediaUrl,
  isPlainRuleObject,
  parsePutMapFromRule,
  parseLegadoPureGetKey,
  readJsonField,
  readJsonNestedValue,
  sourceVariableCacheKey,
  extractUrlFetchOptionsSuffix,
  splitUrlAndRuleVariables,
} from "./legadoCompositeRule";
import { getCacheValue } from "../store/bookSourceStore";
import { runBackstageWebView, stripWebJsRule } from "./backstageWebView";
import type { LegadoVariableSync } from "./legadoRuleEntity";
import { coerceJavaString } from "./legadoJavaShims";

export {
  isLegadoJsRule,
  looksLikeLegadoJs,
  shouldSplitOrAlternatives,
  splitSourceRule,
  stripLegadoJsRuleMarkers,
} from "./legadoRuleSplit";

export type RuleData = {
  variable?: Record<string, string>;
  [key: string]: unknown;
};

type AnalyzeMode = "default" | "json" | "xpath" | "js" | "webJs" | "regex" | "template";

function coerceLegadoRuleString(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    // 对齐 Legado：列表用换行拼接（勿用逗号，否则 URL 数组 / tagList 会被拆坏）
    return value
      .map((v) => coerceLegadoMediaUrl(v))
      .filter(Boolean)
      .join("\n");
  }
  if (typeof value === "object") {
    const s = coerceJavaString(value).trim();
    if (s && s !== "[object Object]") return s;
  }
  return "";
}

export class AnalyzeRule {
  private content: unknown = "";
  private baseUrl = "";
  private redirectUrl = "";
  private ruleUrlCtx = "";
  private requestUrlCtx = "";
  private source?: BookSourceRecord;
  private book?: Record<string, unknown>;
  private chapter?: Record<string, unknown>;
  private nextChapterUrl = "";
  private ruleData: RuleData = {};
  private contentIsJson = false;
  /** 规则链起始上下文（搜索/发现列表项），供 @js 内 {{$.}} 展开 */
  private chainItemContext: unknown = undefined;
  private host: JsExtensionHost;

  constructor(
    source?: BookSourceRecord,
    _logs: string[] = [],
    host?: JsExtensionHost,
  ) {
    this.source = source;
    this.host = host ?? createJsExtensionHost(source ?? emptySource(), _logs);
  }

  setContent(content: unknown, baseUrl = ""): this {
    this.content = content;
    this.baseUrl = baseUrl;
    this.contentIsJson = isLegadoJsonContent(content);
    if (!this.redirectUrl) this.redirectUrl = baseUrl;
    return this;
  }

  setRedirectUrl(url: string): this {
    this.redirectUrl = url || this.baseUrl;
    return this;
  }

  setRequestContext(ruleUrl: string, requestUrl: string): this {
    this.ruleUrlCtx = ruleUrl;
    this.requestUrlCtx = requestUrl;
    return this;
  }

  setBook(book: Record<string, unknown>): this {
    this.book = book;
    return this;
  }

  setChapter(chapter: Record<string, unknown>): this {
    this.chapter = chapter;
    return this;
  }

  setNextChapterUrl(url: string | undefined | null): this {
    this.nextChapterUrl = String(url ?? "").trim();
    return this;
  }

  /**
   * 对齐 Legado `AnalyzeRule.evalJS`（购买 `payAction`、自定义脚本等）。
   * 与规则链 `evalRuleJs` 不同：不回退整页正文，错误向上抛出。
   */
  async evalJS(jsStr: string, result: unknown = null): Promise<unknown> {
    const script = stripLegadoJsRuleMarkers(jsStr);
    const title =
      this.chapter && typeof this.chapter.title === "string"
        ? this.chapter.title
        : "";
    const prefixes: string[] = [`var title=${JSON.stringify(title)};`];
    if (this.nextChapterUrl) {
      prefixes.push(
        `var nextChapterUrl=${JSON.stringify(this.nextChapterUrl)};`,
      );
    }
    return await evalJsAsync(
      `${prefixes.join("\n")}\n${script}`,
      this.buildJsEvalContext(result),
    );
  }

  setRuleData(data: RuleData): this {
    this.ruleData = data;
    return this;
  }

  get currentContent(): unknown {
    return this.content;
  }

  get currentBaseUrl(): string {
    return this.baseUrl;
  }

  get sourceRecord(): BookSourceRecord | undefined {
    return this.source;
  }

  get bookRecord(): Record<string, unknown> | undefined {
    return this.book;
  }

  get chapterRecord(): Record<string, unknown> | undefined {
    return this.chapter;
  }

  get extensionHost(): JsExtensionHost {
    return this.host;
  }

  /** 搜索/发现/目录等通用规则解析（不含详情页 {{}} 复合模板） */
  async getPlainString(
    rule: string | undefined | null,
    mContent?: unknown,
  ): Promise<string> {
    const normalized = trimLegadoRulePreservingRegexReplace(rule ?? "");
    if (normalized && isTagListTextRule(normalized)) {
      const content = mContent ?? this.content;
      const html = typeof content === "string" ? content : String(content ?? "");
      const { regex } = splitRuleRegexSuffix(normalized);
      let tags = "";
      if (isTagListContainerTextRule(normalized)) {
        tags = tagListContainerTextFromHtml(html);
      } else {
        const tagRule = normalizeTagListTextRule(normalized) ?? normalized;
        tags = legadoJoinResultTexts(legadoCollectResultTexts(html, tagRule)).trim();
        if (!tags) tags = extractTagListLabelsFromHtml(html).trim();
      }
      if (tags) {
        return regex ? this.applyRuleRegex(tags, regex).trim() : tags;
      }
    }
    return this.getString(rule, mContent);
  }

  lookupStored(key: string): string {
    return this.lookupStoredValue(key);
  }

  buildRuleJavaBindings(ruleContext?: unknown): Record<string, unknown> {
    return this.buildRuleJava(ruleContext);
  }

  async applyPutMapFromRule(rule: string, content: unknown): Promise<void> {
    const { putMap } = parsePutMapFromRule(rule);
    for (const [key, fieldRule] of Object.entries(putMap)) {
      const val = isPlainRuleObject(content)
        ? readJsonField(content, fieldRule)
        : await this.getString(fieldRule, content);
      this.putStored(key, val);
    }
  }

  private async evalPutMap(
    putMap: Record<string, string>,
    mContent?: unknown,
  ): Promise<void> {
    for (const [key, fieldRule] of Object.entries(putMap)) {
      const { baseRule, regex } = splitRuleRegexSuffix(fieldRule);
      const { working: normalized } = await this.normalizeRuleInput(baseRule, mContent);
      let s = await this.getStringChain(normalized, mContent);
      if (s && regex) s = this.applyRuleRegex(s, regex);
      this.putStored(key, s);
    }
  }

  /** Legado splitPutRule + putRule：getOne/getElement 前先执行 @put */
  private async applyPutPrefixRule(
    rule: string,
    content: unknown,
  ): Promise<{ rule: string; content: unknown }> {
    const { cleanRule, putMap } = parsePutMapFromRule(rule);
    if (Object.keys(putMap).length > 0) {
      await this.evalPutMap(putMap, content);
    }
    return { rule: cleanRule.trim(), content };
  }

  private evalPutMapSync(
    putMap: Record<string, string>,
    mContent?: unknown,
  ): void {
    for (const [key, fieldRule] of Object.entries(putMap)) {
      const { baseRule, regex } = splitRuleRegexSuffix(fieldRule);
      let s = this.getStringChainSync(baseRule, mContent);
      if (s && regex) s = this.applyRuleRegex(s, regex);
      this.putStored(key, s);
    }
  }

  private applyPutPrefixRuleSync(
    rule: string,
    content: unknown,
  ): { rule: string; content: unknown } {
    const { cleanRule, putMap } = parsePutMapFromRule(rule);
    if (Object.keys(putMap).length > 0) {
      this.evalPutMapSync(putMap, content);
    }
    return { rule: cleanRule.trim(), content };
  }

  private async normalizeRuleInput(
    rule: string,
    mContent?: unknown,
  ): Promise<{ working: string; pureGet: boolean }> {
    const { cleanRule, putMap } = parsePutMapFromRule(rule);
    await this.evalPutMap(putMap, mContent);
    const getKey = parseLegadoPureGetKey(cleanRule);
    if (getKey) {
      return { working: this.lookupStoredValue(getKey), pureGet: true };
    }
    return {
      working: expandLegadoGetRefs(cleanRule, (k) => this.lookupStoredValue(k)),
      pureGet: false,
    };
  }

  private async applyPutFromFullRule(
    rule: string,
    mContent?: unknown,
  ): Promise<string> {
    const normalized = trimLegadoRulePreservingRegexReplace(rule);
    const { cleanRule, putMap } = parsePutMapFromRule(normalized);
    if (Object.keys(putMap).length > 0) {
      await this.evalPutMap(putMap, mContent);
    }
    const kept = trimLegadoRulePreservingRegexReplace(cleanRule);
    return kept || normalized;
  }

  private applyPutFromFullRuleSync(rule: string, mContent?: unknown): string {
    const normalized = trimLegadoRulePreservingRegexReplace(rule);
    const { cleanRule, putMap } = parsePutMapFromRule(normalized);
    if (Object.keys(putMap).length > 0) {
      this.evalPutMapSync(putMap, mContent);
    }
    const kept = trimLegadoRulePreservingRegexReplace(cleanRule);
    return kept || normalized;
  }

  async getString(rule: string | undefined | null, mContent?: unknown): Promise<string> {
    if (!rule?.trim()) return "";
    const parseRule = await this.applyPutFromFullRule(rule, mContent);
    // 对齐 Legado：先按 @js/<js> 切段，再对各段做 ##（勿先拆 ## 以免把 @js 吃进 replacement）
    if (/(?:@js:|<js>|@webjs:)/i.test(parseRule)) {
      return (await this.getStringChain(parseRule, mContent)).trim();
    }
    // ## 作用于整条 a||b||c；须先拆 ## 再按 || 取首个非空
    const { baseRule: orBase, regex: orRegex } = splitRuleRegexSuffix(parseRule);
    if (shouldSplitOrAlternatives(orBase)) {
      for (const alt of orBase.split("||").map((s) => s.trim()).filter(Boolean)) {
        let v = await this.getString(alt, mContent);
        if (v) {
          if (orRegex) v = this.applyRuleRegex(v, orRegex);
          return v.trim();
        }
      }
      return "";
    }
    const { baseRule, regex } = splitRuleRegexSuffix(parseRule);
    const { working, pureGet } = await this.normalizeRuleInput(baseRule, mContent);
    if (pureGet) {
      let s = working;
      if (regex) s = this.applyRuleRegex(s, regex);
      return s.trim();
    }
    if (isLegadoTemplateOnlyRule(working)) {
      const expanded = expandLegadoTemplateRule(working, mContent ?? this.content).trim();
      return regex ? this.applyRuleRegex(expanded, regex).trim() : expanded;
    }
    const jsonCompound = await this.resolveJsonCompoundString(working, mContent, regex);
    if (jsonCompound != null) return jsonCompound;
    let s = await this.getStringChain(working, mContent);
    if (regex) s = this.applyRuleRegex(s, regex);
    return s.trim();
  }

  /** Legado getStringList：&& 分段取多个 tag，|| 取首个非空段 */
  async getStringList(
    rule: string | undefined | null,
    mContent?: unknown,
  ): Promise<string[]> {
    if (!rule?.trim()) return [];
    const content = mContent ?? this.content;
    const parseRule = await this.applyPutFromFullRule(rule, content);
    // 对齐 Legado：含 @js 时整条走规则链（段内 ## 由 getOne 处理）
    if (/(?:@js:|<js>|@webjs:)/i.test(parseRule)) {
      const prevChain = this.chainItemContext;
      this.chainItemContext = content;
      try {
        const rules = splitSourceRule(parseRule);
        let result: unknown = content;
        for (const r of rules) {
          result = await this.evalStringChainSegment(r, result);
        }
        if (Array.isArray(result)) {
          return result
            .flatMap((v) => {
              if (v == null) return [];
              if (Array.isArray(v)) {
                return v.map((x) => String(x ?? "").trim()).filter(Boolean);
              }
              const s = String(v).trim();
              return s ? [s] : [];
            })
            .filter(Boolean);
        }
        const s = coerceLegadoRuleString(result);
        return s ? splitStringListLines(s) : [];
      } finally {
        this.chainItemContext = prevChain;
      }
    }

    if (shouldSplitOrAlternatives(parseRule)) {
      for (const alt of parseRule.split("||").map((s) => s.trim()).filter(Boolean)) {
        const list = await this.getStringList(alt, content);
        if (list.length) return list;
      }
      return [];
    }

    const { baseRule, regex } = splitRuleRegexSuffix(parseRule);

    if (isLegadoTemplateOnlyRule(baseRule)) {
      const s = expandLegadoTemplateRule(baseRule, content).trim();
      const v = regex ? this.applyRuleRegex(s, regex) : s;
      return v ? splitStringListLines(v) : [];
    }

    const { parts, joiner } = splitLegadoCompoundRule(baseRule);
    if (parts.length > 1) {
      const out: string[] = [];
      for (const part of parts) {
        if (joiner === "||") {
          const seg = await this.getStringList(part, content);
          if (seg.length) {
            out.push(...seg);
            break;
          }
          continue;
        }
        out.push(...(await this.getStringList(part, content)));
      }
      if (!out.length) return [];
      if (regex) {
        return out.map((s) => this.applyRuleRegex(s, regex).trim()).filter(Boolean);
      }
      return out;
    }

    const multi = this.byLegadoDefaultExtractAll(baseRule, content);
    if (multi.length) {
      return multi
        .map((s) => (regex ? this.applyRuleRegex(s, regex) : s))
        .filter(Boolean);
    }

    if (isJsonItemContent(content)) {
      const jsonList = jsonPathToLegadoStringList(baseRule, content);
      if (jsonList.length) {
        return jsonList
          .map((s) => (regex ? this.applyRuleRegex(s, regex).trim() : s.trim()))
          .filter(Boolean);
      }
    }

    const s = await this.getStringChain(baseRule, content);
    if (!s) return [];
    const v = regex ? this.applyRuleRegex(s, regex) : s;
    return splitStringListLines(v);
  }

  /** Legado/Rhino：规则 JS 中 java.getStringList 为同步 API */
  getStringListSync(
    rule: string | undefined | null,
    mContent?: unknown,
  ): string[] {
    if (!rule?.trim()) return [];
    const content = mContent ?? this.content;
    const parseRule = this.applyPutFromFullRuleSync(rule, content);
    if (/(?:@js:|<js>|@webjs:)/i.test(parseRule)) {
      const prevChain = this.chainItemContext;
      this.chainItemContext = content;
      try {
        const rules = splitSourceRule(parseRule);
        let result: unknown = content;
        for (const r of rules) {
          result = this.evalStringChainSegmentSync(r, result);
        }
        if (Array.isArray(result)) {
          return result
            .flatMap((v) => {
              if (v == null) return [];
              if (Array.isArray(v)) {
                return v.map((x) => String(x ?? "").trim()).filter(Boolean);
              }
              const s = String(v).trim();
              return s ? [s] : [];
            })
            .filter(Boolean);
        }
        const s = coerceLegadoRuleString(result);
        return s ? splitStringListLines(s) : [];
      } finally {
        this.chainItemContext = prevChain;
      }
    }

    if (shouldSplitOrAlternatives(parseRule)) {
      for (const alt of parseRule.split("||").map((s) => s.trim()).filter(Boolean)) {
        const list = this.getStringListSync(alt, content);
        if (list.length) return list;
      }
      return [];
    }

    const { baseRule, regex } = splitRuleRegexSuffix(parseRule);

    if (isLegadoTemplateOnlyRule(baseRule)) {
      const s = expandLegadoTemplateRule(baseRule, content).trim();
      const v = regex ? this.applyRuleRegex(s, regex) : s;
      return v ? splitStringListLines(v) : [];
    }

    const { parts, joiner } = splitLegadoCompoundRule(baseRule);
    if (parts.length > 1) {
      const out: string[] = [];
      for (const part of parts) {
        if (joiner === "||") {
          const seg = this.getStringListSync(part, content);
          if (seg.length) {
            out.push(...seg);
            break;
          }
          continue;
        }
        out.push(...this.getStringListSync(part, content));
      }
      if (!out.length) return [];
      if (regex) {
        return out.map((s) => this.applyRuleRegex(s, regex).trim()).filter(Boolean);
      }
      return out;
    }

    const multi = this.byLegadoDefaultExtractAll(baseRule, content);
    if (multi.length) {
      return multi
        .map((s) => (regex ? this.applyRuleRegex(s, regex) : s))
        .filter(Boolean);
    }

    if (isJsonItemContent(content)) {
      const jsonList = jsonPathToLegadoStringList(baseRule, content);
      if (jsonList.length) {
        return jsonList
          .map((s) => (regex ? this.applyRuleRegex(s, regex).trim() : s.trim()))
          .filter(Boolean);
      }
    }

    const s = this.getStringChainSync(baseRule, content);
    if (!s) return [];
    const v = regex ? this.applyRuleRegex(s, regex) : s;
    return splitStringListLines(v);
  }

  private async evalStringChainSegment(
    segment: string,
    content: unknown,
  ): Promise<unknown> {
    const t = segment.trim();
    if (!t.includes("||") || /^@js:/i.test(t) || /^<js>/i.test(t)) {
      return this.getOne(t, content);
    }
    const outsideTemplate = t.replace(/\{\{[\s\S]*?\}\}/g, "");
    if (!outsideTemplate.includes("||")) {
      return this.getOne(t, content);
    }
    for (const alt of t.split("||").map((s) => s.trim()).filter(Boolean)) {
      const v = await this.getOne(alt, content);
      if (v != null && v !== "") return v;
    }
    return "";
  }

  private evalStringChainSegmentSync(segment: string, content: unknown): unknown {
    const t = segment.trim();
    if (!t.includes("||") || /^@js:/i.test(t) || /^<js>/i.test(t)) {
      return this.getOneSync(t, content);
    }
    const outsideTemplate = t.replace(/\{\{[\s\S]*?\}\}/g, "");
    if (!outsideTemplate.includes("||")) {
      return this.getOneSync(t, content);
    }
    for (const alt of t.split("||").map((s) => s.trim()).filter(Boolean)) {
      const v = this.getOneSync(alt, content);
      if (v != null && v !== "") return v;
    }
    return "";
  }

  private async getStringChain(
    rule: string,
    mContent?: unknown,
  ): Promise<string> {
    const prevChain = this.chainItemContext;
    this.chainItemContext = mContent ?? this.content;
    try {
      const rules = splitSourceRule(rule);
      let result: unknown = mContent ?? this.content;
      // 空串不打断：后续 @js 可用 baseUrl 兜底
      for (const r of rules) {
        result = await this.evalStringChainSegment(r, result);
      }
      return coerceLegadoRuleString(result);
    } finally {
      this.chainItemContext = prevChain;
    }
  }

  private getStringChainSync(rule: string, mContent?: unknown): string {
    const prevChain = this.chainItemContext;
    this.chainItemContext = mContent ?? this.content;
    try {
      const rules = splitSourceRule(rule);
      let result: unknown = mContent ?? this.content;
      for (const r of rules) {
        result = this.evalStringChainSegmentSync(r, result);
      }
      return coerceLegadoRuleString(result);
    } finally {
      this.chainItemContext = prevChain;
    }
  }

  async getElements(rule: string | undefined | null, mContent?: unknown): Promise<unknown[]> {
    if (!rule?.trim()) return [];
    if (shouldSplitOrAlternatives(rule)) {
      for (const alt of rule.split("||").map((s) => s.trim()).filter(Boolean)) {
        const els = await this.getElements(alt, mContent);
        if (els.length) return els;
      }
      return [];
    }
    const rules = splitSourceRule(rule);
    let result: unknown = mContent ?? this.content;
    for (let i = 0; i < rules.length; i++) {
      const r = rules[i]!;
      const nextIsJs =
        i + 1 < rules.length && isLegadoJsRule(rules[i + 1]!);
      result = await this.getOne(r, result, true);
      if (
        !nextIsJs &&
        (result == null ||
          result === "" ||
          (Array.isArray(result) && result.length === 0))
      ) {
        break;
      }
    }
    if (Array.isArray(result)) return result;
    if (result == null || result === "") return [];
    return [result];
  }

  /** Legado/Rhino：规则 JS 中 java.getElements 为同步 API */
  getElementsSync(rule: string | undefined | null, mContent?: unknown): unknown[] {
    if (!rule?.trim()) return [];
    if (shouldSplitOrAlternatives(rule)) {
      for (const alt of rule.split("||").map((s) => s.trim()).filter(Boolean)) {
        const els = this.getElementsSync(alt, mContent);
        if (els.length) return els;
      }
      return [];
    }
    const rules = splitSourceRule(rule);
    let result: unknown = mContent ?? this.content;
    for (let i = 0; i < rules.length; i++) {
      const r = rules[i]!;
      const nextIsJs =
        i + 1 < rules.length && isLegadoJsRule(rules[i + 1]!);
      result = this.getOneSync(r, result, true);
      if (
        !nextIsJs &&
        (result == null ||
          result === "" ||
          (Array.isArray(result) && result.length === 0))
      ) {
        break;
      }
    }
    if (Array.isArray(result)) return result;
    if (result == null || result === "") return [];
    return [result];
  }

  /** Legado 规则 JS：java.getElement(selector) */
  getElementForJs(ruleStr: string): unknown[] {
    try {
      const html = String(this.content ?? "");
      const out = this.byLegadoDefault(ruleStr.trim(), html, true);
      if (Array.isArray(out)) return out;
      if (out == null || out === "") return [];
      return [out];
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.host.log(`getElement 规则错误: ${msg}`);
      return [];
    }
  }

  async getElement(
    rule: string | undefined | null,
    mContent?: unknown,
  ): Promise<unknown> {
    if (!rule?.trim()) return null;
    const rules = splitSourceRule(rule);
    let result: unknown = mContent ?? this.content;
    for (const r of rules) {
      result = await this.getOne(r, result);
      if (result == null || result === "") return null;
    }
    return result;
  }

  private readBookVariable(key: string): string {
    if (!this.book) return "";
    const raw = this.book.variable;
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      const v = (raw as Record<string, unknown>)[key];
      if (typeof v === "string" && v) return v;
    }
    if (typeof raw === "string" && raw.trim()) {
      try {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        const v = parsed[key];
        if (typeof v === "string" && v) return v;
      } catch {
        /* ignore invalid book.variable JSON */
      }
    }
    return "";
  }

  private lookupStoredValue(key: string): string {
    const fromBook = this.readBookVariable(key);
    if (fromBook) return fromBook;
    const vars = this.ruleData.variable ?? {};
    if (vars[key]) return vars[key]!;
    const sourceUrl = this.source?.bookSourceUrl;
    if (sourceUrl) {
      const cached = getCacheValue(
        sourceUrl,
        sourceVariableCacheKey(sourceUrl, key),
      );
      if (cached) return cached;
    }
    const fromLogin = this.host.sourceWrapper.getLoginInfo as
      | (() => Record<string, string>)
      | undefined;
    const login = fromLogin?.() ?? {};
    if (login[key]) return login[key]!;
    // 须在 cache / put 之后：否则 java.put('url', tocUrl) 会被 baseUrl 盖掉，Lofter nextTocUrl 无法分页
    if (key === "url") return this.requestUrlCtx || this.baseUrl;
    if (key === "bookName" && this.book?.name) return String(this.book.name);
    if (key === "title" && this.chapter?.title) return String(this.chapter.title);
    return "";
  }

  getStored(key: string): string {
    return this.lookupStoredValue(key);
  }

  /** 展开 ## 替换段中的 {{title}} / {{book.name}} 等（对齐 Legado SourceRule.makeUpRule） */
  private expandRuleRegexTemplates(regex: RuleRegexSuffix): RuleRegexSuffix {
    const expand = (text: string): string =>
      text
        .replace(/\{\{([\s\S]*?)\}\}/g, (_, expr: string) =>
          this.expandRegexTemplateExpr(String(expr).trim()),
        )
        .replace(/@get:\{([^}]+)\}/gi, (_, key: string) =>
          this.getStored(String(key).trim()),
        );
    return {
      pattern: expand(regex.pattern),
      replacement: expand(regex.replacement ?? ""),
      replaceFirst: regex.replaceFirst,
    };
  }

  private expandRegexTemplateExpr(expr: string): string {
    if (!expr) return "";
    if (expr === "title") return this.getStored("title");
    if (expr === "bookName" || expr === "book.name") {
      return this.getStored("bookName") || String(this.book?.name ?? "");
    }
    if (expr === "book.author") return String(this.book?.author ?? "");
    if (expr === "result") return String(this.content ?? "");
    return this.getStored(expr);
  }

  /** ##正则##替换：先展开 {{}} 再应用 */
  private applyRuleRegex(value: string, regex?: RuleRegexSuffix): string {
    if (!regex?.pattern) return value;
    return applyRuleRegexImpl(value, this.expandRuleRegexTemplates(regex));
  }

  putStored(key: string, value: unknown): string {
    const s = String(value ?? "");
    if (!this.ruleData.variable) this.ruleData.variable = {};
    this.ruleData.variable[key] = s;
    (this.host.javaBindings.put as ((k: string, v: unknown) => string) | undefined)?.(
      key,
      s,
    );
    return s;
  }

  private writeEntityVariable(
    target: Record<string, unknown> | undefined,
    key: string,
    value: string,
  ): void {
    if (!target) return;
    let variable = target.variable;
    if (!variable || typeof variable !== "object" || Array.isArray(variable)) {
      variable = {};
      target.variable = variable;
    }
    (variable as Record<string, string>)[key] = value;
  }

  private putBookVariable(key: string, value: string): void {
    this.putStored(key, value);
    this.writeEntityVariable(this.book, key, value);
  }

  private putChapterVariable(key: string, value: string): void {
    this.putStored(key, value);
    this.writeEntityVariable(this.chapter, key, value);
  }

  private readChapterVariable(key: string): string {
    if (!this.chapter) return "";
    const raw = this.chapter.variable;
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      const v = (raw as Record<string, unknown>)[key];
      if (typeof v === "string" && v) return v;
    }
    if (typeof raw === "string" && raw.trim()) {
      try {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        const v = parsed[key];
        if (typeof v === "string" && v) return v;
      } catch {
        /* ignore */
      }
    }
    return "";
  }

  private buildJsEvalContext(content: unknown): {
    source: BookSourceRecord | undefined;
    book: Record<string, unknown> | undefined;
    chapter: Record<string, unknown> | undefined;
    result: unknown;
    src: unknown;
    baseUrl: string;
    host: JsExtensionHost;
    java: Record<string, unknown>;
    bookVariableSync: LegadoVariableSync;
    chapterVariableSync: LegadoVariableSync;
  } {
    return {
      source: this.source,
      book: this.book,
      chapter: this.chapter,
      result: content,
      src: this.content,
      baseUrl: this.baseUrl,
      host: this.host,
      // 对齐 Legado：java.getString 默认读 AnalyzeRule.content（src），不是链式 result
      java: this.buildRuleJava(),
      bookVariableSync: {
        putVariable: (key, value) => this.putBookVariable(key, value),
        getVariable: (key) => this.readBookVariable(key),
      },
      chapterVariableSync: {
        putVariable: (key, value) => this.putChapterVariable(key, value),
        getVariable: (key) => this.readChapterVariable(key),
      },
    };
  }

  /** JSON 上 `$.a&&$.b##regex##repl`：合并多段 JsonPath 后再做正则（七猫 intro 标签行） */
  private resolveJsonCompoundStringSync(
    baseRule: string,
    content: unknown,
    regex?: ReturnType<typeof splitRuleRegexSuffix>["regex"],
  ): string | null {
    if (!isJsonItemContent(content)) return null;
    // `a||b <js>strip</js>`：须走规则链，避免 || 短路后跳过 JS 再套 ##（Lofter 章节名）
    if (splitSourceRule(baseRule).length > 1) return null;
    const { parts, joiner } = splitLegadoCompoundRule(baseRule);
    if (parts.length <= 1) return null;

    if (joiner === "||") {
      for (const part of parts) {
        const list = this.getStringListSync(part, content);
        if (list.length) {
          // Legado AnalyzeByJSonPath.getString：List 与 && 段均用 \n 拼接，再由 ##・|\s##， 统一为全角逗号
          let s = list.join("\n");
          if (regex) s = this.applyRuleRegex(s, regex);
          return s.trim();
        }
      }
      return "";
    }

    const segments: string[] = [];
    for (const part of parts) {
      const list = this.getStringListSync(part, content);
      if (list.length) segments.push(list.join("\n"));
    }
    if (!segments.length) return "";
    let s = segments.join("\n");
    if (regex) s = this.applyRuleRegex(s, regex);
    return s.trim();
  }

  private async resolveJsonCompoundString(
    baseRule: string,
    mContent: unknown | undefined,
    regex?: ReturnType<typeof splitRuleRegexSuffix>["regex"],
  ): Promise<string | null> {
    const content = mContent ?? this.content;
    if (!isJsonItemContent(content)) return null;
    if (splitSourceRule(baseRule).length > 1) return null;
    const { parts, joiner } = splitLegadoCompoundRule(baseRule);
    if (parts.length <= 1) return null;

    if (joiner === "||") {
      for (const part of parts) {
        const list = await this.getStringList(part, content);
        if (list.length) {
          let s = list.join("\n");
          if (regex) s = this.applyRuleRegex(s, regex);
          return s.trim();
        }
      }
      return "";
    }

    const segments: string[] = [];
    for (const part of parts) {
      const list = await this.getStringList(part, content);
      if (list.length) segments.push(list.join("\n"));
    }
    if (!segments.length) return "";
    let s = segments.join("\n");
    if (regex) s = this.applyRuleRegex(s, regex);
    return s.trim();
  }

  /** 规则 JS 内 java.getString / getStringList 未传 content 时的默认上下文（列表项优先于整页） */
  private javaRuleContent(content?: unknown, ruleContext?: unknown): unknown {
    if (content !== undefined) return content;
    if (ruleContext !== undefined) return ruleContext;
    if (this.chainItemContext !== undefined) return this.chainItemContext;
    return this.content;
  }

  ruleJavaGetString(ruleStr: string, content?: unknown, ruleContext?: unknown): string {
    let c: unknown = this.javaRuleContent(content, ruleContext);
    const rawRule = String(ruleStr ?? "").trim();
    if (!rawRule) return "";

    if (typeof c === "string") {
      const t = c.trim();
      if (t.startsWith("{") || t.startsWith("[")) {
        try {
          c = JSON.parse(t);
        } catch {
          // 非整段 JSON：按 HTML/文本选择器解析（对齐 Legado AnalyzeRule.getString）
          return this.getStringChainSync(rawRule, c);
        }
      } else {
        // HTML 整页等：必须跑选择器，不能把正文原样返回（否则 kind 会被拆成一堆标签）
        return this.getStringChainSync(rawRule, c);
      }
    }

    const { baseRule, regex } = splitRuleRegexSuffix(rawRule);
    const compound = this.resolveJsonCompoundStringSync(baseRule, c, regex);
    if (compound != null) return compound;
    const field = baseRule.trim();
    if (field.startsWith("$.") || field.startsWith("$[")) {
      let val = jsonPathFromContent(field, c);
      if (regex) val = this.applyRuleRegex(val, regex);
      return val;
    }
    if (isPlainRuleObject(c) && /^[\w.]+$/.test(field)) {
      let val = readJsonField(c, field);
      if (regex) val = this.applyRuleRegex(val, regex);
      return val;
    }
    // 元素节点等：走与 getString 同步路径相同的选择器解析
    if (c != null && typeof c === "object") {
      return this.getStringChainSync(rawRule, c);
    }
    return String(c ?? "");
  }

  buildRuleJava(ruleContext?: unknown): Record<string, unknown> {
    const rule = this;
    const baseAjax = this.host.javaBindings.ajax as (
      url: unknown,
    ) => Promise<string>;
    const ctx = (content?: unknown) => rule.javaRuleContent(content, ruleContext);
    return {
      ...this.host.javaBindings,
      ruleUrl: this.ruleUrlCtx,
      url: this.requestUrlCtx || this.baseUrl,
      get: (key: string) => rule.lookupStoredValue(key),
      put: (key: string, value: unknown) => rule.putStored(key, value),
      getString: (ruleStr: string, content?: unknown) =>
        rule.ruleJavaGetString(ruleStr, content, ruleContext),
      getStringList: (ruleStr: string, content?: unknown) =>
        legadoJsList(rule.getStringListSync(ruleStr, ctx(content))),
      getElements: (ruleStr: string, content?: unknown) =>
        legadoJsList(rule.getElementsSync(ruleStr, ctx(content))),
      getElement: (sel: string) => rule.getElementForJs(sel),
      setContent: (content: unknown, baseUrl?: string) => {
        rule.setContent(content, baseUrl ?? rule.baseUrl);
        return rule;
      },
      ajax: async (url: unknown) => {
        const body = await baseAjax(url);
        if (body != null && body !== "") {
          rule.setContent(body, rule.baseUrl);
        }
        return body;
      },
    };
  }

  private async getOne(rule: string, content: unknown, list = false): Promise<unknown> {
    const trimmed = trimLegadoRulePreservingRegexReplace(rule);
    if (!trimmed) return content;

    const putResolved = await this.applyPutPrefixRule(trimmed, content);
    content = putResolved.content;
    const ruleBody = putResolved.rule;
    if (!ruleBody) return content;

    const groupPick = this.applyRegexGroupRef(ruleBody, content);
    if (groupPick !== undefined) return groupPick;

    const isJsRule =
      isLegadoJsRule(ruleBody) || /^@webjs:/i.test(ruleBody.trim());
    const { baseRule, regex } = splitRuleRegexSuffix(ruleBody);
    let workRule = baseRule.trim();
    // Legado：`<js>##pat</js>` 拆成空规则 + replaceRegex，只对链式 result 做替换
    if (!workRule && regex) {
      const text =
        typeof content === "string" ? content : String(content ?? "");
      return this.applyRuleRegex(text, regex);
    }

    // 单段内 `a||b`：首个非空（Lofter `$..posts[*]||$.response.items[*]`）；勿把整段当 JSONPath
    if (!isJsRule && workRule.includes("||")) {
      const { parts, joiner } = splitLegadoCompoundRule(workRule);
      if (joiner === "||" && parts.length > 1) {
        for (const part of parts) {
          const r = await this.getOne(part.trim(), content, list);
          if (list) {
            if (Array.isArray(r) && r.length) return r;
            if (r != null && r !== "" && !Array.isArray(r)) return [r];
          } else if (r != null && r !== "") {
            return regex ? this.applyRuleRegex(String(r), regex) : r;
          }
        }
        return list ? [] : "";
      }
    }

    if (isJsonItemContent(content)) {
      if (workRule.includes("{{")) {
        workRule = legadoTemplateNeedsJsEval(workRule)
          ? this.expandRuleJsTemplates(workRule, content)
          : expandLegadoTemplateRule(workRule, content);
      } else if (workRule.includes("{$.")) {
        workRule = expandBraceJsonPathRule(workRule, content);
      }
    }
    // Legado AnalyzeByJSonPath：{$.} 展开后为字面量；@js/<js> 仍须执行脚本
    if (workRule !== baseRule && isJsonItemContent(content) && !isJsRule) {
      let literal = workRule;
      if (!list && typeof literal === "string" && regex) {
        literal = this.applyRuleRegex(literal, regex);
      }
      return literal;
    }
    const mode = detectMode(workRule, this.contentIsJson);
    let out: unknown;
    try {
      switch (mode) {
        case "template":
          out = expandLegadoTemplateRule(workRule, content);
          break;
        case "js":
          out = await this.evalRuleJs(baseRule, content);
          break;
        case "webJs":
          out = await this.evalWebJsRule(baseRule, content);
          break;
        case "json":
          if (!list && isPlainRuleObject(content)) {
            const nested = readJsonNestedValue(
              content as Record<string, unknown>,
              ruleBody,
            );
            if (nested !== undefined) return nested;
            const field = readJsonField(content as Record<string, unknown>, ruleBody);
            if (field) return field;
            const path = stripPrefix(workRule, ["@Json:", "@json:"]);
            const fb = jsonPathWithLegacyResponseFallback(path, content);
            if (fb) return fb;
            return "";
          }
          out = this.byJsonPath(
            stripPrefix(workRule, ["@Json:", "@json:"]),
            content,
            list,
          );
          break;
        case "xpath":
          out = this.byXPath(
            stripPrefix(workRule, ["@XPath:", "@xpath:"]),
            content,
            list,
          );
          break;
        case "regex":
          out = this.byLegadoRegex(workRule, content, list);
          break;
        default: {
          const jsonField = tryJsonFieldRule(workRule, content);
          if (jsonField != null) {
            out = jsonField;
          } else if (
            workRule !== baseRule &&
            isJsonItemContent(content) &&
            !workRule.includes("@") &&
            !workRule.startsWith("$.") &&
            !workRule.startsWith("/") &&
            !workRule.startsWith(":")
          ) {
            out = workRule;
          } else {
            out = this.byLegadoDefault(workRule, content, list);
          }
          break;
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const selectorMisparse =
        msg.includes("Unmatched selector") || msg.includes("Empty sub-selector");
      if (
        !isVerificationCancelled(e) &&
        (selectorMisparse || (mode === "default" && looksLikeLegadoJs(workRule)))
      ) {
        out = await this.evalRuleJs(wrapLegadoJsRule(baseRule), content);
      } else {
        throw e;
      }
    }
    if (!list && typeof out === "string" && regex) {
      return this.applyRuleRegex(out, regex);
    }
    return out;
  }

  /** Legado/Rhino 规则 JS 内 getOne 须同步阻塞（与 java.getStringList 一致） */
  private getOneSync(rule: string, content: unknown, list = false): unknown {
    const trimmed = trimLegadoRulePreservingRegexReplace(rule);
    if (!trimmed) return content;

    const putResolved = this.applyPutPrefixRuleSync(trimmed, content);
    content = putResolved.content;
    const ruleBody = putResolved.rule;
    if (!ruleBody) return content;

    const groupPick = this.applyRegexGroupRef(ruleBody, content);
    if (groupPick !== undefined) return groupPick;

    const isJsRule =
      isLegadoJsRule(ruleBody) || /^@webjs:/i.test(ruleBody.trim());
    const { baseRule, regex } = splitRuleRegexSuffix(ruleBody);
    let workRule = baseRule.trim();
    if (!workRule && regex) {
      const text =
        typeof content === "string" ? content : String(content ?? "");
      return this.applyRuleRegex(text, regex);
    }
    if (!isJsRule && workRule.includes("||")) {
      const { parts, joiner } = splitLegadoCompoundRule(workRule);
      if (joiner === "||" && parts.length > 1) {
        for (const part of parts) {
          const r = this.getOneSync(part.trim(), content, list);
          if (list) {
            if (Array.isArray(r) && r.length) return r;
            if (r != null && r !== "" && !Array.isArray(r)) return [r];
          } else if (r != null && r !== "") {
            return regex ? this.applyRuleRegex(String(r), regex) : r;
          }
        }
        return list ? [] : "";
      }
    }
    if (isJsonItemContent(content)) {
      if (workRule.includes("{{")) {
        workRule = legadoTemplateNeedsJsEval(workRule)
          ? this.expandRuleJsTemplates(workRule, content)
          : expandLegadoTemplateRule(workRule, content);
      } else if (workRule.includes("{$.")) {
        workRule = expandBraceJsonPathRule(workRule, content);
      }
    }
    if (workRule !== baseRule && isJsonItemContent(content) && !isJsRule) {
      let literal = workRule;
      if (!list && typeof literal === "string" && regex) {
        literal = this.applyRuleRegex(literal, regex);
      }
      return literal;
    }
    const mode = detectMode(workRule, this.contentIsJson);
    let out: unknown;
    try {
      switch (mode) {
        case "template":
          out = expandLegadoTemplateRule(workRule, content);
          break;
        case "js":
          out = this.evalRuleJsSync(baseRule, content);
          break;
        case "webJs":
          this.host.log("规则 JS 中 @webjs 须异步执行，同步 getStringList/getElements 无法解析");
          out = "";
          break;
        case "json":
          if (!list && isPlainRuleObject(content)) {
            const nested = readJsonNestedValue(
              content as Record<string, unknown>,
              ruleBody,
            );
            if (nested !== undefined) return nested;
            const field = readJsonField(content as Record<string, unknown>, ruleBody);
            if (field) return field;
            const path = stripPrefix(workRule, ["@Json:", "@json:"]);
            const fb = jsonPathWithLegacyResponseFallback(path, content);
            if (fb) return fb;
            return "";
          }
          out = this.byJsonPath(
            stripPrefix(workRule, ["@Json:", "@json:"]),
            content,
            list,
          );
          break;
        case "xpath":
          out = this.byXPath(
            stripPrefix(workRule, ["@XPath:", "@xpath:"]),
            content,
            list,
          );
          break;
        case "regex":
          out = this.byLegadoRegex(workRule, content, list);
          break;
        default: {
          const jsonField = tryJsonFieldRule(workRule, content);
          if (jsonField != null) {
            out = jsonField;
          } else if (
            workRule !== baseRule &&
            isJsonItemContent(content) &&
            !workRule.includes("@") &&
            !workRule.startsWith("$.") &&
            !workRule.startsWith("/") &&
            !workRule.startsWith(":")
          ) {
            out = workRule;
          } else {
            out = this.byLegadoDefault(workRule, content, list);
          }
          break;
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const selectorMisparse =
        msg.includes("Unmatched selector") || msg.includes("Empty sub-selector");
      if (
        !isVerificationCancelled(e) &&
        (selectorMisparse || (mode === "default" && looksLikeLegadoJs(workRule)))
      ) {
        out = this.evalRuleJsSync(wrapLegadoJsRule(baseRule), content);
      } else {
        throw e;
      }
    }
    if (!list && typeof out === "string" && regex) {
      return this.applyRuleRegex(out, regex);
    }
    return out;
  }

  /** Legado 正则结果 List<String> 上的 $1 / $2 引用，及 $1@js: 链 */
  private applyRegexGroupRef(rule: string, content: unknown): unknown | undefined {
    const m = rule.match(/^(\$\d{1,2})([\s\S]*)$/);
    if (!m || !Array.isArray(content)) return undefined;
    const idx = Number.parseInt(m[1].slice(1), 10);
    let val: unknown = content[idx] ?? "";
    const tail = m[2].trim();
    if (!tail) return val;
    if (tail.startsWith("@js:")) {
      return evalJs(tail.slice(4), {
        source: this.source,
        book: this.book,
        chapter: this.chapter,
        result: val,
        baseUrl: this.baseUrl,
        host: this.host,
      });
    }
    if (tail.startsWith("##")) {
      const { regex: rx } = splitRuleRegexSuffix(tail);
      return this.applyRuleRegex(String(val ?? ""), rx);
    }
    return undefined;
  }

  private byLegadoRegex(rule: string, content: unknown, list: boolean): unknown {
    const text = typeof content === "string" ? content : String(content ?? "");
    const regs = parseRegexRuleList(rule);
    if (!regs.length) return list ? [] : "";
    if (list) return regexGetElements(text, regs);
    const one = regexGetElement(text, regs);
    return one ?? (list ? [] : "");
  }

  private expandRuleJsTemplates(script: string, content: unknown): string {
    const templateContexts: unknown[] = [];
    if (isJsonItemContent(this.chainItemContext)) {
      templateContexts.push(this.chainItemContext);
    }
    if (isJsonItemContent(content)) {
      templateContexts.push(content);
    }
    if (this.content != null && this.content !== "") {
      templateContexts.push(this.content);
    }
    if (!templateContexts.length) templateContexts.push(content);

    return script.replace(/\{\{([\s\S]*?)\}\}/g, (_, expr: string) => {
      const key = expr.trim();
      if (key.startsWith("$.") || key.startsWith("$..") || key.startsWith("$[")) {
        const pathPart = key.split("##")[0]?.trim() ?? key;
        for (const ctx of templateContexts) {
          const val = expandLegadoTemplateJsonPathExpr(pathPart, ctx);
          if (val) return val;
        }
        if (pathPart === "$.id" || pathPart.endsWith(".id")) {
          const bid =
            this.lookupStoredValue("bid") || this.lookupStoredValue("id");
          if (bid) return bid;
          const fromUrl =
            this.requestUrlCtx?.match(/[?&]id=([^&]+)/i)?.[1] ??
            this.baseUrl?.match(/[?&]id=([^&]+)/i)?.[1] ??
            "";
          if (fromUrl) return fromUrl;
        }
        return "";
      }
      const jsOut = evalJsExpression(key, {
        ...this.buildJsEvalContext(content),
      });
      if (typeof jsOut === "number" && jsOut % 1 === 0) {
        return String(Math.trunc(jsOut));
      }
      return String(jsOut ?? "");
    });
  }

  private async evalWebJsRule(rule: string, content: unknown): Promise<string> {
    const script = stripWebJsRule(rule);
    const html =
      typeof content === "string"
        ? content
        : content == null
          ? String(this.content ?? "")
          : String(content);
    const pageUrl = this.redirectUrl || this.baseUrl || this.requestUrlCtx || "";
    try {
      return await runBackstageWebView({
        html,
        url: pageUrl,
        js: script,
        source: this.source,
        host: this.host,
        injectResult: content,
        cacheFirst: true,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.host.log(`WebJs 规则错误: ${msg}`);
      return "";
    }
  }

  private async evalRuleJs(rule: string, content: unknown): Promise<unknown> {
    let script = stripLegadoJsRuleMarkers(rule);
    const beforeExpand = script;
    script = this.expandRuleJsTemplates(script, content);
    // `{{'书名'}}` / `{{`url`}}`：expand 已是最终字面量，再 eval 会 ReferenceError / Unexpected token
    if (isPureMustacheTemplateRule(beforeExpand)) {
      return script;
    }
    if (Array.isArray(content)) {
      script = script.replace(/\$(\d{1,2})/g, (_, d) => {
        const v = content[Number.parseInt(d, 10)] ?? "";
        return String(v).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
      });
    }
    const allowContentFallback = this.shouldEvalJsFallbackToContent(content);
    let out: unknown;
    const jsPrefix = this.nextChapterUrl
      ? `var nextChapterUrl=${JSON.stringify(this.nextChapterUrl)};\n`
      : "";
    try {
      out = await evalJsAsync(jsPrefix + script, this.buildJsEvalContext(content));
    } catch (e) {
      if (isVerificationCancelled(e)) throw e;
      const msg = e instanceof Error ? e.message : String(e);
      this.host.log(`规则 JS 错误: ${msg}`);
      if (!isLegadoJsRule(rule) && allowContentFallback) {
        return this.content;
      }
      return "";
    }
    if (Array.isArray(out)) {
      // 空数组是合法结果（如 nextTocUrl 无下一页）；不可回退整页正文
      return out;
    }
    if (out != null && out !== "") {
      return out;
    }
    // 部分书源（如起点）在 if 外不 return，但已通过 setContent / ajax 更新正文
    const pathMatch = script.match(/path\s*=\s*['"]([^'"]+)['"]/);
    if (pathMatch) {
      try {
        return this.getElementForJs(pathMatch[1]);
      } catch {
        return [];
      }
    }
    if (allowContentFallback) {
      return this.content;
    }
    return out;
  }

  /** 规则 JS 内嵌 @js/<js> 规则：同步 eval（对齐 Legado/Rhino） */
  private evalRuleJsSync(rule: string, content: unknown): unknown {
    let script = stripLegadoJsRuleMarkers(rule);
    const beforeExpand = script;
    script = this.expandRuleJsTemplates(script, content);
    if (isPureMustacheTemplateRule(beforeExpand)) {
      return script;
    }
    if (Array.isArray(content)) {
      script = script.replace(/\$(\d{1,2})/g, (_, d) => {
        const v = content[Number.parseInt(d, 10)] ?? "";
        return String(v).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
      });
    }
    const allowContentFallback = this.shouldEvalJsFallbackToContent(content);
    const jsPrefix = this.nextChapterUrl
      ? `var nextChapterUrl=${JSON.stringify(this.nextChapterUrl)};\n`
      : "";
    const out = evalJs(jsPrefix + script, this.buildJsEvalContext(content));
    if (Array.isArray(out)) {
      return out;
    }
    if (out != null && out !== "") {
      return out;
    }
    const pathMatch = script.match(/path\s*=\s*['"]([^'"]+)['"]/);
    if (pathMatch) {
      try {
        return this.getElementForJs(pathMatch[1]);
      } catch {
        return [];
      }
    }
    if (allowContentFallback) {
      return this.content;
    }
    return out;
  }

  /** 子元素/片段解析失败时不应回退到整页 HTML */
  private shouldEvalJsFallbackToContent(content: unknown): boolean {
    // 规则链中间结果（blogId 字符串、列表项 JSON 等）禁止回退整页 content
    if (content !== this.content) return false;
    if (this.content == null || this.content === "") return false;
    return typeof this.content === "string";
  }

  private byJsonPath(rule: string, content: unknown, list: boolean): unknown {
    let data = content;
    if (typeof content === "string") {
      try {
        data = JSON.parse(content);
      } catch {
        return list ? [] : "";
      }
    }
    let path = rule.startsWith("$") ? rule : `$.${rule}`;
    // Legado / Jayway：对数组内容，`$.[*]` 与 `$[*]` 等价；jsonpath-plus 的 `$.[*]` 会错误展开嵌套字段
    if (Array.isArray(data) && (path === "$.[*]" || path === "$.*")) {
      path = "$[*]";
    }
    try {
      const results = JSONPath({ path, json: data as object, wrap: false });
      if (list) {
        if (results == null) return [];
        return Array.isArray(results) ? results : [results];
      }
      if (Array.isArray(results)) {
        // 对齐 Legado：标量数组整表 join（如 $.tagList），勿只取 [0]
        const allScalar = results.every(
          (v) =>
            v == null ||
            typeof v === "string" ||
            typeof v === "number" ||
            typeof v === "boolean",
        );
        const joinMulti =
          allScalar || path.includes("..") || path.includes("[*]");
        if (joinMulti) {
          const sep =
            path.includes("[*]") && !path.includes("..") && !allScalar
              ? ","
              : "\n";
          return results.map((v) => String(v ?? "")).filter(Boolean).join(sep);
        }
        const first = results[0] ?? "";
        if (first !== "" && first != null) return first;
      } else if (results != null && results !== "") {
        return results;
      }
      // 标量路径落空时尝试 Lofter 等详情字段兼容（blogsetting → posts[0].post）
      const fb = jsonPathWithLegacyResponseFallback(path, data);
      return fb || "";
    } catch {
      return list ? [] : "";
    }
  }

  private byXPath(rule: string, content: unknown, list: boolean): unknown {
    const html = typeof content === "string" ? content : String(content ?? "");
    try {
      return selectXPath(rule, html, list);
    } catch {
      return list ? [] : "";
    }
  }

  private byLegadoDefault(rule: string, content: unknown, list: boolean): unknown {
    const trimmed = rule.replace(/^@@/, "").trim();
    if (!trimmed) return list ? [] : "";

    const { parts, joiner } = splitLegadoCompoundRule(trimmed);
    if (parts.length <= 1) {
      return this.byLegadoDefaultSingle(trimmed, content, list);
    }
    return this.mergeLegadoDefaultCompound(parts, joiner, content, list);
  }

  /** Legado AnalyzeByJSoup：同一段内 && / || / %% 组合，共用 content */
  private mergeLegadoDefaultCompound(
    parts: string[],
    joiner: "&&" | "||" | "%%",
    content: unknown,
    list: boolean,
  ): unknown {
    if (joiner === "||") {
      for (const part of parts) {
        const r = this.byLegadoDefaultSingle(part.trim(), content, list);
        if (list) {
          const arr = Array.isArray(r) ? r : r != null && r !== "" ? [r] : [];
          if (arr.length) return arr;
        } else if (typeof r === "string" && r) {
          return r;
        } else if (Array.isArray(r) && r.length) {
          return legadoJoinResultTexts(r.map(String));
        } else if (r != null && r !== "") {
          return String(r);
        }
      }
      return list ? [] : "";
    }

    if (joiner === "%%") {
      const lists = parts.map((part) => {
        const r = this.byLegadoDefaultSingle(part.trim(), content, true);
        return Array.isArray(r) ? r : r != null && r !== "" ? [r] : [];
      });
      if (!lists.length || !lists[0]?.length) return list ? [] : "";
      const out: unknown[] = [];
      for (let i = 0; i < lists[0]!.length; i++) {
        for (const lst of lists) {
          if (i < lst.length) out.push(lst[i]!);
        }
      }
      if (list) return out;
      return legadoJoinResultTexts(
        out.map((v) => String(v ?? "")).filter(Boolean),
      );
    }

    const acc: string[] = [];
    const elements: unknown[] = [];
    for (const part of parts) {
      const r = this.byLegadoDefaultSingle(part.trim(), content, list);
      if (list) {
        if (Array.isArray(r)) elements.push(...r);
        else if (r != null && r !== "") elements.push(r);
      } else if (typeof r === "string" && r) {
        acc.push(r);
      } else if (Array.isArray(r)) {
        acc.push(...r.map(String).filter(Boolean));
      } else if (r != null && r !== "") {
        acc.push(String(r));
      }
    }
    if (list) return elements;
    return legadoJoinResultTexts(acc);
  }

  private byLegadoDefaultExtractAll(rule: string, content: unknown): string[] {
    const trimmed = rule.replace(/^@@/, "").trim();
    if (!trimmed) return [];

    const atParts = trimmed.split("@").filter(Boolean);
    if (atParts.length < 2) return [];

    let extract: string | null = null;
    let resultIndex: number | undefined;
    let selectorSegs = atParts;
    const lastPart = atParts[atParts.length - 1];
    const parsedExtract = lastPart ? parseLegadoResultExtract(lastPart) : null;
    if (parsedExtract) {
      extract = parsedExtract.extract;
      resultIndex = parsedExtract.resultIndex;
      selectorSegs = atParts.slice(0, -1);
    }
    if (!extract || selectorSegs.length !== 1) return [];

    const selector = selectorSegs[0].trim();
    const parsed = parseLegadoSelectorSegment(selector);
    if (hasLegadoSegmentIndex(parsed)) return [];

    const html = typeof content === "string" ? content : String(content ?? "");
    const $ = loadCheerioHtml(html);
    const els = isLegadoAttrSelectorSegment(selector)
      ? queryLegadoAttrSelector($, selector)
      : queryLegadoSelectorSegment($, $("body"), selector, true);
    if (!els.length) return [];

    const out: string[] = [];
    els.each((_, el) => {
      const v = extractFromElement($(el), extract!).trim();
      if (v) out.push(v);
    });
    return pickLegadoResultByIndex(out, resultIndex);
  }

  private byLegadoDefaultSingle(rule: string, content: unknown, list: boolean): unknown {
    const trimmed = rule.replace(/^@@/, "").trim();
    if (!trimmed) return list ? [] : "";

    if (trimmed.startsWith("@css:")) {
      return this.byCss(trimmed.slice(5).trim(), content, list);
    }

    const html = typeof content === "string" ? content : String(content ?? "");
    const $ = loadCheerioHtml(html);
    let atParts = trimmed.split("@").filter(Boolean);

    let jsSuffix: string | null = null;
    const tail = atParts[atParts.length - 1];
    if (tail?.startsWith("js:") || tail?.startsWith("@js:")) {
      jsSuffix = tail.replace(/^@?js:/, "").trim();
      atParts = atParts.slice(0, -1);
    }

    if (atParts.length === 1 && !jsSuffix) {
      const seg = atParts[0];
      // Legado：规则仅为 text / href / value 等时，从当前 content 元素直接提取属性或文本。
      // getElements（list）只走选择器，避免把 option 等标签名误判为属性。
      if (isLegadoExtractType(seg) || (!list && isLegadoAttrExtract(seg))) {
        return extractFromContentRoot(content, seg, list);
      }
      if (isLegadoAttrSelectorSegment(seg)) {
        const found = queryLegadoAttrSelector($, seg);
        if (!found.length) return list ? [] : "";
        if (list) return elementsToHtmlList(found, $);
        return found.first().html() ?? found.first().text() ?? "";
      }
      const found = queryLegadoSelectorSegment($, $("body"), seg, true);
      if (!found.length) return list ? [] : "";
      if (list) return elementsToHtmlList(found, $);
      return found.first().html() ?? found.first().text() ?? "";
    }

    let extract: string | null = null;
    let resultIndex: number | undefined;
    let selectorSegs = atParts;
    const lastPart = atParts[atParts.length - 1];
    const parsedExtract = lastPart ? parseLegadoResultExtract(lastPart) : null;
    if (parsedExtract) {
      extract = parsedExtract.extract;
      resultIndex = parsedExtract.resultIndex;
      selectorSegs = atParts.slice(0, -1);
    }

    if (extract && selectorSegs.length > 0 && !jsSuffix) {
      const parts = legadoCollectResultTexts(html, trimmed);
      if (parts.length) {
        return list ? parts : legadoJoinResultTexts(parts);
      }
    }

    let current: cheerio.Cheerio<any> = $("body");
    if (!current.length) current = $.root().children();

    for (let i = 0; i < selectorSegs.length; i++) {
      const seg = selectorSegs[i];
      let found: cheerio.Cheerio<any>;
      let segIndexed = false;
      if (isLegadoAttrSelectorSegment(seg)) {
        found = queryLegadoAttrSelector($, seg);
      } else {
        found = queryLegadoSelectorSegment($, current, seg, i === 0);
        const parsed = parseLegadoSelectorSegment(seg);
        segIndexed = hasLegadoSegmentIndex(parsed);
      }
      if (!found.length) return list ? [] : "";

      const isLast = i === selectorSegs.length - 1;
      if (isLast && !extract && !jsSuffix) {
        const target = list ? found : segIndexed ? found : pickElements(found, { index: 0 });
        if (list) return elementsToHtmlList(target, $);
        return target.first().html() ?? target.first().text() ?? "";
      }

      if (isLast && extract) {
        const parsed = parseLegadoSelectorSegment(seg);
        if (
          parsed.tagName === "span" &&
          parsed.index != null &&
          current.length === 1 &&
          current.children("li").length > 1
        ) {
          const perLi = extractIndexedSpanTextFromListItems(
            $,
            current,
            parsed.index,
            extract,
          );
          if (perLi) return perLi;
        }
        current = found;
      } else {
        // list 模式中间段保留全部匹配（对齐 Legado getElements）；单值模式再取首个
        current = list || segIndexed ? found : pickElements(found, { index: 0 });
      }
    }

    let value: unknown;
    if (!extract && !jsSuffix) {
      if (list) return elementsToHtmlList(current, $);
      value = current.first().html() ?? current.first().text() ?? "";
    } else if (extract) {
      if (list || current.length > 1) {
        const out: string[] = [];
        current.each((_, el) => {
          const v = extractFromElement($(el), extract).trim();
          if (v) out.push(v);
        });
        const picked = pickLegadoResultByIndex(out, resultIndex);
        return list ? picked : legadoJoinResultTexts(picked);
      }
      value = extractFromElement(current, extract);
    } else {
      value = list
        ? elementsToHtmlList(current, $)
        : (current.first().html() ?? current.first().text() ?? "");
    }

    if (jsSuffix) {
      const base = typeof value === "string" ? value : String(value ?? "");
      const jsOut = evalJs(jsSuffix, {
        source: this.source,
        book: this.book,
        chapter: this.chapter,
        result: base,
        baseUrl: this.baseUrl,
        host: this.host,
      });
      return jsOut ?? base;
    }

    return value;
  }

  private byCss(rule: string, content: unknown, list: boolean): unknown {
    const html = typeof content === "string" ? content : String(content ?? "");
    const $ = loadCheerioHtml(html);
    let sel = rule.replace(/^@@/, "").replace(/^@css:/, "").trim();
    if (!sel) return list ? [] : "";

    let extract = "html";
    const at = sel.lastIndexOf("@");
    if (at > 0) {
      const maybe = sel.slice(at + 1);
      if (isLegadoExtractType(maybe)) {
        extract = maybe;
        sel = sel.slice(0, at);
      }
    }

    const els = $(sel);
    if (!els.length) return list ? [] : "";
    if (list) {
      // 供后续 @js：`$[i].select()`（对齐 Legado Elements）；普通列表字段仍靠 toString→outerHtml
      return cheerioToJsoupList($, els);
    }
    return extractFromElement(els.first(), extract);
  }

  async getUrlList(
    rule: string | undefined | null,
    mContent?: unknown,
  ): Promise<string[]> {
    if (!rule?.trim()) return [];
    const content = mContent ?? this.content;
    const parseRule = await this.applyPutFromFullRule(rule, content);
    // @js 返回 string[] 时保留列表（对齐 Legado getStringList isUrl），勿先拼成单串
    if (/(?:@js:|<js>|@webjs:)/i.test(parseRule)) {
      const prevChain = this.chainItemContext;
      this.chainItemContext = content;
      try {
        const rules = splitSourceRule(parseRule);
        let result: unknown = content;
        for (const r of rules) {
          result = await this.evalStringChainSegment(r, result);
        }
        if (Array.isArray(result)) {
          const out: string[] = [];
          for (const item of result) {
            const u = this.resolveAbsoluteRuleUrl(String(item ?? "").trim());
            if (u) out.push(u);
          }
          return out;
        }
        const raw = coerceLegadoRuleString(result).trim();
        if (!raw) return [];
        if (/,\s*\{/.test(raw)) {
          const u = this.resolveAbsoluteRuleUrl(raw);
          return u ? [u] : [];
        }
        const out: string[] = [];
        for (const line of splitStringListLines(raw)) {
          const u = this.resolveAbsoluteRuleUrl(line);
          if (u) out.push(u);
        }
        return out;
      } finally {
        this.chainItemContext = prevChain;
      }
    }

    const raw = (await this.getString(rule, mContent)).trim();
    if (!raw) return [];
    // 含 UrlOption 的整段可跨行，不可按行拆成多条
    if (/,\s*\{/.test(raw)) {
      const chunks = raw
        .split(/\n\s*\n/)
        .map((s) => s.trim())
        .filter(Boolean);
      const out: string[] = [];
      for (const chunk of chunks.length ? chunks : [raw]) {
        if (/,\s*\{/.test(chunk)) {
          const u = this.resolveAbsoluteRuleUrl(chunk);
          if (u) out.push(u);
          continue;
        }
        for (const line of chunk.split(/[\r\n]+/)) {
          const u = this.resolveAbsoluteRuleUrl(line.trim());
          if (u) out.push(u);
        }
      }
      return out;
    }
    const list = await this.getStringList(rule, mContent);
    const out: string[] = [];
    for (const item of list) {
      const u = this.resolveAbsoluteRuleUrl(item);
      if (u) out.push(u);
    }
    return out;
  }

  resolveAbsoluteRuleUrl(u: string): string {
    let path = u.trim();
    if (!path) return "";
    // 内容回退/误解析成相对路径时，拒绝整页 JSON/HTML 被拼进 URL
    if (
      path.startsWith("{") ||
      path.startsWith("[") ||
      path.startsWith("<") ||
      path.length > 4096
    ) {
      return "";
    }
    const suffix = extractUrlFetchOptionsSuffix(path);
    const { url: pathPart } = splitUrlAndRuleVariables(path);
    path = pathPart;
    if (path.startsWith("data:") || path.startsWith("colortxt-local:")) {
      return path + suffix;
    }
    if (path.startsWith("//")) path = `https:${path}`;
    if (!/^https?:\/\//i.test(path)) {
      const base = normalizeBookSourceBaseUrl(
        this.redirectUrl || this.baseUrl || this.source?.bookSourceUrl || "",
      );
      // UrlOption 后缀已拆出；相对路径不含换行。多行 href 误入时只取首行
      path = resolveAbsoluteUrl(base, path);
    }
    return path + suffix;
  }

  async getUrl(rule: string, content?: unknown): Promise<string> {
    const raw = (await this.getString(rule, content)).trim();
    if (!raw) return "";
    /**
     * 搜索/详情 bookUrl 常为多行 UrlOption：
     * `https://host/path,{\n  "body":'{"bookId":"1"}',\n  "method":"POST"\n}`
     * 不可走 getStringList 按换行切开（会只剩 `…/path,{`，bookId 丢失）。
     */
    if (/,\s*\{/.test(raw)) {
      return this.resolveAbsoluteRuleUrl(raw);
    }
    // 多条普通 href 换行拼接（如 a@href）：取第一条
    const first =
      raw
        .split(/[\r\n]+/)
        .map((s) => s.trim())
        .find(Boolean) ?? "";
    return first ? this.resolveAbsoluteRuleUrl(first) : "";
  }
}

function jsonPathFromContent(path: string, content: unknown): string {
  let data = content;
  if (typeof content === "string") {
    try {
      data = JSON.parse(content);
    } catch {
      return "";
    }
  }
  if (data == null || typeof data !== "object") return "";
  const jsonPath = path.startsWith("$") ? path : `$.${path}`;
  try {
    const results = JSONPath({ path: jsonPath, json: data as object, wrap: false });
    if (Array.isArray(results)) {
      // 对齐 Legado：数组结果用换行拼接（含 $.data.Content[0].Content 字符串数组）
      const allScalar = results.every(
        (v) => v == null || typeof v === "string" || typeof v === "number" || typeof v === "boolean",
      );
      const joinMulti =
        allScalar || jsonPath.includes("..") || jsonPath.includes("[*]");
      if (joinMulti) {
        const sep = jsonPath.includes("[*]") && !jsonPath.includes("..") && !allScalar
          ? ","
          : "\n";
        return results.map((v) => coerceLegadoMediaUrl(v)).filter(Boolean).join(sep);
      }
      return coerceLegadoMediaUrl(results[0]);
    }
    return coerceLegadoMediaUrl(results);
  } catch {
    return "";
  }
}

/**
 * Lofter 字段兼容（勿把 detail 的 post.blogId 当成 blogsetting.blogId：
 * 否则会误拼 blogHomePage，目录变成博主全部动态而非本书）。
 */
function jsonPathWithLegacyResponseFallback(path: string, content: unknown): string {
  let val = jsonPathFromContent(path, content);
  if (val) return val;
  // coverUrl @put page：详情响应常无 blogStat，用合集 postCount 供真·blogHomePage 分页
  if (path === "$.response.blogInfo.blogStat.publicPostCount") {
    const count =
      jsonPathFromContent(
        "$.response.posts[0].post.postCollection.postCount",
        content,
      ) || jsonPathFromContent("$..postCollection.postCount", content).split("\n")[0];
    return String(count ?? "").split("\n")[0]?.trim() ?? "";
  }
  return "";
}

function expandLegadoTemplateJsonPathExpr(expr: string, content: unknown): string {
  const alts = expr.split("||").map((s) => s.trim()).filter(Boolean);
  for (const alt of alts) {
    // 对齐 Legado：`{{$.docId##.*_}}` 先取 JsonPath，再套用 ## 替换
    const { baseRule, regex } = splitRuleRegexSuffix(alt);
    const pathPart = baseRule.trim();
    if (
      !pathPart.startsWith("$.") &&
      !pathPart.startsWith("$..") &&
      !pathPart.startsWith("$[")
    ) {
      continue;
    }
    let val = "";
    if (isPlainRuleObject(content)) {
      val = readJsonField(content as Record<string, unknown>, pathPart);
    }
    if (!val) {
      val = jsonPathWithLegacyResponseFallback(pathPart, content);
    }
    if (val && regex) val = applyRuleRegexImpl(val, regex);
    if (val) return val;
  }
  if (alts.length === 1 && isJsonItemContent(content)) {
    const { baseRule } = splitRuleRegexSuffix(alts[0]!);
    const pathPart = baseRule.trim();
    const nestedFallback: Record<string, string> = {
      "$.blogId": "$.blogInfo.blogId",
      "$.blogName": "$.blogInfo.blogName",
    };
    const fb = nestedFallback[pathPart];
    if (fb) {
      return readJsonField(content as Record<string, unknown>, fb);
    }
  }
  return "";
}

function expandLegadoTemplateRule(rule: string, content: unknown): string {
  return rule.replace(/\{\{([\s\S]*?)\}\}/g, (_, expr: string) => {
    const key = expr.trim();
    // Legado 规则链：{{result}} 表示上一段规则的输出（如 bid 经 JS 偏移后的 bookid）
    if (key === "result") {
      if (content == null || typeof content === "object") return "";
      if (typeof content === "number" && Number.isFinite(content)) {
        return content % 1 === 0
          ? String(Math.trunc(content))
          : String(content);
      }
      return String(content);
    }
    if (key.startsWith("$.") || key.startsWith("$..") || key.startsWith("$[")) {
      return expandLegadoTemplateJsonPathExpr(key, content);
    }
    return "";
  });
}

/** Legado `{$.path}` 单花括号 JSON 模板（不匹配 {{$.path}} 双花括号） */
function expandBraceJsonPathRule(rule: string, content: unknown): string {
  return rule.replace(/(?<!\{)\{(\$\.[^}]+)\}/g, (_, expr: string) =>
    jsonPathFromContent(expr.trim(), content),
  );
}

function isJsonItemContent(content: unknown): boolean {
  return content != null && typeof content === "object" && !Array.isArray(content);
}

/** JSON 列表项上的裸字段名，如 category_name */
function tryJsonFieldRule(rule: string, content: unknown): string | null {
  const t = rule.trim();
  if (!isJsonItemContent(content)) return null;
  if (!/^[\w.]+$/.test(t)) return null;
  const path = t.startsWith("$.") ? t : `$.${t}`;
  const v = jsonPathFromContent(path, content);
  return v || null;
}

function splitStringListLines(value: string): string[] {
  return value
    .split(/[\n\r]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Legado getStringList：JSON 数组字段（如 $.tagList / book_tag_list[*].title）展开为多个 tag */
function jsonPathToLegadoStringList(rule: string, content: unknown): string[] {
  const pathRule = rule.trim().split("##")[0]?.trim() ?? "";
  const path = legadoJsonPathFromRule(pathRule);
  if (!path) return [];
  let data = content;
  if (typeof content === "string") {
    try {
      data = JSON.parse(content);
    } catch {
      return [];
    }
  }
  if (data == null || typeof data !== "object") return [];
  try {
    const results = JSONPath({ path, json: data as object, wrap: false });
    if (results == null || results === "") return [];
    const flatten = (v: unknown): string[] => {
      if (v == null) return [];
      if (Array.isArray(v)) return v.flatMap((item) => flatten(item));
      const s = String(v).trim();
      return s ? [s] : [];
    };
    if (Array.isArray(results)) {
      if (results.length === 1 && Array.isArray(results[0])) {
        return flatten(results[0]);
      }
      return results.flatMap((v) => flatten(v));
    }
    return flatten(results);
  } catch {
    return [];
  }
}

function isLegadoJsonContent(content: unknown): boolean {
  if (content == null) return false;
  if (typeof content === "object") return true;
  if (typeof content !== "string") return false;
  const str = content.trim();
  return (
    (str.startsWith("{") && str.endsWith("}")) ||
    (str.startsWith("[") && str.endsWith("]"))
  );
}

function detectMode(rule: string, contentIsJson = false): AnalyzeMode {
  const t = rule.trim();
  if (isLegadoTemplateOnlyRule(t)) return "template";
  if (/^@webjs:/i.test(t)) return "webJs";
  if (/^<js>/i.test(t) || /^@js:/i.test(t)) return "js";
  if (
    t.startsWith("@Json:") ||
    t.startsWith("@json:") ||
    t.startsWith("$.") ||
    t.startsWith("$..") ||
    t.startsWith("$[")
  )
    return "json";
  if (t.startsWith("@XPath:") || t.startsWith("@xpath:") || t.startsWith("/"))
    return "xpath";
  if (t.startsWith("@css:") || t.startsWith("@@")) return "default";
  if (t.includes("{{")) return "js";
  if (looksLikeLegadoJs(t)) return "js";
  if (t.startsWith(":") || looksLikeLegadoRegexRule(t)) return "regex";
  if (/^##/.test(t) || (t.startsWith("##") === false && /^[^@#.\s]+##/.test(t)))
    return "regex";
  // Legado：setContent 判定为 JSON 时，裸字段规则（如 data）走 JsonPath
  if (contentIsJson) return "json";
  return "default";
}

function stripPrefix(s: string, prefixes: string[]): string {
  for (const p of prefixes) {
    if (s.startsWith(p)) return s.slice(p.length).trim();
  }
  return s;
}

function emptySource(): BookSourceRecord {
  return { bookSourceUrl: "", bookSourceName: "", bookSourceType: 0 };
}

export function templateRule(rule: string, ctx: Record<string, string>): string {
  return rule.replace(/\{\{([^}]+)\}\}/g, (_, key) => ctx[key.trim()] ?? "");
}
