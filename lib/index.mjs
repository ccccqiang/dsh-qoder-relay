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
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverElectron, discoverSdkRoot } from "./discover.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const RELAY_DIR = join(HERE, "..");

const DEFAULT_PORT = 8788;
const DEFAULT_HOST = "127.0.0.1";

/* ───────────────────────── 配置 ───────────────────────── */
//
// 路径探测不在这里 —— 它和网关半边共用 lib/discover.mjs 那一份实现。
// 这里原本也写了一份，且已经和那边漂移：host 这份只认 C: 和 D: 前缀，
// 装在 E 盘时 host 先探测失败就直接放弃拉起网关，而网关自己那份本来
// 认得 E 盘，根本没机会运行。合并成一份之后这个坑从结构上没有了。

/**
 * 读取插件目录下的 config.json —— 用户自救通道。
 *
 * 这个文件一直被 config.example.json 暗示存在、server.mjs 也一直在读，
 * 但 host 半边从来没读过。于是形成一个死锁：
 *   host 探测 exe 失败 → 不启动 server → server 永远读不到 config.json
 *   → host 下次探测依旧失败。示例配置文件形同虚设。
 * 这里补上读取，死锁解开。
 */
function readRelayConfigFile() {
  const p = join(RELAY_DIR, "config.json");
  if (!existsSync(p)) return {};
  try {
    const j = JSON.parse(readFileSync(p, "utf8"));
    return j && typeof j === "object" && !Array.isArray(j) ? j : {};
  } catch (e) {
    // 坏文件不该拖垮启动，只警告，继续用默认值。
    console.warn("[qoder-relay] config.json 解析失败，已忽略: " + e.message);
    return {};
  }
}

/**
 * 合并配置，优先级 cordis 注入 > config.json > 默认值。
 *
 * 空字符串视为「未设置」而不是「设为空」：设置页保存一次只带 port 的配置，
 * 不该把 config.json 里的 electronExe 抹掉。
 */
