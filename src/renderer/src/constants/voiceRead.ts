import type { VoiceReadEdgeTtsRequest } from "@shared/voiceReadEdgeIpc";

export type VoiceReadEngineId = "system" | "edge" | "dashscope";

export type VoiceReadScheme = "single" | "multi";

/** 对白检测：启用的引号对（多选，仅 multi 方案生效） */
export type VoiceReadDialogueQuoteStyle =
  | "double"
  | "single"
  | "corner"
  | "doubleCorner";

export const VOICE_READ_DIALOGUE_QUOTE_OPTIONS: {
  id: VoiceReadDialogueQuoteStyle;
  label: string;
}[] = [
  { id: "double", label: "“”" },
  { id: "single", label: "‘’" },
  { id: "corner", label: "「」" },
  { id: "doubleCorner", label: "『』" },
];

export const VOICE_READ_DIALOGUE_QUOTE_DEFAULTS: VoiceReadDialogueQuoteStyle[] =
  ["double", "single", "corner", "doubleCorner"];

const VALID_DIALOGUE_QUOTE_STYLES = new Set<VoiceReadDialogueQuoteStyle>(
  VOICE_READ_DIALOGUE_QUOTE_DEFAULTS,
);

/** 与 localStorage / SettingsApplyPayload 对齐的语音朗读设置 */
export type VoiceReadSettings = {
  /** 朗读方案：单音色 / 旁白对白多音色 */
  scheme: VoiceReadScheme;
  engine: VoiceReadEngineId;
  /** 系统：voiceURI；Edge：完整 voice id；DashScope：音色名（单音色方案） */
  voiceId: string;
  /** 多音色：旁白 */
  narrationVoiceId: string;
  /** 多音色：对白默认（未识别说话人或性别未知时） */
  dialogueVoiceId: string;
  /** 多音色：对白男声（未设角色专属音色且角色性别为男，或 AI 识别为男声时使用） */
  dialogueMaleVoiceId: string;
  /** 多音色：对白女声（未设角色专属音色且角色性别为女，或 AI 识别为女声时使用） */
  dialogueFemaleVoiceId: string;
  /** 多音色：对白检测引号类型 */
  dialogueQuoteStyles: VoiceReadDialogueQuoteStyle[];
  /** 多音色：启用 AI 识别引号内对白/旁白与说话人（须全局 AI 已启用） */
  aiSpeakerRecognitionEnabled: boolean;
  /** 0.5–2，对应 SpeechSynthesis rate 风格 */
  rate: number;
  /** 0.5–2，对应 SpeechSynthesis pitch 风格 */
  pitch: number;
  dashscopeApiKey: string;
};

export const defaultVoiceReadSettings: VoiceReadSettings = {
  scheme: "single",
  engine: "edge",
  voiceId: "zh-CN-XiaoxiaoNeural",
  narrationVoiceId: "zh-CN-XiaoxiaoNeural",
  dialogueVoiceId: "zh-CN-YunxiNeural",
  dialogueMaleVoiceId: "zh-CN-YunxiNeural",
  dialogueFemaleVoiceId: "zh-CN-XiaoxiaoNeural",
  dialogueQuoteStyles: [...VOICE_READ_DIALOGUE_QUOTE_DEFAULTS],
  aiSpeakerRecognitionEnabled: true,
  rate: 1,
  pitch: 1,
  dashscopeApiKey: "",
};

export function normalizeDialogueQuoteStyles(
  raw: unknown,
): VoiceReadDialogueQuoteStyle[] {
  if (!Array.isArray(raw)) return [...VOICE_READ_DIALOGUE_QUOTE_DEFAULTS];
  const out: VoiceReadDialogueQuoteStyle[] = [];
  const seen = new Set<VoiceReadDialogueQuoteStyle>();
  for (const item of raw) {
    if (
      typeof item === "string" &&
      VALID_DIALOGUE_QUOTE_STYLES.has(item as VoiceReadDialogueQuoteStyle) &&
      !seen.has(item as VoiceReadDialogueQuoteStyle)
    ) {
      const id = item as VoiceReadDialogueQuoteStyle;
      seen.add(id);
      out.push(id);
    }
  }
  return out.length > 0 ? out : [...VOICE_READ_DIALOGUE_QUOTE_DEFAULTS];
}

export const voiceReadRateMin = 0.5;
export const voiceReadRateMax = 2;
export const voiceReadPitchMin = 0.5;
export const voiceReadPitchMax = 2;

/** DashScope qwen3-tts-flash 音色 */
export const DASHSCOPE_TTS_VOICES: { id: string; label: string }[] = [
  { id: "Cherry", label: "芊悦 (Cherry)" },
  { id: "Ethan", label: "晨煦 (Ethan)" },
  { id: "Nofish", label: "不吃鱼 (Nofish)" },
  { id: "Ryan", label: "甜茶 (Ryan)" },
  { id: "Katerina", label: "卡捷琳娜 (Katerina)" },
  { id: "Dylan", label: "北京-晓东 (Dylan)" },
  { id: "Sunny", label: "四川-晴儿 (Sunny)" },
  { id: "Peter", label: "天津-李彼得 (Peter)" },
  { id: "Rocky", label: "粤语-阿强 (Rocky)" },
  { id: "Kiki", label: "粤语-阿清 (Kiki)" },
];

