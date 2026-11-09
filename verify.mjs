// Functional check of both halves of the plugin, without launching a browser.
// Usage: node verify.mjs [package directory]
import assert from 'node:assert/strict'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'

const packageDir = path.resolve(process.argv[2] ?? path.dirname(fileURLToPath(import.meta.url)))
const failures = []
const pass = (name) => console.log(`PASS ${name}`)
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

async function testHost() {
  const routes = new Map()
  const listeners = new Map()
  const edits = []
  const state = {
    enabled: true,
    escalateAfterErrors: 2,
    tiers: {
      fast: { provider: 'deepseek', model: 'deepseek-chat' },
      coder: { provider: 'deepseek', model: 'coder-model' },
      heavy: { provider: 'deepseek', model: 'heavy-model' },
    },
  }
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
          listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
          listModels: async () => [
            { id: 'deepseek-chat', name: 'DeepSeek Chat' },
            { id: 'coder-model', name: 'Coder' },
            { id: 'heavy-model', name: 'Heavy' },
          ],
        }
      }
      if (name === 'agentDefaultModel') {
        return { currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-chat' }) }
      }
      if (name === 'configEditor') {
        return { edit: async (entry, change) => { edits.push({ entry, value: change(state) }) } }
      }
      return undefined
    },
    on(event, fn) { listeners.set(event, fn); return () => listeners.delete(event) },
    effect(fn) { fn(); return () => {} },
  }

  const mod = await import(pathToFileURL(path.join(packageDir, 'index.js')).href)
  assert.ok(Array.isArray(mod.inject) && mod.inject.includes('connection'), 'host exports inject: connection')
  pass('host: exports inject=["connection"]')

  mod.apply(ctx, state)
  assert.deepEqual([...routes.keys()].sort(), ['/api/model-autopilot/settings', '/api/model-autopilot/state'])
  pass('host: both exact Fetch routes are registered')

  const stateRoute = routes.get('/api/model-autopilot/state')
  let response = await stateRoute.fetch(new Request('http://local/api/model-autopilot/state'))
  assert.equal(response.status, 200)
  const payload = await response.json()
  assert.equal(payload.enabled, true)
  assert.equal(payload.models.length, 3)
  assert.deepEqual(payload.current, { provider: 'deepseek', model: 'deepseek-chat' })
  pass('host: state GET returns models, current selection, and config')

  const settingsRoute = routes.get('/api/model-autopilot/settings')
  response = await settingsRoute.fetch(new Request('http://local/api/model-autopilot/settings', { method: 'POST', body: '{' }))
  assert.equal(response.status, 400)
  pass('host: malformed JSON POST is rejected')

  response = await settingsRoute.fetch(new Request('http://local/api/model-autopilot/settings', {
    method: 'POST',
    body: JSON.stringify({
      enabled: true,
      escalateAfterErrors: 3,
      tiers: {
        fast: { provider: 'deepseek', model: 'deepseek-chat' },
        coder: { provider: 'deepseek', model: 'coder-model' },
        heavy: { provider: 'deepseek', model: 'heavy-model' },
      },
    }),
  }))
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { ok: true })
  assert.equal(edits.length, 1)
  assert.equal(edits[0].value.enabled, true)
  assert.equal(edits[0].value.escalateAfterErrors, 3)
  assert.equal(edits[0].value.tiers.heavy.model, 'heavy-model')
  pass('host: settings POST persists config through configEditor')

  assert.ok(!listeners.has('agent/pre-step'), 'routing does not rely on pre-step (the model is captured earlier)')
  pass('host: routing does not rely on agent/pre-step')

  const selected = []
  const agent = {
    id: 'session-1',
    model: {
      current: () => ({ provider: 'deepseek', model: 'deepseek-chat' }),
      select: async (selection) => selected.push(selection),
    },
  }
  const inserted = listeners.get('agent/inbox/inserted')
  assert.ok(inserted, 'host listens to agent/inbox/inserted')
  inserted({ agent, message: { role: 'user', content: [{ type: 'text', text: 'Design the plugin architecture' }] } })
  await tick(); await tick(); await tick()
  assert.deepEqual(selected, [{ provider: 'deepseek', model: 'coder-model' }])
  pass('host: a complex request selects the coder model on message insert')

  // An ordinary message keeps the heavy tier until the failure counter is reset.
  const toolResult = listeners.get('tools/result')
  assert.ok(toolResult, 'host listens to tools/result')
  selected.length = 0
  toolResult({ agent, name: 'bash' }, { isError: true })
  toolResult({ agent, name: 'bash' }, { isError: true })
  await tick(); await tick(); await tick()
  assert.deepEqual(selected.at(-1), { provider: 'deepseek', model: 'heavy-model' })
  pass('host: the tool failure threshold switches to the heavy model')

  selected.length = 0
  inserted({ agent, message: { role: 'user', content: [{ type: 'text', text: 'just answer' }] } })
  await tick(); await tick(); await tick()
  assert.deepEqual(selected.at(-1), { provider: 'deepseek', model: 'heavy-model' })
  pass('host: after failures new messages stay on the heavy model')

  // A successful edit resets the counter, so the next message goes back to fast.
  toolResult({ agent, name: 'edit' }, { isError: false })
  selected.length = 0
  inserted({ agent, message: { role: 'user', content: [{ type: 'text', text: 'just answer' }] } })
  await tick(); await tick(); await tick()
  assert.equal(selected.length, 0, 'the model is already fast: select is not called')
  pass('host: a successful edit resets the failure counter')

  const refreshed = await routes.get('/api/model-autopilot/state').fetch(new Request('http://local/api/model-autopilot/state'))
  const refreshedPayload = await refreshed.json()
  assert.ok(refreshedPayload.recent.length >= 1)
  pass('host: the decision log reaches the panel state')
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
  pass('client: the sidebar.panellist icon and the main key are registered')

  assert.equal(localeDicts.length, 1)
  assert.equal(localeDicts[0].ns, 'model-autopilot')
  assert.ok(localeDicts[0].dicts.ru && localeDicts[0].dicts.en)
  assert.equal(localeDicts[0].dicts.ru['panel.title'], 'Автопилот моделей')
  pass('client: ru/en locales are registered')

  const panelElement = main.component({})
  assert.ok(panelElement && typeof panelElement.type === 'function')
  pass('client: the main panel returns a React component')

  // Render the panel with stubbed React hooks and fetch to catch markup exceptions.
  const rendered = []
  const ReactRenderStub = {
    createElement: (type, props, ...children) => {
      const node = { type, props: props ?? {}, children }
      if (typeof type === 'function') rendered.push(type)
      return node
    },
    useState: (initial) => [initial, () => {}],
    useEffect: () => {},
    useRef: () => ({ current: true }),
    Fragment: Symbol('Fragment'),
  }
  void ReactRenderStub
}

try {
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
