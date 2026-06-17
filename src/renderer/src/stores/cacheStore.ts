import type { ChapterMatchRule } from "../chapter";
import type {
  FileCategoryDefinition,
  FileSortMode,
} from "../constants/fileCategories";
import {
  isFileSortMode,
  parseFileCategoryCatalog,
} from "../constants/fileCategories";
import {
  migrateTxtFileListAddedAt,
  type TxtFileItem,
} from "../services/fileListService";

export type { TxtFileItem };
import { parseHighlightColorsArray } from "../constants/highlightColors";
import { parseLineationColorsArray } from "../constants/lineationColors";
import { parseLineationLastColors } from "../constants/annotationColors";
import {
  normalizeHighlightWordsByIndex,
  type HighlightWordsByIndex,
} from "./fileMetaStore";
import {
  parseReaderPaletteOverrides,
  type ReaderSurfacePalette,
} from "../constants/readerPalette";
import type { ShortcutActionId } from "../services/shortcutRegistry";
import type { AiCustomSkill, AiSkillUserOverride } from "@shared/aiSkills";
import {
  mergeAiCustomSkills,
  mergeAiSkillOverrides,
  mergeAiSkillsEnabled,
} from "@shared/aiSkills";
import type { VoiceReadSettings } from "../constants/voiceRead";
import { normalizeCharacterCardTextureEffect } from "@shared/characterCardTextureEffects";
import { parseWordcloudAngleMode } from "../constants/wordcloudUi";
import { parseWordcloudPaletteId } from "../constants/wordcloudPalettes";

