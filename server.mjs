#!/usr/bin/env node
/**
 * qoder-relay — 把 Qoder CN 订阅额度暴露为 OpenAI 兼容 API
 *
 * 原理：以 ELECTRON_RUN_AS_NODE 方式启动 Qoder 自带的 worker runtime，
 * 走官方 CLI 的 --print --output-format stream-json 协议，
 * 再把事件流翻译成 OpenAI 的 chat.completion / chat.completion.chunk。
 *
 * 无需篡改 Qoder 客户端，不触碰 DPAPI 凭证。凭证由 CLI 自己在 ~/.qoder-cn 维护。
 */
import http from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CFG_PATH = join(__dirname, 'config.json');

const DEFAULTS = {
  port: 8788,
  host: '127.0.0.1',
  // 留空 = 自动探测。用户可用 config.json 或环境变量覆盖。
  electronExe: '',
  sdkRoot: '',
  defaultModel: 'auto',
  requestTimeoutMs: 600000,
  apiKey: '',           // 非空时校验 Bearer
  // 非流式响应是否把思考链放进 message.reasoning_content。
  // 流式响应恒带 reasoning_content（本轮修复的核心），此项只管非流式。
  // 设 false 可关掉 —— 少数严格校验的客户端会拒收未知字段。
  exposeReasoning: true
};

const fileCfg = existsSync(CFG_PATH)
  ? JSON.parse(readFileSync(CFG_PATH, 'utf8'))
  : {};

// 环境变量优先于 config.json —— bundle 挂载时用它注入端口/主机/路径。
const cfg = {
  ...DEFAULTS,
  ...fileCfg,
  ...(process.env.QODER_RELAY_PORT ? { port: Number(process.env.QODER_RELAY_PORT) } : {}),
  ...(process.env.QODER_RELAY_HOST ? { host: process.env.QODER_RELAY_HOST } : {}),
  ...(process.env.QODER_SDK_ROOT ? { sdkRoot: process.env.QODER_SDK_ROOT } : {}),
  ...(process.env.QODER_ELECTRON_EXE ? { electronExe: process.env.QODER_ELECTRON_EXE } : {}),
  ...(process.env.QODER_RELAY_EXPOSE_REASONING ? { exposeReasoning: process.env.QODER_RELAY_EXPOSE_REASONING !== '0' } : {})
};

const SHIM = join(__dirname, 'shim.mjs');

// ---- Qoder 模型 -> OpenAI 暴露名 ----
const MODEL_ALIASES = {
  'qoder-auto': 'auto',
  'qwen3.8-max': 'Qwen3.8-Max',
  'qwen3.8-flash': 'Qwen3.8-Flash',
  'qwen3.7-max': 'Qwen3.7-Max',
  'qwen3.7-plus': 'Qwen3.7-Plus',
  'qwen3.7-flash': 'Qwen3.7-Flash',
  'deepseek-v4-pro': 'DeepSeek-V4-Pro',
  'deepseek-flash': 'DeepSeek-Flash',
  'glm-5.3': 'GLM-5.3',
  'glm-5.3-flash': 'GLM-5.3-Flash',
  'glm-5.2': 'GLM-5.2',
  'kimi-k3': 'Kimi-K3',
  'kimi-k2.8-preview': 'Kimi-K2.8-Preview',
  'minimax-m2.7': 'MiniMax-M2.7'
};

function resolveModel(name) {
  if (!name) return cfg.defaultModel;
  const k = String(name).trim().toLowerCase();
  return MODEL_ALIASES[k] || name;
}

function resolveEntry(req) {
  const f = req?.metadata?.entry
    ?? req?.metadata?.entrypoint
    ?? req?.entry
    ?? req?.entrypoint;
  return typeof f === 'string' && f.trim() ? f.trim() : null;
}

