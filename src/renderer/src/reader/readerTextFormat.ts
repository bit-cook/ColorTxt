import type { ReaderDisplayFormatOptions } from "./readerDisplayPipeline";
import {
  formatPhysicalLinesForReader,
  formatPhysicalPlainTextForReader,
} from "./readerDisplayPipeline";

function normalizeNewlines(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export type CompressBlankFormatResult = {
  text: string;
  displayLineToPhysicalLine: number[];
};

/** 编辑模式：仅压缩空行（不含行首缩进，除非 options 指定） */
export function formatPlainTextCompressBlankLinesWithMap(
  text: string,
  keepOneBlank: boolean,
  extra?: Pick<ReaderDisplayFormatOptions, "leadIndentFullWidth">,
): CompressBlankFormatResult {
  const lines = normalizeNewlines(text).split("\n");
  const result = formatPhysicalLinesForReader(lines, {
    compressBlankLines: true,
    compressBlankKeepOneBlank: keepOneBlank,
    leadIndentFullWidth: extra?.leadIndentFullWidth ?? false,
  });
  return {
    text: result.text,
    displayLineToPhysicalLine: result.displayLineToPhysicalLine,
  };
}

export function formatPlainTextCompressBlankLines(
  text: string,
  keepOneBlank: boolean,
): string {
  return formatPlainTextCompressBlankLinesWithMap(text, keepOneBlank).text;
}

/** 编辑模式：仅行首全角缩进 */
export function formatPlainTextLeadIndentFullWidth(text: string): string {
  return formatPhysicalPlainTextForReader(text, {
    compressBlankLines: false,
    compressBlankKeepOneBlank: false,
    leadIndentFullWidth: true,
  }).text;
}
