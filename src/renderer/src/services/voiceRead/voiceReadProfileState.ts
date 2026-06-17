import {
  ensureVoiceReadProfilesBundle,
  LEGACY_DEFAULT_VOICE_READ_PROFILE_ID,
  normalizeVoiceReadProfile,
  normalizeVoiceReadProfiles,
  type VoiceReadProfile,
  type VoiceReadProfilesBundle,
} from "@shared/voiceReadProfiles";
import { toRaw } from "vue";
import {
  mergeVoiceReadSettings,
  type VoiceReadSettings,
} from "../../constants/voiceRead";

export type PersistedVoiceReadRaw = Partial<VoiceReadSettings> & {
  profiles?: unknown;
  activeProfileId?: unknown;
  aiSpeakerTokenUsage?: unknown;
  aiSpeakerTokenUsageAvailable?: unknown;
};

function normalizeProfileSettings(partial: unknown): VoiceReadSettings {
  return mergeVoiceReadSettings(
    partial && typeof partial === "object"
      ? (partial as Partial<VoiceReadSettings>)
      : undefined,
  );
}

function extractLegacySettings(
  raw: PersistedVoiceReadRaw | undefined,
): VoiceReadSettings {
  if (!raw || typeof raw !== "object") {
    return mergeVoiceReadSettings(undefined);
  }
  const { profiles: _profiles, activeProfileId: _active, aiSpeakerTokenUsage: _usage, aiSpeakerTokenUsageAvailable: _usageAvail, ...legacy } = raw;
  return mergeVoiceReadSettings(legacy);
}

export function migrateVoiceReadFromPersisted(
  raw: PersistedVoiceReadRaw | undefined,
): VoiceReadProfilesBundle & { activeSettings: VoiceReadSettings } {
  const fallbackSettings = extractLegacySettings(raw);
  const hadProfiles = Array.isArray(raw?.profiles) && raw!.profiles!.length > 0;
  const bundle = ensureVoiceReadProfilesBundle(
    hadProfiles ? raw?.profiles : undefined,
    hadProfiles ? raw?.activeProfileId : LEGACY_DEFAULT_VOICE_READ_PROFILE_ID,
    fallbackSettings,
    normalizeProfileSettings,
  );

  if (!hadProfiles) {
    bundle.profiles = normalizeVoiceReadProfiles(
      undefined,
      fallbackSettings,
      normalizeProfileSettings,
    );
    const defaultProfile = bundle.profiles[0];
    if (defaultProfile) {
      defaultProfile.settings = fallbackSettings;
    }
    bundle.activeProfileId = bundle.profiles[0]?.id ?? bundle.activeProfileId;
  }

  const active =
    bundle.profiles.find((p) => p.id === bundle.activeProfileId) ??
    bundle.profiles[0]!;
  return {
    ...bundle,
    activeSettings: mergeVoiceReadSettings(active.settings),
  };
}

export function normalizeVoiceReadProfilesForSave(
  profiles: VoiceReadProfile[],
): VoiceReadProfile[] {
  return profiles.map((p) => ({
    ...p,
    settings: normalizeProfileSettings(p.settings),
  }));
}

/** Vue 响应式对象无法 structuredClone，先 toRaw 再归一化为纯数据 */
export function cloneVoiceReadProfiles(
  source: readonly VoiceReadProfile[],
): VoiceReadProfile[] {
  const list = toRaw(source) as VoiceReadProfile[];
  return normalizeVoiceReadProfilesForSave(Array.isArray(list) ? list : []);
}

export { normalizeVoiceReadProfile, normalizeVoiceReadProfiles };
