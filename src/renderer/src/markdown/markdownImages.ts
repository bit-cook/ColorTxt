import { dirnameFs, joinFs } from "../ebook/pathUtils";

const RE_MD_IMAGE = /!\[([^\]]*)\]\(([^)]+)\)/g;

function isRemoteImageUrl(url: string): boolean {
  return /^https?:\/\//i.test(url.trim());
}

function isAbsolutePathUrl(url: string): boolean {
  const u = url.trim();
  return /^[a-zA-Z]:[\\/]/.test(u) || u.startsWith("/");
}

/** 将 `![alt](url)` 的 url 转为 `<<IMG:payload>>` 中的 payload */
export function markdownImageUrlToImgPayload(
  url: string,
  mdFileAbsPath: string,
): string {
  const trimmed = url.trim();
  if (isRemoteImageUrl(trimmed)) return trimmed;
  if (isAbsolutePathUrl(trimmed)) {
    return trimmed.replace(/\\/g, "/");
  }
  const baseDir = dirnameFs(mdFileAbsPath.replace(/\\/g, "/"));
  return joinFs(baseDir, trimmed.replace(/\\/g, "/")).replace(/\\/g, "/");
}

function expandLineWithMarkdownImages(
  line: string,
  mdFileAbsPath: string,
): string[] {
  const matches: { index: number; length: number; payload: string }[] = [];
  let m: RegExpExecArray | null;
  RE_MD_IMAGE.lastIndex = 0;
  while ((m = RE_MD_IMAGE.exec(line)) !== null) {
    const url = m[2]?.trim() ?? "";
    if (!url) continue;
    matches.push({
      index: m.index,
      length: m[0].length,
      payload: markdownImageUrlToImgPayload(url, mdFileAbsPath),
    });
  }
  if (matches.length === 0) return [line];

  const out: string[] = [];
  let cursor = 0;
  for (const hit of matches) {
    const before = line.slice(cursor, hit.index);
    if (before.length > 0) out.push(before);
    out.push(`<<IMG:${hit.payload}>>`);
    cursor = hit.index + hit.length;
  }
  const tail = line.slice(cursor);
  if (tail.length > 0) out.push(tail);
  return out;
}

/** 将展示层全文中的 Markdown 图片语法展开为独占 `<<IMG:…>>` 行（一行一图） */
export function expandMarkdownImagesInPlainText(
  text: string,
  mdFileAbsPath: string,
): string {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.length > 0 ? normalized.split("\n") : [];
  const expanded: string[] = [];
  for (const line of lines) {
    expanded.push(...expandLineWithMarkdownImages(line, mdFileAbsPath));
  }
  return expanded.join("\n");
}
