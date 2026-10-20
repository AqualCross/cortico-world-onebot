#!/usr/bin/env node
/**
 * 从 NapCatQQ 源码生成 action 目录（维护者用，不随包发布）。
 *
 * NapCat 的 action 类声明了 actionName / actionSummary / actionTags / payloadSchema，
 * 但只有运行中的实例才会把它们吐出来。这个脚本直接读源码：
 *   - actionName 从 router.ts 的 ActionName 表解析；
 *   - payloadSchema 用 TypeBox 的替身求值成 JSON Schema，父类声明的沿继承链上溯；
 *   - 引用了 action 目录之外的常量时，那个字段退化成宽松 schema。
 *
 * 用法：
 *   node tools/gen-napcat-catalog.mjs --from "D:\path\to\NapCatQQ"
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const OPTIONAL = Symbol('optional');

const pick = (opts) => {
  const out = {};
  for (const key of ['description', 'title', 'default', 'minimum', 'maximum', 'enum']) {
    if (opts?.[key] !== undefined) out[key] = opts[key];
  }
  if (opts?.additionalProperties !== undefined) out.additionalProperties = opts.additionalProperties;
  return out;
};

/** TypeBox 的替身：只保留 JSON Schema 语义。 */
const Type = {
  Object(properties = {}, opts = {}) {
    const props = {};
    const required = [];
    for (const [key, value] of Object.entries(properties)) {
      if (value && value[OPTIONAL]) {
        const { [OPTIONAL]: _drop, ...rest } = value;
        props[key] = rest;
      } else {
        props[key] = value;
        required.push(key);
      }
    }
    return { type: 'object', properties: props, ...(required.length ? { required } : {}), ...pick(opts) };
  },
  Optional: (schema) => ({ ...schema, [OPTIONAL]: true }),
  String: (opts = {}) => ({ type: 'string', ...pick(opts) }),
  Number: (opts = {}) => ({ type: 'number', ...pick(opts) }),
  Integer: (opts = {}) => ({ type: 'integer', ...pick(opts) }),
  Boolean: (opts = {}) => ({ type: 'boolean', ...pick(opts) }),
  Null: (opts = {}) => ({ type: 'null', ...pick(opts) }),
  Unknown: (opts = {}) => ({ ...pick(opts) }),
  Any: (opts = {}) => ({ ...pick(opts) }),
  Void: () => ({}),
  Undefined: () => ({}),
  Literal: (value, opts = {}) => ({ const: value, ...pick(opts) }),
  Enum: (values, opts = {}) => ({ enum: [...values], ...pick(opts) }),
  Union: (schemas, opts = {}) => ({ anyOf: schemas, ...pick(opts) }),
  Intersect: (schemas, opts = {}) => ({ allOf: schemas, ...pick(opts) }),
  Array: (items, opts = {}) => ({ type: 'array', items, ...pick(opts) }),
  Tuple: (items, opts = {}) => ({ type: 'array', items, ...pick(opts) }),
  Record: (_key, value, opts = {}) => ({ type: 'object', additionalProperties: value, ...pick(opts) }),
  Ref: (name, opts = {}) => ({ $ref: name, ...pick(opts) }),
  Partial: (schema, opts = {}) => ({ ...schema, required: undefined, ...pick(opts) }),
  Omit(schema, keys, opts = {}) {
    const drop = new Set(keys);
    const properties = {};
    for (const [key, value] of Object.entries(schema.properties ?? {})) {
      if (!drop.has(key)) properties[key] = value;
    }
    const required = (schema.required ?? []).filter((key) => !drop.has(key));
    return { ...schema, properties, ...(required.length ? { required } : {}), ...pick(opts) };
  },
  Pick(schema, keys, opts = {}) {
    const keep = new Set(keys);
    const properties = {};
    for (const [key, value] of Object.entries(schema.properties ?? {})) {
      if (keep.has(key)) properties[key] = value;
    }
    return { ...schema, properties, ...pick(opts) };
  },
};

