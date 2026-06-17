import { computed, nextTick, ref, shallowRef, watch, type ShallowRef } from "vue";
import * as monaco from "monaco-editor";
import { clampLineationColorIndex } from "../constants/annotationColors";
import type { LineationLastColorPrefs } from "../constants/annotationColors";
import {
  ANNOTATION_VIEWPORT_BUFFER_LINES,
  ANNOTATION_VIEWPORT_SYNC_MS,
  buildAnnotationDecorationsForViewport,
  buildAnnotationHitsByDisplayLine,
  monacoRangeFromAnnotation,
  type AnnotationCompactHit,
} from "../reader/readerAnnotationDecor";
import type {
  ReaderAnnotationRecord,
  ReaderLineationType,
} from "../stores/fileMetaStore";
import {
  annotationPhysicalRange,
  annotationColumnMapOptions,
  collapseAnnotationQuoteText,
  createAnnotationFromRange,
  displayColumnToPhysicalColumn,
  findAnnotationAtPoint,
  findAnnotationContainingRange,
  findAnnotationMatchingExactSelection,
  findAnnotationsIntersectingRange,
  getTextInDisplayRangeFromStoredRange,
  getTextInPhysicalRangeFromLines,
  monacoRangeToPhysicalRange,
  physicalRangeToMonacoRange,
  resolveAnnotationDisplayQuote,
  rangesEqual,
  unionPhysicalRanges,
  type AnnotationColumnMapOptions,
  type AnnotationDisplayQuoteContext,
  type AnnotationRange,
} from "../utils/readerAnnotations";
import { getRangeViewportAnchor, computeFloatPlacement } from "../reader/readerHighlightGeometry";
import {
  positionFromClientPoint,
  clientXWithinSingleLineModelRange,
} from "../reader/readerEbookPointer";
import { appToast } from "../services/appToast";
import {
  findHighlightColorIndexInMap,
} from "../utils/highlightWords";

