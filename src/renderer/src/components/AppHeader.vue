<script setup lang="ts">
import { computed } from "vue";
import IconButton from "./IconButton.vue";
import FontPicker from "./FontPicker.vue";
import MoreMenu from "./MoreMenu.vue";
import { icons } from "../icons";
import readingSvg from "../assets/reading.svg?raw";
import type { ShortcutBindingMap } from "../services/shortcutRegistry";

/** 仅路径；阅读进度由 `file.meta` 提供（菜单侧由父组件合并） */
export type RecentFileItem = { path: string; progress?: number };

const props = withDefaults(
  defineProps<{
    currentTheme: string;
    showSidebar: boolean;
    canIncreaseFont: boolean;
    canDecreaseFont: boolean;
    canIncreaseLineHeight: boolean;
    canDecreaseLineHeight: boolean;
    monacoFontFamily: string;
    /** Monaco 高级换行策略（wrappingStrategy: advanced）是否开启 */
    monacoAdvancedWrapping: boolean;
    /** Monaco 自定义语法着色是否开启 */
    monacoCustomHighlight: boolean;
    /** 是否在加载时过滤空行 */
    compressBlankLines: boolean;
    /** 是否将正文行首统一为两个全角空格（章节标题与空行除外） */
    leadIndentFullWidth: boolean;
    /** 当前是否处于全屏阅读（全屏浮动顶栏为 true，用于全屏按钮图标与提示） */
    inFullscreen?: boolean;
    /** 最近打开的文件（含阅读进度），最多 20 条 */
    recentFiles?: RecentFileItem[];
    /** 书钉是否已记录阅读位置 */
    pinActive?: boolean;
    /** 是否允许钉住（无文件、加载中或空文件时为 false） */
    canPin?: boolean;
    bookmarkActive?: boolean;
    canBookmark?: boolean;
    /** 语音朗读模式已开启 */
    voiceReadActive?: boolean;
    canVoiceRead?: boolean;
    /** 朗读模式中：禁用编辑/字体/行高/压缩空行/缩进/高级换行 */
    voiceReadHeaderLocked?: boolean;
    /** 阅读器是否处于可编辑模式 */
    readerEditMode: boolean;
    /** 是否允许进入编辑（有文件且加载完成等，由父组件计算） */
    canEnterReaderEditMode: boolean;
    /** 与快捷键面板、按键处理一致，用于「更多」菜单旁展示的快捷键 */
    shortcutBindings: ShortcutBindingMap;
    /** Markdown 文件：禁用章节正则规则（使用 # 标题） */
    chapterRulesDisabled?: boolean;
  }>(),
  {
    inFullscreen: false,
    recentFiles: () => [],
    pinActive: false,
    canPin: true,
    bookmarkActive: false,
    canBookmark: true,
    voiceReadActive: false,
    canVoiceRead: true,
    voiceReadHeaderLocked: false,
    readerEditMode: false,
    canEnterReaderEditMode: false,
    chapterRulesDisabled: false,
  },
);

const emit = defineEmits<{
  openFile: [];
  changeTheme: [theme: string];
  toggleSidebar: [];
  toggleFullscreen: [];
  setMonacoFont: [fontFamily: string];
  increaseFontSize: [];
  decreaseFontSize: [];
  increaseLineHeight: [];
  decreaseLineHeight: [];
  toggleCompressBlankLines: [];
  toggleLeadIndentFullWidth: [];
  /** 编辑模式：对当前全文执行压缩空行 */
  formatEditCompressBlankLines: [];
  /** 编辑模式：对当前全文执行行首缩进 */
  formatEditLeadIndentFullWidth: [];
  toggleMonacoAdvancedWrapping: [];
  toggleMonacoCustomHighlight: [];
  toggleFind: [];
  openChapterRules: [];
  openGithub: [];
  checkForUpdates: [];
  openShortcuts: [];
  openSettings: [];
  openColorScheme: [];
  openNewWindow: [];
  openAbout: [];
  quitApp: [];
  openRecentFile: [filePath: string];
  clearRecentFiles: [];
  pinClick: [];
  goBackFromPin: [];
  bookmarkClick: [];
  toggleReaderEdit: [];
  saveReaderFile: [];
  voiceReadToggle: [];
}>();

