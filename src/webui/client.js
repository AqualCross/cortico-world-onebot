/**
 * 控制台面板：动作目录与接收的会话。
 *
 * 浏览器侧代码：不 import 框架运行时，只用 ctx.ui 和 ctx.invoke。
 * 服务端方法见 world.js 的 #invokePanel（actions: state/update；receive: state/save）。
 */

const ZH = {
  actions: {
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
  },
  receive: {
    title: '接收的会话',
    desc: '勾选要接收的会话。未勾选的消息和通知不送达，也不落盘；全选包含以后新增的会话。',
    searchLabel: '搜索',
    search: '群名、好友名或号码',
    selectAll: '全选',
    refresh: '刷新列表',
    save: '保存',
    loading: '正在读取群和好友列表…',
    saving: '正在保存…',
    saved: (n) => `已保存：接收 ${n} 个会话`,
    savedAll: '已保存：接收全部会话',
    savedNone: '已保存：不接收任何会话',
    disconnected: 'OneBot 未连接。连接后才能读取群和好友列表；当前显示已配置的会话。',
    empty: '没有可选的会话。',
    none: '没有勾选任何会话：所有 QQ 消息和通知都会被丢弃。',
    summaryAll: (n) => `已选全部 ${n} 个会话；保存后包含以后新增的会话`,
    summary: (n, total) => `已选 ${n} / ${total} 个会话；未勾选的不接收`,
    name: '会话',
    kind: '类型',
    key: '会话键',
    group: '群',
    friend: '好友',
    unknown: '（不在当前列表）',
    unsaved: '接收设置还没保存，确定离开？',
  },
};

const EN = {
  actions: {
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
  },
  receive: {
    title: 'Received conversations',
    desc: 'Only checked conversations deliver events. Everything else is dropped without being stored; Select all includes conversations added later.',
    searchLabel: 'Search',
    search: 'Group name, friend name or number',
    selectAll: 'Select all',
    refresh: 'Refresh',
    save: 'Save',
    loading: 'Loading groups and friends…',
    saving: 'Saving…',
    saved: (n) => `Saved: receiving ${n} conversation${n === 1 ? '' : 's'}`,
    savedAll: 'Saved: receiving all conversations',
    savedNone: 'Saved: no conversations are received',
    disconnected: 'OneBot is not connected. Connect to load groups and friends; showing configured conversations.',
    empty: 'No conversations available.',
    none: 'No conversations selected: every QQ message and notice will be dropped.',
    summaryAll: (n) => `All ${n} conversations selected; saving also includes future ones`,
    summary: (n, total) => `${n} of ${total} conversations selected; the rest are dropped`,
    name: 'Conversation',
    kind: 'Type',
    key: 'Key',
    group: 'Group',
    friend: 'Friend',
    unknown: '(not in current list)',
    unsaved: 'Receive settings are not saved. Leave anyway?',
  },
};

