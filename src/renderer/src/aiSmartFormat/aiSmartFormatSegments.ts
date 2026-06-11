import type { Chapter } from "../chapter";

export type SmartFormatSegmentPlan = {
  id: string;
  /** 任务开始时 1-based 行号（写回前须叠加 lineDelta） */
  startLine: number;
  endLine: number;
};

export const SMART_FORMAT_LONG_SELECTION_CHARS = 6000;
export const SMART_FORMAT_CHUNK_MAX_CHARS = 8000;

function splitTextByMaxChars(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];
  const parts: string[] = [];
  let i = 0;
  while (i < text.length) {
    let end = Math.min(i + maxChars, text.length);
    if (end < text.length) {
      const nl = text.lastIndexOf("\n", end);
      if (nl > i + Math.floor(maxChars * 0.4)) end = nl + 1;
    }
    parts.push(text.slice(i, end));
    i = end;
  }
  return parts;
}

function linesFromModelText(
  fullText: string,
  startLine: number,
  endLine: number,
): string {
  const lines = fullText.split("\n");
  const start = Math.max(1, Math.min(startLine, lines.length));
  const end = Math.max(start, Math.min(endLine, lines.length));
  return lines.slice(start - 1, end).join("\n");
}

function appendSegmentsForLineRange(
  plans: SmartFormatSegmentPlan[],
  fullText: string,
  startLine: number,
  endLine: number,
  idPrefix: string,
  maxSingleChars: number,
  chunkMaxChars: number,
): void {
  if (startLine > endLine) return;
  const text = linesFromModelText(fullText, startLine, endLine);
  if (text.length <= maxSingleChars) {
    plans.push({ id: `${idPrefix}-0`, startLine, endLine });
    return;
  }
  const chunks = splitTextByMaxChars(text, chunkMaxChars);
  let lineCursor = startLine;
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]!;
    const n = chunk.length > 0 ? chunk.split("\n").length : 1;
    const chunkEnd = Math.min(endLine, lineCursor + n - 1);
    plans.push({
      id: `${idPrefix}-${i}`,
      startLine: lineCursor,
      endLine: chunkEnd,
    });
    lineCursor = chunkEnd + 1;
  }
}

/** 全文：按章节切分（含第一章前内容）；超长章再按字数切块；无章节则整文切块 */
export function planFullTextSegments(
  lineCount: number,
  chapters: readonly Chapter[],
  fullText: string,
): SmartFormatSegmentPlan[] {
  if (lineCount < 1) return [];
  if (chapters.length > 0) {
    const plans: SmartFormatSegmentPlan[] = [];
    const firstChapterLine = chapters[0]!.lineNumber;
    if (firstChapterLine > 1) {
      appendSegmentsForLineRange(
        plans,
        fullText,
        1,
        firstChapterLine - 1,
        "pre",
        SMART_FORMAT_CHUNK_MAX_CHARS,
        SMART_FORMAT_CHUNK_MAX_CHARS,
      );
    }
    for (let i = 0; i < chapters.length; i++) {
      const startLine = chapters[i]!.lineNumber;
      const endLine =
        i + 1 < chapters.length
          ? chapters[i + 1]!.lineNumber - 1
          : lineCount;
      if (startLine > endLine || startLine > lineCount) continue;
      appendSegmentsForLineRange(
        plans,
        fullText,
        startLine,
        Math.min(endLine, lineCount),
        `ch-${i}`,
        SMART_FORMAT_CHUNK_MAX_CHARS,
        SMART_FORMAT_CHUNK_MAX_CHARS,
      );
    }
    if (plans.length > 0) return plans;
  }

  const plans: SmartFormatSegmentPlan[] = [];
  appendSegmentsForLineRange(
    plans,
    fullText,
    1,
    lineCount,
    "blk",
    SMART_FORMAT_CHUNK_MAX_CHARS,
    SMART_FORMAT_CHUNK_MAX_CHARS,
  );
  return plans;
}

/** 选区：短则单段，长则按块切分（行号相对于全文） */
export function planSelectionSegments(
  fullText: string,
  selStartLine: number,
  selEndLine: number,
): SmartFormatSegmentPlan[] {
  const plans: SmartFormatSegmentPlan[] = [];
  appendSegmentsForLineRange(
    plans,
    fullText,
    selStartLine,
    selEndLine,
    "sel",
    SMART_FORMAT_LONG_SELECTION_CHARS,
    SMART_FORMAT_CHUNK_MAX_CHARS,
  );
  return plans;
}

export function countLinesInText(text: string): number {
  if (!text) return 0;
  return text.split("\n").length;
}

export function lineDeltaAfterReplace(
  oldText: string,
  newText: string,
): number {
  return countLinesInText(newText) - countLinesInText(oldText);
}
