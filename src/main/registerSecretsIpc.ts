import { ipcMain } from "electron";
import {
  SECRET_SLOT_VOICE_READ_DASHSCOPE_API_KEY,
  SECRET_SLOT_VOICE_READ_PROFILE_KEYS,
  type SecretSlotId,
} from "@shared/secretSlots";
import {
  getSecret,
  isSystemSecretEncryptionAvailable,
  secretStorageBackendLabel,
  setSecret,
} from "./secretStorage";

function isVoiceReadSlot(slot: unknown): slot is SecretSlotId {
  return (
    slot === SECRET_SLOT_VOICE_READ_DASHSCOPE_API_KEY ||
    slot === SECRET_SLOT_VOICE_READ_PROFILE_KEYS
  );
}

export function registerSecretsIpcHandlers(): void {
  ipcMain.handle("secrets:isEncryptionAvailable", () => ({
    ok: true as const,
    available: isSystemSecretEncryptionAvailable(),
    backend: secretStorageBackendLabel(),
  }));

  ipcMain.handle("secrets:getVoiceReadDashScopeApiKey", async () => ({
    ok: true as const,
    apiKey: await getSecret(SECRET_SLOT_VOICE_READ_DASHSCOPE_API_KEY),
  }));

  ipcMain.handle(
    "secrets:setVoiceReadDashScopeApiKey",
    async (_evt, rawKey: unknown) => {
      const key = typeof rawKey === "string" ? rawKey : "";
      await setSecret(SECRET_SLOT_VOICE_READ_DASHSCOPE_API_KEY, key);
      return { ok: true as const };
    },
  );

  ipcMain.handle("secrets:get", async (_evt, slotRaw: unknown) => {
    if (!isVoiceReadSlot(slotRaw)) {
      return { ok: false as const, error: "不支持的密钥类型" };
    }
    return {
      ok: true as const,
      value: await getSecret(slotRaw),
    };
  });

  ipcMain.handle("secrets:set", async (_evt, payload: unknown) => {
    if (!payload || typeof payload !== "object") {
      return { ok: false as const, error: "无效参数" };
    }
    const o = payload as { slot?: unknown; value?: unknown };
    if (!isVoiceReadSlot(o.slot)) {
      return { ok: false as const, error: "不支持的密钥类型" };
    }
    await setSecret(o.slot, typeof o.value === "string" ? o.value : "");
    return { ok: true as const };
  });
}
