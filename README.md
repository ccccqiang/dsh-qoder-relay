# dsh-qoder-relay

把 **Qoder CN 订阅额度**做成 DSH 的一部分：一个随宿主自动启停的本地 OpenAI 兼容网关，
外加一个**设置页**用来完成登录。

[![GitHub release](https://img.shields.io/github/v/release/ccccqiang/dsh-qoder-relay)](https://github.com/ccccqiang/dsh-qoder-relay/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

---

## 安装

### 前置条件

**必须已安装 Qoder CN 桌面端**（[qoder.cn](https://qoder.cn)）。

网关不依赖它的 GUI 运行，但需要它的可执行文件当 Node 运行时。
装在 `C:` / `D:` / `E:` / `F:` 任一盘符都能自动探测；
装在非常规位置时用 `QODER_ELECTRON_EXE` 环境变量指定。

### 方式一：CLI 安装（推荐）

```bash
dsh plugin --profile desktop install github:ccccqiang/dsh-qoder-relay#v0.2.0
```

### 方式二：手动装进 profile

编辑 `$DSH_HOME/profiles/desktop/package.json`，两处都要改：

```json
{
  "dependencies": {
    "dsh-qoder-relay": "github:ccccqiang/dsh-qoder-relay#v0.2.0"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "...",
        "dsh-qoder-relay"
      ]
    }
  }
}
```

然后安装依赖（`nodeLinker: hoisted` 是**复制**不是软链，必须跑这一步）：

```powershell
$pnpm = Get-ChildItem "$env:APPDATA\DSH Desktop\runtime-commands" -Recurse -Filter pnpm.cmd | Select-Object -First 1
& $pnpm.FullName install --dir "$env:USERPROFILE\.dsh\profiles\desktop"
```

### 方式三：本地目录

clone 到本地后把依赖写成：

```json
"dsh-qoder-relay": "file:D:/path/to/dsh-qoder-relay"
```

### 启用模型路由

装完插件后，还要让 DSH 知道怎么用它。
在 `$DSH_HOME/profiles/desktop/cordis.patch.yml` 的 `llm-pi-ai` 行里加一个 provider：

```yaml
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      qoder:
        displayName: Qoder CN
        api: openai-completions
        baseURL: http://127.0.0.1:8788/v1
        apiKeyEnv: QODER_RELAY_KEY
        models:
          - id: auto
            name: Qoder Auto
          - id: deepseek-flash
            name: DeepSeek Flash (Qoder)
          - id: glm-5.3
            name: GLM-5.3 (Qoder)
          # …其余模型见「14 个模型」一节
```

再往 `$DSH_HOME/.credentials.yaml` 加一行（网关默认不校验，占位值即可）：

```yaml
refs:
  QODER_RELAY_KEY: qoder-relay-local
```

> **这条路由必须留在 profile 层。** 搬到 home 层会让「设置 → 模型」那页变空壳。

---

## 装完先做这一步

**重启 DSH**（完全退出，托盘也退，再打开）。

然后打开 **设置 → Qoder CN** 那个 tab，点「登录 Qoder」——
会给你一个设备码链接，浏览器打开授权后即可。不用敲任何命令。


**重启 DSH**（完全退出，托盘也退，再打开）。

然后打开 **设置 → Qoder CN** 那个 tab，点「登录 Qoder」——
会给你一个设备码链接，浏览器打开授权后即可。不用敲任何命令。

---

## 它做了什么

Qoder CN 桌面端（默认装在 `D:\Qoder CN`，其他盘符也能自动探测）内部打包了完整的 headless Agent CLI：

- `resources/app.asar.unpacked/node_modules/@qoder-ai/qoder-cn-agent-sdk/dist/_worker/qoder-worker-runtime.obf.mjs`
- `qoder-worker-runtime 1.1.35` / `qoderclicn 1.1.35`

让 Electron 主程序以 `ELECTRON_RUN_AS_NODE=1` 充当 Node 24.18.0，就能用官方 CLI 协议
驱动它，复用同一套订阅额度 —— **不需要逆向签名算法，也不触碰桌面端的 DPAPI 凭证**。

### 两套凭证是隔离的

| | 位置 | 谁在用 |
|---|---|---|
| 桌面端凭证 | `%APPDATA%\com.qodercn.app.stable\auth.v1.dat`（DPAPI） | Qoder 桌面端 GUI |
| CLI 凭证 | `~/.qoder-cn` | 本插件（网关） |

worker 运行时不读 `auth.v1.dat`（实测 `auth.v1` 命中数为 0）。
所以桌面端和 CLI 可以各自登录、同时在线，互不干扰。

### Qoder 桌面端不用开着

网关 spawn 的是 `Qoder CN.exe` 这个**文件**当运行时，跟 GUI 进程无关。
实测：GUI 完全退出（0 进程）时，网关照常启动、推理照常返回。

**唯一的要求**：别删 `D:\Qoder CN` 目录。

---

## 设置页能做什么

**设置 → Qoder CN**

- **登录**：一键发起设备码登录，显示授权链接与实时进度
- **状态**：真正跑一次 `--list-models` 判定可用性（不靠猜），区分「找不到安装」和「未登录」
- **模型**：列出当前账号可用的全部模型
- **网关地址**：显示 OpenAI 兼容端点，方便接其他客户端

---

## 14 个模型

`auto`、`deepseek-v4-pro`、`deepseek-flash`、`qwen3.8-max`、`qwen3.8-flash`、
`qwen3.7-max`、`qwen3.7-plus`、`qwen3.7-flash`、`glm-5.3`、`glm-5.3-flash`、
`glm-5.2`、`kimi-k3`、`kimi-k2.8-preview`、`minimax-m2.7`

## 计量：只看 qoder_credits

上游不返回 token 计数，`prompt_tokens` / `completion_tokens` **恒为 0**。
真实额度扣费在 `usage.qoder_credits`（上游直接下发）。

实测同一句 "Say OK" 的成本：

| 模型 | credits |
|---|---|
| DeepSeek-Flash | 0.011 |
| Qwen3.7-Flash | 0.067 |
| **Kimi-K3** | **5.15** |

**差 460 倍。** 日常用 flash 系列，贵的省着用。

---

## 架构

```
DSH ──挂载──> dsh-qoder-relay
                ├─ lib/index.mjs   host 半边：网关生命周期 + 登录服务
                └─ lib/client.js   浏览器半边：设置页 UI
                     │
                     ├─ spawn "Qoder CN.exe" (ELECTRON_RUN_AS_NODE=1)
                     │     └─ qoder-worker-runtime.obf.mjs（官方 headless CLI）
                     │           └─ gateway.qoder.com.cn ← 你的订阅额度
                     │
                     └─ 网关监听 127.0.0.1:8788 → llm-pi-ai 路由接入
```

## 文件

| 文件 | 作用 |
|---|---|
| `lib/index.mjs` | host 入口：网关生命周期 + `qoderRelay` 服务（登录控制） |
| `lib/client.js` | 浏览器入口：设置页 React 组件 |
| `server.mjs` | OpenAI 兼容网关 |
| `shim.mjs` | 以 Electron-as-Node 启动 Qoder worker；参数经 `QODER_RELAY_ARGS`(JSON) 传入 |
| `cordis.patch.yml` | 一行 insert，让插件管理器能按 id 定位并开关 |

### 为什么 client.js 是手写的

DSH 的 client bundle 契约很简单：

```js
window.__ModuleLoader__.load({
  id: "<包名>",
  factory: (require) => { /* ... */ return exports }
});
```

`react` / `react-dom` 由加载器提供，不需要打包。所以手写纯 JS +
`React.createElement`（不用 JSX）就够，省掉 tsdown + vite 整套构建链。

**注意**：`window.__ModuleLoader__.load(` 必须是文件第一个语句，注释要放在
`factory` 内部 —— 加载器在执行时立即读取。

---

## 改了代码怎么办

`nodeLinker: hoisted` 是**复制**不是链接。改完必须同步并重启：

```powershell
$src = '<你的插件源码目录>'
$dst = "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-qoder-relay"
foreach($f in @('lib\index.mjs','lib\client.js','server.mjs','shim.mjs','package.json','cordis.patch.yml')){
  Copy-Item -LiteralPath (Join-Path $src $f) -Destination (Join-Path $dst $f) -Force
}
```

然后重启 DSH。

---

## 关键设计点（改代码前必读）

| 关注点 | 做法 | 为什么 |
|---|---|---|
| 端口占用 | 先探 `/health`，活着就复用 | 宿主重启常见「上一个实例还没死透」，重复 listen 会 EADDRINUSE |
| 重复挂载 | `generation` 计数器 | profile 是 `patchReload:"live"`，新 fiber 先建旧 fiber 后拆，不做代际判定会「新的刚装好又被旧的拆掉」 |
| 升级兼容 | **不写 `peerDependencies`** | 没有 peers 时版本预检返回 undefined 被绕过；写了每次 DSH 升级都报不兼容 |
| 清理注册 | `ctx.effect(() => { ...; return teardown })` | DSH 里 84 个插件用它。写成 `ctx.on("dispose", ...)` 是错的 —— 那只是事件订阅 |
| 子进程终止 | `taskkill /PID x /T /F`（`spawnSync`） | Windows 上 Electron 子进程常不在同一进程组；`unref` 的定时器在宿主退出时永不触发，会留孤儿 |
| 路由位置 | profile 层 `cordis.patch.yml` | 搬到 home 层会让「设置 → 模型」变空壳 |

---

## 排错

| 症状 | 修法 |
|---|---|
| 设置里没有 Qoder CN tab | 重启 DSH；确认 `dsh.client` 声明在（见 package.json） |
| 状态显示「找不到 Qoder CN 安装目录」 | 装 Qoder CN，或在插件 config 里给 `electronExe` |
| 状态显示「未登录」 | 点「登录 Qoder」，浏览器完成授权 |
| 模型是死的，请求超时 | 看 `:8788` 是否 LISTEN；检查插件开关 |
| 退出 DSH 后 `:8788` 还被占 | `taskkill /PID <pid> /T /F` |

日志：`%APPDATA%\DSH Desktop\logs\host\dsh-<日期>.log`，搜 `qoder-relay`。

---

## 已知限制

- **非流式上游 + 分块转发**：CLI 一次性返回完整结果，网关按 64 字符切块成 SSE。首字节延迟 = 完整生成时间。
- 每次请求起一个 worker 进程（约 1s 冷启动）。
- 会话无状态：多轮由网关把 messages 拍平成对话文本。
- 上游不返回 token 计数，只能用 `qoder_credits` 计量。
- 复用的边界：若 DSH 崩溃未跑 teardown，残留网关会被下次挂载「复用」。端口固定的场景无害，但换端口时复用的会是旧配置进程。
---

## 两个让 DSH 直接打不开的坑（血泪）

这两条都表现为 **"Renderer boot failed for N plugin(s)"**，DSH 进恢复模式，
而且 **client Loader 不给任何错误信息**，只能靠对比可用样本定位。

### 坑一：host 端用 ctx.set 注册服务

```js
ctx.set("qoderRelay", service)      // ✗ 抛 "cannot set property without provide"
ctx.provide("qoderRelay", service)  // ✓ 正确 API
```

而且这个错发生在 host 端 `apply()` 里，会让**整个插件激活失败**，
连带渲染进程起不来。**不要用没验证过的 ctx API。**

本插件后来改用 `ctx.on("webserver/index-inject", ...)` 注入全局变量 +
网关自己的 HTTP 端点，彻底避开了 DSH 的服务协议。

### 坑二：client 端必须导出 exports.inject

```js
exports.apply = apply;
exports.inject = ['slots', 'connection'];   // ← 少这行就崩，且无错误信息
return module.exports;
```

**注意两点**：

1. 这是**运行时短名**（`'slots'`、`'connection'`），**不是** package.json 里
   `dsh.client.inject` 那种包全名（`'@deepseek-ai/dsh-client-ui-settings'`）。
   两者都要有，作用不同：前者是运行时等待的服务，后者是模块图依赖。
2. `slots` 是注册任何 slot 的必需项。少了它，加载器不知道要等 slot 注册表就绪。

**定位方法**：拿一个能工作的同类第三方包做对照。
本机可用的样本是 `dsh-session-recycle-bin`（同样是手写的 `__ModuleLoader__` 壳），
直接 diff 它的 `exports` 块即可。

### 验证手法（不用重启 DSH）

`client.js` 可以被独立模拟执行 —— 不需要真的浏览器：

```js
let spec = null;
const win = { __ModuleLoader__: { load(s) { spec = s; } } };
const requireStub = (n) => n === "react" ? require("react") : new Proxy({}, { get: () => () => ({}) });
new Function("window", "require", code)(win, requireStub);
const exports = spec.factory(requireStub);
// 检查 exports.apply / exports.inject
```

跑法（PATH 里没有 node，用 Electron 当 node）：

```powershell
$env:ELECTRON_RUN_AS_NODE = "1"
& "$env:QODER_HOME\Qoder CN.exe" <你的探针脚本>.mjs
```

**改 client.js 前务必先跑这个**，能避免让 DSH 进恢复模式。