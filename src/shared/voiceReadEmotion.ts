import type { VoiceReadEngineConfig } from "./voiceReadEngineConfig";
import type { VoiceReadEngineId } from "./voiceReadEngines";
import {
  dashscopeTtsModelSupportsInstructions,
  normalizeDashscopeTtsModel,
} from "./voiceReadDashscopeModels";

/** auto：不传情绪参数，由引擎根据文本推断 */
export const VOICE_READ_EMOTION_AUTO = "auto" as const;

/** auto，或预设英文标签，或 AI 标注的自然语言语气描述 */
export type VoiceReadEmotionId = typeof VOICE_READ_EMOTION_AUTO | string;

/** MiniMax 等引擎支持的固定情绪枚举 */
export type VoiceReadEmotionLabel =
  | "happy"
  | "sad"
  | "worried"
  | "angry"
  | "fearful"
  | "disgusted"
  | "surprised"
  | "calm"
  | "fluent"
  | "whisper";

const EMOTION_LABELS: readonly VoiceReadEmotionLabel[] = [
  "happy",
  "sad",
  "worried",
  "angry",
  "fearful",
  "disgusted",
  "surprised",
  "calm",
  "fluent",
  "whisper",
];

const EMOTION_ALIASES: Record<string, VoiceReadEmotionLabel> = {
  auto: "calm",
  happy: "happy",
  高兴: "happy",
  开心: "happy",
  快乐: "happy",
  sad: "sad",
  悲伤: "sad",
  难过: "sad",
  worried: "worried",
  担心: "worried",
  关切: "worried",
  忧虑: "worried",
  angry: "angry",
  愤怒: "angry",
  生气: "angry",
  fearful: "fearful",
  害怕: "fearful",
  恐惧: "fearful",
  disgusted: "disgusted",
  厌恶: "disgusted",
  surprised: "surprised",
  惊讶: "surprised",
  calm: "calm",
  平静: "calm",
  中性: "calm",
  fluent: "fluent",
  生动: "fluent",
  whisper: "whisper",
  低语: "whisper",
};

export function isVoiceReadEmotionEnumLabel(
  id: string,
): id is VoiceReadEmotionLabel {
  return (EMOTION_LABELS as readonly string[]).includes(id);
}

export function normalizeVoiceReadEmotion(raw: unknown): VoiceReadEmotionId {
  if (raw === null || raw === undefined) return VOICE_READ_EMOTION_AUTO;
  if (typeof raw !== "string") return VOICE_READ_EMOTION_AUTO;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.toLowerCase() === "auto") {
    return VOICE_READ_EMOTION_AUTO;
  }
  const key = trimmed.toLowerCase();
  if (isVoiceReadEmotionEnumLabel(key)) return key;
  const mapped = EMOTION_ALIASES[key] ?? EMOTION_ALIASES[trimmed];
  if (mapped) return mapped;
  return trimmed;
}

export function isVoiceReadEmotionLabel(
  id: VoiceReadEmotionId,
): id is VoiceReadEmotionLabel {
  return id !== VOICE_READ_EMOTION_AUTO && isVoiceReadEmotionEnumLabel(id);
}

const EMOTION_ENGINE_SUPPORT = new Set<VoiceReadEngineId>([
  "minimax",
  "dashscope",
  "mimo",
]);

export function voiceReadEngineSupportsEmotion(
  engine: VoiceReadEngineId,
  engineConfig?: VoiceReadEngineConfig,
): boolean {
  if (engine === "dashscope") {
    if (!engineConfig) return false;
    return dashscopeTtsModelSupportsInstructions(
      normalizeDashscopeTtsModel(engineConfig.dashscopeModel),
    );
  }
  return EMOTION_ENGINE_SUPPORT.has(engine);
}

/** 用户开启且当前引擎/模型支持情绪参数 */
export function voiceReadEmotionActive(settings: {
  engine: VoiceReadEngineId;
  engineConfig?: VoiceReadEngineConfig;
  emotionEnabled?: boolean;
}): boolean {
  if (settings.emotionEnabled === false) return false;
  return voiceReadEngineSupportsEmotion(
    settings.engine,
    settings.engineConfig,
  );
}

const DASHSCOPE_EMOTION_INSTRUCTIONS: Record<VoiceReadEmotionLabel, string> = {
  happy: "语气开心、轻松愉快，富有感染力。",
  sad: "语气悲伤、低沉，带有压抑感。",
  worried: "语气关切、略带担忧，语速略慢。",
  angry: "语气愤怒、强硬，情绪外露。",
  fearful: "语气害怕、紧张，略显颤抖。",
  disgusted: "语气厌恶、不屑，带有排斥感。",
  surprised: "语气惊讶、意外，情绪起伏明显。",
  calm: "语气平静、自然，不夸张。",
  fluent: "语气生动、富有表现力，节奏流畅。",
  whisper: "语气低语、轻声，像在说悄悄话。",
};

/** 将情绪转为通义 instruct / MiMo 等自然语言引擎可用的 instructions */
export function mapEmotionForNaturalLanguageEngine(
  emotion: VoiceReadEmotionId | undefined,
): string | undefined {
  if (!emotion || emotion === VOICE_READ_EMOTION_AUTO) return undefined;
  if (isVoiceReadEmotionEnumLabel(emotion)) {
    return DASHSCOPE_EMOTION_INSTRUCTIONS[emotion];
  }
  return emotion;
}

export function mapEmotionForDashScope(
  emotion: VoiceReadEmotionId | undefined,
): string | undefined {
  return mapEmotionForNaturalLanguageEngine(emotion);
}

function voiceReadEmotionToMiniMaxEnum(
  emotion: string,
): VoiceReadEmotionLabel | undefined {
  if (isVoiceReadEmotionEnumLabel(emotion)) return emotion;
  return undefined;
}

/** MiniMax 仅支持固定枚举；自然语言描述无法映射时不传 emotion */
export function mapEmotionForMiniMax(
  emotion: VoiceReadEmotionId | undefined,
  model: string,
): string | undefined {
  if (!emotion || emotion === VOICE_READ_EMOTION_AUTO) return undefined;
  const enumLabel = voiceReadEmotionToMiniMaxEnum(emotion);
  if (!enumLabel) return undefined;
  const modelId = model.trim().toLowerCase();
  if (enumLabel === "worried") return "fearful";
  if (enumLabel === "whisper" && modelId.includes("2.8")) return undefined;
  if (
    (enumLabel === "fluent" || enumLabel === "whisper") &&
    !modelId.includes("2.6") &&
    !modelId.includes("02") &&
    !modelId.includes("01")
  ) {
    if (enumLabel === "whisper") return undefined;
  }
  return enumLabel;
}

/** MiMo 通过 user 消息传递自然语言风格指令 */
export function mapEmotionForMimo(
  emotion: VoiceReadEmotionId | undefined,
): string | undefined {
  return mapEmotionForNaturalLanguageEngine(emotion);
}

export function voiceReadEmotionCacheToken(
  emotion: VoiceReadEmotionId | undefined,
): string {
  return emotion?.trim() || VOICE_READ_EMOTION_AUTO;
}