export function useReaderAnnotations(opts: {
  editor: { value: monaco.editor.IStandaloneCodeEditor | null };
  model: { value: monaco.editor.ITextModel | null };
  readerAnnotations: () => ReaderAnnotationRecord[];
  lineationLastColors: () => LineationLastColorPrefs;
  readerFilePath: () => string | null | undefined;
  readerEditMode: () => boolean;
  monacoCustomHighlight: () => boolean;
  highlightWordsByIndexBookOnly: () => Record<string, string[]> | undefined;
  highlightColorsLength: () => number;
  lineationColorsLength: () => number;
  emitUpsert: (ann: ReaderAnnotationRecord) => void;
  emitRemove: (id: string) => void;
  emitUpdateLineationColor: (payload: {
    type: ReaderLineationType;
    colorIndex: number;
  }) => void;
  emitAddHighlightTerm: (payload: { text: string; colorIndex: number }) => void;
  emitRemoveHighlightTerm: (payload: { text: string }) => void;
  emitAskAiWithQuote: (text: string) => void;
  ebookDisplayLineToPhysical: () =>
    | ((displayLine: number) => number)
    | undefined;
  ebookAnchorPhysicalToDisplay: () =>
    | ((physicalLine: number) => number)
    | undefined;
  /** 源文件物理行文本（标注 `text` 快照） */
  getPhysicalLineContent: (physicalLine: number) => string;
  /** 当前展示层行文本（标注 `displayText` 快照） */
  getDisplayLineContent: (displayLine: number) => string;
  /** 只读态是否启用行首全角缩进（列映射须与展示层一致） */
  leadIndentFullWidth: () => boolean;
  onAnnotationIndexRebuilt?: () => void;
  annotationDecorationsCollection: ShallowRef<monaco.editor.IEditorDecorationsCollection | null>;
}) {
  const toolbarVisible = ref(false);
  const colorPickerMode = ref<null | "highlight" | "lineation">(null);
  const lineationPickerType = ref<ReaderLineationType | null>(null);
  const floatCenterX = ref(0);
  const floatRootTop = ref(0);
  const floatOpenDownward = ref(false);
  const draftText = ref("");
  const draftPhysicalRange = ref<AnnotationRange | null>(null);
  const activeAnnotationId = ref<string | null>(null);
  const floatRootRef = ref<HTMLElement | null>(null);
  const notePanelOpen = ref(false);
  const notePanelDraft = ref("");
  const notePanelSourceText = ref("");
  const notePanelEditing = ref(false);
  const notePanelTargetAnnotationId = ref<string | null>(null);
  const notePanelPhysicalRange = ref<AnnotationRange | null>(null);
  const notePanelRootRef = ref<HTMLElement | null>(null);

  let annotationViewportSyncTimer: ReturnType<typeof setTimeout> | null = null;
  let annotationViewportDecorLastKey = "";
  let annotationViewportDecorLastCount = 0;
  let annotationScrollDisposable: monaco.IDisposable | null = null;
  let annotationViewportSyncRetry = 0;
  const ANNOTATION_VIEWPORT_SYNC_MAX_RETRY = 40;
  const ANNOTATION_VIEWPORT_SYNC_RETRY_MS = 50;
  const annotationHitsByLine = shallowRef<Map<number, AnnotationCompactHit[]>>(
    new Map(),
  );
  const annotationsById = shallowRef<Map<string, ReaderAnnotationRecord>>(
    new Map(),
  );
  let suppressToolbarUntilMs = 0;
  let removeGlobalListeners: (() => void) | null = null;
  let selectionPointerActive = false;
  let selectionPointerUpListener: ((ev: PointerEvent) => void) | null = null;
  /** 选区滚出视口时暂隐工具条，保留 draft 以便滚回后恢复 */
  let toolbarScrollHidden = false;

  function isFindWidgetTarget(target: EventTarget | null): boolean {
    return target instanceof Element && !!target.closest(".find-widget");
  }

  function clearSelectionPointerUpListener() {
    if (selectionPointerUpListener) {
      window.removeEventListener("pointerup", selectionPointerUpListener, true);
      selectionPointerUpListener = null;
    }
  }

  function finishSelectionPointerInteraction(
    clientX: number,
    clientY: number,
  ) {
    if (!selectionPointerActive) return;
    selectionPointerActive = false;
    clearSelectionPointerUpListener();
    if (opts.readerEditMode() || !opts.readerFilePath()) return;
    if (Date.now() < suppressToolbarUntilMs) return;
    void nextTick(() => {
      const ed = opts.editor.value;
      const sel = ed?.getSelection();
      if (sel && !sel.isEmpty()) {
        showToolbarFromSelectionIfAny();
        return;
      }
      if (!tryShowToolbarFromAnnotationPoint(clientX, clientY)) {
        closeToolbarUi();
      }
    });
  }

  function beginSelectionPointerInteraction(startTarget?: EventTarget | null) {
    if (isFindWidgetTarget(startTarget ?? null)) return;
    selectionPointerActive = true;
    if (selectionPointerUpListener) return;
    selectionPointerUpListener = (ev: PointerEvent) => {
      if (ev.button !== 0) return;
      finishSelectionPointerInteraction(ev.clientX, ev.clientY);
    };
    window.addEventListener("pointerup", selectionPointerUpListener, true);
  }

  function cancelSelectionPointerInteraction() {
    selectionPointerActive = false;
    clearSelectionPointerUpListener();
  }

  function physicalToDisplay(n: number): number {
    const fn = opts.ebookAnchorPhysicalToDisplay();
    return typeof fn === "function" ? fn(n) : n;
  }

  function displayToPhysical(n: number): number {
    const fn = opts.ebookDisplayLineToPhysical();
    return typeof fn === "function" ? fn(n) : n;
  }

  function columnMap(): AnnotationColumnMapOptions {
    return annotationColumnMapOptions({
      readerEditMode: opts.readerEditMode(),
      leadIndentFullWidth: opts.leadIndentFullWidth(),
    });
  }

  function annotationDisplayQuoteContext(): AnnotationDisplayQuoteContext {
    return {
      readerEditMode: opts.readerEditMode(),
      getDisplayLineContent: opts.getDisplayLineContent,
      getPhysicalLineContent: opts.getPhysicalLineContent,
      physicalToDisplay,
      columnMap: columnMap(),
      monacoModel: opts.model.value,
      hitsByLine: annotationHitsByLine.value,
    };
  }

  function sourceTextInPhysicalRange(range: AnnotationRange): string {
    return getTextInPhysicalRangeFromLines(
      opts.getPhysicalLineContent,
      range,
      "physical",
    ).trim();
  }

  /** 高亮词持久化：只读存物理原文，编辑态与 Monaco 一致 */
  function highlightTermTextForStorage(): string {
    const display = draftText.value.trim();
    if (!display) return "";
    if (opts.readerEditMode()) return display;
    const range = draftPhysicalRange.value;
    if (!range) return display;
    return sourceTextInPhysicalRange(range) || display;
  }

  function displayTextInPhysicalRange(range: AnnotationRange): string {
    return getTextInDisplayRangeFromStoredRange(
      opts.getDisplayLineContent,
      opts.getPhysicalLineContent,
      range,
      physicalToDisplay,
      columnMap(),
    ).trim();
  }

  function createAnnotationTextsFromRange(range: AnnotationRange): {
    text: string;
    displayText?: string;
  } {
    const text = getTextInPhysicalRangeFromLines(
      opts.getPhysicalLineContent,
      range,
      "physical",
    ).trim();
    const m = opts.model.value;
    let displayText = "";
    if (m && !opts.readerEditMode()) {
      displayText = m
        .getValueInRange(
          physicalRangeToMonacoRange(
            range,
            physicalToDisplay,
            opts.getPhysicalLineContent,
            columnMap(),
          ),
        )
        .trim();
    } else {
      displayText = getTextInDisplayRangeFromStoredRange(
        opts.getDisplayLineContent,
        opts.getPhysicalLineContent,
        range,
        physicalToDisplay,
        columnMap(),
      ).trim();
    }
    return displayText === text ? { text } : { text, displayText };
  }

  /** 侧栏/导出：与阅读器装饰同源的展示层原文 */
  function getAnnotationDisplayQuote(ann: ReaderAnnotationRecord): string {
    return resolveAnnotationDisplayQuote(ann, annotationDisplayQuoteContext());
  }

  function displayTextForAnnotation(ann: ReaderAnnotationRecord): string {
    return getAnnotationDisplayQuote(ann);
  }

  function shouldSuppressToolbar(): boolean {
    return Date.now() < suppressToolbarUntilMs;
  }

  function resolveAnnotationById(
    id: string | null | undefined,
  ): ReaderAnnotationRecord | null {
    if (!id) return null;
    return (
      annotationsById.value.get(id) ??
      opts.readerAnnotations().find((a) => a.id === id) ??
      null
    );
  }

  function activeAnnotation(): ReaderAnnotationRecord | null {
    return resolveAnnotationById(activeAnnotationId.value);
  }

  const activeLineation = computed(() => activeAnnotation()?.lineation);
  const toolbarHasLineation = computed(() => !!activeLineation.value);
  const toolbarHasNote = computed(() =>
    Boolean(activeAnnotation()?.note?.content?.trim()),
  );

  const lineationPickerSelectedIndex = computed(() => {
    if (colorPickerMode.value !== "lineation" || !lineationPickerType.value) {
      return 0;
    }
    const count = opts.lineationColorsLength();
    const ann = activeAnnotation();
    if (
      ann?.lineation?.type === lineationPickerType.value &&
      ann.lineation.colorIndex != null
    ) {
      return clampLineationColorIndex(ann.lineation.colorIndex, count);
    }
    return clampLineationColorIndex(
      opts.lineationLastColors()[lineationPickerType.value],
      count,
    );
  });

  function syncLineationLastColor(
    type: ReaderLineationType,
    colorIndex: number,
  ) {
    opts.emitUpdateLineationColor({ type, colorIndex });
  }

  /** 绑定已有划线标注时同步色盘类型；openIfLineation 为 true 时一并展开标注色盘 */
  function rememberLineationColorFromAnnotation(ann: ReaderAnnotationRecord) {
    if (!ann.lineation?.type || ann.lineation.colorIndex == null) return;
    syncLineationLastColor(ann.lineation.type, ann.lineation.colorIndex);
  }

  function syncLineationPickerFromActiveAnnotation(openIfLineation = false) {
    const ann = activeAnnotation();
    if (!ann?.lineation?.type) {
      if (colorPickerMode.value === "lineation") {
        colorPickerMode.value = null;
        lineationPickerType.value = null;
      }
      return;
    }
    if (openIfLineation) {
      colorPickerMode.value = "lineation";
      lineationPickerType.value = ann.lineation.type;
      rememberLineationColorFromAnnotation(ann);
    } else if (colorPickerMode.value === "lineation") {
      lineationPickerType.value = ann.lineation.type;
      rememberLineationColorFromAnnotation(ann);
    }
  }

  function findStoredHighlightColorIndex(text: string): number | null {
    const idx = findHighlightColorIndexInMap(
      opts.highlightWordsByIndexBookOnly(),
      text,
    );
    if (idx == null || idx >= opts.highlightColorsLength()) return null;
    return idx;
  }

  function syncPickerFromSelection(openIfPicker = false) {
    const ann = activeAnnotation();
    const hasLineation = !!ann?.lineation?.type;
    const hasHighlight = findStoredHighlightColorIndex(draftText.value) != null;

    if (hasLineation) {
      syncLineationPickerFromActiveAnnotation(openIfPicker);
      return;
    }

    if (hasHighlight) {
      if (openIfPicker || colorPickerMode.value === "lineation") {
        colorPickerMode.value = "highlight";
        lineationPickerType.value = null;
      }
      return;
    }

    if (colorPickerMode.value === "lineation") {
      colorPickerMode.value = null;
      lineationPickerType.value = null;
    }
    if (colorPickerMode.value === "highlight") {
      colorPickerMode.value = null;
    }
  }

  const hlPickerExistingColorIndex = computed(() =>
    findStoredHighlightColorIndex(draftText.value.trim()),
  );

  const hlPickerShowRemoveRow = computed(
    () =>
      hlPickerExistingColorIndex.value != null &&
      hlPickerExistingColorIndex.value < opts.highlightColorsLength(),
  );

  function hideToolbarForScrollOut() {
    toolbarVisible.value = false;
    colorPickerMode.value = null;
    lineationPickerType.value = null;
    toolbarScrollHidden = true;
  }

  function closeToolbarUi() {
    toolbarScrollHidden = false;
    toolbarVisible.value = false;
    colorPickerMode.value = null;
    lineationPickerType.value = null;
    draftText.value = "";
    draftPhysicalRange.value = null;
    activeAnnotationId.value = null;
  }

  function maybeCloseToolbarOnEmptySelection() {
    if (!activeAnnotationId.value && !toolbarVisible.value) closeToolbarUi();
  }

  function openNotePanelFromToolbar() {
    bindDraftFromSelection();
    const source = resolveNotePanelSourceText();
    if (!source) return;
    const ann = activeAnnotation();
    notePanelTargetAnnotationId.value = ann?.id ?? activeAnnotationId.value ?? null;
    notePanelPhysicalRange.value =
      draftPhysicalRange.value ??
      (ann ? annotationPhysicalRange(ann) : null);
    notePanelDraft.value = ann?.note?.content ?? "";
    notePanelEditing.value = !!ann?.note?.content?.trim();
    notePanelSourceText.value = source;
    notePanelOpen.value = true;
    /** 笔记面板 registerModal 入栈瞬间不关闭工具条 */
    suppressToolbarUntilMs = Date.now() + 300;
  }

  function ensureNotePanelAnnotationRecord(): ReaderAnnotationRecord | null {
    const existing = resolveAnnotationById(notePanelTargetAnnotationId.value);
    if (existing) return existing;
    const range = notePanelPhysicalRange.value;
    const text = notePanelSourceText.value.trim();
    if (!range || !text) return null;
    const { text: physicalText, displayText } =
      createAnnotationTextsFromRange(range);
    return createAnnotationFromRange(range, physicalText, { displayText });
  }

  function resolveNotePanelSourceText(): string {
    const e = opts.editor.value;
    const m = opts.model.value;
    if (e && m) {
      const sel = e.getSelection();
      if (sel && !sel.isEmpty()) {
        const fromSel = collapseAnnotationQuoteText(m.getValueInRange(sel));
        if (fromSel) return fromSel;
      }
    }
    const fromDraft = collapseAnnotationQuoteText(draftText.value);
    if (fromDraft) return fromDraft;
    const ann = activeAnnotation();
    const fromAnn = ann ? collapseAnnotationQuoteText(displayTextForAnnotation(ann)) : "";
    if (fromAnn) return fromAnn;
    const range = draftPhysicalRange.value;
    if (range) {
      return collapseAnnotationQuoteText(displayTextInPhysicalRange(range));
    }
    return "";
  }

  function closeNotePanel() {
    notePanelOpen.value = false;
    notePanelDraft.value = "";
    notePanelSourceText.value = "";
    notePanelEditing.value = false;
    notePanelTargetAnnotationId.value = null;
    notePanelPhysicalRange.value = null;
  }

  function getToolbarAnchorRange(): monaco.IRange | null {
    const e = opts.editor.value;
    const m = opts.model.value;
    if (!e || !m) return null;
    const sel = e.getSelection();
    if (sel && !sel.isEmpty()) return sel;
    if (draftPhysicalRange.value) {
      return physicalRangeToMonacoRange(
        draftPhysicalRange.value,
        physicalToDisplay,
        opts.getPhysicalLineContent,
        columnMap(),
      );
    }
    const ann = activeAnnotation();
    if (ann) {
      return monacoRangeFromAnnotation(
        ann,
        physicalToDisplay,
        opts.getPhysicalLineContent,
        columnMap(),
      );
    }
    return null;
  }

  function isToolbarRangeInViewport(range: monaco.IRange): boolean {
    const e = opts.editor.value;
    if (!e) return false;
    const lifted = monaco.Range.lift(range);
    for (const vr of e.getVisibleRanges()) {
      if (lifted.intersectRanges(vr)) return true;
    }
    return false;
  }

  function getAnchor() {
    const e = opts.editor.value;
    const m = opts.model.value;
    if (!e || !m) return null;
    const range = getToolbarAnchorRange();
    if (!range) return null;
    return getRangeViewportAnchor(e, m, range);
  }

  function syncToolbarOnScroll() {
    const range = getToolbarAnchorRange();
    const inView = range != null && isToolbarRangeInViewport(range);
    const anchor = inView ? getAnchor() : null;

    if (toolbarVisible.value || colorPickerMode.value) {
      if (!inView || !anchor) {
        hideToolbarForScrollOut();
        return;
      }
      applyFloatPlacement(anchor);
      return;
    }

    if (toolbarScrollHidden && inView && anchor) {
      toolbarScrollHidden = false;
      toolbarVisible.value = true;
      applyFloatPlacement(anchor);
    }
  }

  function getEditorClipRect() {
    const dom = opts.editor.value?.getDomNode();
    if (dom) {
      const r = dom.getBoundingClientRect();
      return { top: r.top, left: r.left, right: r.right, bottom: r.bottom };
    }
    return {
      top: 0,
      left: 0,
      right: window.innerWidth,
      bottom: window.innerHeight,
    };
  }

  const FLOAT_TOOLBAR_H = 72;
  const FLOAT_GAP = 6;
  const FLOAT_PICKER_H = 52;

  function estimateFloatWidth(): number {
    let actions = 6 + (opts.monacoCustomHighlight() ? 1 : 0);
    if (toolbarHasLineation.value) actions += 1;
    return actions * 46 + 24;
  }

  function estimateFloatHeight(): number {
    if (!colorPickerMode.value) return FLOAT_TOOLBAR_H;
    return FLOAT_TOOLBAR_H + FLOAT_GAP + FLOAT_PICKER_H;
  }

  /** 相对选区首行水平居中；钳制于阅读器视口；色盘展开时重新判定上下方向 */
  function applyFloatPlacement(anchor: {
    selectionCenterX: number;
    anchorTop: number;
    lineBottom: number;
  }) {
    const placed = computeFloatPlacement({
      selectionCenterX: anchor.selectionCenterX,
      anchorTop: anchor.anchorTop,
      lineBottom: anchor.lineBottom,
      floatHeight: estimateFloatHeight(),
      floatWidth: estimateFloatWidth(),
      gap: FLOAT_GAP,
      clip: getEditorClipRect(),
    });
    floatOpenDownward.value = placed.openDownward;
    floatRootTop.value = placed.rootTop;
    floatCenterX.value = placed.centerX;
  }

  function reflowToolbarPlacement() {
    const anchor = getAnchor();
    if (!anchor) return;
    applyFloatPlacement(anchor);
  }

  function bindDraftFromAnnotation(ann: ReaderAnnotationRecord) {
    activeAnnotationId.value = ann.id;
    draftText.value = displayTextForAnnotation(ann);
    draftPhysicalRange.value = annotationPhysicalRange(ann);
  }

  function bindDraftFromSelection() {
    const e = opts.editor.value;
    const m = opts.model.value;
    if (!e || !m) return false;
    const sel = e.getSelection();
    if (!sel || sel.isEmpty()) return false;
    const text = m.getValueInRange(sel).trim();
    if (!text) return false;
    const phys = monacoRangeToPhysicalRange(
      sel,
      displayToPhysical,
      opts.getPhysicalLineContent,
      columnMap(),
    );
    const exact = findAnnotationMatchingExactSelection(
      opts.readerAnnotations(),
      sel,
      displayToPhysical,
      opts.getPhysicalLineContent,
      columnMap(),
    );
    const containedIn = findAnnotationContainingRange(
      opts.readerAnnotations(),
      phys,
    );
    if (exact) {
      bindDraftFromAnnotation(exact);
    } else {
      draftText.value = text;
      draftPhysicalRange.value = phys;
      /** 选区完全落在标注内：保留用户选区，但绑定标注以显示工具条激活态 */
      activeAnnotationId.value = containedIn?.id ?? null;
    }
    return true;
  }

  function showToolbarFromSelectionIfAny() {
    if (opts.readerEditMode() || !opts.readerFilePath()) {
      closeToolbarUi();
      return;
    }
    if (!opts.editor.value || !opts.model.value) {
      closeToolbarUi();
      return;
    }
    const sel = opts.editor.value.getSelection();
    if (!sel || sel.isEmpty()) {
      maybeCloseToolbarOnEmptySelection();
      return;
    }
    if (!bindDraftFromSelection()) {
      closeToolbarUi();
      return;
    }
    const anchor = getAnchor();
    if (!anchor) {
      closeToolbarUi();
      return;
    }
    applyFloatPlacement(anchor);
    toolbarScrollHidden = false;
    toolbarVisible.value = true;
    syncPickerFromSelection(true);
  }

  function onSelectionChangedDuringInteraction() {
    if (opts.readerEditMode() || !opts.readerFilePath()) return;
    if (selectionPointerActive) return;
    const sel = opts.editor.value?.getSelection();
    if (!sel || sel.isEmpty()) {
      maybeCloseToolbarOnEmptySelection();
      return;
    }
    if (!toolbarVisible.value) return;
    if (bindDraftFromSelection()) {
      syncPickerFromSelection(true);
    }
  }

  function findAnnotationAtClientPoint(
    clientX: number,
    clientY: number,
  ): ReaderAnnotationRecord | null {
    const ed = opts.editor.value;
    const m = opts.model.value;
    if (!ed || !m) return null;
    const pos = positionFromClientPoint(ed, clientX, clientY);
    if (!pos) return null;
    const hits = annotationHitsByLine.value.get(pos.lineNumber);
    if (hits?.length) {
      for (const h of hits) {
        const range: monaco.Range = new monaco.Range(
          pos.lineNumber,
          h.startColumn,
          pos.lineNumber,
          h.endColumnExclusive,
        );
        if (!range.containsPosition(pos)) continue;
        if (!clientXWithinSingleLineModelRange(ed, m, range, clientX)) continue;
        const ann = annotationsById.value.get(h.annotationId);
        if (ann && !ann.stale) return ann;
      }
    }
    const physicalLine = displayToPhysical(pos.lineNumber);
    const physicalColumn = displayColumnToPhysicalColumn(
      opts.getPhysicalLineContent(physicalLine),
      pos.column,
      columnMap(),
    );
    return findAnnotationAtPoint(
      opts.readerAnnotations(),
      physicalLine,
      physicalColumn,
    );
  }

  /** 点击标注区域：弹出工具条并绑定该标注，但不改变编辑器选区 */
  function showToolbarForAnnotationClick(ann: ReaderAnnotationRecord) {
    if (opts.readerEditMode() || !opts.readerFilePath()) return false;
    const ed = opts.editor.value;
    const m = opts.model.value;
    if (!ed || !m || ann.stale) return false;
    bindDraftFromAnnotation(ann);
    const range = monacoRangeFromAnnotation(
      ann,
      physicalToDisplay,
      opts.getPhysicalLineContent,
      columnMap(),
    );
    const anchor = getRangeViewportAnchor(ed, m, range);
    if (!anchor) return false;
    applyFloatPlacement(anchor);
    toolbarScrollHidden = false;
    toolbarVisible.value = true;
    syncPickerFromSelection(true);
    return true;
  }

  function tryShowToolbarFromAnnotationPoint(
    clientX: number,
    clientY: number,
  ): boolean {
    const ann = findAnnotationAtClientPoint(clientX, clientY);
    if (!ann || ann.stale) return false;
    return showToolbarForAnnotationClick(ann);
  }

  function clearAnnotationViewportDecorations() {
    if (annotationViewportSyncTimer) {
      clearTimeout(annotationViewportSyncTimer);
      annotationViewportSyncTimer = null;
    }
    annotationViewportDecorLastKey = "";
    annotationViewportDecorLastCount = 0;
    annotationViewportSyncRetry = 0;
    annotationHitsByLine.value = new Map();
    opts.annotationDecorationsCollection.value?.clear();
  }

  function rebuildAnnotationIndex() {
    const list = opts.readerAnnotations().filter((a) => !a.stale);
    const idMap = new Map<string, ReaderAnnotationRecord>();
    for (const a of list) idMap.set(a.id, a);
    annotationsById.value = idMap;

    if (opts.readerEditMode()) {
      clearAnnotationViewportDecorations();
      closeToolbarUi();
      opts.onAnnotationIndexRebuilt?.();
      return;
    }

    annotationHitsByLine.value = buildAnnotationHitsByDisplayLine(
      list,
      physicalToDisplay,
      opts.getPhysicalLineContent,
      columnMap(),
      opts.lineationColorsLength(),
    );
    annotationViewportDecorLastKey = "";
    annotationViewportSyncRetry = 0;
    scheduleAnnotationViewportSync(true);
    opts.onAnnotationIndexRebuilt?.();
  }

  async function waitForEditorLayoutReady(): Promise<boolean> {
    for (let i = 0; i < ANNOTATION_VIEWPORT_SYNC_MAX_RETRY; i++) {
      const ed = opts.editor.value;
      const m = opts.model.value;
      if (
        ed &&
        m &&
        m.getLineCount() > 0 &&
        ed.getVisibleRanges().length > 0
      ) {
        await new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        });
        return true;
      }
      await new Promise((r) => setTimeout(r, ANNOTATION_VIEWPORT_SYNC_RETRY_MS));
    }
    return false;
  }

  function refreshAnnotationDecorations() {
    void waitForEditorLayoutReady().then(() => {
      rebuildAnnotationIndex();
    });
  }

  function noteHoverSuppressId(): string | null {
    return toolbarVisible.value && activeAnnotationId.value
      ? activeAnnotationId.value
      : null;
  }

  function dismissEditorContentHover() {
    const ed = opts.editor.value;
    if (!ed) return;
    (
      ed.getContribution("editor.contrib.contentHover") as {
        hideContentHover?: () => void;
      } | null
    )?.hideContentHover?.();
  }

  function syncAnnotationViewportDecorationsNow() {
    const ed = opts.editor.value;
    const m = opts.model.value;
    const collection = opts.annotationDecorationsCollection.value;
    if (!ed || !m || !collection) return;
    if (opts.readerEditMode()) {
      collection.clear();
      annotationViewportDecorLastKey = "";
      annotationViewportDecorLastCount = 0;
      return;
    }
    if (annotationHitsByLine.value.size === 0) {
      collection.clear();
      annotationViewportDecorLastKey = "";
      annotationViewportDecorLastCount = 0;
      return;
    }
    const ranges = ed.getVisibleRanges();
    if (!ranges.length) {
      if (
        annotationViewportSyncRetry < ANNOTATION_VIEWPORT_SYNC_MAX_RETRY &&
        annotationHitsByLine.value.size > 0
      ) {
        annotationViewportSyncRetry++;
        if (annotationViewportSyncTimer) {
          clearTimeout(annotationViewportSyncTimer);
        }
        annotationViewportSyncTimer = setTimeout(() => {
          annotationViewportSyncTimer = null;
          syncAnnotationViewportDecorationsNow();
        }, ANNOTATION_VIEWPORT_SYNC_RETRY_MS);
      }
      return;
    }
    annotationViewportSyncRetry = 0;
    let lo = ranges[0]!.startLineNumber;
    let hi = ranges[0]!.endLineNumber;
    for (const r of ranges) {
      lo = Math.min(lo, r.startLineNumber);
      hi = Math.max(hi, r.endLineNumber);
    }
    lo = Math.max(1, lo - ANNOTATION_VIEWPORT_BUFFER_LINES);
    hi = hi + ANNOTATION_VIEWPORT_BUFFER_LINES;
    const suppressId = noteHoverSuppressId();
    const key = `${lo}:${hi}:${suppressId ?? ""}`;
    if (
      key === annotationViewportDecorLastKey &&
      annotationViewportDecorLastCount > 0
    ) {
      return;
    }
    const decs = buildAnnotationDecorationsForViewport(
      lo,
      hi,
      annotationHitsByLine.value,
      m,
      { suppressNoteHoverForAnnotationId: suppressId },
    );
    annotationViewportDecorLastKey = key;
    annotationViewportDecorLastCount = decs.length;
    collection.set(decs);
  }

  function scheduleAnnotationViewportSync(force = false) {
    if (opts.readerEditMode()) {
      if (force) syncAnnotationViewportDecorationsNow();
      return;
    }
    if (force) {
      if (annotationViewportSyncTimer) {
        clearTimeout(annotationViewportSyncTimer);
        annotationViewportSyncTimer = null;
      }
      syncAnnotationViewportDecorationsNow();
      return;
    }
    if (annotationViewportSyncTimer) return;
    annotationViewportSyncTimer = setTimeout(() => {
      annotationViewportSyncTimer = null;
      syncAnnotationViewportDecorationsNow();
    }, ANNOTATION_VIEWPORT_SYNC_MS);
  }

  function bindAnnotationScrollSync(ed: monaco.editor.IStandaloneCodeEditor) {
    annotationScrollDisposable?.dispose();
    annotationScrollDisposable = ed.onDidScrollChange(() => {
      scheduleAnnotationViewportSync();
      syncToolbarOnScroll();
    });
  }

  function disposeAnnotationDecorations() {
    cancelSelectionPointerInteraction();
    clearAnnotationViewportDecorations();
    annotationsById.value = new Map();
    annotationScrollDisposable?.dispose();
    annotationScrollDisposable = null;
  }

  function prepareLineationTargetAnnotation(): ReaderAnnotationRecord | null {
    const m = opts.model.value;
    if (!m) return null;
    const range = draftPhysicalRange.value;
    const text = draftText.value.trim();
    if (!range || !text) return null;

    const existing = activeAnnotation();
    if (existing && rangesEqual(annotationPhysicalRange(existing), range)) {
      return existing;
    }

    const overlaps = findAnnotationsIntersectingRange(
      opts.readerAnnotations(),
      range,
    );
    for (const ann of overlaps) {
      opts.emitRemove(ann.id);
    }

    const mergedRange = unionPhysicalRanges([
      range,
      ...overlaps.map((ann) => annotationPhysicalRange(ann)),
    ]);
    const { text: mergedText, displayText } =
      createAnnotationTextsFromRange(mergedRange);
    if (!mergedText) return null;

    const ann = createAnnotationFromRange(mergedRange, mergedText, {
      displayText,
    });
    activeAnnotationId.value = ann.id;
    draftPhysicalRange.value = mergedRange;
    draftText.value = displayText ?? mergedText;
    return ann;
  }

  function applyLineation(type: ReaderLineationType, colorIndex: number) {
    const idx = clampLineationColorIndex(
      colorIndex,
      opts.lineationColorsLength(),
    );
    let ann = prepareLineationTargetAnnotation();
    if (!ann) return;
    ann = {
      ...ann,
      lineation: { type, colorIndex: idx },
      updatedAt: Date.now(),
    };
    opts.emitUpsert(ann);
    activeAnnotationId.value = ann.id;
    syncLineationLastColor(type, idx);
    colorPickerMode.value = "lineation";
    lineationPickerType.value = type;
  }

  function onToolbarAction(
    action:
      | "copy"
      | "highlight"
      | "marker"
      | "wavy"
      | "straight"
      | "deleteLineation"
      | "note"
      | "askAi",
  ) {
    if (action === "note") {
      openNotePanelFromToolbar();
      return;
    }
    const text = draftText.value.trim();
    if (!text) return;
    if (action === "copy") {
      void navigator.clipboard.writeText(text).then(
        () => {
          appToast("已复制到剪贴板", { kind: "success", duration: 1000 });
        },
        () => {
          /* ignore */
        },
      );
      return;
    }
    if (action === "askAi") {
      opts.emitAskAiWithQuote(text);
      /** 切换侧栏 / 聚焦 AI 输入框时避免误关工具条 */
      suppressToolbarUntilMs = Date.now() + 500;
      return;
    }
    if (action === "highlight") {
      colorPickerMode.value = "highlight";
      lineationPickerType.value = null;
      return;
    }
    if (action === "deleteLineation") {
      const ann = activeAnnotation();
      if (!ann?.lineation) return;
      if (ann.note?.content?.trim()) {
        opts.emitUpsert({ ...ann, lineation: undefined, updatedAt: Date.now() });
      } else {
        opts.emitRemove(ann.id);
        closeToolbarUi();
      }
      return;
    }
    const typeMap = {
      marker: "marker" as const,
      wavy: "wavy" as const,
      straight: "straight" as const,
    };
    if (action in typeMap) {
      const type = typeMap[action as keyof typeof typeMap];
      const ann = activeAnnotation();
      if (ann?.lineation?.type === type) {
        colorPickerMode.value = "lineation";
        lineationPickerType.value = type;
        return;
      }
      colorPickerMode.value = "lineation";
      lineationPickerType.value = type;
      applyLineation(type, opts.lineationLastColors()[type]);
    }
  }

  function jumpToAnnotationRange(
    ann: ReaderAnnotationRecord,
    options?: { smooth?: boolean },
  ) {
    const ed = opts.editor.value;
    if (!ed) return;
    const range = monacoRangeFromAnnotation(
      ann,
      physicalToDisplay,
      opts.getPhysicalLineContent,
      columnMap(),
    );
    ed.revealRangeInCenter(
      range,
      options?.smooth
        ? monaco.editor.ScrollType.Smooth
        : monaco.editor.ScrollType.Immediate,
    );
    ed.setSelection(range);
    suppressToolbarUntilMs = Date.now() + 300;
    closeToolbarUi();
  }

  watch(() => opts.readerAnnotations(), rebuildAnnotationIndex, { deep: true });

  watch(
    () => [opts.leadIndentFullWidth(), opts.readerEditMode()] as const,
    rebuildAnnotationIndex,
  );

  watch(() => opts.lineationColorsLength(), () => {
    rebuildAnnotationIndex();
  });

  watch(
    () => opts.readerFilePath(),
    () => {
      annotationViewportDecorLastKey = "";
      annotationViewportDecorLastCount = 0;
      rebuildAnnotationIndex();
    },
  );

  watch(
    () => opts.model.value,
    () => {
      annotationViewportDecorLastKey = "";
      annotationViewportDecorLastCount = 0;
      annotationViewportSyncRetry = 0;
      scheduleAnnotationViewportSync(true);
    },
  );

  watch(colorPickerMode, () => {
    if (!toolbarVisible.value) return;
    void nextTick(() => reflowToolbarPlacement());
  });

  watch([toolbarVisible, activeAnnotationId], () => {
    annotationViewportDecorLastKey = "";
    scheduleAnnotationViewportSync(true);
    if (toolbarVisible.value) {
      dismissEditorContentHover();
      syncPickerFromSelection(false);
    }
  });

  watch(toolbarVisible, (v) => {
    if (!v) {
      removeGlobalListeners?.();
      removeGlobalListeners = null;
      return;
    }
    const onDocPointerDown = (ev: PointerEvent) => {
      if (floatRootRef.value?.contains(ev.target as Node)) return;
      if (notePanelRootRef.value?.contains(ev.target as Node)) return;
      const editorDom = opts.editor.value?.getDomNode();
      if (!editorDom?.contains(ev.target as Node)) return;
      closeToolbarUi();
    };
    document.addEventListener("pointerdown", onDocPointerDown, true);
    removeGlobalListeners = () =>
      document.removeEventListener("pointerdown", onDocPointerDown, true);
  });

  return {
    toolbarVisible,
    colorPickerMode,
    lineationPickerType,
    floatCenterX,
    floatRootTop,
    floatOpenDownward,
    floatRootRef,
    activeLineation,
    toolbarHasLineation,
    toolbarHasNote,
    lineationPickerSelectedIndex,
    hlPickerShowRemoveRow,
    hlPickerExistingColorIndex,
    notePanelOpen,
    notePanelDraft,
    notePanelEditing,
    notePanelSourceText,
    notePanelRootRef,
    closeToolbarUi,
    showToolbarFromSelectionIfAny,
    syncToolbarOnScroll,
    onSelectionChangedDuringInteraction,
    onToolbarAction,
    onHighlightPickConfirm: (colorIndex: number) => {
      const t = highlightTermTextForStorage();
      if (!t || colorIndex < 0 || colorIndex >= opts.highlightColorsLength()) return;
      opts.emitAddHighlightTerm({ text: t, colorIndex });
    },
    onHighlightPickRemove: () => {
      const t = highlightTermTextForStorage();
      if (t) opts.emitRemoveHighlightTerm({ text: t });
    },
    onLineationPickConfirm: (colorIndex: number) => {
      const type = lineationPickerType.value;
      if (
        !type ||
        colorIndex < 0 ||
        colorIndex >= opts.lineationColorsLength()
      ) {
        return;
      }
      applyLineation(type, colorIndex);
    },
    onNotePanelConfirm: (content: string) => {
      let ann = ensureNotePanelAnnotationRecord();
      if (!ann) return;
      const now = Date.now();
      ann = {
        ...ann,
        note: { content, createdAt: ann.note?.createdAt ?? now, updatedAt: now },
        updatedAt: now,
      };
      opts.emitUpsert(ann);
      notePanelTargetAnnotationId.value = ann.id;
      closeNotePanel();
    },
    onNotePanelDelete: () => {
      const ann =
        resolveAnnotationById(notePanelTargetAnnotationId.value) ??
        activeAnnotation();
      if (!ann?.note) return;
      if (ann.lineation) {
        opts.emitUpsert({ ...ann, note: undefined, updatedAt: Date.now() });
      } else {
        opts.emitRemove(ann.id);
      }
      closeNotePanel();
      closeToolbarUi();
    },
    closeNotePanel,
    beginSelectionPointerInteraction,
    cancelSelectionPointerInteraction,
    tryShowToolbarFromAnnotationPoint,
    jumpToAnnotationRange,
    getAnnotationDisplayQuote,
    getAnnotationHitsByLine: () => annotationHitsByLine.value,
    rebuildAnnotationIndex,
    refreshAnnotationDecorations,
    bindAnnotationScrollSync,
    disposeAnnotationDecorations,
    shouldSuppressToolbar,
    setSuppressToolbarUntilMs: (ms: number) => {
      suppressToolbarUntilMs = ms;
    },
  };
}
