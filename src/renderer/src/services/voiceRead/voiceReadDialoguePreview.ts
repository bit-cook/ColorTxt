import type { CharacterGender, CharacterRosterEntry } from "@shared/characterTypes";
import type { VoiceReadQuoteAttribution } from "@shared/voiceReadSpeakerIpc";
import type { VoiceReadSettings } from "../../constants/voiceRead";
import { hasVoiceReadSpeakableText } from "./voiceReadTextChunks";
import type { VoiceReadQuoteCarry } from "./voiceReadSegments";
import { buildLineSpeakChunks } from "./voiceReadLineBuild";
import {
  attributeDialogueQuotes,
  voiceReadSpeakerRosterToken,
} from "./voiceReadSpeakerCache";
import type { VoiceReadSpeakChunk } from "./voiceReadVoiceResolve";

/** 设置页「对白语音」综合试听默认文案（旁白 + 男/女/默认对白） */
export const VOICE_READ_DIALOGUE_GENDER_PREVIEW_DEFAULT = `男生一脸关切的问道：“身体不舒服吗？要多喝热水。”
女生淡淡道：“你人还怪好的嘞。”
“贾君鹏，妈妈喊你回家吃饭！”这时外面传来一道声音。`;

function demoRosterEntry(
  displayName: string,
  gender: CharacterGender,
): CharacterRosterEntry {
  return {
    id: `__voice_read_preview_${displayName}__`,
    displayName,
    aliases: "",
    gender,
    ageText: "",
    identity: "",
    bio: "",
    relations: "",
    promptZh: "",
    negativeZh: "",
    retrieveThinkingText: "",
  };
}

/** 默认试听文案配套的演示角色（男/女）；与当前书角色卡合并后供 AI 识别 */
export const VOICE_READ_DIALOGUE_PREVIEW_DEMO_ROSTER: readonly CharacterRosterEntry[] =
  [
    demoRosterEntry("男生", "male"),
    demoRosterEntry("女生", "female"),
  ];

/** 默认试听文案各行的预置引号分类（与 AI 识别结果一致，免调模型） */
const VOICE_READ_DIALOGUE_PREVIEW_DEFAULT_QUOTES_BY_LINE = new Map<
  string,
  readonly VoiceReadQuoteAttribution[]
>([
  [
    `男生一脸关切的问道：“身体不舒服吗？要多喝热水。”`,
    [{ kind: "unknown", speaker: "男生" }],
  ],
  [`女生淡淡道：“你人还怪好的嘞。”`, [{ kind: "unknown", speaker: "女生" }]],
  [
    `“贾君鹏，妈妈喊你回家吃饭！”这时外面传来一道声音。`,
    [{ kind: "unknown", speaker: null }],
  ],
]);

export function normalizeVoiceReadPreviewText(raw: string): string {
  return raw.replace(/\r\n/g, "\n").trim();
}

export function isDefaultVoiceReadDialoguePreviewText(raw: string): boolean {
  return (
    normalizeVoiceReadPreviewText(raw) ===
    normalizeVoiceReadPreviewText(VOICE_READ_DIALOGUE_GENDER_PREVIEW_DEFAULT)
  );
}

export function mergeRosterForVoiceReadPreview(
  bookRoster: readonly CharacterRosterEntry[],
): CharacterRosterEntry[] {
  const byName = new Map<string, CharacterRosterEntry>();
  for (const r of VOICE_READ_DIALOGUE_PREVIEW_DEMO_ROSTER) {
    const k = r.displayName.trim().toLowerCase();
    if (k) byName.set(k, r);
  }
  for (const r of bookRoster) {
    const k = r.displayName.trim().toLowerCase();
    if (k) byName.set(k, r);
  }
  return [...byName.values()];
}

function getDefaultPreviewQuotesForLine(
  lineText: string,
  quoteTexts: string[],
): VoiceReadQuoteAttribution[] | null {
  const baked = VOICE_READ_DIALOGUE_PREVIEW_DEFAULT_QUOTES_BY_LINE.get(
    lineText.trim(),
  );
  if (!baked || baked.length !== quoteTexts.length) return null;
  return baked.map((q) => ({ ...q }));
}

