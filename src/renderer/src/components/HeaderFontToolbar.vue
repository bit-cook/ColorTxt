<script setup lang="ts">
import FontPicker from "./FontPicker.vue";
import IconButton from "./IconButton.vue";
import { icons } from "../icons";

defineProps<{
  monacoFontFamily: string;
  pinnedOtherFonts?: string[];
  disabled?: boolean;
  canIncreaseFont: boolean;
  canDecreaseFont: boolean;
  canIncreaseLineHeight: boolean;
  canDecreaseLineHeight: boolean;
}>();

const emit = defineEmits<{
  setMonacoFont: [fontFamily: string];
  togglePinOtherFont: [fontName: string];
  increaseFontSize: [];
  decreaseFontSize: [];
  increaseLineHeight: [];
  decreaseLineHeight: [];
}>();
</script>

<template>
  <div class="headerFontToolbar">
    <FontPicker
      :monaco-font-family="monacoFontFamily"
      :pinned-other-fonts="pinnedOtherFonts"
      :disabled="disabled"
      @set-monaco-font="emit('setMonacoFont', $event)"
      @toggle-pin-other-font="emit('togglePinOtherFont', $event)"
    />
    <IconButton
      :icon-html="icons.fontSizeDown"
      title="减小字号"
      aria-label="减小字号"
      :disabled="disabled || !canDecreaseFont"
      @click="emit('decreaseFontSize')"
    />
    <IconButton
      :icon-html="icons.fontSizeUp"
      title="加大字号"
      aria-label="加大字号"
      :disabled="disabled || !canIncreaseFont"
      @click="emit('increaseFontSize')"
    />
    <IconButton
      :icon-html="icons.lineHeightDown"
      title="减小行高"
      aria-label="减小行高"
      :disabled="disabled || !canDecreaseLineHeight"
      @click="emit('decreaseLineHeight')"
    />
    <IconButton
      :icon-html="icons.lineHeightUp"
      title="加大行高"
      aria-label="加大行高"
      :disabled="disabled || !canIncreaseLineHeight"
      @click="emit('increaseLineHeight')"
    />
  </div>
</template>

<style scoped>
.headerFontToolbar {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}
</style>
