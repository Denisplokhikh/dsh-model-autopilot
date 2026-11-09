// Функциональная проверка обеих половин плагина без запуска браузера.
// Использование: node verify.mjs <путь к пакету>
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'

const packageDir = path.resolve(process.argv[2] ?? '.')
const failures = []
const pass = (name) => console.log(`PASS ${name}`)

/** Wait out the plugin's fire-and-forget async chains. */
const settle = async (rounds = 25) => {
  for (let index = 0; index < rounds; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

const importModule = (file) => import(pathToFileURL(path.join(packageDir, file)).href)

async function testClassifier() {
  const { classifyRequest, parseVerdict } = await importModule('classifier.js')
  const expectations = [
    ['как дела?', 'fast'],
    ['Привет!', 'fast'],
    ['просто ответь коротко', 'fast'],
    ['Продолжай', 'fast'],
    ['Что такое замыкание в JavaScript?', 'fast'],
    ['Как установить npm пакет?', 'fast'],
    ['Продолжай рефакторинг', 'coder'],
    ['Исправь баг в src/auth.ts: TypeError при входе', 'coder'],
    ['Почему падает тест login.test.ts?', 'coder'],
    ['Проанализируй этот код и найди баги', 'coder'],
    ['fix the prefix handling in the parser', 'coder'],
    ['Добавь логирование в server.js и прогони тесты', 'coder'],
    ['migrate the app to TypeScript', 'heavy'],
    ['проведи миграцию базы данных на новую схему', 'heavy'],
    ['plan a multi-step refactor of the auth module', 'heavy'],
    ['перепиши функцию', 'coder'],
    ['review this file', 'coder'],
    ['rename the variable x to y in main.ts', 'coder'],
    ['add a small feature to the settings page', 'coder'],
    ['где мой багаж?', 'fast'],
    ['Спроектируй архитектуру плагина, нужно несколько файлов и тесты', 'heavy'],
    ['Отрефактори весь проект, перепиши на TypeScript', 'heavy'],
    ['отрефактори весь проект', 'heavy'],
    ['refactoring the whole codebase', 'heavy'],
    ['Refactor the whole project structure', 'heavy'],
    ['Applying the migration across the entire repository', 'heavy'],
  ]
  for (const [text, tier] of expectations) {
    const verdict = classifyRequest(text)
    assert.equal(verdict.tier, tier, `classifier: "${text}" -> ${verdict.tier}, ожидался ${tier} (score ${verdict.score})`)
    assert.ok(Array.isArray(verdict.signals), 'classifier: signals is an array')
  }
  pass('classifier: три уровня на реальных формулировках')

  const prefix = classifyRequest('please check the prefix and suffix')
  assert.equal(prefix.tier, 'fast', 'classifier: "prefix" не считается словом "fix"')
  pass('classifier: границы слов, а не подстроки')

  assert.equal(parseVerdict('heavy'), 'heavy')
  assert.equal(parseVerdict('The answer is: Coder.'), 'coder')
  assert.equal(parseVerdict('light.'), 'fast')
  assert.equal(parseVerdict('???'), undefined)
  pass('classifier: разбор ответа быстрой модели')
}

/**
 * Build a fake Host context with the services the plugin touches.
 * @param {object} overrides - per-test stubs.
 * @returns {object} test harness.
 */
function createHost(overrides = {}) {
  const routes = new Map()
  const listeners = new Map()
  const edits = []
  const selected = []
  const streamCalls = []
  const state = {
    enabled: true,
    escalateAfterErrors: 2,
    classifier: 'local',
    classifierTimeoutMs: 1500,
    tiers: {
      fast: { provider: '', model: '', reasoningEffort: '' },
      coder: { provider: '', model: '', reasoningEffort: '' },
      heavy: { provider: '', model: '', reasoningEffort: '' },
    },
    ...overrides.config,
  }
  const defaultSelection = overrides.defaultSelection ?? { provider: 'deepseek', model: 'base-model' }
  const models = overrides.models ?? [
    { id: 'base-model', name: 'Base' },
    { id: 'fast-model', name: 'Fast' },
    { id: 'coder-model', name: 'Coder' },
    { id: 'heavy-model', name: 'Heavy' },
  ]
  const efforts = overrides.efforts ?? { efforts: [{ id: 'low', name: 'Low' }, { id: 'medium', name: 'Medium' }, { id: 'high', name: 'High' }], defaultEffort: 'medium' }
  const streamFactory = overrides.stream
  const control = { failInfo: overrides.failInfo === true }
  const currentHolder = { value: overrides.current ?? { ...defaultSelection } }
  const ctx = {
    connection: {
      fetch: {
        register(route) {
          routes.set(route.path, route)
          return async () => { routes.delete(route.path) }
        },
      },
    },
    fiber: { entry: { id: 'model-autopilot' } },
    logger: { info() {} },
    get(name) {
      if (name === 'llm') {
        return {
          listProviders: () => overrides.providers ?? [{ id: 'deepseek', name: 'DeepSeek' }],
          listModels: async () => models,
          resolveModelInfo: async (provider, model) => {
            if (control.failInfo === true) throw new Error('no metadata')
            if (provider === 'ghost') throw new Error('unknown provider')
            const info = { provider, id: model, name: model, context: { contextWindow: 128000 } }
            if (overrides.noReasoning !== true) info.reasoning = efforts
            return info
          },
          stream: (options) => {
            streamCalls.push(options)
            if (streamFactory === undefined) throw new Error('stream not expected')
            return streamFactory(options)
          },
        }
      }
      if (name === 'agentDefaultModel') {
        return { currentSelection: () => defaultSelection }
      }
      if (name === 'configEditor') {
        return { edit: async (entry, change) => { edits.push({ entry, value: change(state) }) } }
      }
      return undefined
    },
    on(event, fn) { listeners.set(event, fn); return () => listeners.delete(event) },
    effect(fn) { fn(); return () => {} },
  }
  const agent = {
    id: 'session-1',
    status: 'running',
    model: {
      current: () => currentHolder.value,
      select: async (selection) => {
        currentHolder.value = selection
        selected.push(selection)
      },
    },
  }
  return { ctx, routes, listeners, edits, selected, streamCalls, state, agent, currentHolder, control }
}

async function testHost() {
  const mod = await importModule('index.js')
  assert.ok(Array.isArray(mod.inject) && mod.inject.includes('connection'), 'host exports inject: connection')
  pass('host: экспорт inject=["connection"]')

  // --- Explicit three-model config ------------------------------------------------
  const explicit = createHost({
    config: {
      enabled: true,
      tiers: {
        fast: { provider: 'deepseek', model: 'fast-model' },
        coder: { provider: 'deepseek', model: 'coder-model' },
        heavy: { provider: 'deepseek', model: 'heavy-model' },
      },
    },
    current: { provider: 'deepseek', model: 'fast-model' },
  })
  mod.apply(explicit.ctx, { ...explicit.state })
  assert.deepEqual([...explicit.routes.keys()].sort(), ['/api/model-autopilot/settings', '/api/model-autopilot/state'])
  pass('host: зарегистрированы оба exact Fetch маршрута')

  const inserted = explicit.listeners.get('agent/inbox/inserted')
  assert.ok(inserted, 'host listens to agent/inbox/inserted')
  explicit.selected.length = 0
  inserted({ agent: explicit.agent, message: { role: 'user', content: [{ type: 'text', text: 'исправь баг в src/auth.ts, падает тест' }] } })
  await settle()
  assert.deepEqual(explicit.selected.at(-1), { provider: 'deepseek', model: 'coder-model' })
  pass('host: средний запрос выбирает coder-модель при вставке сообщения')

  explicit.selected.length = 0
  inserted({ agent: explicit.agent, message: { role: 'user', content: [{ type: 'text', text: 'спроектируй архитектуру сервиса, несколько файлов и тесты' }] } })
  await settle()
  assert.deepEqual(explicit.selected.at(-1), { provider: 'deepseek', model: 'heavy-model' })
  pass('host: сложный запрос выбирает heavy-модель сразу, без ошибок инструментов')

  explicit.selected.length = 0
  inserted({ agent: explicit.agent, message: { role: 'user', content: [{ type: 'text', text: 'как дела?' }] } })
  await settle()
  assert.deepEqual(explicit.selected.at(-1), { provider: 'deepseek', model: 'fast-model' })
  pass('host: лёгкий запрос возвращает fast-модель')

  // Вставленный контекст (напоминания, уведомления, результаты сабагентов) —
  // тоже user-role, но маршрут по нему переключать нельзя.
  explicit.selected.length = 0
  inserted({
    agent: explicit.agent,
    message: {
      role: 'user',
      source: { kind: 'model-selection', form: 'notice', summary: 'switch' },
      content: [{ type: 'text', text: 'рефакторинг архитектуры всего проекта, несколько файлов' }],
    },
  })
  await settle()
  assert.equal(explicit.selected.length, 0, 'вставленный контекст не маршрутизируется')
  pass('host: служебный вставленный контекст не переключает модель')

  // Горячий путь после прогрева обязан выбирать модель синхронно: шаг
  // захватывает маршрут раньше, чем отработают промисы.
  explicit.selected.length = 0
  inserted({ agent: explicit.agent, message: { role: 'user', content: [{ type: 'text', text: 'исправь баг в src/auth.ts, падает тест' }] } })
  assert.deepEqual(explicit.selected.at(-1), { provider: 'deepseek', model: 'coder-model' }, 'после прогрева выбор применяется синхронно, без await')
  await settle()
  pass('host: прогретый маршрут выбирается синхронно, в том же тике, что и вставка сообщения')

  const stateResponse = await explicit.routes.get('/api/model-autopilot/state').fetch(new Request('http://local/api/model-autopilot/state'))
  assert.equal(stateResponse.status, 200)
  const payload = await stateResponse.json()
  assert.equal(payload.enabled, true)
  assert.equal(payload.classifier, 'local')
  assert.equal(payload.models.length, 4)
  assert.deepEqual(payload.current, { provider: 'deepseek', model: 'base-model' })
  assert.equal(payload.effective.fast.source, 'config')
  assert.deepEqual(
    { provider: payload.effective.heavy.provider, model: payload.effective.heavy.model },
    { provider: 'deepseek', model: 'heavy-model' },
  )
  assert.ok(payload.recent.length >= 1 && typeof payload.recent[0].score === 'number', 'recent keeps the classifier score')
  pass('host: GET состояния отдаёт модели, текущий выбор, effective-уровни и журнал')

  // --- First message on an explicitly configured tier must be synchronous ------
  const fresh = createHost({
    config: {
      enabled: true,
      tiers: {
        fast: { provider: 'deepseek', model: 'fast-model' },
        coder: { provider: 'deepseek', model: 'coder-model' },
        heavy: { provider: 'deepseek', model: 'heavy-model' },
      },
    },
    current: { provider: 'deepseek', model: 'fast-model' },
  })
  mod.apply(fresh.ctx, { ...fresh.state })
  await settle()
  fresh.selected.length = 0
  fresh.listeners.get('agent/inbox/inserted')({
    agent: fresh.agent,
    message: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'исправь баг в src/auth.ts, падает тест' }] },
  })
  assert.deepEqual(fresh.selected.at(-1), { provider: 'deepseek', model: 'coder-model' }, 'первое сообщение на явных уровнях выбирается синхронно')
  await settle()
  pass('host: prewarm прогревает явные уровни, первое сообщение маршрутизируется синхронно')

  // --- A model id the provider does not advertise must not reach select() ------
  const catalogStale = createHost({
    config: {
      enabled: true,
      tiers: {
        fast: { provider: 'deepseek', model: 'removed-model' },
        coder: { provider: 'deepseek', model: 'coder-model' },
        heavy: { provider: 'deepseek', model: 'heavy-model' },
      },
    },
  })
  mod.apply(catalogStale.ctx, { ...catalogStale.state })
  await settle()
  catalogStale.selected.length = 0
  catalogStale.listeners.get('agent/inbox/inserted')({
    agent: catalogStale.agent,
    message: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'как дела?' }] },
  })
  await settle()
  assert.equal(catalogStale.selected.length, 0, 'модель вне каталога провайдера не выбирается')
  pass('host: устаревший id модели в каталоге не доходит до select()')

  // --- Failed metadata must be recoverable, not a permanent lockout -----------
  const flaky = createHost({
    config: {
      enabled: true,
      tiers: {
        fast: { provider: 'deepseek', model: 'fast-model' },
        coder: { provider: 'deepseek', model: 'coder-model' },
        heavy: { provider: 'deepseek', model: 'heavy-model' },
      },
    },
  })
  flaky.control.failInfo = true
  mod.apply(flaky.ctx, { ...flaky.state })
  await settle()
  flaky.selected.length = 0
  flaky.listeners.get('agent/inbox/inserted')({
    agent: flaky.agent,
    message: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'исправь баг в src/auth.ts, падает тест' }] },
  })
  await settle()
  assert.equal(flaky.selected.length, 0, 'без метаданных выбор пропускается, шаг не ломается')

  flaky.control.failInfo = false
  const flakySettings = flaky.routes.get('/api/model-autopilot/settings')
  const recovered = await flakySettings.fetch(new Request('http://local/api/model-autopilot/settings', {
    method: 'POST',
    body: JSON.stringify({
      enabled: true,
      escalateAfterErrors: 2,
      classifier: 'local',
      classifierTimeoutMs: 1500,
      tiers: {
        fast: { provider: 'deepseek', model: 'fast-model' },
        coder: { provider: 'deepseek', model: 'coder-model' },
        heavy: { provider: 'deepseek', model: 'heavy-model' },
      },
    }),
  }))
  assert.equal(recovered.status, 200)
  await settle()
  flaky.selected.length = 0
  flaky.listeners.get('agent/inbox/inserted')({
    agent: flaky.agent,
    message: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'исправь баг в src/auth.ts, падает тест' }] },
  })
  await settle()
  assert.deepEqual(flaky.selected.at(-1), { provider: 'deepseek', model: 'coder-model' }, 'после восстановления метаданных маршрутизация снова работает')
  pass('host: сбой метаданных не блокирует маршрутизацию навсегда')

  // --- Zero-config: tiers inherit the default model by reasoning effort -----------
  const auto = createHost({ config: { enabled: true } })
  mod.apply(auto.ctx, { ...auto.state })
  const autoInserted = auto.listeners.get('agent/inbox/inserted')
  auto.selected.length = 0
  autoInserted({ agent: auto.agent, message: { role: 'user', content: [{ type: 'text', text: 'как дела?' }] } })
  await settle()
  assert.deepEqual(auto.selected.at(-1), { provider: 'deepseek', model: 'base-model', reasoningEffort: 'low' })
  autoInserted({ agent: auto.agent, message: { role: 'user', content: [{ type: 'text', text: 'исправь баг в src/auth.ts, падает тест' }] } })
  await settle()
  assert.deepEqual(auto.selected.at(-1), { provider: 'deepseek', model: 'base-model', reasoningEffort: 'medium' })
  autoInserted({ agent: auto.agent, message: { role: 'user', content: [{ type: 'text', text: 'спроектируй архитектуру сервиса, несколько файлов' }] } })
  await settle()
  assert.deepEqual(auto.selected.at(-1), { provider: 'deepseek', model: 'base-model', reasoningEffort: 'high' })
  pass('host: без настроек уровни выводятся из модели по умолчанию через усилие рассуждения')

  const autoState = await auto.routes.get('/api/model-autopilot/state').fetch(new Request('http://local/api/model-autopilot/state'))
  const autoPayload = await autoState.json()
  assert.equal(autoPayload.effective.fast.source, 'auto')
  assert.equal(autoPayload.effective.fast.reasoningEffort, 'low')
  assert.equal(autoPayload.effective.heavy.reasoningEffort, 'high')
  pass('host: панель видит, какие уровни вывелись автоматически')

  // --- A model without reasoning levels never produces a pointless switch --------
  const flat = createHost({ config: { enabled: true }, noReasoning: true })
  mod.apply(flat.ctx, { ...flat.state })
  const flatSelected = []
  const flatAgent = { ...flat.agent, model: { current: () => flat.currentHolder.value, select: async (selection) => flatSelected.push(selection) } }
  flat.listeners.get('agent/inbox/inserted')({ agent: flatAgent, message: { role: 'user', content: [{ type: 'text', text: 'спроектируй архитектуру сервиса' }] } })
  await settle()
  assert.equal(flatSelected.length, 0, 'модель без уровней рассуждения: переключений нет')
  pass('host: без уровней рассуждения плагин не переключает модель')

  // --- Invalid configuration cannot break the step -------------------------------
  const broken = createHost({
    config: {
      enabled: true,
      tiers: {
        fast: { provider: 'ghost', model: 'phantom' },
        coder: { provider: 'deepseek', model: 'coder-model' },
        heavy: { provider: 'deepseek', model: 'heavy-model' },
      },
    },
  })
  mod.apply(broken.ctx, { ...broken.state })
  const brokenSelected = []
  const brokenAgent = { ...broken.agent, model: { current: () => broken.currentHolder.value, select: async (selection) => brokenSelected.push(selection) } }
  broken.listeners.get('agent/inbox/inserted')({ agent: brokenAgent, message: { role: 'user', content: [{ type: 'text', text: 'как дела?' }] } })
  await settle()
  assert.equal(brokenSelected.length, 0, 'незарегистрированный провайдер не выбирается')
  pass('host: невалидный провайдер пропускается, шаг агента не ломается')

  // --- Failure escalation and reset ----------------------------------------------
  const errors = createHost({
    config: {
      enabled: true,
      escalateAfterErrors: 2,
      tiers: {
        fast: { provider: 'deepseek', model: 'fast-model' },
        coder: { provider: 'deepseek', model: 'coder-model' },
        heavy: { provider: 'deepseek', model: 'heavy-model' },
      },
    },
    current: { provider: 'deepseek', model: 'fast-model' },
  })
  mod.apply(errors.ctx, { ...errors.state })
  const toolResult = errors.listeners.get('tools/result')
  assert.ok(toolResult, 'host listens to tools/result')
  const errorsInserted = errors.listeners.get('agent/inbox/inserted')
  errorsInserted({ agent: errors.agent, message: { role: 'user', content: [{ type: 'text', text: 'как дела?' }] } })
  await settle()
  errors.selected.length = 0
  toolResult({ agent: errors.agent, name: 'bash' }, { isError: true })
  toolResult({ agent: errors.agent, name: 'bash' }, { isError: true })
  await settle()
  assert.deepEqual(errors.selected.at(-1), { provider: 'deepseek', model: 'heavy-model' })
  pass('host: порог ошибок инструментов переключает на тяжёлую модель')

  errors.selected.length = 0
  errorsInserted({ agent: errors.agent, message: { role: 'user', content: [{ type: 'text', text: 'просто ответь' }] } })
  await settle()
  assert.deepEqual(errors.selected, [], 'тяжёлая модель уже выбрана: повторный select не нужен')
  assert.deepEqual(errors.currentHolder.value, { provider: 'deepseek', model: 'heavy-model' })
  pass('host: после ошибок новые сообщения остаются на тяжёлой модели')

  toolResult({ agent: errors.agent, name: 'edit' }, { isError: false })
  errors.selected.length = 0
  errorsInserted({ agent: errors.agent, message: { role: 'user', content: [{ type: 'text', text: 'просто ответь' }] } })
  await settle()
  assert.deepEqual(errors.selected.at(-1), { provider: 'deepseek', model: 'fast-model' })
  pass('host: успешная правка сбрасывает счётчик ошибок')

  // --- Optional fast-model classifier --------------------------------------------
  let releaseVerdict
  const smart = createHost({
    config: { enabled: true, classifier: 'fast' },
    stream: async function* stream() {
      await new Promise((resolve) => { releaseVerdict = resolve })
      yield { type: 'text-delta', text: 'heavy' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  })
  mod.apply(smart.ctx, { ...smart.state })
  const smartInserted = smart.listeners.get('agent/inbox/inserted')
  smart.selected.length = 0
  smartInserted({ agent: smart.agent, message: { role: 'user', content: [{ type: 'text', text: 'напиши что-нибудь' }] } })
  await settle()
  assert.equal(smart.streamCalls.length, 1, 'fast mode делает один запрос к быстрой модели')
  assert.equal(smart.streamCalls[0].provider, 'deepseek')
  assert.equal(smart.streamCalls[0].model, 'base-model')
  assert.equal(smart.streamCalls[0].maxTokens, 48)
  assert.equal(smart.streamCalls[0].reasoningEffort, 'low', 'классификатор просит минимальное усилие быстрой модели')
  const heuristicPick = smart.selected.at(-1)
  assert.deepEqual(heuristicPick, { provider: 'deepseek', model: 'base-model', reasoningEffort: 'low' }, 'эвристика выбирает лёгкий уровень до ответа модели')
  releaseVerdict()
  await settle()
  assert.deepEqual(smart.selected.at(-1), { provider: 'deepseek', model: 'base-model', reasoningEffort: 'high' }, 'вердикт быстрой модели применяется к следующему шагу')
  pass('host: режим "быстрая модель" спрашивает свою быструю модель и уточняет уровень')

  // A stale verdict must be dropped when a newer message arrived meanwhile.
  const staleResolvers = []
  const stale = createHost({
    config: { enabled: true, classifier: 'fast' },
    stream: async function* stream2() {
      await new Promise((resolve) => { staleResolvers.push(resolve) })
      yield { type: 'text-delta', text: 'heavy' }
    },
  })
  mod.apply(stale.ctx, { ...stale.state })
  const staleInserted = stale.listeners.get('agent/inbox/inserted')
  staleInserted({ agent: stale.agent, message: { role: 'user', content: [{ type: 'text', text: 'напиши что-нибудь' }] } })
  await settle()
  staleInserted({ agent: stale.agent, message: { role: 'user', content: [{ type: 'text', text: 'просто ответь' }] } })
  await settle()
  assert.equal(staleResolvers.length, 2, 'оба сообщения запустили классификацию')
  stale.selected.length = 0
  staleResolvers[0]()
  await settle()
  assert.equal(stale.selected.length, 0, 'устаревший вердикт не применяется')
  staleResolvers[1]()
  await settle()
  assert.deepEqual(stale.selected.at(-1), { provider: 'deepseek', model: 'base-model', reasoningEffort: 'high' }, 'свежий вердикт применяется')
  pass('host: устаревший вердикт классификатора отбрасывается')

  // --- Settings route ------------------------------------------------------------
  const settingsRoute = explicit.routes.get('/api/model-autopilot/settings')
  let response = await settingsRoute.fetch(new Request('http://local/api/model-autopilot/settings', { method: 'POST', body: '{' }))
  assert.equal(response.status, 400)

  response = await settingsRoute.fetch(new Request('http://local/api/model-autopilot/settings', {
    method: 'POST',
    body: JSON.stringify({ enabled: true, escalateAfterErrors: 3, classifier: 'bogus', tiers: {} }),
  }))
  assert.equal(response.status, 400)
  assert.equal((await response.json()).error, 'invalid-classifier')

  response = await settingsRoute.fetch(new Request('http://local/api/model-autopilot/settings', {
    method: 'POST',
    body: JSON.stringify({ enabled: true, escalateAfterErrors: 3, classifier: 'fast', classifierTimeoutMs: 42, tiers: {} }),
  }))
  assert.equal(response.status, 400)
  pass('host: POST отклоняет битый JSON, неизвестный классификатор и таймаут')

  response = await settingsRoute.fetch(new Request('http://local/api/model-autopilot/settings', {
    method: 'POST',
    body: JSON.stringify({
      enabled: true,
      escalateAfterErrors: 3,
      classifier: 'fast',
      classifierTimeoutMs: 2000,
      tiers: {
        fast: { provider: 'deepseek', model: 'fast-model', reasoningEffort: 'low' },
        coder: { provider: 'deepseek', model: 'coder-model' },
        heavy: { provider: 'deepseek', model: 'heavy-model', reasoningEffort: 'high' },
      },
    }),
  }))
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { ok: true })
  assert.equal(explicit.edits.length, 1)
  assert.equal(explicit.edits[0].value.classifier, 'fast')
  assert.equal(explicit.edits[0].value.classifierTimeoutMs, 2000)
  assert.equal(explicit.edits[0].value.tiers.heavy.reasoningEffort, 'high')
  const savedState = await explicit.routes.get('/api/model-autopilot/state').fetch(new Request('http://local/api/model-autopilot/state'))
  const savedPayload = await savedState.json()
  assert.equal(savedPayload.classifier, 'fast')
  assert.equal(savedPayload.classifierTimeoutMs, 2000)
  pass('host: POST настроек сохраняет классификатор, таймаут и усилие уровня')

  assert.ok(!explicit.listeners.has('agent/pre-step'), 'маршрутизация не использует pre-step (выбор модели захвачен раньше)')
  pass('host: маршрутизация не полагается на agent/pre-step')

  // --- Disabled plugin is inert ---------------------------------------------------
  const disabled = createHost({ config: { enabled: false } })
  mod.apply(disabled.ctx, { ...disabled.state })
  const disabledSelected = []
  const disabledAgent = { ...disabled.agent, model: { current: () => undefined, select: async (selection) => disabledSelected.push(selection) } }
  disabled.listeners.get('agent/inbox/inserted')({ agent: disabledAgent, message: { role: 'user', content: [{ type: 'text', text: 'спроектируй архитектуру' }] } })
  await settle()
  assert.equal(disabledSelected.length, 0)
  pass('host: выключенный плагин не трогает модель')
}

