<script setup lang="ts">
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  useTemplateRef,
  watch,
  type ComponentPublicInstance,
} from "vue";
import AppModal from "../../components/AppModal.vue";
import IconButton from "../../components/IconButton.vue";
import LoadingDotsBounce from "../../components/LoadingDotsBounce.vue";
import LoadingDotsRotate from "../../components/LoadingDotsRotate.vue";
import RefreshIcon from "../../components/RefreshIcon.vue";
import VirtualList from "../../components/VirtualList.vue";
import ReaderMain from "../../components/ReaderMain.vue";
import VoiceReadToolbar from "../../components/VoiceReadToolbar.vue";
import ReaderChapterNavBar from "../../components/ReaderChapterNavBar.vue";
import FullscreenSystemClock from "../../components/FullscreenSystemClock.vue";
import PomodoroBreakOverlay from "../../components/PomodoroBreakOverlay.vue";
import FindBookReaderFooter from "./FindBookReaderFooter.vue";
import FindBookReaderHeader from "./FindBookReaderHeader.vue";
import {
  countCharsForLine,
  floorReadingProgressPercentByLines,
  formatCharCount,
} from "../../utils/format";
import { usePomodoroTimer } from "../../composables/usePomodoroTimer";
import EditBookSourcePanel from "./EditBookSourcePanel.vue";
import BookSourceLoginPanel from "./BookSourceLoginPanel.vue";
import AppShellMenuTeleport from "../../components/AppShellMenuTeleport.vue";
import { icons } from "../../icons";
import type {
  BookChapter,
  Book,
  BookSourceRecord,
  SearchBookItem,
} from "@shared/bookSource/types";
import {
  useBookSourceChapterContent,
  useBookSourceDownload,
} from "../composables/useBookSource";
import { useFindBookBookshelf } from "../composables/useFindBookBookshelf";
import {
  updateFindBookBookshelfBookInfo,
} from "../findBookBookshelf";
import { useFindBookReaderSettings } from "../composables/useFindBookReaderSettings";
import { useFindBookSettings } from "../composables/useFindBookSettings";
import { useFindBookReaderShortcuts } from "../composables/useFindBookReaderShortcuts";
import { useAnchoredAppShellMenu } from "../../composables/useAnchoredAppShellMenu";
import { acceleratorToDisplayText } from "../../services/shortcutUtils";
import { useAppReaderUiPrefs } from "../../composables/useAppReaderUiPrefs";
import { useAppReaderChrome } from "../../composables/useAppReaderChrome";
import { useAppFullscreenReaderLayout } from "../../composables/useAppFullscreenReaderLayout";
import { useAppTimedScroll } from "../../composables/useAppTimedScroll";
import { useAppVoiceRead } from "../../composables/useAppVoiceRead";
import { hasEscBeforeModalLayers } from "../../utils/modalStack";
import { formatPhysicalPlainTextForReader } from "../../reader/readerDisplayPipeline";
import { applyTextDisplayConverts } from "../../services/textConvertApply";
import { applyAppShellTheme, type AppShellTheme } from "../../utils/appShellThemeSync";
import { appConfirm, appLog } from "../../services/appDialog";
import { appToast } from "../../services/appToast";
import type {
  TextConvertWidthMode,
  TextConvertZhMode,
} from "@shared/textConvertTypes";
import {
  findBookReplaceRulesChangedEvent,
  type ReplaceRule,
} from "@shared/bookSource/replaceRule";
import {
  applyContentReplaceWithRules,
  applyTitleReplaceWithRules,
  filterEnabledReplaceRules,
} from "@shared/bookSource/replaceRuleApply";
import { listReplaceRulesLocal } from "../replaceRuleLocalStore";
import type { BookSourceEditTab } from "../editBookSourceFields";
import { useChapterCacheMarks } from "../composables/useChapterCacheMarks";
import { confirmClearBookChapterCache } from "../services/clearBookChapterCache";
import { sortContentChaptersDisplay } from "../sortContentChaptersDisplay";
import {
  FIND_BOOK_SIDEBAR_MIN_WIDTH,
  SIDEBAR_MIN_READER_WIDTH,
  persistKey,
  persistedSettingsChangedEvent,
  applyReaderSurfaceToDocument,
} from "../../constants/appUi";
import {
  loadPersistedSettingsData,
  persistSettingsData,
} from "../../stores/cacheStore";
import { READER_SIDEBAR_ROW_STRIDE } from "../../composables/useReaderSidebarLists";
import {
  contentChaptersInReadingOrder,
  displayIndexForReadingOrder,
  readingOrderIndexFromDisplay,
} from "../chapterReadingOrder";
import {
  FIND_BOOK_WINDOW_TITLE,
  formatFindBookWindowTitle,
} from "@shared/findBookWindowTitle";

import { ipcPlain } from "../ipcPlain";

const props = withDefaults(
  defineProps<{
    item: SearchBookItem;
    detail: Book;
    chapters: BookChapter[];
    initialChapterIndex?: number;
    /** 书架首次打开：目录尚未就绪，阅读区内显示加载中 */
    tocLoading?: boolean;
  }>(),
  { tocLoading: false },
);

const modelValue = defineModel<boolean>({ default: false });

const emit = defineEmits<{
  openSettings: [];
  openBookDetail: [];
  chapterCacheCleared: [];
  /** 重新获取目录后同步父级 detail/chapters */
  tocRefreshed: [payload: { detail: Book; chapters: BookChapter[] }];
  openTextReplace: [];
  /** 限定该书源搜索 */
  searchSource: [item: { bookSourceUrl: string; bookSourceName: string }];
}>();

const readerRef = ref<InstanceType<typeof ReaderMain> | null>(null);
const chapterListRef = ref<InstanceType<typeof VirtualList> | null>(null);

const showEditSource = ref(false);
const editingSourceUrl = ref<string | null>(null);
const editSourceInitialTab = ref<BookSourceEditTab>("content");
const showLogin = ref(false);
const loginSource = ref<BookSourceRecord | null>(null);
const sourceNeedsLogin = ref(false);
/** 用户点击「刷新」强制重拉当前章节 */
const refreshingChapter = ref(false);
/** 侧栏「重新获取目录」 */
const refreshingToc = ref(false);
/** 购买操作进行中 */
const payingChapter = ref(false);

const topMoreBtnRef = ref<HTMLElement | null>(null);
const topMoreMenu = useAnchoredAppShellMenu({
  anchor: topMoreBtnRef,
  placement: "below-end",
  widthPx: 180,
});
const {
  open: topMoreOpen,
  left: topMoreLeft,
  top: topMoreTop,
  toggleMenu: toggleTopMoreMenu,
  closeMenu: closeTopMoreMenu,
  panelRef: topMorePanelRef,
} = topMoreMenu;

function bindTopMorePanel(el: HTMLElement | null) {
  topMorePanelRef.value = el;
}
const chapterSortDesc = ref(false);
const currentDisplayIndex = ref(0);
const readerContentKey = ref<string | null>(null);
const lastChapterTitle = ref("");
const lastChapterBody = ref("");
const viewportTopLine = ref(1);
const viewportEndLine = ref(1);
const viewportVisualProgressPercent = ref(0);
const viewportAtBottom = ref(false);
/** 当前章节在阅读器中的展示总行数 */
const totalLineCount = ref(0);
const readerEditMode = ref(false);
const readerEditorDirty = ref(false);
const loading = ref(false);
/** 仅切到未缓存章节时为 true，控制侧栏 loading 图标与「加载中」提示 */
const showChapterLoadingUi = ref(false);
const showSidebar = ref(true);

const settings = useFindBookReaderSettings();
const findBookSettings = useFindBookSettings();
const effectiveCacheDir = findBookSettings.effectiveCacheDir;
const {
  phase: pomodoroPhase,
  displayMode: pomodoroDisplayMode,
  progress: pomodoroProgress,
  countdownText: pomodoroCountdownText,
  pauseResumeLabel: pomodoroPauseResumeLabel,
  paused: pomodoroPaused,
  showBreakOverlay: pomodoroShowBreakOverlay,
  start: startPomodoro,
  toggleDisplayMode: togglePomodoroDisplayMode,
  togglePause: togglePomodoroPause,
  stop: stopPomodoro,
  finishBreakEarly: finishPomodoroBreakEarly,
} = usePomodoroTimer(findBookSettings.pomodoroSettings);
const pomodoroEnabled = computed(
  () => findBookSettings.pomodoroSettings.value.enabled,
);
const {
  currentTheme,
  sidebarWidth,
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
  chapterMinCharCount,
  timedScrollSettings,
  aiFeaturesEnabled,
  effectiveReaderSurfaceLight,
  effectiveReaderSurfaceDark,
  highlightColorsForReader,
  lineationColorsLight,
  lineationColorsDark,
  readerPaletteColorEnabledForReader,
  highlightWordsByIndexGlobal,
  voiceReadProfiles,
  activeVoiceReadProfileId,
  voiceReadSettings,
  canIncreaseFont,
  canDecreaseFont,
  canIncreaseLineHeight,
  canDecreaseLineHeight,
  persistReaderUiPrefs,
  syncSharedSettingsFromMain,
} = settings;

const { loading: chapterLoading, error: chapterError, logs, load: loadChapterContent, cancel: cancelChapterLoad } =
  useBookSourceChapterContent();
const {
  downloading: offlineCaching,
  downloadProgress: offlineCacheProgress,
  download: startOfflineCacheDownload,
  cancel: cancelOfflineCache,
} = useBookSourceDownload();
const { isInBookshelf, toggle: toggleBookshelf, updateReadProgress } =
  useFindBookBookshelf();

const contentChapters = computed(() => props.chapters.filter((ch) => !ch.isVolume));

const {
  refresh: refreshChapterCacheStatus,
  markCached: markChapterCached,
  clearLocal: clearChapterCacheMarks,
  isCached: isChapterCached,
} = useChapterCacheMarks({
  bookName: () => props.detail.name || "",
  bookUrl: () => props.detail.bookUrl || "",
  chapterUrls: () => contentChapters.value.map((ch) => ch.url),
  cacheDir: () => effectiveCacheDir.value,
});

/** 离线缓存进行中、尚未写入勾标集合的当前章 */
function isChapterOfflineCaching(ch: BookChapter | undefined): boolean {
  if (!offlineCaching.value || !ch?.url) return false;
  if (offlineCacheProgress.value.chapterUrl !== ch.url) return false;
  return !isChapterCached(ch);
}

const offlineCacheProgressPercent = computed(() => {
  const { current, total } = offlineCacheProgress.value;
  if (total <= 0) return 0;
  return Math.min(100, Math.round((current / total) * 100));
});

const offlineCacheProgressLabel = computed(() => {
  const { current, total } = offlineCacheProgress.value;
  return `缓存进度：${current}/${total}`;
});

watch(
  () =>
    [
      offlineCacheProgress.value.chapterUrl,
      offlineCacheProgress.value.current,
    ] as const,
  ([url], prev) => {
    if (!offlineCaching.value) return;
    const prevUrl = prev?.[0];
    if (prevUrl && prevUrl !== url) markChapterCached(prevUrl);
  },
);

watch(offlineCaching, (v, was) => {
  if (was && !v) {
    const url = offlineCacheProgress.value.chapterUrl;
    if (url) markChapterCached(url);
  }
});

const inBookshelf = computed(() =>
  isInBookshelf(props.detail.bookUrl, props.item.origin),
);

