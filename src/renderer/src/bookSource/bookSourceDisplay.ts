import { formatLegadoBookAuthor } from "@shared/bookSource/formatBookAuthor";

/** 书籍列表作者行：净化后补「作者：」前缀（对齐 Legado 展示） */
export function formatBookAuthor(author: string | undefined): string {
  const a = formatLegadoBookAuthor(author) || "未知";
  return `作者：${a}`;
}

/** 默认封面作者标签 */
export function formatCoverAuthor(author: string | undefined): string {
  return formatLegadoBookAuthor(author) || "未知";
}

export {
  getBookKindList,
  splitBookMetaTags,
} from "@shared/bookSource/bookMetaTags";

/** 简介展示：保留段首全角缩进；换行转 &lt;br&gt;，不依赖 CSS white-space */
export function formatBookIntroForDisplay(intro: string | undefined | null): string {
  const raw = intro ?? "";
  if (!raw.trim()) return "";
  return raw.trimEnd();
}

/** 详情简介 HTML（转义 + 换行），供 v-html 使用 */
export function formatBookIntroHtmlForDisplay(intro: string | undefined | null): string {
  const text = formatBookIntroForDisplay(intro);
  if (!text) return "";
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\r\n|\r|\n/g, "<br>");
}
