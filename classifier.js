/**
 * Local request classifier for the Model Autopilot bundle.
 *
 * The host plugin decides the tier of a step inside `agent/inbox/inserted`.
 * That decision has to be ready before the loop captures the step's model
 * selection, so the classifier must be synchronous, deterministic, and free:
 * no network, no third-party key, no latency. Everything here is pure; the
 * only state is the pattern tables.
 *
 * The score is a sum of the best signal per group, which keeps a single
 * request from stacking ten synonyms of "refactor" into a "heavy" verdict:
 *
 *   intent   — what the user asks for (architecture > fix > explain)
 *   scope    — how much of the codebase is in play
 *   failure  — an error trace, failing test, or "it does not work"
 *   code     — fences, inline code, file paths, shell commands
 *   plan     — explicit multi-step phrasing
 *   length   — long briefs are usually harder than short ones
 *   casual   — greetings, short questions, "briefly", "continue"
 *
 * Casual signals only apply when no other group fired, so "продолжай
 * рефакторинг" stays a coder request while "как дела?" stays fast.
 *
 * Tiers keep their historical ids so existing profiles keep working:
 *   fast  — light: ordinary turns, short questions, chat
 *   coder — medium: one focused code change, debugging, a small feature
 *   heavy — complex: architecture, migrations, codebase-wide work, failures
 *
 * @module dsh-model-autopilot/classifier
 */

/** Tier ids, ordered by expected cost. */
export const TIERS = Object.freeze(['fast', 'coder', 'heavy'])

/** Score at which a request becomes `coder`. */
export const CODER_THRESHOLD = 2

/** Score at which a request becomes `heavy`. */
export const HEAVY_THRESHOLD = 7

/** Highest score a request can reach. */
const MAX_SCORE = 24

/**
 * Whole-word matcher: the term may not sit inside a longer word, which is what
 * kept the old classifier turning "prefix" into "fix".
 * @param {string[]} words - Latin/Cyrillic words, already lower-case.
 * @returns {RegExp} anchored word matcher.
 */
const word = (...words) => new RegExp(`(?<![\\p{L}\\p{N}])(?:${words.join('|')})(?![\\p{L}\\p{N}])`, 'iu')

/**
 * Latin stem matcher that consumes inflections: `refactor` matches
 * `refactoring` and `migrat` matches `migrated`, while the leading boundary
 * still rejects `preview` for `review`.
 * @param {string[]} stems - Latin stems, already lower-case.
 * @returns {RegExp} stem matcher.
 */
const stem = (...stems) => new RegExp(`(?<![\\p{L}\\p{N}])(?:${stems.join('|')})[a-z]*`, 'iu')

/**
 * Cyrillic stem matcher with a leading boundary and consumed inflections:
 * `исправ` matches `исправления`, but `баг` does not match `багаж`.
 * @param {string[]} stems - Cyrillic stems, already lower-case.
 * @returns {RegExp} stem matcher.
 */
const ruWord = (...stems) => new RegExp(`(?<![\\p{L}\\p{N}])(?:${stems.join('|')})[\\p{L}]*`, 'iu')

/**
 * Cyrillic stem matcher that also accepts prefixes, for the verbs Russians
 * genuinely prefix: `отрефактори`, `перепиши`, `переработай`.
 * @param {string[]} stems - Cyrillic stems, already lower-case.
 * @returns {RegExp} prefix-tolerant stem matcher.
 */
const ruRoot = (...stems) => new RegExp(`(?:${stems.join('|')})[\\p{L}]*`, 'iu')

/** Latinate stems that mean a genuinely large piece of work. */
const STRONG_INTENT = ['architect', 'refactor', 'redesign', 'migrat', 'rewrit', 'rewrot', 'rearchitect', 'overhaul', 'scaffold']
/** Strong Russian roots, prefix-tolerant (от-, пере-, до-). */
const STRONG_INTENT_RU = ['архитектур', 'рефактор', 'спроектир', 'переработ', 'миграц', 'перепиш', 'перепис', 'перестро']

/** Migration wording is both a large intent and a change spread over the schema. */
const BREADTH = ['migrat']
const BREADTH_RU = ['миграц', 'мигрир']

/** Medium intents: a concrete change, fix, review, or integration. */
const MEDIUM_INTENT = ['implement', 'optimi', 'integrat', 'introduc', 'debug', 'review', 'renam']
const MEDIUM_INTENT_WORD = ['fix', 'fixes', 'fixed', 'fixing']
const MEDIUM_INTENT_RU = ['исправ', 'почин', 'отлад', 'реализ', 'добав', 'интегрир', 'оптимиз', 'передела', 'ревью', 'переимен']
/** "Add / implement … feature" is a small product change, however it is phrased. */
const FEATURE = /(?<![\p{L}])(?:add|adds|adding|implement|implementing)\b[^\n.]{0,40}\bfeature/iu

