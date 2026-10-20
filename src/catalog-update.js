/**
 * 目录的获取、归一化与落盘。
 *
 * 面板上的「更新动作」和命令行 `sync-catalog` 共用这一份逻辑，避免两处各写一套。
 * 支持的输入形状：
 *   1. 本包格式      { actions: [...], categories: [...] }
 *   2. SnowLuma      packages/mcp/src/generated/catalog.json
 *   3. NapCat WebUI  GET /api/Debug/schemas → { ok, data: { <action>: { description, payload, tags } } }
 *   4. NapCat 原始   { <action>: { description, payload, tags } }
 */
import { writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

/** 只读判定：NapCat 不声明 readOnly，只能按命名归类，拿不准就当写操作。 */
const READ_ONLY_PATTERNS = [
  /^_?get_/i,
  /^nc_get_/i,
  /^can_send_/i,
  /^fetch_/i,
  /^check_/i,
  /^translate_/i,
  /^ocr_/i,
  /^\.?(get_|ocr_)/i,
];
const SKIP_ACTION = /^(unknown|test_)/i;

const CATALOG_DIR = fileURLToPath(new URL('./catalogs/', import.meta.url));

export function readOnlyOf(name) {
  return READ_ONLY_PATTERNS.some((pattern) => pattern.test(name));
}

function fromMap(map) {
  const actions = [];
  for (const [name, entry] of Object.entries(map)) {
    if (SKIP_ACTION.test(name)) continue;
    const payload = entry?.payload ?? entry?.inputSchema;
    actions.push({
      name,
      aliases: [],
      summary: String(entry?.description ?? entry?.summary ?? ''),
      readOnly: typeof entry?.readOnly === 'boolean' ? entry.readOnly : readOnlyOf(name),
      category: String(entry?.tags?.[0] ?? entry?.category ?? '未分类'),
      inputSchema: payload && typeof payload === 'object'
        ? payload
        : { type: 'object', properties: {}, additionalProperties: true },
    });
  }
  return actions;
}

function deriveCategories(actions) {
  const counts = new Map();
  for (const action of actions) {
    const category = String(action.category ?? '未分类');
    counts.set(category, (counts.get(category) ?? 0) + 1);
  }
  return [...counts.entries()].map(([category, count]) => ({ category, count }));
}

/** 去掉 NapCat WebUI 的 { ok, data } 外壳，并认出是不是“action 名 → 描述”的形状。 */
function unwrap(raw) {
  if (Array.isArray(raw?.actions)) return { kind: 'catalog', value: raw };
  const inner = raw?.data ?? raw?.schemas ?? raw;
  const isMap = inner && typeof inner === 'object' && !Array.isArray(inner)
    && !Array.isArray(inner.actions)
    && Object.values(inner).some((entry) => entry && typeof entry === 'object' && 'payload' in entry);
  return isMap ? { kind: 'map', value: inner } : { kind: 'catalog', value: raw };
}

export function normalizeCatalog(raw, impl) {
  const { kind, value } = unwrap(raw);
  const actions = kind === 'map'
    ? fromMap(value)
    : (Array.isArray(value) ? value : (Array.isArray(value?.actions) ? value.actions : []));
  if (!actions.length) throw new Error('输入里没有 action');
  return {
    source: String(value?.source ?? `${impl} action catalog`),
    version: String(value?.version ?? impl),
    generatedAt: new Date().toISOString(),
    actions,
    categories: Array.isArray(value?.categories) && value.categories.length
      ? value.categories
      : deriveCategories(actions),
  };
}

/** 从 URL 或本机文件读一份原始目录；返回未归一化的对象。 */
export async function readCatalogSource(input, { token = '' } = {}) {
  const target = String(input ?? '').trim();
  if (!target) throw new Error('没有给目录来源');
  if (/^https?:\/\//i.test(target)) {
    const response = await fetch(target, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  }
  return JSON.parse(await readFile(target, 'utf8'));
}

/** 落盘到 src/catalogs/<impl>.json，返回写入路径。 */
export function saveCatalog(data, impl) {
  const path = join(CATALOG_DIR, `${impl}.json`);
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  return path;
}
