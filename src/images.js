/**
 * 图片获取：把 OneBot image segment 的 URL 下载成 BlobInput 的字节。
 *
 * OneBot 的 get_image / download_file_image_stream 不会直接给模型一张图：
 * 前者返回 URL/文件信息，后者是流式字节。真正让模型“看见”图，需要在事件或
 * 工具回执里带 blobs。这里只做最小的下载、来源校验与 MIME 判断。
 *
 * 来源校验：URL 主机解析到环回、内网、链路本地或组播地址时拒绝；重定向逐跳
 * 重新校验；响应边读边计数。图片服务在本机或内网时用 images.allowPrivateHosts
 * 显式放开。
 */
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

const MAX_REDIRECTS = 5;
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

/** 非公网 IPv4 网段：[前缀字节, 前缀长度]。 */
const PRIVATE_V4 = [
  [[0], 8],
  [[10], 8],
  [[100, 64], 10],
  [[127], 8],
  [[169, 254], 16],
  [[172, 16], 12],
  [[192, 0, 0], 24],
  [[192, 0, 2], 24],
  [[192, 168], 16],
  [[198, 18], 15],
  [[198, 51, 100], 24],
  [[203, 0, 113], 24],
  [[224, 0, 0, 0], 4],
  [[240, 0, 0, 0], 4],
];

/** 非公网 IPv6 网段：ULA、链路本地、组播、文档地址；环回与未指定走 IPv4 兼容分支。 */
const PRIVATE_V6 = [
  [[0xfc], 7],
  [[0xfe, 0x80], 10],
  [[0xff], 8],
  [[0x20, 0x01, 0x0d, 0xb8], 32],
];

const MIME_EXT = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
};

export function extensionForMime(mime) {
  return MIME_EXT[String(mime).toLowerCase()] ?? 'img';
}

function pickImageMime(contentType, url) {
  if (contentType) {
    const mime = contentType.split(';')[0].trim().toLowerCase();
    if (mime.startsWith('image/')) return mime;
  }
  const ext = (url.split('?')[0].match(/\.([a-zA-Z0-9]+)$/)?.[1] ?? '').toLowerCase();
  for (const [mime, extension] of Object.entries(MIME_EXT)) {
    if (extension === ext) return mime;
  }
  return 'image/jpeg';
}

/**
 * 下载一张图；只接受 http(s)。目标地址必须是公网地址（或显式 allowPrivate），
 * 重定向逐跳校验，超过 maxBytes 立即中断。
 */
export async function downloadImage(url, options = {}, fetchImpl = fetch) {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
    throw new Error(`not an http(s) image URL: ${String(url)}`);
  }
  const timeoutMs = Number(options.timeoutMs) || 10000;
  const maxBytes = Number(options.maxBytes) || 10 * 1024 * 1024;
  const allowPrivate = options.allowPrivate === true;
  const lookupImpl = typeof options.lookup === 'function' ? options.lookup : defaultLookup;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let target = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      await assertPublicUrl(target, { allowPrivate, lookupImpl });
      const response = await fetchImpl(target, { signal: controller.signal, redirect: 'manual' });
      if (REDIRECT_STATUS.has(response.status)) {
        const location = response.headers.get('location');
        if (!location) throw new Error(`HTTP ${response.status} without Location`);
        target = new URL(location, target).toString();
        continue;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const declared = Number(response.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > maxBytes) {
        throw new Error(`image too large: ${declared} > ${maxBytes}`);
      }
      const bytes = await readCapped(response, maxBytes);
      return {
        bytes,
        mime: pickImageMime(response.headers.get('content-type'), target),
      };
    }
    throw new Error('too many redirects');
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') throw new Error('image download timed out');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 只判定目标地址，不发请求；返回 null 表示可用公网访问，否则返回原因。
 * onebot_call 里交给实现对端去拉取的 URL 也走这里。
 */