export type PersistedSettingsData = {
  theme?: "vs" | "vs-dark";
  /** 侧边栏宽度（px） */
  sidebarWidth?: number;
  /** 侧边栏是否打开（非全屏时） */
  showSidebar?: boolean;
  fontSize?: number;
  /** Monaco 行高倍数，实际行高 = round(fontSize * lineHeightMultiple) */
  lineHeightMultiple?: number;
  fontFamily?: string;
  /** 阅读器字体弹框：钉在外层的「其他字体」名称列表 */
  pinnedOtherFonts?: string[];
  monacoCustomHighlight?: boolean;
  /** 与「内容上色」同时开启时：成对引号/括号是否允许跨行 */
  txtrDelimitedMatchCrossLine?: boolean;
  /** 是否在加载时过滤空行（仅空格/缩进也视为空行） */
  compressBlankLines?: boolean;
  /** 压缩空行时是否在每行正文下方保留一行空行（章节标题行除外） */
  compressBlankKeepOneBlank?: boolean;
  /** 是否为正文行统一行首两个全角空格（章节标题行与空行除外） */
  leadIndentFullWidth?: boolean;
  textConvertZh?: string;
  textConvertLetter?: string;
  textConvertDigit?: string;
  /** 章节列表是否显示每章字数 */
  showChapterCounts?: boolean;
  chapterRules?: ChapterMatchRule[];
  /** 启动时是否从会话快照恢复上次文件与列表；关闭时关闭窗口不写入会话 */
  restoreSessionOnStartup?: boolean;
  /** 最近打开文件条数上限，0 表示不记录 */
  recentFilesHistoryLimit?: number;
  /** 小于该字数的章节不纳入章节列表与导航 */
  chapterMinCharCount?: number;
  /** Monaco 换行是否使用 advanced 策略（性能开销更大） */
  monacoAdvancedWrapping?: boolean;
  /** Monaco 阅读区平滑滚动（滚轮、程序性 setScrollTop/revealLine 等） */
  monacoSmoothScrolling?: boolean;
  /** 编辑模式下是否显示行号 */
  readerEditShowLineNumbers?: boolean;
  /** 编辑模式下是否显示小地图 */
  readerEditMinimap?: boolean;
  /** 编辑模式下内容变更时是否自动刷新侧栏章节列表（超过行数上限时需手动刷新） */
  editAutoRefreshChapterList?: boolean;
  /** 编辑模式 AI 智能排版选项 */
  aiSmartFormat?: Partial<
    import("@shared/aiSmartFormatTypes").AiSmartFormatSettings
  >;
  /** 全屏时阅读区宽度（百分比） */
  fullscreenReaderWidthPercent?: number;
  /** 用户自定义快捷键（动作ID -> accelerator） */
  shortcutBindings?: Partial<Record<ShortcutActionId, string>>;
  /** 阅读器表面色用户覆盖（亮色侧） */
  readerPaletteOverridesLight?: Partial<ReaderSurfacePalette>;
  /** 阅读器表面色用户覆盖（暗色侧） */
  readerPaletteOverridesDark?: Partial<ReaderSurfacePalette>;
  /** 自定义高亮色（亮色主题），与默认逐项相同可不写入 */
  highlightColorsLight?: string[];
  /** 自定义高亮色（暗色主题） */
  highlightColorsDark?: string[];
  /** 划线标注色（亮色主题） */
  lineationColorsLight?: string[];
  /** 划线标注色（暗色主题） */
  lineationColorsDark?: string[];
  /** 已收藏（全书通用）高亮词，按高亮色索引分桶 */
  highlightWordsByIndexGlobal?: HighlightWordsByIndex;
  /** 划线（马克笔/波浪/直线）各自上次选用的 5 色索引 */
  lineationLastColors?: import("../constants/annotationColors").LineationLastColorPrefs;
  /**
   * 电子书转换输出目录：空字符串表示与源书同目录。
   * 非空时为绝对路径。若设置 JSON 中无此键，应用默认使用 `userData/ConvertedTxt`。
   */
  ebookConvertOutputDir?: string;
  /** 文件列表分类筛选：`__all__` | `__uncategorized__` | 分类名 */
  fileCategory?: string;
  /** 文件列表排序方式 */
  fileSort?: FileSortMode;
  /** 用户维护的分类名称与颜色表 */
  fileCategoryCatalog?: FileCategoryDefinition[];
  /** 监控当前打开文件，磁盘变更后自动重新加载 */
  syncCurrentFile?: boolean;
  /** 内置技能开关（键为技能 id，缺省由合并逻辑视为启用） */
  aiSkillsEnabled?: Record<string, boolean>;
  /** 用户对内置技能的描述与提示词覆盖 */
  aiSkillOverrides?: Record<string, AiSkillUserOverride>;
  /** 用户自定义技能列表 */
  aiCustomSkills?: AiCustomSkill[];
  /** AI 阅读助手：深度思考 */
  aiAssistantDeepThinking?: boolean;
  /** AI 阅读助手：防剧透 */
  aiAssistantSpoilerSafe?: boolean;
  /** 词云全屏：字体（CSS font-family 串，与阅读器独立） */
  wordcloudFontFamily?: string;
  /** 词云全屏：角度布局 */
  wordcloudAngleMode?: "horizontal" | "mixed" | "random";
  /** 词云全屏：配色方案 */
  wordcloudPaletteId?:
    | "category10"
    | "category20"
    | "pastel"
    | "paired"
    | "dark"
    | "accent"
    | "warm"
    | "cool";
  /**
   * 角色立绘缓存根目录（绝对路径）。
   * 缺省时运行时使用 `userData/CharacterPortrait`（子目录名见 `@shared/characterPortraitPaths`）。
   */
  characterPortraitCacheDir?: string;
  /** 语音朗读（引擎、音色、语速音调、DashScope Key、配置方案） */
  voiceRead?: Partial<VoiceReadSettings> & {
    profiles?: unknown[];
    activeProfileId?: string;
    aiSpeakerTokenUsage?: {
      promptTokens?: number;
      completionTokens?: number;
      totalTokens?: number;
      promptCacheHitTokens?: number;
    };
    aiSpeakerTokenUsageAvailable?: boolean;
  };
  /** 角色卡列表纹理/全息效果 */
  characterCardTextureEffect?: string;
};

export type PersistedSettingsLoadResult = {
  data: PersistedSettingsData;
  /** 持久化 JSON 是否包含 `ebookConvertOutputDir` 且为 string（含空串）；否则用 userData/ConvertedTxt 作为首次默认 */
  ebookConvertOutputDirKeyPresent: boolean;
  /** 是否包含 `characterPortraitCacheDir` 键（含空串） */
  characterPortraitCacheDirKeyPresent: boolean;
};

