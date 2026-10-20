/**
 * 控制台「动作目录」面板。
 *
 * 浏览器侧代码：不 import 框架运行时，只用 ctx.ui 和 ctx.invoke。
 * 服务端方法见 world.js 的 #invokePanel（state / update）。
 */

const ZH = {
  title: '动作目录',
  desc: '当前生效的 action 目录，以及从实现对端重新拉取。',
  impl: '实现',
  detected: '对端识别',
  source: '目录来源',
  version: '目录版本',
  actions: '动作数',
  categories: '分类数',
  disabled: '被禁用',
  update: '更新',
  updateDesc: '从运行中的实现拉一份最新目录；拉不到就保持现状。',
  url: '目录地址',
  urlPlaceholder: 'http://127.0.0.1:6099/api/Debug/schemas',
  token: 'Token',
  tokenPlaceholder: 'WebUI token（需要时填）',
  run: '更新动作',
  updating: '正在拉取…',
  updated: (actions, categories) => `已更新：${actions} 个动作 / ${categories} 个分类`,
  noSource: '这个实现没有默认地址，填一个再点。',
};

const EN = {
  title: 'Action catalog',
  desc: 'The catalog in effect, and a way to re-fetch it from the implementation.',
  impl: 'Implementation',
  detected: 'Detected',
  source: 'Source',
  version: 'Version',
  actions: 'Actions',
  categories: 'Categories',
  disabled: 'Disabled',
  update: 'Update',
  updateDesc: 'Pull the latest catalog from the running implementation; keep the current one if that fails.',
  url: 'Catalog URL',
  urlPlaceholder: 'http://127.0.0.1:6099/api/Debug/schemas',
  token: 'Token',
  tokenPlaceholder: 'WebUI token (if required)',
  run: 'Update actions',
  updating: 'Fetching…',
  updated: (actions, categories) => `Updated: ${actions} actions / ${categories} categories`,
  noSource: 'No default URL for this implementation; fill one in first.',
};

export default {
  panels: {
    actions: {
      mount: async (ctx) => {
        const { ui, root } = ctx;
        const S = String(ctx.language ?? '').startsWith('zh') ? ZH : EN;

        const card = ui.sheet({ title: S.title, desc: S.desc });
        const facts = ui.h('div');
        const message = ui.msgline();

        const url = ui.input({
          placeholder: S.urlPlaceholder,
          cls: 'mono',
          onInput: () => syncButton(),
        });
        const token = ui.input({ type: 'password', placeholder: S.tokenPlaceholder });
        const button = ui.button(S.run, { variant: 'primary', onClick: () => run() });
        const bar = ui.rowbar();
        bar.append(button);

        const form = ui.section(S.update, S.updateDesc);
        form.append(ui.field(S.url, url), ui.field(S.token, token), bar, message);

        card.body.append(facts, form);
        root.append(card.el);

        function renderFacts(state) {
          facts.replaceChildren(ui.kv([
            { k: S.impl, v: state.impl },
            { k: S.detected, v: state.detected || '—' },
            { k: S.source, v: state.source },
            { k: S.version, v: state.version || '—' },
            { k: S.actions, v: String(state.actions) },
            { k: S.categories, v: String(state.categories) },
            { k: S.disabled, v: String(state.disabled) },
          ]));
        }

        async function load() {
          try {
            const state = await ctx.invoke('state');
            renderFacts(state);
            if (!url.value && state.defaultUrl) url.value = state.defaultUrl;
            syncButton();
          } catch (error) {
            message.textContent = String(error);
            message.classList.add('bad');
          }
        }

        /** 没有地址就没法更新：按钮置灰并说明原因，填了地址再放开。 */
        function syncButton() {
          const ready = url.value.trim().length > 0;
          button.disabled = !ready;
          if (!ready && !message.textContent) message.textContent = S.noSource;
          if (ready && message.textContent === S.noSource) message.textContent = '';
        }

        async function run() {
          const release = ui.disable(button);
          message.classList.remove('bad');
          message.textContent = S.updating;
          try {
            const state = await ctx.invoke('update', [url.value, token.value]);
            renderFacts(state);
            const text = S.updated(state.actions, state.categories);
            message.textContent = state.saved ? `${text} · ${state.saved}` : text;
            ui.toast(text, 'ok');
          } catch (error) {
            message.textContent = String(error);
            message.classList.add('bad');
          } finally {
            release.dispose();
          }
        }

        await load();
      },
    },
  },
};
