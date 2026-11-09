/**
 * Host half of the Model Autopilot bundle.
 *
 * Observes every prepared agent step, classifies the incoming message batch
 * locally, then selects the configured model for the next unprepared step
 * through the public `agent.model.select()` API. State for the left-sidebar
 * panel is served over two authenticated exact Fetch routes; configuration is
 * written through the profile's config editor, never by touching
 * `cordis.patch.yml` from this package.
 *
 * The plugin is deliberately self-contained: it never hardcodes a provider,
 * a model id, or a third-party classification service. Unset tiers are derived
 * from the deployment default model the user already configured in
 * DeepSeek Harness, so a fresh install works without buying any API key.
 *
 * @module dsh-model-autopilot
 */

import { classifyRequest, classifierPrompt, parseVerdict } from './classifier.js'

/** Hard Host dependencies: the authenticated Fetch carrier that serves the panel. */
export const inject = ['connection']

/** Row and client-panel id shared with the Client half. */
const NAME = 'model-autopilot'
/** Absolute Fetch route paths served by the shared authenticated carrier. */
const STATE_PATH = '/api/model-autopilot/state'
const SETTINGS_PATH = '/api/model-autopilot/settings'

const TIERS = ['fast', 'coder', 'heavy']
/** Accepted classifier modes: local heuristics or one call to the user's fast model. */
const CLASSIFIERS = ['local', 'fast']
const MAX_RECENT = 12
/** Upper bound for one fast-model classification round trip. */
const DEFAULT_CLASSIFIER_TIMEOUT_MS = 1500
/** Minimum request length worth an extra classification request. */
const MIN_CLASSIFIER_CHARS = 12
/** Bound for resolving model metadata; a slow provider never blocks a step. */
const MODEL_INFO_TIMEOUT_MS = 4000
/** Backoff before retrying metadata that failed to resolve. */
const INFO_RETRY_MS = 30000
/** How long an advertised model catalog is trusted before it is re-read. */
const CATALOG_TTL_MS = 60000
/** Output cap for the optional fast-model classification request. */
const CLASSIFIER_MAX_TOKENS = 48
/** Bound for the fast-model classifier's answer. */
const CLASSIFIER_MAX_CHARS = 160
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

const DEFAULT_TIERS = {
  fast: { provider: '', model: '', reasoningEffort: '' },
  coder: { provider: '', model: '', reasoningEffort: '' },
  heavy: { provider: '', model: '', reasoningEffort: '' },
}

/**
 * Normalize the row config into the shape the routing and the panel read.
 * Missing or malformed values fall back to the disabled default, so a broken
 * patch row never starts silently switching models.
 * @param {unknown} config - raw row config supplied by the Loader.
 * @returns {{ enabled: boolean, escalateAfterErrors: number, classifier: string, classifierTimeoutMs: number, tiers: typeof DEFAULT_TIERS }} normalized config.
 */
function normalizeConfig(config) {
  const raw = config !== null && typeof config === 'object' ? config : {}
  const rawTiers = raw.tiers !== null && typeof raw.tiers === 'object' ? raw.tiers : {}
  const tiers = {}
  for (const tier of TIERS) {
    const value = rawTiers[tier] !== null && typeof rawTiers[tier] === 'object' ? rawTiers[tier] : {}
    tiers[tier] = {
      provider: typeof value.provider === 'string' ? value.provider.trim() : '',
      model: typeof value.model === 'string' ? value.model.trim() : '',
      reasoningEffort: typeof value.reasoningEffort === 'string' ? value.reasoningEffort.trim() : '',
    }
  }
  const threshold = Number(raw.escalateAfterErrors)
  const timeout = Number(raw.classifierTimeoutMs)
  return {
    enabled: raw.enabled === true,
    escalateAfterErrors: Number.isInteger(threshold) && threshold >= 0 && threshold <= 20 ? threshold : 2,
    classifier: CLASSIFIERS.includes(raw.classifier) ? raw.classifier : 'local',
    classifierTimeoutMs: Number.isInteger(timeout) && timeout >= 200 && timeout <= 10000 ? timeout : DEFAULT_CLASSIFIER_TIMEOUT_MS,
    tiers,
  }
}