/** 展示管线用规则缓存（原文在 lastChapter*；规则变更时刷新） */
const cachedReplaceRules = ref<ReplaceRule[]>([]);
const replaceRulesLoaded = ref(false);

async function refreshReplaceRulesCache() {
  try {
    cachedReplaceRules.value = listReplaceRulesLocal("findBook");
  } catch {
    cachedReplaceRules.value = [];
  } finally {
    replaceRulesLoaded.value = true;
  }
}

async function ensureReplaceRulesCache() {
  if (!replaceRulesLoaded.value) await refreshReplaceRulesCache();
}

async function onReplaceRulesChanged() {
  await refreshReplaceRulesCache();
  if (!modelValue.value || readerEditMode.value) return;
  void refreshCurrentChapterDisplay();
  void refreshConvertedChapterTitles();
}

function applyDisplayReplaceTitle(title: string): string {
  if (!title) return title;
  const rules = filterEnabledReplaceRules(
    cachedReplaceRules.value,
    props.detail.name || "",
    props.item.origin || "",
    "title",
  );
  return applyTitleReplaceWithRules(title, rules);
}

function applyDisplayReplaceBody(body: string): string {
  const rules = filterEnabledReplaceRules(
    cachedReplaceRules.value,
    props.detail.name || "",
    props.item.origin || "",
    "content",
  );
  return applyContentReplaceWithRules(body, rules);
}

/** 有已启用的规则 → 工具栏按钮激活（无总开关） */
const textReplaceActive = computed(() => {
  const name = props.detail.name || "";
  const origin = props.item.origin || "";
  const rules = cachedReplaceRules.value;
  return (
    filterEnabledReplaceRules(rules, name, origin, "content").length > 0 ||
    filterEnabledReplaceRules(rules, name, origin, "title").length > 0
  );
});

function onOpenTextReplace() {
  emit("openTextReplace");
}

const fullscreenSidebarPopoversSuppressCollapse = ref(false);
const chrome = useAppReaderChrome({
  readerRef,
  fullscreenSidebarPopoversSuppressCollapse,
});
const {
  isFullscreenView,
  showFullscreenTip,
  fullscreenTipFading,
  showFullscreenHeader,
  fullscreenHeaderOverlayRef,
  showFullscreenFooter,
  fullscreenFooterOverlayRef,
  showFullscreenSidebar,
  fullscreenSidebarOverlayRef,
  resizingSidebar,
  enterOrExitFullscreenView,
  startResizeSidebar,
  endSidebarResize,
  updateFullscreenSidebarHover,
  onFullscreenSidebarMouseLeave,
  updateFullscreenHeaderHover,
  onFullscreenHeaderMouseLeave,
  updateFullscreenFooterHover,
  onFullscreenFooterMouseLeave,
  dismissFullscreenPanelsOnLayoutPointerDown,
  dismissFullscreenChromeForNativeExit,
  fullscreenCursorHidden,
  bumpFullscreenCursorIdle,
  recordFullscreenPointer,
  sidebarWidth: chromeSidebarWidth,
} = chrome;

const readerPaneWrapRef = useTemplateRef<HTMLElement>("readerPaneWrapRef");
const {
  fullscreenReaderPaneStyle,
  onLayoutMouseDown: onFullscreenLayoutMouseDown,
  onLayoutWheel,
} = useAppFullscreenReaderLayout({
  isFullscreenView,
  readerRef,
  fullscreenSidebarOverlayRef,
  fullscreenReaderWidthPercent,
  readerPaneWrapRef,
});

const sidebarShellVisible = computed(() =>
  !isFullscreenView.value ? showSidebar.value : showFullscreenSidebar.value,
);

const chapterNavUiVisible = computed(
  () =>
    chapterNavToolbarEnabled.value &&
    displayChapters.value.length > 0 &&
    !isVoiceReadActive.value,
);

const chapterNavVisible = computed(
  () =>
    chapterNavUiVisible.value &&
    (!isFullscreenView.value || showFullscreenFooter.value),
);

function setFullscreenHeaderOverlayEl(
  el: Element | ComponentPublicInstance | null,
) {
  if (el == null) {
    fullscreenHeaderOverlayRef.value = null;
    return;
  }
  fullscreenHeaderOverlayRef.value =
    el instanceof HTMLElement
      ? el
      : ((el as ComponentPublicInstance).$el as HTMLElement | null);
}

function setFullscreenFooterOverlayEl(
  el: Element | ComponentPublicInstance | null,
) {
  if (el == null) {
    fullscreenFooterOverlayRef.value = null;
    return;
  }
  fullscreenFooterOverlayRef.value =
    el instanceof HTMLElement
      ? el
      : ((el as ComponentPublicInstance).$el as HTMLElement | null);
}

function onLayoutMouseDown(ev: MouseEvent) {
  const raw = ev.target;
  const footer = fullscreenFooterOverlayRef.value;
  if (
    isFullscreenView.value &&
    raw instanceof Node &&
    footer &&
    (footer === raw || footer.contains(raw))
  ) {
    return;
  }
  dismissFullscreenPanelsOnLayoutPointerDown(ev);
  onFullscreenLayoutMouseDown(ev);
}

const breadcrumbSourceName = computed(() => props.item.originName?.trim() ?? "");
const hasReaderLogs = computed(() => logs.value.length > 0);
const showReaderLogBtn = computed(
  () => Boolean(chapterError.value) || hasReaderLogs.value,
);
const readerLogHasError = computed(() => Boolean(chapterError.value));
/** 顶栏/正文加载遮罩：目录拉取中（不含侧栏「重新获取目录」） */
const readerBootLoading = computed(() => props.tocLoading);

watch(
  () => props.item.origin?.trim() ?? "",
  async (origin) => {
    if (!origin) {
      sourceNeedsLogin.value = false;
      return;
    }
    try {
      const source = await window.colorTxt.bookSourceGet(origin);
      sourceNeedsLogin.value = Boolean(source?.loginUrl?.trim());
    } catch {
      sourceNeedsLogin.value = false;
    }
  },
  { immediate: true },
);

watch(
  () =>
    [
      props.detail.bookUrl,
      props.chapters,
      effectiveCacheDir.value,
    ] as const,
  () => {
    void refreshChapterCacheStatus();
  },
  { immediate: true },
);

const displayChapters = computed(() =>
  sortContentChaptersDisplay(contentChapters.value, chapterSortDesc.value),
);

/** 对齐 Legado ReadMenu：有 loginUrl 且当前章 VIP 未购买时显示「购买」 */
const showChapterPayBtn = computed(() => {
  if (!sourceNeedsLogin.value) return false;
  const ch = displayChapters.value[currentDisplayIndex.value];
  if (!ch) return false;
  return Boolean(ch.isVip) && !ch.isPay;
});

const convertedChapterTitlesByIndex = ref(new Map<number, string>());
let convertedChapterTitlesGen = 0;

function textConvertOptions() {
  return {
    zh: textConvertZh.value,
    letter: textConvertLetter.value,
    digit: textConvertDigit.value,
  };
}

async function refreshConvertedChapterTitles() {
  const gen = ++convertedChapterTitlesGen;
  await ensureReplaceRulesCache();
  if (gen !== convertedChapterTitlesGen) return;
  const opts = textConvertOptions();
  const next = new Map<number, string>();
  const list = displayChapters.value;
  for (let i = 0; i < list.length; i++) {
    if (gen !== convertedChapterTitlesGen) return;
    const titled = applyDisplayReplaceTitle(list[i]!.title);
    next.set(i, await applyTextDisplayConverts(titled, opts));
  }
  if (gen !== convertedChapterTitlesGen) return;
  convertedChapterTitlesByIndex.value = next;
}

function chapterDisplayTitle(index: number): string {
  const ch = displayChapters.value[index];
  if (!ch) return "";
  return convertedChapterTitlesByIndex.value.get(index) ?? ch.title;
}
const sidebarPanelWidth = computed(() =>
  Math.max(FIND_BOOK_SIDEBAR_MIN_WIDTH, sidebarWidth.value),
);

function getSidebarMaxTotalWidth(): number {
  const sidebarLeft =
    fullscreenSidebarOverlayRef.value?.getBoundingClientRect().left ?? 0;
  return Math.max(
    FIND_BOOK_SIDEBAR_MIN_WIDTH,
    window.innerWidth - SIDEBAR_MIN_READER_WIDTH - sidebarLeft,
  );
}

function clampSidebarWidthToViewport(): void {
  sidebarWidth.value = Math.min(
    getSidebarMaxTotalWidth(),
    Math.max(FIND_BOOK_SIDEBAR_MIN_WIDTH, sidebarWidth.value),
  );
}

function displayIndexForContentIndex(contentIndex: number): number {
  const ch = contentChapters.value[contentIndex];
  if (!ch) return 0;
  const idx = displayChapters.value.findIndex((c) => c.url === ch.url);
  return idx >= 0 ? idx : 0;
}

async function scrollChapterListToCurrent(options?: {
  force?: boolean;
  smooth?: boolean;
}): Promise<void> {
  const { force = false, smooth = false } = options ?? {};
  await nextTick();
  await chapterListRef.value?.scrollToIndex(currentDisplayIndex.value, {
    align: "center",
    force,
    behavior: smooth ? "smooth" : "auto",
  });
}

const MAX_CHAPTER_LIST_LAYOUT_RETRIES = 48;
const FLUSH_CHAPTER_LIST_AFTER_FULLSCREEN_MS = 50;

