import { nextTick, type Ref } from "vue";
import { applyLeadIndentFullWidth } from "../chapter";
import type ReaderMain from "../components/ReaderMain.vue";
import {
  physicalLineToFilteredDisplayLine,
  physicalLineToLastFilteredDisplayLine,
} from "../reader/lineMapping";
import { formatPhysicalLinesForReader } from "../reader/readerDisplayPipeline";
import {
  countCharsForLine,
  floorReadingProgressPercentByLines,
} from "../utils/format";
import { createPhysicalLineSplitter } from "../services/physicalLineStream";

type ReaderRef = Ref<InstanceType<typeof ReaderMain> | null>;

/**
 * txt 流式读盘：仅累积物理行与加载进度；展示格式化与章节匹配在加载完成后统一处理。
 */
export function useTxtStreamPipeline(deps: {
  readerRef: ReaderRef;
  totalCharCount: Ref<number>;
  totalLineCount: Ref<number>;
  compressBlankLines: Ref<boolean>;
  compressBlankKeepOneBlank: Ref<boolean>;
  leadIndentFullWidth: Ref<boolean>;
  /** 展示正文写入 Monaco 且插图/内链处理完成后 */
  afterFullTextInstalled: () => void | Promise<void>;
}) {
  const lineSplitter = createPhysicalLineSplitter();

  /** Monaco 展示行数（滤空后与物理行数可能不同） */
  let lineCount = 0;
  /** 源文件物理行（含空行）；加载阶段只 push，行/字数在格式化完成后写入 ref */
  let physicalLineContents: string[] = [];
  /** 展示行号 i（1-based）→ 物理行号 */
  let filteredDisplayToPhysicalLine: number[] = [];

  function lineForReaderDisplay(rawLine: string): string {
    return deps.leadIndentFullWidth.value
      ? applyLeadIndentFullWidth(rawLine)
      : rawLine;
  }

  function viewportDisplayLineToPhysicalLine(displayLine: number): number {
    const v = Math.max(1, Math.floor(displayLine));
    if (!deps.compressBlankLines.value) return v;
    const idx = v - 1;
    if (idx < 0) return 1;
    if (idx >= filteredDisplayToPhysicalLine.length) {
      return (
        filteredDisplayToPhysicalLine[
          filteredDisplayToPhysicalLine.length - 1
        ] ?? 1
      );
    }
    return filteredDisplayToPhysicalLine[idx]!;
  }

  function physicalLineToDisplayForReader(physicalLine: number): number {
    if (!deps.compressBlankLines.value) {
      return Math.max(1, Math.floor(physicalLine));
    }
    const map = filteredDisplayToPhysicalLine;
    const p = Math.max(1, Math.floor(physicalLine));
    const raw = physicalLineContents[p - 1] ?? "";
    const wantShown = lineForReaderDisplay(raw);

    if (wantShown.length > 0) {
      const reader = deps.readerRef.value;
      const getEditorLineContent = reader?.getEditorLineContent;
      if (reader && typeof getEditorLineContent === "function") {
        for (let i = 0; i < map.length; i++) {
          if (map[i] !== p) continue;
          if (getEditorLineContent.call(reader, i + 1) === wantShown) {
            return i + 1;
          }
        }
      }
    }

    return physicalLineToFilteredDisplayLine(p, map);
  }

  function physicalLineToBottomDisplayForReader(physicalLine: number): number {
    if (!deps.compressBlankLines.value) {
      return Math.max(1, Math.floor(physicalLine));
    }
    return physicalLineToLastFilteredDisplayLine(
      physicalLine,
      filteredDisplayToPhysicalLine,
    );
  }

  function calcProgressPercentByPhysicalLine(
    physicalLine: number,
  ): number | undefined {
    const total = physicalLineContents.length;
    if (total <= 0) return undefined;
    const current = Math.min(total, Math.max(1, Math.floor(physicalLine)));
    return floorReadingProgressPercentByLines(current, total);
  }

  function calcProgressPercentByViewportDisplay(
    topDisplayLine: number,
    bottomDisplayLine: number,
  ): number | undefined {
    const totalDisplay = deps.totalLineCount.value;
    if (totalDisplay <= 0) return undefined;
    const top = Math.min(totalDisplay, Math.max(1, Math.floor(topDisplayLine)));
    const bottom = Math.min(
      totalDisplay,
      Math.max(1, Math.floor(bottomDisplayLine)),
    );
    if (bottom >= totalDisplay) return 100;
    if (top === 1) return 0;
    const physical = viewportDisplayLineToPhysicalLine(bottomDisplayLine);
    return calcProgressPercentByPhysicalLine(physical);
  }

  function resetStreamInternals() {
    lineCount = 0;
    physicalLineContents = [];
    filteredDisplayToPhysicalLine = [];
    lineSplitter.reset();
  }

  /**
   * 从阅读器模型同步镜像（插图删行等外部改动后）。
   * 滤空模式下勿把 map 写成 1..N。
   */
  function syncMirrorFromReaderModel() {
    const text = deps.readerRef.value?.getAllText() ?? "";
    const lines = text.length > 0 ? text.split("\n") : [""];
    let c = 0;
    for (const ln of lines) {
      c += countCharsForLine(ln);
    }
    deps.totalCharCount.value = c;

    if (!deps.compressBlankLines.value) {
      physicalLineContents = lines;
      lineCount = lines.length;
      deps.totalLineCount.value = lineCount;
      filteredDisplayToPhysicalLine = lines.map((_, i) => i + 1);
      return;
    }

    lineCount = filteredDisplayToPhysicalLine.length;
    deps.totalLineCount.value = lineCount;
  }

  function processChunk(chunk: string) {
    const parts = lineSplitter.push(chunk);
    for (const rawLine of parts) {
      physicalLineContents.push(rawLine);
    }
  }

  function restoreViewportAfterDisplayChange(
    restorePhysicalLine: number | undefined,
  ): Promise<void> {
    const r = deps.readerRef.value;
    if (!r || restorePhysicalLine == null) return Promise.resolve();
    const totalPhysical = physicalLineContents.length;
    const phys = Math.min(
      totalPhysical,
      Math.max(1, Math.floor(restorePhysicalLine)),
    );
    return new Promise((resolve) => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (phys >= totalPhysical) {
            r.scrollToBottom?.(false);
          } else if (phys <= 1) {
            r.jumpToLine?.(1, false);
          } else {
            const jumpLine = physicalLineToBottomDisplayForReader(phys);
            if (jumpLine <= 1) {
              r.jumpToLine?.(1, false);
            } else {
              r.scrollLineToBottom?.(jumpLine, false);
            }
          }
          void nextTick(() => {
            r.normalizeScrollAfterEmbeddedViewZones?.();
            r.emitProbeLine?.();
            resolve();
          });
        });
      });
    });
  }

  /**
   * 由已缓存的物理行生成展示正文并写入 Monaco（加载完成 / 切换压缩或缩进 / 保留一空行设置）。
   */
  async function applyReaderDisplayFromPhysicalLines(
    restorePhysicalLine?: number,
  ): Promise<boolean> {
    const r = deps.readerRef.value;
    if (!r) return false;

    const formatted = formatPhysicalLinesForReader(physicalLineContents, {
      compressBlankLines: deps.compressBlankLines.value,
      compressBlankKeepOneBlank: deps.compressBlankKeepOneBlank.value,
      leadIndentFullWidth: deps.leadIndentFullWidth.value,
    });

    filteredDisplayToPhysicalLine = formatted.displayLineToPhysicalLine;
    lineCount = formatted.lineCount;
    deps.totalCharCount.value = formatted.charCount;
    deps.totalLineCount.value = formatted.lineCount;

    await r.setFullText(formatted.text);
    if (deps.leadIndentFullWidth.value) {
      r.normalizeLastLineLeadIndent?.();
    }
    await deps.afterFullTextInstalled();
    await restoreViewportAfterDisplayChange(restorePhysicalLine);
    return true;
  }

  async function finalizeReaderMonaco(restorePhysicalLine?: number) {
    await applyReaderDisplayFromPhysicalLines(restorePhysicalLine);
  }

  async function flushCarry() {
    try {
      const tail = lineSplitter.flushEof();
      if (tail != null) {
        physicalLineContents.push(tail);
      }
    } finally {
      await finalizeReaderMonaco();
    }
  }

  function getPhysicalLineCount(): number {
    return physicalLineContents.length;
  }

  function getLineCount(): number {
    return lineCount;
  }

  function getPhysicalLineContent(physicalLine: number) {
    const idx = Math.max(0, Math.floor(physicalLine) - 1);
    return physicalLineContents[idx] ?? "";
  }

  function getPhysicalFilePlainText(): string {
    if (physicalLineContents.length === 0) return "";
    return physicalLineContents.join("\n");
  }

  function resyncMirrorFromReader() {
    syncMirrorFromReaderModel();
  }

  function removeFilteredDisplayLinesAtOriginalIndices(
    deletedOriginalLineNumbersDesc: readonly number[],
  ) {
    if (!deps.compressBlankLines.value || deletedOriginalLineNumbersDesc.length === 0) {
      return;
    }
    for (const lineNum of deletedOriginalLineNumbersDesc) {
      const idx = Math.floor(lineNum) - 1;
      if (idx >= 0 && idx < filteredDisplayToPhysicalLine.length) {
        filteredDisplayToPhysicalLine.splice(idx, 1);
      }
    }
    lineCount = filteredDisplayToPhysicalLine.length;
    deps.totalLineCount.value = lineCount;
  }

  return {
    processChunk,
    flushCarry,
    resetStreamInternals,
    viewportDisplayLineToPhysicalLine,
    physicalLineToDisplayForReader,
    physicalLineToBottomDisplayForReader,
    calcProgressPercentByPhysicalLine,
    calcProgressPercentByViewportDisplay,
    getPhysicalLineCount,
    getLineCount,
    getPhysicalLineContent,
    getPhysicalFilePlainText,
    resyncMirrorFromReader,
    removeFilteredDisplayLinesAtOriginalIndices,
    applyReaderDisplayFromPhysicalLines,
  };
}
