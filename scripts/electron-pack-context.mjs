/** electron-builder 打包阶段共享的平台/架构上下文（beforePack → onNodeModuleFile） */
export let packPlat = null;
export let packArch = null;

/** @param {string} plat @param {string} arch */
export function setPackTarget(plat, arch) {
  packPlat = plat;
  packArch = arch;
}

/** @returns {{ plat: string, arch: string } | null} */
export function resolvePackTarget() {
  if (packPlat && packArch) return { plat: packPlat, arch: packArch };
  const plat = process.env.COLORTXT_PRUNE_PLATFORM;
  const arch = process.env.COLORTXT_PRUNE_ARCH;
  if (plat && arch) return { plat, arch };
  return null;
}

/** @param {string} plat @param {string} arch */
export function jiebaKeepName(plat, arch) {
  const platToken =
    plat === "darwin"
      ? arch === "arm64"
        ? "darwin-arm64"
        : "darwin-x64"
      : plat === "linux"
        ? arch === "arm64"
          ? "linux-arm64-gnu"
          : "linux-x64-gnu"
        : arch === "arm64"
          ? "win32-arm64-msvc"
          : "win32-x64-msvc";
  return `jieba-${platToken}`;
}

/** @param {string} plat @param {string} arch */
export function sqliteKeepName(plat, arch) {
  const os = plat === "win32" ? "windows" : plat;
  return `sqlite-vec-${os}-${arch}`;
}

/** @param {string} plat @param {string} arch */
export function onnxArchDirsToKeep(plat, arch) {
  if (plat === "linux" && arch === "x64") return ["x64", "x86_64"];
  return [arch];
}

/** @param {string} file */
export function normalizePackPath(file) {
  return file.replace(/\\/g, "/");
}

/**
 * 在 electron-builder 收集 node_modules 时排除非当前平台的文件。
 * @param {string} file
 * @returns {boolean | void} false = 排除
 */
export function shouldIncludeNodeModuleFile(file) {
  const target = resolvePackTarget();
  if (!target) return;

  const { plat: activePlat, arch: activeArch } = target;
  const f = normalizePackPath(file);

  if (
    f.includes("/node_modules/onnxruntime-web/") ||
    f.endsWith("/node_modules/onnxruntime-web") ||
    f.includes("/node_modules/@img/")
  ) {
    return false;
  }

  const sqliteKeep = sqliteKeepName(activePlat, activeArch);
  for (const m of f.matchAll(/node_modules\/(sqlite-vec-[^/]+)/g)) {
    if (m[1].startsWith("sqlite-vec-") && m[1] !== sqliteKeep) return false;
  }

  const jiebaKeep = jiebaKeepName(activePlat, activeArch);
  for (const m of f.matchAll(/node_modules\/@node-rs\/(jieba-[^/]+)/g)) {
    if (m[1].startsWith("jieba-") && m[1] !== jiebaKeep) return false;
  }

  if (f.includes("/onnxruntime-node/bin/napi-v3/")) {
    const match = f.match(/onnxruntime-node\/bin\/napi-v3\/([^/]+)(?:\/([^/]+))?/);
    if (match) {
      const [, platform, archDir] = match;
      if (platform !== activePlat) return false;
      if (archDir && !onnxArchDirsToKeep(activePlat, activeArch).includes(archDir)) {
        return false;
      }
    }
  }

  if (f.includes("/@huggingface/transformers/dist/")) {
    if (!f.endsWith("/transformers.node.mjs")) return false;
  }

  return undefined;
}
