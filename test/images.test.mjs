import test from 'node:test';
import assert from 'node:assert/strict';

import { downloadImage, extensionForMime, imageSourcesFromMessage } from '../src/images.js';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
  'base64',
);

const failFetch = async () => {
  throw new Error('fetch must not run for a blocked URL');
};

const okResponse = (body = PNG, headers = {}) => new Response(body, {
  status: 200,
  headers: { 'content-type': 'image/png', ...headers },
});

const lookup = (address) => async () => [{ address, family: address.includes(':') ? 6 : 4 }];

test('downloadImage: 环回、内网与链路本地地址直接拒绝，不发请求', async () => {
  const hosts = [
    '127.0.0.1',
    '0.0.0.0',
    '10.1.2.3',
    '100.64.0.1',
    '169.254.169.254',
    '172.16.0.1',
    '192.168.1.1',
    '224.0.0.1',
    '255.255.255.255',
    '127.1',
    '0x7f000001',
    '2130706433',
    '[::1]',
    '[::]',
    '[fc00::1]',
    '[fe80::1]',
    '[ff02::1]',
    '[::ffff:127.0.0.1]',
    '[::ffff:7f00:1]',
    '[64:ff9b::7f00:1]',
  ];
  for (const host of hosts) {
    await assert.rejects(
      () => downloadImage(`http://${host}/a.png`, {}, failFetch),
      /blocked address/,
      host,
    );
  }
});

test('downloadImage: 主机名按解析结果判定', async () => {
  await assert.rejects(
    () => downloadImage('http://images.example/a.png', { lookup: lookup('127.0.0.1') }, failFetch),
    /blocked address: 127\.0\.0\.1/,
  );
  await assert.rejects(
    () => downloadImage('http://images.example/a.png', { lookup: async () => [] }, failFetch),
    /cannot resolve host/,
  );

  const result = await downloadImage(
    'http://images.example/a.png',
    { lookup: lookup('93.184.216.34') },
    async () => okResponse(),
  );
  assert.equal(result.mime, 'image/png');
  assert.ok(result.bytes.length > 0);
});

test('downloadImage: 重定向逐跳校验', async () => {
  const calls = [];
  const fake = async (url) => {
    calls.push(url);
    return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/a.png' } });
  };
  await assert.rejects(
    () => downloadImage('http://images.example/a.png', { lookup: lookup('93.184.216.34') }, fake),
    /blocked address: 127\.0\.0\.1/,
  );
  assert.equal(calls.length, 1);

  const hops = [];
  const publicFake = async (url) => {
    hops.push(url);
    if (hops.length === 1) {
      return new Response(null, { status: 302, headers: { location: '/b.png' } });
    }
    return okResponse();
  };
  const result = await downloadImage(
    'http://images.example/a.png',
    { lookup: lookup('93.184.216.34') },
    publicFake,
  );
  assert.equal(result.mime, 'image/png');
  assert.deepEqual(hops, ['http://images.example/a.png', 'http://images.example/b.png']);
});

test('downloadImage: 重定向次数有上限', async () => {
  const loop = async () => new Response(null, { status: 302, headers: { location: '/again.png' } });
  await assert.rejects(
    () => downloadImage('http://images.example/a.png', { lookup: lookup('93.184.216.34') }, loop),
    /too many redirects/,
  );
});

test('downloadImage: 超过字节上限时中断，不先读完', async () => {
  await assert.rejects(
    () => downloadImage(
      'http://images.example/a.png',
      { lookup: lookup('93.184.216.34'), maxBytes: 10 },
      async () => okResponse(PNG, { 'content-length': '999' }),
    ),
    /image too large: 999 > 10/,
  );

  let pulled = 0;
  const stream = new ReadableStream({
    pull(controller) {
      pulled += 1;
      controller.enqueue(new Uint8Array(8));
      if (pulled > 10) controller.close();
    },
  });
  await assert.rejects(
    () => downloadImage(
      'http://images.example/a.png',
      { lookup: lookup('93.184.216.34'), maxBytes: 10 },
      async () => new Response(stream, { headers: { 'content-type': 'image/png' } }),
    ),
    /image too large/,
  );
  assert.equal(pulled < 10, true);
});

test('downloadImage: 显式允许内网地址；协议仍限 http(s)', async () => {
  const result = await downloadImage(
    'http://127.0.0.1/a.png',
    { allowPrivate: true },
    async () => okResponse(),
  );
  assert.equal(result.mime, 'image/png');

  await assert.rejects(
    () => downloadImage('file:///C:/a.png', { allowPrivate: true }, failFetch),
    /not an http\(s\) image URL/,
  );
});

test('imageSourcesFromMessage: 只收 http(s) 图片段', () => {
  const sources = imageSourcesFromMessage({
    message: [
      { type: 'text', data: { text: 'hi' } },
      { type: 'image', data: { url: 'https://example.com/a.png', file: 'a.png' } },
      { type: 'image', data: { file: 'b.png' } },
    ],
  });
  assert.deepEqual(sources.map((source) => source.url), ['https://example.com/a.png']);
});

test('extensionForMime: 已知图片类型与兜底', () => {
  assert.equal(extensionForMime('image/png'), 'png');
  assert.equal(extensionForMime('image/jpeg'), 'jpg');
  assert.equal(extensionForMime('application/octet-stream'), 'img');
});
