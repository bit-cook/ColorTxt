import { computed, ref } from "vue";
import {
  createInitialFindBookSettingsState,
  persistFindBookSettings,
  snapshotFindBookSettingsFromStore,
} from "../services/findBookSettingsStore";
import {
  buildFindBookProxyUrl,
  type FindBookProxySettings,
} from "../constants/findBookSettings";
import {
  resolveDefaultBookSourceChapterCacheDirSync,
  resolveDefaultBookSourceDownloadDirSync,
} from "../../utils/defaultCacheDirs";

let store: ReturnType<typeof createFindBookSettingsStore> | null = null;

function createFindBookSettingsStore() {
  const initial = createInitialFindBookSettingsState();

  const cacheDir = ref(initial.cacheDir);
  const downloadDir = ref(initial.downloadDir);
  const downloadAfterAction = ref(initial.downloadAfterAction);
  const downloadAddToMainFileList = ref(initial.downloadAddToMainFileList);
  const downloadDefaultCategory = ref(initial.downloadDefaultCategory);
  const proxy = ref<FindBookProxySettings>({ ...initial.proxy });
  const readerFontSize = ref(initial.readerFontSize);
  const readerLineHeightMultiple = ref(initial.readerLineHeightMultiple);
  const monacoFontFamily = ref(initial.monacoFontFamily);
  const pinnedOtherFonts = ref(initial.pinnedOtherFonts);
  const monacoCustomHighlight = ref(initial.monacoCustomHighlight);
  const txtrDelimitedMatchCrossLine = ref(initial.txtrDelimitedMatchCrossLine);
  const compressBlankLines = ref(initial.compressBlankLines);
  const compressBlankKeepOneBlank = ref(initial.compressBlankKeepOneBlank);
  const leadIndentFullWidth = ref(initial.leadIndentFullWidth);
  const textConvertZh = ref(initial.textConvertZh);
  const textConvertLetter = ref(initial.textConvertLetter);
  const textConvertDigit = ref(initial.textConvertDigit);
  const monacoAdvancedWrapping = ref(initial.monacoAdvancedWrapping);
  const monacoSmoothScrolling = ref(initial.monacoSmoothScrolling);
  const stickyChapterTitleEnabled = ref(initial.stickyChapterTitleEnabled);
  const chapterNavToolbarEnabled = ref(initial.chapterNavToolbarEnabled);
  const readerEditShowLineNumbers = ref(initial.readerEditShowLineNumbers);
  const readerEditMinimap = ref(initial.readerEditMinimap);
  const fullscreenReaderWidthPercent = ref(initial.fullscreenReaderWidthPercent);
  const fullscreenShowSystemTime = ref(initial.fullscreenShowSystemTime);
  const showSidebar = ref(initial.showSidebar);
  const sidebarWidth = ref(initial.sidebarWidth);
  const timedScrollSettings = ref(initial.timedScrollSettings);
  const pomodoroSettings = ref(initial.pomodoroSettings);

  const effectiveCacheDir = computed(() => {
    const configured = cacheDir.value.trim();
    return configured || resolveDefaultBookSourceChapterCacheDirSync();
  });

  const effectiveDownloadDir = computed(() => {
    const configured = downloadDir.value.trim();
    return configured || resolveDefaultBookSourceDownloadDirSync();
  });

  function syncHttpProxyToMain() {
    const url = buildFindBookProxyUrl(proxy.value);
    void window.colorTxt.bookSourceSetHttpProxy(url || null);
  }

  function persistAll() {
    persistFindBookSettings(
      snapshotFindBookSettingsFromStore({
        cacheDir: cacheDir.value,
        downloadDir: downloadDir.value,
        downloadAfterAction: downloadAfterAction.value,
        downloadAddToMainFileList: downloadAddToMainFileList.value,
        downloadDefaultCategory: downloadDefaultCategory.value,
        proxy: proxy.value,
        readerFontSize: readerFontSize.value,
        readerLineHeightMultiple: readerLineHeightMultiple.value,
        monacoFontFamily: monacoFontFamily.value,
        pinnedOtherFonts: pinnedOtherFonts.value,
        monacoCustomHighlight: monacoCustomHighlight.value,
        txtrDelimitedMatchCrossLine: txtrDelimitedMatchCrossLine.value,
        compressBlankLines: compressBlankLines.value,
        compressBlankKeepOneBlank: compressBlankKeepOneBlank.value,
        leadIndentFullWidth: leadIndentFullWidth.value,
        textConvertZh: textConvertZh.value,
        textConvertLetter: textConvertLetter.value,
        textConvertDigit: textConvertDigit.value,
        monacoAdvancedWrapping: monacoAdvancedWrapping.value,
        monacoSmoothScrolling: monacoSmoothScrolling.value,
        stickyChapterTitleEnabled: stickyChapterTitleEnabled.value,
        chapterNavToolbarEnabled: chapterNavToolbarEnabled.value,
        readerEditShowLineNumbers: readerEditShowLineNumbers.value,
        readerEditMinimap: readerEditMinimap.value,
        fullscreenReaderWidthPercent: fullscreenReaderWidthPercent.value,
        fullscreenShowSystemTime: fullscreenShowSystemTime.value,
        showSidebar: showSidebar.value,
        sidebarWidth: sidebarWidth.value,
        timedScrollSettings: timedScrollSettings.value,
        pomodoroSettings: pomodoroSettings.value,
      }),
    );
    syncHttpProxyToMain();
  }

  function persistReaderUiPrefs() {
    persistAll();
  }

  // 窗口启动时把已持久化的代理同步到主进程
  syncHttpProxyToMain();

  return {
    cacheDir,
    downloadDir,
    downloadAfterAction,
    downloadAddToMainFileList,
    downloadDefaultCategory,
    proxy,
    effectiveCacheDir,
    effectiveDownloadDir,
    syncHttpProxyToMain,
    readerFontSize,
    readerLineHeightMultiple,
    monacoFontFamily,
    pinnedOtherFonts,
    monacoCustomHighlight,
    txtrDelimitedMatchCrossLine,
    compressBlankLines,
    compressBlankKeepOneBlank,
    leadIndentFullWidth,
    textConvertZh,
    textConvertLetter,
    textConvertDigit,
    monacoAdvancedWrapping,
    monacoSmoothScrolling,
    stickyChapterTitleEnabled,
    chapterNavToolbarEnabled,
    readerEditShowLineNumbers,
    readerEditMinimap,
    fullscreenReaderWidthPercent,
    fullscreenShowSystemTime,
    showSidebar,
    sidebarWidth,
    timedScrollSettings,
    pomodoroSettings,
    persistAll,
    persistReaderUiPrefs,
  };
}

export function useFindBookSettings() {
  if (!store) store = createFindBookSettingsStore();
  return store;
}

export function resetFindBookSettingsStoreForTests() {
  store = null;
}
