/**
 * 本地文件读取白名单。
 *
 * onebot_call 的参数原样发给实现：file / image / video / record 这类参数填绝对路径，
 * 实现就会读宿主上的文件并随消息发出。调用前先把这些取值和消息段里的 file 收出来，
 * 逐个按 worlds.onebot.files.readPaths 判定。
 *
 * URL 与 base64 不读本地，直接放过；绝对路径与 file:// 必须落在白名单内；
 * 相对路径一律拒绝，只有只读 action 的裸文件名例外——那是实现侧的缓存标识。
 * 参数里的 http(s) URL 由实现对端拉取，另走公网地址判定，和图片下载同一套规则。
 */
import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkPublicUrl } from './images.js';

const REMOTE = /^(?:https?:\/\/|base64:\/\/|data:)/i;
const HTTP = /^https?:\/\//i;
const FILE_ROLES = new Set(['file', 'image', 'video', 'record', 'audio']);
const MESSAGE_NAMES = new Set(['message', 'messages']);
const PATH_NAMES = new Set(['files', 'images']);
const URL_NAMES = new Set(['url', 'urls', 'link', 'links', 'uri']);
const PATH_KEYS = ['file', 'path', 'file_path', 'thumb_path', 'url'];
const SEGMENT_TYPES = new Set(['image', 'record', 'video', 'file', 'audio', 'voice']);
const CQ_FILE_TYPES = new Set(['image', 'record', 'video', 'file']);

/** 白名单只按换行分隔：Windows 路径里逗号、分号都是合法字符。 */
export function readPathsOf(cfg) {
  const raw = cfg?.files?.readPaths;
  const list = Array.isArray(raw) ? raw.map(String) : String(raw ?? '').split(/\r?\n/);
  return [...new Set(list.map((entry) => entry.trim()).filter(Boolean))];
}

/** 面板保存用：只接受绝对路径，返回规范化后的去重列表。 */
export function normalizeReadPaths(value) {
  const raw = Array.isArray(value) ? value : String(value ?? '').split(/\r?\n/);
  const paths = [];
  for (const entry of raw) {
    const text = String(entry ?? '').trim();
    if (!text) continue;
    if (!isAbsolute(text)) throw new Error(`read path must be absolute: ${text}`);
    const path = resolve(text);
    if (!paths.includes(path)) paths.push(path);
  }
  return paths;
}

/** 面板状态用：这条白名单在本机是否存在、是目录还是文件。 */
export function readPathStatus(path) {
  const resolved = realOrSelf(resolve(path));
  try {
    const stat = statSync(path);
    return { path, resolved, exists: true, isDirectory: stat.isDirectory() };
  } catch (err) {
    return { path, resolved, exists: false, isDirectory: false, error: String(err?.code ?? err) };
  }
}

/**
 * 判定一个取值能否读。返回 null 表示放过，否则返回一句原因。
 * 只读 action 的裸文件名是实现侧缓存标识，按 tokenOk 放过。
 */
export function checkLocalPath(value, allowed, { tokenOk = false } = {}) {
  const raw = String(value ?? '');
  if (!raw || !raw.trim()) return null;
  if (raw.includes('\0')) return 'contains a NUL byte';
  if (REMOTE.test(raw)) return null;

  let target = raw;
  if (/^file:\/\//i.test(raw)) {
    try {
      target = fileURLToPath(raw);
    } catch {
      return 'is not a valid file URL';
    }
  }

  if (!isAbsolute(target)) {
    const looksLikePath = /[\\/]/.test(raw) || /^[A-Za-z]:/.test(raw) || raw.startsWith('..');
    if (!looksLikePath && tokenOk) return null;
    return 'is a relative path';
  }

  const resolved = realOrSelf(resolve(target));
  for (const root of allowed) {
    if (isInside(resolved, realOrSelf(resolve(root)))) return null;
  }
  return allowed.length
    ? 'is outside the allowed read paths'
    : 'is blocked because no read paths are allowed';
}