async function waitChapterListLayoutFrames(frameCount = 2): Promise<void> {
  let left = Math.max(0, Math.floor(frameCount));
  await new Promise<void>((resolve) => {
    const step = () => {
      if (left <= 0) {
        resolve();
        return;
      }
      left -= 1;
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}

/** 全屏切换后：当前章滚到列表视口垂直居中（侧栏隐藏时仍写入 VirtualList scrollTop） */
async function centerChapterListInSidebar(layoutRetry = 0): Promise<void> {
  await nextTick();
  await waitChapterListLayoutFrames(2);
  const idx = currentDisplayIndex.value;
  if (idx < 0 || !displayChapters.value.length) return;

  const vl = chapterListRef.value;
  if (!vl) {
    if (layoutRetry < MAX_CHAPTER_LIST_LAYOUT_RETRIES) {
      requestAnimationFrame(() => void centerChapterListInSidebar(layoutRetry + 1));
    }
    return;
  }

  vl.scrollToIndex(idx, {
    align: "center",
    behavior: "auto",
    force: true,
  });
}

function pulseChapterListCenter() {
  void nextTick(() => {
    requestAnimationFrame(() => {
      window.setTimeout(() => {
        void centerChapterListInSidebar();
      }, FLUSH_CHAPTER_LIST_AFTER_FULLSCREEN_MS);
    });
  });
}

watch(showFullscreenSidebar, (visible) => {
  if (visible && isFullscreenView.value) {
    pulseChapterListCenter();
  }
});

function toggleChapterSort() {
  const current = displayChapters.value[currentDisplayIndex.value];
  chapterSortDesc.value = !chapterSortDesc.value;
  if (current) {
    const nextIdx = displayChapters.value.findIndex((c) => c.url === current.url);
    if (nextIdx >= 0) currentDisplayIndex.value = nextIdx;
  }
  scrollChapterListToCurrent({ force: true, smooth: true });
}

function onWindowMouseMove(ev: MouseEvent) {
  if (resizingSidebar.value) {
    const sidebar = fullscreenSidebarOverlayRef.value;
    if (!sidebar) return;
    const rect = sidebar.getBoundingClientRect();
    const panelWidth = ev.clientX - rect.left;
    sidebarWidth.value = Math.min(
      getSidebarMaxTotalWidth(),
      Math.max(FIND_BOOK_SIDEBAR_MIN_WIDTH, panelWidth),
    );
    return;
  }
  updateFullscreenHeaderHover(ev);
  updateFullscreenFooterHover(ev);
  updateFullscreenSidebarHover(ev);
  if (isFullscreenView.value) {
    recordFullscreenPointer(ev);
    bumpFullscreenCursorIdle();
  }
}

function onWindowMouseUp() {
  const wasResizing = resizingSidebar.value;
  endSidebarResize();
  if (wasResizing) persistReaderUiPrefs();
}

const readerUi = useAppReaderUiPrefs({
  readerRef,
  readerFontSize,
  readerLineHeightMultiple,
  monacoFontFamily,
  pinnedOtherFonts,
  monacoCustomHighlight,
  monacoAdvancedWrapping,
  compressBlankLines,
  leadIndentFullWidth,
  textConvertZh,
  textConvertLetter,
  textConvertDigit,
  withChapterListScrollSuppressed: async (fn) => fn(),
  currentFile: readerContentKey,
  stream: {
    applyDisplayPipelineToFullText: async (text: string) => text,
    reloadReaderFromPhysicalText: async () => {},
  } as never,
  syncChaptersAfterViewportSettled: () => {},
  persistSettings: persistReaderUiPrefs,
  isFullscreenView,
  showFullscreenHeader,
  viewportTopLine,
  viewportEndLine,
  viewportVisualProgressPercent,
  viewportAtBottom,
});

const emptyCharacterRoster = ref<readonly never[]>([]);

let offFullscreen: (() => void) | null = null;

function applySharedSettingsFromMain() {
  syncSharedSettingsFromMain();
  if (!modelValue.value) return;
  applyAppShellTheme(currentTheme.value);
  applyReaderAppearance();
}

function onStorageSync(ev: StorageEvent) {
  if (ev.storageArea !== localStorage) return;
  if (ev.key === persistKey) {
    applySharedSettingsFromMain();
  }
}

function onPersistedSettingsChanged() {
  applySharedSettingsFromMain();
}

function contentIndexFor(ch: BookChapter): number {
  return contentChapters.value.findIndex((c) => c.url === ch.url);
}

async function ensureChapterScrollAtTop() {
  for (let i = 0; i < 30 && !readerRef.value; i++) {
    await nextTick();
  }
  const reader = readerRef.value;
  if (!reader) return;
  reader.scrollToDocumentStart(false);
  await nextTick();
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        reader.scrollToDocumentStart(false);
        reader.refreshChapterStickyScroll?.();
        resolve();
      });
    });
  });
}

async function renderChapterText(
  heading: string,
  body: string,
  opts?: { resetScroll?: boolean },
) {
  await ensureReplaceRulesCache();
  const convertOpts = textConvertOptions();
  const rawTitle = heading.trim();
  // 正文若已带章节名（旧缓存 / ##{{title}} 未生效），先剥离再拼回一行，
  // 避免「橙色章节装饰行 + 正文里又一行黑字标题」
  let bodyText = stripLeadingChapterTitleFromBody(body, rawTitle);
  // 文本替换与「转换」同属展示管线：先替换，再简繁/全半角
  const titleText = applyDisplayReplaceTitle(rawTitle);
  bodyText = applyDisplayReplaceBody(bodyText);
  let text = titleText ? `${titleText}\n${bodyText}` : bodyText;
  text = await applyTextDisplayConverts(text, convertOpts);
  const formatted = formatPhysicalPlainTextForReader(text, {
    compressBlankLines: compressBlankLines.value,
    compressBlankKeepOneBlank: compressBlankKeepOneBlank.value,
    leadIndentFullWidth: leadIndentFullWidth.value,
    minCharCount: chapterMinCharCount.value,
    skipBlanksBeforeFirstChapterTitle: true,
  });
  for (let i = 0; i < 30 && !readerRef.value; i++) {
    await nextTick();
  }
  const reader = readerRef.value;
  if (!reader) return;
  await reader.setFullText(formatted.text, {
    heavy: false,
    resetScroll: opts?.resetScroll ?? true,
  });
  totalLineCount.value = reader.getModelLineCount?.() ?? formatted.lineCount;
  if (rawTitle) {
    const lineNumber =
      formatted.chapterTitleDisplayLineByPhysical.get(1) ?? 1;
    reader.setChapters([
      {
        title: rawTitle,
        lineNumber,
        headingLevel: 1,
      },
    ]);
  } else {
    reader.setChapters([]);
  }
}

function syncFooterLineCountFromReader() {
  const n = readerRef.value?.getModelLineCount?.();
  if (typeof n === "number" && Number.isFinite(n) && n >= 0) {
    totalLineCount.value = n;
  }
}

function onFindBookViewportEndLineChange(line: number) {
  readerUi.onViewportEndLineChange(line);
  syncFooterLineCountFromReader();
}

function stripLeadingChapterTitleFromBody(body: string, title: string): string {
  const rawTitle = title.trim();
  if (!rawTitle) return body;
  try {
    const titlePat = rawTitle
      .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      .replace(/\s+/g, "\\s*");
    return body.replace(
      new RegExp(`^(?:\\s|\\p{P})*${titlePat}\\s*`, "u"),
      "",
    );
  } catch {
    return body;
  }
}

/** 编辑态展示：缓存原文（章节名 + 正文），不经压缩空行等阅读管线 */
function buildEditSourceText(): string {
  const rawTitle = lastChapterTitle.value.trim();
  const body = lastChapterBody.value;
  return rawTitle ? `${rawTitle}\n${body}` : body;
}

const canEnterReaderEditMode = computed(
  () =>
    Boolean(readerContentKey.value) &&
    !chapterContentBusy.value &&
    !readerBootLoading.value,
);

async function confirmIfReaderEditDiscard(): Promise<boolean> {
  if (!readerEditMode.value || !readerEditorDirty.value) return true;
  return appConfirm(
    "当前章节已修改但尚未保存，确定要放弃这些改动吗？",
    "修改未保存",
  );
}

function onReaderEditDirtyChange(dirty: boolean) {
  readerEditorDirty.value = dirty;
}

async function onToggleReaderEdit() {
  if (readerEditMode.value) {
    if (!(await confirmIfReaderEditDiscard())) return;
    readerEditorDirty.value = false;
    readerEditMode.value = false;
    // 退出编辑：lastChapter* 仍为原文，重跑展示管线（文本替换 → 转换 → …）
    if (lastChapterBody.value || lastChapterTitle.value) {
      await renderChapterText(lastChapterTitle.value, lastChapterBody.value, {
        resetScroll: false,
      });
    }
    return;
  }
  if (!canEnterReaderEditMode.value) {
    appToast("请等待当前章节加载完成后再进入编辑模式。");
    return;
  }
  voiceRead.exitVoiceRead();
  timedScroll.stopTimedScroll();
  // 先进入编辑态再 setChapters，避免阅读态标题装饰残留（与主界面一致：编辑不渲标题样式）
  readerEditMode.value = true;
  await nextTick();
  // 进入编辑：直接编辑原文（文本替换只在阅读展示管线，不改 lastChapter*）
  const editText = buildEditSourceText();
  const reader = readerRef.value;
  if (reader) {
    await reader.setFullText(editText, { heavy: false, resetScroll: false });
    totalLineCount.value = reader.getModelLineCount?.() ?? 0;
    if (lastChapterTitle.value.trim()) {
      reader.setChapters([
        {
          title: lastChapterTitle.value.trim(),
          lineNumber: 1,
          headingLevel: 1,
        },
      ]);
    } else {
      reader.setChapters([]);
    }
  }
  readerRef.value?.markReaderEditSaved?.();
  readerEditorDirty.value = false;
}

async function onSaveReaderChapter() {
  if (!readerEditMode.value) return;
  const ch = displayChapters.value[currentDisplayIndex.value];
  const bookUrl = props.detail.bookUrl?.trim() || props.item.bookUrl?.trim();
  if (!ch?.url?.trim() || !bookUrl) {
    appToast("无法保存：缺少章节信息", { kind: "warning" });
    return;
  }
  const text = readerRef.value?.getAllText() ?? "";
  const body = stripLeadingChapterTitleFromBody(text, lastChapterTitle.value);
  const r = await window.colorTxt.bookSourceSaveChapterCache({
    name: props.detail.name || "",
    bookUrl,
    chapterUrl: ch.url,
    content: body,
    cacheDir: effectiveCacheDir.value.trim() || undefined,
  });
  if (!r.ok) {
    appToast(r.message || "保存到缓存失败", { kind: "warning" });
    return;
  }
  lastChapterBody.value = body;
  markChapterCached(ch.url);
  readerRef.value?.markReaderEditSaved?.();
  readerEditorDirty.value = false;
  appToast("已保存到缓存", { kind: "success", duration: 1200 });
}

async function loadChapterAtDisplayIndex(
  index: number,
  options?: { smoothScroll?: boolean; preferCache?: boolean },
) {
  const ch = displayChapters.value[index];
  if (!ch) return;
  if (!(await confirmIfReaderEditDiscard())) return;
  if (readerEditMode.value) {
    readerEditMode.value = false;
    readerEditorDirty.value = false;
  }
  const contentIndex = contentIndexFor(ch);
  if (contentIndex < 0) return;
  const preferCache = options?.preferCache !== false;
  const fromCache = preferCache && isChapterCached(ch);
  const wantSmooth = options?.smoothScroll ?? true;
  currentDisplayIndex.value = index;
  loading.value = true;
  showChapterLoadingUi.value = !fromCache;
  cancelChapterLoad();
  // 先启动侧栏居中动画，避免与 Monaco 正文写入抢主线程导致卡顿
  const scrollDone = scrollChapterListToCurrent({ smooth: wantSmooth });
  if (!fromCache) {
    // 未缓存 / 强制刷新：遮罩盖住旧正文，切章期间不做 Monaco 清空（避免卡列表动画）
    readerContentKey.value = null;
    lastChapterTitle.value = "";
    lastChapterBody.value = "";
    totalLineCount.value = 0;
  }
  const listLen = displayChapters.value.length;
  const readingIdx = readingOrderIndexFromDisplay(
    index,
    listLen,
    chapterSortDesc.value,
  );
  const nextDisplayIdx = displayIndexForReadingOrder(
    readingIdx + 1,
    listLen,
    chapterSortDesc.value,
  );
  const nextInReadingOrder =
    readingIdx + 1 < listLen
      ? displayChapters.value[nextDisplayIdx]
      : undefined;
  const chapterUrlsInReadingOrder = contentChaptersInReadingOrder(
    contentChapters.value,
  ).map((c) => c.url);
  try {
    const loaded = await loadChapterContent({
      bookSourceUrl: props.item.origin,
      book: {
        ...props.detail,
        kind: props.detail.kind || props.item.kind || "",
        origin: props.item.origin,
        originName: props.item.originName,
      },
      chapterUrl: ch.url,
      chapterTitle: ch.title,
      chapterIndex: contentIndex,
      nextChapterUrl: nextInReadingOrder?.url,
      chapterUrls: chapterUrlsInReadingOrder,
      cacheDir: effectiveCacheDir.value.trim() || undefined,
      preferCache,
    });
    if (loaded == null) {
      if (chapterError.value) appToast(chapterError.value);
      return;
    }
    const { content: body, displayTitle } = loaded;
    // 缓存命中往往立刻返回：等列表动画结束再写正文，避免与 rAF 平滑滚动抢帧
    if (wantSmooth) await scrollDone;
    markChapterCached(ch.url);
    readerContentKey.value = `findbook://${props.detail.bookUrl}#${ch.url}`;
    // IPC 返回缓存/联网原文；文本替换在 renderChapterText 中与「转换」一并套用
    lastChapterTitle.value = displayTitle || ch.title;
    lastChapterBody.value = body;
    await renderChapterText(lastChapterTitle.value, body);
    if (isInBookshelf(props.detail.bookUrl, props.item.origin)) {
      updateReadProgress(
        props.detail.bookUrl,
        props.item.origin,
        contentIndex,
        ch.title,
      );
    }
  } finally {
    loading.value = false;
    showChapterLoadingUi.value = false;
    await ensureChapterScrollAtTop();
  }
}