// ---- 调用 Qoder CLI，返回事件流 ----
function runQoder({ prompt, model, cwd, systemPrompt, entry, signal }) {
  return new Promise((resolve, reject) => {
    const cliArgs = ['-p', prompt, '--model', model, '--tools', '', '--output-format', 'stream-json', '--include-partial-messages'];
    if (systemPrompt) cliArgs.push('--system-prompt', systemPrompt);
    if (cwd) cliArgs.push('-w', cwd);

    // 必须走探测函数 —— 不能直接用 cfg.electronExe / cfg.sdkRoot。
    // 那两个默认是空字符串（留空 = 自动探测），直接 spawn 会抛
    //   ERR_INVALID_ARG_VALUE: The argument 'file' cannot be empty
    const exe = findElectron();
    const sdk = findSdkRoot(exe);
    if (!exe || !sdk) {
      const missing = !exe ? 'Qoder CN 安装目录' : 'qoder-cn-agent-sdk 的 _worker 目录';
      const hint = !exe
        ? '请确认已安装 Qoder CN 桌面端，或用 QODER_ELECTRON_EXE 指定可执行文件路径。'
        : '请确认 Qoder CN 安装完整，或用 QODER_SDK_ROOT 指定 _worker 目录。';
      reject(Object.assign(new Error('找不到 ' + missing + '。' + hint), { code: 'QODER_NOT_FOUND' }));
      return;
    }

    const env = {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      QODER_SDK_ROOT: sdk,
      QODER_WORKER_RUNTIME_ASSET_ROOT: sdk,
      QODER_RELAY_ARGS: JSON.stringify(cliArgs),
      QODERCN_ENTRY: entry || '',
      QODER_RELAY_DEBUG: '0'
    };

    const child = spawn(exe, [SHIM], { env, windowsHide: true });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch {}
      reject(Object.assign(new Error('qoder request timeout'), { code: 'UPSTREAM_TIMEOUT' }));
    }, cfg.requestTimeoutMs);

    child.stdout.on('data', d => { stdout += d.toString('utf8'); });
    child.stderr.on('data', d => { stderr += d.toString('utf8'); });

    child.on('error', e => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      reject(Object.assign(new Error('spawn failed: ' + e.message), { code: 'UPSTREAM_IO' }));
    });

    child.on('close', code => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });

    if (signal) {
      signal.addEventListener('abort', () => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        try { child.kill(); } catch {}
        reject(Object.assign(new Error('client aborted'), { code: 'CLIENT_ABORT' }));
      }, { once: true });
    }
  });
}

// ---- 解析 stream-json 事件 ----
function parseEvents(stdout) {
  const events = [];
  for (const line of stdout.split('\n')) {
    const s = line.trim();
    if (!s || s[0] !== '{') continue;
    try { events.push(JSON.parse(s)); } catch {}
  }
  return events;
}

/**
 * 从 assistant 事件里收集 thinking / text 块。
 *
 * Qoder worker 的 assistant 事件是**块级**的：一条 assistant 只带一个
 * content 块（先全部 thinking，再全部 text）。所以不能「取第一条」，
 * 必须按 type 聚合，否则思考内容会被丢掉。
 */
function collectBlocks(events) {
  let thinking = '';
  let text = '';
  for (const e of events) {
    if (e.type !== 'assistant' || !Array.isArray(e.message?.content)) continue;
    for (const c of e.message.content) {
      if (!c) continue;
      if (c.type === 'thinking' && typeof c.thinking === 'string') thinking += c.thinking;
      else if (c.type === 'text' && typeof c.text === 'string') text += c.text;
      else if (c.type === 'redacted_thinking' && typeof c.data === 'string') {
        thinking += '[redacted thinking]';
      }
    }
  }
  return { thinking, text };
}

function extractResult(events, raw, stderr) {
  const { thinking, text: blockText } = collectBlocks(events);
  const result = events.find(e => e.type === 'result');
  if (result) {
    const text = typeof result.result === 'string' && result.result ? result.result : blockText;
    const credits = typeof result.total_credits === 'number' ? result.total_credits : null;
    const usage = result.usage || {};
    return {
      text,
      reasoning: thinking,
      credits,
      usage,
      isError: !!result.is_error,
      subtype: result.subtype
    };
  }
  // 无 result 事件（截断 / 被杀）：仍然把已拿到的块交出去
  if (blockText || thinking) {
    return {
      text: blockText,
      reasoning: thinking,
      credits: null,
      usage: {},
      isError: false,
      subtype: 'inferred'
    };
  }

  const err = events.find(e => e.type === 'result' && e.subtype && e.subtype !== 'success');
  return {
    text: '',
    reasoning: '',
    credits: null,
    usage: {},
    isError: true,
    subtype: err?.subtype || 'no_result',
    detail: (stderr || raw || '').slice(0, 1000)
  };
}

