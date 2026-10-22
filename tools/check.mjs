/**
 * 轻量自检：不连 OneBot，只检查声明、catalog 和工具表是否一致。
 * 等价于 `npm run check`。
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import definition from '../src/definition.js';
import { configGroup } from '../src/config.js';
import { IMPLEMENTATIONS, hasImplCatalog, loadCatalog } from '../src/catalog.js';
import { OneBotWorld } from '../src/world.js';

let failed = 0;
const ok = (line) => console.log(`  ok    ${line}`);
const bad = (line) => {
  failed += 1;
  console.log(`  FAIL  ${line}`);
};

/** 与键序无关的稳定序列化，用来比对 describe.json。 */
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? String(value);
}

if (definition.id !== 'onebot') bad(`definition.id=${definition.id}`);
else ok('definition.id = onebot');

const defaults = definition.defaults();
if (defaults.enabled !== false) bad('defaults().enabled must be false');
else ok('defaults().enabled = false');

const group = configGroup('zh');
if (Object.hasOwn(group.schema.properties, 'worlds.onebot.enabled')) {
  bad('enabled 由框架的 World 开关渲染，不该进配置 schema');
} else ok('configGroup 不声明 worlds.onebot.enabled');

// 每份随包发布的目录都要能读、能过基本形状检查。
for (const impl of IMPLEMENTATIONS) {
  if (impl === 'auto' || !hasImplCatalog(impl)) continue;
  const catalog = loadCatalog({ impl });
  if (catalog.total === 0) {
    bad(`catalog ${impl}: no actions`);
    continue;
  }
  ok(`catalog ${impl}: ${catalog.total} actions / ${catalog.categories.length} categories (${catalog.source})`);

  const names = new Set();
  for (const action of catalog.actions) {
    if (!action.name) bad(`catalog ${impl}: action without name`);
    if (names.has(action.name)) bad(`catalog ${impl}: duplicate action ${action.name}`);
    names.add(action.name);
    if (typeof action.readOnly !== 'boolean') bad(`catalog ${impl}: ${action.name} readOnly is not boolean`);
    if (!action.inputSchema || action.inputSchema.type !== 'object') {
      bad(`catalog ${impl}: ${action.name} missing object inputSchema`);
    }
  }
  if (catalog.total && names.size !== catalog.total) {
    bad(`catalog ${impl}: ${names.size} unique names for ${catalog.total} actions`);
  }
}

const world = new OneBotWorld({ cfg: {} });
const toolNames = world.tools().map((tool) => tool.name);
if (new Set(toolNames).size !== toolNames.length) bad('duplicate tool names');
else ok(`tools unique: ${toolNames.join(', ')}`);

const described = definition.describe.tools.map((tool) => tool.name);
if (described.join('|') !== toolNames.join('|')) {
  bad(`describe.tools (${described.join(', ')}) != tools() (${toolNames.join(', ')})`);
} else {
  ok('describe.tools matches tools()');
}

for (const tool of world.tools()) {
  if (!Array.isArray(tool.tags) || tool.tags.length === 0) bad(`${tool.name}: missing tags`);
  if (!tool.parameters || tool.parameters.type !== 'object') bad(`${tool.name}: parameters must be an object schema`);
  if (typeof tool.handler !== 'function') bad(`${tool.name}: missing handler`);
}
ok('tool declarations have tags, object parameters and handlers');

const eventTypes = definition.describe.events.map((event) => event.type);
if (new Set(eventTypes).size !== eventTypes.length) bad('duplicate event types');
else ok(`events unique: ${eventTypes.join(', ')}`);

const ui = world.webUi('zh');
if (!ui.config || ui.config.length === 0) bad('webUi has no config group');
else ok(`webUi config groups: ${ui.config.map((group) => group.id).join(', ')}`);

// 自定义面板必须有浏览器 bundle，否则控制台挂载时只会报“缺这个面板”。
if (ui.panels?.length) {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const client = pkg.cortico?.webUiClient;
  if (!client) {
    bad(`webUi declares panels (${ui.panels.map((p) => p.id).join(', ')}) but package.json has no cortico.webUiClient`);
  } else if (!existsSync(new URL(`../${client}`, import.meta.url))) {
    bad(`cortico.webUiClient 指向的文件不存在：${client}`);
  } else if (typeof ui.invoke !== 'function') {
    bad('webUi declares panels but has no invoke()');
  } else {
    ok(`panels: ${ui.panels.map((p) => p.id).join(', ')} → ${client}`);
  }
}

// 环境提示词：模板在 src/ENV_PROMPT.md，promptDocs 只声明路径与变量。
const doc = ui.promptDocs?.find((d) => d.role === 'envPrompt');
if (!doc) {
  bad('webUi 没有声明 role=envPrompt 的提示词文档');
} else {
  ok(`envPrompt doc: ${doc.key}`);
  if (!existsSync(doc.path)) {
    bad(`环境提示词模板不在：${doc.path}`);
  } else {
    ok(`模板文件存在：${doc.path}`);
    const template = readFileSync(doc.path, 'utf8');
    const used = [...new Set([...template.matchAll(/\{\{\s*([\w.-]+)\s*\}\}/g)].map((m) => m[1]))].sort();
    const declared = (doc.vars ?? []).map((v) => v.name).sort();
    const reported = Object.keys(world.envPromptVars() ?? {}).sort();
    if (used.join('|') !== declared.join('|')) {
      bad(`模板占位符 (${used.join(', ')}) != vars 声明 (${declared.join(', ')})`);
    } else {
      ok('模板占位符与 vars 声明一致');
    }
    if (declared.join('|') !== reported.join('|')) {
      bad(`vars 声明 (${declared.join(', ')}) != envPromptVars() (${reported.join(', ')})`);
    } else {
      ok('vars 声明与 envPromptVars() 一致');
    }
  }
}

// describe.json 与 describe + ENV_PROMPT.md 一致（npm run describe 重新生成）。
const describeFile = JSON.parse(readFileSync(fileURLToPath(new URL('../describe.json', import.meta.url)), 'utf8'));
const expected = {
  tools: definition.describe.tools,
  events: definition.describe.events,
  ...(doc ? {
    prompts: [{
      key: doc.key,
      title: doc.title,
      ...(doc.role ? { role: doc.role } : {}),
      content: readFileSync(doc.path, 'utf8'),
    }],
  } : {}),
};
if (stable(describeFile) !== stable(expected)) {
  bad('describe.json 与 describe + ENV_PROMPT.md 不一致（跑 npm run describe 重新生成）');
} else {
  ok('describe.json matches describe + ENV_PROMPT.md');
}

console.log(failed === 0 ? '\nall checks passed' : `\n${failed} check(s) failed`);
process.exit(failed === 0 ? 0 : 1);
