window.__ModuleLoader__.load({
  id: 'dsh-model-autopilot',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** Locale namespace registered by this Client half. */
    const NS = 'model-autopilot';
    /** Panel id shared with the Host row and with the `main` slot key. */
    const PANEL_ID = 'model-autopilot';
    /** Browser-relative state route (document-relative form of the Host path). */
    const STATE_ROUTE = 'api/model-autopilot/state';
    const SETTINGS_ROUTE = 'api/model-autopilot/settings';
    const TIERS = ['fast', 'coder', 'heavy'];

    const en = {
      'panel.label': 'Autopilot',
      'panel.title': 'Model autopilot',
      'panel.subtitle': 'Switches the agent model for every step: a fast tier for ordinary turns, the coder tier for complex requests, and the heavy tier after repeated tool failures.',
      'status.label': 'State',
      'status.on': 'Enabled',
      'status.off': 'Disabled',
      'status.hint': 'While enabled, the plugin selects a model before each prepared step. The switch is recorded in the session as a normal model change.',
      'toggle.enable': 'Enable',
      'toggle.disable': 'Disable',
      'current.label': 'Default model for new sessions',
      'current.empty': 'not configured',
      'models.empty': 'No models are advertised by the registered providers. Configure a provider in Settings → Models first.',
      'tiers.title': 'Tiers',
      'tiers.hint': 'Every tier is a provider and a model. Leave a tier empty to skip it; the plugin falls back to the first configured tier.',
      'tier.fast': 'Fast',
      'tier.fast.hint': 'Ordinary turns and short questions.',
      'tier.coder': 'Coder',
      'tier.coder.hint': 'Architecture, refactoring, fixes, and other complex requests.',
      'tier.heavy': 'Heavy',
      'tier.heavy.hint': 'After the failure threshold, to leave an error loop.',
      'errors.label': 'Tool failures before switching to heavy',
      'errors.hint': 'Consecutive failing tool results per session; a successful edit or command resets the counter.',
      'save': 'Save',
      'saving': 'Saving…',
      'saved': 'Saved. The new policy applies from the next step.',
      'saveFailed': 'Could not save: ',
      'loading': 'Loading state…',
      'loadFailed': 'Could not read the plugin state: ',
      'retry': 'Retry',
      'recent.title': 'Recent decisions',
      'recent.empty': 'No decisions yet. Enable the autopilot and start a session.',
      'reason.intent': 'by request',
      'reason.errors': 'after failures',
      'recent.at': 'time',
      'note': 'The panel talks to the Host only over the authenticated same-origin route; no data leaves this machine.',
    };

    const ru = {
      'panel.label': 'Автопилот',
      'panel.title': 'Автопилот моделей',
      'panel.subtitle': 'Переключает модель агента на каждом шаге: быстрый уровень для обычных ходов, уровень для кода для сложных запросов и тяжёлый — после повторяющихся ошибок инструментов.',
      'status.label': 'Состояние',
      'status.on': 'Включён',
      'status.off': 'Выключен',
      'status.hint': 'Пока автопилот включён, плагин выбирает модель перед каждым подготовленным шагом. Смена записывается в сессию как обычная смена модели.',
      'toggle.enable': 'Включить',
      'toggle.disable': 'Выключить',
      'current.label': 'Модель по умолчанию для новых сессий',
      'current.empty': 'не задана',
      'models.empty': 'Провайдеры не сообщают моделей. Сначала настройте провайдера: Настройки → Модели.',
      'tiers.title': 'Уровни',
      'tiers.hint': 'Уровень — это провайдер и модель. Пустой уровень пропускается, плагин берёт первый настроенный.',
      'tier.fast': 'Быстрый',
      'tier.fast.hint': 'Обычные ходы и короткие вопросы.',
      'tier.coder': 'Для кода',
      'tier.coder.hint': 'Архитектура, рефакторинг, исправления и другие сложные запросы.',
      'tier.heavy': 'Тяжёлый',
      'tier.heavy.hint': 'После порога ошибок — чтобы выйти из цикла.',
      'errors.label': 'Ошибок инструментов до переключения на тяжёлый',
      'errors.hint': 'Подряд идущие неудачные результаты инструментов на сессию; успешная правка или команда сбрасывает счётчик.',
      'save': 'Сохранить',
      'saving': 'Сохранение…',
      'saved': 'Сохранено. Новая политика действует со следующего шага.',
      'saveFailed': 'Не удалось сохранить: ',
      'loading': 'Загружаю состояние…',
      'loadFailed': 'Не удалось получить состояние плагина: ',
      'retry': 'Повторить',
      'recent.title': 'Последние решения',
      'recent.empty': 'Решений пока нет. Включите автопилот и начните сессию.',
      'reason.intent': 'по запросу',
      'reason.errors': 'после ошибок',
      'recent.at': 'время',
      'note': 'Панель общается с Host только через аутентифицированный маршрут того же источника; данные не покидают машину.',
    };

    const CSS = [
      '.ma-page{box-sizing:border-box;height:100%;overflow:auto;padding:32px clamp(16px,4vw,48px);color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);font:inherit}',
      '.ma-inner{max-width:760px;margin:0 auto;display:flex;flex-direction:column;gap:18px}',
      '.ma-title{margin:0;font-size:22px;line-height:1.25;font-weight:600}',
      '.ma-subtitle{margin:0;font-size:13px;line-height:1.55;color:var(--dsw-alias-label-secondary)}',
      '.ma-card{border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);padding:18px 20px;display:flex;flex-direction:column;gap:12px}',
      '.ma-card-head{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}',
      '.ma-card-title{margin:0;font-size:14px;font-weight:600}',
      '.ma-muted{margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary)}',
      '.ma-status{display:flex;align-items:center;gap:8px;font-size:13px}',
      '.ma-dot{width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-state-idle-primary)}',
      '.ma-dot.on{background:var(--dsw-alias-state-success-primary)}',
      '.ma-row{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.4fr);gap:14px;align-items:start;padding:10px 0;border-top:1px solid var(--dsw-alias-border-l1)}',
      '.ma-row:first-of-type{border-top:0;padding-top:0}',
      '.ma-tier-name{font-size:13px;font-weight:600}',
      '.ma-select,.ma-input{box-sizing:border-box;width:100%;padding:7px 9px;border-radius:7px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px}',
      '.ma-select:focus-visible,.ma-input:focus-visible,.ma-button:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}',
      '.ma-actions{display:flex;align-items:center;gap:12px;flex-wrap:wrap}',
      '.ma-button{font:inherit;font-size:13px;padding:7px 14px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);cursor:pointer}',
      '.ma-button:disabled{opacity:.55;cursor:default}',
      '.ma-button.primary{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base)}',
      '.ma-notice{font-size:12px;color:var(--dsw-alias-state-success-primary)}',
      '.ma-error{font-size:12px;color:var(--dsw-alias-state-error-primary)}',
      '.ma-error-box{border:1px solid var(--dsw-alias-state-error-primary);border-radius:10px;padding:14px 16px;font-size:13px;color:var(--dsw-alias-state-error-primary)}',
      '.ma-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px}',
      '.ma-list li{display:flex;gap:10px;align-items:baseline;font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.ma-chip{display:inline-block;border-radius:999px;padding:1px 8px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);font-size:11px}',
      '.ma-note{font-size:11px;color:var(--dsw-alias-label-secondary)}',
    ].join('\n');

    /** Render the sidebar glyph at the requested edge; the sidebar owns the label. */
    function AutopilotIcon({ size }) {
      const edge = typeof size === 'number' && size > 0 ? size : 18;
      return h('svg', {
        viewBox: '0 0 24 24',
        width: edge,
        height: edge,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.8,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
        focusable: false,
        style: { display: 'block' },
      },
        h('circle', { cx: 5.5, cy: 18.5, r: 2.4 }),
        h('circle', { cx: 18.5, cy: 5.5, r: 2.4 }),
        h('path', { d: 'M7.6 17.2c4.1-1.5 3.4-5.3 6.2-7.1 1.9-1.2 3-.4 3.7-2.6' }),
      );
    }

    /**
     * Encode one tier value for a `<select>` option so provider and model ids
     * stay unambiguous even when they contain separators.
     */
    function encodeTier(tier) {
      return JSON.stringify({ provider: tier.provider, model: tier.model });
    }

    function decodeTier(value) {
      try {
        const parsed = JSON.parse(value);
        if (parsed !== null && typeof parsed === 'object') {
          return {
            provider: typeof parsed.provider === 'string' ? parsed.provider : '',
            model: typeof parsed.model === 'string' ? parsed.model : '',
          };
        }
      } catch {
        /* fall through to the empty tier */
      }
      return { provider: '', model: '' };
    }

    function formatSelection(selection) {
      if (selection === null || selection === undefined) return '';
      if (typeof selection !== 'object') return String(selection);
      const provider = typeof selection.provider === 'string' ? selection.provider : '';
      const model = typeof selection.model === 'string' ? selection.model : '';
      if (provider === '' && model === '') return '';
      return model === '' ? provider : `${provider} / ${model}`;
    }

    function groupModels(models) {
      const groups = [];
      const index = new Map();
      for (const model of models) {
        const key = model.provider;
        let group = index.get(key);
        if (group === undefined) {
          group = { provider: model.provider, name: model.providerName || model.provider, models: [] };
          index.set(key, group);
          groups.push(group);
        }
        group.models.push(model);
      }
      return groups;
    }

    function AutopilotPanel({ t }) {
      const [remote, setRemote] = React.useState(null);
      const [draft, setDraft] = React.useState(null);
      const [error, setError] = React.useState('');
      const [notice, setNotice] = React.useState('');
      const [busy, setBusy] = React.useState(false);
      const alive = React.useRef(true);
      const [reloadKey, setReloadKey] = React.useState(0);

      React.useEffect(() => {
        alive.current = true;
        const controller = new AbortController();
        const load = async () => {
          try {
            const response = await fetch(STATE_ROUTE, {
              headers: { accept: 'application/json' },
              signal: controller.signal,
              credentials: 'same-origin',
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const data = await response.json();
            if (!alive.current) return;
            setRemote(data);
            setError('');
            setDraft((current) => current !== null ? current : {
              enabled: data.enabled === true,
              escalateAfterErrors: Number.isInteger(data.escalateAfterErrors) ? data.escalateAfterErrors : 2,
              tiers: data.tiers !== null && typeof data.tiers === 'object' ? data.tiers : {},
            });
          } catch (cause) {
            if (!alive.current || controller.signal.aborted) return;
            setError(cause instanceof Error ? cause.message : String(cause));
          }
        };
        void load();
        const timer = setInterval(() => { void load(); }, 5000);
        return () => {
          alive.current = false;
          controller.abort();
          clearInterval(timer);
        };
      }, [reloadKey]);

      const models = remote !== null && Array.isArray(remote.models) ? remote.models : [];
      const groups = groupModels(models);
      const currentLabel = formatSelection(remote !== null ? remote.current : null);
      const recent = remote !== null && Array.isArray(remote.recent) ? remote.recent : [];
      const known = new Set(models.map((model) => `${model.provider}\u0000${model.id}`));

      const updateTier = (tier, value) => {
        setDraft((current) => {
          if (current === null) return current;
          return { ...current, tiers: { ...current.tiers, [tier]: decodeTier(value) } };
        });
      };

      const save = async (nextEnabled) => {
        if (draft === null || busy) return;
        setBusy(true);
        setNotice('');
        setError('');
        const body = {
          enabled: nextEnabled === undefined ? draft.enabled === true : nextEnabled,
          escalateAfterErrors: Number(draft.escalateAfterErrors),
          tiers: draft.tiers,
        };
        try {
          const response = await fetch(SETTINGS_ROUTE, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify(body),
          });
          const data = await response.json().catch(() => null);
          if (!response.ok || data === null || data.ok !== true) {
            throw new Error(data !== null && typeof data.error === 'string' ? data.error : `HTTP ${response.status}`);
          }
          setNotice(t('saved'));
          setDraft((current) => current === null ? current : { ...current, enabled: body.enabled });
          setReloadKey((key) => key + 1);
        } catch (cause) {
          setError(t('saveFailed') + (cause instanceof Error ? cause.message : String(cause)));
        } finally {
          setBusy(false);
        }
      };

      const renderTier = (tier) => {
        const value = draft !== null && draft.tiers !== null && typeof draft.tiers === 'object' && draft.tiers[tier] !== undefined
          ? draft.tiers[tier]
          : { provider: '', model: '' };
        const encoded = encodeTier(value);
        const missing = value.provider !== '' && !known.has(`${value.provider}\u0000${value.model}`);
        return h('div', { className: 'ma-row', key: tier },
          h('div', null,
            h('div', { className: 'ma-tier-name' }, t(`tier.${tier}`)),
            h('div', { className: 'ma-muted' }, t(`tier.${tier}.hint`)),
          ),
          h('div', null,
            h('select', {
              className: 'ma-select',
              value: encoded,
              disabled: draft === null,
              'aria-label': t(`tier.${tier}`),
              onChange: (event) => updateTier(tier, event.target.value),
            },
              h('option', { value: encodeTier({ provider: '', model: '' }) }, t('current.empty')),
              missing ? h('option', { value: encoded }, `${value.provider} / ${value.model}`) : null,
              groups.map((group) => h('optgroup', { key: group.provider, label: group.name },
                group.models.map((model) => h('option', {
                  key: `${model.provider}\u0000${model.id}`,
                  value: encodeTier({ provider: model.provider, model: model.id }),
                }, model.name || model.id)),
              )),
            ),
          ),
        );
      };

      const body = error !== '' && remote === null
        ? h('div', { className: 'ma-card' },
            h('div', { className: 'ma-error-box' }, t('loadFailed') + error),
            h('div', { className: 'ma-actions' },
              h('button', {
                type: 'button',
                className: 'ma-button',
                onClick: () => { setError(''); setReloadKey((key) => key + 1); },
              }, t('retry')),
            ),
          )
        : h(React.Fragment, null,
            h('section', { className: 'ma-card' },
              h('div', { className: 'ma-card-head' },
                h('div', { className: 'ma-status' },
                  h('span', { className: 'ma-dot' + (draft !== null && draft.enabled ? ' on' : '') }),
                  h('span', null, `${t('status.label')}: ${draft !== null && draft.enabled ? t('status.on') : t('status.off')}`),
                ),
                h('button', {
                  type: 'button',
                  className: 'ma-button' + (draft !== null && draft.enabled ? '' : ' primary'),
                  disabled: draft === null || busy,
                  onClick: () => { void save(!(draft !== null && draft.enabled)); },
                }, draft !== null && draft.enabled ? t('toggle.disable') : t('toggle.enable')),
              ),
              h('p', { className: 'ma-muted' }, t('status.hint')),
              h('div', { className: 'ma-muted' }, `${t('current.label')}: ${currentLabel === '' ? t('current.empty') : currentLabel}`),
            ),
            h('section', { className: 'ma-card' },
              h('div', { className: 'ma-card-head' },
                h('h2', { className: 'ma-card-title' }, t('tiers.title')),
              ),
              h('p', { className: 'ma-muted' }, t('tiers.hint')),
              models.length === 0 ? h('p', { className: 'ma-muted' }, t('models.empty')) : null,
              TIERS.map(renderTier),
              h('div', { className: 'ma-row' },
                h('div', null,
                  h('div', { className: 'ma-tier-name' }, t('errors.label')),
                  h('div', { className: 'ma-muted' }, t('errors.hint')),
                ),
                h('input', {
                  className: 'ma-input',
                  type: 'number',
                  min: 0,
                  max: 20,
                  step: 1,
                  value: draft === null ? 2 : draft.escalateAfterErrors,
                  disabled: draft === null,
                  onChange: (event) => {
                    const next = Number(event.target.value);
                    setDraft((currentContext) => currentContext === null ? currentContext : {
                      ...currentContext,
                      escalateAfterErrors: Number.isFinite(next) ? next : 2,
                    });
                  },
                }),
              ),
              h('div', { className: 'ma-actions' },
                h('button', {
                  type: 'button',
                  className: 'ma-button primary',
                  disabled: draft === null || busy,
                  onClick: () => { void save(undefined); },
                }, busy ? t('saving') : t('save')),
                notice !== '' ? h('span', { className: 'ma-notice' }, notice) : null,
                error !== '' && remote !== null ? h('span', { className: 'ma-error' }, error) : null,
              ),
            ),
            h('section', { className: 'ma-card' },
              h('h2', { className: 'ma-card-title' }, t('recent.title')),
              recent.length === 0
                ? h('p', { className: 'ma-muted' }, t('recent.empty'))
                : h('ul', { className: 'ma-list' },
                    recent.map((entry, index) => h('li', { key: `${entry.at}-${index}` },
                      h('span', { className: 'ma-chip' }, t(`tier.${entry.tier}`) ),
                      h('span', null, `${entry.provider} / ${entry.model}`),
                      h('span', null, t(entry.reason === 'errors' ? 'reason.errors' : 'reason.intent')),
                      h('span', null, new Date(entry.at).toLocaleTimeString()),
                    )),
                  ),
            ),
            h('p', { className: 'ma-note' }, t('note')),
          );

      return h('div', { className: 'ma-page', 'data-panel': PANEL_ID },
        h('style', null, CSS),
        h('div', { className: 'ma-inner' },
          h('header', null,
            h('h1', { className: 'ma-title' }, t('panel.title')),
            h('p', { className: 'ma-subtitle' }, t('panel.subtitle')),
          ),
          body,
        ),
      );
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { en, ru }), 'model-autopilot: dictionaries');
        const t = ctx.locale.bind(NS);
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 20,
          locale: NS,
          label: () => t('panel.label'),
        }, AutopilotIcon));
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
          locale: NS,
        }, () => h(AutopilotPanel, { t })));
      },
    };
  },
});
