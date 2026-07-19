<script setup lang="ts">
import { ref, watch } from "vue";
import AppModal from "../../components/AppModal.vue";
import SettingsReadingPanel from "../../components/SettingsReadingPanel.vue";
import FindBookSettingsTabBar, {
  type FindBookSettingsTabId,
} from "./FindBookSettingsTabBar.vue";
import FindBookSettingsDownloadPanel from "./FindBookSettingsDownloadPanel.vue";
import FindBookSettingsEditPanel from "./FindBookSettingsEditPanel.vue";
import FindBookSettingsProxyPanel from "./FindBookSettingsProxyPanel.vue";
import {
  clampFindBookReaderLineHeight,
  defaultTimedScrollIntervalMs,
  defaultTimedScrollRange,
} from "../services/findBookSettingsStore";
import {
  defaultCompressBlankKeepOneBlank,
  defaultFullscreenReaderWidthPercent,
  defaultFullscreenShowSystemTime,
  defaultMonacoSmoothScrolling,
  defaultReaderEditMinimap,
  defaultReaderEditShowLineNumbers,
  defaultReaderFontSize,
  defaultReaderLineHeightMultiple,
  defaultStickyChapterTitleEnabled,
  defaultTxtrDelimitedMatchCrossLine,
} from "../../constants/appUi";
import { mergeTimedScrollSettings } from "../../constants/timedScroll";
import type { TimedScrollRange } from "../../constants/timedScroll";
import {
  defaultPomodoroEnabled,
  defaultPomodoroFocusMinutes,
  defaultPomodoroLongBreakMinutes,
  defaultPomodoroShortBreakMinutes,
  mergePomodoroSettings,
} from "../../constants/pomodoro";
import { useFindBookSettings } from "../composables/useFindBookSettings";
import {
  DEFAULT_FIND_BOOK_DOWNLOAD_AFTER_ACTION,
  DEFAULT_FIND_BOOK_DOWNLOAD_CATEGORY,
  DEFAULT_FIND_BOOK_PROXY_SETTINGS,
  defaultFindBookChapterNavToolbarEnabled,
  type FindBookDownloadAfterAction,
  type FindBookProxyType,
} from "../constants/findBookSettings";
import {
  resolveDefaultBookSourceChapterCacheDirSync,
  resolveDefaultBookSourceDownloadDirSync,
} from "../../utils/defaultCacheDirs";
import { confirmClearAllChapterCache } from "../services/clearBookChapterCache";
import "../../styles/settingsPanel.css";

const modelValue = defineModel<boolean>({ default: false });

const props = withDefaults(
  defineProps<{
    initialTab?: FindBookSettingsTabId;
  }>(),
  { initialTab: "download" },
);

const emit = defineEmits<{
  chapterCacheCleared: [];
}>();

const fb = useFindBookSettings();
const activeTab = ref<FindBookSettingsTabId>("download");

const draftCacheDir = ref("");
const draftDownloadDir = ref("");
const draftDownloadAfterAction = ref<FindBookDownloadAfterAction>(
  DEFAULT_FIND_BOOK_DOWNLOAD_AFTER_ACTION,
);
const draftDownloadAddToMainFileList = ref(true);
const draftDownloadDefaultCategory = ref(DEFAULT_FIND_BOOK_DOWNLOAD_CATEGORY);
const draftProxyEnabled = ref(DEFAULT_FIND_BOOK_PROXY_SETTINGS.enabled);
const draftProxyType = ref<FindBookProxyType>(DEFAULT_FIND_BOOK_PROXY_SETTINGS.type);
const draftProxyHost = ref(DEFAULT_FIND_BOOK_PROXY_SETTINGS.host);
const draftProxyPort = ref(DEFAULT_FIND_BOOK_PROXY_SETTINGS.port);
const draftProxyUsername = ref(DEFAULT_FIND_BOOK_PROXY_SETTINGS.username);
const draftProxyPassword = ref(DEFAULT_FIND_BOOK_PROXY_SETTINGS.password);
const draftFontSize = ref(defaultReaderFontSize);
const draftLineHeightMultiple = ref(defaultReaderLineHeightMultiple);
const draftMonacoSmoothScrolling = ref(defaultMonacoSmoothScrolling);
const draftStickyChapterTitleEnabled = ref(defaultStickyChapterTitleEnabled);
const draftChapterNavToolbarEnabled = ref(defaultFindBookChapterNavToolbarEnabled);
const draftReaderEditShowLineNumbers = ref(defaultReaderEditShowLineNumbers);
const draftReaderEditMinimap = ref(defaultReaderEditMinimap);
const draftCompressBlankKeepOneBlank = ref(defaultCompressBlankKeepOneBlank);
const draftTxtrDelimitedMatchCrossLine = ref(defaultTxtrDelimitedMatchCrossLine);
const draftFullscreenReaderWidthPercent = ref(defaultFullscreenReaderWidthPercent);
const draftFullscreenShowSystemTime = ref(defaultFullscreenShowSystemTime);
const draftPomodoroEnabled = ref(defaultPomodoroEnabled);
const draftPomodoroFocusMinutes = ref(defaultPomodoroFocusMinutes);
const draftPomodoroShortBreakMinutes = ref(defaultPomodoroShortBreakMinutes);
const draftPomodoroLongBreakMinutes = ref(defaultPomodoroLongBreakMinutes);
const draftTimedScrollRange = ref<TimedScrollRange>(defaultTimedScrollRange);
const draftTimedScrollIntervalMs = ref(defaultTimedScrollIntervalMs);