function isChapterLoading(index: number): boolean {
  return showChapterLoadingUi.value && index === currentDisplayIndex.value;
}

function onChapterClick(index: number) {
  if (voiceRead.isVoiceReadNavigationBlocked.value) return;
  if (index === currentDisplayIndex.value && !loading.value && !chapterLoading.value)
    return;
  void loadChapterAtDisplayIndex(index);
}

const currentReadingOrderIndex = computed(() =>
  readingOrderIndexFromDisplay(
    currentDisplayIndex.value,
    displayChapters.value.length,
    chapterSortDesc.value,
  ),
);

const footerReadingProgress = computed(() => {
  const totalChapters = displayChapters.value.length;
  const hasContent = Boolean(readerContentKey.value);
  if (!hasContent || totalChapters <= 0 || currentReadingOrderIndex.value < 0) {
    return {
      percentPart: "-",
      detailPart: "",
      placeholder: true,
      complete: false,
    };
  }
  const chapterRo1 = currentReadingOrderIndex.value + 1;
  const percentValue = floorReadingProgressPercentByLines(
    chapterRo1,
    totalChapters,
  );
  const totalLines = Math.max(0, totalLineCount.value);
  const currentLine =
    totalLines > 0
      ? Math.min(totalLines, Math.max(1, viewportEndLine.value))
      : 0;
  const percent = percentValue.toFixed(1).replace(/\.0$/, "");
  return {
    percentPart: `${percent}%`,
    detailPart: ` (${chapterRo1}/${totalChapters}，${currentLine}/${totalLines})`,
    placeholder: false,
    complete: chapterRo1 >= totalChapters,
  };
});

const footerChapterCharCountText = computed(() =>
  formatCharCount(countCharsForLine(lastChapterBody.value)),
);

const footerHasContent = computed(() => Boolean(readerContentKey.value));
const footerLoading = computed(
  () => readerBootLoading.value || showChapterLoadingUi.value,
);

const canGoPrevChapter = computed(() => currentReadingOrderIndex.value > 0);
const canGoNextChapter = computed(
  () =>
    currentReadingOrderIndex.value >= 0 &&
    currentReadingOrderIndex.value < displayChapters.value.length - 1,
);

/** 阅读顺序上一章 / 下一章（与 content 数组正倒序、侧栏展示排序解耦） */
function goToPrevChapter() {
  if (!canGoPrevChapter.value || chapterNavBusy.value) return;
  void loadChapterAtDisplayIndex(
    displayIndexForReadingOrder(
      currentReadingOrderIndex.value - 1,
      displayChapters.value.length,
      chapterSortDesc.value,
    ),
  );
}

function goToNextChapter() {
  if (!canGoNextChapter.value || chapterNavBusy.value) return;
  void loadChapterAtDisplayIndex(
    displayIndexForReadingOrder(
      currentReadingOrderIndex.value + 1,
      displayChapters.value.length,
      chapterSortDesc.value,
    ),
  );
}

/** 定时滚动 / 语音朗读续章：不受「朗读中禁止跳转」限制 */
function advanceToNextChapterForAutoRead() {
  if (!canGoNextChapter.value || chapterContentBusy.value) return;
  void loadChapterAtDisplayIndex(
    displayIndexForReadingOrder(
      currentReadingOrderIndex.value + 1,
      displayChapters.value.length,
      chapterSortDesc.value,
    ),
  );
}

/** 切章清空正文到新章写入完成（含网络拉取）期间为 true */
const chapterContentBusy = computed(
  () => loading.value || chapterLoading.value,
);

const voiceRead = useAppVoiceRead({
  readerRef,
  voiceReadSettings,
  voiceReadProfiles,
  activeVoiceReadProfileId,
  currentFile: readerContentKey,
  loading: chapterContentBusy,
  readerEditMode,
  monacoSmoothScrolling,
  aiFeaturesEnabled,
  characterRoster: emptyCharacterRoster,
  continueAtDocumentEnd: true,
  pauseOnLoading: true,
  canAdvanceToNextDocument: () => canGoNextChapter.value,
  onDocumentEnd: () => {
    advanceToNextChapterForAutoRead();
  },
});

const isVoiceReadActive = voiceRead.isVoiceReadActive;
const isVoiceReadScrollLocked = voiceRead.isVoiceReadScrollLocked;
const isVoiceReadBlocksFind = voiceRead.isVoiceReadBlocksFind;
const canStartVoiceRead = voiceRead.canStartVoiceRead;

const chapterNavBusy = computed(
  () =>
    chapterContentBusy.value ||
    (isVoiceReadActive.value && voiceRead.mode.value === "playing"),
);

function jumpToPrevChapterWithShortcut() {
  if (voiceRead.isVoiceReadNavigationBlocked.value) return;
  goToPrevChapter();
}

function jumpToNextChapterWithShortcut() {
  if (voiceRead.isVoiceReadNavigationBlocked.value) return;
  goToNextChapter();
}

const { shortcutBindings } = useFindBookReaderShortcuts({
  readerOpen: modelValue,
  readerRef,
  increaseFontSize: () => readerUi.increaseFontSize(),
  decreaseFontSize: () => readerUi.decreaseFontSize(),
  increaseLineHeight: () => readerUi.increaseLineHeight(),
  decreaseLineHeight: () => readerUi.decreaseLineHeight(),
  jumpToPrevChapter: jumpToPrevChapterWithShortcut,
  jumpToNextChapter: jumpToNextChapterWithShortcut,
  isVoiceReadScrollLocked,
  isVoiceReadBlocksFind,
});

const isMacPlatform = /mac|iphone|ipad|ipod/i.test(navigator.platform || "");
const settingsShortcutLabel = computed(() =>
  acceleratorToDisplayText(shortcutBindings.value.openSettings, isMacPlatform),
);

watch(
  () => [modelValue.value, props.detail.name] as const,
  ([open, name]) => {
    window.colorTxt.setWindowTitle(
      open ? formatFindBookWindowTitle(name) : FIND_BOOK_WINDOW_TITLE,
    );
  },
  { immediate: true },
);

const timedScroll = useAppTimedScroll({
  readerRef,
  timedScrollSettings,
  currentFile: readerContentKey,
  loading: chapterContentBusy,
  readerEditMode,
  viewportAtBottom,
  isVoiceReadActive: voiceRead.isVoiceReadActive,
  continueAtBottom: true,
  pauseOnLoading: true,
  canStartDespiteBottom: () => canGoNextChapter.value,
  onAtBottomTick: () => {
    advanceToNextChapterForAutoRead();
  },
});

const isTimedScrollActive = timedScroll.isTimedScrollActive;
const canStartTimedScroll = timedScroll.canStartTimedScroll;

async function refreshCurrentChapterDisplay() {
  if (readerEditMode.value) return;
  if (!lastChapterBody.value) return;
  await renderChapterText(lastChapterTitle.value, lastChapterBody.value, {
    resetScroll: false,
  });
}

async function toggleCompressBlankLines() {
  if (readerEditMode.value) {
    void readerRef.value?.applyEditFormatCompressBlankLines?.(
      compressBlankKeepOneBlank.value,
    );
    return;
  }
  compressBlankLines.value = !compressBlankLines.value;
  persistReaderUiPrefs();
  await refreshCurrentChapterDisplay();
}

async function toggleLeadIndentFullWidth() {
  if (readerEditMode.value) {
    void readerRef.value?.applyEditFormatLeadIndentFullWidth?.();
    return;
  }
  leadIndentFullWidth.value = !leadIndentFullWidth.value;
  persistReaderUiPrefs();
  await refreshCurrentChapterDisplay();
}

async function setTextConvertZhRead(mode: typeof textConvertZh.value) {
  if (textConvertZh.value === mode) return;
  textConvertZh.value = mode;
  persistReaderUiPrefs();
  await refreshCurrentChapterDisplay();
}

async function setTextConvertLetterRead(mode: typeof textConvertLetter.value) {
  if (textConvertLetter.value === mode) return;
  textConvertLetter.value = mode;
  persistReaderUiPrefs();
  await refreshCurrentChapterDisplay();
}

async function setTextConvertDigitRead(mode: typeof textConvertDigit.value) {
  if (textConvertDigit.value === mode) return;
  textConvertDigit.value = mode;
  persistReaderUiPrefs();
  await refreshCurrentChapterDisplay();
}

function onFormatEditCompressBlankLines() {
  void readerRef.value?.applyEditFormatCompressBlankLines?.(
    compressBlankKeepOneBlank.value,
  );
}

function onFormatEditLeadIndentFullWidth() {
  void readerRef.value?.applyEditFormatLeadIndentFullWidth?.();
}

function onApplyTextConvertZhEdit(mode: Exclude<TextConvertZhMode, "off">) {
  void readerRef.value?.applyEditFormatTextConvertZh?.(mode);
}

function onApplyTextConvertLetterEdit(
  mode: Exclude<TextConvertWidthMode, "off">,
) {
  void readerRef.value?.applyEditFormatTextConvertLetters?.(mode);
}

function onApplyTextConvertDigitEdit(
  mode: Exclude<TextConvertWidthMode, "off">,
) {
  void readerRef.value?.applyEditFormatTextConvertDigits?.(mode);
}

async function onBack() {
  if (!(await confirmIfReaderEditDiscard())) return;
  readerEditMode.value = false;
  readerEditorDirty.value = false;
  voiceRead.exitVoiceRead();
  timedScroll.stopTimedScroll();
  cancelChapterLoad();
  modelValue.value = false;
}

function onOpenBookDetail() {
  closeTopMoreMenu();
  emit("openBookDetail");
}

async function copyText(label: string, text: string) {
  const value = text.trim();
  if (!value) {
    appToast(`${label}为空`, { kind: "warning" });
    return;
  }
  try {
    await navigator.clipboard.writeText(value);
    appToast(`已复制${label}`, { kind: "success", duration: 1200 });
  } catch {
    appToast(`复制${label}失败`, { kind: "warning" });
  }
}

async function onCopyChapterUrl() {
  closeTopMoreMenu();
  const ch = displayChapters.value[currentDisplayIndex.value];
  await copyText("正文 URL", ch?.url ?? "");
}

function onEditBookSource() {
  closeTopMoreMenu();
  const origin = props.item.origin?.trim();
  if (!origin) {
    appToast("书源不存在", { kind: "warning" });
    return;
  }
  editingSourceUrl.value = origin;
  editSourceInitialTab.value = "content";
  showEditSource.value = true;
}

