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
import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
function runQoder({ prompt, model, cwd, systemPrompt, entry, signal, onEvent }) {
  return new Promise((resolve, reject) => {
    // 控制台里必须没有第二个工具通道。
    //
    // Qoder 的用户级 settings.json 里挂着 serena MCP（~/.qoder-cn/settings.json
    // 的 mcpServers）。它的 instructions 会和我们的文本协议抢注意力：system prompt
    // 一长，模型就转头去试 serena 的工具，撞上 "Permission confirmation required but
    // no interactive handler is available" 之后干脆放弃动手，回头告诉用户"工具不可用"。
    // 更糟的是我们那段协议写着"本环境没有任何可用工具"——被模型验证为假话之后，
    // 整段协议都不再可信。
    //
    // --strict-mcp-config 和 --mcp-config '{}' 都挡不住它（那是 mcp.json 那层的开关），
    // 真正管用的是 --setting-sources：serena 定义在 user 源里，只加载 project 源就没有了。
    // 实测：user 源 → 1 个 MCP 服务器；project / local 源 → "No MCP servers configured"。
    // 登录凭证在 ~/.qoder-cn/.auth，不属于 setting source，切换后照常可用。
    const cliArgs = [
      '-p', prompt,
      '--model', model,
      '--tools', '',
      '--strict-mcp-config',
      '--setting-sources', 'project',
      '--output-format', 'stream-json',
      '--include-partial-messages'
    ];
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

    // 参数走临时文件，不走环境变量：system prompt + 工具 schema 轻松上万字符，
    // 会撞穿 Windows 进程环境块 32767 字符的上限，spawn 直接失败。
    const argsFile = join(tmpdir(), 'qoder-relay-args-' + process.pid + '-' +
      randomUUID().replace(/-/g, '').slice(0, 12) + '.json');
    try {
      writeFileSync(argsFile, JSON.stringify(cliArgs), 'utf8');
    } catch (e) {
      reject(Object.assign(new Error('写参数临时文件失败：' + e.message), { code: 'UPSTREAM_IO' }));
      return;
    }
    const cleanupArgs = () => { try { unlinkSync(argsFile); } catch {} };

    const env = {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      QODER_SDK_ROOT: sdk,
      QODER_WORKER_RUNTIME_ASSET_ROOT: sdk,
      QODER_RELAY_ARGS_FILE: argsFile,
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
      cleanupArgs();
      reject(Object.assign(new Error('qoder request timeout'), { code: 'UPSTREAM_TIMEOUT' }));
    }, cfg.requestTimeoutMs);

    // 边收边解析：把每一条完整的 JSON 行立刻交给 onEvent。
    // 没有 onEvent 时行为与原来完全一致（只累积），非流式路径不受影响。
    let lineBuf = '';
    child.stdout.on('data', d => {
      const s = d.toString('utf8');
      stdout += s;
      if (!onEvent) return;
      lineBuf += s;
      let nl;
      while ((nl = lineBuf.indexOf('\n')) >= 0) {
        const line = lineBuf.slice(0, nl).trim();
        lineBuf = lineBuf.slice(nl + 1);
        if (!line || line[0] !== '{') continue;
        try { onEvent(JSON.parse(line)); } catch {}
      }
    });
    child.stderr.on('data', d => { stderr += d.toString('utf8'); });

    child.on('error', e => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      cleanupArgs();
      reject(Object.assign(new Error('spawn failed: ' + e.message), { code: 'UPSTREAM_IO' }));
    });

    child.on('close', code => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      cleanupArgs();
      resolve({ code, stdout, stderr });
    });

    if (signal) {
      signal.addEventListener('abort', () => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        try { child.kill(); } catch {}
        cleanupArgs();
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

/**
 * 增量块聚合器：把 stream-json 事件流实时翻译成增量文本。
 *
 * Qoder worker 的事件是**块级**的（这与 collectBlocks 的观察一致）：
 *   content_block_start {type:"thinking"}  → 开一个思考块
 *   content_block_delta {thinking_delta}   → 思考增量
 *   content_block_start {type:"text"}      → 换到正文块
 *   content_block_delta {text_delta}       → 正文增量
 *
 * 聚合器对每个事件算出「本事件新增了什么」，通过 onDelta(type, text) 立刻吐出去，
 * 这样网关就能边收边转发，而不是等 CLI 跑完再切块。
 *
 * 同时保留完整文本累积（thinking / text 两个字符串），流程结束后与
 * extractResult() 的结果做一致性校对 —— 两者不一致时以聚合器为准并告警，
 * 因为聚合器看到的是真实到达顺序。
 */
function createBlockAggregator(onDelta) {
  let thinking = '';
  let text = '';
  let current = null;      // 'thinking' | 'text' | null
  let started = false;     // 是否已开过块（用于跳过 role 之前的噪声）

  const emit = (kind, chunk) => {
    if (!chunk) return;
    if (kind === 'thinking') thinking += chunk;
    else text += chunk;
    onDelta(kind, chunk);
  };

  const feed = (e) => {
    if (!e || e.type !== 'stream_event' || !e.event) return;
    const ev = e.event;
    const t = ev.type;

    if (t === 'content_block_start') {
      const bt = ev.content_block?.type;
      if (bt === 'thinking' || bt === 'redacted_thinking') {
        current = 'thinking';
        started = true;
        // 起始块可能自带初始文本
        if (typeof ev.content_block.thinking === 'string') emit('thinking', ev.content_block.thinking);
      } else if (bt === 'text') {
        current = 'text';
        started = true;
        if (typeof ev.content_block.text === 'string') emit('text', ev.content_block.text);
      }
      return;
    }

    if (t === 'content_block_delta') {
      const d = ev.delta;
      if (!d) return;
      if (d.type === 'thinking_delta' && typeof d.thinking === 'string') {
        current = 'thinking';
        emit('thinking', d.thinking);
      } else if (d.type === 'text_delta' && typeof d.text === 'string') {
        current = 'text';
        emit('text', d.text);
      }
      return;
    }

    if (t === 'content_block_stop') {
      current = null;
    }
  };

  return {
    feed,
    get thinking() { return thinking; },
    get text() { return text; },
    get sawBlocks() { return started; }
  };
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

// ---- 工具调用桥（Harness Tool Bridge）----------------------------------
//
// DSH 侧走的是标准 OpenAI function calling：请求带 tools[]，期待响应带 tool_calls[]。
// 但 Qoder worker CLI 是个自带工具的 agent，它的 --print 协议只吐 thinking/text 块，
// 没有 function calling 通道。所以在这里架一层文本协议桥：
//
//   入方向：把请求里的 tools[] 渲染进 system prompt，约定模型用
//           <tool_call>{"name":"..","arguments":{..}}</tool_call> 表达调用。
//   出方向：把该块从正文里剥出来，翻译成 OpenAI 的 tool_calls 增量。
//
// 不放过 CLI 自带的工具（--tools default）是刻意的：那会让 Qoder 自己动手改文件，
// DSH 既拿不到工具卡片，也没有审批与回滚。工具的执行权必须留在 DSH。
//
// 实测：deepseek-flash / glm-5.3-flash 都能稳定按此格式输出，也包括 write 这类
// 带长文本参数的工具。

const TOOL_OPEN = '<tool_call>';
const TOOL_CLOSE = '</tool_call>';
const MAX_TOOL_PROMPT_CHARS = 24000;
const MAX_TOOL_DESC_CHARS = 400;
const MAX_TOOL_PARAM_DESC_CHARS = 120;

function tryParseJson(s) {
  if (typeof s !== 'string' || !s) return null;
  try { return JSON.parse(s); } catch {}
  // 模型偶尔会留一个尾随逗号
  try { return JSON.parse(s.replace(/,\s*([}\]])/g, '$1')); } catch {}
  return null;
}

/** 精简 JSON Schema：只留模型填参数真正需要的字段，去掉 strict / additionalProperties 之类噪声。 */
function describeToolParameters(schema, depth = 0) {
  if (!schema || typeof schema !== 'object' || depth > 6) return {};
  const out = {};
  if (schema.type) out.type = schema.type;
  if (Array.isArray(schema.enum)) out.enum = schema.enum;
  if (Array.isArray(schema.required)) out.required = schema.required;
  if (schema.properties && typeof schema.properties === 'object') {
    out.properties = {};
    for (const [k, v] of Object.entries(schema.properties)) {
      const sub = describeToolParameters(v, depth + 1);
      if (v && typeof v.description === 'string' && v.description.trim()) {
        sub.desc = v.description.replace(/\s+/g, ' ').trim().slice(0, MAX_TOOL_PARAM_DESC_CHARS);
      }
      out.properties[k] = sub;
    }
  }
  if (schema.items) out.items = describeToolParameters(schema.items, depth + 1);
  for (const key of ['anyOf', 'oneOf', 'allOf']) {
    if (Array.isArray(schema[key])) out[key] = schema[key].map(s => describeToolParameters(s, depth + 1));
  }
  return out;
}

/** 把 OpenAI 的 tools[] 渲染成一段注入 system prompt 的协议说明。 */
function buildToolSystemPrompt(tools, toolChoice) {
  // 措辞必须够硬。实测：只说"你可以调用工具"时，模型会去尝试 Qoder CLI 自带
  // 的工具链（拿回一堆 Tool not found / MCP 权限报错），然后告诉用户"工具不可用"，
  // 完全不理会文本协议。必须显式否认原生工具的存在，模型才会老老实实走这个通道。
  const lines = [
    '## 工具调用协议（必须遵守）',
    '',
    '本环境没有给你注册任何原生函数工具（function tools），也没有可用的 MCP 工具。',
    '不要尝试以任何其他方式调用工具，那只会失败。你对工具的所有调用都必须用下面的文本块表达。',
    '',
    '需要调用工具时，整条回复只允许包含这一个块，前后不要有任何解释文字、也不要包 Markdown 代码围栏：',
    '',
    TOOL_OPEN + '{"name":"工具名","arguments":{按参数说明填写}}' + TOOL_CLOSE,
    '',
    '宿主会执行该调用，并把结果作为下一条 Tool result 消息回给你，你收到后再继续推理。',
    '可以直接回答时用自然语言回答，不要输出 ' + TOOL_OPEN + '。',
    '一次只调用一个工具，arguments 必须是合法 JSON 对象。',
  ];

  const forced = toolChoice && typeof toolChoice === 'object' ? toolChoice.function?.name : null;
  if (forced) lines.push('本轮必须调用工具 `' + forced + '`。');
  else if (toolChoice === 'required') lines.push('本轮必须调用工具，不要直接回答。');
  else if (toolChoice === 'none') lines.push('本轮不要调用任何工具，直接回答。');

  lines.push('', '### 可用工具', '');

  let budget = MAX_TOOL_PROMPT_CHARS;
  let included = 0;
  for (const t of tools) {
    const fn = t?.function || t;
    if (!fn || !fn.name) continue;
    const desc = String(fn.description || '').replace(/\s+/g, ' ').trim().slice(0, MAX_TOOL_DESC_CHARS);
    const row = '- ' + fn.name + (desc ? ': ' + desc : '') +
      '\n  参数: ' + JSON.stringify(describeToolParameters(fn.parameters));
    if (row.length > budget && included > 0) break;
    budget -= row.length;
    lines.push(row);
    included++;
  }
  if (included < tools.length) {
    lines.push('', '（工具清单过长，已省略 ' + (tools.length - included) + ' 个。）');
  }
  return lines.join('\n');
}

/** 把一段 <tool_call> 内容解析成 { name, arguments }。宽松容错，认不出就返回 null。 */
function parseToolCall(raw) {
  let s = String(raw || '').trim();
  if (!s) return null;
  s = s.replace(/^\`\`\`[a-zA-Z]*\s*/, '').replace(/\`\`\`\s*$/, '').trim();

  let obj = tryParseJson(s);
  if (!obj) {
    const a = s.indexOf('{'), b = s.lastIndexOf('}');
    if (a >= 0 && b > a) obj = tryParseJson(s.slice(a, b + 1));
  }
  if (!obj || typeof obj !== 'object') return null;

  const fn = obj.function && typeof obj.function === 'object' ? obj.function : obj;
  const name = fn.name || fn.tool || fn.tool_name || obj.name || obj.tool;
  if (!name || typeof name !== 'string') return null;

  let args = fn.arguments ?? fn.args ?? fn.parameters ?? fn.input ?? obj.arguments ?? obj.args ?? obj.parameters ?? {};
  if (typeof args === 'string') args = tryParseJson(args) ?? { value: args };
  if (!args || typeof args !== 'object') args = {};

  let json;
  try { json = JSON.stringify(args); } catch { json = '{}'; }
  return { name, arguments: json };
}

/**
 * 流式工具块提取器。
 *
 * 输入是上游正文的任意分片，输出两条通道：
 *   onText(s)                     —— 可以安全发出去的正文（工具块已剥掉）
 *   onToolCall({name,arguments})  —— 解析完成的工具调用
 *
 * 三处关键处理：
 *  1. 标签可能被切在分片中间，所以尾部若是 TOOL_OPEN 的前缀就先扣住不发；
 *  2. 工具块前后的空白一并吞掉，避免 DSH 正文里出现空行；
 *  3. 同一调用（name + arguments 签名）只发一次 —— 有的模型会在思考里先写一遍。
 */
function createToolCallExtractor({ onText, onToolCall }) {
  let tail = '';       // 扣住的半截标签
  let inBlock = false;
  let body = '';
  let hold = '';       // 尾部未定空白
  let textOut = '';
  const calls = [];
  const seen = new Set();

  const pushText = (s) => { if (!s) return; textOut += s; onText(s); };

  const emitWithheld = (s) => {
    const merged = hold + s;
    const m = /[ \t\r\n]*$/.exec(merged);
    hold = m ? m[0] : '';
    const head = merged.slice(0, merged.length - hold.length);
    if (head) pushText(head);
  };

  const emitCall = (raw) => {
    const call = parseToolCall(raw);
    if (!call) return;
    const sig = call.name + '\u0000' + call.arguments;
    if (seen.has(sig)) return;
    seen.add(sig);
    calls.push(call);
    onToolCall(call);
  };

  const feed = (chunk) => {
    if (!chunk) return;
    let s = tail + chunk;
    tail = '';
    for (;;) {
      if (!s) return;
      if (inBlock) {
        const idx = s.indexOf(TOOL_CLOSE);
        if (idx < 0) { body += s; return; }
        body += s.slice(0, idx);
        s = s.slice(idx + TOOL_CLOSE.length);
        inBlock = false;
        const raw = body;
        body = '';
        emitCall(raw);
        continue;
      }
      const idx = s.indexOf(TOOL_OPEN);
      if (idx >= 0) {
        emitWithheld(s.slice(0, idx));
        hold = '';
        s = s.slice(idx + TOOL_OPEN.length);
        inBlock = true;
        continue;
      }
      let keep = 0;
      const max = Math.min(TOOL_OPEN.length - 1, s.length);
      for (let n = max; n > 0; n--) {
        if (s.endsWith(TOOL_OPEN.slice(0, n))) { keep = n; break; }
      }
      emitWithheld(s.slice(0, s.length - keep));
      tail = keep ? s.slice(s.length - keep) : '';
      return;
    }
  };

  const flush = () => {
    if (inBlock) {
      const raw = body;
      body = '';
      inBlock = false;
      if (raw.trim()) emitCall(raw);   // 流被截断：尽力解析已攒到的内容
    }
    if (tail) { emitWithheld(tail); tail = ''; }
    if (hold) { pushText(hold); hold = ''; }
  };

  return {
    feed,
    flush,
    get calls() { return calls; },
    get text() { return textOut; }
  };
}

// ---- 把 OpenAI messages 压成单条 prompt ----
/** 一段 content 里有没有图片块。 */
function contentHasImage(content) {
  if (!Array.isArray(content)) return false;
  return content.some(c => c && typeof c === 'object' &&
    (c.type === 'image_url' || c.type === 'input_image' || c.image_url));
}

/** 整个请求里有没有图片块（含工具结果里的）。 */
function messagesHaveImage(messages) {
  return (messages || []).some(m => contentHasImage(m && m.content));
}

function contentToText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(c => {
    if (typeof c === 'string') return c;
    if (!c) return '';
    if (c.type === 'text' || c.type === 'input_text') return c.text || '';
    // 图片走不到这里：入口已经用 messagesHaveImage 拒掉整条请求。
    return '';
  }).join('');
}

/** 回放历史里的 tool_calls：还原成模型自己写过的 <tool_call> 格式，保持协议一致。 */
function renderToolCalls(toolCalls) {
  const parts = [];
  for (const tc of toolCalls) {
    if (!tc) continue;
    const fn = tc.function && typeof tc.function === 'object' ? tc.function : tc;
    const name = fn.name || tc.name || '';
    if (!name) continue;
    let args = fn.arguments ?? tc.arguments ?? {};
    if (typeof args === 'string') args = tryParseJson(args) ?? {};
    parts.push(TOOL_OPEN + JSON.stringify({ name, arguments: args }) + TOOL_CLOSE);
  }
  return parts.join('\n');
}

function flattenMessages(messages, systemFromField) {
  const sysParts = [];
  if (systemFromField) sysParts.push(String(systemFromField));

  const convo = [];
  for (const m of messages || []) {
    const role = m.role || 'user';
    const text = contentToText(m.content).trim();

    if (role === 'system' || role === 'developer') { if (text) sysParts.push(text); continue; }

    // 工具返回结果（OpenAI role:"tool"）。必须带上调用标识 —— 否则模型看到的就是
    // 一条普通 User 消息，会以为用户凭空说了句话，于是把同一个工具再调一次。
    if (role === 'tool' || role === 'function') {
      const id = m.tool_call_id || m.name || '';
      const head = id ? '（调用 ' + id + ' 的返回结果）' : '（工具返回结果）';
      convo.push({ role: 'tool', text: head + '\n' + (text || '(空)') });
      continue;
    }

    if (role === 'assistant') {
      const parts = [];
      if (text) parts.push(text);
      if (Array.isArray(m.tool_calls) && m.tool_calls.length) {
        const rendered = renderToolCalls(m.tool_calls);
        if (rendered) parts.push(rendered);
      }
      if (parts.length) convo.push({ role: 'assistant', text: parts.join('\n') });
      continue;
    }

    if (text) convo.push({ role, text });
  }

  let prompt;
  if (convo.length === 0) prompt = '';
  else if (convo.length === 1 && convo[0].role === 'user') prompt = convo[0].text;
  else {
    prompt = convo.map(m => {
      const label = m.role === 'assistant' ? 'Assistant' : (m.role === 'tool' ? 'Tool result' : 'User');
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

    // 纯文本通道：输入最终是 CLI 的 `-p <prompt>`，没有任何多模态入口。
    // 与其把图片悄悄压成占位符、让模型对着看不见的图说"读过了"，不如直接拒绝 ——
    // 这也是 DSH 里其他纯文本模型的表现（pi-ai 层同样抛 UNSUPPORTED_CONTENT）。
    if (messagesHaveImage(body.messages)) {
      return json(res, 400, {
        error: {
          message: 'qoder-relay model "' + model + '" does not support image input',
          type: 'unsupported_content',
          code: 'UNSUPPORTED_CONTENT'
        }
      });
    }

    const tools = Array.isArray(body.tools)
      ? body.tools.filter(t => t && (t.function?.name || t.name))
      : [];
    const flat = flattenMessages(body.messages, body.system);
    const prompt = flat.prompt;
    if (!prompt) return json(res, 400, { error: { message: 'no user content in messages' } });

    // 有工具就走协议桥：把 tools[] 渲染进 system prompt，出方向再把 <tool_call>
    // 翻译成真正的 tool_calls。没有工具时一切照旧，纯对话行为不变。
    let systemPrompt = flat.systemPrompt;
    if (tools.length) {
      const bridge = buildToolSystemPrompt(tools, body.tool_choice);
      systemPrompt = systemPrompt ? systemPrompt + '\n\n' + bridge : bridge;
    }

    const entry = resolveEntry(body);
    const id = 'chatcmpl-' + randomUUID().replace(/-/g, '').slice(0, 24);
    const created = Math.floor(Date.now() / 1000);
    const stream = body.stream === true;

    const ac = new AbortController();
    req.on('aborted', () => ac.abort());

    // ── 流式：先开 SSE 头，边收边转发 ──────────────────────────────────
    //
    // 原来是把 CLI 的 stdout 整个攒完再切块，导致首字节延迟 = 全部生成时间。
    // 现在给 runQoder 挂 onEvent，事件一到就翻译成增量 chunk 发出去。
    //
    // 块顺序仍是「先思考后回答」：聚合器按上游真实到达顺序吐 delta，
    // 因此 contentIndex 的推进天然正确，不需要人工重排。
    let agg = null;
    let sseOpen = false;
    let toolCallIndex = 0;
    const openSse = () => {
      if (sseOpen) return;
      sseOpen = true;
      sse(res);
      res.write(': qoder-relay upstream warming\n\n');
      sseSend(res, {
        id, object: 'chat.completion.chunk', created, model,
        choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }]
      });
    };

    const sseChunk = (delta) => {
      openSse();
      sseSend(res, {
        id, object: 'chat.completion.chunk', created, model,
        choices: [{ index: 0, delta, finish_reason: null }]
      });
    };

    // 一条工具调用一次性发全：id + name + 完整 arguments。
    // 上游是块级输出，工具块闭合时参数已经完整，再切分片只会多一层出错面。
    const sendToolCall = (call) => {
      sseChunk({
        tool_calls: [{
          index: toolCallIndex++,
          id: 'call_' + randomUUID().replace(/-/g, '').slice(0, 24),
          type: 'function',
          function: { name: call.name, arguments: call.arguments }
        }]
      });
    };

    const extractor = createToolCallExtractor({
      onText: (s) => sseChunk({ content: s }),
      onToolCall: sendToolCall
    });

    const onEvent = (e) => {
      if (!agg) return;
      agg.feed(e);
    };
    const onDelta = (kind, chunk) => {
      // 思考链直接透传：实测上游不会把工具调用写进 thinking 块，只在正文块里输出。
      if (kind === 'thinking') return sseChunk({ reasoning_content: chunk });
      extractor.feed(chunk);
    };
    if (stream) agg = createBlockAggregator(onDelta);

    let outcome;
    try {
      const { stdout, stderr } = await runQoder({
        prompt, model, cwd: body.cwd, systemPrompt, entry, signal: ac.signal,
        onEvent
      });
      outcome = extractResult(parseEvents(stdout), stdout, stderr);
      // 聚合器与 extractResult 不一致时，以聚合器为准（它看到的是真实到达顺序）
      if (agg && agg.sawBlocks) {
        if (agg.text && agg.text !== outcome.text) outcome.text = agg.text;
        if (agg.thinking && agg.thinking !== (outcome.reasoning || '')) outcome.reasoning = agg.thinking;
      }
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
      const ex = createToolCallExtractor({ onText() {}, onToolCall() {} });
      ex.feed(outcome.text);
      ex.flush();
      const message = { role: 'assistant', content: ex.text };
      if (ex.calls.length) {
        message.tool_calls = ex.calls.map(c => ({
          id: 'call_' + randomUUID().replace(/-/g, '').slice(0, 24),
          type: 'function',
          function: { name: c.name, arguments: c.arguments }
        }));
      }
      // 只有开启 thinking 的路由才带：非推理模型（如 deepseek-flash）返回空串，
      // 挂了反而让下游以为「有思考但为空」。
      if (nonStreamReasoning && outcome.reasoning) message.reasoning_content = outcome.reasoning;
      return json(res, 200, {
        id, object: 'chat.completion', created, model,
        choices: [{ index: 0, message, finish_reason: ex.calls.length ? 'tool_calls' : 'stop' }],
        usage
      });
    }

    // 流式：正文已在 onDelta 里边收边发，这里只做收尾。
    //
    // 兜底：如果上游一个 content_block 都没给（例如 worker 直接回了 result 事件），
    // 聚合器不会产生任何 delta，此时把 outcome 整体补发一次，避免空响应。
    openSse();
    if (agg && !agg.sawBlocks) {
      const CHUNK = 64;
      if (outcome.reasoning) {
        for (let i = 0; i < outcome.reasoning.length; i += CHUNK) {
          sseSend(res, {
            id, object: 'chat.completion.chunk', created, model,
            choices: [{ index: 0, delta: { reasoning_content: outcome.reasoning.slice(i, i + CHUNK) }, finish_reason: null }]
          });
        }
      }
      // 走同一条提取器：这段兜底正文里同样可能裹着工具块
      extractor.feed(outcome.text);
    }
    extractor.flush();

    sseSend(res, {
      id, object: 'chat.completion.chunk', created, model,
      choices: [{ index: 0, delta: {}, finish_reason: toolCallIndex > 0 ? 'tool_calls' : 'stop' }],
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