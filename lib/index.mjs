/**
 * dsh-qoder-relay — host 半边（兼作 Qoder CLI 生命周期管理）
 *
 * 两块职责：
 *   1. 网关生命周期：DSH 启动时把本地网关跑起来，退出时收干净
 *   2. 登录控制：暴露一个 host 服务，供浏览器半边查询登录状态、发起设备码登录
 *
 * ── 为什么登录要放在 host 端 ──────────────────────────────────────────
 * 设备码登录要 spawn "Qoder CN.exe"（当 Node 运行时）跑 qoderclicn login。
 * 浏览器里做不到这件事。所以 host 端提供 API，client 端只负责渲染和触发。
 *
 * ── 网关原理（简版） ─────────────────────────────────────────────────
 * Qoder CN 桌面端内部打包了完整 headless Agent CLI
 * （@qoder-ai/qoder-cn-agent-sdk → _worker/qoder-worker-runtime.obf.mjs）。
 * 让 Electron 主程序以 ELECTRON_RUN_AS_NODE=1 充当 Node 24，就能用官方 CLI
 * 协议驱动它，复用订阅额度 —— 不需要逆向签名，也不触碰桌面端的 DPAPI 凭证
 * （worker 运行时不读 auth.v1.dat，CLI 走自己的设备码登录）。
 *
 * 网关本身是标准 OpenAI 兼容服务，与 DSH 无耦合。
 *
 * ── 关键设计点（都有原因，别随手改）────────────────────────────────
 *   - 端口占用探测：宿主重启常见「上一个实例还没死透」。先探 /health，
 *     活着就复用，不重复 listen（否则 EADDRINUSE）。
 *   - generation 计数：profile 是 patchReload:"live"，新 fiber 先建、旧 fiber
 *     后拆。不做代际判定会「新的刚装好又被旧的拆掉」。
 *   - 不写 peerDependencies：没有 peers 时版本预检直接返回 undefined 被绕过；
 *     写了每次 DSH 升级都报不兼容。
 *   - 清理必须用 ctx.effect（DSH 里 84 个插件用它，返回值即 teardown）。
 *     写成 ctx.on("dispose", ...) 是错的 —— 那只是事件订阅。
 *   - 子进程终止用 taskkill /T /F（spawnSync 同步）。Windows 上 Electron 子进程
 *     常不在同一进程组，SIGTERM 未必管用；且 unref 的定时器在宿主退出时
 *     永不触发，会留孤儿。
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const RELAY_DIR = join(HERE, "..");

const DEFAULT_PORT = 8788;
const DEFAULT_HOST = "127.0.0.1";

/* ───────────────────────── 路径探测 ───────────────────────── */

/** 探测 Qoder 安装位置。返回 exe 路径，找不到返回 null。 */
function discoverElectron(cfg) {
  if (cfg.electronExe) {
    const p = isAbsolute(cfg.electronExe) ? cfg.electronExe : join(RELAY_DIR, cfg.electronExe);
    if (existsSync(p)) return p;
  }
  const candidates = [
    "D:\\Qoder CN\\Qoder CN.exe",
    "C:\\Qoder CN\\Qoder CN.exe",
    "D:\\Qoder\\Qoder CN.exe",
    "C:\\Qoder\\Qoder CN.exe",
    "C:\\Program Files\\Qoder CN\\Qoder CN.exe",
    join(process.env.LOCALAPPDATA ?? "", "Programs", "Qoder CN", "Qoder CN.exe"),
    join(process.env.ProgramFiles ?? "", "Qoder CN", "Qoder CN.exe")
  ];
  for (const c of candidates) if (c && existsSync(c)) return c;
  return null;
}

/** 探测 worker runtime 根目录（ELECTRON_RUN_AS_NODE 模式用）。 */
function discoverSdkRoot(electronExe, cfg) {
  if (cfg.sdkRoot && existsSync(cfg.sdkRoot)) return cfg.sdkRoot;
  if (!electronExe) return null;
  const base = join(dirname(electronExe), "resources", "app.asar.unpacked",
    "node_modules", "@qoder-ai", "qoder-cn-agent-sdk", "dist", "_worker");
  return existsSync(base) ? base : null;
}

/** CLI 配置根（~/.qoder-cn）。DSH_HOME 风格：可被 cfg 覆盖。 */
function cliConfigDir(cfg) {
  return cfg.qoderConfigDir || join(process.env.USERPROFILE || process.env.HOME || "", ".qoder-cn");
}

/* ───────────────────────── 登录态 ───────────────────────── */

