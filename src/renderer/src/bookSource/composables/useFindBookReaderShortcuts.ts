import { nextTick, onBeforeUnmount, onMounted, ref, watch, type Ref } from "vue";
import type ReaderMain from "../../components/ReaderMain.vue";
import {
  persistKey,
  persistedSettingsChangedEvent,
} from "../../constants/appUi";
import { loadPersistedSettingsData } from "../../stores/cacheStore";
import {
  createDefaultShortcutBindings,
  type ShortcutBindingMap,
} from "../../services/shortcutRegistry";
import {
  bindAppShortcuts,
  VOICE_READ_SCROLL_BLOCKED_ACTIONS,
} from "../../services/shortcutService";
import { mergeShortcutBindings } from "../../services/shortcutUtils";
import {
  getModalStackDepth,
  hasEscBeforeModalLayers,
} from "../../utils/modalStack";
import { keyboardEventFromReaderSidebar } from "../../utils/readerSidebarKeyboard";

function keyboardTargetInsideFindWidget(ev: KeyboardEvent): boolean {
  const t = ev.target;
  return t instanceof Element && !!t.closest(".find-widget");
}

const defaultShortcutBindings = createDefaultShortcutBindings(
  /mac|iphone|ipad|ipod/i.test(navigator.platform || ""),
);

function loadMainShortcutBindings():
  | Partial<ShortcutBindingMap>
  | undefined {
  return loadPersistedSettingsData(localStorage, persistKey)?.data
    ?.shortcutBindings;
}

export function useFindBookReaderShortcuts(deps: {
  readerOpen: Ref<boolean>;
  readerRef: Ref<InstanceType<typeof ReaderMain> | null>;
  increaseFontSize: () => void;
  decreaseFontSize: () => void;
  increaseLineHeight: () => void;
  decreaseLineHeight: () => void;
  jumpToPrevChapter: () => void;
  jumpToNextChapter: () => void;
  toggleSidebar: () => void;
  toggleFullscreen: () => void;
  isVoiceReadScrollLocked?: Ref<boolean>;
  isVoiceReadBlocksFind?: Ref<boolean>;
}) {
  const shortcutBindings = ref<ShortcutBindingMap>(
    mergeShortcutBindings(defaultShortcutBindings, loadMainShortcutBindings()),
  );

  let unbindShortcuts: (() => void) | null = null;
  /** 阅读器打开时的模态栈深度（含找书面板/阅读器自身 AppModal）；仅更上层模态（设置等）才屏蔽快捷键 */
  let shortcutsBaselineModalDepth = 0;

  function syncShortcutBindingsFromMain() {
    shortcutBindings.value = mergeShortcutBindings(
      defaultShortcutBindings,
      loadMainShortcutBindings(),
    );
  }

  function findBookReaderShortcutsShouldHandle(ev: KeyboardEvent): boolean {
    if (!deps.readerOpen.value) return false;
    if (hasEscBeforeModalLayers()) return false;
    if (getModalStackDepth() > shortcutsBaselineModalDepth) return false;
    // 与主界面一致：侧栏内按键不接管，交给浏览器（↑/↓ 在章节按钮间移动并滚入视口）
    if (keyboardEventFromReaderSidebar(ev)) return false;
    return true;
  }

  function bindShortcuts() {
    if (unbindShortcuts) return;
    shortcutsBaselineModalDepth = getModalStackDepth();
    unbindShortcuts = bindAppShortcuts(
      {
        openSettings: () => {},
        openColorScheme: () => {},
        openFindBook: () => {},
        openBookSource: () => {},
        toggleFullscreen: deps.toggleFullscreen,
        increaseFontSize: deps.increaseFontSize,
        decreaseFontSize: deps.decreaseFontSize,
        increaseLineHeight: deps.increaseLineHeight,
        decreaseLineHeight: deps.decreaseLineHeight,
        toggleSidebar: deps.toggleSidebar,
        openNewWindow: () => {},
        openFile: () => {},
        pickTxtDirectory: () => {},
        openChapterRules: () => {},
        toggleBookmark: () => {},
        jumpToPrevChapter: deps.jumpToPrevChapter,
        jumpToNextChapter: deps.jumpToNextChapter,
        toggleFind: () => {
          if (deps.isVoiceReadBlocksFind?.value) return;
          deps.readerRef.value?.toggleFindWidget?.();
        },
        scrollDownLine: () => deps.readerRef.value?.scrollByLineStep?.(1),
        scrollUpLine: () => deps.readerRef.value?.scrollByLineStep?.(-1),
        scrollPageUp: () => deps.readerRef.value?.scrollByPageStep?.(-1),
        scrollPageDown: () => deps.readerRef.value?.scrollByPageStep?.(1),
      },
      () => shortcutBindings.value,
      findBookReaderShortcutsShouldHandle,
      (action, ev) =>
        keyboardTargetInsideFindWidget(ev) &&
        (action === "scrollUpLine" || action === "scrollDownLine"),
      (action) =>
        Boolean(deps.isVoiceReadScrollLocked?.value) &&
        VOICE_READ_SCROLL_BLOCKED_ACTIONS.has(action),
    );
  }

  function teardownShortcuts() {
    unbindShortcuts?.();
    unbindShortcuts = null;
  }

  function onStorageSync(ev: StorageEvent) {
    if (ev.storageArea !== localStorage || ev.key !== persistKey) return;
    syncShortcutBindingsFromMain();
  }

  watch(
    () => deps.readerOpen.value,
    (open) => {
      if (open) {
        void nextTick(() => bindShortcuts());
      } else {
        teardownShortcuts();
      }
    },
    { immediate: true },
  );

  onMounted(() => {
    syncShortcutBindingsFromMain();
    window.addEventListener("storage", onStorageSync);
    window.addEventListener(
      persistedSettingsChangedEvent,
      syncShortcutBindingsFromMain,
    );
  });

  onBeforeUnmount(() => {
    teardownShortcuts();
    window.removeEventListener("storage", onStorageSync);
    window.removeEventListener(
      persistedSettingsChangedEvent,
      syncShortcutBindingsFromMain,
    );
  });

  return { shortcutBindings };
}
