<script setup lang="ts">
import ConvertMenu from "./ConvertMenu.vue";
import IconButton from "./IconButton.vue";
import { icons } from "../icons";
import type {
  TextConvertWidthMode,
  TextConvertZhMode,
} from "@shared/textConvertTypes";

defineProps<{
  readerEditMode: boolean;
  disabled?: boolean;
  textConvertZh?: TextConvertZhMode;
  textConvertLetter?: TextConvertWidthMode;
  textConvertDigit?: TextConvertWidthMode;
  compressBlankLines: boolean;
  leadIndentFullWidth: boolean;
  monacoAdvancedWrapping: boolean;
  monacoCustomHighlight: boolean;
}>();

const emit = defineEmits<{
  selectTextConvertZhRead: [mode: TextConvertZhMode];
  selectTextConvertLetterRead: [mode: TextConvertWidthMode];
  selectTextConvertDigitRead: [mode: TextConvertWidthMode];
  applyTextConvertZhEdit: [mode: Exclude<TextConvertZhMode, "off">];
  applyTextConvertLetterEdit: [mode: Exclude<TextConvertWidthMode, "off">];
  applyTextConvertDigitEdit: [mode: Exclude<TextConvertWidthMode, "off">];
  toggleCompressBlankLines: [];
  toggleLeadIndentFullWidth: [];
  formatEditCompressBlankLines: [];
  formatEditLeadIndentFullWidth: [];
  toggleMonacoAdvancedWrapping: [];
  toggleMonacoCustomHighlight: [];
}>();
</script>

<template>
  <div class="headerFormatToolbar">
    <ConvertMenu
      :reader-edit-mode="readerEditMode"
      :disabled="disabled"
      :text-convert-zh="textConvertZh"
      :text-convert-letter="textConvertLetter"
      :text-convert-digit="textConvertDigit"
      @select-zh-read="emit('selectTextConvertZhRead', $event)"
      @select-letter-read="emit('selectTextConvertLetterRead', $event)"
      @select-digit-read="emit('selectTextConvertDigitRead', $event)"
      @apply-zh-edit="emit('applyTextConvertZhEdit', $event)"
      @apply-letter-edit="emit('applyTextConvertLetterEdit', $event)"
      @apply-digit-edit="emit('applyTextConvertDigitEdit', $event)"
    />
    <template v-if="!readerEditMode">
      <IconButton
        :icon-html="icons.compress"
        :active="compressBlankLines"
        :pressed="compressBlankLines"
        title="压缩空行"
        aria-label="压缩空行"
        :disabled="disabled"
        @click="emit('toggleCompressBlankLines')"
      />
      <IconButton
        :icon-html="icons.indent"
        :active="leadIndentFullWidth"
        :pressed="leadIndentFullWidth"
        title="行首缩进"
        aria-label="行首缩进"
        :disabled="disabled"
        @click="emit('toggleLeadIndentFullWidth')"
      />
    </template>
    <template v-else>
      <IconButton
        :icon-html="icons.compress"
        primary
        title="格式化：压缩空行"
        aria-label="格式化：压缩空行"
        :disabled="disabled"
        @click="emit('formatEditCompressBlankLines')"
      />
      <IconButton
        :icon-html="icons.indent"
        primary
        title="格式化：行首缩进"
        aria-label="格式化：行首缩进"
        :disabled="disabled"
        @click="emit('formatEditLeadIndentFullWidth')"
      />
    </template>
    <IconButton
      :icon-html="icons.advancedWrapping"
      :active="monacoAdvancedWrapping"
      :pressed="monacoAdvancedWrapping"
      title="高级换行策略
开启可以优化换行效果，但对性能影响较大。"
      aria-label="高级换行策略"
      :disabled="disabled"
      @click="emit('toggleMonacoAdvancedWrapping')"
    />
    <IconButton
      :icon-html="icons.palette"
      multicolor
      :active="monacoCustomHighlight"
      :pressed="monacoCustomHighlight"
      title="内容上色"
      @click="emit('toggleMonacoCustomHighlight')"
    />
  </div>
</template>

<style scoped>
.headerFormatToolbar {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}
</style>
