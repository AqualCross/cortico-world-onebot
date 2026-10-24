import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

import { OneBotWorld } from '../src/world.js';
import { loadCatalog } from '../src/catalog.js';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
  'base64',
);

const tick = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(fn, timeoutMs = 3000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = fn();
    if (value) return value;
    await tick();
  }
  throw new Error('waitFor timeout');
}

function groupMessage(groupId, messageId, text) {
  return {
    post_type: 'message',
    message_type: 'group',
    group_id: groupId,
    user_id: 456,
    message_id: messageId,
    time: 1700000000 + messageId,
    sender: { nickname: 'Alice' },
    message: [{ type: 'text', data: { text } }],
  };
}

function privateMessage(userId, messageId, text) {
  return {
    post_type: 'message',
    message_type: 'private',
    user_id: userId,
    message_id: messageId,
    time: 1700000000 + messageId,
    sender: { nickname: 'Alice' },
    message: [{ type: 'text', data: { text } }],
  };
}

function makeHost(events) {
  const logger = {
    trace() {}, debug() {}, info() {}, warn() {}, error() {}, emit() {},
    child() { return this; },
  };
  return {
    pushEvent: async (event) => {
      const saved = { ...event, cursor: events.length + 1, origin: 'external' };
      events.push(saved);
      return saved;
    },
    pushDeferred() {},
    store: {
      range: () => events,
      get: (cursor) => events.find((event) => event.cursor === cursor),
      latestCursor: () => events.length,
      around: () => [],
      grep: () => [],
    },
    modelFacts: { model: () => 'test', accepts: (mime) => mime === 'image/png', contextWindow: () => undefined },
    blob: () => null,
    reportUsage() {},
    log: logger,
  };
}