function syncDraftFromStore() {
  draftCacheDir.value = fb.cacheDir.value;
  draftDownloadDir.value = fb.downloadDir.value;
  draftDownloadAfterAction.value = fb.downloadAfterAction.value;
  draftDownloadAddToMainFileList.value = fb.downloadAddToMainFileList.value;
  draftDownloadDefaultCategory.value = fb.downloadDefaultCategory.value;
  draftProxyEnabled.value = fb.proxy.value.enabled;
  draftProxyType.value = fb.proxy.value.type;
  draftProxyHost.value = fb.proxy.value.host;
  draftProxyPort.value = fb.proxy.value.port;
  draftProxyUsername.value = fb.proxy.value.username;
  draftProxyPassword.value = fb.proxy.value.password;
  draftFontSize.value = fb.readerFontSize.value;
  draftLineHeightMultiple.value = clampFindBookReaderLineHeight(
    fb.readerFontSize.value,
    fb.readerLineHeightMultiple.value,
  );
  draftMonacoSmoothScrolling.value = fb.monacoSmoothScrolling.value;
  draftStickyChapterTitleEnabled.value = fb.stickyChapterTitleEnabled.value;
  draftChapterNavToolbarEnabled.value = fb.chapterNavToolbarEnabled.value;
  draftReaderEditShowLineNumbers.value = fb.readerEditShowLineNumbers.value;
  draftReaderEditMinimap.value = fb.readerEditMinimap.value;
  draftCompressBlankKeepOneBlank.value = fb.compressBlankKeepOneBlank.value;
  draftTxtrDelimitedMatchCrossLine.value = fb.txtrDelimitedMatchCrossLine.value;
  draftFullscreenReaderWidthPercent.value = fb.fullscreenReaderWidthPercent.value;
  draftFullscreenShowSystemTime.value = fb.fullscreenShowSystemTime.value;
  const pomodoroMerged = mergePomodoroSettings(fb.pomodoroSettings.value);
  draftPomodoroEnabled.value = pomodoroMerged.enabled;
  draftPomodoroFocusMinutes.value = pomodoroMerged.focusMinutes;
  draftPomodoroShortBreakMinutes.value = pomodoroMerged.shortBreakMinutes;
  draftPomodoroLongBreakMinutes.value = pomodoroMerged.longBreakMinutes;
  const timedScrollMerged = mergeTimedScrollSettings(fb.timedScrollSettings.value);
  draftTimedScrollRange.value = timedScrollMerged.range;
  draftTimedScrollIntervalMs.value = timedScrollMerged.intervalMs;
}

function resetDownloadDraft() {
  draftCacheDir.value = resolveDefaultBookSourceChapterCacheDirSync();
  draftDownloadDir.value = resolveDefaultBookSourceDownloadDirSync();
  draftDownloadAfterAction.value = DEFAULT_FIND_BOOK_DOWNLOAD_AFTER_ACTION;
  draftDownloadAddToMainFileList.value = true;
  draftDownloadDefaultCategory.value = DEFAULT_FIND_BOOK_DOWNLOAD_CATEGORY;
}

function resetProxyDraft() {
  draftProxyEnabled.value = DEFAULT_FIND_BOOK_PROXY_SETTINGS.enabled;
  draftProxyType.value = DEFAULT_FIND_BOOK_PROXY_SETTINGS.type;
  draftProxyHost.value = DEFAULT_FIND_BOOK_PROXY_SETTINGS.host;
  draftProxyPort.value = DEFAULT_FIND_BOOK_PROXY_SETTINGS.port;
  draftProxyUsername.value = DEFAULT_FIND_BOOK_PROXY_SETTINGS.username;
  draftProxyPassword.value = DEFAULT_FIND_BOOK_PROXY_SETTINGS.password;
}