/** 引用不到的标识符（外部常量、辅助函数）统一当成“宽松 schema”。 */
const ANY = new Proxy(function any() {}, {
  get: (_target, key) => (key === Symbol.toPrimitive ? () => '' : ANY),
  apply: () => ANY,
  construct: () => ANY,
});

function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function readExpression(src, start) {
  let depth = 0;
  let quote = '';
  for (let i = start; i < src.length; i += 1) {
    const ch = src[i];
    if (quote) {
      if (ch === '\\') i += 1;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') {
      depth -= 1;
      if (depth < 0) return src.slice(start, i).trim();
    } else if (ch === ';' && depth === 0) return src.slice(start, i).trim();
  }
  return '';
}

function sanitize(expr) {
  return expr
    .replace(/\s+as\s+const\b/g, '')
    .replace(/\s+satisfies\s+[A-Za-z_][\w.<>\[\]]*/g, '')
    .replace(/\s+as\s+[A-Za-z_][\w.<>\[\]]*/g, '');
}

function makeScope(consts) {
  const memo = new Map();
  const resolveConst = (name) => {
    if (memo.has(name)) return memo.get(name);
    const expr = consts.get(name);
    if (!expr) return ANY;
    memo.set(name, ANY); // 防循环
    let value = ANY;
    try {
      value = evaluate(expr, consts, memo);
    } catch {
      value = ANY;
    }
    memo.set(name, value);
    return value;
  };
  return new Proxy({}, {
    has: (_target, key) => typeof key === 'string' && key !== 'Symbol(Symbol.unscopables)',
    get: (_target, key) => {
      if (key === Symbol.unscopables) return undefined;
      if (key === 'Type') return Type;
      if (typeof key !== 'string') return undefined;
      return consts.has(key) ? resolveConst(key) : ANY;
    },
  });
}

function evaluate(expr, consts, memo) {
  const code = sanitize(expr);
  const fn = new Function('__scope', `with (__scope) { return (${code}); }`);
  return fn(makeScope(consts, memo));
}

function collectConsts(src) {
  const found = new Map();
  const re = /\bconst\s+([A-Za-z0-9_]+)\s*(?::[^=]+)?=\s*/g;
  let match;
  while ((match = re.exec(src))) {
    const expr = readExpression(src, re.lastIndex);
    if (expr && expr.includes('Type.')) found.set(match[1], expr);
  }
  return found;
}

function parseActionNames(src) {
  const anchor = src.indexOf('export const ActionName');
  if (anchor < 0) return {};
  const body = readExpression(src, src.indexOf('{', anchor) + 1);
  const map = {};
  for (const item of body.matchAll(/([A-Za-z0-9_]+)\s*:\s*'([^']*)'/g)) map[item[1]] = item[2];
  return map;
}

const READ_ONLY = [/^_?get_/i, /^nc_get_/i, /^can_send_/i, /^fetch_/i, /^check_/i, /^translate_/i, /^ocr_/i, /^\.?(get_|ocr_)/i];
const SKIP = /^(unknown|test_)/i;
const FALLBACK_SCHEMA = { type: 'object', properties: {}, additionalProperties: true };

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      if (entry === 'test' || entry === 'example') continue;
      out.push(...walk(path));
    } else if (entry.endsWith('.ts')) {
      out.push(path);
    }
  }
  return out;
}

const root = arg('--from');
if (!root) {
  console.error('用法：node tools/gen-napcat-catalog.mjs --from <NapCatQQ 目录> [--out 文件]');
  process.exit(2);
}

const actionDir = join(resolve(root), 'packages', 'napcat-onebot', 'action');
const actionNames = parseActionNames(readFileSync(join(actionDir, 'router.ts'), 'utf8'));

/** className → { parent, payloadExpr, consts, file, nameKey, summary, tags } */
const classes = new Map();