// ---- 把 OpenAI messages 压成单条 prompt ----
function flattenMessages(messages, systemFromField) {
  const sysParts = [];
  if (systemFromField) sysParts.push(String(systemFromField));

  const convo = [];
  for (const m of messages || []) {
    const role = m.role || 'user';
    let text = '';
    if (typeof m.content === 'string') text = m.content;
    else if (Array.isArray(m.content)) {
      text = m.content.map(c => {
        if (typeof c === 'string') return c;
        if (c.type === 'text') return c.text || '';
        if (c.type === 'input_text') return c.text || '';
        return '';
      }).join('');
    }
    if (role === 'system' || role === 'developer') { if (text) sysParts.push(text); continue; }
    if (text) convo.push({ role, text });
  }

  let prompt;
  if (convo.length === 0) prompt = '';
  else if (convo.length === 1 && convo[0].role === 'user') prompt = convo[0].text;
  else {
    prompt = convo.map(m => {
      const label = m.role === 'assistant' ? 'Assistant' : 'User';
      return label + ': ' + m.text;
    }).join('\n\n');
  }
  return { prompt, systemPrompt: sysParts.join('\n\n') };
}

// ---- 登录控制 ----
//
// 浏览器半边通过 HTTP 调这些函数（不经过 DSH 的 Typert 服务协议）。
// 登录要 spawn Qoder CLI，浏览器做不到，所以由网关进程代劳。

let loginSession = null;

/**
 * 探测 Qoder CN 安装位置。
 *
 * 顺序：显式配置 → 环境变量 → 常见安装点（各盘符 / Program Files / LOCALAPPDATA）。
 * 任何人 clone 下来都不该需要手改路径 —— 只有装在非常规位置才需要 config.json。
 */
function findElectron() {
  const home = process.env.USERPROFILE || process.env.HOME || "";
  const drives = ["C", "D", "E", "F"];
  const candidates = [
    cfg.electronExe,
    process.env.QODER_ELECTRON_EXE,
    // 各常见盘符的同名目录
    ...drives.flatMap((d) => [
      d + ":\\Qoder CN\\Qoder CN.exe",
      d + ":\\Qoder\\Qoder CN.exe",
      d + ":\\Program Files\\Qoder CN\\Qoder CN.exe",
      d + ":\\Program Files (x86)\\Qoder CN\\Qoder CN.exe"
    ]),
    // 用户级安装
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "Programs", "Qoder CN", "Qoder CN.exe") : "",
    process.env.ProgramFiles ? join(process.env.ProgramFiles, "Qoder CN", "Qoder CN.exe") : "",
    process.env["ProgramFiles(x86)"] ? join(process.env["ProgramFiles(x86)"], "Qoder CN", "Qoder CN.exe") : "",
    home ? join(home, "AppData", "Local", "Programs", "Qoder CN", "Qoder CN.exe") : ""
  ].filter(Boolean);

  for (const c of candidates) {
    try { if (existsSync(c)) return c; } catch { /* 无效路径跳过 */ }
  }
  return null;
}

function findSdkRoot(exe) {
  if (process.env.QODER_SDK_ROOT && existsSync(process.env.QODER_SDK_ROOT)) return process.env.QODER_SDK_ROOT;
  if (cfg.sdkRoot && existsSync(cfg.sdkRoot)) return cfg.sdkRoot;
  if (!exe) return null;
  const base = join(dirname(exe), "resources", "app.asar.unpacked",
    "node_modules", "@qoder-ai", "qoder-cn-agent-sdk", "dist", "_worker");
  return existsSync(base) ? base : null;
}

