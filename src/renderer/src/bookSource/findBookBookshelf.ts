import type { BookChapter, SearchBookItem, Book } from "@shared/bookSource/types";
import { searchBookToBook } from "@shared/bookSource/bookModel";
import {
  bookshelfContentChapters,
  extractUpdateTimeFromKind,
  resolveLatestChapterTitleFromToc,
} from "./findBookshelfDisplay";

const STORAGE_KEY = "colortxt:findBookBookshelf";

/** 书架项 = Book + 阅读进度等 UI 字段（存盘即为 Book 形状，取出直接用） */
export type BookshelfBook = Book & {
  id: string;
  origin: string;
  originName: string;
  savedAt: number;
  /** 内容章节下标（与 getChapterContent 的 chapterIndex 一致，0 为目录数组中的最新章） */
  lastReadChapterIndex?: number;
  /** 最后阅读章节标题 */
  lastReadChapterTitle?: string;
  /** 最后阅读时间戳（对齐 Legado durChapterTime） */
  lastReadAt?: number;
  /** 是否允许书架更新；缺省或为 true 表示允许 */
  canUpdate?: boolean;
  /** 章节目录缓存（打开阅读器时复用） */
  chapters?: BookChapter[];
};

/** 书架项上的 Book 字段（去掉进度等） */
export function bookshelfAsBook(book: BookshelfBook): Book {
  return {
    name: book.name,
    author: book.author,
    intro: book.intro,
    coverUrl: book.coverUrl,
    coverSourceUrl: book.coverSourceUrl,
    kind: book.kind,
    wordCount: book.wordCount,
    lastChapter: book.lastChapter,
    updateTime: book.updateTime,
    tocUrl: book.tocUrl,
    bookUrl: book.bookUrl,
    origin: book.origin,
    originName: book.originName,
    variable: book.variable,
  };
}

export type BookshelfBookInfoPatch = {
  name?: string;
  author?: string;
  intro?: string;
  coverUrl?: string;
  coverSourceUrl?: string;
  lastChapter?: string;
  kind?: string;
  wordCount?: string;
  updateTime?: string;
  bookUrl?: string;
  tocUrl?: string;
  chapters?: BookChapter[];
};

export type BookshelfAddOptions = {
  updateTime?: string;
};

export function bookshelfBookKey(bookUrl: string, origin: string): string {
  return `${origin.trim()}\0${bookUrl.trim()}`;
}

function isBookshelfBook(v: unknown): v is BookshelfBook {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.id === "string" &&
    typeof o.name === "string" &&
    typeof o.author === "string" &&
    typeof o.intro === "string" &&
    typeof o.coverUrl === "string" &&
    typeof o.kind === "string" &&
    typeof o.tocUrl === "string" &&
    typeof o.bookUrl === "string" &&
    typeof o.origin === "string" &&
    typeof o.originName === "string" &&
    typeof o.savedAt === "number"
  );
}

export function loadFindBookBookshelf(): BookshelfBook[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: BookshelfBook[] = [];
    const seen = new Set<string>();
    for (const item of parsed) {
      if (!isBookshelfBook(item)) continue;
      const key = bookshelfBookKey(item.bookUrl, item.origin);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(item);
    }
    return out;
  } catch {
    return [];
  }
}

export function saveFindBookBookshelf(items: BookshelfBook[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
  } catch {
    /* ignore quota */
  }
}

export function isInFindBookBookshelf(bookUrl: string, origin: string): boolean {
  const key = bookshelfBookKey(bookUrl, origin);
  return loadFindBookBookshelf().some(
    (b) => bookshelfBookKey(b.bookUrl, b.origin) === key,
  );
}

export function addToFindBookBookshelf(
  item: SearchBookItem,
  options?: BookshelfAddOptions,
): BookshelfBook[] {
  const key = bookshelfBookKey(item.bookUrl, item.origin);
  const prev = loadFindBookBookshelf().filter(
    (b) => bookshelfBookKey(b.bookUrl, b.origin) !== key,
  );
  const updateTime =
    options?.updateTime?.trim() || extractUpdateTimeFromKind(item.kind) || undefined;
  const book = searchBookToBook(item);
  const next: BookshelfBook[] = [
    {
      ...book,
      id: item.id,
      origin: item.origin,
      originName: item.originName,
      savedAt: Date.now(),
      ...(updateTime ? { updateTime } : {}),
    },
    ...prev,
  ];
  saveFindBookBookshelf(next);
  return next;
}

/** 解析封面成功后回写书架（更新代理 URL 与原始 URL） */
export function updateFindBookBookshelfCover(
  bookUrl: string,
  origin: string,
  cover: { coverUrl?: string; coverSourceUrl?: string },
): BookshelfBook[] | null {
  const key = bookshelfBookKey(bookUrl, origin);
  let changed = false;
  const next = loadFindBookBookshelf().map((b) => {
    if (bookshelfBookKey(b.bookUrl, b.origin) !== key) return b;
    changed = true;
    return {
      ...b,
      ...(cover.coverUrl ? { coverUrl: cover.coverUrl } : {}),
      ...(cover.coverSourceUrl ? { coverSourceUrl: cover.coverSourceUrl } : {}),
    };
  });
  if (!changed) return null;
  saveFindBookBookshelf(next);
  return next;
}