for (const file of walk(actionDir)) {
  if (file.endsWith('router.ts')) continue;
  const src = readFileSync(file, 'utf8');
  const consts = collectConsts(src);
  const classRe = /class\s+([A-Za-z0-9_]+)\s+extends\s+([A-Za-z0-9_]+)/g;
  let match;
  const starts = [];
  while ((match = classRe.exec(src))) starts.push({ name: match[1], parent: match[2], index: match.index });
  starts.forEach((entry, i) => {
    const body = src.slice(entry.index, starts[i + 1]?.index ?? src.length);
    classes.set(entry.name, {
      parent: entry.parent,
      payloadExpr: /override\s+payloadSchema\s*=\s*([^;]+);/.exec(body)?.[1]?.trim(),
      nameKey: /override\s+actionName\s*=\s*ActionName\.([A-Za-z0-9_]+)/.exec(body)?.[1],
      summary: (/override\s+actionSummary\s*=\s*'([^']*)'/.exec(body)
        ?? /override\s+actionDescription\s*=\s*'([^']*)'/.exec(body))?.[1] ?? '',
      tags: (/override\s+actionTags\s*=\s*\[([^\]]*)\]/.exec(body)?.[1] ?? '')
        .split(',').map((part) => part.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean),
      consts,
      file,
    });
  });
}

function resolvePayload(className, depth = 0) {
  if (depth > 8) return null;
  const info = classes.get(className);
  if (!info) return null;
  if (info.payloadExpr) {
    try {
      const expr = /^[A-Za-z0-9_]+$/.test(info.payloadExpr)
        ? info.consts.get(info.payloadExpr)
        : info.payloadExpr;
      if (!expr) return null;
      const schema = evaluate(expr, info.consts, new Map());
      if (schema && typeof schema === 'object' && (schema.type === 'object' || schema.properties)) {
        return schema.type ? schema : { type: 'object', ...schema };
      }
    } catch {
      return null;
    }
  }
  return resolvePayload(info.parent, depth + 1);
}

const actions = [];
const seen = new Set();
let exact = 0;
let loose = 0;

for (const [className, info] of classes) {
  const name = actionNames[info.nameKey];
  if (!name || SKIP.test(name) || seen.has(name)) continue;

  const inputSchema = resolvePayload(className) ?? FALLBACK_SCHEMA;
  if (inputSchema === FALLBACK_SCHEMA) loose += 1;
  else exact += 1;

  seen.add(name);
  actions.push({
    name,
    aliases: [],
    summary: info.summary,
    readOnly: READ_ONLY.some((pattern) => pattern.test(name)),
    category: info.tags[0] ?? '未分类',
    inputSchema,
  });
}

actions.sort((a, b) => a.name.localeCompare(b.name));

const counts = new Map();
for (const action of actions) counts.set(action.category, (counts.get(action.category) ?? 0) + 1);

const catalog = {
  source: 'NapCat action catalog',
  version: `NapCatQQ@${new Date().toISOString().slice(0, 10)}`,
  generatedAt: new Date().toISOString(),
  actions,
  categories: [...counts.entries()].map(([category, count]) => ({ category, count })),
};

const out = resolve(arg('--out') ?? join(process.cwd(), 'src', 'catalogs', 'napcat.json'));
writeFileSync(out, `${JSON.stringify(catalog, null, 2)}\n`, 'utf8');
console.log(`已写入 ${out}`);
console.log(`  actions: ${actions.length} / categories: ${catalog.categories.length}`);
console.log(`  带参数 schema: ${exact} / 宽松 schema: ${loose}`);
const missing = Object.values(actionNames).filter((name) => !seen.has(name) && !SKIP.test(name));
console.log(`  ActionName 里有但没生成: ${missing.length}${missing.length ? ` → ${missing.slice(0, 12).join(', ')}` : ''}`);