export default {
  panels: {
    actions: {
      mount: async (ctx) => {
        const { ui, root } = ctx;
        const S = String(ctx.language ?? '').startsWith('zh') ? ZH.actions : EN.actions;

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
          void ctx.refresh().catch(() => { /* Refresh connection and action-count badges. */ });
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

        ctx.interval(() => { void ctx.refresh().catch(() => {}); }, 15000);
        await load();
      },
    },

    receive: {
      mount: async (ctx) => {
        const { ui, root } = ctx;
        const S = String(ctx.language ?? '').startsWith('zh') ? ZH.receive : EN.receive;

        const card = ui.sheet({ title: S.title, desc: S.desc });
        const search = ui.input({ placeholder: S.search, onInput: () => applySearch() });
        const selectAll = ui.checkbox(S.selectAll, { onChange: (checked) => onSelectAll(checked) });
        const refresh = ui.button(S.refresh, { size: 'sm', onClick: () => { void load(true); } });
        const save = ui.button(S.save, { variant: 'primary', onClick: () => { void persist(); } });
        const bar = ui.rowbar();
        bar.append(selectAll.el, refresh, save);

        const summary = ui.msgline();
        const message = ui.msgline();
        const table = ui.table({ head: [S.name, S.kind, S.key], maxHeight: '420px' });

        card.body.append(ui.field(S.searchLabel, search), bar, summary, message, table.el);
        root.append(card.el);

        let state = null;
        let rows = [];
        let selected = new Set();
        let allMode = false;
        let busy = false;
        let dirty = false;

        ctx.guardLeave(() => (dirty ? S.unsaved : null));

        function visibleName(item) {
          if (item.name) return item.name;
          return state?.connected ? S.unknown : item.key;
        }

        function syncSelectAll() {
          const total = state?.items.length ?? 0;
          const all = total > 0 && selected.size === total;
          selectAll.setChecked(all);
          selectAll.input.indeterminate = selected.size > 0 && !all;
          selectAll.input.disabled = busy || total === 0;
        }

        function syncControls() {
          search.disabled = busy;
          refresh.disabled = busy;
          save.disabled = busy || !state || state.items.length === 0;
          for (const row of rows) row.check.input.disabled = busy;
          syncSelectAll();
        }

        function syncSummary() {
          if (!state) return;
          const total = state.items.length;
          const count = selected.size;
          if (total === 0) {
            summary.textContent = '';
          } else if (count === 0) {
            summary.textContent = S.none;
          } else if (count === total) {
            summary.textContent = S.summaryAll(total);
          } else {
            summary.textContent = S.summary(count, total);
          }
        }

        function applySearch() {
          const q = search.value.trim().toLowerCase();
          for (const row of rows) {
            const hay = `${row.item.name} ${row.item.key}`.toLowerCase();
            row.tr.hidden = q.length > 0 && !hay.includes(q);
          }
        }

        function onSelectAll(checked) {
          if (!state) return;
          allMode = checked && state.items.length > 0;
          selected = checked ? new Set(state.items.map((item) => item.key)) : new Set();
          for (const row of rows) row.check.setChecked(selected.has(row.item.key));
          dirty = true;
          syncSelectAll();
          syncSummary();
        }

        function onItem(item, checked) {
          if (checked) selected.add(item.key);
          else selected.delete(item.key);
          allMode = state.items.length > 0 && selected.size === state.items.length;
          dirty = true;
          syncSelectAll();
          syncSummary();
        }

        function render(next) {
          state = next;
          const initiallyChecked = next.items
            .filter((item) => next.all === true || item.received)
            .map((item) => item.key);
          selected = new Set(initiallyChecked);
          // 列表里全勾上就按「全部会话」保存；与全选框显示的状态一致。
          allMode = next.items.length > 0 && selected.size === next.items.length;

          table.clear(next.items.length ? undefined : (next.connected ? S.empty : S.disconnected));
          rows = next.items.map((item) => {
            const check = ui.checkbox(visibleName(item), {
              checked: selected.has(item.key),
              onChange: (checked) => onItem(item, checked),
            });
            check.input.title = item.key;
            const tr = table.addRow([
              check.el,
              item.kind === 'group' ? S.group : S.friend,
              { text: item.key, cls: 'mono' },
            ]);
            return { item, tr, check };
          });

          syncControls();
          syncSummary();
          applySearch();
        }

        async function load(refreshList) {
          if (busy) return;
          busy = true;
          syncControls();
          message.classList.remove('bad');
          message.textContent = S.loading;
          try {
            const next = await ctx.invoke('state', [refreshList === true]);
            render(next);
            dirty = false;
            message.textContent = next.error || '';
            if (next.error) message.classList.add('bad');
          } catch (error) {
            message.textContent = String(error);
            message.classList.add('bad');
          } finally {
            busy = false;
            syncControls();
          }
        }

        async function persist() {
          if (!state || state.items.length === 0 || busy) return;
          const keys = allMode
            ? ['*']
            : state.items.filter((item) => selected.has(item.key)).map((item) => item.key);
          busy = true;
          syncControls();
          message.classList.remove('bad');
          message.textContent = S.saving;
          try {
            const next = await ctx.invoke('save', [keys]);
            render(next);
            dirty = false;
            const text = next.all
              ? S.savedAll
              : (selected.size ? S.saved(selected.size) : S.savedNone);
            message.textContent = text;
            ui.toast(text, 'ok');
            void ctx.refresh().catch(() => { /* Refresh the receive badge. */ });
          } catch (error) {
            message.textContent = String(error);
            message.classList.add('bad');
          } finally {
            busy = false;
            syncControls();
          }
        }

        await load(false);
      },
    },
  },
};
