<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import AppCheckbox from "./AppCheckbox.vue";
import AppCustomSelect, { type CustomSelectItem } from "./AppCustomSelect.vue";
import IconButton from "./IconButton.vue";
import RangeSlider from "./RangeSlider.vue";
import SwitchToggle from "./SwitchToggle.vue";
import { icons } from "../icons";
import {
  DASHSCOPE_TTS_VOICES,
  defaultVoiceReadSettings,
  VOICE_READ_DIALOGUE_QUOTE_DEFAULTS,
  VOICE_READ_DIALOGUE_QUOTE_OPTIONS,
  voiceReadAiSpeakerRecognitionActive,
  voiceReadDashScopeRequiresApiKey,
  voiceReadEngineSupportsPitch,
  voiceReadEngineSupportsRate,
  type VoiceReadDialogueQuoteStyle,
  type VoiceReadEngineId,
  type VoiceReadScheme,
  type VoiceReadSettings,
} from "../constants/voiceRead";
import {
  DASHSCOPE_API_KEY_CONSOLE_URL,
  DASHSCOPE_PLATFORM_LABEL,
} from "@shared/apiEndpointPresets";
import { useSecretStorageHint } from "../composables/useSecretStorageHint";
import { buildLineSpeakChunks } from "../services/voiceRead/voiceReadLineBuild";
import {
  buildDialogueAiPreviewSpeakChunks,
  buildMultiVoicePreviewSpeakChunks,
  VOICE_READ_DIALOGUE_GENDER_PREVIEW_DEFAULT,
} from "../services/voiceRead/voiceReadDialoguePreview";
import {
  VoiceReadLinePlayer,
  type VoiceReadPreviewDownload,
} from "../services/voiceRead/voiceReadLinePlayer";
import type { VoiceReadSpeakChunk } from "../services/voiceRead/voiceReadVoiceResolve";
import {
  flatVoiceOptionsToSelectItems,
  groupEdgeTtsVoices,
  groupSystemVoices,
  resolveVoiceReadDisplayLabel,
  voiceGroupsToSelectItems,
} from "../utils/voiceReadVoiceGroups";
import type { CharacterRosterEntry } from "@shared/characterTypes";
import { MAX_VOICE_READ_PROFILES } from "@shared/voiceReadProfiles";
import type { VoiceReadProfile } from "@shared/voiceReadProfiles";
import { useVoiceReadProfileDraft } from "../composables/useVoiceReadProfileDraft";
import AiConfigProfileToolbar from "./AiConfigProfileToolbar.vue";
import type { AITokenPricePerMillion } from "@shared/aiTypes";
import { formatTokenUsageSummaryLine } from "@shared/aiTokenUsage";
import {
  clearVoiceReadAiSpeakerTokenUsage,
  voiceReadAiSpeakerTokenUsage,
} from "../services/voiceRead/voiceReadAiSpeakerTokenUsage";

const settings = defineModel<VoiceReadSettings>({ required: true });
const profiles = defineModel<VoiceReadProfile[]>("profiles", { required: true });
const activeProfileId = defineModel<string>("activeProfileId", { required: true });

const props = defineProps<{
  aiEnabled?: boolean;
  characterRoster?: readonly CharacterRosterEntry[];
}>();

const voiceReadProfileDraft = useVoiceReadProfileDraft(
  settings,
  profiles,
  activeProfileId,
);

const draft = settings;

const { secretStorageHint } = useSecretStorageHint();

const chatTokenPricePerMillion = ref<AITokenPricePerMillion | null>(null);

const voiceReadAiTokenUsageLine = computed(() =>
  formatTokenUsageSummaryLine(
    voiceReadAiSpeakerTokenUsage.value,
    true,
    chatTokenPricePerMillion.value,
    "累计消耗 Token",
  ),
);

function onClearVoiceReadAiTokenUsage() {
  clearVoiceReadAiSpeakerTokenUsage();
}

const selectListsEmpty: CustomSelectItem[] = [];