function mergeConfig(injected) {
  const merged = { ...readRelayConfigFile() };
  for (const [k, v] of Object.entries(injected || {})) {
    if (v === undefined || v === null || v === "") continue;
    merged[k] = v;
  }
  return merged;
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

export function apply(ctx, injected = {}) {
  // cordis 注入优先，config.json 兜底。原先只有前者，死锁就出在这里。
  const cfg = mergeConfig(injected);
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

    const electronExe = discoverElectron(cfg, RELAY_DIR);
    if (!electronExe) {
      // 报错要能直接照做 —— 只说「找不到」等于没说，用户不可能猜到该配哪个键。
      warn(
        "找不到 Qoder CN 安装位置 —— 可能未安装，或装在非常规路径。以下三种方式任选一种：" +
        "① 在本插件目录建 config.json，内容 " + JSON.stringify({ electronExe: "E:/Qoder CN/Qoder CN.exe" }) + " ；" +
        "② 在 cordis.patch.yml 的 qoder-relay 行注入 config.electronExe；" +
        "③ 设置 QODER_ELECTRON_EXE 环境变量。"
      );
      return;
    }
    const sdkRoot = discoverSdkRoot(electronExe, cfg, RELAY_DIR);
    if (!sdkRoot) {
      warn(`已找到 ${electronExe}，但它旁边没有 qoder-cn-agent-sdk 的 _worker 目录 —— 安装可能不完整或版本不匹配。可用 config.json 的 sdkRoot 显式指定。`);
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

  /* ─────────── 接入模型路由（对接官方 settings / credentials 服务）─────────── */
  //
  // DSH 不会自动发现网关上的模型 —— 必须在 profile 层显式声明一个 provider。
  // 手工抄那段 yaml 有 60 行，而且同一个 id 的行是「整体覆盖」不是合并，
  // 用户照抄时很容易把自己别家中转站的 provider 一起冲掉。
  //
  // 这里改走官方写入路径 dsh-settings 的 SettingsForms.mutate()，
  // 也就是「设置 → 模型」页自己用的那个方法、同一个落点。ops 是路径寻址的
  // （applyPathOp 只改 path 指到的那一个键），所以写 providers.qoder
  // 不会碰到 providers.<别家>。
  //
  // 三条硬边界：
  //   1. 只在用户点按钮时执行 —— 插件启动时绝不改用户配置。
  //   2. providers.qoder 已存在时默认不覆盖，把差异如实报回去让用户决定。
  //   3. 写入前先取 revision 做乐观锁；用户在模型页同时编辑会被拒绝而不是盖掉。
  if (ctx && typeof ctx.inject === "function") {
    ctx.inject(["webServer", "settings"], (hostCtx) => {
      const SETTINGS_NS = "llm-pi-ai";
      const ROUTE = "qoder";
      const KEY_REF = "QODER_RELAY_KEY";
      const BASE = "http://" + host + ":" + port + "/v1";

      // 网关不校验 key，但 llm-pi-ai 解析 apiKeyEnv 找不到值会抛
      // MISSING_CREDENTIAL —— 所以这个引用名必须真实存在。
      const PLACEHOLDER_KEY = "qoder-relay-local";

      // 显示名只影响选择器，按上游实际名字给；表里没有就按连字符分词首字母大写。
      const DISPLAY_NAMES = {
        "auto": "Auto",
        "qoder-auto": "Qoder Auto",
        "deepseek-v4-pro": "DeepSeek-V4-Pro",
        "deepseek-flash": "DeepSeek-Flash",
        "qwen3.8-max": "Qwen3.8-Max",
        "qwen3.8-flash": "Qwen3.8-Flash",
        "qwen3.7-max": "Qwen3.7-Max",
        "qwen3.7-plus": "Qwen3.7-Plus",
        "qwen3.7-flash": "Qwen3.7-Flash",
        "glm-5.3": "GLM-5.3",
        "glm-5.3-flash": "GLM-5.3-Flash",
        "glm-5.2": "GLM-5.2",
        "kimi-k3": "Kimi-K3",
        "kimi-k2.8-preview": "Kimi-K2.8-Preview",
        "minimax-m2.7": "MiniMax-M2.7"
      };
      const displayNameOf = (id) => DISPLAY_NAMES[id]
        ?? String(id).split("-").map((s) => s.charAt(0).toUpperCase() + s.slice(1)).join("-");

      // 上下文/输出上限网关不暴露，按 Qoder 实际能力给；缺省会回落到 262144/32768。
      const contextWindow = 200000;
      const maxTokens = 65536;

      const buildProvider = (models) => ({
        displayName: "Qoder CN",
        api: "openai-completions",
        baseURL: BASE,
        apiKeyEnv: KEY_REF,
        models: models.map((id) => ({
          id,
          name: displayNameOf(id),
          contextWindow,
          maxTokens,
          // 网关走的是 CLI 的 -p <prompt>，没有多模态入口。声明 text 才不会被
          // 塞图片块；给了 image 反而会让请求在上游失败。
          input: ["text"]
        }))
      });

      /** 问网关它现在暴露哪些模型。失败返回 null —— 和「网关活着但零模型」区分开。 */
      const gatewayModels = async () => {
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), 5000);
        try {
          const res = await fetch(BASE + "/models", { signal: ac.signal });
          if (!res.ok) return null;
          const json = await res.json();
          const ids = (json && Array.isArray(json.data) ? json.data : [])
            .map((m) => m && m.id)
            .filter((x) => typeof x === "string" && x.length > 0);
          return ids.length > 0 ? ids : null;
        } catch {
          return null;
        } finally {
          clearTimeout(timer);
        }
      };

      /** 凭据服务是可选的：拿不到就让用户自己补，不要因此让整个端点不可用。 */
      const credentialService = () => {
        try { return hostCtx.get ? hostCtx.get("credentials") : undefined; } catch { return undefined; }
      };

      /** 读 profile 层当前声明的 provider。没配过就是 null。 */
      //
      // 不假设外部服务返回什么形状 —— 读不到就降级成结构化错误，
      // 别让异常冒到 HTTP 层。端点整个挂掉比报一条清楚的错难查得多。
      const readState = () => {
        let rows;
        try {
          rows = hostCtx.settings.describe();
        } catch (e) {
          return { error: "读取配置失败：" + ((e && e.message) || e) };
        }
        if (!Array.isArray(rows)) return { error: "settings.describe() 没有返回数组" };
        const row = rows.find((r) => r.ns === SETTINGS_NS);
        if (!row) return { error: "profile 里没有 " + SETTINGS_NS + " 这一行，请先按 README 建好它" };
        const routes = (row.user && row.user.providers) || {};
        return {
          revision: row.revision,
          routes: Object.keys(routes),
          provider: routes[ROUTE] ?? null
        };
      };

      hostCtx.effect(() => hostCtx.webServer.register({
        kind: "exact",
        path: "/qoder-relay/wire",
        handler: async (request, response) => {
          const send = (code, obj) => {
            response.writeHead(code, {
              "content-type": "application/json; charset=utf-8",
              "cache-control": "no-store"
            });
            response.end(JSON.stringify(obj));
          };

          if (request.method !== "GET" && request.method !== "POST") {
            return send(405, { ok: false, error: "use GET or POST" });
          }

          const state = readState();
          if (state.error) return send(200, { ok: false, error: state.error });

          const models = await gatewayModels();
          const have = (state.provider && Array.isArray(state.provider.models) ? state.provider.models : [])
            .map((m) => m && m.id)
            .filter((x) => typeof x === "string");
          const want = models ?? [];

          const creds = credentialService();
          let credentialSet = false;
          if (creds && typeof creds.resolve === "function") {
            try { credentialSet = Boolean((await creds.resolve(KEY_REF))?.value); } catch { /* 视为未设置 */ }
          }

          const status = {
            baseURL: BASE,
            gatewayUp: models !== null,
            gatewayModels: want,
            providerExists: state.provider !== null,
            declaredModels: have,
            otherRoutes: state.routes.filter((r) => r !== ROUTE),
            missing: want.filter((id) => have.indexOf(id) === -1),
            extra: have.filter((id) => want.indexOf(id) === -1),
            credentialSet,
            credentialRef: KEY_REF
          };

          if (request.method === "GET") return send(200, { ok: true, ...status });

          // ---- POST：真正写入 ----
          let body = {};
          try {
            const chunks = [];
            for await (const c of request) chunks.push(c);
            body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
          } catch { /* 空体 = 默认模式 */ }
          const replace = body && body.mode === "replace";

          if (!models) {
            return send(200, { ok: false, code: "GATEWAY_DOWN", ...status,
              error: "网关没有响应（" + BASE + "/models）。先确认它起来了再接入。" });
          }

          // 已存在就不动它 —— 覆盖是破坏性动作，必须用户显式要求。
          if (state.provider && !replace) {
            return send(200, { ok: false, code: "EXISTS", ...status,
              error: "providers." + ROUTE + " 已经存在。要覆盖请传 {\"mode\":\"replace\"}" });
          }

          try {
            await hostCtx.settings.mutate(SETTINGS_NS, [
              { op: "set", path: ["providers", ROUTE], value: buildProvider(models) }
            ], state.revision);
          } catch (e) {
            const code = (e && (e.code || e.name)) || "ERROR";
            warn("模型路由写入失败: " + code + " " + (e && e.message));
            return send(200, { ok: false, code, error: (e && e.message) || String(e), ...status });
          }

          // 凭证只在缺失时补占位值，绝不覆盖用户已有的。
          let credentialWritten = false;
          let credentialError = null;
          if (!credentialSet && creds && typeof creds.set === "function") {
            try { await creds.set(KEY_REF, PLACEHOLDER_KEY); credentialWritten = true; }
            catch (e) { credentialError = (e && e.message) || String(e); }
          }

          log("模型路由已接入：providers." + ROUTE + "（" + models.length + " 个模型）");
          if (credentialWritten) log("已补上占位凭证 " + KEY_REF + "。");
          if (credentialError) warn("凭证写入失败，需要手工加 " + KEY_REF + "：" + credentialError);

          return send(200, {
            ok: true,
            wrote: ROUTE,
            modelCount: models.length,
            mode: state.provider ? "replace" : "create",
            credentialWritten,
            credentialError,
            ...status
          });
        }
      }, "qoder-relay: wire"));
      log("模型路由接入已就绪（GET/POST /qoder-relay/wire）。");
    });
  } else {
    warn("ctx.inject 不可用，模型路由接入未启用。");
  }
  /* ─────────────────── 自更新（借宿主 pluginManager）─────────────────── */
  //
  // 设置页的版本卡片原来只能「检查更新」，点开还要自己去插件页动手。
  // 这里把 DSH 官方的 pluginManager.installBundle() 接出来，让卡片能一键更新。
  //
  // 三条硬约束（都有原因，别随手改）：
  //   1. 服务不能直接取值。webServer / pluginManager 都可能比本插件晚就绪，
  //      直接 ctx.pluginManager 会拿到 undefined 或抛错。必须用 ctx.inject()，
  //      等服务可用时才跑回调 —— 这是官方 dsh-purge 的做法。
  //   2. 路由必须注册在 host.effect() 里，返回值即 teardown，热重载才不泄漏。
  //   3. installBundle 走的是 dsh plugin 同一套 pnpm，成败由它决定；
  //      本插件只负责发起和如实回报，不伪造状态。
  if (ctx && typeof ctx.inject === "function") {
    ctx.inject(["webServer", "pluginManager"], (host) => {
      const pm = host.pluginManager;
      if (!pm || typeof pm.installBundle !== "function") {
        warn("宿主未提供 pluginManager.installBundle，一键更新不可用。");
        return;
      }
      const defaultSpec = cfg.updateSpec || "github:ccccqiang/dsh-qoder-relay";
      host.effect(() => host.webServer.register({
        kind: "exact",
        path: "/qoder-relay/update",
        handler: async (request, response) => {
          const send = (code, obj) => {
            response.writeHead(code, {
              "content-type": "application/json; charset=utf-8",
              "cache-control": "no-store"
            });
            response.end(JSON.stringify(obj));
          };
          if (request.method !== "POST") return send(405, { ok: false, error: "use POST" });

          let body = {};
          try {
            const chunks = [];
            for await (const c of request) chunks.push(c);
            body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
          } catch {}
          const spec = typeof body.spec === "string" && body.spec.trim() ? body.spec.trim() : defaultSpec;

          try {
            log(`开始更新: ${spec}`);
            const out = await pm.installBundle(spec, { activate: true });
            const ok = !(out && out.activation && out.activation.ok === false);
            log(`更新完成 ok=${ok}`);
            send(200, { ok, spec, result: out ?? null });
          } catch (e) {
            const msg = (e && e.message) ? e.message : String(e);
            warn(`更新失败: ${msg}`);
            send(200, { ok: false, spec, error: msg });
          }
        }
      }, "qoder-relay: update"));
      log("一键更新已就绪（POST /qoder-relay/update）。");
    });
  } else {
    warn("ctx.inject 不可用，一键更新未启用。");
  }

  start().catch((e) => warn(`启动流程异常: ${e.message}`));
}

export default { name, apply };