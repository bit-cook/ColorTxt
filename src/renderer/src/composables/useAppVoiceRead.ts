import { computed, nextTick, ref, watch, type Ref } from "vue";
import type { CharacterRosterEntry } from "@shared/characterTypes";
import type ReaderMain from "../components/ReaderMain.vue";
import type { VoiceReadProfile } from "@shared/voiceReadProfiles";
import {
  clampVoiceReadRate,
  clampVoiceReadVolume,
  mergeVoiceReadSettings,
  voiceReadSettingsSynthesisFingerprint,
  voiceReadAiEmotionRecognitionActive,
  voiceReadAiSpeakerRecognitionActive,
  type VoiceReadSettings,
} from "../constants/voiceRead";
import {
  VoiceReadLinePlayer,
  type VoiceReadSpeakChunk,
} from "../services/voiceRead/voiceReadLinePlayer";
import { voiceReadRequiresSerialChunkFetch } from "../services/voiceRead/voiceReadEngineRouting";
import { hasVoiceReadSpeakableText } from "../services/voiceRead/voiceReadTextChunks";
import { buildLineSpeakChunks } from "../services/voiceRead/voiceReadLineBuild";
import type { VoiceReadQuoteCarry } from "../services/voiceRead/voiceReadSegments";
import {
  attributeDialogueQuotes,
  bumpVoiceReadSpeakerRosterVersion,
  clearVoiceReadSpeakerCache,
  invalidateCachedQuoteAttributions,
  voiceReadSpeakerCacheKey,
} from "../services/voiceRead/voiceReadSpeakerCache";

export type VoiceReadMode = "off" | "playing" | "paused";
export type VoiceReadSynthesizingPhase = "ai" | "tts";

/** 多行一次会话，Edge 在同一条时间线上跨行缓冲 fetch */
const VOICE_READ_BATCH_LINES = 28;