export type SessionSnapshot = {
  currentFile: string | null;
  /** 源文件物理行号（含空行），视口顶部行 */
  viewportTopLine: number;
  /** 源文件物理行号（含空行），视口底部行 */
  viewportBottomLine: number;
};

function safeJsonParse(value: string | null | undefined) {
  if (!value) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function isTxtFileItemArray(x: unknown): x is TxtFileItem[] {
  if (!Array.isArray(x)) return false;
  return x.every((item) => {
    if (!item || typeof item !== "object") return false;
    const o = item as Record<string, unknown>;
    if (typeof o.path !== "string") return false;
    if (o.addedAt !== undefined) {
      if (typeof o.addedAt !== "number" || !Number.isFinite(o.addedAt))
        return false;
    }
    if (o.category !== undefined && typeof o.category !== "string")
      return false;
    return true;
  });
}

export function loadPersistedSettingsData(
  storage: Storage | undefined,
  key: string,
): PersistedSettingsLoadResult | null {
  const parsed = safeJsonParse(storage?.getItem(key));
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  const ebookConvertOutputDirKeyPresent =
    Object.prototype.hasOwnProperty.call(obj, "ebookConvertOutputDir") &&
    typeof obj.ebookConvertOutputDir === "string";
  const characterPortraitCacheDirKeyPresent =
    Object.prototype.hasOwnProperty.call(obj, "characterPortraitCacheDir") &&
    typeof obj.characterPortraitCacheDir === "string";
  const data: PersistedSettingsData = {};

  if (obj.theme === "vs" || obj.theme === "vs-dark") data.theme = obj.theme;
  if (
    typeof obj.sidebarWidth === "number" &&
    Number.isFinite(obj.sidebarWidth)
  ) {
    data.sidebarWidth = obj.sidebarWidth;
  }
  if (typeof obj.showSidebar === "boolean") {
    data.showSidebar = obj.showSidebar;
  }
  if (typeof obj.fontSize === "number" && Number.isFinite(obj.fontSize)) {
    data.fontSize = obj.fontSize;
  }
  if (
    typeof obj.lineHeightMultiple === "number" &&
    Number.isFinite(obj.lineHeightMultiple)
  ) {
    data.lineHeightMultiple = obj.lineHeightMultiple;
  }
  if (typeof obj.fontFamily === "string" && obj.fontFamily.trim()) {
    data.fontFamily = obj.fontFamily;
  }
  if (Array.isArray(obj.pinnedOtherFonts)) {
    data.pinnedOtherFonts = obj.pinnedOtherFonts.filter(
      (f): f is string => typeof f === "string" && f.trim().length > 0,
    );
  }
  if (typeof obj.monacoCustomHighlight === "boolean") {
    data.monacoCustomHighlight = obj.monacoCustomHighlight;
  }
  if (typeof obj.txtrDelimitedMatchCrossLine === "boolean") {
    data.txtrDelimitedMatchCrossLine = obj.txtrDelimitedMatchCrossLine;
  }
  if (typeof obj.compressBlankLines === "boolean") {
    data.compressBlankLines = obj.compressBlankLines;
  }
  if (typeof obj.compressBlankKeepOneBlank === "boolean") {
    data.compressBlankKeepOneBlank = obj.compressBlankKeepOneBlank;
  }
  if (typeof obj.leadIndentFullWidth === "boolean") {
    data.leadIndentFullWidth = obj.leadIndentFullWidth;
  }
  if (typeof obj.textConvertZh === "string") {
    data.textConvertZh = obj.textConvertZh;
  }
  if (typeof obj.textConvertLetter === "string") {
    data.textConvertLetter = obj.textConvertLetter;
  }
  if (typeof obj.textConvertDigit === "string") {
    data.textConvertDigit = obj.textConvertDigit;
  }
  if (typeof obj.showChapterCounts === "boolean") {
    data.showChapterCounts = obj.showChapterCounts;
  }
  if (Array.isArray(obj.chapterRules)) {
    data.chapterRules = obj.chapterRules as ChapterMatchRule[];
  }
  if (typeof obj.restoreSessionOnStartup === "boolean") {
    data.restoreSessionOnStartup = obj.restoreSessionOnStartup;
  }
  if (
    typeof obj.recentFilesHistoryLimit === "number" &&
    Number.isFinite(obj.recentFilesHistoryLimit)
  ) {
    data.recentFilesHistoryLimit = Math.max(
      0,
      Math.min(100, Math.floor(obj.recentFilesHistoryLimit)),
    );
  }
  if (
    typeof obj.chapterMinCharCount === "number" &&
    Number.isFinite(obj.chapterMinCharCount)
  ) {
    data.chapterMinCharCount = Math.max(0, Math.floor(obj.chapterMinCharCount));
  }
  if (typeof obj.monacoAdvancedWrapping === "boolean") {
    data.monacoAdvancedWrapping = obj.monacoAdvancedWrapping;
  }
  if (typeof obj.monacoSmoothScrolling === "boolean") {
    data.monacoSmoothScrolling = obj.monacoSmoothScrolling;
  }
  if (typeof obj.readerEditShowLineNumbers === "boolean") {
    data.readerEditShowLineNumbers = obj.readerEditShowLineNumbers;
  }
  if (typeof obj.readerEditMinimap === "boolean") {
    data.readerEditMinimap = obj.readerEditMinimap;
  }
  if (typeof obj.editAutoRefreshChapterList === "boolean") {
    data.editAutoRefreshChapterList = obj.editAutoRefreshChapterList;
  }
  if (obj.aiSmartFormat && typeof obj.aiSmartFormat === "object") {
    data.aiSmartFormat = obj.aiSmartFormat as PersistedSettingsData["aiSmartFormat"];
  }
  if (
    typeof obj.fullscreenReaderWidthPercent === "number" &&
    Number.isFinite(obj.fullscreenReaderWidthPercent)
  ) {
    data.fullscreenReaderWidthPercent = Math.max(
      30,
      Math.min(100, Math.floor(obj.fullscreenReaderWidthPercent)),
    );
  }
  if (obj.shortcutBindings && typeof obj.shortcutBindings === "object") {
    data.shortcutBindings = obj.shortcutBindings as Partial<
      Record<ShortcutActionId, string>
    >;
  }
  if (
    obj.readerPaletteOverridesLight &&
    typeof obj.readerPaletteOverridesLight === "object"
  ) {
    const p = parseReaderPaletteOverrides(obj.readerPaletteOverridesLight);
    if (Object.keys(p).length) data.readerPaletteOverridesLight = p;
  }
  if (
    obj.readerPaletteOverridesDark &&
    typeof obj.readerPaletteOverridesDark === "object"
  ) {
    const p = parseReaderPaletteOverrides(obj.readerPaletteOverridesDark);
    if (Object.keys(p).length) data.readerPaletteOverridesDark = p;
  }
  if (Array.isArray(obj.highlightColorsLight)) {
    const h = parseHighlightColorsArray(obj.highlightColorsLight);
    if (h) data.highlightColorsLight = h;
  }
  if (Array.isArray(obj.highlightColorsDark)) {
    const h = parseHighlightColorsArray(obj.highlightColorsDark);
    if (h) data.highlightColorsDark = h;
  }
  if (Array.isArray(obj.lineationColorsLight)) {
    const c = parseLineationColorsArray(obj.lineationColorsLight);
    if (c) data.lineationColorsLight = c;
  }
  if (Array.isArray(obj.lineationColorsDark)) {
    const c = parseLineationColorsArray(obj.lineationColorsDark);
    if (c) data.lineationColorsDark = c;
  }
  if (obj.lineationLastColors != null && typeof obj.lineationLastColors === "object") {
    data.lineationLastColors = parseLineationLastColors(obj.lineationLastColors);
  }
  const globalHl = normalizeHighlightWordsByIndex(
    obj.highlightWordsByIndexGlobal,
  );
  if (globalHl) data.highlightWordsByIndexGlobal = globalHl;
  if (typeof obj.ebookConvertOutputDir === "string") {
    data.ebookConvertOutputDir = obj.ebookConvertOutputDir;
  }
  if (typeof obj.fileCategory === "string" && obj.fileCategory.trim()) {
    data.fileCategory = obj.fileCategory.trim();
  }
  if (typeof obj.fileSort === "string" && isFileSortMode(obj.fileSort)) {
    data.fileSort = obj.fileSort;
  }
  const catalog = parseFileCategoryCatalog(obj.fileCategoryCatalog);
  if (catalog) data.fileCategoryCatalog = catalog;
  if (typeof obj.syncCurrentFile === "boolean") {
    data.syncCurrentFile = obj.syncCurrentFile;
  }

  const hasAiSkillsPersisted =
    (obj.aiSkillsEnabled && typeof obj.aiSkillsEnabled === "object") ||
    (obj.aiSkillOverrides && typeof obj.aiSkillOverrides === "object") ||
    Array.isArray(obj.aiCustomSkills);

  const customSkillList = Array.isArray(obj.aiCustomSkills)
    ? mergeAiCustomSkills(obj.aiCustomSkills)
    : [];
  if (customSkillList.length) {
    data.aiCustomSkills = customSkillList;
  }
  const customSkillIds = customSkillList.map((s) => s.id);

  if (obj.aiSkillOverrides && typeof obj.aiSkillOverrides === "object") {
    data.aiSkillOverrides = mergeAiSkillOverrides(
      obj.aiSkillOverrides as Record<string, AiSkillUserOverride>,
    );
  }

  if (hasAiSkillsPersisted) {
    const enabledRaw =
      obj.aiSkillsEnabled && typeof obj.aiSkillsEnabled === "object"
        ? (obj.aiSkillsEnabled as Record<string, boolean>)
        : undefined;
    data.aiSkillsEnabled = mergeAiSkillsEnabled(enabledRaw, customSkillIds);
  }

  if (typeof obj.aiAssistantDeepThinking === "boolean") {
    data.aiAssistantDeepThinking = obj.aiAssistantDeepThinking;
  }
  if (typeof obj.aiAssistantSpoilerSafe === "boolean") {
    data.aiAssistantSpoilerSafe = obj.aiAssistantSpoilerSafe;
  }

  if (
    typeof obj.wordcloudFontFamily === "string" &&
    obj.wordcloudFontFamily.trim()
  ) {
    data.wordcloudFontFamily = obj.wordcloudFontFamily.trim();
  }
  const wordcloudAngle = parseWordcloudAngleMode(obj.wordcloudAngleMode);
  if (wordcloudAngle) {
    data.wordcloudAngleMode = wordcloudAngle;
  }
  const wordcloudPalette = parseWordcloudPaletteId(obj.wordcloudPaletteId);
  if (wordcloudPalette) {
    data.wordcloudPaletteId = wordcloudPalette;
  }

  if (typeof obj.characterPortraitCacheDir === "string") {
    data.characterPortraitCacheDir = obj.characterPortraitCacheDir.trim();
  }

  data.characterCardTextureEffect = normalizeCharacterCardTextureEffect(
    obj.characterCardTextureEffect,
  );

  if (obj.voiceRead && typeof obj.voiceRead === "object") {
    const vr = obj.voiceRead as Record<string, unknown>;
    data.voiceRead = {
      scheme:
        vr.scheme === "single" || vr.scheme === "multi" ? vr.scheme : undefined,
      engine:
        vr.engine === "edge" || vr.engine === "dashscope" || vr.engine === "system"
          ? vr.engine
          : undefined,
      voiceId: typeof vr.voiceId === "string" ? vr.voiceId : undefined,
      narrationVoiceId:
        typeof vr.narrationVoiceId === "string"
          ? vr.narrationVoiceId
          : undefined,
      dialogueVoiceId:
        typeof vr.dialogueVoiceId === "string" ? vr.dialogueVoiceId : undefined,
      dialogueMaleVoiceId:
        typeof vr.dialogueMaleVoiceId === "string"
          ? vr.dialogueMaleVoiceId
          : undefined,
      dialogueFemaleVoiceId:
        typeof vr.dialogueFemaleVoiceId === "string"
          ? vr.dialogueFemaleVoiceId
          : undefined,
      dialogueQuoteStyles: Array.isArray(vr.dialogueQuoteStyles)
        ? vr.dialogueQuoteStyles
        : undefined,
      aiSpeakerRecognitionEnabled:
        typeof vr.aiSpeakerRecognitionEnabled === "boolean"
          ? vr.aiSpeakerRecognitionEnabled
          : undefined,
      rate: typeof vr.rate === "number" ? vr.rate : undefined,
      pitch: typeof vr.pitch === "number" ? vr.pitch : undefined,
      dashscopeApiKey:
        typeof vr.dashscopeApiKey === "string" ? vr.dashscopeApiKey : undefined,
      profiles: Array.isArray(vr.profiles) ? vr.profiles : undefined,
      activeProfileId:
        typeof vr.activeProfileId === "string" ? vr.activeProfileId : undefined,
    };
    const usageRaw = vr.aiSpeakerTokenUsage;
    if (usageRaw && typeof usageRaw === "object") {
      const u = usageRaw as Record<string, unknown>;
      data.voiceRead!.aiSpeakerTokenUsage = {
        promptTokens:
          typeof u.promptTokens === "number" ? u.promptTokens : undefined,
        completionTokens:
          typeof u.completionTokens === "number" ? u.completionTokens : undefined,
        totalTokens:
          typeof u.totalTokens === "number" ? u.totalTokens : undefined,
        promptCacheHitTokens:
          typeof u.promptCacheHitTokens === "number"
            ? u.promptCacheHitTokens
            : undefined,
      };
    }
    if (typeof vr.aiSpeakerTokenUsageAvailable === "boolean") {
      data.voiceRead!.aiSpeakerTokenUsageAvailable =
        vr.aiSpeakerTokenUsageAvailable;
    }
  }

  return {
    data,
    ebookConvertOutputDirKeyPresent,
    characterPortraitCacheDirKeyPresent,
  };
}

export function persistSettingsData(
  storage: Storage | undefined,
  key: string,
  data: PersistedSettingsData,
) {
  try {
    storage?.setItem(key, JSON.stringify(data));
  } catch {
    // ignore
  }
}

export function loadSessionSnapshot(
  storage: Storage | undefined,
  key: string,
): SessionSnapshot | null {
  const parsed = safeJsonParse(storage?.getItem(key));
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;

  const currentFile =
    typeof obj.currentFile === "string" && obj.currentFile.trim()
      ? obj.currentFile
      : null;
  const viewportTopLine =
    typeof obj.viewportTopLine === "number" &&
    Number.isFinite(obj.viewportTopLine)
      ? Math.max(1, Math.floor(obj.viewportTopLine))
      : 1;
  const viewportBottomLine =
    typeof obj.viewportBottomLine === "number" &&
    Number.isFinite(obj.viewportBottomLine)
      ? Math.max(1, Math.floor(obj.viewportBottomLine))
      : 1;

  return {
    currentFile,
    viewportTopLine,
    viewportBottomLine,
  };
}

export function persistSessionSnapshot(
  storage: Storage | undefined,
  key: string,
  data: SessionSnapshot,
) {
  try {
    storage?.setItem(key, JSON.stringify(data));
  } catch {
    // ignore
  }
}

export function clearSessionSnapshot(
  storage: Storage | undefined,
  key: string,
) {
  try {
    storage?.removeItem(key);
  } catch {
    // ignore
  }
}

export function loadTxtFileListSnapshot(
  storage: Storage | undefined,
  key: string,
): TxtFileItem[] {
  const parsed = safeJsonParse(storage?.getItem(key));
  if (!isTxtFileItemArray(parsed)) return [];
  return migrateTxtFileListAddedAt(parsed);
}

export function persistTxtFileListSnapshot(
  storage: Storage | undefined,
  key: string,
  data: TxtFileItem[],
) {
  try {
    storage?.setItem(key, JSON.stringify(data));
  } catch {
    // ignore
  }
}