/** 登录态文件：CLI 的 auth 目录 + 桌面端的状态快照。
 *  我们不解析 auth.v1.dat（那是 DPAPI 加密的），只看存在性与状态快照。 */
function readLoginState(cfg) {
  const dir = cliConfigDir(cfg);
  const statusPath = join(dir, ".qoder-app-status.json");
  let loggedIn = false;
  let name = null;

  // 优先读 CLI 自己写的状态快照
  try {
    if (existsSync(statusPath)) {
      const j = JSON.parse(readFileSync(statusPath, "utf8"));
      loggedIn = j.logged_in === true;
      name = typeof j.name === "string" ? j.name : null;
    }
  } catch { /* 快照坏了就回落到目录探测 */ }

  // 回落：CLI 的凭证目录存在即视为已登录
  const authDir = join(dir, ".auth");
  if (!loggedIn && existsSync(authDir)) {
    // .auth 里有 machine_id 只能说明装过，不能证明登过。
    // 真正的登录标志由下面的实测（--list-models）决定。
  }

  return {
    loggedIn,
    name,
    configDir: dir,
    authDirExists: existsSync(authDir),
    statusFileExists: existsSync(statusPath)
  };
}

/* ───────────────────────── 网关管理 ───────────────────────── */

/** 探一下端口上是不是已经有一个活的 qoder-relay。 */
async function probeGateway(port, host, timeoutMs = 1500) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(`http://${host}:${port}/health`, { signal: ac.signal });
    if (!r.ok) return null;
    const j = await r.json();
    return j && j.service === "qoder-relay" ? j : null;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

export const name = "qoder-relay";

/** 供 host 侧使用的登录会话状态（同一时刻只允许一个登录流程）。 */
let activeLogin = null;

/**
 * 以 Electron-as-Node 跑一次 qoderclicn 命令，收集 stdout。
 * 用于登录、列模型等一次性操作。
 *
 * @returns {Promise<{code:number, stdout:string, stderr:string}>}
 */