async function onLogin() {
  const origin = props.item.origin?.trim();
  if (!origin) {
    appToast("书源不存在", { kind: "warning" });
    return;
  }
  const source = await window.colorTxt.bookSourceGet(origin);
  if (!source?.loginUrl?.trim()) {
    appToast("此书源未配置登录", { kind: "warning" });
    return;
  }
  // 对齐 Legado SourceLoginActivity：无 loginUi → WebView；有 loginUi → 弹层
  if (!source.loginUi?.trim()) {
    const r = await window.colorTxt.bookSourceBrowserLogin(
      source.bookSourceUrl,
      `登录 · ${source.bookSourceName}`,
    );
    if (r.ok) appToast("Cookie 已保存", { kind: "info" });
    else if (!r.cancelled && r.message) appToast(r.message, { kind: "warning" });
    return;
  }
  loginSource.value = source;
  showLogin.value = true;
}

/** 对齐 Legado ReadBookActivity.payAction：确认购买 → 执行 payAction */
async function onChapterPay() {
  if (payingChapter.value) return;
  const origin = props.item.origin?.trim();
  const ch = displayChapters.value[currentDisplayIndex.value];
  if (!origin || !ch) {
    appToast("当前没有可购买的章节", { kind: "warning" });
    return;
  }
  // 对齐 Legado alert(购买) + chapter.title
  const confirmed = await appConfirm(ch.title || "（无标题）", "购买");
  if (!confirmed) return;

  payingChapter.value = true;
  try {
    const bookUrl = props.detail.bookUrl?.trim() || props.item.bookUrl?.trim() || "";
    // IPC 只能传可结构化克隆的纯对象，需剥离 Vue 响应式代理
    const r = await window.colorTxt.bookSourcePayAction(
      JSON.parse(
        JSON.stringify({
          bookSourceUrl: origin,
          book: {
            ...props.detail,
            bookUrl,
            tocUrl: props.detail.tocUrl || bookUrl,
            kind: props.detail.kind || props.item.kind || "",
            name: props.detail.name || props.item.name,
            author: props.detail.author || props.item.author,
            origin,
            originName: props.item.originName,
          },
          chapter: ch,
          cacheDir: effectiveCacheDir.value.trim() || undefined,
        }),
      ),
    );
    if (r.logs?.length) logs.value = r.logs;
    if (!r.ok) {
      if (!r.cancelled && r.message) {
        appToast(r.message, { kind: "danger" });
      }
      return;
    }
    if (r.refresh) {
      await refreshTocAfterPay();
      await loadChapterAtDisplayIndex(currentDisplayIndex.value, {
        smoothScroll: false,
        preferCache: false,
      });
    }
  } catch (e) {
    appToast(e instanceof Error ? e.message : "购买失败", { kind: "danger" });
  } finally {
    payingChapter.value = false;
  }
}

async function onRefresh() {
  if (
    readerBootLoading.value ||
    chapterContentBusy.value ||
    refreshingChapter.value
  ) {
    return;
  }
  if (!displayChapters.value[currentDisplayIndex.value]) {
    appToast("当前没有可刷新的章节", { kind: "warning" });
    return;
  }
  refreshingChapter.value = true;
  try {
    await loadChapterAtDisplayIndex(currentDisplayIndex.value, {
      smoothScroll: false,
      preferCache: false,
    });
  } finally {
    refreshingChapter.value = false;
  }
}

async function onRefreshToc() {
  await refreshTocInternal({ announce: true });
}

/** 购买成功后刷新目录（对齐 Legado loadChapterList，不弹「无更新」） */
async function refreshTocAfterPay() {
  await refreshTocInternal({ announce: false });
}

