#!/usr/bin/env node
/**
 * 同步某个 OneBot 实现的完整 action 目录，写成 src/catalogs/<impl>.json。
 *
 * 控制台「动作目录」面板上的按钮走同一份逻辑（src/catalog-update.js）；这个脚本是终端/CI 版。
 *
 * 用法：
 *   npm run sync-catalog -- --impl snowluma
 *   npm run sync-catalog -- --impl snowluma --from "D:\path\to\SnowLuma"
 *   npm run sync-catalog -- --impl napcat --from http://127.0.0.1:6099/api/Debug/schemas --token <WebUI token>
 */
import { existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { normalizeCatalog, readCatalogSource, saveCatalog } from '../src/catalog-update.js';

const pkgDir = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);

function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

/** 把 --from 给的文件 / 目录展开成候选文件列表。 */
function candidates(input) {
  const absolute = resolve(input);
  if (!existsSync(absolute)) return [];
  if (statSync(absolute).isFile()) return [absolute];
  return [
    join(absolute, 'catalog.json'),
    join(absolute, 'packages', 'mcp', 'src', 'generated', 'catalog.json'),
    join(absolute, 'packages', 'mcp', 'dist', 'generated', 'catalog.json'),
    join(absolute, 'packages', 'mcp', 'dist', 'generated', 'catalog.js'),
    join(absolute, 'dist', 'generated', 'catalog.json'),
    join(absolute, 'dist', 'generated', 'catalog.js'),
    join(absolute, 'src', 'generated', 'catalog.json'),
  ].filter((path) => existsSync(path));
}

function resolveInstalled() {
  try {
    return dirname(require.resolve('@snowluma/mcp/package.json'));
  } catch {
    return '';
  }
}

const impl = String(arg('--impl') ?? process.env.ONEBOT_IMPL ?? '').trim();
if (!impl) {
  console.error('缺少 --impl（例如 snowluma / napcat）。');
  process.exit(2);
}

const token = String(arg('--token') ?? '').trim();
const explicit = arg('--from') ?? process.env.ONEBOT_CATALOG;
const input = explicit
  || (impl === 'snowluma' ? resolveInstalled() : '')
  || (impl === 'napcat' ? 'http://127.0.0.1:6099/api/Debug/schemas' : '');
if (!input) {
  console.error(`找不到 ${impl} 的目录来源。用 --from 指一个文件 / 目录 / URL。`);
  process.exit(2);
}

const sources = /^https?:\/\//i.test(input) ? [input] : candidates(input);
if (!sources.length) {
  console.error(`在 ${input} 下没找到 catalog.json / catalog.js。`);
  process.exit(2);
}

let data;
let used = '';
for (const source of sources) {
  try {
    let raw;
    if (/\.m?js$/i.test(source) && !/^https?:/i.test(source)) {
      const mod = await import(`${pathToFileURL(source).href}?t=${Date.now()}`);
      raw = mod.ACTIONS
        ? { actions: mod.ACTIONS, categories: mod.CATEGORIES, version: mod.VERSION }
        : mod;
    } else {
      raw = await readCatalogSource(source, { token });
    }
    data = normalizeCatalog(raw, impl);
    used = source;
    break;
  } catch (error) {
    console.error(`跳过 ${source}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
if (!data) {
  console.error('没有可用的目录。');
  process.exit(2);
}

const path = saveCatalog(data, impl);
console.log(`已写入 ${path}`);
console.log(`  actions: ${data.actions.length} / categories: ${data.categories.length}`);
console.log(`  source: ${used}`);
console.log('重启 Coopanion 后生效。');