export function clampVoiceReadRate(v: number): number {
  if (!Number.isFinite(v)) return defaultVoiceReadSettings.rate;
  return Math.max(voiceReadRateMin, Math.min(voiceReadRateMax, v));
}

export function clampVoiceReadPitch(v: number): number {
  if (!Number.isFinite(v)) return defaultVoiceReadSettings.pitch;
  return Math.max(voiceReadPitchMin, Math.min(voiceReadPitchMax, v));
}

export function mergeVoiceReadSettings(
  raw: Partial<VoiceReadSettings> | undefined,
): VoiceReadSettings {
  const d = defaultVoiceReadSettings;
  if (!raw || typeof raw !== "object") return { ...d };
  const engine: VoiceReadEngineId =
    raw.engine === "edge" ||
    raw.engine === "dashscope" ||
    raw.engine === "system"
      ? raw.engine
      : d.engine;
  const scheme: VoiceReadScheme =
    raw.scheme === "multi" || raw.scheme === "single" ? raw.scheme : d.scheme;
  const voiceId =
    typeof raw.voiceId === "string" && raw.voiceId.trim()
      ? raw.voiceId
      : d.voiceId;
  const narrationVoiceId =
    typeof raw.narrationVoiceId === "string" && raw.narrationVoiceId.trim()
      ? raw.narrationVoiceId
      : voiceId;
  const dialogueVoiceId =
    typeof raw.dialogueVoiceId === "string" && raw.dialogueVoiceId.trim()
      ? raw.dialogueVoiceId
      : voiceId;
  const dialogueMaleVoiceId =
    typeof raw.dialogueMaleVoiceId === "string" &&
    raw.dialogueMaleVoiceId.trim()
      ? raw.dialogueMaleVoiceId
      : dialogueVoiceId;
  const dialogueFemaleVoiceId =
    typeof raw.dialogueFemaleVoiceId === "string" &&
    raw.dialogueFemaleVoiceId.trim()
      ? raw.dialogueFemaleVoiceId
      : narrationVoiceId;
  return {
    scheme,
    engine,
    voiceId,
    narrationVoiceId,
    dialogueVoiceId,
    dialogueMaleVoiceId,
    dialogueFemaleVoiceId,
    dialogueQuoteStyles: normalizeDialogueQuoteStyles(raw.dialogueQuoteStyles),
    aiSpeakerRecognitionEnabled:
      typeof raw.aiSpeakerRecognitionEnabled === "boolean"
        ? raw.aiSpeakerRecognitionEnabled
        : d.aiSpeakerRecognitionEnabled,
    rate: clampVoiceReadRate(typeof raw.rate === "number" ? raw.rate : d.rate),
    pitch: clampVoiceReadPitch(
      typeof raw.pitch === "number" ? raw.pitch : d.pitch,
    ),
    dashscopeApiKey:
      typeof raw.dashscopeApiKey === "string"
        ? raw.dashscopeApiKey
        : d.dashscopeApiKey,
  };
}

/** 已选 DashScope 但未填写 API 密钥 */
/** 多音色朗读是否执行 AI 引号识别（受朗读设置与全局 AI 开关共同约束） */
export function voiceReadAiSpeakerRecognitionActive(
  settings: Pick<
    VoiceReadSettings,
    "scheme" | "aiSpeakerRecognitionEnabled"
  >,
  globalAiEnabled: boolean,
): boolean {
  return (
    settings.scheme === "multi" &&
    settings.aiSpeakerRecognitionEnabled !== false &&
    globalAiEnabled
  );
}

export function voiceReadDashScopeRequiresApiKey(
  settings: Pick<VoiceReadSettings, "engine" | "dashscopeApiKey">,
): boolean {
  return settings.engine === "dashscope" && !settings.dashscopeApiKey.trim();
}

export function voiceReadEngineSupportsPitch(
  engine: VoiceReadEngineId,
): boolean {
  return engine === "system" || engine === "edge";
}

export function voiceReadEngineSupportsRate(
  engine: VoiceReadEngineId,
): boolean {
  return engine === "system" || engine === "edge" || engine === "dashscope";
}

/** Edge 请求用：从 voice id 推断 xml:lang */
export function inferLangFromEdgeVoiceId(voiceId: string): string {
  const idx = voiceId.indexOf("-");
  if (idx <= 0) return "zh-CN";
  const second = voiceId.indexOf("-", idx + 1);
  if (second < 0) return "zh-CN";
  return voiceId.slice(0, second);
}

export function toVoiceReadEdgeTtsRequest(
  settings: VoiceReadSettings,
  text: string,
  voiceIdOverride?: string,
): VoiceReadEdgeTtsRequest {
  const voice =
    (voiceIdOverride ?? settings.voiceId).trim() || "zh-CN-XiaoxiaoNeural";
  return {
    text,
    voice,
    lang: inferLangFromEdgeVoiceId(voice),
    rate: settings.rate,
    pitch: settings.pitch,
  };
}

/** 单音色方案用 voiceId；多音色由调用方传入已解析的 voiceId */
export function effectiveVoiceReadVoiceId(
  settings: VoiceReadSettings,
  resolvedVoiceId?: string,
): string {
  if (resolvedVoiceId?.trim()) return resolvedVoiceId.trim();
  return settings.voiceId.trim() || defaultVoiceReadSettings.voiceId;
}
