import type { CharacterRosterEntry } from "@shared/characterTypes";
import type { VoiceReadQuoteAttribution } from "@shared/voiceReadSpeakerIpc";
import { parseCharacterAliasesInput } from "@shared/characterAliases";
import { absorbVoiceReadAiSpeakerTokenUsage } from "./voiceReadAiSpeakerTokenUsage";

export type VoiceReadSpeakerCacheKey = string;

type CacheEntry = {
  quotes: VoiceReadQuoteAttribution[];
};

const cache = new Map<VoiceReadSpeakerCacheKey, CacheEntry>();
const inflight = new Map<
  VoiceReadSpeakerCacheKey,
  Promise<VoiceReadQuoteAttribution[]>
>();
/** 作废后：在途 AI 识别完成时不再写回缓存 */
const skipCacheKeys = new Set<VoiceReadSpeakerCacheKey>();

let rosterVersion = 0;

export function bumpVoiceReadSpeakerRosterVersion(): void {
  rosterVersion += 1;
  cache.clear();
  inflight.clear();
  skipCacheKeys.clear();
}

function rosterVersionToken(roster: readonly CharacterRosterEntry[]): string {
  return roster
    .map(
      (r) =>
        `${r.displayName}\u0001${r.aliases}\u0001${r.voiceReadVoiceId ?? ""}\u0001${r.gender}`,
    )
    .join("\u0002");
}

/** 供设置页试听等场景构造缓存键 */
export function voiceReadSpeakerRosterToken(
  roster: readonly CharacterRosterEntry[],
): string {
  return rosterVersionToken(roster);
}

export function voiceReadSpeakerCacheKey(
  bookPath: string,
  lineNo: number,
  lineText: string,
  dialogueTexts: string[],
  roster: readonly CharacterRosterEntry[],
): VoiceReadSpeakerCacheKey {
  return [
    bookPath,
    String(lineNo),
    lineText,
    dialogueTexts.join("\u0001"),
    String(rosterVersion),
    rosterVersionToken(roster),
  ].join("\u0003");
}

export function getCachedQuoteAttributions(
  key: VoiceReadSpeakerCacheKey,
): VoiceReadQuoteAttribution[] | null {
  return cache.get(key)?.quotes ?? null;
}

export function setCachedQuoteAttributions(
  key: VoiceReadSpeakerCacheKey,
  quotes: VoiceReadQuoteAttribution[],
): void {
  cache.set(key, { quotes: quotes.map((q) => ({ ...q })) });
}

export function clearVoiceReadSpeakerCache(): void {
  cache.clear();
  inflight.clear();
  skipCacheKeys.clear();
}

/** 强制下次对该行重新 AI 识别（「重新合成」用） */
export function invalidateCachedQuoteAttributions(
  key: VoiceReadSpeakerCacheKey,
): void {
  cache.delete(key);
  inflight.delete(key);
  skipCacheKeys.add(key);
}

function unknownQuotes(count: number): VoiceReadQuoteAttribution[] {
  return Array.from({ length: count }, () => ({
    kind: "unknown" as const,
    speaker: null,
  }));
}

export async function attributeDialogueQuotes(
  line: string,
  quoteTexts: string[],
  roster: readonly CharacterRosterEntry[],
  cacheKey: VoiceReadSpeakerCacheKey,
): Promise<VoiceReadQuoteAttribution[]> {
  if (quoteTexts.length === 0) return [];
  const hit = getCachedQuoteAttributions(cacheKey);
  if (hit && hit.length === quoteTexts.length) return hit;

  const pending = inflight.get(cacheKey);
  if (pending) return pending;

  const rosterPayload = roster.map((r) => ({
    displayName: r.displayName,
    aliases: parseCharacterAliasesInput(r.aliases),
  }));

  const work = window.colorTxt
    .voiceReadAttributeSpeakers({
      line,
      dialogueTexts: quoteTexts,
      roster: rosterPayload,
    })
    .then((r) => {
      if (r.ok) {
        absorbVoiceReadAiSpeakerTokenUsage({
          tokenUsage: r.tokenUsage,
          tokenUsageAvailable: r.tokenUsageAvailable,
        });
      }
      if (!r.ok) {
        return unknownQuotes(quoteTexts.length);
      }
      const quotes = r.quotes.slice(0, quoteTexts.length);
      while (quotes.length < quoteTexts.length) {
        quotes.push({ kind: "unknown", speaker: null });
      }
      if (!skipCacheKeys.delete(cacheKey)) {
        setCachedQuoteAttributions(cacheKey, quotes);
      }
      return quotes;
    })
    .catch(() => unknownQuotes(quoteTexts.length))
    .finally(() => {
      inflight.delete(cacheKey);
    });

  inflight.set(cacheKey, work);
  return work;
}

/** @deprecated 使用 attributeDialogueQuotes */
export async function attributeDialogueSpeakers(
  line: string,
  quoteTexts: string[],
  roster: readonly CharacterRosterEntry[],
  cacheKey: VoiceReadSpeakerCacheKey,
): Promise<VoiceReadQuoteAttribution[]> {
  return attributeDialogueQuotes(line, quoteTexts, roster, cacheKey);
}