function resetReadingDraft() {
  draftFontSize.value = defaultReaderFontSize;
  draftLineHeightMultiple.value = defaultReaderLineHeightMultiple;
  draftMonacoSmoothScrolling.value = defaultMonacoSmoothScrolling;
  draftStickyChapterTitleEnabled.value = defaultStickyChapterTitleEnabled;
  draftChapterNavToolbarEnabled.value = defaultFindBookChapterNavToolbarEnabled;
  draftCompressBlankKeepOneBlank.value = defaultCompressBlankKeepOneBlank;
  draftTxtrDelimitedMatchCrossLine.value = defaultTxtrDelimitedMatchCrossLine;
  draftFullscreenReaderWidthPercent.value = defaultFullscreenReaderWidthPercent;
  draftFullscreenShowSystemTime.value = defaultFullscreenShowSystemTime;
  draftPomodoroEnabled.value = defaultPomodoroEnabled;
  draftPomodoroFocusMinutes.value = defaultPomodoroFocusMinutes;
  draftPomodoroShortBreakMinutes.value = defaultPomodoroShortBreakMinutes;
  draftPomodoroLongBreakMinutes.value = defaultPomodoroLongBreakMinutes;
  draftTimedScrollRange.value = defaultTimedScrollRange;
  draftTimedScrollIntervalMs.value = defaultTimedScrollIntervalMs;
}

function resetEditDraft() {
  draftReaderEditShowLineNumbers.value = defaultReaderEditShowLineNumbers;
  draftReaderEditMinimap.value = defaultReaderEditMinimap;
}

function onResetCurrentTab() {
  if (activeTab.value === "download") resetDownloadDraft();
  else if (activeTab.value === "edit") resetEditDraft();
  else if (activeTab.value === "proxy") resetProxyDraft();
  else resetReadingDraft();
}

function onCancel() {
  modelValue.value = false;
}

function onConfirm() {
  fb.cacheDir.value = draftCacheDir.value.trim();
  fb.downloadDir.value = draftDownloadDir.value.trim();
  fb.downloadAfterAction.value = draftDownloadAfterAction.value;
  fb.downloadAddToMainFileList.value = draftDownloadAddToMainFileList.value;
  fb.downloadDefaultCategory.value = draftDownloadDefaultCategory.value.trim();
  fb.proxy.value = {
    enabled: draftProxyEnabled.value,
    type: draftProxyType.value,
    host: draftProxyHost.value.trim(),
    port: draftProxyPort.value.trim(),
    username: draftProxyUsername.value.trim(),
    password: draftProxyPassword.value,
  };
  fb.readerFontSize.value = draftFontSize.value;
  fb.readerLineHeightMultiple.value = clampFindBookReaderLineHeight(
    draftFontSize.value,
    draftLineHeightMultiple.value,
  );
  fb.monacoSmoothScrolling.value = draftMonacoSmoothScrolling.value;
  fb.stickyChapterTitleEnabled.value = draftStickyChapterTitleEnabled.value;
  fb.chapterNavToolbarEnabled.value = draftChapterNavToolbarEnabled.value;
  fb.readerEditShowLineNumbers.value = draftReaderEditShowLineNumbers.value;
  fb.readerEditMinimap.value = draftReaderEditMinimap.value;
  fb.compressBlankKeepOneBlank.value = draftCompressBlankKeepOneBlank.value;
  fb.txtrDelimitedMatchCrossLine.value = draftTxtrDelimitedMatchCrossLine.value;
  fb.fullscreenReaderWidthPercent.value = draftFullscreenReaderWidthPercent.value;
  fb.fullscreenShowSystemTime.value = draftFullscreenShowSystemTime.value;
  fb.pomodoroSettings.value = mergePomodoroSettings({
    enabled: draftPomodoroEnabled.value,
    focusMinutes: draftPomodoroFocusMinutes.value,
    shortBreakMinutes: draftPomodoroShortBreakMinutes.value,
    longBreakMinutes: draftPomodoroLongBreakMinutes.value,
  });
  fb.timedScrollSettings.value = mergeTimedScrollSettings({
    range: draftTimedScrollRange.value,
    intervalMs: draftTimedScrollIntervalMs.value,
  });
  fb.persistAll();
  modelValue.value = false;
}

async function onClearCache() {
  const cleared = await confirmClearAllChapterCache({
    cacheDir: draftCacheDir.value.trim() || undefined,
  });
  if (cleared) emit("chapterCacheCleared");
}

watch(
  () => modelValue.value,
  (open) => {
    if (!open) return;
    activeTab.value = props.initialTab;
    syncDraftFromStore();
  },
);

watch(
  () => props.initialTab,
  (tab) => {
    if (modelValue.value) activeTab.value = tab;
  },
);

