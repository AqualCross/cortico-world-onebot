/**
 * 目录层：多实现加载、禁用过滤、找不到文件时退回标准目录。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  Catalog,
  STANDARD_IMPL,
  hasImplCatalog,
  loadCatalog,
} from '../src/catalog.js';

test('loadCatalog: 标准目录永远可读', () => {
  const catalog = loadCatalog();
  assert.equal(catalog.impl, STANDARD_IMPL);
  assert.ok(catalog.total > 0);
  assert.ok(catalog.actions.every((action) => typeof action.name === 'string'));
  assert.ok(catalog.categories.length > 0);
});

test('loadCatalog: auto 等价于标准目录', () => {
  assert.equal(loadCatalog({ impl: 'auto' }).impl, STANDARD_IMPL);
});

test('loadCatalog: 没有目录文件的实现退回标准目录', () => {
  const catalog = loadCatalog({ impl: 'no-such-impl' });
  assert.equal(catalog.impl, 'no-such-impl');
  assert.equal(catalog.total, loadCatalog().total);
});

test('loadCatalog: 带了目录文件的实现用自己的目录', () => {
  const impls = ['snowluma', 'onebot11'].filter(hasImplCatalog);
  assert.ok(impls.length > 0, '至少要有一份目录');
  for (const impl of impls) {
    const catalog = loadCatalog({ impl });
    assert.equal(catalog.impl, impl);
    assert.ok(catalog.total > 0);
  }
});

test('Catalog: 别名可解析，禁用项不出现在列表里', () => {
  const catalog = new Catalog({
    source: 'test',
    version: '1',
    categories: [{ category: '消息', count: 2 }],
    actions: [
      { name: 'send_msg', aliases: ['send'], category: '消息', summary: '发消息', readOnly: false },
      { name: 'get_msg', aliases: [], category: '消息', summary: '查消息', readOnly: true },
    ],
  });

  assert.equal(catalog.resolve('send')?.name, 'send_msg');
  assert.equal(catalog.resolve('nope'), null);

  const policy = { disabled: (_spec, name) => name === 'get_msg' };
  const listed = catalog.list({ policy });
  assert.deepEqual(listed.actions.map((action) => action.name), ['send_msg']);
  assert.equal(listed.total, 1);

  assert.deepEqual(catalog.counts(policy), { total: 2, enabled: 1, disabled: 1 });
  assert.equal(catalog.summary().total, 2);
});

test('Catalog: 没有 categories 时按 action 的 category 推导', () => {
  const catalog = new Catalog({
    source: 'test',
    version: '',
    categories: [],
    actions: [
      { name: 'a', category: '消息' },
      { name: 'b', category: '消息' },
      { name: 'c', category: '群管理' },
    ],
  });
  assert.deepEqual(catalog.categories, [
    { category: '消息', count: 2 },
    { category: '群管理', count: 1 },
  ]);
});