const schemeOptions: { id: VoiceReadScheme; label: string; description: string }[] =
  [
    { id: "single", label: "单音色", description: "全书使用同一语音" },
    {
      id: "multi",
      label: "旁白/对白多音色",
      description: "旁白与对白可使用不同语音",
    },
  ];

const schemeScrollItems: CustomSelectItem[] = schemeOptions.map((o) => ({
  kind: "item",
  id: o.id,
  label: o.label,
  description: o.description,
}));

const schemeDisplayLabel = computed(() => {
  const hit = schemeOptions.find((o) => o.id === draft.value.scheme);
  return hit?.label ?? draft.value.scheme;
});

const isMultiScheme = computed(() => draft.value.scheme === "multi");

const showAiSpeakerRecognitionToggle = computed(
  () => isMultiScheme.value && props.aiEnabled === true,
);

const showDialogueGenderVoices = computed(
  () =>
    isMultiScheme.value &&
    props.aiEnabled === true &&
    draft.value.aiSpeakerRecognitionEnabled !== false,
);

const engineOptions: {
  id: VoiceReadEngineId;
  label: string;
  description: string;
}[] = [
  {
    id: "edge",
    label: "Edge TTS",
    description: "免费高质量微软 Neural 语音",
  },
  {
    id: "system",
    label: "系统语音",
    description: "免费离线，使用设备系统语音",
  },
  {
    id: "dashscope",
    label: DASHSCOPE_PLATFORM_LABEL,
    description: "高质量云端语音，需要 API 密钥",
  },
];

const engineScrollItems: CustomSelectItem[] = engineOptions.map((o) => ({
  kind: "item",
  id: o.id,
  label: o.label,
  description: o.description,
}));

const engineDisplayLabel = computed(() => {
  const hit = engineOptions.find((o) => o.id === draft.value.engine);
  return hit?.label ?? draft.value.engine;
});

function openDashScopeApiKeyPage() {
  void window.colorTxt.openExternal(DASHSCOPE_API_KEY_CONSOLE_URL);
}

const previewText = ref(VOICE_READ_DIALOGUE_GENDER_PREVIEW_DEFAULT);

type PreviewPhase = "idle" | "ai" | "synthesizing" | "playing";
const previewPhase = ref<PreviewPhase>("idle");
const previewError = ref("");
const previewDownload = ref<VoiceReadPreviewDownload | null>(null);

const showDashScopeKey = ref(false);
const previewPlayer = new VoiceReadLinePlayer();
let previewRunId = 0;

function voiceIdForSinglePreview(): string {
  return draft.value.voiceId;
}

function isPreviewBusy(): boolean {
  return previewPhase.value !== "idle";
}

const previewButtonLabel = computed(() => {
  if (previewPhase.value === "playing") return "停止";
  switch (previewPhase.value) {
    case "ai":
      return "AI 识别中…";
    case "synthesizing":
      return "语音合成中…";
    default:
      return "试听";
  }
});

const previewButtonClass = computed(() => {
  if (previewPhase.value === "playing") return "danger";
  if (isPreviewBusy()) return "warning";
  return "primary";
});

const isPreviewPlaying = computed(() => previewPhase.value === "playing");

function previewPhaseAfterAi(settings: VoiceReadSettings): PreviewPhase {
  return settings.engine === "system" ? "playing" : "synthesizing";
}

const systemVoices = ref<SpeechSynthesisVoice[]>([]);

function refreshSystemVoices() {
  if (typeof window === "undefined" || !window.speechSynthesis) return;
  systemVoices.value = window.speechSynthesis.getVoices();
}

onMounted(() => {
  refreshSystemVoices();
  if (typeof window !== "undefined" && window.speechSynthesis) {
    window.speechSynthesis.onvoiceschanged = () => refreshSystemVoices();
  }
  void (async () => {
    try {
      const c = await window.colorTxt.ai.configGet();
      chatTokenPricePerMillion.value = c.chat?.tokenPricePerMillion ?? null;
    } catch {
      chatTokenPricePerMillion.value = null;
    }
  })();
});