async function testClient() {
  const registered = []
  const localeDicts = []
  let loaded
  const ReactStub = {
    createElement: (...args) => ({ type: args[0], props: args[1] ?? {}, children: args.slice(2) }),
    useState: () => [undefined, () => {}],
    useEffect: () => {},
    useRef: () => ({ current: true }),
    Fragment: Symbol('Fragment'),
  }
  globalThis.window = {
    __ModuleLoader__: {
      load(entry) { loaded = entry },
    },
  }
  const source = fs.readFileSync(path.join(packageDir, 'client.js'), 'utf8')
  // eslint-disable-next-line no-new-func
  new Function('window', source)(globalThis.window)
  assert.ok(loaded, 'client registers through window.__ModuleLoader__')
  assert.equal(loaded.id, 'dsh-model-autopilot')
  const plugin = loaded.factory((name) => {
    if (name === 'react') return ReactStub
    throw new Error(`unexpected require: ${name}`)
  })
  let current = null
  const ctx = {
    slots: {
      inject(key, callback) {
        current = { key }
        registered.push(current)
        current.effect = callback()
        return () => {}
      },
      register(options, component) {
        current.options = options
        current.component = component
        return { ...options }
      },
    },
    locale: {
      register(ns, dicts) { localeDicts.push({ ns, dicts }); return () => {} },
      bind() { return (key) => key },
    },
    effect(fn) { fn(); return () => {} },
  }
  plugin.apply(ctx)
  assert.deepEqual(plugin.inject, ['slots', 'locale'])
  const sidebar = registered.find((entry) => entry.key === 'sidebar.panellist')
  const main = registered.find((entry) => entry.key === 'main')
  assert.ok(sidebar && main, 'client registers sidebar.panellist and main')
  assert.equal(sidebar.options.id, 'model-autopilot')
  assert.equal(sidebar.options.order, 20)
  assert.equal(typeof sidebar.options.label, 'function')
  assert.equal(main.options.key, 'model-autopilot')
  assert.equal(typeof sidebar.component, 'function')
  pass('client: иконка в sidebar.panellist и ключ main зарегистрированы')

  assert.equal(localeDicts.length, 1)
  const dicts = localeDicts[0].dicts
  assert.equal(localeDicts[0].ns, 'model-autopilot')
  assert.ok(dicts.ru && dicts.en)
  assert.equal(dicts.ru['panel.title'], 'Автопилот моделей')
  for (const key of ['tiers.hint', 'classifier.label', 'classifier.local', 'classifier.fast', 'effective.auto', 'effective.none', 'reason.classifier']) {
    assert.equal(typeof dicts.en[key], 'string', `en dictionary has ${key}`)
    assert.equal(typeof dicts.ru[key], 'string', `ru dictionary has ${key}`)
  }
  pass('client: локали ru/en зарегистрированы, новые строки на месте')

  const panelElement = main.component({})
  assert.ok(panelElement && typeof panelElement.type === 'function')
  pass('client: main-панель возвращает компонент React')

  // Render the panel body with a stateful React stub so a markup crash would throw.
  const ReactRenderStub = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
    useRef: () => ({ current: true }),
    Fragment: Symbol('Fragment'),
  }
  const renderPlugin = loaded.factory((name) => {
    if (name === 'react') return ReactRenderStub
    throw new Error(`unexpected require: ${name}`)
  })
  let renderMain = null
  const renderCtx = {
    slots: {
      inject(key, callback) { const entry = { key }; if (key === 'main') renderMain = entry; callback(); return () => {} },
      register(options, component) { if (options.name === 'main') renderMain.component = component; return { ...options } },
    },
    locale: { register() { return () => {} }, bind() { return (key) => key } },
    effect(fn) { fn(); return () => {} },
  }
  renderPlugin.apply(renderCtx)
  assert.ok(renderMain !== null && typeof renderMain.component === 'function', 'panel component is registered')
  const wrapper = renderMain.component({})
  assert.ok(wrapper !== undefined && wrapper !== null && typeof wrapper.type === 'function', 'main slot returns the panel element')
  const panelTree = wrapper.type(wrapper.props)
  assert.ok(panelTree !== undefined && panelTree !== null, 'panel renders its element tree')
  pass('client: панель рендерится без исключений')

  // Тот же рендер, но с заполненным состоянием: панель должна показать
  // эффективные маршруты, журнал и режим классификатора без исключений.
  const remote = {
    enabled: true,
    escalateAfterErrors: 2,
    classifier: 'fast',
    classifierTimeoutMs: 1500,
    tiers: { fast: { provider: '', model: '', reasoningEffort: '' }, coder: { provider: '', model: '' }, heavy: { provider: '', model: '' } },
    models: [
      { provider: 'deepseek', providerName: 'DeepSeek', id: 'base-model', name: 'Base' },
      { provider: 'deepseek', providerName: 'DeepSeek', id: 'coder-model', name: 'Coder' },
    ],
    current: { provider: 'deepseek', model: 'base-model' },
    effective: {
      fast: { provider: 'deepseek', model: 'base-model', reasoningEffort: 'low', source: 'auto' },
      coder: { provider: 'deepseek', model: 'base-model', reasoningEffort: 'medium', source: 'auto' },
      heavy: { provider: 'deepseek', model: 'base-model', reasoningEffort: 'high', source: 'auto' },
    },
    recent: [
      { at: 1700000000000, tier: 'coder', provider: 'deepseek', model: 'base-model', reasoningEffort: 'medium', reason: 'classifier', score: 4, signals: ['intent:change'] },
      { at: 1700000000001, tier: 'heavy', provider: 'deepseek', model: 'base-model', reason: 'errors' },
    ],
  }
  const draft = {
    enabled: true,
    escalateAfterErrors: 2,
    classifier: 'fast',
    classifierTimeoutMs: 1500,
    tiers: { fast: { provider: '', model: '' }, coder: { provider: '', model: '' }, heavy: { provider: '', model: '' } },
  }
  const hookValues = [remote, draft, '', '', false, 0]
  let hookIndex = 0
  const ReactDataStub = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState: (initial) => {
      const value = hookIndex < hookValues.length ? hookValues[hookIndex] : (typeof initial === 'function' ? initial() : initial)
      hookIndex += 1
      return [value, () => {}]
    },
    useEffect: () => {},
    useRef: () => ({ current: true }),
    Fragment: Symbol('Fragment'),
  }
  const dataPlugin = loaded.factory((name) => {
    if (name === 'react') return ReactDataStub
    throw new Error(`unexpected require: ${name}`)
  })
  let dataMain = null
  const dataCtx = {
    slots: {
      inject(key, callback) { const entry = { key }; if (key === 'main') dataMain = entry; callback(); return () => {} },
      register(options, component) { if (options.name === 'main') dataMain.component = component; return { ...options } },
    },
    locale: { register() { return () => {} }, bind() { return (key) => key } },
    effect(fn) { fn(); return () => {} },
  }
  dataPlugin.apply(dataCtx)
  const dataWrapper = dataMain.component({})
  const dataTree = dataWrapper.type(dataWrapper.props)
  const texts = []
  const collect = (node) => {
    if (node === null || node === undefined || typeof node === 'boolean') return
    if (typeof node === 'string' || typeof node === 'number') { texts.push(String(node)); return }
    if (typeof node !== 'object') return
    if (Array.isArray(node)) { for (const child of node) collect(child); return }
    const children = node.children
    if (Array.isArray(children)) for (const child of children) collect(child)
  }
  collect(dataTree)
  const joined = texts.join('\n')
  for (const expected of ['tier.heavy', 'classifier.label', 'classifier.fast', 'effective.auto', 'reason.classifier', 'base-model']) {
    assert.ok(joined.includes(expected), `панель показывает ${expected}`)
  }
  pass('client: панель показывает эффективные уровни, классификатор и журнал решений')
}

try {
  await testClassifier()
  await testHost()
  await testClient()
} catch (error) {
  failures.push(error)
  console.error('FAIL', error)
}

if (failures.length > 0) {
  console.error(`\n${failures.length} failure(s)`)
  process.exit(1)
}
console.log('\nALL CHECKS PASSED')
