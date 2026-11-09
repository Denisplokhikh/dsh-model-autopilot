/**
 * Host half of the Model Autopilot bundle.
 *
 * Observes every prepared agent step, classifies the incoming message batch and
 * the recent tool failures, then selects the configured model for the next step
 * through the public `agent.model.select()` API. State for the left-sidebar
 * panel is served over two authenticated exact Fetch routes; configuration is
 * written through the profile's config editor, never by touching
 * `cordis.patch.yml` from this package.
 *
 * @module dsh-model-autopilot
 */

/** Hard Host dependencies: the authenticated Fetch carrier that serves the panel. */
export const inject = ['connection']

/** Row and client-panel id shared with the Client half. */
const NAME = 'model-autopilot'
/** Absolute Fetch route paths served by the shared authenticated carrier. */
const STATE_PATH = '/api/model-autopilot/state'
const SETTINGS_PATH = '/api/model-autopilot/settings'

const TIERS = ['fast', 'coder', 'heavy']
const MAX_RECENT = 12
const ACTION_TOOLS = new Set([
  'edit',
  'write',
  'apply_patch',
  'edit_file',
  'write_file',
  'apply_diff',
  'bash',
  'run_command',
  'terminal',
  'run_code',
])
/** Heuristic for "this prompt needs the coder tier" in Russian and English. */
const COMPLEX_INTENT = /(архитектур|рефактор|спроектир|анимаци|миграц|почини|исправ|перепиши|оптимиз|реализуй|debug|fix|refactor|architect|implement|compose|optimi[sz]e)/iu

const DEFAULT_TIERS = {
  fast: { provider: '', model: '' },
  coder: { provider: '', model: '' },
  heavy: { provider: '', model: '' },
}

/**
 * Normalize the row config into the shape the routing and the panel read.
 * Missing or malformed values fall back to the disabled default, so a broken
 * patch row never starts silently switching models.
 * @param {unknown} config - raw row config supplied by the Loader.
 * @returns {{ enabled: boolean, escalateAfterErrors: number, tiers: typeof DEFAULT_TIERS }} normalized config.
 */
function normalizeConfig(config) {
  const raw = config !== null && typeof config === 'object' ? config : {}
  const rawTiers = raw.tiers !== null && typeof raw.tiers === 'object' ? raw.tiers : {}
  const tiers = {}
  for (const tier of TIERS) {
    const value = rawTiers[tier] !== null && typeof rawTiers[tier] === 'object' ? rawTiers[tier] : {}
    tiers[tier] = {
      provider: typeof value.provider === 'string' ? value.provider : '',
      model: typeof value.model === 'string' ? value.model : '',
    }
  }
  const threshold = Number(raw.escalateAfterErrors)
  return {
    enabled: raw.enabled === true,
    escalateAfterErrors: Number.isInteger(threshold) && threshold >= 0 && threshold <= 20 ? threshold : 2,
    tiers,
  }
}

/**
 * Read the display text of a step's user message batch. Only text blocks
 * matter for classification; anything unknown stays ignored.
 * @param {readonly unknown[]} messages - messages entering the step.
 * @returns {string} concatenated lower-cased text.
 */
function batchText(messages) {
  if (!Array.isArray(messages)) return ''
  const parts = []
  for (const message of messages) {
    if (message === null || typeof message !== 'object') continue
    const content = message.content
    if (typeof content === 'string') {
      parts.push(content)
      continue
    }
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (block !== null && typeof block === 'object' && typeof block.text === 'string') parts.push(block.text)
    }
  }
  return parts.join('\n').toLowerCase()
}

/**
 * Build the JSON response used by both routes.
 * @param {unknown} value - JSON-safe payload.
 * @param {number} [status] - HTTP status.
 * @returns {Response} JSON response with no caching.
 */
function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}

/**
 * Register the Host half.
 * @param {import('cordis').Context} ctx - Host context.
 * @param {unknown} config - row config.
 */
