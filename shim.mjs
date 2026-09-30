// qoder-relay-shim.mjs — 以 Electron-as-Node 启动 Qoder worker CLI
// 参数经环境变量 QODER_RELAY_ARGS (JSON 数组) 传入，规避 Windows 引号问题
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';

const ROOT = process.env.QODER_SDK_ROOT;
const target = join(ROOT, 'qoder-worker-runtime.obf.mjs');

// 参数优先从文件读：system prompt + 工具 schema 有上万字符，
// 塞进环境变量会撞穿 Windows 进程环境块上限。
let cliArgs = [];
const argsFile = process.env.QODER_RELAY_ARGS_FILE;
const raw = argsFile ? (() => {
  try { return readFileSync(argsFile, 'utf8'); } catch (e) {
    process.stderr.write('[shim] cannot read args file: ' + e.message + '\n');
    process.exit(64);
  }
})() : process.env.QODER_RELAY_ARGS;
if (raw) {
  try { cliArgs = JSON.parse(raw); } catch (e) { process.stderr.write('[shim] bad args JSON\n'); process.exit(64); }
}

if (process.env.QODER_RELAY_DEBUG === '1') {
  process.stderr.write('[shim] node=' + process.versions.node + '\n');
  process.stderr.write('[shim] cliArgs=' + JSON.stringify(cliArgs) + '\n');
}

process.argv = [process.execPath, target, ...cliArgs];

try {
  await import(pathToFileURL(target).href);
} catch (e) {
  process.stderr.write('[shim] import failed: ' + (e && e.stack ? e.stack : String(e)) + '\n');
  process.exit(70);
}