async function refreshTocInternal(opts: { announce: boolean }) {
  if (refreshingToc.value || props.tocLoading || offlineCaching.value) {
    return;
  }
  const origin = props.item.origin?.trim();
  const bookUrl = props.detail.bookUrl?.trim() || props.item.bookUrl?.trim();
  if (!origin || !bookUrl) {
    appToast("书籍信息不完整，无法刷新目录", { kind: "warning" });
    return;
  }
  const currentUrl = displayChapters.value[currentDisplayIndex.value]?.url ?? "";
  refreshingToc.value = true;
  try {
    const bookPayload = ipcPlain({
      ...props.detail,
      bookUrl,
      tocUrl: props.detail.tocUrl || bookUrl,
      kind: props.detail.kind || props.item.kind || "",
      name: props.detail.name || props.item.name,
      author: props.detail.author || props.item.author,
      origin,
      originName: props.item.originName,
    });
    const tocRes = await window.colorTxt.bookSourceGetChapterList({
      bookSourceUrl: origin,
      book: bookPayload,
    });
    if (tocRes.logs?.length) logs.value = tocRes.logs;
    if (tocRes.message) {
      appToast(tocRes.message, { kind: "warning" });
      return;
    }
    const nextChapters = tocRes.chapters ?? [];
    const contentOnly = nextChapters.filter((ch) => !ch.isVolume);
    if (!contentOnly.length) {
      appToast("未获取到章节", { kind: "warning" });
      return;
    }
    // 内容章「最新在前」：与 resolveLatestChapterTitleFromToc / Legado 写回一致
    const prevLatest = contentChapters.value[0];
    const prevLatestTitle = prevLatest?.title?.trim() ?? "";
    const prevLatestUrl = prevLatest?.url ?? "";
    const latest = contentOnly[0]!;
    const latestTitle = latest.title?.trim() ?? "";
    const latestUrl = latest.url ?? "";
    const latestUnchanged =
      prevLatestUrl === latestUrl && prevLatestTitle === latestTitle;

    const nextDetail: Book = latestTitle
      ? { ...props.detail, lastChapter: latestTitle }
      : props.detail;
    updateFindBookBookshelfBookInfo(bookUrl, origin, {
      tocUrl: nextDetail.tocUrl,
      chapters: nextChapters,
      lastChapter: latestTitle,
    });
    emit("tocRefreshed", {
      detail: ipcPlain(nextDetail),
      chapters: nextChapters,
    });
    await nextTick();
    await refreshChapterCacheStatus();
    const nextDisplay = sortContentChaptersDisplay(
      contentOnly,
      chapterSortDesc.value,
    );
    // 只调整侧栏选中项，不重拉正文
    let idx = Math.min(
      currentDisplayIndex.value,
      Math.max(0, nextDisplay.length - 1),
    );
    if (currentUrl) {
      const found = nextDisplay.findIndex((ch) => ch.url === currentUrl);
      if (found >= 0) idx = found;
    }
    currentDisplayIndex.value = idx;
    void nextTick(() => scrollChapterListToCurrent({ smooth: false }));
    if (opts.announce) {
      if (latestUnchanged) {
        appToast("无更新", { kind: "info" });
      } else {
        appToast(`目录已更新，最新章节：${latestTitle || "（无标题）"}`, {
          kind: "success",
        });
      }
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn("[findBook] refreshToc", e);
    appToast(msg?.trim() ? `刷新目录失败：${msg}` : "刷新目录失败", {
      kind: "warning",
    });
  } finally {
    refreshingToc.value = false;
  }
}

function onEditSourceDone() {
  showEditSource.value = false;
  editingSourceUrl.value = null;
}

function onSearchFromEdit(item: {
  bookSourceUrl: string;
  bookSourceName: string;
}) {
  showEditSource.value = false;
  editingSourceUrl.value = null;
  emit("searchSource", item);
}

async function onClearChapterCache() {
  closeTopMoreMenu();
  const bookUrl = props.detail.bookUrl?.trim() || props.item.bookUrl?.trim();
  const name = props.detail.name?.trim() || props.item.name?.trim() || "";
  const cleared = await confirmClearBookChapterCache({
    name,
    bookUrl: bookUrl || "",
    cacheDir: effectiveCacheDir.value,
  });
  if (!cleared) return;
  clearChapterCacheMarks();
  emit("chapterCacheCleared");
}

async function onStopOfflineCache() {
  if (!offlineCaching.value) return;
  await cancelOfflineCache();
  appToast("已停止离线缓存", { kind: "warning" });
}

async function onStartOfflineCache() {
  if (offlineCaching.value) return;
  const bookUrl = props.detail.bookUrl?.trim() || props.item.bookUrl?.trim();
  if (!bookUrl || !props.item.origin?.trim()) {
    appToast("书籍信息不完整，无法缓存", { kind: "warning" });
    return;
  }
  const result = await startOfflineCacheDownload(
    {
      ...props.item,
      bookUrl,
      name: props.detail.name?.trim() || props.item.name,
      author: props.detail.author?.trim() || props.item.author,
    },
    "",
    effectiveCacheDir.value.trim() || undefined,
    { cacheOnly: true },
  );
  if (result !== null) {
    appToast("已完成离线缓存", { kind: "success", duration: 1200 });
    void refreshChapterCacheStatus();
  }
}

function buildShelfItem(): SearchBookItem {
  return {
    ...props.item,
    name: props.detail.name,
    author: props.detail.author,
    intro: props.detail.intro ?? props.item.intro,
    coverUrl: props.detail.coverUrl || props.item.coverUrl,
    coverSourceUrl: props.detail.coverSourceUrl ?? props.item.coverSourceUrl,
    lastChapter: props.detail.lastChapter ?? props.item.lastChapter,
    kind: props.detail.kind ?? props.item.kind,
    wordCount: props.detail.wordCount ?? props.item.wordCount,
    bookUrl: props.detail.bookUrl,
  };
}

function onToggleBookshelf() {
  const item = buildShelfItem();
  const added = toggleBookshelf(item, {
    updateTime: props.detail.updateTime?.trim() || undefined,
  });
  if (added) {
    const ch = displayChapters.value[currentDisplayIndex.value];
    const contentIndex = ch ? contentIndexFor(ch) : -1;
    if (contentIndex >= 0) {
      updateReadProgress(
        props.detail.bookUrl,
        props.item.origin,
        contentIndex,
        ch.title,
      );
    }
    if (props.detail.tocUrl && props.chapters.length) {
      updateFindBookBookshelfBookInfo(props.detail.bookUrl, props.item.origin, {
        tocUrl: props.detail.tocUrl,
        chapters: props.chapters,
      });
    }
  }
  appToast(added ? "已放入书架" : "已从书架移除");
}

function persistSharedTheme(theme: AppShellTheme) {
  const loaded = loadPersistedSettingsData(localStorage, persistKey);
  persistSettingsData(localStorage, persistKey, {
    ...(loaded?.data ?? {}),
    theme,
  });
}

function onChangeTheme(theme: string) {
  const next: AppShellTheme = theme === "vs-dark" ? "vs-dark" : "vs";
  currentTheme.value = next;
  applyAppShellTheme(next);
  applyReaderAppearance();
  persistSharedTheme(next);
}

async function toggleFullscreen() {
  if (!isFullscreenView.value) {
    chromeSidebarWidth.value = sidebarWidth.value;
  }
  await enterOrExitFullscreenView();
}

function onDocumentKeydownEscape(ev: KeyboardEvent) {
  if (!modelValue.value || !isFullscreenView.value) return;
  if (ev.key !== "Escape") return;
  if (hasEscBeforeModalLayers()) return;
  ev.preventDefault();
  ev.stopPropagation();
  if (readerRef.value?.isFindWidgetRevealed?.()) {
    readerRef.value?.toggleFindWidget?.();
    return;
  }
  void window.colorTxt.setFullscreen(false).catch(() => {});
}

async function onShowLogs() {
  const runtimeText = logs.value.length ? logs.value.join("\n\n") : "";
  let text = "";
  if (chapterError.value && runtimeText) {
    text = `${chapterError.value}\n\n---\n\n${runtimeText}`;
  } else if (chapterError.value) {
    text = chapterError.value;
  } else if (runtimeText) {
    text = runtimeText;
  } else {
    text = "（暂无运行日志）";
  }
  await appLog(text);
}

function applyReaderAppearance() {
  applyReaderSurfaceToDocument(
    currentTheme.value,
    effectiveReaderSurfaceLight.value,
    effectiveReaderSurfaceDark.value,
  );
  readerRef.value?.setTheme(currentTheme.value);
  readerRef.value?.setFontSize(readerFontSize.value);
  readerRef.value?.setLineHeightMultiple(readerLineHeightMultiple.value);
  readerRef.value?.setFontFamily(monacoFontFamily.value);
}

watch(
  [
    displayChapters,
    textConvertZh,
    textConvertLetter,
    textConvertDigit,
  ],
  () => {
    void refreshConvertedChapterTitles();
  },
  { immediate: true },
);

watch(
  [readerFontSize, readerLineHeightMultiple, monacoFontFamily],
  () => {
    if (!modelValue.value) return;
    applyReaderAppearance();
  },
);

watch(
  [compressBlankKeepOneBlank, txtrDelimitedMatchCrossLine],
  () => {
    if (!modelValue.value) return;
    void refreshCurrentChapterDisplay();
  },
);

async function bootstrapReaderContent() {
  if (!modelValue.value || !displayChapters.value.length) return;
  await refreshReplaceRulesCache();
  await refreshChapterCacheStatus();
  const startIndex = displayIndexForContentIndex(props.initialChapterIndex ?? 0);
  void loadChapterAtDisplayIndex(startIndex, { smoothScroll: false });
}

watch(
  modelValue,
  async (open) => {
    if (!open) {
      voiceRead.exitVoiceRead();
      timedScroll.stopTimedScroll();
      stopPomodoro();
      cancelChapterLoad();
      if (offlineCaching.value) void cancelOfflineCache();
      loading.value = false;
      showChapterLoadingUi.value = false;
      readerEditMode.value = false;
      readerEditorDirty.value = false;
      readerContentKey.value = null;
      lastChapterBody.value = "";
      lastChapterTitle.value = "";
      totalLineCount.value = 0;
      if (isFullscreenView.value) {
        try {
          await window.colorTxt.setFullscreen(false);
        } catch {
          /* ignore */
        }
        dismissFullscreenChromeForNativeExit();
      }
      return;
    }
    showSidebar.value = true;
    applyAppShellTheme(currentTheme.value);
    await nextTick();
    applyReaderAppearance();
    await bootstrapReaderContent();
  },
  { immediate: true },
);

/** 书架先开阅读器、目录迟到时：目录就绪后加载正文 */
watch(
  () => [modelValue.value, props.chapters.length, props.tocLoading] as const,
  async ([open, chapterCount, tocLoading], prev) => {
    if (!open || tocLoading || chapterCount <= 0) return;
    const prevCount = prev?.[1] ?? 0;
    const wasTocLoading = prev?.[2] ?? false;
    // 目录从空到有，或 tocLoading 刚结束且已有章节
    if (prevCount > 0 && !wasTocLoading) return;
    await nextTick();
    await bootstrapReaderContent();
  },
);

onMounted(() => {
  offFullscreen = window.colorTxt.onFullscreenChanged(({ isFullscreen }) => {
    isFullscreenView.value = isFullscreen;
    if (!isFullscreen) {
      dismissFullscreenChromeForNativeExit();
    } else {
      void nextTick(() => {
        requestAnimationFrame(() => {
          readerRef.value?.focusEditor?.();
        });
      });
    }
    pulseChapterListCenter();
  });
  clampSidebarWidthToViewport();
  window.addEventListener("mousemove", onWindowMouseMove);
  window.addEventListener("mouseup", onWindowMouseUp);
  window.addEventListener("resize", clampSidebarWidthToViewport);
  window.addEventListener("storage", onStorageSync);
  window.addEventListener(persistedSettingsChangedEvent, onPersistedSettingsChanged);
  window.addEventListener(findBookReplaceRulesChangedEvent, onReplaceRulesChanged);
  document.addEventListener("keydown", onDocumentKeydownEscape, true);
  void refreshReplaceRulesCache();
});

onBeforeUnmount(() => {
  window.colorTxt.setWindowTitle(FIND_BOOK_WINDOW_TITLE);
  offFullscreen?.();
  window.removeEventListener("mousemove", onWindowMouseMove);
  window.removeEventListener("mouseup", onWindowMouseUp);
  window.removeEventListener("resize", clampSidebarWidthToViewport);
  window.removeEventListener("storage", onStorageSync);
  window.removeEventListener(
    persistedSettingsChangedEvent,
    onPersistedSettingsChanged,
  );
  window.removeEventListener(
    findBookReplaceRulesChangedEvent,
    onReplaceRulesChanged,
  );
  document.removeEventListener("keydown", onDocumentKeydownEscape, true);
  voiceRead.exitVoiceRead();
  timedScroll.stopTimedScroll();
  cancelChapterLoad();
});

defineExpose({
  bringToFront: () => {
    modalRef.value?.bringToFront?.();
  },
  refreshChapterCacheStatus,
  clearChapterCacheMarks,
  openChapter: (contentIndex: number) => {
    const startIndex = displayIndexForContentIndex(contentIndex);
    if (displayChapters.value.length) {
      void loadChapterAtDisplayIndex(startIndex, { smoothScroll: false });
    }
  },
  readerEditMode,
  applyEditFormatTextReplace: (rules: ReplaceRule[]) =>
    readerRef.value?.applyEditFormatTextReplace?.(rules),
});

const modalRef = ref<InstanceType<typeof AppModal> | null>(null);
</script>

<template>
  <AppModal
    ref="modalRef"
    v-model="modelValue"
    title=""
    fullscreen
    panel-class="findBookReaderPanel"
    :fullscreen-header-float="false"
    :mask-closable="false"
    :esc-closable="false"
    :show-close-button="false"
    :body-scroll="false"
  >
    <div
      class="findBookReaderShell"
      :class="{
        fullscreen: isFullscreenView,
        'fullscreen--cursorHidden': isFullscreenView && fullscreenCursorHidden,
      }"
    >
      <div
        :ref="setFullscreenHeaderOverlayEl"
        class="findBookReaderHeaderWrap"
        v-show="!isFullscreenView || showFullscreenHeader"
        @mouseleave="onFullscreenHeaderMouseLeave"
      >
        <div v-show="!isFullscreenView" class="findBookReaderTopBar">
          <IconButton
            :icon-html="icons.back"
            title="返回"
            aria-label="返回"
            @click="onBack"
          />
          <nav class="findBookReaderBreadcrumb" aria-label="阅读">
            <span v-if="breadcrumbSourceName" class="findBookReaderBreadcrumbSource">{{
              breadcrumbSourceName
            }}</span>
            <span
              v-if="breadcrumbSourceName"
              class="findBookReaderBreadcrumbSep"
              aria-hidden="true"
            >/</span>
            <span class="findBookReaderBreadcrumbCurrent">{{ detail.name }}</span>
          </nav>
          <div class="findBookReaderTopBarActions">
            <IconButton
              v-if="showReaderLogBtn"
              class="findBookReaderLogBtn"
              :class="{ 'findBookReaderLogBtn--warning': readerLogHasError }"
              :icon-html="icons.info"
              title="日志"
              aria-label="日志"
              @click="onShowLogs"
            />
            <IconButton
              title="重新获取当前章节（忽略缓存）"
              aria-label="重新获取当前章节（忽略缓存）"
              :disabled="
                refreshingChapter ||
                readerBootLoading ||
                chapterContentBusy ||
                !displayChapters.length
              "
              :aria-busy="refreshingChapter || undefined"
              @click="onRefresh"
            >
              <RefreshIcon :spinning="refreshingChapter" />
            </IconButton>
            <IconButton
              v-if="showChapterPayBtn"
              :icon-html="icons.buy"
              title="购买"
              aria-label="购买"
              :disabled="payingChapter || readerBootLoading || chapterContentBusy"
              :aria-busy="payingChapter || undefined"
              @click="onChapterPay"
            />
            <IconButton
              v-if="sourceNeedsLogin"
              :icon-html="icons.login"
              title="登录"
              aria-label="登录"
              @click="onLogin"
            />
            <div ref="topMoreBtnRef" class="findBookReaderTopMoreWrap">
              <IconButton
                :icon-html="icons.more"
                :active="topMoreOpen"
                :pressed="topMoreOpen"
                title="更多"
                aria-label="更多"
                aria-haspopup="menu"
                :aria-expanded="topMoreOpen"
                @click="toggleTopMoreMenu"
              />
            </div>
          </div>
        </div>
        <AppShellMenuTeleport
          v-model:open="topMoreOpen"
          :left="topMoreLeft"
          :top="topMoreTop"
          :on-panel-mount="bindTopMorePanel"
        >
          <button
            type="button"
            class="appShellMenuItem"
            role="menuitem"
            @click="onOpenBookDetail"
          >
            <span class="appShellMenuLabel">书籍信息</span>
          </button>
          <button
            type="button"
            class="appShellMenuItem"
            role="menuitem"
            :disabled="!displayChapters[currentDisplayIndex]?.url?.trim()"
            @click="onCopyChapterUrl"
          >
            <span class="appShellMenuLabel">复制正文 URL</span>
          </button>
          <button
            type="button"
            class="appShellMenuItem"
            role="menuitem"
            :disabled="!item.origin?.trim()"
            @click="onEditBookSource"
          >
            <span class="appShellMenuLabel">编辑书源</span>
          </button>
          <button
            type="button"
            class="appShellMenuItem appShellMenuItem--warning"
            role="menuitem"
            :disabled="
              offlineCaching ||
              !(detail.bookUrl?.trim() || item.bookUrl?.trim())
            "
            @click="onClearChapterCache"
          >
            <span class="appShellMenuLabel">清除缓存</span>
          </button>
        </AppShellMenuTeleport>
        <FindBookReaderHeader
          :in-bookshelf="inBookshelf"
          :current-theme="currentTheme"
          :show-sidebar="showSidebar"
          :in-fullscreen="isFullscreenView"
          :can-increase-font="canIncreaseFont"
          :can-decrease-font="canDecreaseFont"
          :can-increase-line-height="canIncreaseLineHeight"
          :can-decrease-line-height="canDecreaseLineHeight"
          :monaco-font-family="monacoFontFamily"
          :pinned-other-fonts="pinnedOtherFonts"
          :monaco-advanced-wrapping="monacoAdvancedWrapping"
          :monaco-custom-highlight="monacoCustomHighlight"
          :compress-blank-lines="compressBlankLines"
          :lead-indent-full-width="leadIndentFullWidth"
          :text-convert-zh="textConvertZh"
          :text-convert-letter="textConvertLetter"
          :text-convert-digit="textConvertDigit"
          :voice-read-active="isVoiceReadActive"
          :can-voice-read="canStartVoiceRead"
          :timed-scroll-active="isTimedScrollActive"
          :can-timed-scroll="canStartTimedScroll"
          :voice-read-header-locked="isVoiceReadScrollLocked"
          :settings-shortcut-label="settingsShortcutLabel"
          :reader-edit-mode="readerEditMode"
          :can-enter-reader-edit-mode="canEnterReaderEditMode"
          :text-replace-active="textReplaceActive"
          @change-theme="onChangeTheme"
          @toggle-sidebar="showSidebar = !showSidebar"
          @toggle-fullscreen="toggleFullscreen"
          @set-monaco-font="readerUi.setMonacoFontFamily"
          @toggle-pin-other-font="readerUi.togglePinnedOtherFont"
          @increase-font-size="readerUi.increaseFontSize"
          @decrease-font-size="readerUi.decreaseFontSize"
          @increase-line-height="readerUi.increaseLineHeight"
          @decrease-line-height="readerUi.decreaseLineHeight"
          @toggle-compress-blank-lines="toggleCompressBlankLines"
          @toggle-lead-indent-full-width="toggleLeadIndentFullWidth"
          @format-edit-compress-blank-lines="onFormatEditCompressBlankLines"
          @format-edit-lead-indent-full-width="onFormatEditLeadIndentFullWidth"
          @select-text-convert-zh-read="setTextConvertZhRead"
          @select-text-convert-letter-read="setTextConvertLetterRead"
          @select-text-convert-digit-read="setTextConvertDigitRead"
          @apply-text-convert-zh-edit="onApplyTextConvertZhEdit"
          @apply-text-convert-letter-edit="onApplyTextConvertLetterEdit"
          @apply-text-convert-digit-edit="onApplyTextConvertDigitEdit"
          @toggle-monaco-advanced-wrapping="readerUi.toggleMonacoAdvancedWrapping"
          @toggle-monaco-custom-highlight="readerUi.toggleMonacoCustomHighlight"
          @voice-read-toggle="voiceRead.toggleVoiceReadToolbar"
          @timed-scroll-toggle="timedScroll.toggleTimedScroll"
          @open-settings="emit('openSettings')"
          @toggle-bookshelf="onToggleBookshelf"
          @open-text-replace="onOpenTextReplace"
          @toggle-reader-edit="onToggleReaderEdit"
          @save-reader-chapter="onSaveReaderChapter"
        />
      </div>

      <div
        class="findBookReaderBody"
        @mousedown="onLayoutMouseDown"
        @wheel.capture="onLayoutWheel"
      >
        <aside
          v-show="sidebarShellVisible"
          ref="fullscreenSidebarOverlayRef"
          class="findBookReaderSidebar"
          data-reader-sidebar-root
          :class="{ 'sidebarPaneWrap--fullscreen': isFullscreenView }"
          :style="{ width: `${sidebarPanelWidth}px` }"
          @mouseleave="onFullscreenSidebarMouseLeave"
        >
          <div class="sidebarPanelColumn">
            <div class="sidebarHeader">
              <div class="sidebarHeaderStart">
                <span class="sidebarHeaderTitle">章节</span>
                <IconButton
                  title="重新获取目录"
                  aria-label="重新获取目录"
                  :disabled="
                    refreshingToc ||
                    tocLoading ||
                    offlineCaching ||
                    !(detail.bookUrl?.trim() || item.bookUrl?.trim())
                  "
                  :aria-busy="refreshingToc || undefined"
                  @click="onRefreshToc"
                >
                  <RefreshIcon :spinning="refreshingToc" />
                </IconButton>
              </div>
              <div
                v-if="displayChapters.length || readerBootLoading"
                class="sidebarHeaderEnd"
              >
                <IconButton
                  :icon-html="icons.cache"
                  title="离线缓存"
                  aria-label="离线缓存"
                  :disabled="
                    readerBootLoading ||
                    refreshingToc ||
                    offlineCaching ||
                    !(detail.bookUrl?.trim() || item.bookUrl?.trim())
                  "
                  @click="onStartOfflineCache"
                />
                <IconButton
                  :icon-html="chapterSortDesc ? icons.desc : icons.asc"
                  :title="chapterSortDesc ? '倒序' : '正序'"
                  :aria-label="chapterSortDesc ? '切换为正序' : '切换为倒序'"
                  :pressed="chapterSortDesc"
                  :disabled="
                    readerBootLoading ||
                    refreshingToc ||
                    !displayChapters.length
                  "
                  @click="toggleChapterSort"
                />
              </div>
            </div>
            <div
              v-if="offlineCaching"
              class="sidebarCacheBar"
              role="progressbar"
              :aria-valuenow="offlineCacheProgress.current"
              aria-valuemin="0"
              :aria-valuemax="offlineCacheProgress.total"
              :aria-label="offlineCacheProgressLabel"
            >
              <span class="sidebarCacheBarLabel">{{
                offlineCacheProgressLabel
              }}</span>
              <button
                type="button"
                class="link danger sidebarCacheBarStop"
                @click="onStopOfflineCache"
              >
                停止
              </button>
              <div class="sidebarCacheBarTrack" aria-hidden="true">
                <div
                  class="sidebarCacheBarFill"
                  :style="{ width: `${offlineCacheProgressPercent}%` }"
                />
              </div>
            </div>
            <div class="sidebarListWrap">
              <div class="sidebarTabBody">
                <div v-if="!displayChapters.length" class="empty">
                  <span
                    v-if="readerBootLoading"
                    class="findBookReaderLoadingHint"
                    aria-live="polite"
                  >
                    加载中<LoadingDotsBounce />
                  </span>
                  <template v-else>暂无章节</template>
                </div>
                <div v-else class="sidebarListViewportPad">
                  <VirtualList
                    ref="chapterListRef"
                    class="sidebarList sidebarList--itemGap"
                    :item-count="displayChapters.length"
                    :row-stride="READER_SIDEBAR_ROW_STRIDE"
                    :overscan="10"
                    :item-key="(i) => i"
                  >
                    <template #default="{ index }">
                      <button
                        type="button"
                        class="sidebarItem"
                        :class="{
                          active: index === currentDisplayIndex,
                          'sidebarItem--vip':
                            displayChapters[index]?.isVip ||
                            displayChapters[index]?.isPay,
                        }"
                        :title="chapterDisplayTitle(index)"
                        @click="onChapterClick(index)"
                      >
                        <span
                          v-if="
                            displayChapters[index]?.isVip ||
                            displayChapters[index]?.isPay
                          "
                          class="findBookReaderChapterLock"
                          :class="{
                            'findBookReaderChapterLock--unlocked':
                              displayChapters[index]?.isPay,
                          }"
                          v-html="
                            displayChapters[index]?.isPay
                              ? icons.unlock
                              : icons.lock
                          "
                          :aria-label="
                            displayChapters[index]?.isPay ? '已购买' : 'VIP'
                          "
                        />
                        <span class="itemName">{{ chapterDisplayTitle(index) }}</span>
                        <LoadingDotsRotate
                          v-if="isChapterLoading(index)"
                          class="findBookReaderChapterLoading"
                          title="加载中"
                          aria-label="加载中"
                        />
                        <LoadingDotsRotate
                          v-else-if="isChapterOfflineCaching(displayChapters[index])"
                          class="findBookReaderChapterLoading"
                          title="正在缓存"
                          aria-label="正在缓存"
                        />
                        <span
                          v-else-if="isChapterCached(displayChapters[index])"
                          class="findBookReaderChapterCached"
                          v-html="icons.ok"
                          title="已离线缓存"
                          aria-label="已离线缓存"
                        />
                      </button>
                    </template>
                  </VirtualList>
                </div>
              </div>
              <div v-if="displayChapters.length" class="sidebarTabFooter">
                <span class="sidebarTabFooterStat"
                  >共 {{ displayChapters.length }} 章</span
                >
              </div>
            </div>
          </div>
          <div
            class="resizer findBookReaderResizer"
            @mousedown="startResizeSidebar"
          ></div>
        </aside>

        <div
          ref="readerPaneWrapRef"
          class="findBookReaderMainWrap"
          :style="fullscreenReaderPaneStyle"
        >
          <p
            v-if="readerBootLoading || showChapterLoadingUi"
            class="findBookReaderLoading"
            aria-live="polite"
          >
            <span class="findBookReaderLoadingHint">
              加载中<LoadingDotsBounce />
            </span>
          </p>
          <p
            v-else-if="chapterError && !readerContentKey"
            class="findBookReaderError"
          >
            {{ chapterError }}
          </p>
          <ReaderMain
            ref="readerRef"
            class="readerPane findBookReaderMain"
            :stream-loading="readerBootLoading || showChapterLoadingUi"
            :voice-read-scroll-locked="isVoiceReadScrollLocked"
            :voice-read-paused="isVoiceReadActive && voiceRead.mode.value === 'paused'"
            :voice-read-blocks-find="isVoiceReadBlocksFind"
            @voice-read-resume="voiceRead.togglePlayPause"
            :monaco-custom-highlight="monacoCustomHighlight"
            :txtr-delimited-match-cross-line="txtrDelimitedMatchCrossLine"
            :compress-blank-lines="compressBlankLines"
            :lead-indent-full-width="leadIndentFullWidth"
            :chapter-min-char-count="chapterMinCharCount"
            :monaco-advanced-wrapping="monacoAdvancedWrapping"
            :monaco-smooth-scrolling="monacoSmoothScrolling"
            :sticky-chapter-title-enabled="stickyChapterTitleEnabled"
            :reader-surface-light="effectiveReaderSurfaceLight"
            :reader-surface-dark="effectiveReaderSurfaceDark"
            :reader-palette-color-enabled="readerPaletteColorEnabledForReader"
            :highlight-colors="highlightColorsForReader"
            :lineation-colors="currentTheme === 'vs' ? lineationColorsLight : lineationColorsDark"
            :highlight-words-by-index="highlightWordsByIndexGlobal"
            :reader-fullscreen="isFullscreenView"
            :reader-edit-mode="readerEditMode"
            :reader-edit-show-line-numbers="readerEditShowLineNumbers"
            :reader-edit-minimap="readerEditMinimap"
            :monaco-font-family="monacoFontFamily"
            @viewport-top-line-change="readerUi.onViewportTopLineChange"
            @viewport-end-line-change="onFindBookViewportEndLineChange"
            @viewport-visual-progress-change="readerUi.onViewportVisualProgressChange"
            @reader-edit-dirty-change="onReaderEditDirtyChange"
            @reader-edit-save-request="onSaveReaderChapter"
          />
          <VoiceReadToolbar
            :visible="isVoiceReadActive"
            :mode="voiceRead.mode.value"
            :synthesizing="voiceRead.isSynthesizing.value"
            :synthesizing-phase="voiceRead.synthesizingPhase.value"
            :toolbar-rate="voiceRead.toolbarRate.value"
            :toolbar-volume="voiceRead.toolbarVolume.value"
            :engine="voiceReadSettings.engine"
            :can-prev-line="voiceRead.canPlayPrevLine.value"
            :can-next-line="voiceRead.canPlayNextLine.value"
            @update:toolbar-rate="voiceRead.toolbarRate.value = $event"
            @update:toolbar-volume="voiceRead.setToolbarVolume($event)"
            @toggle-play-pause="voiceRead.togglePlayPause"
            @prev-line="voiceRead.playPrevLine"
            @next-line="voiceRead.playNextLine"
            @regenerate="voiceRead.regenerateCurrentLine"
            @stop="voiceRead.exitVoiceRead"
          />
          <ReaderChapterNavBar
            v-if="chapterNavUiVisible && !isFullscreenView"
            :visible="chapterNavVisible"
            :can-go-prev="canGoPrevChapter"
            :can-go-next="canGoNextChapter"
            :disabled="chapterNavBusy"
            @prev="goToPrevChapter"
            @next="goToNextChapter"
          />
        </div>
      </div>

      <div
        :ref="setFullscreenFooterOverlayEl"
        class="findBookReaderFooterWrap"
        v-show="!isFullscreenView || showFullscreenFooter"
        @mouseleave="onFullscreenFooterMouseLeave"
      >
        <ReaderChapterNavBar
          v-if="chapterNavUiVisible && isFullscreenView"
          :visible="chapterNavVisible"
          :can-go-prev="canGoPrevChapter"
          :can-go-next="canGoNextChapter"
          :disabled="chapterNavBusy"
          @prev="goToPrevChapter"
          @next="goToNextChapter"
        />
        <FindBookReaderFooter
          :loading="footerLoading"
          :has-content="footerHasContent"
          :reading-progress-percent-part="footerReadingProgress.percentPart"
          :reading-progress-detail-part="footerReadingProgress.detailPart"
          :reading-progress-placeholder="footerReadingProgress.placeholder"
          :reading-progress-complete="footerReadingProgress.complete"
          :chapter-char-count-text="footerChapterCharCountText"
          :pomodoro-enabled="pomodoroEnabled"
          :pomodoro-phase="pomodoroPhase"
          :pomodoro-display-mode="pomodoroDisplayMode"
          :pomodoro-progress="pomodoroProgress"
          :pomodoro-countdown-text="pomodoroCountdownText"
          :pomodoro-pause-resume-label="pomodoroPauseResumeLabel"
          :pomodoro-paused="pomodoroPaused"
          @pomodoro-start="startPomodoro"
          @pomodoro-toggle-display-mode="togglePomodoroDisplayMode"
          @pomodoro-toggle-pause="togglePomodoroPause"
          @pomodoro-stop="stopPomodoro"
        />
      </div>

      <div
        v-if="showFullscreenTip"
        class="fullscreenTip"
        :class="{ fading: fullscreenTipFading }"
      >
        按 ESC 退出全屏
      </div>
      <FullscreenSystemClock
        :visible="isFullscreenView && fullscreenShowSystemTime"
        :pomodoro-visible="isFullscreenView && pomodoroPhase !== 'idle'"
        :pomodoro-progress="pomodoroProgress"
        :pomodoro-paused="pomodoroPaused"
      />
      <PomodoroBreakOverlay
        :visible="pomodoroShowBreakOverlay"
        :countdown-text="pomodoroCountdownText"
        @finish="finishPomodoroBreakEarly"
      />
    </div>

    <EditBookSourcePanel
      v-model="showEditSource"
      :source-url="editingSourceUrl"
      :initial-tab="editSourceInitialTab"
      @done="onEditSourceDone"
      @search-source="onSearchFromEdit"
    />
    <BookSourceLoginPanel v-model="showLogin" :source="loginSource" />
  </AppModal>
