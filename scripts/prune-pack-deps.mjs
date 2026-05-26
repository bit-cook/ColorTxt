/**
 * 在 electron-builder 打包前裁剪项目 node_modules，减小安装包体积。
 * electron-builder 会复用已有 node_modules（见 installOrRebuild），故须在 build 脚本中、
 * electron-vite build 之后、electron-builder 之前执行。
 *
 * 打包后若需恢复完整依赖：npm ci
 *
 * 用法：node scripts/prune-pack-deps.mjs [--platform win32|darwin|linux] [--arch x64|arm64]
 */
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const nm = path.join(root, "node_modules");

/** @param {string} abs */
function rm(abs) {
  if (fs.existsSync(abs)) fs.rmSync(abs, { recursive: true, force: true });
}

function parseArgs() {
  const argv = process.argv.slice(2);
  let platform = process.env.npm_config_platform || process.platform;
  let arch = process.env.npm_config_arch || process.arch;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--platform" && argv[i + 1]) platform = argv[++i];
    if (argv[i] === "--arch" && argv[i + 1]) arch = argv[++i];
  }
  return resolveOnnxPlatformArch(platform, arch);
}

/**
 * @param {string} platformName
 * @param {string} archName
 */
function resolveOnnxPlatformArch(platformName, archName) {
  const name = String(platformName ?? "").toLowerCase();
  const plat =
    name === "darwin" || name === "mac" || name === "mas"
      ? "darwin"
      : name === "linux"
        ? "linux"
        : "win32";
  const a = String(archName ?? "").toLowerCase();
  const arch =
    a === "arm64" || a === "arm" || a === "aarch64" ? "arm64" : "x64";
  return { plat, arch };
}

/** @param {string} nodeModulesRoot */
function pruneOnnxRuntimeNode(nodeModulesRoot, plat, archName) {
  const ortRoot = path.join(nodeModulesRoot, "onnxruntime-node");
  const napiRoot = path.join(ortRoot, "bin", "napi-v3");
  if (!fs.existsSync(napiRoot)) return;

  for (const platformDir of fs.readdirSync(napiRoot, { withFileTypes: true })) {
    if (!platformDir.isDirectory()) continue;
    const platformPath = path.join(napiRoot, platformDir.name);
    if (platformDir.name !== plat) {
      rm(platformPath);
      continue;
    }
    for (const archDir of fs.readdirSync(platformPath, { withFileTypes: true })) {
      if (!archDir.isDirectory()) continue;
      if (archDir.name !== archName) {
        rm(path.join(platformPath, archDir.name));
      }
    }
  }
}

/** Windows 内置向量仅用 CPU；DirectML.dll 仅在使用 dml EP 时需要（约 18MB） */
function pruneOnnxDirectMl(nodeModulesRoot, plat, arch) {
  if (plat !== "win32") return;
  const dml = path.join(
    nodeModulesRoot,
    "onnxruntime-node",
    "bin",
    "napi-v3",
    "win32",
    arch,
    "DirectML.dll",
  );
  rm(dml);
}

/** @param {string} nodeModulesRoot */
function pruneOnnxRuntimeNodePackage(nodeModulesRoot) {
  const ortRoot = path.join(nodeModulesRoot, "onnxruntime-node");
  if (!fs.existsSync(ortRoot)) return;

  for (const extra of ["lib", "script", "README.md"]) {
    rm(path.join(ortRoot, extra));
  }

  const distDir = path.join(ortRoot, "dist");
  if (!fs.existsSync(distDir)) return;
  for (const name of fs.readdirSync(distDir)) {
    if (name.endsWith(".map")) rm(path.join(distDir, name));
  }
}

/** 与 package.json exports.node 一致，仅保留 node 入口（勿用未导出的 dist 子路径） */
function pruneTransformersPackage(nodeModulesRoot) {
  const pkgRoot = path.join(nodeModulesRoot, "@huggingface", "transformers");
  const distDir = path.join(pkgRoot, "dist");
  if (!fs.existsSync(distDir)) return;

  const keepDist = new Set(["transformers.node.mjs"]);

  for (const name of fs.readdirSync(distDir)) {
    if (!keepDist.has(name)) rm(path.join(distDir, name));
  }
  rm(path.join(pkgRoot, "src"));
  rm(path.join(pkgRoot, "types"));
}

/** onnxruntime-web 删除后常留在顶层的孤儿包（仅 web 推理链使用） */
function pruneOnnxWebOrphans(nodeModulesRoot) {
  rm(path.join(nodeModulesRoot, "@protobufjs"));
  for (const name of [
    "protobufjs",
    "flatbuffers",
    "guid-typescript",
    "long",
    "platform",
  ]) {
    rm(path.join(nodeModulesRoot, name));
  }
}

/**
 * 从 transformers 的 package.json 去掉已裁剪的 web/sharp 依赖，避免 electron-builder
 * 收集依赖时 npm ls 报 ELSPROBLEMS（missing / extraneous）。
 * @param {string} nodeModulesRoot
 */
function patchTransformersManifest(nodeModulesRoot) {
  const pkgPath = path.join(
    nodeModulesRoot,
    "@huggingface",
    "transformers",
    "package.json",
  );
  if (!fs.existsSync(pkgPath)) return;

  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  const drop = ["onnxruntime-web", "sharp"];
  for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
    const block = pkg[field];
    if (!block || typeof block !== "object") continue;
    for (const name of drop) delete block[name];
    if (Object.keys(block).length === 0) delete pkg[field];
  }
  fs.writeFileSync(pkgPath, `${JSON.stringify(pkg)}\n`);
}

function main() {
  if (!fs.existsSync(nm)) {
    console.warn("[prune-pack-deps] skip: node_modules not found");
    return;
  }

  const { plat, arch } = parseArgs();

  rm(path.join(nm, "onnxruntime-web"));
  rm(path.join(nm, "sharp"));
  rm(path.join(nm, "@img"));
  pruneOnnxWebOrphans(nm);

  pruneOnnxRuntimeNode(nm, plat, arch);
  pruneOnnxRuntimeNodePackage(nm);
  pruneOnnxDirectMl(nm, plat, arch);
  pruneTransformersPackage(nm);
  patchTransformersManifest(nm);

  const ortMb = dirSizeMb(path.join(nm, "onnxruntime-node"));
  const hfMb = dirSizeMb(path.join(nm, "@huggingface"));
  console.log(
    `[prune-pack-deps] ${plat}/${arch} done; onnxruntime-node≈${ortMb}MB @huggingface≈${hfMb}MB in node_modules`,
  );
}

/** @param {string} abs */
function dirSizeMb(abs) {
  if (!fs.existsSync(abs)) return "0";
  let sum = 0;
  for (const f of fs.readdirSync(abs, { withFileTypes: true })) {
    const p = path.join(abs, f.name);
    if (f.isDirectory()) sum += Number.parseFloat(dirSizeMb(p)) * 1024 * 1024;
    else if (f.isFile()) sum += fs.statSync(p).size;
  }
  return (sum / (1024 * 1024)).toFixed(1);
}

main();
