import {
  applyLeadIndentFullWidth,
  detectChapterTitle,
  filterChaptersByMinCharCount,
  type Chapter,
} from "../chapter";
import { isBlankPhysicalLineContent } from "./lineMapping";
import { countCharsForLine } from "../utils/format";

export type ReaderDisplayFormatOptions = {
  compressBlankLines: boolean;
  compressBlankKeepOneBlank: boolean;
  leadIndentFullWidth: boolean;
};

export type ReaderDisplayFormatResult = {
  text: string;
  /** 展示行号 i（1-based）→ 源物理行号 */
  displayLineToPhysicalLine: number[];
  lineCount: number;
  charCount: number;
};

function normalizeNewlines(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function lineForReaderDisplay(
  rawLine: string,
  leadIndentFullWidth: boolean,
): string {
  return leadIndentFullWidth
    ? applyLeadIndentFullWidth(rawLine)
    : rawLine;
}

/**
 * 由源文件物理行生成阅读器展示正文（压缩空行 / 行首缩进可组合）。
 * 只读加载完成、顶栏切换展示选项、编辑模式「格式化」均走此函数。
 */
export function formatPhysicalLinesForReader(
  physicalLines: readonly string[],
  options: ReaderDisplayFormatOptions,
): ReaderDisplayFormatResult {
  if (!options.compressBlankLines) {
    const out: string[] = [];
    const displayLineToPhysicalLine: number[] = [];
    let charCount = 0;
    let physicalLine = 0;
    for (const rawLine of physicalLines) {
      physicalLine += 1;
      const shown = lineForReaderDisplay(rawLine, options.leadIndentFullWidth);
      out.push(shown);
      displayLineToPhysicalLine.push(physicalLine);
      charCount += countCharsForLine(shown);
    }
    return {
      text: out.join("\n"),
      displayLineToPhysicalLine,
      lineCount: out.length,
      charCount,
    };
  }

  const keepOneBlank = options.compressBlankKeepOneBlank;
  const blanksAbove = keepOneBlank ? 1 : 2;
  const out: string[] = [];
  const displayLineToPhysicalLine: number[] = [];
  let charCount = 0;

  const pushDisplay = (lineText: string, physicalLine: number) => {
    displayLineToPhysicalLine.push(physicalLine);
    out.push(lineText);
    charCount += countCharsForLine(lineText);
  };

  let physicalLine = 0;
  for (const rawLine of physicalLines) {
    physicalLine += 1;
    if (isBlankPhysicalLineContent(rawLine)) continue;
    const shown = lineForReaderDisplay(rawLine, options.leadIndentFullWidth);
    const title = detectChapterTitle(rawLine);
    if (title) {
      for (let i = 0; i < blanksAbove; i += 1) {
        pushDisplay("", physicalLine);
      }
      pushDisplay(shown, physicalLine);
      pushDisplay("", physicalLine);
    } else {
      pushDisplay(shown, physicalLine);
      if (keepOneBlank) pushDisplay("", physicalLine);
    }
  }

  return {
    text: out.join("\n"),
    displayLineToPhysicalLine,
    lineCount: out.length,
    charCount,
  };
}

export function formatPhysicalPlainTextForReader(
  physicalPlainText: string,
  options: ReaderDisplayFormatOptions,
): ReaderDisplayFormatResult {
  const normalized = normalizeNewlines(physicalPlainText);
  const lines = normalized.length > 0 ? normalized.split("\n") : [];
  return formatPhysicalLinesForReader(lines, options);
}

export type BuildChaptersFromDisplayOptions = {
  minCharCount: number;
  /** 电子书行首内链标签：展示行号 → 标签文案列表 */
  leadingLinkLabelsByDisplayLine?: ReadonlyMap<
    number,
    readonly string[]
  >;
};

/**
 * 对当前 Monaco **展示**全文匹配章节并统计字数（加载后 / 规则变更 / 刷新章节共用）。
 */
export function buildChaptersFromReaderDisplayText(
  displayText: string,
  options: BuildChaptersFromDisplayOptions,
): Chapter[] {
  const normalized = normalizeNewlines(displayText);
  const lines = normalized.length > 0 ? normalized.split("\n") : [];
  const leadingLinkLabels =
    options.leadingLinkLabelsByDisplayLine ??
    new Map<number, readonly string[]>();

  const next: Chapter[] = [];
  let lineNo = 0;
  let currentIdx = -1;

  for (const rawLine of lines) {
    lineNo += 1;
    const title = detectChapterTitle(rawLine);
    if (title) {
      const labels = leadingLinkLabels.get(lineNo);
      if (labels && labels.length > 0) {
        const t = title.trim();
        const fromLeadingLink = labels.some((lab) => {
          const L = lab.trim();
          return L.length > 0 && t.startsWith(L);
        });
        if (fromLeadingLink) {
          if (currentIdx >= 0) {
            next[currentIdx]!.charCount += countCharsForLine(rawLine);
          }
          continue;
        }
      }
      next.push({ title, lineNumber: lineNo, charCount: 0 });
      currentIdx = next.length - 1;
      continue;
    }
    if (currentIdx >= 0) {
      next[currentIdx]!.charCount += countCharsForLine(rawLine);
    }
  }

  return filterChaptersByMinCharCount(next, options.minCharCount);
}
