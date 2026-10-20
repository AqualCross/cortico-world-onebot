/**
 * action 目录。
 *
 * 按 OneBot 实现分文件放在 catalogs/ 下；加载优先级：
 *   ONEBOT_CATALOG 环境变量 → catalogs/<impl>.json → catalogs/onebot11.json
 *
 * 目录只决定模型“看得见哪些 action”，被禁用的项在这里就已经被滤掉。
 */
import { existsSync, readFileSync } from 'node:fs';

/** 不带任何实现特征的 OneBot v11 标准 action，永远存在的兜底。 */
export const STANDARD_IMPL = 'onebot11';

/** 可选实现。auto 只出现在配置里，加载时一定已解析成具体实现。 */
export const IMPLEMENTATIONS = ['auto', 'snowluma', 'napcat', 'onebot11'];

function readJson(pathOrUrl) {
  try {
    return JSON.parse(readFileSync(pathOrUrl, 'utf8'));
  } catch {
    return null;
  }
}

function implPath(impl) {
  return new URL(`./catalogs/${impl}.json`, import.meta.url);
}

/** 这个实现是否随包带了目录文件；没有就只能退回标准目录。 */
export function hasImplCatalog(impl) {
  return existsSync(implPath(impl));
}

function deriveCategories(actions) {
  const counts = new Map();
  for (const action of actions) {
    const category = String(action.category ?? '未分类');
    counts.set(category, (counts.get(category) ?? 0) + 1);
  }
  return [...counts.entries()].map(([category, count]) => ({ category, count }));
}

function shape(raw, fallbackSource) {
  const actions = Array.isArray(raw)
    ? raw
    : (Array.isArray(raw?.actions) ? raw.actions : []);
  return {
    source: String(raw?.source ?? fallbackSource),
    version: String(raw?.version ?? ''),
    actions,
    categories: Array.isArray(raw?.categories) ? raw.categories : [],
  };
}

export class Catalog {
  constructor(data, { impl = '', path = '' } = {}) {
    this.impl = impl;
    this.path = path;
    this.source = data.source;
    this.version = data.version;
    this.actions = data.actions;
    this.categories = data.categories?.length ? data.categories : deriveCategories(data.actions);
    this.byName = new Map();
    for (const action of this.actions) {
      if (!action?.name) continue;
      this.byName.set(action.name, action);
      for (const alias of action.aliases ?? []) this.byName.set(alias, action);
    }
  }

  get total() {
    return this.actions.length;
  }

  resolve(name) {
    return this.byName.get(String(name ?? '').trim()) ?? null;
  }

  static lite(action) {
    return {
      name: action.name,
      category: action.category,
      summary: action.summary ?? '',
      readOnly: action.readOnly === true,
      aliases: action.aliases ?? [],
    };
  }

  /** 按关键词/分类列出 action。被禁用的项直接不出现，调用方看不到它们。 */
  list({ query = '', category = '', policy = { disabled: () => false }, limit = 50 } = {}) {
    const q = String(query).trim().toLowerCase();
    const cat = String(category).trim();
    const filtered = this.actions.filter((action) => {
      if (cat && action.category !== cat) return false;
      if (policy.disabled(action, action.name)) return false;
      if (!q) return true;
      return action.name.toLowerCase().includes(q)
        || String(action.summary ?? '').toLowerCase().includes(q)
        || (action.aliases ?? []).some((alias) => alias.toLowerCase().includes(q));
    });
    return {
      total: filtered.length,
      actions: filtered.slice(0, Math.max(1, limit)).map((action) => Catalog.lite(action)),
    };
  }

  counts(policy) {
    let disabled = 0;
    for (const action of this.actions) {
      if (policy.disabled(action, action.name)) disabled += 1;
    }
    return { total: this.total, enabled: this.total - disabled, disabled };
  }

  summary() {
    return { source: this.source, total: this.total, categories: this.categories };
  }
}

/**
 * 载入目录。impl 必须是具体实现（auto 由调用方解析）。
 * 找不到对应实现的文件时退回 OneBot v11 标准目录。
 */
export function loadCatalog({ impl = STANDARD_IMPL, override = '' } = {}) {
  const explicit = String(override || process.env.ONEBOT_CATALOG || '').trim();
  const wanted = impl === 'auto' || !impl ? STANDARD_IMPL : impl;

  const candidates = [];
  if (explicit) candidates.push({ path: explicit, impl: wanted });
  if (wanted !== STANDARD_IMPL) candidates.push({ path: implPath(wanted), impl: wanted });
  candidates.push({ path: implPath(STANDARD_IMPL), impl: STANDARD_IMPL });

  for (const candidate of candidates) {
    const raw = readJson(candidate.path);
    if (!raw) continue;
    const data = shape(raw, `${candidate.impl} catalog`);
    if (!data.actions.length) continue;
    return new Catalog(data, { impl: wanted, path: String(candidate.path) });
  }
  return new Catalog(
    { source: 'no catalog', version: '', actions: [], categories: [] },
    { impl: wanted },
  );
}
