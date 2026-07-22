import {
  clampLineHeightMultipleForFontSize,
  defaultCompressBlankKeepOneBlank,
  defaultCompressBlankLines,
  defaultFullscreenReaderWidthPercent,
  defaultFullscreenShowSystemTime,
  defaultShowSidebar,
  defaultLeadIndentFullWidth,
  defaultMonacoAdvancedWrapping,
  defaultMonacoCustomHighlight,
  defaultMonacoSmoothScrolling,
  defaultReaderEditMinimap,
  defaultReaderEditShowLineNumbers,
  defaultReaderFontSize,
  defaultStickyChapterTitleEnabled,
  defaultTxtrDelimitedMatchCrossLine,
  FIND_BOOK_SIDEBAR_MIN_WIDTH,
  normalizeLineHeightMultiple,
  persistKey,
  SIDEBAR_ACTIVITY_BAR_WIDTH,
} from "../../constants/appUi";
import {
  defaultTimedScrollIntervalMs,
  defaultTimedScrollRange,
  mergeTimedScrollSettings,
  type TimedScrollSettings,
} from "../../constants/timedScroll";
import {
  mergePomodoroSettings,
  type PomodoroSettings,
} from "../../constants/pomodoro";
import { READER_EDITOR_DEFAULT_FONT_FAMILY } from "../../monaco/readerEditorOptions";
import { loadPersistedSettingsData } from "../../stores/cacheStore";
import { resolveDefaultBookSourceDownloadDirSync, resolveDefaultBookSourceChapterCacheDirSync } from "../../utils/defaultCacheDirs";
import type {
  TextConvertWidthMode,
  TextConvertZhMode,
} from "@shared/textConvertTypes";
import {
  DEFAULT_FIND_BOOK_DOWNLOAD_AFTER_ACTION,
  DEFAULT_FIND_BOOK_DOWNLOAD_CATEGORY,
  DEFAULT_FIND_BOOK_PROXY_SETTINGS,
  defaultFindBookChapterNavToolbarEnabled,
  defaultFindBookShowChapterTag,
  findBookSettingsKey,
  isFindBookDownloadAfterAction,
  normalizeFindBookProxySettings,
  type FindBookDownloadAfterAction,
  type FindBookProxySettings,
  type PersistedFindBookSettings,
} from "../constants/findBookSettings";

function safeParseFindBookSettings(raw: string | null): PersistedFindBookSettings {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    return parsed as PersistedFindBookSettings;
  } catch {
    return {};
  }
}

function loadRawFindBookSettings(): PersistedFindBookSettings {
  try {
    return safeParseFindBookSettings(localStorage.getItem(findBookSettingsKey));
  } catch {
    return {};
  }
}

function seedFromMainSettings(
  data: PersistedFindBookSettings,
): PersistedFindBookSettings {
  const main = loadPersistedSettingsData(localStorage, persistKey)?.data ?? {};
  const out: PersistedFindBookSettings = { ...data };

  const copyIfUndef = <K extends keyof PersistedFindBookSettings>(
    key: K,
    value: PersistedFindBookSettings[K] | undefined,
  ) => {
    if (out[key] === undefined && value !== undefined) {
      out[key] = value;
    }
  };

  copyIfUndef("fontSize", main.fontSize);
  copyIfUndef("lineHeightMultiple", main.lineHeightMultiple);
  copyIfUndef("fontFamily", main.fontFamily);
  copyIfUndef("pinnedOtherFonts", main.pinnedOtherFonts);
  copyIfUndef("monacoCustomHighlight", main.monacoCustomHighlight);
  copyIfUndef("txtrDelimitedMatchCrossLine", main.txtrDelimitedMatchCrossLine);
  copyIfUndef("compressBlankLines", main.compressBlankLines);
  copyIfUndef("compressBlankKeepOneBlank", main.compressBlankKeepOneBlank);
  copyIfUndef("leadIndentFullWidth", main.leadIndentFullWidth);
  copyIfUndef("textConvertZh", main.textConvertZh as TextConvertZhMode | undefined);
  copyIfUndef(
    "textConvertLetter",
    main.textConvertLetter as TextConvertWidthMode | undefined,
  );
  copyIfUndef(
    "textConvertDigit",
    main.textConvertDigit as TextConvertWidthMode | undefined,
  );
  copyIfUndef("monacoAdvancedWrapping", main.monacoAdvancedWrapping);
  copyIfUndef("monacoSmoothScrolling", main.monacoSmoothScrolling);
  copyIfUndef("stickyChapterTitleEnabled", main.stickyChapterTitleEnabled);
  copyIfUndef("readerEditShowLineNumbers", main.readerEditShowLineNumbers);
  copyIfUndef("readerEditMinimap", main.readerEditMinimap);
  copyIfUndef("fullscreenReaderWidthPercent", main.fullscreenReaderWidthPercent);
  copyIfUndef("fullscreenShowSystemTime", main.fullscreenShowSystemTime);
  copyIfUndef("showSidebar", main.showSidebar);
  if (out.sidebarWidth === undefined && typeof main.sidebarWidth === "number") {
    out.sidebarWidth = Math.max(
      FIND_BOOK_SIDEBAR_MIN_WIDTH,
      Math.floor(main.sidebarWidth) - SIDEBAR_ACTIVITY_BAR_WIDTH,
    );
  }
  copyIfUndef("timedScroll", main.timedScroll);
  if (out.pomodoro === undefined && main.pomodoro) {
    out.pomodoro = main.pomodoro;
  }

  return out;
}