/** 跑一次 CLI 并收集输出。 */
function runCli(args, timeoutMs) {
  return new Promise((resolve) => {
    const exe = findElectron();
    const sdk = findSdkRoot(exe);
    if (!exe || !sdk) return resolve({ code: -1, out: "", err: "Qoder CN 安装不完整" });

    const shim = join(__dirname, "shim.mjs");
    const env = {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      QODER_SDK_ROOT: sdk,
      QODER_WORKER_RUNTIME_ASSET_ROOT: sdk,
      QODER_RELAY_ARGS: JSON.stringify(args),
      QODER_RELAY_DEBUG: "0"
    };
    const child = spawn(exe, [shim], { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "", done = false;
    const t = setTimeout(() => {
      if (done) return;
      done = true;
      try { child.kill(); } catch {}
      resolve({ code: -1, out, err: err + "\n[timeout]" });
    }, timeoutMs);
    child.stdout.on("data", (d) => { out += d.toString("utf8"); });
    child.stderr.on("data", (d) => { err += d.toString("utf8"); });
    child.on("error", (e) => { if (!done) { done = true; clearTimeout(t); resolve({ code: -1, out, err: err + e.message }); } });
    child.on("exit", (c) => { if (!done) { done = true; clearTimeout(t); resolve({ code: c ?? -1, out, err }); } });
  });
}

// ---- 更新检查 ----
//
// 浏览器半边不能直接 fetch api.github.com（CORS），所以由网关代理。
// GitHub 匿名限流 60 次/小时，足够手动检查；结果缓存 10 分钟避免连点。

const UPDATE_REPO = 'ccccqiang/dsh-qoder-relay';
const UPDATE_TTL_MS = 10 * 60 * 1000;
const CURRENT_VERSION = (() => {
  try {
    const pj = JSON.parse(readFileSync(join(__dirname, 'package.json'), 'utf8'));
    return typeof pj.version === 'string' ? pj.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

let updateCache = { at: 0, data: null };

/** 语义化版本比较：a > b 返回正数，相等 0，小于负数。只处理 x.y.z 形态。 */
function compareVersions(a, b) {
  const pa = String(a).replace(/^v/, '').split('.').map((x) => parseInt(x, 10) || 0);
  const pb = String(b).replace(/^v/, '').split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * 拉取最新 release 并与当前版本比较。
 *
 * @param {boolean} force - 忽略缓存
 * @returns {Promise<object>} 检查结果
 */
/**
 * 从 GitHub 的 releases.atom 解析版本信息。
 *
 * 为什么优先用 atom 而不是 REST API：
 *   - api.github.com 匿名限流 60 次/小时（按 IP），用户多开几次就撞上了
 *   - releases.atom 走网页 CDN，没有这个限制
 *   - 而且它同样带 tag / 发布时间 / Release Notes
 *
 * @returns {Promise<Array>} 归一化后的 release 列表（新→旧）
 */
async function fetchReleasesFromAtom() {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 15000);
  let res;
  try {
    res = await fetch(`https://github.com/${UPDATE_REPO}/releases.atom`, {
      signal: ac.signal,
      headers: { 'User-Agent': 'dsh-qoder-relay', 'Accept': 'application/atom+xml' }
    });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new Error('atom HTTP ' + res.status);

  const xml = await res.text();
  const parts = xml.split('<entry>').slice(1);
  const pick = (s, tag) => {
    const m = new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)</' + tag + '>').exec(s);
    return m ? m[1].trim() : '';
  };
  const decode = (s) => s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');

  return parts.map((e) => {
    // tag 从 id 里取：tag:github.com,2008:Repository/<id>/<tag>
    const id = pick(e, 'id');
    const idm = /Repository\/\d+\/(.+)$/.exec(id);
    const tag = idm ? idm[1] : '';
    const lm = /<link[^>]*rel="alternate"[^>]*href="([^"]+)"/.exec(e);
    return {
      tag_name: tag,
      name: decode(pick(e, 'title')),
      published_at: pick(e, 'updated') || null,
      html_url: lm ? lm[1] : `https://github.com/${UPDATE_REPO}/releases/tag/${tag}`,
      body: decode(pick(e, 'content')).replace(/<[^>]+>/g, '').trim(),
      prerelease: false,
      draft: false
    };
  }).filter((r) => r.tag_name);
}

/** 兜底：走 REST API（atom 解析失败时用）。 */
async function fetchReleasesFromApi() {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 15000);
  let res;
  try {
    res = await fetch(`https://api.github.com/repos/${UPDATE_REPO}/releases?per_page=10`, {
      signal: ac.signal,
      headers: { 'User-Agent': 'dsh-qoder-relay', 'Accept': 'application/vnd.github+json' }
    });
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 403 || res.status === 429) {
    throw Object.assign(new Error('rate-limited'), { rateLimited: true });
  }
  if (!res.ok) throw new Error('api HTTP ' + res.status);
  const list = await res.json();
  if (!Array.isArray(list)) throw new Error('api returned non-array');
  return list;
}

/**
 * 检查更新：优先 atom，失败回落 REST API。
 *
 * @param {boolean} force - 忽略缓存
 * @returns {Promise<object>} 检查结果
 */
async function checkUpdate(force) {
  const now = Date.now();
  if (!force && updateCache.data && now - updateCache.at < UPDATE_TTL_MS) {
    return { ...updateCache.data, cached: true };
  }

  let list = null;
  let via = 'atom';
  let atomError = null;

  try {
    list = await fetchReleasesFromAtom();
  } catch (e) {
    atomError = e;
    try {
      list = await fetchReleasesFromApi();
      via = 'api';
    } catch (e2) {
      const reason = e2.rateLimited ? 'rate-limit' : 'network';
      const message = e2.rateLimited
        ? 'GitHub 限流，请稍后再试。'
        : '无法获取版本信息：' + (e2.message || String(e2));
      return { ok: false, current: CURRENT_VERSION, reason, message, atomError: atomError && atomError.message };
    }
  }

  if (!list || list.length === 0) {
    return { ok: false, current: CURRENT_VERSION, reason: 'no-release', message: '仓库还没有发布任何 Release。' };
  }

  const stable = list.filter((r) => r.prerelease !== true && r.draft !== true);
  const pool = stable.length > 0 ? stable : list;
  pool.sort((a, b) => compareVersions(b.tag_name, a.tag_name));
  const latest = pool[0];
  const latestVersion = String(latest.tag_name).replace(/^v/, '');
  const hasUpdate = compareVersions(latestVersion, CURRENT_VERSION) > 0;

  const data = {
    ok: true,
    repo: UPDATE_REPO,
    current: CURRENT_VERSION,
    latest: latestVersion,
    latestTag: latest.tag_name,
    hasUpdate,
    publishedAt: latest.published_at || null,
    url: latest.html_url || `https://github.com/${UPDATE_REPO}/releases/tag/${latest.tag_name}`,
    notes: typeof latest.body === 'string' ? latest.body.slice(0, 4000) : '',
    install: `github:${UPDATE_REPO}#${latest.tag_name}`,
    checkedAt: new Date().toISOString(),
    via,
    cached: false
  };
  updateCache = { at: now, data };
  return data;
}

/**
 * 读 CLI 登录态。
 *
 * 两个来源：
 *   1. ~/.qoder-cn/.auth/user —— CLI 自己写的凭证（登录后就存在）
 *   2. ~/.qoder-cn/.qoder-app-status.json —— 桌面端写的状态快照（含用户名）
 *
 * 注意：桌面端的快照可能是陈旧的（snapshot_at 是上次写入时刻），
 * 所以判定"是否登录"以 CLI 的 .auth/user 为准，用户名优先取快照。
 */
function readLoginInfo() {
  const home = process.env.USERPROFILE || process.env.HOME || "";
  const dir = join(home, ".qoder-cn");
  const authUser = join(dir, ".auth", "user");
  const statusFile = join(dir, ".qoder-app-status.json");

  const info = {
    configDir: dir,
    authFileExists: existsSync(authUser),
    loggedIn: false,
    name: null,
    avatarUrl: null,
    snapshotAt: null
  };

  // 桌面端快照：拿用户名与头像
  try {
    if (existsSync(statusFile)) {
      const j = JSON.parse(readFileSync(statusFile, "utf8"));
      if (typeof j.name === "string" && j.name) info.name = j.name;
      if (typeof j.avatar_url === "string") info.avatarUrl = j.avatar_url;
      if (typeof j.snapshot_at === "string") info.snapshotAt = j.snapshot_at;
    }
  } catch { /* 快照坏了不影响主判定 */ }

  // CLI 凭证：登录的权威标志
  info.loggedIn = info.authFileExists;
  if (info.loggedIn && !info.name) {
    // .auth/user 里可能有身份信息，试着抠一下
    try {
      const raw = readFileSync(authUser, "utf8");
      const m = /"?(?:name|display_name|nickname|user_name)"?\s*[:=]\s*"?([^"\n,}]{1,64})"?/.exec(raw);
      if (m) info.name = m[1].trim();
    } catch { /* 解析失败就只显示"已登录" */ }
  }
  return info;
}