export function voiceReadSettingsPreviewSpeakerCacheKey(
  fullPreviewText: string,
  lineNo: number,
  lineText: string,
  dialogueTexts: string[],
  roster: readonly CharacterRosterEntry[],
  quoteStylesKey: string,
): string {
  return [
    "settings-preview",
    fullPreviewText,
    String(lineNo),
    lineText,
    dialogueTexts.join("\u0001"),
    quoteStylesKey,
    voiceReadSpeakerRosterToken(roster),
  ].join("\u0003");
}

async function resolvePreviewLineQuotes(
  fullPreviewText: string,
  lineNo: number,
  lineText: string,
  quoteTexts: string[],
  roster: readonly CharacterRosterEntry[],
  quoteStylesKey: string,
  useDefaultQuotes: boolean,
): Promise<VoiceReadQuoteAttribution[]> {
  const cacheKey = voiceReadSettingsPreviewSpeakerCacheKey(
    fullPreviewText,
    lineNo,
    lineText,
    quoteTexts,
    roster,
    quoteStylesKey,
  );

  if (useDefaultQuotes) {
    const baked = getDefaultPreviewQuotesForLine(lineText, quoteTexts);
    if (baked) return baked;
  }

  return attributeDialogueQuotes(lineText, quoteTexts, roster, cacheKey);
}

/** 多音色试听（无 AI 说话人识别）：按行切分旁白/对白 */
export function buildMultiVoicePreviewSpeakChunks(
  settings: VoiceReadSettings,
  raw: string,
): VoiceReadSpeakChunk[] {
  const fullText = normalizeVoiceReadPreviewText(raw);
  if (!fullText || !hasVoiceReadSpeakableText(fullText)) return [];

  const lines = fullText.split("\n").filter((l) => l.trim());
  const chunks: VoiceReadSpeakChunk[] = [];
  let carry: VoiceReadQuoteCarry = null;

  for (const line of lines) {
    const lineText = line.trim();
    const lineCarry = carry;
    const built = buildLineSpeakChunks(settings, lineText, [], {
      carry: lineCarry,
      aiFeaturesEnabled: false,
    });
    chunks.push(...built.chunks);
    carry = built.carry;
  }

  return chunks;
}

/**
 * 设置页综合试听：多行旁白/对白，引号内文本经 AI 分类（或默认文案预置结果 / 缓存）。
 */
export async function buildDialogueAiPreviewSpeakChunks(
  settings: VoiceReadSettings,
  raw: string,
  bookRoster: readonly CharacterRosterEntry[],
): Promise<VoiceReadSpeakChunk[]> {
  const fullText = normalizeVoiceReadPreviewText(raw);
  if (!fullText || !hasVoiceReadSpeakableText(fullText)) return [];

  const roster = mergeRosterForVoiceReadPreview(bookRoster);
  const useDefaultQuotes = isDefaultVoiceReadDialoguePreviewText(fullText);
  const quoteStylesKey = settings.dialogueQuoteStyles.join(",");
  const lines = fullText.split("\n").filter((l) => l.trim());

  const chunks: VoiceReadSpeakChunk[] = [];
  let carry: VoiceReadQuoteCarry = null;

  for (let i = 0; i < lines.length; i++) {
    const lineText = lines[i]!.trim();
    const lineCarry = carry;
    const first = buildLineSpeakChunks(settings, lineText, roster, {
      carry: lineCarry,
      aiFeaturesEnabled: true,
    });

    if (first.dialogueSegments.length === 0) {
      chunks.push(...first.chunks);
      carry = first.carry;
      continue;
    }

    const quoteTexts = first.dialogueSegments.map((d) => d.text);
    const quotes = await resolvePreviewLineQuotes(
      fullText,
      i,
      lineText,
      quoteTexts,
      roster,
      quoteStylesKey,
      useDefaultQuotes,
    );

    const built = buildLineSpeakChunks(settings, lineText, roster, {
      carry: lineCarry,
      quoteAttributions: quotes,
      aiFeaturesEnabled: true,
    });
    chunks.push(...built.chunks);
    carry = built.carry;
  }

  return chunks;
}
