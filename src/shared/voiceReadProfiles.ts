/** 语音朗读配置方案（主进程 / preload / renderer 对齐） */

import { DASHSCOPE_PLATFORM_LABEL } from "./apiEndpointPresets";

export const MAX_VOICE_READ_PROFILES = 12;
export const LEGACY_DEFAULT_VOICE_READ_PROFILE_ID = "profile-default";

export type VoiceReadEngineId = "system" | "edge" | "dashscope";
export type VoiceReadScheme = "single" | "multi";
export type VoiceReadDialogueQuoteStyle =
  | "double"
  | "single"
  | "corner"
  | "doubleCorner";

/** 方案内 settings 快照（不含试听文案） */
export type VoiceReadProfileSettings = {
  scheme: VoiceReadScheme;
  engine: VoiceReadEngineId;
  voiceId: string;
  narrationVoiceId: string;
  dialogueVoiceId: string;
  dialogueMaleVoiceId: string;
  dialogueFemaleVoiceId: string;
  dialogueQuoteStyles: VoiceReadDialogueQuoteStyle[];
  aiSpeakerRecognitionEnabled: boolean;
  rate: number;
  pitch: number;
  dashscopeApiKey: string;
};

export interface VoiceReadProfile {
  id: string;
  name: string;
  settings: VoiceReadProfileSettings;
  updatedAt?: number;
}

function normalizeProfileName(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw.trim().slice(0, 80);
}

function normalizeProfileId(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw.trim().slice(0, 64);
}

/** 方案未命名时，下拉 placeholder / 列表回退文案 */
export function resolveVoiceReadProfileLabel(
  settings: Pick<
    VoiceReadProfileSettings,
    "scheme" | "engine" | "aiSpeakerRecognitionEnabled"
  >,
): string {
  const schemeLabel = settings.scheme === "multi" ? "旁白/对白" : "单音色";
  let engineLabel = "";
  switch (settings.engine) {
    case "edge":
      engineLabel = "Edge TTS";
      break;
    case "system":
      engineLabel = "系统语音";
      break;
    case "dashscope":
      engineLabel = DASHSCOPE_PLATFORM_LABEL;
      break;
    default:
      engineLabel = settings.engine;
  }
  let label = `${schemeLabel} · ${engineLabel}`;
  if (
    settings.scheme === "multi" &&
    settings.aiSpeakerRecognitionEnabled !== false
  ) {
    label += " · AI 识别";
  }
  return label;
}

export function createVoiceReadProfile(opts?: {
  id?: string;
  name?: string;
  settings?: VoiceReadProfileSettings;
}): VoiceReadProfile {
  return {
    id: opts?.id?.trim() || crypto.randomUUID(),
    name: normalizeProfileName(opts?.name),
    settings: opts?.settings ?? ({} as VoiceReadProfileSettings),
    updatedAt: Date.now(),
  };
}

export function normalizeVoiceReadProfile(
  raw: unknown,
  normalizeSettings: (partial: unknown) => VoiceReadProfileSettings,
): VoiceReadProfile | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const id = normalizeProfileId(o.id);
  if (!id) return null;
  return {
    id,
    name: normalizeProfileName(o.name),
    settings: normalizeSettings(o.settings ?? o),
    updatedAt:
      typeof o.updatedAt === "number" && Number.isFinite(o.updatedAt)
        ? o.updatedAt
        : undefined,
  };
}

export function normalizeVoiceReadProfiles(
  raw: unknown,
  fallbackSettings: VoiceReadProfileSettings,
  normalizeSettings: (partial: unknown) => VoiceReadProfileSettings,
): VoiceReadProfile[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    return [
      createVoiceReadProfile({
        id: LEGACY_DEFAULT_VOICE_READ_PROFILE_ID,
        name: "",
        settings: fallbackSettings,
      }),
    ];
  }
  const seen = new Set<string>();
  const out: VoiceReadProfile[] = [];
  for (const item of raw) {
    const p = normalizeVoiceReadProfile(item, normalizeSettings);
    if (!p || seen.has(p.id)) continue;
    seen.add(p.id);
    out.push(p);
    if (out.length >= MAX_VOICE_READ_PROFILES) break;
  }
  return out.length > 0
    ? out
    : [
        createVoiceReadProfile({
          id: LEGACY_DEFAULT_VOICE_READ_PROFILE_ID,
          name: "",
          settings: fallbackSettings,
        }),
      ];
}

function resolveActiveProfileId(
  activeId: unknown,
  profiles: Array<{ id: string }>,
): string {
  const id = typeof activeId === "string" ? activeId.trim() : "";
  if (id && profiles.some((p) => p.id === id)) return id;
  return profiles[0]!.id;
}

export function collectVoiceReadProfileApiKeys(
  profiles: VoiceReadProfile[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of profiles) {
    const k = p.settings.dashscopeApiKey.trim();
    if (k) out[p.id] = k;
  }
  return out;
}

export function hydrateVoiceReadProfilesApiKeys(
  profiles: VoiceReadProfile[],
  keys: Record<string, string>,
): void {
  for (const p of profiles) {
    const vault = keys[p.id];
    if (vault) {
      p.settings.dashscopeApiKey = vault;
    }
  }
}

export function stripVoiceReadProfileApiKeysForDisk(
  profiles: VoiceReadProfile[],
): VoiceReadProfile[] {
  return profiles.map((p) => ({
    ...p,
    settings: { ...p.settings, dashscopeApiKey: "" },
  }));
}

export type VoiceReadProfilesBundle = {
  profiles: VoiceReadProfile[];
  activeProfileId: string;
};

export function ensureVoiceReadProfilesBundle(
  rawProfiles: unknown,
  rawActiveId: unknown,
  fallbackSettings: VoiceReadProfileSettings,
  normalizeSettings: (partial: unknown) => VoiceReadProfileSettings,
): VoiceReadProfilesBundle {
  const profiles = normalizeVoiceReadProfiles(
    rawProfiles,
    fallbackSettings,
    normalizeSettings,
  );
  const activeProfileId = resolveActiveProfileId(rawActiveId, profiles);
  return { profiles, activeProfileId };
}