export function useAppVoiceRead(deps: {
  readerRef: Ref<InstanceType<typeof ReaderMain> | null>;
  voiceReadSettings: Ref<VoiceReadSettings>;
  voiceReadProfiles: Ref<VoiceReadProfile[]>;
  activeVoiceReadProfileId: Ref<string>;
  currentFile: Ref<string | null>;
  loading: Ref<boolean>;
  readerEditMode: Ref<boolean>;
  monacoSmoothScrolling: Ref<boolean>;
  aiFeaturesEnabled: Ref<boolean>;
  characterRoster: Ref<readonly CharacterRosterEntry[]>;
  /**
   * 找书等场景：当前章读完后自动续章（由 onDocumentEnd 加载下一章）。
   * 最后一章仍正常结束朗读。
   */
  continueAtDocumentEnd?: boolean;
  onDocumentEnd?: () => void | Promise<void>;
  /** 为 true 时可续读下一章（非最后一章） */
  canAdvanceToNextDocument?: () => boolean;
  /** 加载下一章时暂停播放循环并保持 playing，加载完成后自动从篇首续读 */
  pauseOnLoading?: boolean;
}) {
  const mode = ref<VoiceReadMode>("off");
  const isSynthesizing = ref(false);
  const synthesizingPhase = ref<VoiceReadSynthesizingPhase | null>(null);
  const toolbarRate = ref(1);
  const toolbarVolume = ref(1);
  const player = new VoiceReadLinePlayer();
  /** 批次构建（含 AI 引号分类）进行中的深度 */
  let prepareSynthesisDepth = 0;
  let playerSynthesisActive = false;
  /** AI 识别结束到播放器接管合成 UI 之间的衔接，避免短暂显示「播放中」 */
  let ttsBridgeActive = false;

  function syncSynthesizingState() {
    const busy =
      prepareSynthesisDepth > 0 || playerSynthesisActive || ttsBridgeActive;
    isSynthesizing.value = busy;
    if (!busy) {
      synthesizingPhase.value = null;
      return;
    }
    synthesizingPhase.value =
      prepareSynthesisDepth > 0 ? "ai" : "tts";
  }

  function beginPrepareSynthesis() {
    prepareSynthesisDepth += 1;
    syncSynthesizingState();
  }

  function endPrepareSynthesis(handoffToTts = false) {
    prepareSynthesisDepth = Math.max(0, prepareSynthesisDepth - 1);
    if (handoffToTts && prepareSynthesisDepth === 0 && mode.value !== "off") {
      ttsBridgeActive = true;
    }
    syncSynthesizingState();
  }

  function endTtsBridge() {
    if (!ttsBridgeActive) return;
    ttsBridgeActive = false;
    syncSynthesizingState();
  }

  function resetSynthesizingState() {
    prepareSynthesisDepth = 0;
    playerSynthesisActive = false;
    ttsBridgeActive = false;
    isSynthesizing.value = false;
    synthesizingPhase.value = null;
  }

  player.onSynthesizingChange = (active) => {
    playerSynthesisActive = active;
    syncSynthesizingState();
  };
  let currentLine = 1;
  /** 当前批次内正在播的段索引 */
  let currentChunkIndex = 0;
  const resumeWaiters: Array<() => void> = [];
  let playbackLoopGen = 0;
  /** 已连续播完的批次末行，防止 jump/续播与主循环重叠时重读同一行 */
  let lastCompletedBatchEndLine = 0;

  function isPlaybackAlive(gen: number, modeValue: VoiceReadMode): boolean {
    return gen === playbackLoopGen && modeValue !== "off";
  }

  /** 当前批次（供段高亮与行锚点） */
  let activeBatchEnd = 0;
  let activeChunks: VoiceReadSpeakChunk[] = [];
  let activeChunkToLine: number[] = [];

  watch(mode, (m) => {
    if (m === "playing") {
      deps.readerRef.value?.closeFindWidgetIfRevealed?.();
      const w = resumeWaiters.splice(0, resumeWaiters.length);
      for (const fn of w) fn();
    }
  });

  async function waitIfPaused(): Promise<void> {
    while (mode.value === "paused") {
      await new Promise<void>((resolve) => {
        resumeWaiters.push(resolve);
      });
    }
  }

  const isVoiceReadActive = computed(() => mode.value !== "off");
  const isVoiceReadScrollLocked = computed(() => mode.value === "playing");
  const isVoiceReadBlocksFind = computed(() => mode.value === "playing");
  /** 朗读模式中（含暂停）：顶栏排版/编辑相关控件不可用 */
  const isVoiceReadHeaderLocked = computed(() => mode.value !== "off");
  /** 识别/合成/播放中：拦截侧栏跳转，避免与批次播放冲突 */
  const isVoiceReadNavigationBlocked = computed(() => mode.value === "playing");

  async function buildLineSpeakChunksWithSpeakers(
    settings: VoiceReadSettings,
    lineNo: number,
    rawLine: string,
    carry: VoiceReadQuoteCarry,
  ) {
    const roster = deps.characterRoster.value;
    const aiOn = voiceReadAiSpeakerRecognitionActive(
      settings,
      deps.aiFeaturesEnabled.value,
    );
    const emotionOn = voiceReadAiEmotionRecognitionActive(
      settings,
      deps.aiFeaturesEnabled.value,
    );
    const first = buildLineSpeakChunks(settings, rawLine, roster, {
      carry,
      aiFeaturesEnabled: aiOn,
    });
    if (!aiOn || first.dialogueSegments.length === 0) {
      return first;
    }
    const dialogueTexts = first.dialogueSegments.map((d) => d.text);
    const bookPath = deps.currentFile.value?.trim() ?? "";
    const cacheKey = voiceReadSpeakerCacheKey(
      bookPath,
      lineNo,
      rawLine,
      dialogueTexts,
      roster,
      emotionOn,
    );
    const { quotes, narrationEmotion } = await attributeDialogueQuotes(
      rawLine,
      dialogueTexts,
      roster,
      cacheKey,
      emotionOn,
    );
    return buildLineSpeakChunks(settings, rawLine, roster, {
      carry,
      quoteAttributions: quotes,
      narrationEmotion,
      aiFeaturesEnabled: aiOn,
    });
  }

  function invalidateAiQuoteCacheForLine(lineNo: number, rawLine: string): void {
    const settings = deps.voiceReadSettings.value;
    if (
      !voiceReadAiSpeakerRecognitionActive(
        settings,
        deps.aiFeaturesEnabled.value,
      )
    ) {
      return;
    }
    const emotionOn = voiceReadAiEmotionRecognitionActive(
      settings,
      deps.aiFeaturesEnabled.value,
    );
    const roster = deps.characterRoster.value;
    const first = buildLineSpeakChunks(settings, rawLine, roster, {
      aiFeaturesEnabled: true,
    });
    if (first.dialogueSegments.length === 0) return;
    const dialogueTexts = first.dialogueSegments.map((d) => d.text);
    const bookPath = deps.currentFile.value?.trim() ?? "";
    invalidateCachedQuoteAttributions(
      voiceReadSpeakerCacheKey(
        bookPath,
        lineNo,
        rawLine,
        dialogueTexts,
        roster,
        emotionOn,
      ),
    );
  }

  async function buildBatchSpeakChunks(
    settings: VoiceReadSettings,
    reader: InstanceType<typeof ReaderMain>,
    fromLine: number,
    toLine: number,
    initialCarry: VoiceReadQuoteCarry = null,
    shouldAbort?: () => boolean,
  ) {
    const chunks: VoiceReadSpeakChunk[] = [];
    const chunkToModelLine: number[] = [];
    let carry = initialCarry;
    for (let L = fromLine; L <= toLine; L++) {
      if (shouldAbort?.()) break;
      const rawL = reader.getEditorLineContent?.(L) ?? "";
      const t = rawL.replace(/\s+/g, " ").trim();
      if (!hasVoiceReadSpeakableText(t)) continue;
      const built = await buildLineSpeakChunksWithSpeakers(
        settings,
        L,
        rawL,
        carry,
      );
      if (shouldAbort?.()) break;
      carry = built.carry;
      for (const c of built.chunks) {
        chunks.push(c);
        chunkToModelLine.push(L);
      }
    }
    return { chunks, chunkToModelLine, carry };
  }

  function effectiveSettingsForSpeak(): VoiceReadSettings {
    const base = deps.voiceReadSettings.value;
    return mergeVoiceReadSettings({
      ...base,
      rate: clampVoiceReadRate(toolbarRate.value),
      volume: clampVoiceReadVolume(toolbarVolume.value),
    });
  }

  function syncVolumeToActiveProfile(volume: number) {
    const profileId = deps.activeVoiceReadProfileId.value.trim();
    const idx = deps.voiceReadProfiles.value.findIndex((p) => p.id === profileId);
    if (idx < 0) return;
    const current = deps.voiceReadProfiles.value[idx]!;
    if (clampVoiceReadVolume(current.settings.volume) === volume) return;
    const profiles = [...deps.voiceReadProfiles.value];
    profiles[idx] = {
      ...current,
      settings: mergeVoiceReadSettings({ ...current.settings, volume }),
    };
    deps.voiceReadProfiles.value = profiles;
  }

  function setToolbarVolume(v: number) {
    const volume = clampVoiceReadVolume(v);
    toolbarVolume.value = volume;
    player.setPlaybackVolume(volume);
    if (deps.voiceReadSettings.value.volume === volume) return;
    deps.voiceReadSettings.value = mergeVoiceReadSettings({
      ...deps.voiceReadSettings.value,
      volume,
    });
    syncVolumeToActiveProfile(volume);
  }

  function clearActiveBatch() {
    activeBatchEnd = 0;
    activeChunks = [];
    activeChunkToLine = [];
    currentChunkIndex = 0;
  }

  function exitVoiceRead() {
    playbackLoopGen += 1;
    player.onChunkChange = undefined;
    resetSynthesizingState();
    player.stop();
    clearActiveBatch();
    lastCompletedBatchEndLine = 0;
    mode.value = "off";
    deps.readerRef.value?.setVoiceReadLineHighlight?.(null);
  }

  async function handleDocumentEndReached(): Promise<boolean> {
    if (!deps.continueAtDocumentEnd || !deps.onDocumentEnd) return false;
    if (deps.canAdvanceToNextDocument && !deps.canAdvanceToNextDocument()) {
      return false;
    }
    playbackLoopGen += 1;
    player.onChunkChange = undefined;
    player.stopForLineJump();
    player.discardPrefetch();
    resetSynthesizingState();
    clearActiveBatch();
    lastCompletedBatchEndLine = 0;
    await Promise.resolve(deps.onDocumentEnd());
    return true;
  }

  function clampPlaybackStartLine(line: number, mCount: number): number {
    let ln = Math.max(1, Math.min(Math.floor(line), mCount));
    if (ln <= lastCompletedBatchEndLine) {
      ln = Math.min(mCount, lastCompletedBatchEndLine + 1);
    }
    return ln;
  }

  function syncToolbarFromPersisted() {
    const s = deps.voiceReadSettings.value;
    toolbarRate.value = s.rate;
    toolbarVolume.value = s.volume;
  }

  function applyPlaybackLineHighlight(ln: number) {
    const reader = deps.readerRef.value;
    if (!reader) return;
    currentLine = ln;
    reader.setVoiceReadLineHighlight?.(ln);
    reader.scrollModelLineBlockToViewportCenter?.(
      ln,
      deps.monacoSmoothScrolling.value,
    );
  }

  /** 将锚点同步到批次内某段（段 → 模型行） */
  function syncPlaybackChunkAnchor(
    chunkIndex: number,
    chunkToModelLine: number[],
    fallbackLine: number,
  ) {
    if (chunkToModelLine.length === 0) return;
    const idx = Math.max(0, Math.min(chunkIndex, chunkToModelLine.length - 1));
    currentChunkIndex = idx;
    applyPlaybackLineHighlight(chunkToModelLine[idx] ?? fallbackLine);
  }

  function bindChunkHighlight(
    gen: number,
    chunkToModelLine: number[],
    fallbackLine: number,
    baseChunkIndex = 0,
  ) {
    /** 已反映到 UI 的段索引；首段必须是 batch 第 0 段，其后只允许 +1 推进 */
    let lastAppliedChunkIndex = -1;
    player.onChunkChange = (relIdx) => {
      if (!isPlaybackAlive(gen, mode.value)) return;
      const absIdx = baseChunkIndex + relIdx;
      if (absIdx < 0 || absIdx >= chunkToModelLine.length) return;
      if (lastAppliedChunkIndex < 0) {
        if (absIdx !== baseChunkIndex) return;
        lastAppliedChunkIndex = absIdx;
        endTtsBridge();
        currentChunkIndex = absIdx;
        return;
      }
      if (absIdx !== lastAppliedChunkIndex + 1) return;
      lastAppliedChunkIndex = absIdx;
      currentChunkIndex = absIdx;
      const hl = chunkToModelLine[absIdx] ?? fallbackLine;
      if (hl === currentLine) return;
      applyPlaybackLineHighlight(hl);
      warmAdjacentSpeakableLines(hl);
    };
  }

  function scrollAndHighlightLine(ln: number) {
    applyPlaybackLineHighlight(ln);
  }

  function prefetchLineAfterBatch(
    batchEnd: number,
    settings: VoiceReadSettings,
    quoteCarry: VoiceReadQuoteCarry,
    gen: number,
  ) {
    if (voiceReadRequiresSerialChunkFetch(settings)) return;
    const reader = deps.readerRef.value;
    const mCount = reader?.getModelLineCount?.() ?? 0;
    if (!reader || batchEnd >= mCount) return;
    void (async () => {
      for (let L = batchEnd + 1; L <= mCount; L++) {
        if (!isPlaybackAlive(gen, mode.value)) return;
        const rawAfter = reader.getEditorLineContent?.(L) ?? "";
        const t = rawAfter.replace(/\s+/g, " ").trim();
        if (!hasVoiceReadSpeakableText(t)) continue;
        const built = await buildLineSpeakChunksWithSpeakers(
          settings,
          L,
          rawAfter,
          quoteCarry,
        );
        if (!isPlaybackAlive(gen, mode.value)) return;
        if (built.chunks.length > 0) {
          player.startPrefetch(settings, built.chunks);
          return;
        }
      }
    })();
  }

  function warmLineText(line: number, settings: VoiceReadSettings) {
    const reader = deps.readerRef.value;
    if (!reader || line < 1) return;
    const raw = reader.getEditorLineContent?.(line) ?? "";
    const t = raw.replace(/\s+/g, " ").trim();
    if (!hasVoiceReadSpeakableText(t)) return;
    void buildLineSpeakChunksWithSpeakers(settings, line, raw, null).then(
      (built) => {
        if (!isVoiceReadActive.value) return;
        if (built.chunks.length > 0) {
          player.warmSpeakChunks(settings, built.chunks);
        }
      },
    );
  }

  /** 预生成锚点行上下各一行，手动上一行/下一行命中缓存 */
  function warmAdjacentSpeakableLines(anchorLine: number) {
    const settings = effectiveSettingsForSpeak();
    if (voiceReadRequiresSerialChunkFetch(settings)) return;
    if (settings.engine === "dashscope") return;
    const prev = findAdjacentSpeakableLine(anchorLine, -1);
    const next = findAdjacentSpeakableLine(anchorLine, 1);
    const mCount = deps.readerRef.value?.getModelLineCount?.() ?? 0;
    if (prev !== anchorLine) warmLineText(prev, settings);
    if (next !== anchorLine && next <= mCount) warmLineText(next, settings);
  }

  async function runPlaybackLoop(startLine: number) {
    const gen = ++playbackLoopGen;
    const reader0 = deps.readerRef.value;
    const mCount0 = reader0?.getModelLineCount?.() ?? 0;
    if (!reader0 || mCount0 < 1) {
      if (await handleDocumentEndReached()) return;
      exitVoiceRead();
      return;
    }
    const startLn = clampPlaybackStartLine(startLine, mCount0);
    currentLine = startLn;
    if (startLn > mCount0) {
      exitVoiceRead();
      return;
    }
    while (mode.value !== "off" && gen === playbackLoopGen) {
      await waitIfPaused();
      if (!isPlaybackAlive(gen, mode.value)) break;

      const reader = deps.readerRef.value;
      const mCount = reader?.getModelLineCount?.() ?? 0;
      if (!reader || mCount < 1) {
        if (await handleDocumentEndReached()) break;
        exitVoiceRead();
        break;
      }
      const ln = Math.max(1, Math.min(currentLine, mCount));
      currentLine = ln;

      const batchEnd = Math.min(mCount, ln + VOICE_READ_BATCH_LINES - 1);
      const settings = effectiveSettingsForSpeak();

      scrollAndHighlightLine(ln);

      let batchBuilt;
      beginPrepareSynthesis();
      try {
        batchBuilt = await buildBatchSpeakChunks(
          settings,
          reader,
          ln,
          batchEnd,
          null,
          () => !isPlaybackAlive(gen, mode.value),
        );
      } finally {
        endPrepareSynthesis(isPlaybackAlive(gen, mode.value));
      }
      if (!isPlaybackAlive(gen, mode.value)) {
        endTtsBridge();
        break;
      }

      const chunks = batchBuilt.chunks;
      const chunkToModelLine = batchBuilt.chunkToModelLine;

      activeBatchEnd = batchEnd;
      activeChunks = chunks;
      activeChunkToLine = chunkToModelLine;

      if (chunks.length === 0) {
        endTtsBridge();
        lastCompletedBatchEndLine = Math.max(lastCompletedBatchEndLine, batchEnd);
        if (batchEnd >= mCount) {
          player.discardPrefetch();
          if (await handleDocumentEndReached()) break;
          exitVoiceRead();
          break;
        }
        currentLine = clampPlaybackStartLine(batchEnd + 1, mCount);
        continue;
      }

      const anchorLn = chunkToModelLine[0] ?? ln;
      currentLine = anchorLn;
      scrollAndHighlightLine(anchorLn);
      prefetchLineAfterBatch(batchEnd, settings, batchBuilt.carry, gen);
      syncPlaybackChunkAnchor(0, chunkToModelLine, anchorLn);
      warmAdjacentSpeakableLines(anchorLn);
      bindChunkHighlight(gen, chunkToModelLine, anchorLn, 0);

      try {
        await player.speakChunks(settings, chunks);
        await player.waitForPlaybackSettled();
      } catch {
        // 错误提示由 App 层处理
      } finally {
        endTtsBridge();
      }

      if (!isPlaybackAlive(gen, mode.value)) break;
      await waitIfPaused();
      if (!isPlaybackAlive(gen, mode.value)) break;

      lastCompletedBatchEndLine = Math.max(lastCompletedBatchEndLine, batchEnd);

      if (batchEnd >= mCount) {
        player.discardPrefetch();
        if (await handleDocumentEndReached()) break;
        exitVoiceRead();
        break;
      }

      currentLine = clampPlaybackStartLine(batchEnd + 1, mCount);
    }
  }

  function resolveSpeakableStartLine(line: number): number {
    const reader = deps.readerRef.value;
    const mCount = reader?.getModelLineCount?.() ?? 0;
    if (!reader || mCount < 1) return 1;
    const ln = Math.max(1, Math.min(Math.floor(line), mCount));
    if (lineHasSpeakableContent(ln)) return ln;
    const next = findAdjacentSpeakableLine(ln, 1);
    if (lineHasSpeakableContent(next)) return next;
    const prev = findAdjacentSpeakableLine(ln, -1);
    if (lineHasSpeakableContent(prev)) return prev;
    return ln;
  }

  /** 顶栏进入朗读：从视口内首行起播（非视口中心） */
  function startFromViewportTop() {
    const reader = deps.readerRef.value;
    if (!reader) return;
    const ln = resolveSpeakableStartLine(
      reader.getViewportTopLine?.() ?? 1,
    );
    syncToolbarFromPersisted();
    lastCompletedBatchEndLine = 0;
    mode.value = "playing";
    void runPlaybackLoop(ln);
  }

  function restartFromViewportTopAfterNavigation() {
    if (mode.value !== "playing") return;
    playbackLoopGen += 1;
    player.onChunkChange = undefined;
    player.stopForLineJump();
    void nextTick(() => {
      const reader = deps.readerRef.value;
      if (!reader || mode.value !== "playing") return;
      const mCount = reader.getModelLineCount?.() ?? 0;
      const ln = Math.max(
        1,
        Math.min(
          reader.getModelLineAtViewportCenter?.() ?? getPlaybackAnchorLine(),
          mCount,
        ),
      );
      lastCompletedBatchEndLine = Math.max(0, ln - 1);
      clearActiveBatch();
      scrollAndHighlightLine(ln);
      void runPlaybackLoop(ln);
    });
  }

  function getPlaybackAnchorLine(): number {
    const reader = deps.readerRef.value;
    const mCount = reader?.getModelLineCount?.() ?? 0;
    if (!reader || mCount < 1) return 1;

    if (
      activeChunkToLine.length > 0 &&
      currentChunkIndex >= 0 &&
      currentChunkIndex < activeChunkToLine.length
    ) {
      return Math.max(
        1,
        Math.min(activeChunkToLine[currentChunkIndex] ?? currentLine, mCount),
      );
    }

    const highlighted = reader.getVoiceReadHighlightedLine?.();
    if (highlighted != null && highlighted >= 1) {
      return Math.max(1, Math.min(highlighted, mCount));
    }

    return Math.max(1, Math.min(currentLine, mCount));
  }

  function lineHasSpeakableContent(line: number): boolean {
    const reader = deps.readerRef.value;
    if (!reader || line < 1) return false;
    const t = (reader.getEditorLineContent?.(line) ?? "")
      .replace(/\s+/g, " ")
      .trim();
    return hasVoiceReadSpeakableText(t);
  }

  function findAdjacentSpeakableLine(line: number, delta: -1 | 1): number {
    const mCount = deps.readerRef.value?.getModelLineCount?.() ?? 0;
    if (mCount < 1) return 1;
    let L = line + delta;
    while (L >= 1 && L <= mCount) {
      if (lineHasSpeakableContent(L)) return L;
      L += delta;
    }
    return Math.max(1, Math.min(L - delta, mCount));
  }

  /** 从指定行重新播（新批次）；用于跨行跳转、跨批或空行 */
  function restartPlaybackFromLine(line: number) {
    if (mode.value === "off") return;
    const reader = deps.readerRef.value;
    const mCount = reader?.getModelLineCount?.() ?? 0;
    if (!reader || mCount < 1) {
      void handleDocumentEndReached();
      return;
    }
    const ln = resolveSpeakableStartLine(
      Math.max(1, Math.min(Math.floor(line), mCount)),
    );

    playbackLoopGen += 1;
    player.onChunkChange = undefined;
    player.stopForLineJump();
    resetSynthesizingState();
    clearActiveBatch();
    lastCompletedBatchEndLine = Math.max(0, ln - 1);
    scrollAndHighlightLine(ln);
    mode.value = "playing";
    void runPlaybackLoop(ln);
  }

  function playPrevLine() {
    if (mode.value === "off") return;

    if (activeChunkToLine.length > 0) {
      const anchorLine =
        activeChunkToLine[currentChunkIndex] ?? getPlaybackAnchorLine();
      for (let i = currentChunkIndex - 1; i >= 0; i--) {
        const line = activeChunkToLine[i]!;
        if (line < anchorLine) {
          restartPlaybackFromLine(line);
          return;
        }
      }
    }

    const ln = getPlaybackAnchorLine();
    if (ln <= 1) return;
    restartPlaybackFromLine(findAdjacentSpeakableLine(ln, -1));
  }

  function playNextLine() {
    if (mode.value === "off") return;
    const mCount = deps.readerRef.value?.getModelLineCount?.() ?? 0;

    if (activeChunkToLine.length > 0) {
      const anchorLine =
        activeChunkToLine[currentChunkIndex] ?? getPlaybackAnchorLine();
      for (let i = currentChunkIndex + 1; i < activeChunkToLine.length; i++) {
        const line = activeChunkToLine[i]!;
        if (line > anchorLine) {
          restartPlaybackFromLine(line);
          return;
        }
      }
    }

    const ln = getPlaybackAnchorLine();
    if (ln >= mCount) return;
    restartPlaybackFromLine(findAdjacentSpeakableLine(ln, 1));
  }

  function regenerateCurrentLine() {
    if (mode.value === "off") return;
    const reader = deps.readerRef.value;
    if (!reader) return;
    const ln = getPlaybackAnchorLine();
    const settings = effectiveSettingsForSpeak();
    const raw = reader.getEditorLineContent?.(ln) ?? "";
    invalidateAiQuoteCacheForLine(ln, raw);
    void buildLineSpeakChunksWithSpeakers(settings, ln, raw, null).then(
      (built) => {
        player.invalidateLineSynthesis(settings, raw, built.chunks);
      },
    );
    if (mode.value === "paused") mode.value = "playing";
    restartPlaybackFromLine(ln);
  }

  const canPlayPrevLine = computed(() => {
    if (mode.value === "off") return false;
    return getPlaybackAnchorLine() > 1;
  });

  const canPlayNextLine = computed(() => {
    if (mode.value === "off") return false;
    const mCount = deps.readerRef.value?.getModelLineCount?.() ?? 0;
    return getPlaybackAnchorLine() < mCount;
  });

  function toggleVoiceReadToolbar() {
    if (mode.value === "off") {
      if (!canStartVoiceRead.value) return;
      startFromViewportTop();
    } else {
      exitVoiceRead();
    }
  }

  /** 暂停后恢复：从视口中心行开播；有缓存则即时播放，无缓存则先合成 */
  function resumeFromPause() {
    if (mode.value !== "playing") return;
    const reader = deps.readerRef.value;
    const mCount = reader?.getModelLineCount?.() ?? 0;
    if (!reader || mCount < 1) return;

    const ln = resolveSpeakableStartLine(
      reader.getModelLineAtViewportCenter?.() ?? 1,
    );

    restartPlaybackFromLine(ln);
  }

  function togglePlayPause() {
    if (mode.value === "off") return;
    if (mode.value === "playing") {
      playbackLoopGen += 1;
      player.onChunkChange = undefined;
      resetSynthesizingState();
      player.pausePlayback();
      mode.value = "paused";
      return;
    }
    mode.value = "playing";
    void nextTick(() => {
      if (mode.value !== "playing") return;
      resumeFromPause();
    });
  }

  const canStartVoiceRead = computed(() => {
    if (!deps.currentFile.value?.trim()) return false;
    if (deps.loading.value) return false;
    if (deps.readerEditMode.value) return false;
    const n = deps.readerRef.value?.getModelLineCount?.() ?? 0;
    if (n > 0) return true;
    return Boolean(deps.canAdvanceToNextDocument?.());
  });

  watch(deps.currentFile, (file, prev) => {
    player.clearSynthesisCache();
    clearVoiceReadSpeakerCache();
    // 找书续章：未缓存章会先清空 content key 再拉正文；由 loading watch 暂停/续播，勿退出朗读
    if (deps.pauseOnLoading && mode.value !== "off") return;
    if (file === prev) return;
    exitVoiceRead();
  });

  let lastVoiceReadSynthesisFingerprint = "";

  watch(
    () => deps.voiceReadSettings.value,
    (s) => {
      const fingerprint = voiceReadSettingsSynthesisFingerprint(s);
      if (fingerprint === lastVoiceReadSynthesisFingerprint) {
        toolbarVolume.value = s.volume;
        player.setPlaybackVolume(s.volume);
        return;
      }
      lastVoiceReadSynthesisFingerprint = fingerprint;
      syncToolbarFromPersisted();
      player.clearSynthesisCache();
      clearVoiceReadSpeakerCache();
    },
    { deep: true },
  );

  watch(
    () => deps.characterRoster.value,
    () => {
      bumpVoiceReadSpeakerRosterVersion();
      player.clearSynthesisCache();
    },
    { deep: true },
  );

  watch(deps.readerEditMode, (ed) => {
    if (ed) exitVoiceRead();
  });

  watch(
    () => deps.loading.value,
    (ld) => {
      if (deps.pauseOnLoading && mode.value === "playing") {
        if (ld) {
          playbackLoopGen += 1;
          player.onChunkChange = undefined;
          player.stopForLineJump();
          resetSynthesizingState();
          clearActiveBatch();
        } else {
          void nextTick(() => {
            if (mode.value !== "playing" || deps.loading.value) return;
            restartPlaybackFromLine(1);
          });
        }
        return;
      }
      if (ld) exitVoiceRead();
    },
  );

  return {
    mode,
    isSynthesizing,
    synthesizingPhase,
    toolbarRate,
    toolbarVolume,
    setToolbarVolume,
    canStartVoiceRead,
    isVoiceReadActive,
    isVoiceReadScrollLocked,
    isVoiceReadBlocksFind,
    isVoiceReadHeaderLocked,
    isVoiceReadNavigationBlocked,
    toggleVoiceReadToolbar,
    togglePlayPause,
    restartFromViewportTopAfterNavigation,
    exitVoiceRead,
    playPrevLine,
    playNextLine,
    regenerateCurrentLine,
    canPlayPrevLine,
    canPlayNextLine,
    effectiveSettingsForSpeak,
  };
}
