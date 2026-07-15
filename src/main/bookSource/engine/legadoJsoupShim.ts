import type { AnyNode, Element as DomElement } from "domhandler";
import type { Cheerio, CheerioAPI } from "cheerio";
import { loadCheerioHtml } from "./legadoDefaultRule";

/**
 * Legado / Rhino `org.jsoup.*` 兼容层（cheerio 实现）。
 * 书源常用：Jsoup.parse().select() / selectFirst() / attr / text / hasClass / Elements.get|size
 */

type JsoupNode = {
  select(cssQuery: string): JsoupElements;
  selectFirst(cssQuery: string): JsoupElement | null;
  attr(attributeKey: string): string;
  text(): string;
  html(): string;
  outerHtml(): string;
  hasClass(className: string): boolean;
  id(): string;
  tagName(): string;
  className(): string;
  ownText(): string;
  parent(): JsoupElement | null;
  children(): JsoupElements;
  toString(): string;
};

type JsoupElement = JsoupNode;

type JsoupElements = {
  size(): number;
  get(index: number): JsoupElement | null;
  first(): JsoupElement | null;
  last(): JsoupElement | null;
  select(cssQuery: string): JsoupElements;
  selectFirst(cssQuery: string): JsoupElement | null;
  attr(attributeKey: string): string;
  text(): string;
  html(): string;
  outerHtml(): string;
  hasClass(className: string): boolean;
  isEmpty(): boolean;
  toArray(): JsoupElement[];
  forEach(callback: (el: JsoupElement, index: number) => void): void;
  toString(): string;
  [Symbol.iterator](): Iterator<JsoupElement>;
};

function isElementNode(node: AnyNode | undefined | null): node is DomElement {
  return Boolean(node && node.type === "tag");
}

function wrapElement($: CheerioAPI, node: AnyNode): JsoupElement {
  const el = $(node);

  const api: JsoupElement = {
    select(cssQuery: string) {
      // Jsoup Collector：根节点自身若匹配也入选；cheerio.find 只含后代
      const descendants = el.find(cssQuery);
      const merged = el.is(cssQuery) ? el.add(descendants) : descendants;
      return wrapElements($, merged);
    },
    selectFirst(cssQuery: string) {
      const all = api.select(cssQuery);
      return all.first();
    },
    attr(attributeKey: string) {
      return el.attr(attributeKey) ?? "";
    },
    text() {
      return el
        .clone()
        .find("script, style, noscript")
        .remove()
        .end()
        .text()
        .replace(/\s+/g, " ")
        .trim();
    },
    html() {
      return el.html() ?? "";
    },
    outerHtml() {
      return $.html(node) ?? "";
    },
    hasClass(className: string) {
      return el.hasClass(className);
    },
    id() {
      return el.attr("id") ?? "";
    },
    tagName() {
      return isElementNode(node) ? node.name : "";
    },
    className() {
      return el.attr("class") ?? "";
    },
    ownText() {
      return el
        .contents()
        .filter((_, n) => n.type === "text")
        .text()
        .trim();
    },
    parent() {
      const p = el.parent().get(0);
      return p ? wrapElement($, p) : null;
    },
    children() {
      return wrapElements($, el.children());
    },
    toString() {
      return api.outerHtml();
    },
  };
  return api;
}

function wrapElements($: CheerioAPI, selection: Cheerio<AnyNode>): JsoupElements {
  const api: JsoupElements = {
    size() {
      return selection.length;
    },
    get(index: number) {
      const raw = selection.get(index);
      return raw ? wrapElement($, raw) : null;
    },
    first() {
      return api.get(0);
    },
    last() {
      return selection.length > 0 ? api.get(selection.length - 1) : null;
    },
    select(cssQuery: string) {
      const descendants = selection.find(cssQuery);
      const selfMatch = selection.filter((_, node) => $(node).is(cssQuery));
      const merged = selfMatch.length
        ? selfMatch.add(descendants)
        : descendants;
      return wrapElements($, merged);
    },
    selectFirst(cssQuery: string) {
      return api.select(cssQuery).first();
    },
    attr(attributeKey: string) {
      return selection.first().attr(attributeKey) ?? "";
    },
    text() {
      return selection
        .map((_, n) => wrapElement($, n).text())
        .get()
        .filter(Boolean)
        .join(" ");
    },
    html() {
      return selection
        .map((_, n) => $(n).html() ?? "")
        .get()
        .join("");
    },
    outerHtml() {
      return selection
        .map((_, n) => $.html(n) ?? "")
        .get()
        .join("");
    },
    hasClass(className: string) {
      return selection.toArray().some((n) => $(n).hasClass(className));
    },
    isEmpty() {
      return selection.length === 0;
    },
    toArray() {
      return selection.toArray().map((n) => wrapElement($, n));
    },
    forEach(callback: (el: JsoupElement, index: number) => void) {
      selection.each((i, n) => {
        callback(wrapElement($, n), i);
      });
    },
    toString() {
      return api.outerHtml();
    },
    [Symbol.iterator]() {
      let i = 0;
      return {
        next() {
          if (i >= selection.length) return { done: true as const, value: undefined };
          const value = api.get(i++)!;
          return { done: false as const, value };
        },
      };
    },
  };
  return api;
}

function parseHtml(html: unknown): JsoupElement {
  const $ = loadCheerioHtml(String(html ?? ""));
  // Document：select 作用于整页（对齐 Jsoup.parse(html).select）
  const doc: JsoupElement = {
    select(cssQuery: string) {
      return wrapElements($, $(cssQuery));
    },
    selectFirst(cssQuery: string) {
      const hit = $(cssQuery).first();
      const raw = hit.get(0);
      return raw ? wrapElement($, raw) : null;
    },
    attr(attributeKey: string) {
      return $("html").attr(attributeKey) ?? "";
    },
    text() {
      return $.root()
        .clone()
        .find("script, style, noscript")
        .remove()
        .end()
        .text()
        .replace(/\s+/g, " ")
        .trim();
    },
    html() {
      return $("body").html() ?? $.root().html() ?? "";
    },
    outerHtml() {
      return $.html() ?? "";
    },
    hasClass(className: string) {
      return $("html").hasClass(className) || $("body").hasClass(className);
    },
    id() {
      return $("html").attr("id") ?? "";
    },
    tagName() {
      return "#document";
    },
    className() {
      return $("html").attr("class") ?? "";
    },
    ownText() {
      return "";
    },
    parent() {
      return null;
    },
    children() {
      return wrapElements($, $.root().children());
    },
    toString() {
      return doc.outerHtml();
    },
  };
  return doc;
}

/** 将 cheerio 选择结果转为 Jsoup Element 数组，供规则 JS `$[i].select()` 使用 */
export function cheerioToJsoupList(
  $: CheerioAPI,
  selection: Cheerio<AnyNode>,
): unknown[] {
  return selection.toArray().map((n) => wrapElement($, n));
}

/** 顶层 `org` / `Packages.org` */
export function createOrgPackage(): Record<string, unknown> {
  return {
    jsoup: {
      Jsoup: {
        parse: parseHtml,
      },
    },
  };
}