</template>

<style>
.appModalPanel.findBookReaderPanel .appModalBody {
  padding: 0;
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.findBookReaderShell.fullscreen {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  position: relative;
  --txtr-fullscreen-scrollbar-size: 14px;
}

.findBookReaderShell.fullscreen.fullscreen--cursorHidden,
.findBookReaderShell.fullscreen.fullscreen--cursorHidden * {
  cursor: none !important;
}

.findBookReaderShell.fullscreen .findBookReaderBody {
  background: var(--reader-bg);
}

.findBookReaderFooterWrap {
  flex: 0 0 auto;
}

.findBookReaderShell.fullscreen .findBookReaderFooterWrap {
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  z-index: 3400;
  background: var(--bg);
  animation: findBookReaderFullscreenFooterIn 140ms ease-out;
}

@keyframes findBookReaderFullscreenFooterIn {
  from {
    opacity: 0;
    transform: translateY(8px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.findBookReaderShell.fullscreen .findBookReaderHeaderWrap {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  z-index: 3500;
  background: var(--bg);
  border-bottom: 1px solid var(--border);
  animation: findBookReaderFullscreenHeaderIn 140ms ease-out;
}

.findBookReaderShell.fullscreen .findBookReaderSidebar.sidebarPaneWrap--fullscreen {
  position: fixed;
  left: 0;
  top: 0;
  bottom: 0;
  z-index: 3000;
  box-shadow: 6px 0 28px rgba(0, 0, 0, 0.45);
  animation: findBookReaderFullscreenSidebarIn 180ms ease-out;
}

.findBookReaderShell.fullscreen .readerPane.content--readerEditMinimap .monaco-editor .minimap {
  position: fixed !important;
  left: auto !important;
  right: var(--txtr-fullscreen-scrollbar-size) !important;
  z-index: 9;
}

.findBookReaderShell.fullscreen .readerPane .monaco-editor .decorationsOverviewRuler,
.findBookReaderShell.fullscreen .readerPane .monaco-editor .monaco-scrollable-element > .scrollbar.vertical {
  position: fixed !important;
  left: auto !important;
  right: 0 !important;
}

.fullscreenTip {
  position: absolute;
  top: 12px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 50;
  pointer-events: none;
  background: rgba(0, 0, 0, 0.55);
  border: 1px solid rgba(255, 255, 255, 0.12);
  color: #fff;
  padding: 8px 12px;
  border-radius: 999px;
  font-size: 12px;
  opacity: 1;
  transition: opacity 250ms ease;
}

.fullscreenTip.fading {
  opacity: 0;
}

@keyframes findBookReaderFullscreenSidebarIn {
  from {
    opacity: 0;
    transform: translateX(-12px);
  }
  to {
    opacity: 1;
    transform: translateX(0);
  }
}

@keyframes findBookReaderFullscreenHeaderIn {
  from {
    opacity: 0;
    transform: translateY(-8px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

</style>

<style scoped>
.findBookReaderBreadcrumb {
  display: flex;
  align-items: center;
  flex: 1;
  min-width: 0;
  font-size: 14px;
  line-height: 1.4;
}
.findBookReaderBreadcrumbSource {
  color: var(--muted);
  max-width: 45%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex-shrink: 1;
}
.findBookReaderBreadcrumbSep {
  margin: 0 8px;
  color: var(--muted);
  flex-shrink: 0;
  user-select: none;
}
.findBookReaderBreadcrumbCurrent {
  color: var(--fg);
  font-weight: 600;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.findBookReaderLogBtn {
  flex-shrink: 0;
}
.findBookReaderLogBtn--warning :deep(.icon),
.findBookReaderLogBtn--warning :deep(svg path) {
  color: var(--warning);
}
.findBookReaderTopBarActions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
  margin-left: auto;
}
.findBookReaderTopMoreWrap {
  display: inline-flex;
  flex-shrink: 0;
}
.findBookReaderShell {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}
.findBookReaderHeaderWrap {
  flex-shrink: 0;
}
.findBookReaderTopBar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px;
  border-bottom: 1px solid var(--border);
  min-width: 0;
  background: var(--panel);
}
.findBookReaderBody {
  flex: 1;
  min-height: 0;
  display: flex;
}
.findBookReaderSidebar {
  position: relative;
  flex-shrink: 0;
  border-right: 1px solid var(--border);
  background: var(--panel);
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.findBookReaderResizer {
  position: absolute;
  top: 0;
  right: -3px;
  bottom: 0;
  z-index: 20;
  width: 6px;
  cursor: col-resize;
  touch-action: none;
}
.findBookReaderResizer:hover {
  background: var(--accent);
}
.sidebarPanelColumn {
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--panel);
}
.sidebarHeader {
  flex: 0 0 auto;
  background: var(--bg);
  padding: 8px 10px;
  font-size: 12px;
  color: var(--muted);
  border-bottom: 1px solid var(--border);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  height: 44px;
}
.sidebarHeaderTitle {
  font-size: 12px;
  font-weight: 600;
  color: var(--tab-fg-active);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}
.sidebarHeaderStart {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  flex: 1;
}
.sidebarHeaderEnd {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.sidebarListWrap {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.sidebarTabBody {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg);
}
.sidebarListViewportPad {
  flex: 1;
  min-height: 0;
  min-width: 0;
  display: flex;
  flex-direction: column;
  padding: 0;
  background: var(--bg);
}
.sidebarList {
  flex: 1 1 auto;
  min-height: 0;
  min-width: 0;
}
.sidebarList--itemGap :deep(.virtualList-row) {
  padding-bottom: 5px;
}
.findBookReaderSidebar :deep(.virtualList-scroll.sidebarList) {
  box-sizing: border-box;
  padding: 6px 6px 1px;
}
.findBookReaderSidebar :deep(.virtualList-scroll.sidebarList::-webkit-scrollbar-thumb) {
  border-right-width: 0;
}
.sidebarItem {
  width: 100%;
  text-align: left;
  background: transparent;
  border: none;
  color: var(--list-item-fg);
  padding: 8px 10px;
  border-radius: 4px;
  cursor: pointer;
  display: flex;
  gap: 8px;
  align-items: center;
}
.sidebarItem--vip {
  color: var(--muted);
}
.itemName {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.findBookReaderChapterCached,
.findBookReaderChapterLoading {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  color: var(--muted);
}
.findBookReaderChapterLoading {
  color: var(--accent);
}
.findBookReaderChapterCached :deep(svg) {
  width: 14px;
  height: 14px;
  display: block;
}
.findBookReaderChapterCached :deep(svg path) {
  fill: currentColor;
}
.sidebarItem:hover {
  color: var(--list-item-fg);
  background: var(--list-item-bg-hover);
}
.sidebarItem.active {
  color: var(--list-item-fg-active);
  background: var(--list-item-bg-active);
}
.empty {
  box-sizing: border-box;
  flex: 1;
  min-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  text-align: center;
  padding: 10px 16px;
  font-size: 12px;
  color: var(--secondary);
}
.sidebarCacheBar {
  position: relative;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-height: 28px;
  padding: 10px;
  font-size: 12px;
  color: var(--muted);
  border-bottom: 1px solid var(--border);
  background: var(--bg);
  user-select: none;
}
.sidebarCacheBarLabel {
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.sidebarCacheBarStop {
  flex-shrink: 0;
}
.sidebarCacheBarTrack {
  position: absolute;
  left: 0;
  right: 0;
  top: 0;
  height: 3px;
  z-index: 1;
  pointer-events: none;
  background: color-mix(in srgb, var(--accent) 12%, transparent);
  overflow: hidden;
}
.sidebarCacheBarFill {
  height: 100%;
  background: var(--accent);
  transition: width 0.2s ease;
}
.sidebarTabFooter {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 10px;
  font-size: 12px;
  color: var(--muted);
  border-top: 1px solid var(--border);
  background: var(--bg);
  user-select: none;
}
.sidebarTabFooterStat {
  flex: 1;
  min-width: 0;
  text-align: left;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.findBookReaderChapterLock {
  display: inline-flex;
  width: 14px;
  flex-shrink: 0;
  color: var(--warning);
}
.findBookReaderChapterLock--unlocked {
  color: var(--accent);
}
.findBookReaderChapterLock :deep(svg) {
  width: 14px;
  height: 14px;
}
.findBookReaderChapterLock :deep(svg path) {
  fill: currentColor;
}
.findBookReaderMainWrap {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  position: relative;
}
.findBookReaderMainWrap > :deep(.voiceReadToolbarLayer) {
  z-index: 100;
}
.findBookReaderMain {
  flex: 1;
  min-height: 0;
}
.findBookReaderLoading {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  margin: 0;
  padding: 0;
  font-size: 14px;
  color: var(--muted);
  text-align: center;
  z-index: 2;
  pointer-events: none;
  background: var(--reader-bg);
}
.findBookReaderLoadingHint {
  display: inline-flex;
  align-items: center;
  gap: 2px;
}
.findBookReaderError {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  margin: 0;
  padding: 16px;
  font-size: 14px;
  color: var(--danger);
  text-align: center;
  z-index: 2;
  pointer-events: none;
}
</style>