export async function checkPublicUrl(raw, options = {}) {
  try {
    await assertPublicUrl(raw, {
      allowPrivate: options.allowPrivate === true,
      lookupImpl: typeof options.lookup === 'function' ? options.lookup : defaultLookup,
    });
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/** 从 message 事件里取可下载的 image segment；没有 URL 的返回空。 */
export function imageSourcesFromMessage(ev) {
  const message = ev?.message;
  if (!Array.isArray(message)) return [];
  const sources = [];
  for (let index = 0; index < message.length; index += 1) {
    const segment = message[index];
    if (segment?.type !== 'image') continue;
    const data = segment.data && typeof segment.data === 'object' ? segment.data : {};
    const candidates = [data.url, data.file];
    const url = candidates.find((value) => typeof value === 'string' && /^https?:\/\//i.test(value));
    if (url) {
      sources.push({
        index,
        url,
        file: typeof data.file === 'string' ? data.file : '',
      });
    }
  }
  return sources;
}

function defaultLookup(host) {
  return lookup(host, { all: true, verbatim: true });
}

async function assertPublicUrl(raw, { allowPrivate, lookupImpl }) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`invalid URL: ${raw}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`not an http(s) URL: ${raw}`);
  }
  if (allowPrivate) return;

  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) {
    if (isPrivateAddress(host)) throw new Error(`blocked address: ${host}`);
    return;
  }

  let records;
  try {
    records = await lookupImpl(host);
  } catch {
    throw new Error(`cannot resolve host: ${host}`);
  }
  if (!Array.isArray(records) || records.length === 0) {
    throw new Error(`cannot resolve host: ${host}`);
  }
  for (const record of records) {
    const address = typeof record === 'string' ? record : record?.address;
    if (!address || isPrivateAddress(address)) throw new Error(`blocked address: ${address || host}`);
  }
}

function isPrivateAddress(ip) {
  const family = isIP(ip);
  if (family === 4) return isPrivateV4(ip.split('.').map(Number));
  if (family !== 6) return true;

  const bytes = ipv6Bytes(ip);
  if (!bytes) return true;
  if (isV4Mapped(bytes) || isV4Compatible(bytes) || isNat64(bytes)) {
    return isPrivateV4([...bytes.slice(12)]);
  }
  return PRIVATE_V6.some(([prefix, bits]) => inPrefix(bytes, prefix, bits));
}

function isPrivateV4(bytes) {
  return PRIVATE_V4.some(([prefix, bits]) => inPrefix(bytes, prefix, bits));
}

function isV4Mapped(bytes) {
  return bytes.slice(0, 10).every((byte) => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
}

function isV4Compatible(bytes) {
  return bytes.slice(0, 12).every((byte) => byte === 0);
}

function isNat64(bytes) {
  return inPrefix(bytes, [0x00, 0x64, 0xff, 0x9b, 0, 0, 0, 0, 0, 0, 0, 0], 96);
}

function ipv6Bytes(ip) {
  let text = ip.split('%')[0];
  if (text.includes('.')) {
    const index = text.lastIndexOf(':');
    const v4 = text.slice(index + 1).split('.').map(Number);
    if (v4.length !== 4 || v4.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    text = `${text.slice(0, index + 1)}${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (missing < 0) return null;

  const groups = [...head, ...Array(missing).fill('0'), ...tail];
  if (groups.length !== 8) return null;

  const bytes = new Uint8Array(16);
  for (let index = 0; index < 8; index += 1) {
    const value = parseInt(groups[index], 16);
    if (!Number.isFinite(value) || value < 0 || value > 0xffff) return null;
    bytes[index * 2] = value >> 8;
    bytes[index * 2 + 1] = value & 0xff;
  }
  return bytes;
}

function inPrefix(bytes, prefix, bits) {
  const full = Math.floor(bits / 8);
  for (let index = 0; index < full; index += 1) {
    if (bytes[index] !== prefix[index]) return false;
  }
  const rest = bits % 8;
  if (rest === 0) return true;
  const mask = (0xff << (8 - rest)) & 0xff;
  return (bytes[full] & mask) === (prefix[full] & mask);
}

async function readCapped(response, maxBytes) {
  const body = response.body;
  if (!body || typeof body.getReader !== 'function') {
    const buffer = new Uint8Array(await response.arrayBuffer());
    if (buffer.byteLength > maxBytes) {
      throw new Error(`image too large: ${buffer.byteLength} > ${maxBytes}`);
    }
    return buffer;
  }

  const reader = body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
      total += chunk.byteLength;
      if (total > maxBytes) throw new Error(`image too large: > ${maxBytes}`);
      chunks.push(chunk);
    }
  } catch (err) {
    await reader.cancel().catch(() => { /* already closed */ });
    throw err;
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