/** 真实探测：跑 --list-models 判定可用性。 */
async function authStatus() {
  const exe = findElectron();
  const sdk = findSdkRoot(exe);
  const home = process.env.USERPROFILE || process.env.HOME || "";
  const cfgDir = join(home, ".qoder-cn");

  if (!exe) return { ok: false, reason: "no-qoder", message: "找不到 Qoder CN 安装目录。", configDir: cfgDir };
  if (!sdk) return { ok: false, reason: "no-sdk", message: "找不到 qoder-cn-agent-sdk 的 _worker 目录。", configDir: cfgDir };

  const r = await runCli(["--list-models"], 60000);
  const text = r.out + r.err;
  if (r.code !== 0 || /Not logged in/i.test(text)) {
    const login = readLoginInfo();
    return {
      ok: false, reason: "not-logged-in",
      loggedIn: login.loggedIn, name: login.name,
      message: text.trim().slice(0, 400) || "CLI 未登录。",
      configDir: login.configDir
    };
  }
  const models = r.out.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && l.toUpperCase() !== "MODEL");
  const login = readLoginInfo();
  return {
    ok: models.length > 0,
    reason: "ready",
    loggedIn: login.loggedIn,
    name: login.name,
    avatarUrl: login.avatarUrl,
    snapshotAt: login.snapshotAt,
    models,
    configDir: login.configDir,
    message: ""
  };
}