/** 一次调用里所有会当作文件或 URL 传给实现的取值。 */
export function collectInputRefs(spec, params) {
  const refs = [];
  if (!params || typeof params !== 'object' || Array.isArray(params)) return refs;

  const roles = roleMap(spec);
  const messageParams = messageParamNames(spec);
  for (const [name, value] of Object.entries(params)) {
    const role = roles.get(name) ?? '';
    if (FILE_ROLES.has(role)) collectPathValues(value, refs, name);
    else if (PATH_NAMES.has(name) || /(?:^|_)path$/i.test(name)) collectPathValues(value, refs, name);
    if (URL_NAMES.has(name) || /_url$/i.test(name)) collectPathValues(value, refs, name);
    if (messageParams.has(name) || role === 'message') walkMessage(value, refs, name);
  }
  return refs;
}

/** 本地路径有违规就返回 { path, via, reason }，否则 null。 */
export function checkActionParams(spec, params, cfg) {
  const allowed = readPathsOf(cfg);
  const tokenOk = spec?.readOnly === true;
  for (const ref of collectInputRefs(spec, params)) {
    const reason = checkLocalPath(ref.value, allowed, { tokenOk });
    if (reason) return { path: ref.value, via: ref.via, reason };
  }
  return null;
}

/**
 * URL 有违规就返回 { url, via, reason }，否则 null。
 * 实现会替调用方拉取这些地址，所以和图片下载用同一套公网判定。
 */
export async function checkActionUrls(spec, params, cfg, options = {}) {
  const allowPrivate = cfg?.images?.allowPrivateHosts === true;
  for (const ref of collectInputRefs(spec, params)) {
    if (!HTTP.test(ref.value)) continue;
    const reason = await checkPublicUrl(ref.value, { allowPrivate, lookup: options.lookup });
    if (reason) return { url: ref.value, via: ref.via, reason };
  }
  return null;
}

function roleMap(spec) {
  const roles = new Map();
  const props = spec?.inputSchema?.properties ?? {};
  for (const param of spec?.params ?? []) {
    if (!param?.name) continue;
    const role = param.role || props[param.name]?.['x-role'] || '';
    if (role) roles.set(param.name, role);
  }
  for (const [name, prop] of Object.entries(props)) {
    const role = prop && typeof prop === 'object' ? prop['x-role'] : '';
    if (role && !roles.has(name)) roles.set(name, role);
  }
  return roles;
}

function messageParamNames(spec) {
  const names = new Set();
  for (const param of spec?.params ?? []) {
    if (!param?.name) continue;
    if (param.type === 'message' || MESSAGE_NAMES.has(param.name)) names.add(param.name);
  }
  return names;
}

function collectPathValues(value, refs, via) {
  if (typeof value === 'string') {
    refs.push({ via, value });
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectPathValues(item, refs, `${via}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const key of PATH_KEYS) {
    if (value[key] !== undefined) collectPathValues(value[key], refs, `${via}.${key}`);
  }
}

/** 消息可以是字符串（CQ 码）、消息段数组或单个消息段。 */
function walkMessage(value, refs, via) {
  if (typeof value === 'string') {
    scanCq(value, refs, via);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => walkMessage(item, refs, `${via}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') return;

  const type = typeof value.type === 'string' ? value.type.toLowerCase() : '';
  const data = value.data && typeof value.data === 'object' ? value.data : null;
  if (data) {
    if (!type || SEGMENT_TYPES.has(type)) {
      for (const key of ['file', 'path', 'url']) {
        if (typeof data[key] === 'string') refs.push({ via: `${via}.${key}`, value: data[key] });
      }
    }
    if (data.content !== undefined) walkMessage(data.content, refs, `${via}.content`);
  }
  if (value.content !== undefined && value.content !== data?.content) {
    walkMessage(value.content, refs, `${via}.content`);
  }
  if (Array.isArray(value.messages)) walkMessage(value.messages, refs, `${via}.messages`);
}

function scanCq(text, refs, via) {
  for (const match of text.matchAll(/\[CQ:([A-Za-z0-9_.-]+)(?:,[^\]]*)?\]/g)) {
    const type = match[1].toLowerCase();
    if (!CQ_FILE_TYPES.has(type)) continue;
    const file = /(?:^|,)file=([^,\]]*)/.exec(match[0]);
    if (!file) continue;
    refs.push({ via: `${via}.CQ:${type}`, value: unescapeCq(file[1]) });
  }
}

function unescapeCq(value) {
  return value
    .replace(/&#44;/g, ',')
    .replace(/&#91;/g, '[')
    .replace(/&#93;/g, ']')
    .replace(/&amp;/g, '&');
}

function realOrSelf(path) {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function isInside(target, root) {
  const rel = relative(root, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}
