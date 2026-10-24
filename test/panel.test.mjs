/**
 * 控制台面板的数据面：state 读取、update 拉取并落盘。
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { OneBotWorld } from '../src/world.js';
import { onebotDefinition } from '../src/definition.js';
import { loadCatalog } from '../src/catalog.js';
import { normalizeCatalog } from '../src/catalog-update.js';

const NAPCAT_SHAPE = {
  ok: true,
  data: {
    get_group_info: {
      description: '获取群信息',
      payload: { type: 'object', properties: { group_id: { type: 'integer' } } },
      tags: ['群信息'],
    },
    send_group_msg: {
      description: '发送群消息',
      payload: { type: 'object', properties: { group_id: { type: 'integer' }, message: {} } },
      tags: ['消息'],
    },
    test_auto_register_01: {
      description: '测试',
      payload: { type: 'object' },
      tags: ['测试'],
    },
  },
};

test('normalizeCatalog: 解 NapCat 的 { ok, data } 外壳，按命名判只读，排除 test_*', () => {
  const catalog = normalizeCatalog(NAPCAT_SHAPE, 'napcat');
  assert.deepEqual(catalog.actions.map((action) => action.name), ['get_group_info', 'send_group_msg']);
  assert.equal(catalog.actions[0].readOnly, true);
  assert.equal(catalog.actions[1].readOnly, false);
  assert.equal(catalog.actions[1].category, '消息');
  assert.deepEqual(catalog.categories, [
    { category: '群信息', count: 1 },
    { category: '消息', count: 1 },
  ]);
});

test('normalizeCatalog: 本包格式原样通过，空输入报错', () => {
  const catalog = normalizeCatalog({ source: 'x', version: '1', actions: [{ name: 'a' }] }, 'onebot11');
  assert.equal(catalog.source, 'x');
  assert.equal(catalog.actions.length, 1);
  assert.throws(() => normalizeCatalog({ data: {} }, 'napcat'), /没有 action/);
});

test('panel: state 报当前目录，update 拉取后换掉目录', async () => {
  const target = fileURLToPath(new URL('../src/catalogs/napcat.json', import.meta.url));
  const before = readFileSync(target);

  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(NAPCAT_SHAPE));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/api/Debug/schemas`;

  try {
    const world = new OneBotWorld({ cfg: { implementation: 'napcat' } });
    const ui = world.webUi('zh');
    assert.deepEqual(ui.panels.map((panel) => panel.id), ['actions', 'receive', 'files']);

    const state = await ui.invoke('actions', 'state', []);
    assert.equal(state.impl, 'napcat');
    assert.ok(state.actions > 0);
    assert.equal(state.defaultUrl, 'http://127.0.0.1:6099/api/Debug/schemas');

    const updated = await ui.invoke('actions', 'update', [url]);
    assert.equal(updated.actions, 2);
    assert.equal(updated.categories, 2);
    assert.ok(updated.saved.endsWith('napcat.json'));

    // 更新后的目录在同一个实例上立刻生效
    const after = await ui.invoke('actions', 'state', []);
    assert.equal(after.actions, 2);

    await assert.rejects(() => ui.invoke('actions', 'nope', []), /unknown method/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    writeFileSync(target, before);
  }
});

test('panel: receive state and save, including persist wiring', async () => {
  const world = new OneBotWorld({ cfg: {} });
  const ui = world.webUi('zh');

  const state = await ui.invoke('receive', 'state', []);
  assert.equal(state.connected, false);
  assert.deepEqual(state.receive, ['*']);
  assert.equal(state.all, true);
  assert.deepEqual(state.items, []);

  const saved = await ui.invoke('receive', 'save', [['group:123', 'private:456']]);
  assert.equal(saved.saved, 'group:123, private:456');
  assert.deepEqual(saved.receive, ['group:123', 'private:456']);
  assert.equal(saved.all, false);
  assert.deepEqual(saved.items.map((item) => item.key), ['group:123', 'private:456']);

  const all = await ui.invoke('receive', 'save', [['*']]);
  assert.equal(all.saved, '*');
  assert.equal(all.all, true);
  await assert.rejects(() => ui.invoke('receive', 'save', [['nope']]), /invalid conversation key/);
  await assert.rejects(() => ui.invoke('receive', 'save', [42]), /must be an array/);

  // definition.create 必须把下发的 persist 接到 World 上，否则模型/面板写入活配置却落不了盘。
  const persisted = {};
  const fromDefinition = onebotDefinition.create({
    cfg: {},
    timezone: 'UTC',
    persist: (patch) => {
      persisted.conversations = { ...(persisted.conversations ?? {}), ...patch.conversations };
    },
  });
  await fromDefinition.webUi('zh').invoke('receive', 'save', [['group:123']]);
  assert.deepEqual(persisted.conversations, { receive: 'group:123' });
});

test('panel: 动作列表按当前策略渲染，保存写成显式禁用名单', async () => {
  const patches = [];
  const world = new OneBotWorld({
    cfg: { implementation: 'snowluma' },
    persist: (patch) => patches.push(patch),
  });
  const ui = world.webUi('zh');
  const catalog = loadCatalog({ impl: 'snowluma' });

  const state = await ui.invoke('actions', 'state', []);
  assert.equal(state.items.length, catalog.total);
  const disabled = state.items.filter((item) => !item.enabled).map((item) => item.name).sort();
  assert.deepEqual(disabled, ['bot_exit', 'clean_cache', 'send_packet', 'set_restart']);
  assert.equal(state.patterned, false);

  // 列表展示与筛选都靠这三项：描述、分类、只读标记。
  const send = state.items.find((item) => item.name === 'send_group_msg');
  assert.deepEqual(
    { summary: send.summary, category: send.category, readOnly: send.readOnly },
    { summary: '发送群消息', category: '消息', readOnly: false },
  );
  assert.equal(state.items.find((item) => item.name === 'get_group_info').readOnly, true);

  const keep = state.items.filter((item) => item.name !== 'send_group_msg').map((item) => item.name);
  const saved = await ui.invoke('actions', 'save', [keep]);
  assert.equal(saved.items.find((item) => item.name === 'send_group_msg').enabled, false);
  assert.ok(saved.saved.split(', ').includes('send_group_msg'));
  assert.deepEqual(patches.at(-1), { actions: { disabled: saved.saved } });

  await assert.rejects(() => ui.invoke('actions', 'save', [['no_such_action']]), /unknown action/);
  await assert.rejects(() => ui.invoke('actions', 'save', 'send_group_msg'), /must be an array/);

  const all = await ui.invoke('actions', 'save', [state.items.map((item) => item.name)]);
  assert.equal(all.disabled, 0);
  assert.equal(all.saved, '');
});

test('panel: 读取路径保存绝对路径并报每条路径的状态', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'onebot-paths-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const patches = [];
  const world = new OneBotWorld({ cfg: {}, persist: (patch) => patches.push(patch) });
  const ui = world.webUi('zh');

  const state = await ui.invoke('files', 'state', []);
  assert.deepEqual(state.paths, []);
  assert.equal(state.entries.length, 0);

  const saved = await ui.invoke('files', 'save', [`${dir}\n${dir}`]);
  assert.deepEqual(saved.paths, [dir]);
  assert.equal(saved.entries[0].exists, true);
  assert.equal(saved.entries[0].isDirectory, true);
  assert.deepEqual(patches.at(-1), { files: { readPaths: dir } });

  await assert.rejects(() => ui.invoke('files', 'save', ['relative/path']), /must be absolute/);
  await assert.rejects(() => ui.invoke('files', 'nope', []), /unknown method/);
});
