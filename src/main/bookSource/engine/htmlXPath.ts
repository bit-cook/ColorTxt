import { DOMParser, XMLSerializer, type Document } from "@xmldom/xmldom";
import * as cheerio from "cheerio";
import xpath from "xpath";

/** 忽略 xmldom 解析告警，避免控制台刷屏 */
const silentOnError = (
  _level: "warning" | "error" | "fatalError",
  _msg: string,
  _context: unknown,
): void => {};

/** HTML 中裸 &（非合法实体）转义，避免 xmldom 刷屏 entity not found */
export function escapeBareAmpersands(html: string): string {
  return html.replace(/&(?!([a-zA-Z][a-zA-Z0-9]*|#\d+|#x[\da-fA-F]+);)/g, "&amp;");
}

export function parseHtmlDocument(html: string): Document {
  const safe = escapeBareAmpersands(html);
  return new DOMParser({ onError: silentOnError }).parseFromString(
    safe,
    "text/html",
  );
}

/**
 * xmldom 以 text/html 解析时会挂上 XHTML 默认命名空间，xpath 的 `//ul` 匹配不到节点，
 * 而 `//*[local-name()='ul']` 可以。将路径步中的元素名改写为 local-name 形式。
 * （对齐 Legado/Jsoup：HTML 无命名空间语义。）
 */
export function xpathIgnoreXhtmlDefaultNs(expr: string): string {
  const reserved = new Set([
    "and",
    "or",
    "not",
    "div",
    "mod",
    "true",
    "false",
    "text",
    "node",
    "comment",
    "processing-instruction",
    "ancestor",
    "ancestor-or-self",
    "attribute",
    "child",
    "descendant",
    "descendant-or-self",
    "following",
    "following-sibling",
    "namespace",
    "parent",
    "preceding",
    "preceding-sibling",
    "self",
    "contains",
    "starts-with",
    "string",
    "concat",
    "substring",
    "substring-before",
    "substring-after",
    "string-length",
    "normalize-space",
    "translate",
    "boolean",
    "number",
    "sum",
    "floor",
    "ceiling",
    "round",
    "count",
    "position",
    "last",
    "local-name",
    "namespace-uri",
    "name",
    "id",
  ]);

  let out = "";
  let i = 0;
  while (i < expr.length) {
    const axis = expr.slice(i).match(/^(?:\/\/|\/|\.\.\/|\.\/)/);
    if (axis) {
      out += axis[0];
      i += axis[0].length;
      continue;
    }
    if (expr[i] === "@") {
      const m = expr.slice(i).match(/^@[\w:-]+/);
      out += m ? m[0] : expr[i];
      i += m ? m[0].length : 1;
      continue;
    }
    if (expr[i] === '"' || expr[i] === "'") {
      const q = expr[i]!;
      let j = i + 1;
      while (j < expr.length && expr[j] !== q) j++;
      out += expr.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    const prev = out.slice(-1);
    const name = expr.slice(i).match(/^[A-Za-z_][\w.-]*/);
    if (
      name &&
      (out === "" ||
        prev === "/" ||
        prev === "(" ||
        /\s$/.test(out) ||
        out.endsWith("::"))
    ) {
      const n = name[0]!;
      const lower = n.toLowerCase();
      const next = expr[i + n.length];
      const isFunc = next === "(";
      const isAxis = expr.slice(i + n.length, i + n.length + 2) === "::";
      // `div` 作运算符：前后空白（非路径步）
      const asOperator =
        lower === "div" &&
        /\s$/.test(out) &&
        (next === undefined || /\s/.test(next));
      if (
        !isFunc &&
        !isAxis &&
        !asOperator &&
        !(reserved.has(lower) && (/\s$/.test(out) || out === ""))
      ) {
        if (prev === "/" || out === "" || out.endsWith("::") || prev === "(") {
          out += `*[local-name()='${n}']`;
          i += n.length;
          continue;
        }
      }
      out += n;
      i += n.length;
      continue;
    }
    out += expr[i];
    i++;
  }
  return out;
}

/**
 * 部分书源常用的 og:meta XPath，用 cheerio 解析（对齐 Legado + Jsoup 的容错）。
 */
export function xpathViaCheerio(
  rule: string,
  html: string,
  list: boolean,
): unknown | undefined {
  const trimmed = rule.trim();
  const metaAttr = trimmed.match(
    /^\/\/meta\[(@property|@name)=['"]([^'"]+)['"]\]\/@(\w+)$/,
  );
  if (metaAttr) {
    const attrName = metaAttr[1].slice(1);
    const attrVal = metaAttr[2];
    const pick = metaAttr[3];
    const $ = cheerio.load(html);
    const val =
      $(`meta[${attrName}="${attrVal}"]`).attr(pick) ??
      $(`meta[${attrName}='${attrVal}']`).attr(pick) ??
      "";
    return list ? (val ? [val] : []) : val;
  }

  const metaText = trimmed.match(
    /^\/\/meta\[(@property|@name)=['"]([^'"]+)['"]\]\/(?:text\(\)|@content)$/,
  );
  if (metaText) {
    const attrName = metaText[1].slice(1);
    const attrVal = metaText[2];
    const $ = cheerio.load(html);
    const val =
      $(`meta[${attrName}="${attrVal}"]`).attr("content")?.trim() ?? "";
    return list ? (val ? [val] : []) : val;
  }

  // xmldom 解析 HTML 时会丢弃 <script>，Legado/Jsoup 仍可读取 script 文本
  if (/^\/\/script\/text\(\)$/.test(trimmed)) {
    const $ = cheerio.load(html);
    const texts: string[] = [];
    $("script").each((_, el) => {
      const t = $(el).text().trim();
      if (t) texts.push(t);
    });
    return list ? texts : (texts[0] ?? "");
  }

  return undefined;
}

function normalizeXPathNodes(raw: unknown): Node[] {
  if (raw == null) return [];
  if (Array.isArray(raw)) return raw as Node[];
  if (typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean") {
    return [];
  }
  return [raw as Node];
}

function serializeXPathNode(node: Node): string {
  const nt = (node as { nodeType?: number }).nodeType;
  // ATTRIBUTE_NODE
  if (nt === 2) {
    return (
      (node as { value?: string; nodeValue?: string }).value ??
      (node as { nodeValue?: string }).nodeValue ??
      ""
    );
  }
  // TEXT_NODE / CDATA
  if (nt === 3 || nt === 4) {
    return (node as { nodeValue?: string }).nodeValue ?? "";
  }
  // ELEMENT_NODE：getElements 需要可再被 Default 规则解析的 HTML 片段
  if (nt === 1) {
    try {
      let html = new XMLSerializer().serializeToString(node as never);
      html = html.replace(/\sxmlns(?::\w+)?="[^"]*"/g, "");
      return html;
    } catch {
      return textOfXPathNode(node);
    }
  }
  return textOfXPathNode(node);
}

export function selectXPath(
  rule: string,
  html: string,
  list: boolean,
): unknown {
  const viaCheerio = xpathViaCheerio(rule, html, list);
  if (viaCheerio !== undefined) return viaCheerio;

  const doc = parseHtmlDocument(html);
  const expr = xpathIgnoreXhtmlDefaultNs(rule.trim());
  let raw: unknown;
  try {
    raw = xpath.select(expr, doc as unknown as Node);
  } catch {
    return list ? [] : "";
  }
  const nodes = normalizeXPathNodes(raw);
  if (!nodes.length) return list ? [] : "";

  if (list) {
    // getElements：元素序列化为 HTML；属性/文本节点仍为字符串
    return nodes.map(serializeXPathNode);
  }
  return textOfXPathNode(nodes[0]!);
}

function textOfXPathNode(node: Node): string {
  if ("textContent" in node) {
    return (node as { textContent?: string }).textContent ?? "";
  }
  if ("nodeValue" in node && (node as { nodeValue?: string }).nodeValue != null) {
    return String((node as { nodeValue?: string }).nodeValue);
  }
  if ("value" in node && (node as { value?: string }).value != null) {
    return String((node as { value?: string }).value);
  }
  return "";
}