export function loadPersistedFindBookSettings(): PersistedFindBookSettings {
  return seedFromMainSettings(loadRawFindBookSettings());
}

export function persistFindBookSettings(patch: PersistedFindBookSettings) {
  const current = loadRawFindBookSettings();
  try {
    localStorage.setItem(
      findBookSettingsKey,
      JSON.stringify({ ...current, ...patch }),
    );
  } catch {
    // ignore
  }
}

export function snapshotFindBookSettingsFromStore(state: {
  cacheDir: string;
  downloadDir: string;
  downloadAfterAction: FindBookDownloadAfterAction;
  downloadAddToMainFileList: boolean;
  downloadDefaultCategory: string;
  proxy: FindBookProxySettings;
  readerFontSize: number;
  readerLineHeightMultiple: number;
  monacoFontFamily: string;
  pinnedOtherFonts: string[];
  monacoCustomHighlight: boolean;
  txtrDelimitedMatchCrossLine: boolean;
  compressBlankLines: boolean;
  compressBlankKeepOneBlank: boolean;
  leadIndentFullWidth: boolean;
  textConvertZh: TextConvertZhMode;
  textConvertLetter: TextConvertWidthMode;
  textConvertDigit: TextConvertWidthMode;
  monacoAdvancedWrapping: boolean;
  monacoSmoothScrolling: boolean;
  stickyChapterTitleEnabled: boolean;
  chapterNavToolbarEnabled: boolean;
  readerEditShowLineNumbers: boolean;
  readerEditMinimap: boolean;
  fullscreenReaderWidthPercent: number;
  fullscreenShowSystemTime: boolean;
  showSidebar: boolean;
  sidebarWidth: number;
  showChapterTag: boolean;
  timedScrollSettings: TimedScrollSettings;
  pomodoroSettings: PomodoroSettings;
}): PersistedFindBookSettings {
  return {
    cacheDir: state.cacheDir.trim(),
    downloadDir: state.downloadDir.trim(),
    downloadAfterAction: state.downloadAfterAction,
    downloadAddToMainFileList: state.downloadAddToMainFileList,
    downloadDefaultCategory: state.downloadDefaultCategory.trim(),
    proxy: normalizeFindBookProxySettings(state.proxy),
    fontSize: state.readerFontSize,
    lineHeightMultiple: state.readerLineHeightMultiple,
    fontFamily: state.monacoFontFamily,
    pinnedOtherFonts: state.pinnedOtherFonts,
    monacoCustomHighlight: state.monacoCustomHighlight,
    txtrDelimitedMatchCrossLine: state.txtrDelimitedMatchCrossLine,
    compressBlankLines: state.compressBlankLines,
    compressBlankKeepOneBlank: state.compressBlankKeepOneBlank,
    leadIndentFullWidth: state.leadIndentFullWidth,
    textConvertZh: state.textConvertZh,
    textConvertLetter: state.textConvertLetter,
    textConvertDigit: state.textConvertDigit,
    monacoAdvancedWrapping: state.monacoAdvancedWrapping,
    monacoSmoothScrolling: state.monacoSmoothScrolling,
    stickyChapterTitleEnabled: state.stickyChapterTitleEnabled,
    chapterNavToolbarEnabled: state.chapterNavToolbarEnabled,
    readerEditShowLineNumbers: state.readerEditShowLineNumbers,
    readerEditMinimap: state.readerEditMinimap,
    fullscreenReaderWidthPercent: state.fullscreenReaderWidthPercent,
    fullscreenShowSystemTime: state.fullscreenShowSystemTime,
    showSidebar: state.showSidebar,
    sidebarWidth: state.sidebarWidth,
    showChapterTag: state.showChapterTag,
    timedScroll: state.timedScrollSettings,
    pomodoro: state.pomodoroSettings,
  };
}