/** Weak intents: explain and small non-code edits. */
const WEAK_INTENT = ['explain', 'analyz', 'describ', 'summariz', 'updat', 'chang', 'tidi']
const WEAK_INTENT_WORD = ['cleanup', 'clean up']
const WEAK_INTENT_RU = ['объясн', 'проанализ', 'разбер', 'опиши', 'обнови', 'измени', 'почист']

/** Explicit codebase-wide scope. */
const SCOPE = ['codebase', 'whole project', 'entire project', 'entire repo', 'entire repository', 'whole repository', 'entire codebase', 'all files', 'multiple files', 'across files', 'every file', 'module structure']
const SCOPE_RU = ['кодов(?:ая|ой) баз', 'весь проект', 'всей проект', 'весь репозитор', 'все файлы', 'всех файлах', 'несколько файлов', 'много файлов', 'всю кодовую базу']

/** Error traces and failing behaviour. */
const FAILURE = ['traceback', 'stack trace', 'exception', 'typeerror', 'referenceerror', 'syntaxerror', 'segmentation fault', 'failing test', 'tests fail', 'test fails', 'does not work', "doesn't work", 'broken', 'bug', 'bugs']
const FAILURE_RU = ['не работает', 'не работают', 'не запуска', 'падает', 'падают', 'ошибк', 'исключени', 'сломал', 'краш']
/** "Баг"/"баги" as whole words: "багаж" must stay untouched. */
const BUG_RU = ['баг', 'бага', 'баги', 'багов', 'багам', 'багами', 'багах']

/** Source-file paths, in both separators. */
const FILE_PATH = /(?:[\w.@-]+[/\\])+[\w.@-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|kt|rb|php|cs|cpp|c|h|json|ya?ml|toml|md|sh|bat|ps1|vue|svelte)\b/iu

/** Common developer commands. */
const SHELL = word('npm', 'pnpm', 'yarn', 'npx', 'git', 'docker', 'kubectl', 'cargo', 'make', 'cmake', 'pytest', 'jest', 'vitest', 'node', 'python', 'pip')

/** Explicit planning wording. */
const PLAN = [
  ['english', word('step 1', 'first', 'then', 'after that', 'finally', 'roadmap', 'multi-step', 'multistep', 'step-by-step', 'step by step')],
  ['russian', ruWord('сначала', 'затем', 'потом', 'пошагов', 'план')],
  ['numbered', /(?:^|\n)\s*(?:\d+[.)]|[-*])\s+/u],
]

/** Casual context: chat, short questions, "quickly", "continue". */
const CASUAL = [
  ['greeting', word('hi', 'hello', 'hey', 'thanks', 'thank you', 'good morning', 'good evening')],
  ['greeting-ru', ruWord('привет', 'спасибо', 'здравствуй', 'добрый день', 'добрый вечер')],
  ['quick', word('quick', 'quickly', 'briefly', 'tldr')],
  ['quick-ru', ruWord('кратко', 'коротко', 'быстро', 'одним словом')],
  ['continue', word('continue', 'go on', 'proceed', 'keep going')],
  ['continue-ru', ruWord('продолжай', 'продолжи', 'давай дальше')],
]

/**
 * Normalize raw message text for pattern matching.
 * @param {unknown} input - concatenated text of the incoming messages.
 * @returns {string} trimmed text, or an empty string.
 */
function normalize(input) {
  return typeof input === 'string' ? input.trim() : ''
}

/**
 * Detect one of the planning phrasings without regex state leaks.
 * @param {string} text - normalized request text.
 * @returns {boolean} whether the request reads like a multi-step brief.
 */
function hasPlan(text) {
  return PLAN.some(([, pattern]) => pattern.test(text))
}

/**
 * Classify one request into a routing tier.
 *
 * @param {unknown} input - concatenated text of the user message batch.
 * @param {{ coderThreshold?: number, heavyThreshold?: number }} [options] - threshold overrides.
 * @returns {{ tier: string, score: number, signals: string[], length: number }} verdict.
 */