function voiceScrollItemsForEngine(): CustomSelectItem[] {
  if (draft.value.engine === "system") {
    return voiceGroupsToSelectItems(groupSystemVoices(systemVoices.value));
  }
  if (draft.value.engine === "edge") {
    return voiceGroupsToSelectItems(groupEdgeTtsVoices());
  }
  return flatVoiceOptionsToSelectItems(DASHSCOPE_TTS_VOICES);
}

const voiceScrollItems = computed(() => voiceScrollItemsForEngine());

const voiceScrollHasOptions = computed(() =>
  voiceScrollItems.value.some((i) => i.kind === "item"),
);

const voiceScrollMaxHeight = computed(() =>
  draft.value.engine === "dashscope" ? 280 : 360,
);

const voiceDisplayLabel = computed(() =>
  resolveVoiceReadDisplayLabel(
    draft.value.engine,
    draft.value.voiceId,
    systemVoices.value,
  ),
);

const narrationVoiceDisplayLabel = computed(() =>
  resolveVoiceReadDisplayLabel(
    draft.value.engine,
    draft.value.narrationVoiceId,
    systemVoices.value,
  ),
);

const dialogueVoiceDisplayLabel = computed(() =>
  resolveVoiceReadDisplayLabel(
    draft.value.engine,
    draft.value.dialogueVoiceId,
    systemVoices.value,
  ),
);

const dialogueMaleVoiceDisplayLabel = computed(() =>
  resolveVoiceReadDisplayLabel(
    draft.value.engine,
    draft.value.dialogueMaleVoiceId,
    systemVoices.value,
  ),
);

const dialogueFemaleVoiceDisplayLabel = computed(() =>
  resolveVoiceReadDisplayLabel(
    draft.value.engine,
    draft.value.dialogueFemaleVoiceId,
    systemVoices.value,
  ),
);

function isQuoteStyleChecked(id: VoiceReadDialogueQuoteStyle): boolean {
  return draft.value.dialogueQuoteStyles.includes(id);
}

function toggleQuoteStyle(id: VoiceReadDialogueQuoteStyle, checked: boolean) {
  const cur = [...draft.value.dialogueQuoteStyles];
  const idx = cur.indexOf(id);
  if (checked) {
    if (idx < 0) cur.push(id);
  } else {
    if (cur.length <= 1) return;
    if (idx >= 0) cur.splice(idx, 1);
  }
  patchDraft({ dialogueQuoteStyles: cur });
}

watch(
  () => draft.value.engine,
  (eng, prev) => {
    if (eng === prev) return;
    if (eng === "system") {
      refreshSystemVoices();
      const first = systemVoices.value[0];
      const vid = first?.voiceURI ?? "";
      patchDraft({
        voiceId: vid,
        narrationVoiceId: vid,
        dialogueVoiceId: vid,
        dialogueMaleVoiceId: vid,
        dialogueFemaleVoiceId: vid,
      });
    } else if (eng === "edge") {
      patchDraft({
        voiceId: defaultVoiceReadSettings.voiceId,
        narrationVoiceId: defaultVoiceReadSettings.narrationVoiceId,
        dialogueVoiceId: defaultVoiceReadSettings.dialogueVoiceId,
        dialogueMaleVoiceId: defaultVoiceReadSettings.dialogueMaleVoiceId,
        dialogueFemaleVoiceId: defaultVoiceReadSettings.dialogueFemaleVoiceId,
      });
    } else {
      const vid = DASHSCOPE_TTS_VOICES[0]?.id ?? "Cherry";
      patchDraft({
        voiceId: vid,
        narrationVoiceId: vid,
        dialogueVoiceId: vid,
        dialogueMaleVoiceId: vid,
        dialogueFemaleVoiceId: vid,
      });
    }
  },
);

