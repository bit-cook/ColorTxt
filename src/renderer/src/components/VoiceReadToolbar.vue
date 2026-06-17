<script setup lang="ts">
import { computed, ref } from "vue";
import IconButton from "./IconButton.vue";
import RangeSlider from "./RangeSlider.vue";
import playSvg from "../assets/play.svg?raw";
import pauseSvg from "../assets/pause.svg?raw";
import prevSvg from "../assets/prev.svg?raw";
import nextSvg from "../assets/next.svg?raw";
import refreshSvg from "../assets/refresh.svg?raw";
import stopSvg from "../assets/stop.svg?raw";
import speedSvg from "../assets/speed.svg?raw";
import {
  voiceReadEngineSupportsPitch,
  voiceReadEngineSupportsRate,
  type VoiceReadEngineId,
} from "../constants/voiceRead";
import { icons } from "../icons";

type ToolbarLayer = "playback" | "settings";

const props = defineProps<{
  visible: boolean;
  mode: "off" | "playing" | "paused";
  synthesizing?: boolean;
  synthesizingPhase?: "ai" | "tts" | null;
  toolbarRate: number;
  toolbarPitch: number;
  engine: VoiceReadEngineId;
  canPrevLine?: boolean;
  canNextLine?: boolean;
}>();

const emit = defineEmits<{
  "update:toolbarRate": [v: number];
  "update:toolbarPitch": [v: number];
  togglePlayPause: [];
  prevLine: [];
  nextLine: [];
  regenerate: [];
  stop: [];
}>();

const toolbarLayer = ref<ToolbarLayer>("playback");

const rateDisabled = computed(() => !voiceReadEngineSupportsRate(props.engine));
const pitchDisabled = computed(
  () => !voiceReadEngineSupportsPitch(props.engine),
);

const toolbarLocked = computed(() => Boolean(props.synthesizing));

const playIcon = computed(() => {
  if (props.synthesizing) {
    return `<span class="aiThinkingPulse">${icons.thinkingPulse}</span>`;
  }
  return props.mode === "playing" ? pauseSvg : playSvg;
});
const playLabel = computed(() => {
  if (props.synthesizing) {
    return props.synthesizingPhase === "ai" ? "AI 识别中" : "合成中";
  }
  return props.mode === "playing" ? "暂停" : "播放";
});

const showSettingsLayer = computed(() => toolbarLayer.value === "settings");

const layerToggleLabel = computed(() =>
  showSettingsLayer.value ? "切换到朗读控制" : "切换到朗读设置",
);

function toggleToolbarLayer() {
  toolbarLayer.value = showSettingsLayer.value ? "playback" : "settings";
}
</script>

