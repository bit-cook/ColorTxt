import type { TimedScrollSettings } from "../../constants/timedScroll";
import type { PomodoroSettings } from "../../constants/pomodoro";
import type {
  TextConvertWidthMode,
  TextConvertZhMode,
} from "@shared/textConvertTypes";

export const findBookSettingsKey = "colortxt.findBook.settings";

export const DEFAULT_FIND_BOOK_DOWNLOAD_CATEGORY = "下载";

export type FindBookDownloadAfterAction = "none" | "openMain" | "openNewWindow";

export const DEFAULT_FIND_BOOK_DOWNLOAD_AFTER_ACTION: FindBookDownloadAfterAction =
  "none";

/** 找书阅读器底部「上一章 / 下一章」工具栏（默认开启） */
export const defaultFindBookChapterNavToolbarEnabled = true;

export const FIND_BOOK_DOWNLOAD_AFTER_ACTION_OPTIONS = [
  { id: "none" as const, label: "无动作" },
  { id: "openMain" as const, label: "在主界面打开" },
  { id: "openNewWindow" as const, label: "在新窗口打开" },
];

export function isFindBookDownloadAfterAction(
  value: unknown,
): value is FindBookDownloadAfterAction {
  return (
    value === "none" || value === "openMain" || value === "openNewWindow"
  );
}

export function labelForFindBookDownloadAfterAction(
  action: FindBookDownloadAfterAction,
): string {
  return (
    FIND_BOOK_DOWNLOAD_AFTER_ACTION_OPTIONS.find((o) => o.id === action)?.label ??
    "无动作"
  );
}

/** 找书全局 HTTP 代理类型（对齐 Legado `http|socks4|socks5://host:port`） */
export type FindBookProxyType = "http" | "socks5" | "socks4";

export type FindBookProxySettings = {
  enabled: boolean;
  type: FindBookProxyType;
  host: string;
  port: string;
  username: string;
  password: string;
};

export const DEFAULT_FIND_BOOK_PROXY_SETTINGS: FindBookProxySettings = {
  enabled: false,
  type: "http",
  host: "127.0.0.1",
  port: "7890",
  username: "",
  password: "",
};

export const FIND_BOOK_PROXY_TYPE_OPTIONS = [
  { id: "http" as const, label: "HTTP" },
  { id: "socks5" as const, label: "SOCKS5" },
  { id: "socks4" as const, label: "SOCKS4" },
];

export function isFindBookProxyType(value: unknown): value is FindBookProxyType {
  return value === "http" || value === "socks5" || value === "socks4";
}

export function labelForFindBookProxyType(type: FindBookProxyType): string {
  return (
    FIND_BOOK_PROXY_TYPE_OPTIONS.find((o) => o.id === type)?.label ?? "HTTP"
  );
}

export function normalizeFindBookProxySettings(
  raw: unknown,
): FindBookProxySettings {
  const base = { ...DEFAULT_FIND_BOOK_PROXY_SETTINGS };
  if (!raw || typeof raw !== "object") return base;
  const data = raw as Partial<FindBookProxySettings>;
  return {
    enabled: data.enabled === true,
    type: isFindBookProxyType(data.type) ? data.type : "http",
    host: typeof data.host === "string" ? data.host.trim() : "",
    port:
      typeof data.port === "number" && Number.isFinite(data.port)
        ? String(Math.floor(data.port))
        : typeof data.port === "string"
          ? data.port.trim()
          : "",
    username: typeof data.username === "string" ? data.username.trim() : "",
    password: typeof data.password === "string" ? data.password : "",
  };
}

/**
 * 拼成 Legado 代理字符串：`scheme://host:port` 或 `scheme://host:port@user@pass`。
 * 未启用或主机/端口不完整时返回空字符串。
 */
export function buildFindBookProxyUrl(settings: FindBookProxySettings): string {
  if (!settings.enabled) return "";
  const host = settings.host.trim();
  const port = settings.port.trim();
  if (!host || !port) return "";
  if (!/^\d{2,5}$/.test(port)) return "";
  const scheme =
    settings.type === "socks4"
      ? "socks4"
      : settings.type === "socks5"
        ? "socks5"
        : "http";
  const user = settings.username.trim();
  const pass = settings.password;
  const auth = user !== "" || pass !== "" ? `@${user}@${pass}` : "";
  return `${scheme}://${host}:${port}${auth}`;
}

/** 找书窗口独立持久化的设置（主题色、语音朗读仍走主应用设置） */
export type PersistedFindBookSettings = {
  /** 章节正文离线缓存根目录 */
  cacheDir?: string;
  downloadDir?: string;
  downloadAfterAction?: FindBookDownloadAfterAction;
  downloadAddToMainFileList?: boolean;
  downloadDefaultCategory?: string;
  /** 找书全局网络代理（书源 header `proxy` 优先） */
  proxy?: FindBookProxySettings;
  fontSize?: number;
  lineHeightMultiple?: number;
  fontFamily?: string;
  pinnedOtherFonts?: string[];
  monacoCustomHighlight?: boolean;
  txtrDelimitedMatchCrossLine?: boolean;
  compressBlankLines?: boolean;
  compressBlankKeepOneBlank?: boolean;
  leadIndentFullWidth?: boolean;
  textConvertZh?: TextConvertZhMode;
  textConvertLetter?: TextConvertWidthMode;
  textConvertDigit?: TextConvertWidthMode;
  monacoAdvancedWrapping?: boolean;
  monacoSmoothScrolling?: boolean;
  stickyChapterTitleEnabled?: boolean;
  chapterNavToolbarEnabled?: boolean;
  /** 编辑模式：显示行号（默认关闭） */
  readerEditShowLineNumbers?: boolean;
  /** 编辑模式：启用小地图（默认关闭） */
  readerEditMinimap?: boolean;
  fullscreenReaderWidthPercent?: number;
  fullscreenShowSystemTime?: boolean;
  sidebarWidth?: number;
  timedScroll?: Partial<TimedScrollSettings>;
  pomodoro?: Partial<PomodoroSettings>;
};
