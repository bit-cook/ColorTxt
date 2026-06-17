import type { CharacterRosterEntry } from "@shared/characterTypes";
import type { VoiceReadSettings } from "../../constants/voiceRead";
import { buildLineSpeakChunks } from "./voiceReadLineBuild";
import { VoiceReadLinePlayer } from "./voiceReadLinePlayer";

export function resolveCharacterVoicePreviewVoiceId(
  entry: Pick<CharacterRosterEntry, "gender" | "voiceReadVoiceId">,
  settings: VoiceReadSettings,
): string {
  const custom = entry.voiceReadVoiceId?.trim();
  if (custom) return custom;
  if (entry.gender === "male") {
    return (
      settings.dialogueMaleVoiceId.trim() ||
      settings.dialogueVoiceId.trim() ||
      settings.voiceId.trim()
    );
  }
  if (entry.gender === "female") {
    return (
      settings.dialogueFemaleVoiceId.trim() ||
      settings.dialogueVoiceId.trim() ||
      settings.voiceId.trim()
    );
  }
  return settings.dialogueVoiceId.trim() || settings.voiceId.trim();
}

export function characterVoicePreviewSettings(
  entry: Pick<CharacterRosterEntry, "gender" | "voiceReadVoiceId">,
  settings: VoiceReadSettings,
): VoiceReadSettings {
  return {
    ...settings,
    scheme: "single",
    voiceId: resolveCharacterVoicePreviewVoiceId(entry, settings),
  };
}

export async function speakCharacterVoiceSample(
  player: VoiceReadLinePlayer,
  settings: VoiceReadSettings,
  entry: Pick<
    CharacterRosterEntry,
    "gender" | "voiceReadVoiceId" | "voiceReadSampleLine"
  >,
): Promise<void> {
  const text = entry.voiceReadSampleLine?.trim() ?? "";
  if (!text) return;
  const previewSettings = characterVoicePreviewSettings(entry, settings);
  const chunks = buildLineSpeakChunks(previewSettings, text, []).chunks;
  if (chunks.length > 0) {
    await player.speakChunks(previewSettings, chunks);
  } else {
    await player.speakLine(previewSettings, text);
  }
}