watch(
  () => draft.value.scheme,
  (scheme, prev) => {
    if (scheme === prev) return;
    if (scheme === "multi") {
      const v = draft.value.voiceId.trim() || defaultVoiceReadSettings.voiceId;
      patchDraft({
        narrationVoiceId: draft.value.narrationVoiceId.trim() || v,
        dialogueVoiceId:
          draft.value.dialogueVoiceId.trim() ||
          defaultVoiceReadSettings.dialogueVoiceId,
        dialogueMaleVoiceId:
          draft.value.dialogueMaleVoiceId.trim() ||
          draft.value.dialogueVoiceId.trim() ||
          defaultVoiceReadSettings.dialogueMaleVoiceId,
        dialogueFemaleVoiceId:
          draft.value.dialogueFemaleVoiceId.trim() ||
          draft.value.narrationVoiceId.trim() ||
          defaultVoiceReadSettings.dialogueFemaleVoiceId,
        dialogueQuoteStyles:
          draft.value.dialogueQuoteStyles.length > 0
            ? draft.value.dialogueQuoteStyles
            : [...VOICE_READ_DIALOGUE_QUOTE_DEFAULTS],
      });
    }
  },
);

function restoreDefaultPreviewText() {
  previewText.value = VOICE_READ_DIALOGUE_GENDER_PREVIEW_DEFAULT;
  if (isPreviewBusy()) cancelPreview();
  else {
    previewError.value = "";
    clearPreviewDownload();
  }
}

function patchDraft(p: Partial<VoiceReadSettings>) {
  settings.value = { ...draft.value, ...p };
}

function clearPreviewDownload() {
  previewDownload.value = null;
}

function cancelPreview() {
  previewRunId += 1;
  previewPlayer.onChunkChange = undefined;
  previewPlayer.onSynthesizingChange = undefined;
  previewPlayer.stop();
  previewPhase.value = "idle";
  previewError.value = "";
}

function buildPreviewSpeakChunks(
  settings: VoiceReadSettings,
  text: string,
  voiceId: string,
) {
  const previewSettings: VoiceReadSettings = {
    ...settings,
    scheme: "single",
    voiceId,
  };
  return buildLineSpeakChunks(previewSettings, text, []).chunks;
}

function schedulePreviewDownload(
  settings: VoiceReadSettings,
  text: string,
  chunks: VoiceReadSpeakChunk[],
  runId: number,
) {
  if (settings.engine === "system") return;
  void previewPlayer
    .buildLineDownloadable(settings, text, chunks)
    .then((item) => {
      if (runId !== previewRunId) return;
      previewDownload.value = item;
    })
    .catch(() => {
      if (runId !== previewRunId) return;
    });
}

async function onPreview() {
  if (isPreviewBusy()) return;
  const runId = ++previewRunId;
  const settings = { ...draft.value };
  const voiceId = voiceIdForSinglePreview();
  const needsAi =
    isMultiScheme.value &&
    voiceReadAiSpeakerRecognitionActive(settings, props.aiEnabled === true);
  previewError.value = "";
  clearPreviewDownload();
  previewPlayer.stop();
  previewPhase.value = needsAi ? "ai" : previewPhaseAfterAi(settings);

  const text = previewText.value.trim() || "试听";
  let speakChunks: VoiceReadSpeakChunk[] = [];
  let playbackStarted = false;

  const prevOnChunkChange = previewPlayer.onChunkChange;
  const prevOnSynthesizingChange = previewPlayer.onSynthesizingChange;

  previewPlayer.onChunkChange = (index, total) => {
    if (runId !== previewRunId) return;
    playbackStarted = true;
    previewPhase.value = "playing";
    prevOnChunkChange?.(index, total);
  };

  previewPlayer.onSynthesizingChange = (active) => {
    if (runId !== previewRunId) return;
    if (active) {
      previewPhase.value = "synthesizing";
    } else if (playbackStarted) {
      previewPhase.value = "playing";
    }
    prevOnSynthesizingChange?.(active);
  };

  try {
    if (isMultiScheme.value) {
      speakChunks = showDialogueGenderVoices.value
        ? await buildDialogueAiPreviewSpeakChunks(
            settings,
            text,
            props.characterRoster ?? [],
          )
        : buildMultiVoicePreviewSpeakChunks(settings, text);
    } else {
      speakChunks = buildPreviewSpeakChunks(settings, text, voiceId);
    }

    if (runId !== previewRunId) return;
    if (needsAi) {
      previewPhase.value = previewPhaseAfterAi(settings);
    }

    schedulePreviewDownload(settings, text, speakChunks, runId);

    if (speakChunks.length > 0) {
      await previewPlayer.speakChunks(settings, speakChunks);
    } else {
      const previewSettings: VoiceReadSettings = {
        ...settings,
        scheme: "single",
        voiceId,
      };
      await previewPlayer.speakLine(previewSettings, text);
    }
    if (runId !== previewRunId) return;
  } catch (e) {
    if (runId !== previewRunId) return;
    previewError.value = e instanceof Error ? e.message : String(e);
  } finally {
    previewPlayer.onChunkChange = prevOnChunkChange;
    previewPlayer.onSynthesizingChange = prevOnSynthesizingChange;
    if (runId === previewRunId) previewPhase.value = "idle";
  }
}