<template>
  <div
    v-if="visible"
    class="voiceReadToolbar voiceReadToolbarLayer"
    role="toolbar"
    aria-label="语音朗读工具栏"
  >
    <div class="pill">
      <div class="barCore">
        <div class="layersViewport">
          <div
            class="layersTrack"
            :class="{ 'layersTrack--settings': showSettingsLayer }"
          >
            <!-- 朗读控制 -->
            <div
              class="layer layerPlayback"
              :class="{ 'layer--hidden': showSettingsLayer }"
            >
              <div class="layerPlaybackInner">
                <IconButton
                  class="layerBtn layerBtn--stagger"
                  :icon-html="prevSvg"
                  title="上一行"
                  aria-label="上一行"
                  :disabled="toolbarLocked || !canPrevLine"
                  @click="emit('prevLine')"
                />
                <IconButton
                  class="layerBtn layerBtn--stagger"
                  :icon-html="refreshSvg"
                  title="重新合成"
                  aria-label="重新合成"
                  :disabled="toolbarLocked"
                  @click="emit('regenerate')"
                />
                <div class="playSpacer" aria-hidden="true" />
                <IconButton
                  class="layerBtn layerBtn--stagger layerBtn--stop"
                  :icon-html="stopSvg"
                  title="停止"
                  aria-label="停止"
                  :disabled="toolbarLocked"
                  @click="emit('stop')"
                />
                <IconButton
                  class="layerBtn layerBtn--stagger"
                  :icon-html="nextSvg"
                  title="下一行"
                  aria-label="下一行"
                  :disabled="toolbarLocked || !canNextLine"
                  @click="emit('nextLine')"
                />
              </div>
            </div>

            <!-- 朗读设置 -->
            <div
              class="layer layerSettings"
              :class="{ 'layer--hidden': !showSettingsLayer }"
            >
              <div class="layerSettingsInner">
                <div class="side side--stagger">
                  <span class="lbl">语速</span>
                  <RangeSlider
                    class="rateSlider"
                    :model-value="toolbarRate"
                    :min="0.5"
                    :max="2"
                    :step="0.05"
                    :disabled="toolbarLocked || rateDisabled"
                    :show-percent="false"
                    aria-label="语速"
                    @update:model-value="emit('update:toolbarRate', $event)"
                  />
                </div>
                <div class="playSpacer" aria-hidden="true" />
                <div class="side side--stagger">
                  <span class="lbl">音调</span>
                  <RangeSlider
                    class="pitchSlider"
                    :model-value="toolbarPitch"
                    :min="0.5"
                    :max="2"
                    :step="0.05"
                    :disabled="toolbarLocked || pitchDisabled"
                    :show-percent="false"
                    aria-label="音调"
                    @update:model-value="emit('update:toolbarPitch', $event)"
                  />
                </div>
              </div>
            </div>
          </div>
        </div>

        <IconButton
          class="playPauseBtn"
          :class="{
            'playPauseBtn--play': !synthesizing && mode !== 'playing',
            'playPauseBtn--pause': !synthesizing && mode === 'playing',
            'playPauseBtn--synth': synthesizing,
          }"
          :icon-html="playIcon"
          :title="playLabel"
          :aria-label="playLabel"
          :disabled="toolbarLocked"
          @click="emit('togglePlayPause')"
        />

        <button
          type="button"
          class="layerToggle"
          :title="layerToggleLabel"
          :aria-label="layerToggleLabel"
          :disabled="toolbarLocked"
          @click="toggleToolbarLayer"
        >
          <span class="layerToggleIcon" v-html="speedSvg" />
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.voiceReadToolbar {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 12px;
  display: flex;
  justify-content: center;
  pointer-events: none;
}

.pill {
  position: relative;
  pointer-events: auto;
  max-width: min(560px, calc(100% - 24px));
  padding-right: 20px;
}

.barCore {
  position: relative;
  display: inline-block;
  max-width: 100%;
}

.layersViewport {
  overflow: hidden;
  height: 36px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--bg) 95%, transparent);
  border: 1px solid var(--border);
  box-shadow: 0 4px 18px color-mix(in srgb, #000 18%, transparent);
}

.layersTrack {
  display: flex;
  flex-direction: column;
  transition: transform 0.34s cubic-bezier(0.4, 0, 0.2, 1);
  will-change: transform;
}

.layersTrack--settings {
  transform: translateY(-50%);
}

.layer {
  height: 36px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: opacity 0.28s ease;
}

.layer--hidden {
  opacity: 0.35;
  pointer-events: none;
}

.layerPlaybackInner,
.layerSettingsInner {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  padding: 0 12px;
  gap: 20px;
}

.layerSettingsInner {
  gap: 12px;
  padding: 0 24px;
}

.playSpacer {
  flex-shrink: 0;
  width: 52px;
}

.side {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1;
  min-width: 0;
}

.lbl {
  font-size: 12px;
  color: var(--fg-muted, var(--fg));
  flex-shrink: 0;
}

.layerBtn--stagger {
  transition:
    transform 0.32s cubic-bezier(0.4, 0, 0.2, 1),
    opacity 0.28s ease;
}

.layersTrack--settings .layerPlayback .layerBtn--stagger:nth-child(1) {
  transition-delay: 0ms;
  transform: translateY(-10px);
  opacity: 0;
}
.layersTrack--settings .layerPlayback .layerBtn--stagger:nth-child(2) {
  transition-delay: 40ms;
  transform: translateY(-10px);
  opacity: 0;
}
.layersTrack--settings .layerPlayback .layerBtn--stagger:nth-child(4) {
  transition-delay: 80ms;
  transform: translateY(-10px);
  opacity: 0;
}
.layersTrack--settings .layerPlayback .layerBtn--stagger:nth-child(5) {
  transition-delay: 120ms;
  transform: translateY(-10px);
  opacity: 0;
}

.layerPlayback .layerBtn--stagger:nth-child(1) {
  transition-delay: 0ms;
}
.layerPlayback .layerBtn--stagger:nth-child(2) {
  transition-delay: 40ms;
}
.layerPlayback .layerBtn--stagger:nth-child(4) {
  transition-delay: 80ms;
}
.layerPlayback .layerBtn--stagger:nth-child(5) {
  transition-delay: 120ms;
}

