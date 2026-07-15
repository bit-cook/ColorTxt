import type { Book, SearchBookItem } from "./types";

/**
 * 防御：去掉 leading `数字_`（如 `90000001_123` → `123`）。
 * 正常路径应靠列表规则（如 `$.groupID##.*_##`）+ 搜索字段顺序写出干净 id；
 * Legado 引擎无此逻辑，勿当作常规「规范化」。
 */
export function stripNumericIdPrefix(value: string | undefined | null): string {
  const t = typeof value === "string" ? value.trim() : "";
  return t.replace(/^\d+_/, "");
}

/**
 * 对齐 Legado `SearchBook.toBook()`：搜索/发现列表项 → 未完善 Book。
 * `tocUrl` 留空，等 `getBookInfo` 再写入真目录地址。
 */
export function searchBookToBook(item: SearchBookItem): Book {
  const bookUrl = item.bookUrl?.trim() || "";
  return {
    name: item.name ?? "",
    author: item.author ?? "",
    intro: item.intro?.trim() ?? "",
    coverUrl: item.coverUrl?.trim() ?? "",
    coverSourceUrl: item.coverSourceUrl,
    kind: item.kind?.trim() ?? "",
    wordCount: item.wordCount,
    lastChapter: item.lastChapter,
    tocUrl: "",
    bookUrl,
    origin: item.origin,
    originName: item.originName,
  };
}

/** 供 AnalyzeRule.setBook：引擎内与 Legado Book 字段对齐的纯对象 */
export function toEngineBook(book: Book): Record<string, unknown> {
  const kind = stripNumericIdPrefix(book.kind);
  return {
    name: book.name ?? "",
    author: book.author ?? "",
    intro: book.intro ?? "",
    coverUrl: book.coverUrl ?? "",
    kind,
    wordCount: book.wordCount ?? "",
    lastChapter: book.lastChapter ?? "",
    updateTime: book.updateTime ?? "",
    tocUrl: (book.tocUrl ?? "").trim(),
    bookUrl: (book.bookUrl || "").trim(),
    variable: book.variable ? { ...book.variable } : {},
  };
}

/** 将部分字段凑齐为 Book（引擎 / IPC 入参） */
export function coerceBook(raw: Partial<Book> & { bookUrl?: string }): Book {
  const bookUrl = raw.bookUrl?.trim() || "";
  return {
    name: raw.name?.trim() || "",
    author: raw.author?.trim() || "",
    intro: raw.intro?.trim() ?? "",
    coverUrl: raw.coverUrl?.trim() ?? "",
    coverSourceUrl: raw.coverSourceUrl,
    kind: stripNumericIdPrefix(raw.kind),
    wordCount: raw.wordCount,
    lastChapter: raw.lastChapter,
    updateTime: raw.updateTime,
    tocUrl: (raw.tocUrl ?? "").trim(),
    bookUrl,
    origin: raw.origin,
    originName: raw.originName,
    variable: raw.variable,
  };
}