test('OneBot World: connection, action dispatcher, write gate, raw event archive', async (t) => {
  const requests = [];
  const imageServer = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'image/png' });
    res.end(PNG);
  });
  await new Promise((resolve) => imageServer.listen(0, '127.0.0.1', resolve));
  const imagePort = imageServer.address().port;

  const wss = new WebSocketServer({ port: 0 });
  await new Promise((resolve) => wss.once('listening', resolve));
  const port = wss.address().port;

  wss.on('connection', (socket) => {
    socket.on('message', (raw) => {
      const request = JSON.parse(String(raw));
      requests.push(request);
      let data = null;
      if (request.action === 'get_login_info') data = { user_id: 10001, nickname: 'Bot' };
      else if (request.action === 'get_version_info') data = { app_name: 'SnowLuma', app_version: 'test' };
      else if (request.action === 'get_group_info') data = { group_id: request.params.group_id, group_name: 'Test Group' };
      else if (request.action === 'get_group_list') data = [
        { group_id: 123, group_name: 'Test Group' },
        { group_id: 999, group_name: 'Noisy Group' },
      ];
      else if (request.action === 'get_friend_list') data = [{ user_id: 456, nickname: 'Alice' }];
      else if (request.action === 'send_group_msg') data = { message_id: 9001 };
      else data = {};
      socket.send(JSON.stringify({ status: 'ok', retcode: 0, data, echo: request.echo }));
    });
  });

  const events = [];
  const host = makeHost(events);
  const cfg = {
    wsUrl: `ws://127.0.0.1:${port}`,
    token: 'test-token',
    actions: { writePolicy: 'confirm' },
    images: { allowPrivateHosts: true },
  };
  const world = new OneBotWorld({ cfg, timezone: 'UTC' });

  t.after(async () => {
    await world.stop();
    await new Promise((resolve) => wss.close(resolve));
    await new Promise((resolve) => imageServer.close(resolve));
  });

  await world.start(host);
  await waitFor(() => events.some((event) => event.type === 'onebot.connection'));

  const tools = Object.fromEntries(world.tools().map((tool) => [tool.name, tool]));

  const catalog = await tools.onebot_actions.handler({}, {});
  const catalogData = JSON.parse(catalog);
  assert.equal(catalogData.total, loadCatalog({ impl: 'snowluma' }).total);
  assert.ok(catalogData.categories.length > 0);

  const query = await tools.onebot_actions.handler({ name: 'send_group_msg' }, {});
  const queryData = JSON.parse(query);
  assert.equal(queryData.action.name, 'send_group_msg');
  assert.ok(queryData.action.inputSchema);

  const read = await tools.onebot_call.handler({
    action: 'get_group_info',
    params: { group_id: 123 },
  }, {});
  const readData = JSON.parse(read);
  assert.equal(readData.ok, true);
  assert.equal(readData.data.group_name, 'Test Group');

  const staged = await tools.onebot_call.handler({
    action: 'send_group_msg',
    params: { group_id: 123, message: 'hello' },
  }, {});
  assert.match(staged, /^\[confirm required\]/);

  const sent = await tools.onebot_call.handler({
    action: 'send_group_msg',
    params: { group_id: 123, message: 'hello' },
    confirm: true,
  }, {});
  const sentData = JSON.parse(sent);
  assert.equal(sentData.ok, true);
  assert.equal(sentData.data.message_id, 9001);

  // 本地文件读取默认全拒，且拦截发生在写操作确认之前。
  const outside = fileURLToPath(new URL('../package.json', import.meta.url));
  const blockedUpload = await tools.onebot_call.handler({
    action: 'upload_group_file',
    params: { group_id: 123, file: outside },
    confirm: true,
  }, {});
  assert.equal(blockedUpload.failed, true);
  assert.match(blockedUpload.text, /^\[blocked\].*no read paths are allowed/);

  const stagedBlock = await tools.onebot_call.handler({
    action: 'send_group_msg',
    params: { group_id: 123, message: [{ type: 'image', data: { file: outside } }] },
  }, {});
  assert.equal(stagedBlock.failed, true);
  assert.match(stagedBlock.text, /^\[blocked\]/);

  const allowDir = mkdtempSync(join(tmpdir(), 'onebot-read-'));
  t.after(() => rmSync(allowDir, { recursive: true, force: true }));
  const allowedFile = join(allowDir, 'voice.amr');
  writeFileSync(allowedFile, 'x');
  await world.webUi('zh').invoke('files', 'save', [allowDir]);

  const uploadAllowed = JSON.parse(await tools.onebot_call.handler({
    action: 'upload_group_file',
    params: { group_id: 123, file: allowedFile },
    confirm: true,
  }, {}));
  assert.equal(uploadAllowed.ok, true);

  // 被禁用的 action 对模型等同于不存在：两者回执一致，只有回显的 action 名不同。
  const hidden = await tools.onebot_call.handler({
    action: 'set_restart',
    params: {},
    confirm: true,
  }, {});
  const missing = await tools.onebot_call.handler({
    action: 'no_such_action',
    params: {},
    confirm: true,
  }, {});
  assert.equal(hidden.failed, true);
  assert.equal(hidden.text, missing.text.replace('no_such_action', 'set_restart'));

  const server = wss.clients.values().next().value;
  server.send(JSON.stringify({
    post_type: 'message',
    message_type: 'group',
    group_id: 123,
    user_id: 456,
    message_id: 789,
    time: 1700000000,
    sender: { nickname: 'Alice' },
    message: [
      { type: 'text', data: { text: 'hi there' } },
      { type: 'image', data: { url: `http://127.0.0.1:${imagePort}/a.png`, file: 'a.png' } },
    ],
  }));

  const message = await waitFor(() => events.find((event) => event.type === 'onebot.message'));
  assert.match(message.text, /Alice\(456\): hi there.*#789/);
  assert.equal(message.meta.kind, 'message/group');
  assert.deepEqual(message.meta.conv, { kind: 'group', id: 123 });
  assert.equal(message.meta.raw.message_id, 789);
  assert.equal(message.blobs.length, 1);
  assert.equal(message.blobs[0].mime, 'image/png');
  assert.ok(message.blobs[0].bytes.length > 0);

  const viewed = await tools.onebot_view_image.handler({
    url: `http://127.0.0.1:${imagePort}/a.png`,
  }, {});
  assert.equal(viewed.blobs.length, 1);
  assert.equal(viewed.blobs[0].mime, 'image/png');
  assert.match(viewed.text, /^\[image /);

  // action 参数里的 URL 由实现对端拉取，同一套公网判定在 onebot_call 上生效。
  cfg.images.allowPrivateHosts = false;
  const blockedFetch = await tools.onebot_call.handler({
    action: 'download_file',
    params: { url: `http://127.0.0.1:${imagePort}/a.png` },
    confirm: true,
  }, {});
  assert.equal(blockedFetch.failed, true);
  assert.match(blockedFetch.text, /^\[blocked\].*blocked address: 127\.0\.0\.1/);

  const blockedSegment = await tools.onebot_call.handler({
    action: 'send_group_msg',
    params: {
      group_id: 123,
      message: [{ type: 'image', data: { url: `http://127.0.0.1:${imagePort}/a.png` } }],
    },
  }, {});
  assert.equal(blockedSegment.failed, true);
  assert.match(blockedSegment.text, /^\[blocked\]/);

  cfg.images.allowPrivateHosts = true;
  const allowedFetch = JSON.parse(await tools.onebot_call.handler({
    action: 'download_file',
    params: { url: `http://127.0.0.1:${imagePort}/a.png` },
    confirm: true,
  }, {}));
  assert.equal(allowedFetch.ok, true);

  const archived = await tools.onebot_events.handler({ kind: 'message/*', limit: 10 }, {});
  const archivedData = JSON.parse(archived);
  assert.equal(archivedData.count, 1);
  assert.equal(archivedData.events[0].raw.message_id, 789);

  const status = JSON.parse(await tools.onebot_status.handler({}, {}));
  assert.equal(status.connected, true);
  assert.equal(status.selfId, 10001);
  assert.ok(status.catalog.source);
  assert.deepEqual(status.files.readPaths, [resolve(allowDir)]);
  assert.ok(requests.some((request) => request.action === 'send_group_msg'));

  // 控制台的连接徽标要说出连的是哪个实现，而不只是“已连接”。
  const badge = world.webUi('zh').badges.find((item) => item.label === '连接');
  assert.equal(badge.value, 'snowluma：Bot');

  // 接收名单：默认全收；切换后未接收的会话在事件泵入口被丢弃，不落事件库。
  const receiveList = JSON.parse(await tools.onebot_receive.handler({}, {}));
  assert.equal(receiveList.connected, true);
  assert.deepEqual(receiveList.receive, ['*']);
  assert.equal(receiveList.all, true);
  assert.deepEqual(
    receiveList.conversations.map((item) => item.key).sort(),
    ['group:123', 'group:999', 'private:456'],
  );
  assert.ok(receiveList.conversations.every((item) => item.received));

  const stagedReceive = await tools.onebot_receive.handler({
    action: 'set',
    conversations: ['group:123'],
  }, {});
  assert.match(stagedReceive, /^\[confirm required\]/);

  const setReceive = JSON.parse(await tools.onebot_receive.handler({
    action: 'set',
    conversations: ['group:123'],
    confirm: true,
  }, {}));
  assert.deepEqual(setReceive.receive, ['group:123']);

  server.send(JSON.stringify(groupMessage(999, 888, 'noisy group')));
  server.send(JSON.stringify(privateMessage(456, 889, 'private')));
  server.send(JSON.stringify({
    post_type: 'notice',
    notice_type: 'group_recall',
    group_id: 999,
    user_id: 456,
    message_id: 888,
    time: 1700000888,
  }));
  server.send(JSON.stringify(groupMessage(123, 890, 'kept')));

  await waitFor(() => events.some((event) => (
    event.type === 'onebot.message' && event.meta.raw.message_id === 890
  )));
  await tick(100);
  assert.equal(events.some((event) => event.meta?.raw?.message_id === 888), false);
  assert.equal(events.some((event) => event.meta?.raw?.message_id === 889), false);
  assert.equal(events.some((event) => event.meta?.kind === 'notice/group_recall'), false);

  // 从「全部」里移除一个，存成显式名单；之后这个群不再产生事件。
  await tools.onebot_receive.handler({ action: 'set', conversations: ['*'], confirm: true }, {});
  const removed = JSON.parse(await tools.onebot_receive.handler({
    action: 'remove',
    conversations: ['group:999'],
    confirm: true,
  }, {}));
  assert.deepEqual(removed.receive.slice().sort(), ['group:123', 'private:456']);

  server.send(JSON.stringify(groupMessage(999, 891, 'still noisy')));
  server.send(JSON.stringify(groupMessage(123, 892, 'still kept')));
  await waitFor(() => events.some((event) => (
    event.type === 'onebot.message' && event.meta.raw.message_id === 892
  )));
  await tick(100);
  assert.equal(events.some((event) => event.meta?.raw?.message_id === 891), false);

  const statusAfter = JSON.parse(await tools.onebot_status.handler({}, {}));
  assert.deepEqual(statusAfter.conversations.receive.slice().sort(), ['group:123', 'private:456']);
  assert.equal(statusAfter.conversations.all, false);

  // 动作列表保存后，未勾选的动作对模型等同于不存在。
  const ui = world.webUi('zh');
  const listed = await ui.invoke('actions', 'state', []);
  const allNames = listed.items.map((item) => item.name);
  await ui.invoke('actions', 'save', [allNames.filter((name) => name !== 'send_group_msg')]);
  const hiddenByPanel = await tools.onebot_call.handler({
    action: 'send_group_msg',
    params: { group_id: 123, message: 'hello' },
    confirm: true,
  }, {});
  assert.equal(hiddenByPanel.failed, true);
  assert.match(hiddenByPanel.text, /\[unknown action\] send_group_msg/);
  await ui.invoke('actions', 'save', [allNames]);
});

test('onebot_receive: readOnly and deny block writes without a connection', async () => {
  for (const [cfg, pattern] of [
    [{ actions: { readOnly: true } }, /\[read-only\]/],
    [{ actions: { writePolicy: 'deny' } }, /\[denied\]/],
  ]) {
    const world = new OneBotWorld({ cfg });
    const tool = world.tools().find((item) => item.name === 'onebot_receive');
    const result = await tool.handler({ action: 'set', conversations: ['group:123'], confirm: true }, {});
    assert.equal(result.failed, true);
    assert.match(result.text, pattern);
  }

  const world = new OneBotWorld({ cfg: {} });
  const tool = world.tools().find((item) => item.name === 'onebot_receive');
  const list = JSON.parse(await tool.handler({}, {}));
  assert.equal(list.connected, false);
  assert.deepEqual(list.receive, ['*']);
  assert.equal(list.error, 'OneBot is not connected; only the current receive list is shown.');
});