const vrFormatLock = computed(() => props.voiceReadHeaderLocked);
</script>

<template>
  <header class="header">
    <button class="btn primary" size="large" @click="$emit('openFile')">
      打开文件
    </button>
    <IconButton
      :icon-html="icons.edit"
      :active="readerEditMode"
      :pressed="readerEditMode"
      title="编辑模式"
      aria-label="切换编辑模式"
      :disabled="vrFormatLock || (!readerEditMode && !canEnterReaderEditMode)"
      @click="emit('toggleReaderEdit')"
    />
    <IconButton
      v-if="readerEditMode"
      :icon-html="icons.save"
      title="保存"
      aria-label="保存"
      @click="emit('saveReaderFile')"
    />
    <div class="themePicker">
      <div class="headerQuickRow">
        <IconButton
          v-if="pinActive"
          :icon-html="icons.back"
          title="回到之前记住的位置"
          aria-label="回到之前记住的位置"
          @click="emit('goBackFromPin')"
        />
        <IconButton
          :icon-html="pinActive ? icons.pinActive : icons.pin"
          :active="pinActive"
          :pressed="pinActive"
          :title="pinActive ? '清除书钉' : '书钉：记住当前的位置'"
          :aria-label="pinActive ? '清除书钉' : '书钉：记住当前的位置'"
          :disabled="!pinActive && !canPin"
          @click="emit('pinClick')"
        />
        <IconButton
          :icon-html="bookmarkActive ? icons.bookmarkActive : icons.bookmark"
          :active="bookmarkActive"
          :pressed="bookmarkActive"
          :title="bookmarkActive ? '移除书签' : '添加书签'"
          :aria-label="bookmarkActive ? '移除书签' : '添加书签'"
          :disabled="!bookmarkActive && !canBookmark"
          @click="emit('bookmarkClick')"
        />
        <span class="toolbarDivider" aria-hidden="true"></span>
        <IconButton
          class="voiceReadBtn"
          :icon-html="readingSvg"
          :active="voiceReadActive"
          :pressed="voiceReadActive"
          title="语音朗读"
          aria-label="语音朗读"
          :disabled="!voiceReadActive && !canVoiceRead"
          @click="emit('voiceReadToggle')"
        />
        <span class="toolbarDivider" aria-hidden="true"></span>
        <div class="hdrLockable">
          <FontPicker
            :monaco-font-family="monacoFontFamily"
            :disabled="vrFormatLock"
            @set-monaco-font="(fontFamily) => emit('setMonacoFont', fontFamily)"
          />
          <IconButton
            :icon-html="icons.fontSizeDown"
            title="减小字号"
            aria-label="减小字号"
            :disabled="vrFormatLock || !canDecreaseFont"
            @click="emit('decreaseFontSize')"
          />
          <IconButton
            :icon-html="icons.fontSizeUp"
            title="加大字号"
            aria-label="加大字号"
            :disabled="vrFormatLock || !canIncreaseFont"
            @click="emit('increaseFontSize')"
          />
          <IconButton
            :icon-html="icons.lineHeightDown"
            title="减小行高"
            aria-label="减小行高"
            :disabled="vrFormatLock || !canDecreaseLineHeight"
            @click="emit('decreaseLineHeight')"
          />
          <IconButton
            :icon-html="icons.lineHeightUp"
            title="加大行高"
            aria-label="加大行高"
            :disabled="vrFormatLock || !canIncreaseLineHeight"
            @click="emit('increaseLineHeight')"
          />
        </div>
        <span class="toolbarDivider" aria-hidden="true"></span>
        <template v-if="!readerEditMode">
          <IconButton
            :icon-html="icons.compress"
            :active="compressBlankLines"
            :pressed="compressBlankLines"
            title="压缩空行"
            aria-label="压缩空行"
            :disabled="vrFormatLock"
            @click="emit('toggleCompressBlankLines')"
          />
          <IconButton
            :icon-html="icons.indent"
            :active="leadIndentFullWidth"
            :pressed="leadIndentFullWidth"
            title="行首缩进"
            aria-label="行首缩进"
            :disabled="vrFormatLock"
            @click="emit('toggleLeadIndentFullWidth')"
          />
        </template>
        <template v-else>
          <IconButton
            :icon-html="icons.compress"
            title="格式化：压缩空行"
            aria-label="格式化：压缩空行"
            :disabled="vrFormatLock"
            @click="emit('formatEditCompressBlankLines')"
          />
          <IconButton
            :icon-html="icons.indent"
            title="格式化：行首缩进"
            aria-label="格式化：行首缩进"
            :disabled="vrFormatLock"
            @click="emit('formatEditLeadIndentFullWidth')"
          />
        </template>
      </div>
      <IconButton
        :icon-html="icons.advancedWrapping"
        :active="monacoAdvancedWrapping"
        :pressed="monacoAdvancedWrapping"
        title="高级换行策略