function onPreviewDownload() {
  const item = previewDownload.value;
  if (!item) return;
  const url = URL.createObjectURL(item.blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = item.filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

const previewDisabled = computed(() => {
  if (isPreviewPlaying.value) return false;
  return (
    isPreviewBusy() || voiceReadDashScopeRequiresApiKey(draft.value)
  );
});

function onPreviewButtonClick() {
  if (isPreviewPlaying.value) {
    cancelPreview();
    return;
  }
  void onPreview();
}

watch(
  () =>
    [
      draft.value.scheme,
      draft.value.engine,
      draft.value.voiceId,
      draft.value.narrationVoiceId,
      draft.value.dialogueVoiceId,
      draft.value.dialogueMaleVoiceId,
      draft.value.dialogueFemaleVoiceId,
      draft.value.aiSpeakerRecognitionEnabled,
      draft.value.dialogueQuoteStyles.join(","),
      draft.value.dashscopeApiKey,
      draft.value.rate,
      draft.value.pitch,
      previewText.value,
    ] as const,
  () => {
    if (isPreviewBusy()) cancelPreview();
    else {
      previewError.value = "";
      clearPreviewDownload();
    }
  },
);

const rateDisabled = computed(
  () => !voiceReadEngineSupportsRate(draft.value.engine),
);
const pitchDisabled = computed(
  () => !voiceReadEngineSupportsPitch(draft.value.engine),
);

const voiceReadProfileToolbarProfiles = computed(
  () => voiceReadProfileDraft.profileSelectItems.value,
);
const voiceReadProfileToolbarEditingId = computed(
  () => voiceReadProfileDraft.editingId.value,
);
const voiceReadProfileToolbarDisplayName = computed(
  () => voiceReadProfileDraft.editingDisplayName.value,
);
const voiceReadProfileToolbarPlaceholder = computed(
  () => voiceReadProfileDraft.editingProviderLabel.value,
);

function onVoiceReadProfileEditingIdChange(id: string) {
  if (isPreviewBusy()) cancelPreview();
  voiceReadProfileDraft.selectEditingProfile(id);
}

function initVoiceReadProfiles() {
  voiceReadProfileDraft.initFromState();
}

defineExpose({
  finalizeVoiceReadProfiles: voiceReadProfileDraft.finalizeBeforeSave,
  initVoiceReadProfiles,
  resetCurrentVoiceReadProfile: voiceReadProfileDraft.resetCurrentProfileSettings,
});
</script>

<template>
  <div class="settingsBody">
    <section class="aiSection aiSection--compact">
      <h3 class="aiSectionTitle">配置方案</h3>
      <AiConfigProfileToolbar
        :profiles="voiceReadProfileToolbarProfiles"
        :editing-id="voiceReadProfileToolbarEditingId"
        :display-name="voiceReadProfileToolbarDisplayName"
        :placeholder="voiceReadProfileToolbarPlaceholder"
        :max-profiles="MAX_VOICE_READ_PROFILES"
        @update:editing-id="onVoiceReadProfileEditingIdChange"
        @add="voiceReadProfileDraft.addProfile()"
        @rename="void voiceReadProfileDraft.renameProfile()"
        @delete="voiceReadProfileDraft.deleteProfile()"
      />
    </section>

    <section class="aiSection aiSection--compact">
      <div class="settingsRowMain settingsRowMain--baseline">
        <span class="settingsLabel short">朗读方案</span>
        <AppCustomSelect
          class="settingsRowControl"
          :model-value="draft.scheme"
          :display-label="schemeDisplayLabel"
          :fixed-top-items="selectListsEmpty"
          :scroll-items="schemeScrollItems"
          :fixed-bottom-items="selectListsEmpty"
          :scroll-max-height="200"
          ariaLabel="朗读方案"
          @update:model-value="patchDraft({ scheme: $event as VoiceReadScheme })"
        />
      </div>
    </section>

    <section class="aiSection aiSection--compact">
      <div class="settingsRowMain settingsRowMain--baseline">
        <span class="settingsLabel short">引擎</span>
        <AppCustomSelect
          class="settingsRowControl"
          :model-value="draft.engine"
          :display-label="engineDisplayLabel"
          :fixed-top-items="selectListsEmpty"
          :scroll-items="engineScrollItems"
          :fixed-bottom-items="selectListsEmpty"
          :scroll-max-height="280"
          ariaLabel="引擎"
          @update:model-value="
            patchDraft({ engine: $event as VoiceReadEngineId })
          "
        />
      </div>

      <template v-if="draft.engine === 'dashscope'">
        <div class="settingsRowMain settingsRowMain--baseline">
          <span class="settingsLabel short">API 密钥</span>
          <div class="settingsRowField">
            <div class="settingsPasswordRow">
              <input
                class="settingsStretchInput settingsPasswordRow__input"
                :type="showDashScopeKey ? 'text' : 'password'"
                autocomplete="off"
                spellcheck="false"
                :value="draft.dashscopeApiKey"
                @input="
                  patchDraft({
                    dashscopeApiKey: ($event.target as HTMLInputElement).value,
                  })
                "
              />
              <button
                type="button"
                class="btn iconOnly"
                :title="showDashScopeKey ? '隐藏' : '显示'"
                :aria-label="
                  showDashScopeKey ? '隐藏 API 密钥' : '显示 API 密钥'
                "
                @click="showDashScopeKey = !showDashScopeKey"
              >
                <span
                  class="iconSvg"
                  v-html="showDashScopeKey ? icons.view : icons.viewOff"
                />
              </button>
            </div>
          </div>
        </div>
        <p class="settingsHint">
          从阿里百炼平台
          <a href="#" @click.prevent="openDashScopeApiKeyPage">获取 API 密钥</a
          >，使用 qwen3-tts-flash 模型。
        </p>
        <p class="settingsHint">{{ secretStorageHint }}</p>
      </template>

      <div class="settingsRowMain">
        <span class="settingsLabel short">语速（{{ draft.rate.toFixed(2) }}）</span>
        <div class="settingsRowField">
          <RangeSlider
            :model-value="draft.rate"
            :min="0.5"
            :max="2"
            :step="0.05"
            :disabled="rateDisabled"
            :show-percent="false"
            aria-label="语速"
            @update:model-value="patchDraft({ rate: $event })"
          />
        </div>
      </div>
      <p v-if="rateDisabled" class="settingsHint">当前引擎不支持调节语速。</p>

      <div class="settingsRowMain">
        <span class="settingsLabel short">音调（{{ draft.pitch.toFixed(2) }}）</span>
        <div class="settingsRowField">
          <RangeSlider
            :model-value="draft.pitch"
            :min="0.5"
            :max="2"
            :step="0.05"
            :disabled="pitchDisabled"
            :show-percent="false"
            aria-label="音调"
            @update:model-value="patchDraft({ pitch: $event })"
          />
        </div>
      </div>

      <template v-if="isMultiScheme">
        <div class="settingsRowMain settingsRowMain--baseline">
          <span class="settingsLabel short">对白检测</span>
          <div class="settingsRowField voiceReadQuoteChecks">
            <AppCheckbox
              v-for="opt in VOICE_READ_DIALOGUE_QUOTE_OPTIONS"
              :key="opt.id"
              :model-value="isQuoteStyleChecked(opt.id)"
              :aria-label="`对白检测：${opt.label}`"
              @update:model-value="toggleQuoteStyle(opt.id, $event)"
            >
              <template #label
                ><code class="settingsCode">{{ opt.label }}</code></template
              >
            </AppCheckbox>
          </div>
        </div>

        <div class="settingsRowMain settingsRowMain--baseline">
          <span class="settingsLabel short">旁白</span>
          <AppCustomSelect
            class="settingsRowControl"
            :model-value="draft.narrationVoiceId"
            :display-label="narrationVoiceDisplayLabel"
            :placeholder="voiceScrollHasOptions ? '' : '暂无可用语音'"
            :fixed-top-items="selectListsEmpty"
            :scroll-items="voiceScrollItems"
            :fixed-bottom-items="selectListsEmpty"
            :scroll-max-height="voiceScrollMaxHeight"
            ariaLabel="旁白语音"
            @update:model-value="patchDraft({ narrationVoiceId: $event })"
          />
        </div>

        <div class="settingsRowMain settingsRowMain--baseline">
          <span class="settingsLabel short">对白</span>
          <AppCustomSelect
            class="settingsRowControl"
            :model-value="draft.dialogueVoiceId"
            :display-label="dialogueVoiceDisplayLabel"
            :placeholder="voiceScrollHasOptions ? '' : '暂无可用语音'"
            :fixed-top-items="selectListsEmpty"
            :scroll-items="voiceScrollItems"
            :fixed-bottom-items="selectListsEmpty"
            :scroll-max-height="voiceScrollMaxHeight"
            ariaLabel="对白语音"
            @update:model-value="patchDraft({ dialogueVoiceId: $event })"
          />
        </div>

        <div
          v-if="showAiSpeakerRecognitionToggle"
          class="settingsRowMain settingsRowMain--baseline"
        >
          <span class="settingsLabel short">AI 识别</span>
          <SwitchToggle
            :model-value="draft.aiSpeakerRecognitionEnabled"
            aria-label="AI 识别"
            @update:model-value="
              patchDraft({ aiSpeakerRecognitionEnabled: $event })
            "
          />
        </div>
        <p v-if="showDialogueGenderVoices" class="settingsHint">
          朗读时根据性别自动选用男声/女声；可在「角色卡」中为角色设置专属音色。
        </p>
        <p v-if="showDialogueGenderVoices" class="settingsHint voiceReadAiTokenHint">
          {{ voiceReadAiTokenUsageLine }}
          <a href="#" @click.prevent="onClearVoiceReadAiTokenUsage">清零</a>
        </p>

        <template v-if="showDialogueGenderVoices">
          <div class="settingsRowMain settingsRowMain--baseline">
            <span class="settingsLabel short">男声</span>
            <AppCustomSelect
              class="settingsRowControl"
              :model-value="draft.dialogueMaleVoiceId"
              :display-label="dialogueMaleVoiceDisplayLabel"
              :placeholder="voiceScrollHasOptions ? '' : '暂无可用语音'"
              :fixed-top-items="selectListsEmpty"
              :scroll-items="voiceScrollItems"
              :fixed-bottom-items="selectListsEmpty"
              :scroll-max-height="voiceScrollMaxHeight"
              ariaLabel="对白男声"
              @update:model-value="patchDraft({ dialogueMaleVoiceId: $event })"
            />
          </div>
          <div class="settingsRowMain settingsRowMain--baseline">
            <span class="settingsLabel short">女声</span>
            <AppCustomSelect
              class="settingsRowControl"
              :model-value="draft.dialogueFemaleVoiceId"
              :display-label="dialogueFemaleVoiceDisplayLabel"
              :placeholder="voiceScrollHasOptions ? '' : '暂无可用语音'"
              :fixed-top-items="selectListsEmpty"
              :scroll-items="voiceScrollItems"
              :fixed-bottom-items="selectListsEmpty"
              :scroll-max-height="voiceScrollMaxHeight"
              ariaLabel="对白女声"
              @update:model-value="
                patchDraft({ dialogueFemaleVoiceId: $event })
              "
            />
          </div>
        </template>
      </template>

      <div
        v-else
        class="settingsRowMain settingsRowMain--baseline"
      >
        <span class="settingsLabel short">语音</span>
        <AppCustomSelect
          class="settingsRowControl"
          :model-value="draft.voiceId"
          :display-label="voiceDisplayLabel"
          :placeholder="voiceScrollHasOptions ? '' : '暂无可用语音'"
          :fixed-top-items="selectListsEmpty"
          :scroll-items="voiceScrollItems"
          :fixed-bottom-items="selectListsEmpty"
          :scroll-max-height="voiceScrollMaxHeight"
          ariaLabel="语音"
          @update:model-value="patchDraft({ voiceId: $event })"
        />
      </div>

      <textarea
        v-model="previewText"
        class="settingsStretchTextarea settingsStretchTextarea--multiline"
        :rows="isMultiScheme ? 5 : 3"
        aria-label="试听文本"
      />
      <div class="voiceReadPreviewFooter">
        <button
          type="button"
          class="btn voiceReadPreviewRestoreBtn"
          @click="restoreDefaultPreviewText"
        >
          恢复默认
        </button>
        <div class="voiceReadPreviewActionsGroup">
          <p
            v-if="previewError"
            class="voiceReadPreviewError"
            role="alert"
          >
            {{ previewError }}
          </p>
          <IconButton
            v-if="previewDownload"
            class="voiceReadPreviewDownloadBtn"
            :icon-html="icons.download"
            title="保存试听音频"
            aria-label="保存试听音频"
            @click="onPreviewDownload"
          />
          <button
            type="button"
            class="btn voiceReadPreviewBtn"
            :class="[previewButtonClass]"
            :disabled="previewDisabled"
            :aria-label="isPreviewPlaying ? '停止试听' : '试听'"
            @click="onPreviewButtonClick"
          >
            {{ previewButtonLabel }}
          </button>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.voiceReadPreviewFooter {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  width: 100%;
}

.voiceReadPreviewRestoreBtn {
  flex-shrink: 0;
}

.voiceReadPreviewActionsGroup {
  display: inline-flex;
  align-items: center;
  justify-content: flex-end;
  gap: 10px;
  max-width: 100%;
  min-width: 0;
}

.voiceReadPreviewError {
  flex: 0 1 auto;
  min-width: 0;
  margin: 0;
  font-size: 12px;
  line-height: 1.45;
  color: var(--danger);
  text-align: right;
}

.voiceReadPreviewDownloadBtn {
  flex-shrink: 0;
}

.voiceReadPreviewBtn {
  flex-shrink: 0;
}

.voiceReadQuoteChecks {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: 8px 14px;
}

.voiceReadAiTokenHint a {
  margin-left: 8px;
}

.settingsStretchTextarea--multiline {
  min-height: 72px;
}

.iconOnly {
  padding: 6px;
  flex-shrink: 0;
}

.iconSvg :deep(svg) {
  width: 16px;
  height: 16px;
  display: block;
}

.iconSvg :deep(svg path) {
  fill: currentColor;
}
</style>
