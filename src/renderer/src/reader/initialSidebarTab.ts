import type { ReaderSidebarTab } from "../constants/readerSidebarTab";
import {
  defaultRestoreSessionOnStartup,
  persistKey,
  sessionKey,
} from "../constants/appUi";
import {
  loadPersistedSettingsData,
  loadSessionSnapshot,
} from "../stores/cacheStore";

export type InitialWindowLoadIntent = {
  /** 首窗口且无 shell 待打开路径时，渲染进程会尝试 `tryRestoreSession` */
  shouldRestoreSession: boolean;
  /** 右键「打开方式」/ 命令行关联启动时主进程写入的待打开路径 */
  hasPendingOpenTxt: boolean;
};

function willRestoreSessionFileFromStorage(
  storage: Storage | undefined,
): boolean {
  if (!storage) return false;

  let restoreOnStartup = defaultRestoreSessionOnStartup;
  const settings = loadPersistedSettingsData(storage, persistKey);
  if (typeof settings?.data.restoreSessionOnStartup === "boolean") {
    restoreOnStartup = settings.data.restoreSessionOnStartup;
  }
  if (!restoreOnStartup) return false;

  const session = loadSessionSnapshot(storage, sessionKey);
  return Boolean(session?.currentFile);
}

/**
 * 首屏侧栏 tab：仅在本窗口确定会加载文件时用「章节」，否则「文件列表」。
 * - 新窗口：不恢复会话且无待打开路径 → 文件
 * - 首启恢复上次文件 / 打开方式启动 → 章节
 */
export function resolveInitialReaderSidebarTab(
  intent: InitialWindowLoadIntent,
  storage: Storage | undefined =
    typeof window !== "undefined" ? window.localStorage : undefined,
): ReaderSidebarTab {
  if (intent.hasPendingOpenTxt) return "chapters";
  if (!intent.shouldRestoreSession) return "files";
  return willRestoreSessionFileFromStorage(storage) ? "chapters" : "files";
}