export function classifyRequest(input, options = {}) {
  const text = normalize(input)
  const signals = []
  let score = 0

  if (text === '') return { tier: 'fast', score: 0, signals, length: 0 }

  /** Record the best signal of one group and add its weight once. */
  const group = (id, weight) => {
    if (weight <= 0) return false
    signals.push(id)
    score += weight
    return true
  }

  // Intent: architecture/refactor outranks fix/debug/review, which outranks explain.
  if (ruRoot(...STRONG_INTENT_RU).test(text) || stem(...STRONG_INTENT).test(text)) {
    group('intent:large', 4)
  } else if (
    ruWord(...MEDIUM_INTENT_RU).test(text)
    || stem(...MEDIUM_INTENT).test(text)
    || word(...MEDIUM_INTENT_WORD).test(text)
    || FEATURE.test(text)
  ) {
    group('intent:change', 2)
  } else if (ruWord(...WEAK_INTENT_RU).test(text) || stem(...WEAK_INTENT).test(text) || word(...WEAK_INTENT_WORD).test(text)) {
    group('intent:small', 1)
  }

  // Breadth: a migration changes the shape of the system, not one line.
  if (ruRoot(...BREADTH_RU).test(text) || stem(...BREADTH).test(text)) {
    group('breadth:migration', 3)
  }

  // Scope: how much of the repository the request touches.
  if (ruWord(...SCOPE_RU).test(text) || word(...SCOPE).test(text)) {
    group('scope:wide', 3)
  }

  // Failure: a trace, a red test, or "it stopped working".
  if (
    ruWord(...FAILURE_RU).test(text)
    || word(...BUG_RU).test(text)
    || stem('fail', 'crash').test(text)
    || word(...FAILURE).test(text)
    || /(?:^|\s)at\s+[\w.$<>]+:\d+/u.test(text)
  ) {
    group('failure:trace', 2)
  }

  // Code: fenced snippets and source paths are the strongest structural hint.
  let code = 0
  if (text.includes('```')) code = 2
  else if (FILE_PATH.test(text)) code = 2
  else if (/`[^`\n]{1,120}`/u.test(text)) code = 1
  else if (SHELL.test(text)) code = 1
  if (code > 0) group('code:structure', code)

  // Planning wording: an explicit multi-step brief.
  if (hasPlan(text)) group('plan:multi-step', 3)

  // Length: long briefs carry more context and usually more work.
  if (text.length >= 2200) group('length:very-long', 3)
  else if (text.length >= 900) group('length:long', 2)
  else if (text.length >= 300) group('length:medium', 1)

  // Casual signals only matter when nothing else fired: "продолжай
  // рефакторинг" must not be downgraded to fast by the word "продолжай".
  if (score === 0) {
    let casual = 0
    for (const [id, pattern] of CASUAL) {
      if (pattern.test(text)) {
        signals.push(`casual:${id}`)
        casual = Math.max(casual, id === 'greeting' || id === 'greeting-ru' ? 4 : id === 'continue' || id === 'continue-ru' ? 3 : 2)
      }
    }
    if (text.length <= 100 && text.endsWith('?')) {
      signals.push('casual:short-question')
      casual = Math.max(casual, 2)
    }
    score -= casual
  }

  const coderThreshold = Number.isInteger(options.coderThreshold) ? options.coderThreshold : CODER_THRESHOLD
  const heavyThreshold = Number.isInteger(options.heavyThreshold) ? options.heavyThreshold : HEAVY_THRESHOLD
  const bounded = Math.max(0, Math.min(MAX_SCORE, score))
  const tier = bounded >= heavyThreshold ? 'heavy' : bounded >= coderThreshold ? 'coder' : 'fast'
  return { tier, score: bounded, signals, length: text.length }
}

/**
 * Build a compact, model-facing description of a request for the optional
 * fast-model classifier. Kept here so the prompt and the local verdict share
 * one vocabulary.
 * @param {string} text - request text.
 * @param {number} [maxChars] - hard input cap.
 * @returns {string} classifier prompt.
 */
export function classifierPrompt(text, maxChars = 4000) {
  const trimmed = typeof text === 'string' ? text.trim() : ''
  const clipped = trimmed.length > maxChars ? `${trimmed.slice(0, maxChars)}\n…` : trimmed
  return [
    'You route requests for a coding agent. Choose exactly one tier:',
    '- fast: chat, short questions, small lookups, nothing to change.',
    '- coder: one focused code change, debugging, a small feature or review.',
    '- heavy: architecture, migrations, refactors across the codebase, ambiguous multi-step work.',
    'Reply with exactly one lowercase word: fast, coder or heavy. No punctuation, no explanation.',
    '',
    'Request:',
    '"""',
    clipped,
    '"""',
  ].join('\n')
}

/**
 * Parse a fast-model verdict into a tier id.
 * @param {unknown} output - raw model output.
 * @returns {string | undefined} tier id, or undefined when unusable.
 */
export function parseVerdict(output) {
  if (typeof output !== 'string') return undefined
  const lower = output.toLowerCase()
  if (/(?<![\p{L}])(?:heavy|complex|hard)(?![\p{L}])/u.test(lower)) return 'heavy'
  if (/(?<![\p{L}])(?:coder|medium|standard|normal)(?![\p{L}])/u.test(lower)) return 'coder'
  if (/(?<![\p{L}])(?:fast|light|easy|simple)(?![\p{L}])/u.test(lower)) return 'fast'
  return undefined
}