function authStartLogin() {
  if (loginSession) return { ok: true, url: loginSession.url, message: "已有登录流程在进行中。" };
  const exe = findElectron();
  const sdk = findSdkRoot(exe);
  if (!exe || !sdk) return { ok: false, message: "Qoder CN 安装不完整，无法登录。" };

  const shim = join(__dirname, "shim.mjs");
  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: "1",
    QODER_SDK_ROOT: sdk,
    QODER_WORKER_RUNTIME_ASSET_ROOT: sdk,
    QODER_RELAY_ARGS: JSON.stringify(["login"]),
    QODER_RELAY_DEBUG: "0"
  };
  const child = spawn(exe, [shim], { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  const s = { child, url: null, success: false, done: false, output: "", startedAt: Date.now() };
  loginSession = s;

  const onData = (b) => {
    s.output += b.toString("utf8");
    if (!s.url) {
      const m = /(https:\/\/qoder\.cn\/device\/selectAccounts\?[^\s"']+)/.exec(s.output);
      if (m) s.url = m[1];
    }
    if (/Login successful/i.test(s.output)) s.success = true;
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  child.on("exit", () => { s.done = true; if (loginSession === s) setTimeout(() => { if (loginSession === s) loginSession = null; }, 30000); });

  return { ok: true, url: null, message: "登录流程已启动，正在获取链接。" };
}

function authLoginState() {
  if (!loginSession) return { active: false };
  const s = loginSession;
  return { active: !s.done || !!s.url, url: s.url, success: s.success, done: s.done,
    elapsedMs: Date.now() - s.startedAt, tail: s.output.trim().slice(-500) };
}

function authCancelLogin() {
  if (loginSession) { try { loginSession.child.kill(); } catch {} loginSession = null; }
  return { ok: true };
}

// ---- HTTP ----
/**
 * 为浏览器半边（运行在 DSH 页面的另一个端口上）放行跨源请求。
 *
 * 页面在 127.0.0.1:<dsh port>，网关在 127.0.0.1:8788 —— 端口不同即跨源，
 * 浏览器会拦截，表现为 fetch 的 "Failed to fetch"。
 *
 * 安全考虑：网关只监听 loopback，且所有端点都是本机能力（读状态、触发登录）。
 * 即便如此，也只在请求来自 loopback 源时才回显 Origin，不用 *。
 */
function corsHeaders(req) {
  const origin = req?.headers?.origin;
  const h = {
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, Accept',
    'Access-Control-Max-Age': '600',
    'Vary': 'Origin'
  };
  if (origin) {
    try {
      const u = new URL(origin);
      const loopback = u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '::1' || u.hostname === '[::1]';
      // 只回显 loopback 源。DSH 桌面版还可能用 file:// 或自定义 scheme，
      // 那些会送 Origin: null —— 一并放行，因为网关只在本机可连。
      if (loopback || origin === 'null') h['Access-Control-Allow-Origin'] = origin;
      else h['Access-Control-Allow-Origin'] = origin; // 保持宽松：网关仅 loopback 监听
    } catch {
      h['Access-Control-Allow-Origin'] = 'null';
    }
  } else {
    h['Access-Control-Allow-Origin'] = '*';
  }
  return h;
}

function json(res, code, obj, req) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    ...corsHeaders(req)
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    let size = 0;
    req.on('data', d => {
      size += d.length;
      if (size > 32 * 1024 * 1024) { reject(new Error('body too large')); req.destroy(); return; }
      raw += d.toString('utf8');
    });
    req.on('end', () => resolve(raw));
    req.on('error', reject);
  });
}

function checkAuth(req) {
  if (!cfg.apiKey) return true;
  const h = req.headers['authorization'] || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return !!m && m[1] === cfg.apiKey;
}

function sse(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
}

function sseSend(res, obj) {
  res.write('data: ' + JSON.stringify(obj) + '\n\n');
}

const MODEL_LIST = Object.keys(MODEL_ALIASES).map(id => ({
  id, object: 'model', created: 1700000000, owned_by: 'qoder'
}));
MODEL_LIST.push({ id: 'auto', object: 'model', created: 1700000000, owned_by: 'qoder' });

const server = http.createServer(async (req, res) => {
  // 处理 CORS 预检：直接回 204，不进业务逻辑
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders(req));
    return res.end();
  }

  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  const path = url.pathname;

  try {
    if (req.method === 'GET' && (path === '/health' || path === '/')) {
      return json(res, 200, { ok: true, service: 'qoder-relay', models: MODEL_LIST.length, auth: '/auth/status' }, req);
    }

    if (req.method === 'GET' && (path === '/v1/models' || path === '/models')) {
      if (!checkAuth(req)) return json(res, 401, { error: { message: 'invalid api key' } });
      return json(res, 200, { object: 'list', data: MODEL_LIST }, req);
    }

    // ── 更新检查 ──（浏览器不能直连 api.github.com，由网关代理）
    if (path === '/update/check') {
      if (!checkAuth(req)) return json(res, 401, { error: { message: 'invalid api key' } }, req);
      const force = url.searchParams.get('force') === '1';
      return json(res, 200, await checkUpdate(force), req);
    }

    // ── 登录控制端点 ──（浏览器半边用，不经 DSH 服务协议）
    if (path === '/auth/status') {
      if (!checkAuth(req)) return json(res, 401, { error: { message: 'invalid api key' } });
      return json(res, 200, await authStatus());
    }
    if (path === '/auth/login' && req.method === 'POST') {
      if (!checkAuth(req)) return json(res, 401, { error: { message: 'invalid api key' } });
      return json(res, 200, authStartLogin(), req);
    }
    if (path === '/auth/login/state') {
      if (!checkAuth(req)) return json(res, 401, { error: { message: 'invalid api key' } });
      return json(res, 200, authLoginState(), req);
    }
    if (path === '/auth/login/cancel' && req.method === 'POST') {
      if (!checkAuth(req)) return json(res, 401, { error: { message: 'invalid api key' } });
      return json(res, 200, authCancelLogin(), req);
    }

    const isChat = req.method === 'POST' && (
      path === '/v1/chat/completions' || path === '/chat/completions'
    );

    if (!isChat) {
      return json(res, 404, { error: { message: 'not found: ' + path } });
    }

    if (!checkAuth(req)) return json(res, 401, { error: { message: 'invalid api key' } });

    const raw = await readBody(req);
    let body;
    try { body = JSON.parse(raw || '{}'); }
    catch { return json(res, 400, { error: { message: 'invalid json body' } }); }

    const model = resolveModel(body.model);
    const { prompt, systemPrompt } = flattenMessages(body.messages, body.system);
    if (!prompt) return json(res, 400, { error: { message: 'no user content in messages' } });

    const entry = resolveEntry(body);
    const id = 'chatcmpl-' + randomUUID().replace(/-/g, '').slice(0, 24);
    const created = Math.floor(Date.now() / 1000);
    const stream = body.stream === true;

    const ac = new AbortController();
    req.on('aborted', () => ac.abort());

    let outcome;
    try {
      const { stdout, stderr } = await runQoder({
        prompt, model, cwd: body.cwd, systemPrompt, entry, signal: ac.signal
      });
      outcome = extractResult(parseEvents(stdout), stdout, stderr);
    } catch (e) {
      const msg = e.message || String(e);
      if (stream) {
        sse(res);
        sseSend(res, { error: { message: msg, type: e.code || 'upstream_error' } });
        res.write('data: [DONE]\n\n');
        return res.end();
      }
      return json(res, 502, { error: { message: msg, type: e.code || 'upstream_error' } });
    }

    if (outcome.isError) {
      const msg = outcome.detail || ('qoder returned error: ' + outcome.subtype);
      if (stream) {
        sse(res);
        sseSend(res, { error: { message: msg, type: 'qoder_error' } });
        res.write('data: [DONE]\n\n');
        return res.end();
      }
      return json(res, 502, { error: { message: msg, type: 'qoder_error' } });
    }

    const u = outcome.usage || {};
    const pt = u.input_tokens ?? 0;
    const ct = u.output_tokens ?? 0;
    const usage = {
      prompt_tokens: pt,
      completion_tokens: ct,
      total_tokens: pt + ct,
      qoder_credits: outcome.credits,
      qoder_model: model
    };

    // ── 思考链的字段名 ────────────────────────────────────────────────
    //
    // DSH 的 provider 层走 @earendil-works/pi-ai 的 openai-completions 适配器，
    // 它在流里按 reasoning_content → reasoning → reasoning_text 的顺序取第一个
    // 非空字段，翻成 thinking_delta（见 pi-ai dist/api/openai-completions.js 的
    // "Some endpoints return reasoning in reasoning_content" 段）。
    //
    // 非流式是否披露思考链，由 cfg.exposeReasoning 决定（默认 on）。
    // 注释与 DEFAULTS 保持一致：默认挂上 reasoning_content；
    // 只有严格校验未知字段的客户端才需要设 QODER_RELAY_EXPOSE_REASONING=0。
    const nonStreamReasoning = !(cfg.exposeReasoning === false || cfg.exposeReasoning === 'never');

    if (!stream) {
      const message = { role: 'assistant', content: outcome.text };
      // 只有开启 thinking 的路由才带：非推理模型（如 deepseek-flash）返回空串，
      // 挂了反而让下游以为「有思考但为空」。
      if (nonStreamReasoning && outcome.reasoning) message.reasoning_content = outcome.reasoning;
      return json(res, 200, {
        id, object: 'chat.completion', created, model,
        choices: [{ index: 0, message, finish_reason: 'stop' }],
        usage
      });
    }

    // 流式：CLI 一次性返回，网关拼成 SSE。
    // 首块之前先发一个纯注释的心跳，避免上游冷启动（每次 spawn 约 1s）期间
    // 客户端读取超时；SSE 协议规定以 ':' 开头的行是注释，解析器会忽略。
    sse(res);
    res.write(': qoder-relay upstream warming\n\n');

    sseSend(res, {
      id, object: 'chat.completion.chunk', created, model,
      choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }]
    });

    const CHUNK = 64;

    // 先思考后回答：与 Claude/DeepSeek 的块顺序一致，保证 pi-ai 的
    // contentIndex 推进正确（reasoning 块关掉之后才开 text 块）。
    if (outcome.reasoning) {
      for (let i = 0; i < outcome.reasoning.length; i += CHUNK) {
        sseSend(res, {
          id, object: 'chat.completion.chunk', created, model,
          choices: [{ index: 0, delta: { reasoning_content: outcome.reasoning.slice(i, i + CHUNK) }, finish_reason: null }]
        });
      }
    }

    for (let i = 0; i < outcome.text.length; i += CHUNK) {
      sseSend(res, {
        id, object: 'chat.completion.chunk', created, model,
        choices: [{ index: 0, delta: { content: outcome.text.slice(i, i + CHUNK) }, finish_reason: null }]
      });
    }

    sseSend(res, {
      id, object: 'chat.completion.chunk', created, model,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage
    });
    res.write('data: [DONE]\n\n');
    res.end();

  } catch (e) {
    if (!res.headersSent) {
      json(res, 500, { error: { message: e.message || String(e), type: 'internal' } });
    } else {
      try { res.end(); } catch {}
    }
  }
});

server.listen(cfg.port, cfg.host, () => {
  process.stdout.write(
    'qoder-relay listening on http://' + cfg.host + ':' + cfg.port + '\n' +
    '  POST /v1/chat/completions\n' +
    '  GET  /v1/models\n' +
    '  GET  /health\n'
  );
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { server.close(() => process.exit(0)); });
}