function runCli(electronExe, sdkRoot, args, cfg, timeoutMs = 300000) {
  return new Promise((resolve) => {
    const env = {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      QODER_SDK_ROOT: sdkRoot,
      QODER_WORKER_RUNTIME_ASSET_ROOT: sdkRoot,
      QODER_RELAY_ARGS: JSON.stringify(args),
      QODER_RELAY_DEBUG: "0"
    };
    const shim = join(RELAY_DIR, "shim.mjs");
    const child = spawn(electronExe, [shim], { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });

    let stdout = "";
    let stderr = "";
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try { child.kill(); } catch {}
      resolve({ code: -1, stdout, stderr: stderr + "\n[timeout]" });
    }, timeoutMs);

    child.stdout?.on("data", (d) => { stdout += d.toString("utf8"); });
    child.stderr?.on("data", (d) => { stderr += d.toString("utf8"); });
    child.on("error", (e) => {
      if (done) return;
      done = true; clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: stderr + "\n" + e.message });
    });
    child.on("exit", (code) => {
      if (done) return;
      done = true; clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

/** 真正判定「能不能用」：跑一次 --list-models。比看文件靠谱。 */
async function probeUsable(electronExe, sdkRoot, cfg) {
  const r = await runCli(electronExe, sdkRoot, ["--list-models"], cfg, 60000);
  if (r.code !== 0 || /Not logged in/i.test(r.stdout + r.stderr)) {
    return { usable: false, detail: (r.stdout + r.stderr).trim().slice(0, 400) };
  }
  const models = r.stdout.split(/\r?\n/).map((l) => l.trim())
    .filter((l) => l && l.toUpperCase() !== "MODEL");
  return { usable: models.length > 0, models, detail: "" };
}

export function apply(ctx, cfg = {}) {
  const host = cfg.host || DEFAULT_HOST;
  const port = Number(cfg.port) || DEFAULT_PORT;
  const log = (m) => ctx.logger?.info?.(`[qoder-relay] ${m}`) ?? console.log(`[qoder-relay] ${m}`);
  const warn = (m) => ctx.logger?.warn?.(`[qoder-relay] ${m}`) ?? console.warn(`[qoder-relay] ${m}`);

  let generation = 0;
  let child = null;
  let stopping = false;

  /**
   * 杀掉自有子进程。
   *
   * taskkill /T /F 是 Windows 上唯一可靠的手段：Electron 子进程常常不在同一
   * 进程组，Node 的 SIGTERM 对卡住的进程无效。spawnSync 同步阻塞 —— 宿主
   * 可以在返回后安全退出，不依赖任何 unref 的定时器（那种定时器在宿主退出时
   * 永不触发，会留孤儿，随重启累积）。
   */
  const killChild = () => {
    if (!child) return;
    const c = child;
    child = null;
    const pid = c.pid;
    try { c.kill(); } catch {}
    if (pid && process.platform === "win32") {
      try {
        const r = spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"],
          { windowsHide: true, stdio: "ignore", timeout: 5000 });
        if (r.status === 0 && cfg.debug === true) log(`已强杀进程树 pid=${pid}`);
      } catch {}
    }
  };

  const start = async () => {
    const myGen = ++generation;

    const alive = await probeGateway(port, host);
    if (alive) {
      log(`复用已运行实例 http://${host}:${port} (${alive.models} 个模型)`);
      return;
    }
    if (stopping || myGen !== generation) return;

    const electronExe = discoverElectron(cfg);
    if (!electronExe) {
      warn("找不到 Qoder CN 安装位置。请在插件设置里指定 electronExe，或确认 Qoder CN 已安装。");
      return;
    }
    const sdkRoot = discoverSdkRoot(electronExe, cfg);
    if (!sdkRoot) {
      warn(`在 ${electronExe} 附近找不到 qoder-cn-agent-sdk 的 _worker 目录。`);
      return;
    }

    const serverPath = join(RELAY_DIR, "server.mjs");
    if (!existsSync(serverPath)) {
      warn(`网关入口缺失: ${serverPath}`);
      return;
    }

    const env = {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      QODER_SDK_ROOT: sdkRoot,
      QODER_WORKER_RUNTIME_ASSET_ROOT: sdkRoot,
      QODER_RELAY_PORT: String(port),
      QODER_RELAY_HOST: host
    };
    if (cfg.qoderConfigDir) env.QODERCN_CONFIG_DIR = cfg.qoderConfigDir;

    child = spawn(electronExe, [serverPath], { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const spawned = child;

    spawned.stdout?.on("data", (d) => { const s = d.toString("utf8").trim(); if (s) log(s); });
    spawned.stderr?.on("data", (d) => { const s = d.toString("utf8").trim(); if (s) warn(s); });
    spawned.on("exit", (code) => {
      if (child === spawned) child = null;
      if (!stopping && code !== 0) warn(`网关进程退出，code=${code}`);
    });
    spawned.on("error", (e) => {
      if (child === spawned) child = null;
      warn(`网关进程启动失败: ${e.message}`);
    });

    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 250));
      if (stopping || myGen !== generation) return;
      const ok = await probeGateway(port, host, 1000);
      if (ok) { log(`已就绪 http://${host}:${port} (${ok.models} 个模型)`); return; }
      if (!child) return;
    }
    warn("网关启动超时（10s 内未响应 /health）。");
  };

  /* ─────────────────── 清理注册 ─────────────────── */
  const teardown = () => {
    if (stopping) return;
    stopping = true;
    generation++;
    killChild();
    log("网关已停止");
  };

  if (ctx && typeof ctx.effect === "function") {
    ctx.effect(() => {
      const onHostExit = () => killChild();
      process.prependListener("exit", onHostExit);
      return () => {
        process.off("exit", onHostExit);
        teardown();
      };
    }, "qoder-relay gateway teardown");
  } else {
    warn("ctx.effect 不可用，退回 dispose 监听（清理可能不完整）");
    if (ctx && typeof ctx.on === "function") ctx.on("dispose", teardown);
  }

  /* ─────────────────── 向浏览器注入配置 ─────────────────── */
  //
  // 这里**不能**用 ctx.set 注册服务 —— cordis 会抛
  //   "cannot set property ... without provide"
  // 而且那个错误发生在 apply 里，会直接让插件激活失败、渲染进程起不来、DSH 打不开。
  //
  // 正确做法（也是官方 dsh-client-ui-settings-* 的做法）：
  // 通过 webserver/index-inject 往页面塞一个全局变量，浏览器半边从 window 读。
  // 登录动作本身走网关自己的 HTTP 端点（/auth/*），不需要 host 服务协议。
  const cfgDir = cliConfigDir(cfg);
  if (ctx && typeof ctx.on === "function") {
    ctx.on("webserver/index-inject", (table) => {
      table.push({
        kind: "global",
        name: "__QODER_RELAY_CONFIG__",
        value: {
          baseURL: `http://${host}:${port}`,
          apiKey: cfg.relayKey || "",
          configDir: cfgDir,
          electronExe: cfg.electronExe || null
        }
      });
    });
  }

  start().catch((e) => warn(`启动流程异常: ${e.message}`));
}

export default { name, apply };