/**
 * 用框架自带的判据在假部署里真跑一遍装配检查：先 `parseExtensionManifest()` 过一遍声明，
 * 再 `dryMountWorld()` 造实例、查工具名冲突与配置路径。判据直接读这套安装里的框架源码
 * （`<安装>/resources/app/build/cortico/src/extensions/`），不靠手抄。
 *
 * 跑法（打包后的 app 没有开发仓的 `pnpm check:extension`）：
 *   node --experimental-transform-types tools/drymount.mts
 * 框架位置按 `COOPANION_APP_ROOT` → 从本包往上找 `resources/app` 的顺序定位；
 * 另一套安装的扩展目录用 `SNOWLUMA_EXTENSIONS_DIR` 指。
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const pkgDir = fileURLToPath(new URL('..', import.meta.url));
const scratchDir = mkdtempSync(join(tmpdir(), 'onebot-drymount-'));

/** 找这套安装的 `resources/app`：显式变量优先，其次从本包目录往上找。 */
function findAppRoot() {
  const explicit = process.env.COOPANION_APP_ROOT;
  if (explicit && existsSync(join(explicit, 'build', 'cortico', 'src', 'extensions', 'dry-mount.ts'))) return explicit;
  let dir = pkgDir;
  for (let i = 0; i < 8; i += 1) {
    const cand = join(dir, 'resources', 'app');
    if (existsSync(join(cand, 'build', 'cortico', 'src', 'extensions', 'dry-mount.ts'))) return cand;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return '';
}

const appRoot = findAppRoot();
if (!appRoot) {
  console.error('找不到这套安装的 resources/app —— 用 COOPANION_APP_ROOT 指一下（例如 D:\\Coopanion\\resources\\app）');
  process.exit(2);
}
const frameworkDir = join(appRoot, 'build', 'cortico', 'src', 'extensions');
const { collectToolNames, dryMountWorld } = await import(pathToFileURL(join(frameworkDir, 'dry-mount.ts')).href);
const { EXTENSION_API_VERSIONS, parseExtensionManifest } = await import(pathToFileURL(join(frameworkDir, 'manifest.ts')).href);

/** 默认扫「跟这套安装同一个 extensions 目录」里的其它扩展；换安装时用 SNOWLUMA_EXTENSIONS_DIR 覆盖。 */
const extensionsDir = process.env.SNOWLUMA_EXTENSIONS_DIR ?? join(appRoot, '..', '..', 'data', 'extensions', 'node_modules');
let passed = 0;
let warned = 0;
let failed = 0;

const ok = (line) => { passed++; console.log(`  ok    ${line}`); };
const bad = (line) => { failed++; console.log(`  FAIL  ${line}`); };
const hint = (line) => { warned++; console.log(`  提醒  ${line}`); };

/** 其它已装扩展里有没有同名工具：读源码找带引号的工具名，够用的静态冲突扫描。 */
function scanConflicts(names) {
  const found = new Map();
  if (!existsSync(extensionsDir)) return found;
  const skip = new Set(['cortico-world-onebot', '.bin', '.pnpm']);
  const walk = (dir, owner, depth) => {
    if (depth > 6) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        walk(path, owner, depth + 1);
        continue;
      }
      if (!/\.(js|mjs|cjs|ts|mts)$/.test(entry.name)) continue;
      try {
        if (statSync(path).size > 2_000_000) continue;
        const src = readFileSync(path, 'utf8');
        for (const name of names) {
          if ((src.includes(`'${name}'`) || src.includes(`"${name}"`)) && !found.has(name)) found.set(name, owner);
        }
      } catch {
        /* 读不了就跳过 */
      }
    }
  };
  for (const entry of readdirSync(extensionsDir, { withFileTypes: true })) {
    if (skip.has(entry.name)) continue;
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    walk(join(extensionsDir, entry.name), entry.name, 0);
  }
  return found;
}

try {
  const mod = await import(pathToFileURL(join(pkgDir, 'src', 'index.js')).href);
  const def = mod.default;
  const manifest = JSON.parse(await readFile(join(pkgDir, 'package.json'), 'utf8'));

  console.log('用框架自带的判据检查');
  console.log(`  包目录：${pkgDir}`);
  console.log(`  世界：${def?.id} / ${def?.label}`);
  console.log(`  manifest：kind=${manifest.cortico?.kind} api=${manifest.cortico?.api} webUiClient=${manifest.cortico?.webUiClient ?? '(无)'}`);

  const parsed = parseExtensionManifest(manifest);
  if (!parsed.ok) {
    bad(`框架解析 manifest 失败：${parsed.reasons.join('；')}`);
  } else {
    const expected = EXTENSION_API_VERSIONS[parsed.manifest.kind];
    ok(`框架解析 manifest 通过（kind=${parsed.manifest.kind}，框架期望 api=${expected}）`);
    if (parsed.manifest.api !== expected) bad(`api=${parsed.manifest.api} 与框架的 ${expected} 不等，装配层会拒绝加载。`);
    else ok('api 版本与框架一致');
    if (parsed.manifest.id !== undefined && def?.id !== parsed.manifest.id) {
      bad(`manifest 里的 id（${parsed.manifest.id}）与 def.id 不一致`);
    }
  }
  for (const warning of parsed.warnings ?? []) hint(warning);

  const clientFile = manifest.cortico?.webUiClient;
  const hasWebUiClient = typeof clientFile === 'string' && clientFile.length > 0;
  if (hasWebUiClient && !existsSync(join(pkgDir, clientFile))) bad(`manifest 声明的 ${clientFile} 不在包里`);
  else if (hasWebUiClient) ok(`manifest 声明的 ${clientFile} 在包里`);

  const { taken, skipped } = collectToolNames([def], { scratchDir, packageDir: pkgDir });
  for (const extra of skipped) bad(`收集工具名时构造失败 ${extra}`);

  const conflicts = scanConflicts([...taken.keys()]);
  if (conflicts.size === 0) ok(`其它已装扩展里没有同名工具（扫了 ${extensionsDir}）`);
  else for (const [name, owner] of conflicts) bad(`工具名「${name}」已被 ${owner} 占用`);

  const report = await dryMountWorld(def, { scratchDir, packageDir: pkgDir, hasWebUiClient, takenToolNames: conflicts });
  for (const line of report.ok) ok(line);
  for (const line of report.warnings) hint(line);
  for (const line of report.failures) bad(line);
} catch (error) {
  bad(`未捕获的异常：${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
} finally {
  rmSync(scratchDir, { recursive: true, force: true });
}

console.log(`\n结果：${passed} 项通过，${warned} 个提醒，${failed} 个失败`);
process.exit(failed === 0 ? 0 : 1);