/** 更新书架书籍信息（保留阅读进度与排序相关字段） */
export function updateFindBookBookshelfBookInfo(
  bookUrl: string,
  origin: string,
  patch: BookshelfBookInfoPatch,
): BookshelfBook[] | null {
  const key = bookshelfBookKey(bookUrl, origin);
  let changed = false;
  const next = loadFindBookBookshelf().map((b) => {
    if (bookshelfBookKey(b.bookUrl, b.origin) !== key) return b;
    changed = true;
    const merged: BookshelfBook = { ...b };
    if (patch.name?.trim()) merged.name = patch.name.trim();
    if (patch.author?.trim()) merged.author = patch.author.trim();
    if (patch.intro !== undefined) merged.intro = patch.intro;
    if (patch.coverUrl?.trim()) merged.coverUrl = patch.coverUrl.trim();
    if (patch.coverSourceUrl?.trim()) {
      merged.coverSourceUrl = patch.coverSourceUrl.trim();
    }
    if (patch.lastChapter?.trim()) merged.lastChapter = patch.lastChapter.trim();
    if (patch.kind !== undefined) merged.kind = patch.kind;
    if (patch.wordCount !== undefined) merged.wordCount = patch.wordCount;
    if (patch.updateTime?.trim()) merged.updateTime = patch.updateTime.trim();
    if (patch.bookUrl?.trim() && patch.bookUrl.trim() !== b.bookUrl) {
      merged.bookUrl = patch.bookUrl.trim();
    }
    if (patch.tocUrl?.trim()) merged.tocUrl = patch.tocUrl.trim();
    if (patch.chapters?.length) {
      merged.chapters = patch.chapters;
      // 对齐 Legado BookChapterList：有目录后用最新章标题覆盖 lastChapter
      const tocLatest = resolveLatestChapterTitleFromToc(patch.chapters);
      if (tocLatest) merged.lastChapter = tocLatest;
      else if (patch.lastChapter?.trim()) {
        merged.lastChapter = patch.lastChapter.trim();
      }
    }
    return merged;
  });
  if (!changed) return null;
  saveFindBookBookshelf(next);
  return next;
}

/** 设置书架书籍是否允许更新 */
export function setFindBookBookshelfCanUpdate(
  bookUrl: string,
  origin: string,
  canUpdate: boolean,
): BookshelfBook[] | null {
  const key = bookshelfBookKey(bookUrl, origin);
  let changed = false;
  const next = loadFindBookBookshelf().map((b) => {
    if (bookshelfBookKey(b.bookUrl, b.origin) !== key) return b;
    const prev = b.canUpdate !== false;
    if (prev === canUpdate) return b;
    changed = true;
    if (canUpdate) {
      const { canUpdate: _, ...rest } = b;
      return rest as BookshelfBook;
    }
    return { ...b, canUpdate: false };
  });
  if (!changed) return null;
  saveFindBookBookshelf(next);
  return next;
}

export function removeFromFindBookBookshelf(
  bookUrl: string,
  origin: string,
): BookshelfBook[] {
  const key = bookshelfBookKey(bookUrl, origin);
  const next = loadFindBookBookshelf().filter(
    (b) => bookshelfBookKey(b.bookUrl, b.origin) !== key,
  );
  saveFindBookBookshelf(next);
  return next;
}

/** 更新书架书籍的最后阅读章节（仅当已在书架中时生效） */
export function updateFindBookBookshelfReadProgress(
  bookUrl: string,
  origin: string,
  chapterIndex: number,
  chapterTitle?: string,
): BookshelfBook[] | null {
  if (!Number.isFinite(chapterIndex) || chapterIndex < 0) return null;
  const key = bookshelfBookKey(bookUrl, origin);
  const idx = Math.floor(chapterIndex);
  let changed = false;
  const next = loadFindBookBookshelf().map((b) => {
    if (bookshelfBookKey(b.bookUrl, b.origin) !== key) return b;
    changed = true;
    // 对齐 Legado durChapterTitle：未传标题时从目录缓存按下标取
    let title = chapterTitle?.trim() ?? "";
    if (!title) {
      const fromToc = bookshelfContentChapters(b)[idx]?.title?.trim() ?? "";
      title = fromToc;
    }
    return {
      ...b,
      lastReadChapterIndex: idx,
      lastReadAt: Date.now(),
      ...(title ? { lastReadChapterTitle: title } : {}),
    };
  });
  if (!changed) return null;
  saveFindBookBookshelf(next);
  return next;
}
