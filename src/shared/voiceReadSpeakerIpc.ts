import type { AITokenUsageTotals } from "./aiTokenUsage";

/** AI 对引号内文本的朗读分类 */
export type VoiceReadQuoteVoiceKind =
  | "narration"
  | "male"
  | "female"
  | "unknown";

export type VoiceReadQuoteAttribution = {
  kind: VoiceReadQuoteVoiceKind;
  speaker: string | null;
};

export type VoiceReadAttributeSpeakersRequest = {
  line: string;
  /** 按出现顺序的引号内文本（不含引号本身） */
  dialogueTexts: string[];
  roster: { displayName: string; aliases: string[] }[];
};

export type VoiceReadAttributeSpeakersResult =
  | {
      ok: true;
      quotes: VoiceReadQuoteAttribution[];
      tokenUsage?: AITokenUsageTotals | null;
      tokenUsageAvailable?: boolean;
    }
  | { ok: false; error: string };
