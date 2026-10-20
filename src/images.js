/**
 * 图片获取：把 OneBot image segment 的 URL 下载成 BlobInput 的字节。
 *
 * OneBot 的 get_image / download_file_image_stream 不会直接给模型一张图：
 * 前者返回 URL/文件信息，后者是流式字节。真正让模型“看见”图，需要在事件或
 * 工具回执里带 blobs。这里只做最小的下载与 MIME 判断。
 */

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

/** 下载一张图；只接受 http(s)，超时/过大/非 2xx 都抛错。 */
export async function downloadImage(url, options = {}, fetchImpl = fetch) {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
    throw new Error(`not an http(s) image URL: ${String(url)}`);
  }
  const timeoutMs = Number(options.timeoutMs) || 10000;
  const maxBytes = Number(options.maxBytes) || 10 * 1024 * 1024;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > maxBytes) {
      throw new Error(`image too large: ${buffer.byteLength} > ${maxBytes}`);
    }
    return {
      bytes: new Uint8Array(buffer),
      mime: pickImageMime(response.headers.get('content-type'), url),
    };
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') throw new Error('image download timed out');
    throw err;
  } finally {
    clearTimeout(timer);
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