开启可以优化换行效果，但对性能影响较大。"
        aria-label="高级换行策略"
        :disabled="vrFormatLock"
        @click="$emit('toggleMonacoAdvancedWrapping')"
      />
      <IconButton
        :icon-html="icons.palette"
        multicolor
        :active="monacoCustomHighlight"
        :pressed="monacoCustomHighlight"
        title="内容上色"
        @click="$emit('toggleMonacoCustomHighlight')"
      />
      <span class="toolbarDivider" aria-hidden="true"></span>
      <IconButton
        :icon-html="icons.regExp"
        :disabled="chapterRulesDisabled || vrFormatLock"
        :title="
          chapterRulesDisabled
            ? 'Markdown 文件使用 # 标题识别章节'
            : '章节匹配规则'
        "
        @click="!chapterRulesDisabled && $emit('openChapterRules')"
      />
      <IconButton
        :icon-html="currentTheme === 'vs' ? icons.light : icons.dark"
        :title="
          currentTheme === 'vs'
            ? '当前亮色，点击切换暗色'
            : '当前暗色，点击切换亮色'
        "
        @click="$emit('changeTheme', currentTheme === 'vs' ? 'vs-dark' : 'vs')"
      />
      <IconButton
        v-if="!inFullscreen"
        :icon-html="icons.sidebar"
        :active="showSidebar"
        :pressed="showSidebar"
        title="切换侧边栏"
        @click="$emit('toggleSidebar')"
      />
      <IconButton
        :icon-html="
          inFullscreen ? icons.leaveFullscreen : icons.enterFullscreen
        "
        :title="inFullscreen ? '退出全屏' : '全屏阅读'"
        @click="$emit('toggleFullscreen')"
      />
      <div class="moreMenuWrap">
        <MoreMenu
          :recent-files="recentFiles"
          :shortcut-bindings="shortcutBindings"
          @toggle-find="emit('toggleFind')"
          @open-github="emit('openGithub')"
          @check-for-updates="emit('checkForUpdates')"
          @open-shortcuts="emit('openShortcuts')"
          @open-settings="emit('openSettings')"
          @open-color-scheme="emit('openColorScheme')"
          @open-new-window="emit('openNewWindow')"
          @open-about="emit('openAbout')"
          @quit-app="emit('quitApp')"
          @open-recent-file="(filePath) => emit('openRecentFile', filePath)"
          @clear-recent-files="emit('clearRecentFiles')"
        />
      </div>
    </div>
  </header>
</template>

<style scoped>
.header {
  background: var(--bg);
  border-bottom: 1px solid var(--border);
  display: flex;
  flex-shrink: 0;
  gap: 8px;
  align-items: center;
  justify-content: space-between;
  padding: 10px;
  min-height: 0;
  overflow: visible;
}

.themePicker {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  white-space: nowrap;
  flex-shrink: 0;
  margin-left: auto;
}

.headerQuickRow {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.toolbarDivider {
  width: 1px;
  height: 22px;
  background: var(--border);
  flex-shrink: 0;
  /* margin: 0 10px; */
}

.moreMenuWrapLocked {
  pointer-events: none;
  opacity: 0.45;
}

.hdrLockable {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.voiceReadBtn.iconBtn.active {
  background: var(--primary);
}

.voiceReadBtn.iconBtn.active:hover {
  background: var(--primary-hover);
}

.voiceReadBtn.iconBtn.active :deep(.icon) {
  color: #ffffff;
}
</style>