/**
 * Read the display text of a step's user message batch. Only text blocks
 * matter for classification; anything unknown stays ignored.
 * @param {readonly unknown[]} messages - messages entering the step.
 * @returns {string} concatenated text.
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
  return parts.join('\n')
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
 * Race one promise against a deadline. The host must never wait on a broken
 * provider, so a timeout resolves to `undefined` instead of rejecting.
 * @param {Promise<unknown>} promise - pending operation.
 * @param {number} ms - deadline in milliseconds.
 * @returns {Promise<unknown>} settled value or undefined on timeout/failure.
 */
function withTimeout(promise, ms) {
  return new Promise((resolve) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      resolve(undefined)
    }, ms)
    if (typeof timer === 'object' && timer !== null && typeof timer.unref === 'function') timer.unref()
    promise.then(
      (value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(value)
      },
      () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(undefined)
      },
    )
  })
}

/**
 * Normalize one `{ provider, model, reasoningEffort? }` object into a detached
 * selection, or undefined when the pair is incomplete.
 * @param {unknown} value - candidate selection.
 * @returns {{ provider: string, model: string, reasoningEffort?: string } | undefined} clean selection.
 */
function cleanSelection(value) {
  if (value === null || typeof value !== 'object') return undefined
  const provider = typeof value.provider === 'string' ? value.provider.trim() : ''
  const model = typeof value.model === 'string' ? value.model.trim() : ''
  if (provider === '' || model === '') return undefined
  const effort = typeof value.reasoningEffort === 'string' ? value.reasoningEffort.trim() : ''
  return effort === '' ? { provider, model } : { provider, model, reasoningEffort: effort }
}

/**
 * Compare two selections including the optional reasoning effort.
 * @param {{ provider: string, model: string, reasoningEffort?: string } | undefined} left - current selection.
 * @param {{ provider: string, model: string, reasoningEffort?: string }} right - desired selection.
 * @returns {boolean} whether both name the exact same choice.
 */
function sameSelection(left, right) {
  if (left === undefined || left === null) return false
  if (left.provider !== right.provider || left.model !== right.model) return false
  return (left.reasoningEffort ?? '') === (right.reasoningEffort ?? '')
}

/**
 * Register the Host half.
 * @param {import('cordis').Context} ctx - Host context.
 * @param {unknown} config - row config.
 */
