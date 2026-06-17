import type { CharacterRosterEntry } from "@shared/characterTypes";
import { parseCharacterAliasesInput } from "@shared/characterAliases";
import type { VoiceReadQuoteAttribution } from "@shared/voiceReadSpeakerIpc";
import type { VoiceReadSettings } from "../../constants/voiceRead";
import type { VoiceReadTextSegment } from "./voiceReadSegments";

export type VoiceReadSpeakChunk = {
  text: string;
  voiceId: string;
};

function aliasDedupeKey(s: string): string {
  return s.trim().toLowerCase();
}

function findCharacterBySpeaker(
  roster: readonly CharacterRosterEntry[],
  speaker: string | null | undefined,
): CharacterRosterEntry | undefined {
  const key = speaker?.trim();
  if (!key) return undefined;
  const want = aliasDedupeKey(key);
  for (const entry of roster) {
    if (aliasDedupeKey(entry.displayName) === want) return entry;
    for (const a of parseCharacterAliasesInput(entry.aliases)) {
      if (aliasDedupeKey(a) === want) return entry;
    }
  }
  return undefined;
}

function dialogueFallbackVoiceId(settings: VoiceReadSettings): string {
  return settings.dialogueVoiceId.trim() || settings.voiceId;
}

function maleDialogueVoiceId(settings: VoiceReadSettings): string {
  return settings.dialogueMaleVoiceId.trim() || dialogueFallbackVoiceId(settings);
}

function femaleDialogueVoiceId(settings: VoiceReadSettings): string {
  return (
    settings.dialogueFemaleVoiceId.trim() || dialogueFallbackVoiceId(settings)
  );
}

export function resolveSegmentVoiceId(
  settings: VoiceReadSettings,
  segment: Pick<VoiceReadTextSegment, "kind">,
  roster: readonly CharacterRosterEntry[],
  quoteAttr?: VoiceReadQuoteAttribution | null,
  aiFeaturesEnabled = false,
): string {
  if (settings.scheme === "single") {
    return settings.voiceId.trim() || settings.narrationVoiceId;
  }
  if (segment.kind === "narration") {
    return settings.narrationVoiceId.trim() || settings.voiceId;
  }

  const aiOn = aiFeaturesEnabled && quoteAttr != null;
  if (aiOn && quoteAttr.kind === "narration") {
    return settings.narrationVoiceId.trim() || settings.voiceId;
  }

  if (!aiOn) {
    return dialogueFallbackVoiceId(settings);
  }

  const hit = findCharacterBySpeaker(roster, quoteAttr.speaker);
  const charVoice = hit?.voiceReadVoiceId?.trim();
  if (charVoice) return charVoice;
  if (hit?.gender === "male") return maleDialogueVoiceId(settings);
  if (hit?.gender === "female") return femaleDialogueVoiceId(settings);
  if (quoteAttr.kind === "male") return maleDialogueVoiceId(settings);
  if (quoteAttr.kind === "female") return femaleDialogueVoiceId(settings);
  return dialogueFallbackVoiceId(settings);
}

export function resolveSpeakChunk(
  settings: VoiceReadSettings,
  segment: VoiceReadTextSegment,
  roster: readonly CharacterRosterEntry[],
  quoteAttr?: VoiceReadQuoteAttribution | null,
  aiFeaturesEnabled = false,
): VoiceReadSpeakChunk {
  return {
    text: segment.text,
    voiceId: resolveSegmentVoiceId(
      settings,
      segment,
      roster,
      quoteAttr,
      aiFeaturesEnabled,
    ),
  };
}
