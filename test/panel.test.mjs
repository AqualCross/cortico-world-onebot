/**
 * 控制台面板的数据面：state 读取、update 拉取并落盘。
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { OneBotWorld } from '../src/world.js';
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
    assert.deepEqual(ui.panels.map((panel) => panel.id), ['actions']);

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
