/**
 * Qoder CN 安装位置探测 —— host 半边与网关半边共用同一份实现。
 *
 * ── 为什么必须共用（不是洁癖，是一个真实故障）────────────────────────
 * 这段逻辑原本在两处各写了一遍：
 *   lib/index.mjs   discoverElectron()  只认 C:\ 和 D:\ 前缀
 *   server.mjs      findElectron()      枚举 C/D/E/F 盘符
 * 两份漂移之后，装在 E 盘的用户会遇到：
 *   host 半边用自己那份探测 → 失败 → 直接放弃拉起网关，
 *   而网关自己那份本来认得 E 盘，根本没机会运行。
 * 用户只看到「找不到 Qoder CN 安装位置」，因为真正的探测者从未被唤起。
 * 合并成一份，这个坑从结构上消失。
 *
 * 候选顺序：显式配置 → 环境变量 → 各盘符常见位置 → 用户级安装。
 * 盘符用 A-Z 全枚举而非固定几个：每次启动只跑一遍，26 次 existsSync 的
 * 开销可忽略，但少枚举一个盘符就是整台机器不可用。
 */

import { existsSync } from "node:fs";
import { join, dirname, isAbsolute } from "node:path";

/** 每个盘符下要试的相对路径，按命中概率从高到低。 */
const RELATIVE_CANDIDATES = [
  join("Qoder CN", "Qoder CN.exe"),
  join("Qoder", "Qoder CN.exe"),
  join("Program Files", "Qoder CN", "Qoder CN.exe"),
  join("Program Files (x86)", "Qoder CN", "Qoder CN.exe")
];

/**
 * 解析显式配置的路径。
 * baseDir 让相对路径有基准（host 半边传插件根目录）；不传则原样返回。
 */
function resolveConfigured(value, baseDir) {
  if (!value || typeof value !== "string") return null;
  const v = value.trim();
  if (!v) return null;
  return isAbsolute(v) ? v : (baseDir ? join(baseDir, v) : v);
}

/**
 * 按优先级列出全部候选路径（含显式配置）。
 * 单独导出，是为了让报错信息能如实告诉用户「我找过哪些地方」。
 */
export function electronCandidates(cfg = {}, baseDir = null) {
  const home = process.env.USERPROFILE || process.env.HOME || "";
  const out = [];

  const configured = resolveConfigured(cfg.electronExe, baseDir);
  if (configured) out.push(configured);
  if (process.env.QODER_ELECTRON_EXE) out.push(process.env.QODER_ELECTRON_EXE);

  for (let i = 65; i <= 90; i++) {
    const root = String.fromCharCode(i) + ":\\";
    for (const rel of RELATIVE_CANDIDATES) out.push(join(root, rel));
  }

  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData) out.push(join(localAppData, "Programs", "Qoder CN", "Qoder CN.exe"));
  const pf = process.env.ProgramFiles;
  if (pf) out.push(join(pf, "Qoder CN", "Qoder CN.exe"));
  const pf86 = process.env["ProgramFiles(x86)"];
  if (pf86) out.push(join(pf86, "Qoder CN", "Qoder CN.exe"));
  if (home) out.push(join(home, "AppData", "Local", "Programs", "Qoder CN", "Qoder CN.exe"));

  return out;
}

/** 探测 Qoder CN 可执行文件，命中返回绝对路径，否则 null。 */
export function discoverElectron(cfg = {}, baseDir = null) {
  for (const c of electronCandidates(cfg, baseDir)) {
    try { if (c && existsSync(c)) return c; } catch { /* 无效路径跳过 */ }
  }
  return null;
}

/** 探测 worker runtime 根目录（ELECTRON_RUN_AS_NODE 模式用）。 */
export function discoverSdkRoot(electronExe, cfg = {}, baseDir = null) {
  const configured = resolveConfigured(cfg.sdkRoot, baseDir);
  if (configured && existsSync(configured)) return configured;
  if (process.env.QODER_SDK_ROOT && existsSync(process.env.QODER_SDK_ROOT)) return process.env.QODER_SDK_ROOT;
  if (!electronExe) return null;
  const base = join(dirname(electronExe), "resources", "app.asar.unpacked",
    "node_modules", "@qoder-ai", "qoder-cn-agent-sdk", "dist", "_worker");
  return existsSync(base) ? base : null;
}