export function createInitialFindBookSettingsState() {
  const data = loadPersistedFindBookSettings();
  return {
    cacheDir:
      typeof data.cacheDir === "string" && data.cacheDir.trim()
        ? data.cacheDir.trim()
        : resolveDefaultBookSourceChapterCacheDirSync(),
    downloadDir:
      typeof data.downloadDir === "string" && data.downloadDir.trim()
        ? data.downloadDir.trim()
        : resolveDefaultBookSourceDownloadDirSync(),
    downloadAfterAction: isFindBookDownloadAfterAction(data.downloadAfterAction)
      ? data.downloadAfterAction
      : DEFAULT_FIND_BOOK_DOWNLOAD_AFTER_ACTION,
    downloadAddToMainFileList: data.downloadAddToMainFileList !== false,
    downloadDefaultCategory:
      data.downloadDefaultCategory === undefined
        ? DEFAULT_FIND_BOOK_DOWNLOAD_CATEGORY
        : typeof data.downloadDefaultCategory === "string"
          ? data.downloadDefaultCategory.trim()
          : "",
    proxy: normalizeFindBookProxySettings(
      data.proxy ?? DEFAULT_FIND_BOOK_PROXY_SETTINGS,
    ),
    readerFontSize:
      typeof data.fontSize === "number" ? data.fontSize : defaultReaderFontSize,
    readerLineHeightMultiple:
      typeof data.lineHeightMultiple === "number"
        ? normalizeLineHeightMultiple(data.lineHeightMultiple)
        : normalizeLineHeightMultiple(1.6),
    monacoFontFamily:
      typeof data.fontFamily === "string" && data.fontFamily.trim()
        ? data.fontFamily.trim()
        : READER_EDITOR_DEFAULT_FONT_FAMILY,
    pinnedOtherFonts: Array.isArray(data.pinnedOtherFonts)
      ? data.pinnedOtherFonts.filter((f) => typeof f === "string" && f.trim())
      : [],
    monacoCustomHighlight:
      typeof data.monacoCustomHighlight === "boolean"
        ? data.monacoCustomHighlight
        : defaultMonacoCustomHighlight,
    txtrDelimitedMatchCrossLine:
      typeof data.txtrDelimitedMatchCrossLine === "boolean"
        ? data.txtrDelimitedMatchCrossLine
        : defaultTxtrDelimitedMatchCrossLine,
    compressBlankLines:
      typeof data.compressBlankLines === "boolean"
        ? data.compressBlankLines
        : defaultCompressBlankLines,
    compressBlankKeepOneBlank:
      typeof data.compressBlankKeepOneBlank === "boolean"
        ? data.compressBlankKeepOneBlank
        : defaultCompressBlankKeepOneBlank,
    leadIndentFullWidth:
      typeof data.leadIndentFullWidth === "boolean"
        ? data.leadIndentFullWidth
        : defaultLeadIndentFullWidth,
    textConvertZh: (data.textConvertZh as TextConvertZhMode | undefined) ?? "off",
    textConvertLetter:
      (data.textConvertLetter as TextConvertWidthMode | undefined) ?? "off",
    textConvertDigit:
      (data.textConvertDigit as TextConvertWidthMode | undefined) ?? "off",
    monacoAdvancedWrapping:
      typeof data.monacoAdvancedWrapping === "boolean"
        ? data.monacoAdvancedWrapping
        : defaultMonacoAdvancedWrapping,
    monacoSmoothScrolling:
      typeof data.monacoSmoothScrolling === "boolean"
        ? data.monacoSmoothScrolling
        : defaultMonacoSmoothScrolling,
    stickyChapterTitleEnabled:
      typeof data.stickyChapterTitleEnabled === "boolean"
        ? data.stickyChapterTitleEnabled
        : defaultStickyChapterTitleEnabled,
    chapterNavToolbarEnabled:
      typeof data.chapterNavToolbarEnabled === "boolean"
        ? data.chapterNavToolbarEnabled
        : defaultFindBookChapterNavToolbarEnabled,
    readerEditShowLineNumbers:
      typeof data.readerEditShowLineNumbers === "boolean"
        ? data.readerEditShowLineNumbers
        : defaultReaderEditShowLineNumbers,
    readerEditMinimap:
      typeof data.readerEditMinimap === "boolean"
        ? data.readerEditMinimap
        : defaultReaderEditMinimap,
    fullscreenReaderWidthPercent:
      typeof data.fullscreenReaderWidthPercent === "number"
        ? data.fullscreenReaderWidthPercent
        : defaultFullscreenReaderWidthPercent,
    fullscreenShowSystemTime:
      typeof data.fullscreenShowSystemTime === "boolean"
        ? data.fullscreenShowSystemTime
        : defaultFullscreenShowSystemTime,
    showSidebar:
      typeof data.showSidebar === "boolean"
        ? data.showSidebar
        : defaultShowSidebar,
    sidebarWidth:
      typeof data.sidebarWidth === "number" && Number.isFinite(data.sidebarWidth)
        ? Math.max(
            FIND_BOOK_SIDEBAR_MIN_WIDTH,
            Math.floor(data.sidebarWidth),
          )
        : 270 - SIDEBAR_ACTIVITY_BAR_WIDTH,
    showChapterTag:
      typeof data.showChapterTag === "boolean"
        ? data.showChapterTag
        : defaultFindBookShowChapterTag,
    timedScrollSettings: mergeTimedScrollSettings(data.timedScroll),
    pomodoroSettings: mergePomodoroSettings(data.pomodoro),
  };
}

export function clampFindBookReaderLineHeight(
  fontSize: number,
  lineHeight: number,
): number {
  return clampLineHeightMultipleForFontSize(fontSize, lineHeight);
}

export {
  defaultTimedScrollIntervalMs,
  defaultTimedScrollRange,
};