.side--stagger {
  transition:
    transform 0.32s cubic-bezier(0.4, 0, 0.2, 1),
    opacity 0.28s ease;
}

.layersTrack--settings .layerSettings .side--stagger:first-child {
  transition-delay: 60ms;
  transform: translateY(0);
  opacity: 1;
}
.layersTrack--settings .layerSettings .side--stagger:last-child {
  transition-delay: 120ms;
  transform: translateY(0);
  opacity: 1;
}

.layersTrack:not(.layersTrack--settings)
  .layerSettings
  .side--stagger:first-child {
  transition-delay: 0ms;
  transform: translateY(10px);
  opacity: 0;
}
.layersTrack:not(.layersTrack--settings)
  .layerSettings
  .side--stagger:last-child {
  transition-delay: 60ms;
  transform: translateY(10px);
  opacity: 0;
}

.playPauseBtn.iconBtn {
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  z-index: 3;
  width: 48px;
  height: 48px;
  border-radius: 50%;
  box-shadow: 0 2px 10px color-mix(in srgb, #000 14%, transparent);
  /* transition: transform 0.16s ease;
  transform-origin: center center; */
}

/* .playPauseBtn.iconBtn:hover {
  transform: translate(-50%, -50%) scale(1.05);
} */

.playPauseBtn.iconBtn :deep(.icon) {
  width: 24px;
  height: 24px;
  color: #ffffff;
}

.playPauseBtn.iconBtn :deep(.icon svg) {
  width: 24px;
  height: 24px;
}

.playPauseBtn.iconBtn.playPauseBtn--pause {
  background: var(--danger);
}

.playPauseBtn.iconBtn.playPauseBtn--play {
  background: var(--primary);
}

.playPauseBtn.iconBtn.playPauseBtn--pause:not(:disabled):hover {
  background: var(--danger-hover);
}

.playPauseBtn.iconBtn.playPauseBtn--play:not(:disabled):hover {
  background: var(--primary-hover);
}

.playPauseBtn.iconBtn.playPauseBtn--synth {
  background: var(--warning);
  cursor: default;
}

.playPauseBtn.iconBtn.playPauseBtn--synth:not(:disabled):hover {
  background: var(--warning);
}

.playPauseBtn.iconBtn.playPauseBtn--synth:disabled {
  opacity: 1;
}

.playPauseBtn.iconBtn.playPauseBtn--synth :deep(.icon) {
  color: #ffffff;
}

.playPauseBtn.iconBtn.playPauseBtn--synth :deep(.aiThinkingPulse) {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  animation: aiThinkingPulseBreathe 1.25s ease-in-out infinite;
}

.playPauseBtn.iconBtn.playPauseBtn--synth :deep(.aiThinkingPulse svg) {
  color: #ffffff;
}

@keyframes aiThinkingPulseBreathe {
  0%,
  100% {
    opacity: 0.35;
    transform: scale(0.92);
  }
  50% {
    opacity: 1;
    transform: scale(1);
  }
}

.layerToggle:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.layerBtn.iconBtn {
  background: transparent !important;
}

.layerBtn.iconBtn :deep(.icon) {
  width: 16px;
  height: 16px;
  color: var(--icon-btn-fg);
  transition: color 0.16s ease;
}

.layerBtn.iconBtn:not(:disabled):hover :deep(.icon) {
  color: var(--primary);
}

.layerBtn.iconBtn.layerBtn--stop:not(:disabled):hover :deep(.icon) {
  color: var(--danger);
}

.layerToggle {
  position: absolute;
  right: 0;
  top: 50%;
  z-index: 4;
  width: 24px;
  height: 24px;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: color-mix(in srgb, var(--primary) 98%, transparent);
  box-shadow: 0 2px 10px color-mix(in srgb, #000 14%, transparent);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transform: translate(50%, -50%);
  transition:
    background 0.16s ease,
    box-shadow 0.16s ease;
}

.layerToggle:not(:disabled):hover {
  background: color-mix(
    in srgb,
    var(--primary-hover) 98%,
    var(--icon-btn-bg-hover)
  );
  box-shadow: 0 3px 12px color-mix(in srgb, #000 18%, transparent);
}

.layerToggleIcon {
  width: 16px;
  height: 16px;
  display: inline-flex;
  color: #ffffff;
}

.layerToggleIcon :deep(svg) {
  width: 16px;
  height: 16px;
  display: block;
}

.layerToggleIcon :deep(path) {
  fill: currentColor;
}

.rateSlider,
.pitchSlider {
  width: 50px;
}
</style>