export function apply(ctx, config = {}) {
  const settings = normalizeConfig(config)
  /** Per-session consecutive failure counters, cleared on success and disposal. */
  const failures = new Map()
  /** Newest-first decision log rendered by the panel. */
  const recent = []

  const pushRecent = (tier, target, reason) => {
    recent.unshift({
      at: Date.now(),
      tier,
      provider: target.provider,
      model: target.model,
      reason,
    })
    if (recent.length > MAX_RECENT) recent.length = MAX_RECENT
  }

  const resolveTarget = (tier) => {
    const preferred = settings.tiers[tier]
    if (preferred !== undefined && preferred.provider !== '' && preferred.model !== '') return preferred
    for (const fallback of TIERS) {
      const candidate = settings.tiers[fallback]
      if (candidate !== undefined && candidate.provider !== '' && candidate.model !== '') return candidate
    }
    return undefined
  }

  const currentSelection = () => {
    try {
      const service = ctx.get('agentDefaultModel')
      return service === undefined ? undefined : service.currentSelection()
    } catch {
      return undefined
    }
  }

  const listModels = async () => {
    const rows = []
    const service = ctx.get('llm')
    if (service === undefined) return rows
    try {
      const providers = service.listProviders()
      for (const provider of providers) {
        let models = []
        try {
          models = await service.listModels(provider.id)
        } catch {
          models = []
        }
        for (const model of models) {
          rows.push({
            provider: provider.id,
            providerName: provider.name,
            id: model.id,
            name: model.name,
          })
          if (rows.length >= 400) return rows
        }
      }
    } catch {
      return rows
    }
    return rows
  }

  /**
   * Select a tier's model for the agent's next unprepared step. Reading the
   * current choice first keeps an unchanged pick a no-op; every failure is
   * contained so a broken selection never breaks the agent's step.
   * @param {{ id: unknown, model?: { select?: Function, current?: Function } }} agent - live agent handle.
   * @param {string} tier - tier name to resolve.
   * @param {string} reason - short machine reason logged for the panel.
   */
  const selectFor = async (agent, tier, reason) => {
    if (!settings.enabled) return
    if (agent === undefined || agent === null) return
    const model = agent.model
    if (model === undefined || model === null || typeof model.select !== 'function') return
    const target = resolveTarget(tier)
    if (target === undefined) return
    try {
      const current = typeof model.current === 'function' ? model.current() : undefined
      if (current !== undefined && current !== null && current.provider === target.provider && current.model === target.model) return
      await model.select({ provider: target.provider, model: target.model })
      pushRecent(tier, target, reason)
    } catch {
      /* Never surface a selection failure into the agent loop. */
    }
  }

  /**
   * Classify one user message batch and select its tier. The model selection
   * for a step is captured before `agent/pre-step`, so the choice has to be
   * made when input arrives rather than inside that waterfall.
   * @param {{ id: unknown, model?: object }} agent - live agent handle.
   * @param {readonly unknown[]} messages - just-inserted messages.
   */
  const classify = async (agent, messages) => {
    if (!settings.enabled) return
    const text = batchText(messages)
    const id = String(agent.id)
    const errors = failures.get(id) ?? 0
    let tier = 'fast'
    if (errors >= settings.escalateAfterErrors && errors > 0) tier = 'heavy'
    else if (COMPLEX_INTENT.test(text)) tier = 'coder'
    await selectFor(agent, tier, tier === 'heavy' ? 'errors' : 'intent')
  }

  ctx.on('agent/inbox/inserted', (payload) => {
    try {
      const agent = payload !== null && typeof payload === 'object' ? payload.agent : undefined
      if (agent === undefined || agent === null) return
      const message = payload.message
      void classify(agent, [message])
    } catch {
      /* inbox notifications are fire-and-forget */
    }
  })

  ctx.on('tools/result', (exec, result) => {
    const agent = exec !== null && typeof exec === 'object' ? exec.agent : undefined
    if (agent === undefined || agent === null) return
    const id = String(agent.id)
    if (result !== null && typeof result === 'object' && result.isError === true) {
      const next = (failures.get(id) ?? 0) + 1
      failures.set(id, next)
      if (next === settings.escalateAfterErrors) void selectFor(agent, 'heavy', 'errors')
      return
    }
    if (exec !== null && typeof exec === 'object' && ACTION_TOOLS.has(exec.name)) failures.set(id, 0)
  })

  ctx.on('agent/disposed', (payload) => {
    const agent = payload !== null && typeof payload === 'object' ? payload.agent : undefined
    if (agent !== undefined && agent !== null) failures.delete(String(agent.id))
  })

  ctx.effect(() => ctx.connection.fetch.register({
    path: STATE_PATH,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async () => {
      const models = await listModels()
      return json({
        enabled: settings.enabled,
        escalateAfterErrors: settings.escalateAfterErrors,
        tiers: settings.tiers,
        models,
        current: currentSelection() ?? null,
        recent,
      })
    },
  }), 'model-autopilot: state route')

  ctx.effect(() => ctx.connection.fetch.register({
    path: SETTINGS_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      let body
      try {
        body = await request.json()
      } catch {
        return json({ ok: false, error: 'invalid-json' }, 400)
      }
      if (body === null || typeof body !== 'object') return json({ ok: false, error: 'invalid-body' }, 400)
      const enabled = body.enabled === true
      const threshold = Number(body.escalateAfterErrors)
      if (!Number.isInteger(threshold) || threshold < 0 || threshold > 20) {
        return json({ ok: false, error: 'invalid-escalate' }, 400)
      }
      const rawTiers = body.tiers !== null && typeof body.tiers === 'object' ? body.tiers : {}
      const tiers = {}
      for (const tier of TIERS) {
        const value = rawTiers[tier] !== null && typeof rawTiers[tier] === 'object' ? rawTiers[tier] : {}
        const provider = typeof value.provider === 'string' ? value.provider.trim() : ''
        const model = typeof value.model === 'string' ? value.model.trim() : ''
        if ((provider === '') !== (model === '')) return json({ ok: false, error: `incomplete-${tier}` }, 400)
        tiers[tier] = { provider, model }
      }
      const entry = ctx.fiber !== undefined && ctx.fiber !== null ? ctx.fiber.entry : undefined
      const editor = ctx.get('configEditor')
      if (entry === undefined || editor === undefined) {
        return json({ ok: false, error: 'config-editor-unavailable' }, 409)
      }
      try {
        await editor.edit(entry, (current) => ({
          ...(current !== null && typeof current === 'object' ? current : {}),
          enabled,
          escalateAfterErrors: threshold,
          tiers,
        }))
      } catch (error) {
        return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 409)
      }
      return json({ ok: true })
    },
  }), 'model-autopilot: settings route')

  ctx.logger?.info?.(`[model-autopilot] loaded v2 inbox-routing (enabled=${settings.enabled})`)
  void NAME
}
