// 构建脚本：lib/ = host ESM 直拷 + client 单文件产物（window.__ModuleLoader__.load 工厂）
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const src = path.join(root, 'src');
const lib = path.join(root, 'lib');

fs.rmSync(lib, { recursive: true, force: true });
fs.cpSync(path.join(src, 'core'), path.join(lib, 'core'), { recursive: true });
fs.cpSync(path.join(src, 'host.js'), path.join(lib, 'host.js'));

function stripClient(text) {
  return text
    .replace(/^import\s[^\n]*$/gm, '')
    .replace(/^export\s(?=(async\s+)?(function|const|let|var))/gm, '');
}

const parts = ['format.js', 'charts.js', 'ui.js', 'index.js']
  .map((f) => stripClient(fs.readFileSync(path.join(src, 'client', f), 'utf8')));

const artifact = `window.__ModuleLoader__.load({
  id: "dsh-token-tally",
  factory: (require) => {
    var module = { exports: {} };
    var React = require("react");
${parts.join('\n')}
    var __mca = makeModule(React);
    module.exports.inject = __mca.inject;
    module.exports.apply = __mca.apply;
    return module.exports;
  }
});
`;

const codeOnly = artifact.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '');
if (/(^|\n)\s*(import|export)\b/.test(codeOnly)) throw new Error('client artifact still contains import/export');
if (!artifact.includes('__ModuleLoader__')) throw new Error('client artifact missing ModuleLoader bootstrap');

fs.mkdirSync(lib, { recursive: true });
const clientPath = path.join(lib, 'client.js');
fs.writeFileSync(clientPath, artifact);

const chk = spawnSync(process.execPath, ['--check', clientPath], { encoding: 'utf8' });
if (chk.status !== 0) {
  console.error(chk.stderr);
  throw new Error('client artifact syntax check failed');
}

const hostImp = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(path.join(lib, 'host.js')).href)}); console.log('host module graph ok');`], { encoding: 'utf8' });
if (hostImp.status !== 0) {
  console.error(hostImp.stderr);
  throw new Error('host module graph import failed');
}

console.log('build ok:', path.relative(root, clientPath), '+', path.relative(root, path.join(lib, 'host.js')), '+ lib/core/*');
