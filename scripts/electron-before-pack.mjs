/**
 * electron-builder beforePack：在收集依赖前裁剪 node_modules。
 * 须在 onNodeModuleFile 之前执行，以便写入 packPlat/packArch。
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setPackTarget } from "./electron-pack-context.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * @param {string} cwd
 * @param {string} plat
 * @param {string} arch
 * @param {string | null} nodeModules
 */
function runPrune(cwd, plat, arch, nodeModules = null) {
  const args = [
    "scripts/prune-pack-deps.mjs",
    "--platform",
    plat,
    "--arch",
    arch,
  ];
  if (nodeModules) args.push("--node-modules", nodeModules);
  execSync(`node ${args.map((a) => JSON.stringify(a)).join(" ")}`, {
    cwd,
    stdio: "inherit",
  });
}

/** @param {string} dir @returns {string[]} */
function findNodeModulesDirs(dir) {
  /** @type {string[]} */
  const found = [];
  if (!fs.existsSync(dir)) return found;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    const abs = path.join(dir, ent.name);
    if (ent.name === "node_modules") found.push(abs);
    else found.push(...findNodeModulesDirs(abs));
  }
  return found;
}

/** @param {import("app-builder-lib").BeforePackContext} context */
export default async function beforePack(context) {
  const plat = context.electronPlatformName;
  const arch = context.arch === 3 ? "arm64" : "x64";
  setPackTarget(plat, arch);

  const projectDir = context.packager.info.appDir ?? root;
  runPrune(projectDir, plat, arch);

  const projectNm = path.join(projectDir, "node_modules");
  for (const nm of findNodeModulesDirs(context.appOutDir)) {
    if (path.resolve(nm) !== path.resolve(projectNm)) {
      runPrune(projectDir, plat, arch, nm);
    }
  }
}
