import type * as monaco from "monaco-editor";
import { Emitter } from "monaco-editor";
import { chapterTitleForDisplay } from "../chapter";

/** 与 `setChapters` / 粘性滚动大纲一致的单条章节信息 */
export type ChapterStickyLine = { title: string; lineNumber: number };

/** 正文里章节标题行的装饰 class，需与样式中的选择器一致 */
export const CHAPTER_TITLE_LINE_CLASS = "chapterTitleLine";

const STICKY_NO_CLICK_STYLE_ID = "txtr-monaco-sticky-chapter-no-click";

/**
 * 禁止点击粘性章节条触发 Monaco 内部跳转（全局一次注入即可）。
 */
export function ensureStickyChapterBarClickDisabled(): void {
  if (document.getElementById(STICKY_NO_CLICK_STYLE_ID)) return;
  const el = document.createElement("style");
  el.id = STICKY_NO_CLICK_STYLE_ID;
  el.textContent = `
.monaco-editor .sticky-widget {
  pointer-events: none !important;
  background-color: var(--reader-bg) !important;
}
/* 子区域仍用 VS Code 变量；编辑器背景透明后需与阅读区底色一致，避免透出正文 */
.monaco-editor .sticky-widget .sticky-widget-line-numbers {
  background-color: var(--reader-bg) !important;
}
.monaco-editor .sticky-widget .sticky-widget-lines-scrollable {
  background-color: var(--reader-bg) !important;
}
.monaco-editor .sticky-widget .sticky-line-content:hover {
  background-color: var(--reader-bg) !important;
}
`;
  document.head.appendChild(el);
}

export type ChapterStickyScrollProvidersHandle = {
  disposable: monaco.IDisposable;
  /**
   * 章节行号已更新但模型未发生内容变更时调用（如「刷新章节」仅重算行号），
   * 触发折叠区失效，使粘性条按 `getChapters` 重新拉取折叠/大纲范围。
   */
  notifyChapterFoldingRangesChanged: () => void;
};

/**
 * 注册折叠区与文档符号，使粘性滚动按章节层级显示章节名。
 * `getChapters` 应在每次 `setChapters` 后返回最新快照。
 */
export function registerChapterStickyScrollProviders(
  monacoApi: typeof monaco,
  languageId: string,
  getChapters: () => ChapterStickyLine[],
): ChapterStickyScrollProvidersHandle {
  const disposables: monaco.IDisposable[] = [];
  const foldingRangesChanged = new Emitter<monaco.languages.FoldingRangeProvider>();

  const foldingProvider: monaco.languages.FoldingRangeProvider = {
    onDidChange: foldingRangesChanged.event,
    provideFoldingRanges(model) {
      const max = model.getLineCount();
      const sorted = getChapters()
        .filter((c) => c.lineNumber >= 1 && c.lineNumber <= max)
        .slice()
        .sort((a, b) => a.lineNumber - b.lineNumber);

      const ranges: monaco.languages.FoldingRange[] = [];
      for (let i = 0; i < sorted.length; i++) {
        const start = sorted[i].lineNumber;
        const nextStart = sorted[i + 1]?.lineNumber ?? max + 1;
        const end = Math.max(start, Math.min(max, nextStart - 1));
        if (end <= start) continue;
        ranges.push({
          start,
          end,
          kind: monacoApi.languages.FoldingRangeKind.Region,
        });
      }
      return ranges;
    },
  };

  disposables.push(
    monacoApi.languages.registerFoldingRangeProvider(
      languageId,
      foldingProvider,
    ),
  );

  disposables.push(
    monacoApi.languages.registerDocumentSymbolProvider(languageId, {
      provideDocumentSymbols(model) {
        const max = model.getLineCount();
        const sorted = getChapters()
          .filter((c) => c.lineNumber >= 1 && c.lineNumber <= max)
          .slice()
          .sort((a, b) => a.lineNumber - b.lineNumber);

        const symbols: monaco.languages.DocumentSymbol[] = [];
        for (let i = 0; i < sorted.length; i++) {
          const ch = sorted[i];
          const start = ch.lineNumber;
          const nextStart = sorted[i + 1]?.lineNumber ?? max + 1;
          const end = Math.max(start, Math.min(max, nextStart - 1));
          const range = new monacoApi.Range(
            start,
            1,
            end,
            model.getLineMaxColumn(end),
          );
          const selectionRange = new monacoApi.Range(
            start,
            1,
            start,
            model.getLineMaxColumn(start),
          );

          const name =
            chapterTitleForDisplay(ch.title) ||
            chapterTitleForDisplay(model.getLineContent(start)) ||
            `第 ${start} 行`;
          symbols.push({
            name,
            detail: "",
            kind: monacoApi.languages.SymbolKind.Namespace,
            range,
            selectionRange,
            tags: [],
            children: [],
          });
        }
        return symbols;
      },
    }),
  );

  disposables.push({ dispose: () => foldingRangesChanged.dispose() });

  return {
    disposable: {
      dispose() {
        for (const d of disposables) d.dispose();
      },
    },
    notifyChapterFoldingRangesChanged: () => {
      foldingRangesChanged.fire(foldingProvider);
    },
  };
}