export function apply(ctx, config = {}) {
  /** Mutable because a successful settings save applies before the reload lands. */
  let settings = normalizeConfig(config)
  /** Per-session consecutive failure counters, cleared on success and disposal. */
  const failures = new Map()
  /** Per-session message revision, used to drop stale fast-model verdicts. */
  const messageTokens = new Map()
  /** Resolved model metadata keyed by `provider\u0000model`. */
  const infoCache = new Map()
  /** Settled metadata values, readable synchronously on the routing hot path. */
  const infoValues = new Map()
  /** Metadata failures with a retry deadline, so a broken provider is not hammered. */
  const infoRetryAt = new Map()
  /** Advertised model catalogs keyed by provider id. */
  const catalogCache = new Map()
  /** In-flight catalog reads. */
  const catalogPending = new Map()
  /** Resolved tier targets with the signature they were derived from. */
  let targetsCache = null
  /** Newest-first decision log rendered by the panel. */
  const recent = []

  /**
   * Read one optional Host service without letting a missing mount throw.
   * @param {string} name - service name on the context.
   * @returns {any} the service, or undefined.
   */
  const service = (name) => {
    try {
      return ctx.get(name)
    } catch {
      return undefined
    }
  }

  /** Registered provider ids; an empty set means routing must stay disabled. */
  const providerIds = () => {
    const llm = service('llm')
    if (llm === undefined || typeof llm.listProviders !== 'function') return new Set()
    try {
      const providers = llm.listProviders()
      const ids = new Set()
      for (const provider of Array.isArray(providers) ? providers : []) {
        if (provider !== null && typeof provider === 'object' && typeof provider.id === 'string') ids.add(provider.id)
      }
      return ids
    } catch {
      return new Set()
    }
  }

  /** The deployment default model the user configured in Settings → Models. */
  const defaultSelection = () => {
    const model = service('agentDefaultModel')
    if (model === undefined || typeof model.currentSelection !== 'function') return undefined
    try {
      return cleanSelection(model.currentSelection())
    } catch {
      return undefined
    }
  }

  /**
   * Resolve one route's metadata: context window, reasoning efforts, output
   * defaults. A failed lookup is retried after a short backoff instead of
   * being cached as "unavailable" forever, so a slow provider catalog cannot
   * lock routing out for the rest of the process lifetime.
   * @param {string} provider - provider id.
   * @param {string} model - model id.
   * @returns {Promise<object | null>} metadata or null when unavailable.
   */
  const resolveInfo = (provider, model) => {
    const key = `${provider}\u0000${model}`
    const pending = infoCache.get(key)
    if (pending !== undefined) return pending
    const retryAt = infoRetryAt.get(key)
    if (retryAt !== undefined) {
      if (retryAt > Date.now()) return Promise.resolve(null)
      infoRetryAt.delete(key)
    }
    const request = (async () => {
      const llm = service('llm')
      if (llm === undefined || typeof llm.resolveModelInfo !== 'function') return null
      try {
        const info = await withTimeout(llm.resolveModelInfo(provider, model), MODEL_INFO_TIMEOUT_MS)
        return info !== null && typeof info === 'object' ? info : null
      } catch {
        return null
      }
    })().then((info) => {
      if (info === null) {
        infoValues.delete(key)
        infoCache.delete(key)
        infoRetryAt.set(key, Date.now() + INFO_RETRY_MS)
      } else {
        infoValues.set(key, info)
        infoRetryAt.delete(key)
      }
      return info
    })
    infoCache.set(key, request)
    return request
  }

  /**
   * Read the advertised model catalog of one provider. `null` means the
   * adapter cannot report a catalog, so the plugin must not treat an unlisted
   * id as invalid.
   * @param {string} provider - provider id.
   * @returns {Promise<Set<string> | null>} advertised model ids, or null.
   */
  const fetchCatalog = (provider) => {
    const cached = catalogCache.get(provider)
    if (cached !== undefined && Date.now() - cached.at < CATALOG_TTL_MS) return Promise.resolve(cached.value)
    const pending = catalogPending.get(provider)
    if (pending !== undefined) return pending
    const request = (async () => {
      const llm = service('llm')
      if (llm === undefined || typeof llm.listModels !== 'function') return null
      try {
        const models = await withTimeout(llm.listModels(provider), MODEL_INFO_TIMEOUT_MS)
        if (!Array.isArray(models)) return null
        const ids = new Set()
        for (const model of models) {
          if (model !== null && typeof model === 'object' && typeof model.id === 'string' && model.id !== '') ids.add(model.id)
        }
        return ids.size === 0 ? null : ids
      } catch {
        return null
      }
    })().then((value) => {
      catalogCache.set(provider, { at: Date.now(), value })
      catalogPending.delete(provider)
      return value
    })
    catalogPending.set(provider, request)
    return request
  }

  /**
   * Settled catalog of one provider, readable synchronously.
   * @param {string} provider - provider id.
   * @returns {Set<string> | null | undefined} ids, null when unverifiable, undefined when not read yet.
   */
  const catalogValue = (provider) => {
    const cached = catalogCache.get(provider)
    return cached !== undefined && Date.now() - cached.at < CATALOG_TTL_MS ? cached.value : undefined
  }

  /**
   * Map a model's supported reasoning efforts onto the three tiers. The fast
   * tier takes the least effort, the heavy tier the most, and the coder tier
   * the model's own default (or the middle of the list). A pinned default
   * effort does not collapse the coder tier onto the heavy one: the point of
   * auto resolution is to differentiate the levels.
   * @param {object | null} info - resolved model metadata.
   * @returns {{ fast: string, coder: string, heavy: string } | null} effort per tier, or null when the model has none.
   */
  const deriveEfforts = (info) => {
    const reasoning = info !== null && typeof info === 'object' ? info.reasoning : undefined
    if (reasoning === null || typeof reasoning !== 'object' || !Array.isArray(reasoning.efforts)) return null
    const ids = reasoning.efforts
      .map((effort) => (effort !== null && typeof effort === 'object' && typeof effort.id === 'string' ? effort.id : ''))
      .filter((id) => id !== '')
    if (ids.length === 0) return null
    let coderIndex = Math.min(ids.length - 1, Math.floor(ids.length / 2))
    const defaultEffort = typeof reasoning.defaultEffort === 'string' ? reasoning.defaultEffort : ''
    if (defaultEffort !== '' && ids.includes(defaultEffort)) coderIndex = ids.indexOf(defaultEffort)
    return { fast: ids[0], coder: ids[coderIndex], heavy: ids[ids.length - 1] }
  }

  /**
   * Derive the target selection of every tier. Explicit config wins; otherwise
   * the tier inherits the deployment default model and differs only by its
   * supported reasoning effort, which is what makes a zero-config install do
   * something useful without any extra provider or key.
   * @returns {Promise<Record<string, { provider: string, model: string, reasoningEffort?: string, source: string }>>} tier targets.
   */
  const computeTargets = async () => {
    const base = defaultSelection()
    const info = base === undefined ? null : await resolveInfo(base.provider, base.model)
    const efforts = deriveEfforts(info)
    const targets = {}
    for (const tier of TIERS) {
      const configured = settings.tiers[tier]
      if (configured.provider !== '' && configured.model !== '') {
        targets[tier] = cleanSelection(configured) === undefined
          ? undefined
          : { ...cleanSelection(configured), source: 'config' }
        continue
      }
      if (base === undefined) {
        targets[tier] = undefined
        continue
      }
      if (efforts === null) {
        // The model advertises no reasoning levels: every tier is the same
        // route, so selecting it is a no-op and the panel says so.
        targets[tier] = { ...base, source: 'default' }
        continue
      }
      const effort = efforts[tier]
      targets[tier] = {
        provider: base.provider,
        model: base.model,
        ...(typeof effort === 'string' && effort !== '' ? { reasoningEffort: effort } : {}),
        source: 'auto',
      }
    }
    // Settle metadata and catalogs for every target before publishing the
    // cache: the first message on an explicitly configured tier must already
    // select synchronously, and a stale model id must be visible before it can
    // reach the agent loop.
    const routes = new Map()
    for (const tier of TIERS) {
      const target = targets[tier]
      if (target === undefined) continue
      routes.set(`${target.provider}\u0000${target.model}`, { provider: target.provider, model: target.model })
    }
    await Promise.all([...routes.values()].flatMap((route) => [
      resolveInfo(route.provider, route.model),
      fetchCatalog(route.provider),
    ]))
    return targets
  }

  /** Signature of everything the derived targets depend on. */
  const targetSignature = () => {
    const base = defaultSelection()
    return JSON.stringify(settings.tiers)
      + '|'
      + settings.classifier
      + '|'
      + (base === undefined ? '' : `${base.provider}\u0000${base.model}\u0000${base.reasoningEffort ?? ''}`)
  }

  /** Cached targets when they are still derived from the current config. */
  const cachedTargets = () => (targetsCache !== null && targetsCache.signature === targetSignature() ? targetsCache.targets : undefined)

  /**
   * Read the tier targets, recomputing them when the config or the deployment
   * default changed while the panel stayed open.
   * @returns {Promise<Record<string, object | undefined>>} tier targets.
   */
  const ensureTargets = async () => {
    const cached = cachedTargets()
    if (cached !== undefined) return cached
    const targets = await computeTargets()
    targetsCache = { signature: targetSignature(), targets }
    return targets
  }

  /**
   * Validate one target against the live provider registry and the settled
   * model metadata without touching the event loop. `'unknown'` means the
   * metadata has not arrived yet and the caller must await `resolveInfo`.
   * @param {{ provider: string, model: string, reasoningEffort?: string }} target - cleaned candidate.
   * @returns {{ provider: string, model: string, reasoningEffort?: string } | null | 'unknown'} safe selection, rejection, or pending metadata.
   */
  const validateSync = (target) => {
    const providers = providerIds()
    if (providers.size === 0 || !providers.has(target.provider)) return null
    const catalog = catalogValue(target.provider)
    if (catalog === undefined) return 'unknown'
    if (catalog !== null && !catalog.has(target.model)) return null
    const info = infoValues.get(`${target.provider}\u0000${target.model}`)
    if (info === undefined) return 'unknown'
    if (info === null) return null
    const effort = target.reasoningEffort
    if (effort === undefined) return { provider: target.provider, model: target.model }
    const efforts = info.reasoning !== null && typeof info.reasoning === 'object' ? info.reasoning.efforts : undefined
    const supported = Array.isArray(efforts) && efforts.some((entry) => entry !== null && typeof entry === 'object' && entry.id === effort)
    return supported ? { provider: target.provider, model: target.model, reasoningEffort: effort } : { provider: target.provider, model: target.model }
  }

  /**
   * Validate one target against the live provider registry and the model's own
   * metadata. An invalid selection must never reach `agent.model.select()`:
   * the loop would fail the step later, outside this plugin's try/catch.
   * @param {{ provider: string, model: string, reasoningEffort?: string } | undefined} target - candidate.
   * @returns {Promise<{ provider: string, model: string, reasoningEffort?: string } | undefined>} safe selection.
   */
  const validateTarget = async (target) => {
    const cleaned = cleanSelection(target)
    if (cleaned === undefined) return undefined
    const early = validateSync(cleaned)
    if (early !== 'unknown') return early === null ? undefined : early
    const catalog = catalogValue(cleaned.provider) ?? await fetchCatalog(cleaned.provider)
    if (catalog !== null && !catalog.has(cleaned.model)) return undefined
    const info = await resolveInfo(cleaned.provider, cleaned.model)
    if (info === null) return undefined
    const effort = cleaned.reasoningEffort
    if (effort === undefined) return cleaned
    const efforts = info.reasoning !== null && typeof info.reasoning === 'object' ? info.reasoning.efforts : undefined
    const supported = Array.isArray(efforts) && efforts.some((entry) => entry !== null && typeof entry === 'object' && entry.id === effort)
    return supported ? cleaned : { provider: cleaned.provider, model: cleaned.model }
  }

  /**
   * Apply one already-validated selection. Reading the current choice first
   * keeps an unchanged pick a no-op.
   * @param {{ id: unknown, model?: { select?: Function, current?: Function } }} agent - live agent handle.
   * @param {{ provider: string, model: string, reasoningEffort?: string }} selection - safe selection.
   * @param {string} tier - tier that was selected.
   * @param {string} reason - short machine reason.
   * @param {{ score?: number, signals?: string[] }} detail - classifier trace.
   * @param {string | undefined} source - where the target came from.
   */
  const applySelection = (agent, selection, tier, reason, detail, source) => {
    let current
    try {
      current = typeof agent.model.current === 'function' ? agent.model.current() : undefined
    } catch {
      current = undefined
    }
    if (sameSelection(current, selection)) return
    try {
      const pending = agent.model.select(selection)
      if (pending !== null && typeof pending === 'object' && typeof pending.then === 'function') pending.catch(() => {})
    } catch {
      return
    }
    pushRecent(tier, selection, reason, { ...detail, source })
  }

  /**
   * Select a tier's model for the next unprepared step. The settled path is
   * fully synchronous so the selection lands before the step's route is
   * captured; the first message after start-up may await metadata once. Every
   * failure is contained so a broken selection never breaks the agent's step.
   * @param {{ id: unknown, model?: { select?: Function, current?: Function } }} agent - live agent handle.
   * @param {string} tier - tier name to resolve.
   * @param {string} reason - short machine reason logged for the panel.
   * @param {{ score?: number, signals?: string[] }} [detail] - classifier trace.
   */
  const selectFor = async (agent, tier, reason, detail = {}) => {
    if (!settings.enabled) return
    if (agent === undefined || agent === null) return
    const model = agent.model
    if (model === undefined || model === null || typeof model.select !== 'function') return
    const cached = cachedTargets()
    if (cached !== undefined) {
      const target = cached[tier]
      const cleaned = cleanSelection(target)
      if (cleaned === undefined) return
      const sync = validateSync(cleaned)
      if (sync !== 'unknown') {
        if (sync !== null) applySelection(agent, sync, tier, reason, detail, target === undefined ? undefined : target.source)
        return
      }
    }
    const targets = cached ?? await ensureTargets()
    const target = targets[tier]
    const validated = await validateTarget(target)
    if (validated === undefined) return
    applySelection(agent, validated, tier, reason, detail, target === undefined ? undefined : target.source)
  }

  /**
   * Record one decision for the panel.
   * @param {string} tier - tier that was selected.
   * @param {{ provider: string, model: string, reasoningEffort?: string }} target - selected route.
   * @param {string} reason - short machine reason.
   * @param {{ score?: number, signals?: string[], source?: string }} [detail] - classifier trace.
   */
  const pushRecent = (tier, target, reason, detail = {}) => {
    const entry = {
      at: Date.now(),
      tier,
      provider: target.provider,
      model: target.model,
      reason,
    }
    if (target.reasoningEffort !== undefined) entry.reasoningEffort = target.reasoningEffort
    if (typeof detail.source === 'string') entry.source = detail.source
    if (typeof detail.score === 'number') entry.score = detail.score
    if (Array.isArray(detail.signals) && detail.signals.length > 0) entry.signals = detail.signals.slice(0, 6)
    recent.unshift(entry)
    if (recent.length > MAX_RECENT) recent.length = MAX_RECENT
  }

  /**
   * Ask the user's own fast model for a second opinion. The request goes
   * through the configured `fast` tier route (or the deployment default), uses
   * the host LLM service directly, and is bounded by a deadline: any failure
   * simply keeps the local heuristic verdict. Because a step's route is fixed
   * before that step starts, the verdict refines the next unprepared step.
   * @param {{ id: unknown, status?: string, model?: object }} agent - live agent handle.
   * @param {string} text - message batch text.
   * @param {number} token - message revision this call belongs to.
   * @param {string} heuristicTier - local verdict, used as the fallback.
   */
  const smartClassify = async (agent, text, token, heuristicTier) => {
    const llm = service('llm')
    if (llm === undefined || typeof llm.stream !== 'function') return
    const targets = await ensureTargets()
    const route = cleanSelection(targets.fast) ?? defaultSelection()
    if (route === undefined) return
    if (!providerIds().has(route.provider)) return
    const controller = typeof AbortController === 'function' ? new AbortController() : undefined
    const timer = setTimeout(() => {
      try {
        if (controller !== undefined) controller.abort()
      } catch {
        /* an aborted classification is already the fallback path */
      }
    }, settings.classifierTimeoutMs)
    if (typeof timer === 'object' && timer !== null && typeof timer.unref === 'function') timer.unref()
    try {
      // Use the least reasoning level the fast model advertises, so a
      // reasoner does not burn the output cap on hidden thinking.
      const info = await resolveInfo(route.provider, route.model)
      const efforts = info !== null && typeof info === 'object'
        && info.reasoning !== null && typeof info.reasoning === 'object'
        && Array.isArray(info.reasoning.efforts)
        ? info.reasoning.efforts
        : []
      const leastEffort = efforts.length > 0 && efforts[0] !== null && typeof efforts[0] === 'object' && typeof efforts[0].id === 'string'
        ? efforts[0].id
        : undefined
      let output = ''
      const stream = llm.stream({
        provider: route.provider,
        model: route.model,
        ...(leastEffort === undefined ? {} : { reasoningEffort: leastEffort }),
        messages: [{ role: 'user', content: [{ type: 'text', text: classifierPrompt(text) }] }],
        maxTokens: CLASSIFIER_MAX_TOKENS,
        ...(controller === undefined ? {} : { signal: controller.signal }),
      })
      for await (const chunk of stream) {
        if (chunk === null || typeof chunk !== 'object') continue
        const type = typeof chunk.type === 'string' ? chunk.type : ''
        if (type !== 'text-delta') continue
        if (typeof chunk.text === 'string') output += chunk.text
        if (output.length >= CLASSIFIER_MAX_CHARS) break
      }
      const tier = parseVerdict(output)
      if (tier === undefined || tier === heuristicTier) return
      if ((messageTokens.get(String(agent.id)) ?? 0) !== token) return
      if (typeof agent.status === 'string' && agent.status !== 'running') return
      await selectFor(agent, tier, 'classifier', { signals: [`classifier:${tier}`] })
    } catch {
      /* Keep the heuristic verdict. */
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Classify one user message batch and select its tier. The model selection
   * for a step is captured before `agent/pre-step`, so the choice has to be
   * made when input arrives rather than inside that waterfall.
   * @param {{ id: unknown, status?: string, model?: object }} agent - live agent handle.
   * @param {readonly unknown[]} messages - just-inserted messages.
   */
  const classify = (agent, messages) => {
    if (!settings.enabled) return
    const text = batchText(messages)
    const id = String(agent.id)
    const errors = failures.get(id) ?? 0
    const verdict = classifyRequest(text)
    const escalate = settings.escalateAfterErrors > 0 && errors > 0 && errors >= settings.escalateAfterErrors
    const tier = escalate ? 'heavy' : verdict.tier
    const token = (messageTokens.get(id) ?? 0) + 1
    messageTokens.set(id, token)
    void selectFor(agent, tier, escalate ? 'errors' : 'intent', { score: verdict.score, signals: verdict.signals })
    if (settings.classifier === 'fast' && !escalate && text.trim().length >= MIN_CLASSIFIER_CHARS) {
      void smartClassify(agent, text, token, verdict.tier)
    }
  }

  const currentSelection = () => {
    try {
      const model = service('agentDefaultModel')
      return model === undefined || typeof model.currentSelection !== 'function' ? null : model.currentSelection() ?? null
    } catch {
      return null
    }
  }

  const listModels = async () => {
    const rows = []
    const llm = service('llm')
    if (llm === undefined || typeof llm.listProviders !== 'function') return rows
    try {
      const providers = llm.listProviders()
      for (const provider of Array.isArray(providers) ? providers : []) {
        let models = []
        try {
          models = typeof llm.listModels === 'function' ? await llm.listModels(provider.id) : []
        } catch {
          models = []
        }
        for (const model of Array.isArray(models) ? models : []) {
          if (model === null || typeof model !== 'object' || typeof model.id !== 'string') continue
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

  /** Warm the route metadata cache so the first message can select immediately. */
  const prewarm = () => {
    if (!settings.enabled) return
    void ensureTargets().catch(() => {})
  }

  ctx.on('agent/inbox/inserted', (payload) => {
    try {
      const agent = payload !== null && typeof payload === 'object' ? payload.agent : undefined
      if (agent === undefined || agent === null) return
      const message = payload.message
      // Only the human's own messages route the model. Injected context
      // (`runtime-context`, `model-selection` notices, subagent results, …) is
      // user-role too, but classifying it would switch models on reminders.
      const source = message !== null && typeof message === 'object' ? message.source : undefined
      const kind = source !== null && typeof source === 'object' ? source.kind : undefined
      if (typeof kind === 'string' && kind !== 'user') return
      classify(agent, [message])
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
      if (settings.enabled && settings.escalateAfterErrors > 0 && next === settings.escalateAfterErrors) {
        void selectFor(agent, 'heavy', 'errors', {})
      }
      return
    }
    if (exec !== null && typeof exec === 'object' && ACTION_TOOLS.has(exec.name)) failures.set(id, 0)
  })

  ctx.on('agent/disposed', (payload) => {
    const agent = payload !== null && typeof payload === 'object' ? payload.agent : undefined
    if (agent !== undefined && agent !== null) {
      failures.delete(String(agent.id))
      messageTokens.delete(String(agent.id))
    }
  })

  ctx.effect(() => ctx.connection.fetch.register({
    path: STATE_PATH,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async () => {
      const models = await listModels()
      const targets = await ensureTargets()
      const effective = {}
      for (const tier of TIERS) {
        const target = targets[tier]
        effective[tier] = target === undefined
          ? null
          : {
              provider: target.provider,
              model: target.model,
              ...(target.reasoningEffort === undefined ? {} : { reasoningEffort: target.reasoningEffort }),
              source: target.source,
            }
      }
      return json({
        enabled: settings.enabled,
        escalateAfterErrors: settings.escalateAfterErrors,
        classifier: settings.classifier,
        classifierTimeoutMs: settings.classifierTimeoutMs,
        tiers: settings.tiers,
        models,
        current: currentSelection(),
        effective,
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
      const threshold = Number(body.escalateAfterErrors)
      if (!Number.isInteger(threshold) || threshold < 0 || threshold > 20) {
        return json({ ok: false, error: 'invalid-escalate' }, 400)
      }
      const classifier = body.classifier === undefined ? settings.classifier : body.classifier
      if (!CLASSIFIERS.includes(classifier)) return json({ ok: false, error: 'invalid-classifier' }, 400)
      const timeout = body.classifierTimeoutMs === undefined ? settings.classifierTimeoutMs : Number(body.classifierTimeoutMs)
      if (!Number.isInteger(timeout) || timeout < 200 || timeout > 10000) {
        return json({ ok: false, error: 'invalid-classifier-timeout' }, 400)
      }
      const rawTiers = body.tiers !== null && typeof body.tiers === 'object' ? body.tiers : {}
      const tiers = {}
      for (const tier of TIERS) {
        const value = rawTiers[tier] !== null && typeof rawTiers[tier] === 'object' ? rawTiers[tier] : {}
        const provider = typeof value.provider === 'string' ? value.provider.trim() : ''
        const model = typeof value.model === 'string' ? value.model.trim() : ''
        const reasoningEffort = typeof value.reasoningEffort === 'string' ? value.reasoningEffort.trim() : ''
        if ((provider === '') !== (model === '')) return json({ ok: false, error: `incomplete-${tier}` }, 400)
        if (reasoningEffort.length > 64) return json({ ok: false, error: `invalid-effort-${tier}` }, 400)
        tiers[tier] = { provider, model, reasoningEffort }
      }
      const next = {
        enabled: body.enabled === true,
        escalateAfterErrors: threshold,
        classifier,
        classifierTimeoutMs: timeout,
        tiers,
      }
      const entry = ctx.fiber !== undefined && ctx.fiber !== null ? ctx.fiber.entry : undefined
      const editor = service('configEditor')
      if (entry === undefined || editor === undefined) {
        return json({ ok: false, error: 'config-editor-unavailable' }, 409)
      }
      try {
        await editor.edit(entry, (current) => ({
          ...(current !== null && typeof current === 'object' ? current : {}),
          ...next,
        }))
      } catch (error) {
        return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 409)
      }
      settings = normalizeConfig(next)
      infoCache.clear()
      infoValues.clear()
      infoRetryAt.clear()
      catalogCache.clear()
      catalogPending.clear()
      targetsCache = null
      prewarm()
      return json({ ok: true })
    },
  }), 'model-autopilot: settings route')

  ctx.logger?.info?.(`[model-autopilot] loaded v3 inbox-routing (enabled=${settings.enabled}, classifier=${settings.classifier})`)
  void NAME
  prewarm()
}