watch(draftFontSize, (size) => {
  draftLineHeightMultiple.value = clampFindBookReaderLineHeight(
    size,
    draftLineHeightMultiple.value,
  );
});
</script>

<template>
  <AppModal
    v-model="modelValue"
    title="设置"
    max-width="700px"
    panel-class="settingsPanelModal"
    :mask-closable="false"
    :esc-closable="true"
    :body-scroll="false"
  >
    <div class="settingsLayout">
      <FindBookSettingsTabBar v-model:active-tab="activeTab" />

      <div class="settingsScroll">
        <div class="settingsTabScroller">
          <div class="settingsTabContent">
            <FindBookSettingsDownloadPanel
              v-show="activeTab === 'download'"
              v-model:draft-cache-dir="draftCacheDir"
              v-model:draft-download-dir="draftDownloadDir"
              v-model:draft-download-after-action="draftDownloadAfterAction"
              v-model:draft-download-add-to-main-file-list="
                draftDownloadAddToMainFileList
              "
              v-model:draft-download-default-category="draftDownloadDefaultCategory"
              @clear-cache="onClearCache"
            />

            <SettingsReadingPanel
              v-show="activeTab === 'reading'"
              v-model:draft-font-size="draftFontSize"
              v-model:draft-line-height-multiple="draftLineHeightMultiple"
              v-model:draft-monaco-smooth-scrolling="draftMonacoSmoothScrolling"
              v-model:draft-sticky-chapter-title-enabled="draftStickyChapterTitleEnabled"
              v-model:draft-chapter-nav-toolbar-enabled="draftChapterNavToolbarEnabled"
              v-model:draft-compress-blank-keep-one-blank="draftCompressBlankKeepOneBlank"
              v-model:draft-txtr-delimited-match-cross-line="draftTxtrDelimitedMatchCrossLine"
              v-model:draft-fullscreen-reader-width-percent="draftFullscreenReaderWidthPercent"
              v-model:draft-fullscreen-show-system-time="draftFullscreenShowSystemTime"
              v-model:draft-pomodoro-enabled="draftPomodoroEnabled"
              v-model:draft-pomodoro-focus-minutes="draftPomodoroFocusMinutes"
              v-model:draft-pomodoro-short-break-minutes="draftPomodoroShortBreakMinutes"
              v-model:draft-pomodoro-long-break-minutes="draftPomodoroLongBreakMinutes"
              v-model:draft-timed-scroll-range="draftTimedScrollRange"
              v-model:draft-timed-scroll-interval-ms="draftTimedScrollIntervalMs"
              :monaco-custom-highlight="fb.monacoCustomHighlight.value"
            />

            <FindBookSettingsEditPanel
              v-show="activeTab === 'edit'"
              v-model:draft-reader-edit-show-line-numbers="
                draftReaderEditShowLineNumbers
              "
              v-model:draft-reader-edit-minimap="draftReaderEditMinimap"
            />

            <FindBookSettingsProxyPanel
              v-show="activeTab === 'proxy'"
              v-model:draft-proxy-enabled="draftProxyEnabled"
              v-model:draft-proxy-type="draftProxyType"
              v-model:draft-proxy-host="draftProxyHost"
              v-model:draft-proxy-port="draftProxyPort"
              v-model:draft-proxy-username="draftProxyUsername"
              v-model:draft-proxy-password="draftProxyPassword"
            />
          </div>
        </div>
      </div>
    </div>

    <template #footer>
      <div class="settingsFooter">
        <div class="settingsFooterStart">
          <button
            class="btn"
            type="button"
            size="large"
            @click="onResetCurrentTab"
          >
            重置当前页
          </button>
        </div>
        <div class="settingsFooterActions">
          <button class="btn" type="button" size="large" @click="onCancel">
            取消
          </button>
          <button
            class="btn primary"
            type="button"
            size="large"
            @click="onConfirm"
          >
            确定
          </button>
        </div>
      </div>
    </template>
  </AppModal>
</template>

<style>
.settingsPanelModal {
  height: min(640px, calc(100vh - 48px));
}
</style>

<style scoped>
.settingsLayout {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
}

.settingsScroll {
  flex: 1 1 auto;
  min-height: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.settingsTabScroller {
  box-sizing: border-box;
  flex: 1 1 auto;
  min-height: 0;
  overflow-x: hidden;
  overflow-y: auto;
  padding: 16px 8px 8px 0;
}

.settingsTabContent {
  box-sizing: border-box;
}

.settingsFooter {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  width: 100%;
}

.settingsFooterStart {
  display: flex;
  align-items: center;
  gap: 10px;
}

.settingsFooterActions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
  margin-left: auto;
}
</style>
