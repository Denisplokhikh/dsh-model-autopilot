# DSH host API notes for per-step model routing

Verified against the installed build `@deepseek-ai/* 0.2.2-rc.1`.
All `lib/...` paths below are relative to
`C:\Users\minio\dsh-plugins\_asar\dsh\node_modules\@deepseek-ai\` (extracted from
`C:\Users\minio\AppData\Local\Programs\DeepSeek Harness\resources\app.asar`).
Profile facts read from `C:\Users\minio\.dsh` (read-only); active profile is `desktop`
(`$env:DSH_PROFILE=desktop`, `$env:DSH_PROFILE_DIR=...\profiles\desktop`).

## Facts

### 1. Selection capture timing

- F1. The loop captures the step's selection in `preStep()` **before** the `agent/pre-step`
  waterfall and before step preparation: `dsh-agent-loop/lib/index.js:671`
  `const selection = this.model.current();`, then claim at :670,
  `tools.resolve` :673, `systemPrompt.assemble` :679, and only then
  `await this.dispatch.waterfall("agent/pre-step", { ... modelSelection: selection }, ...)`
  at :685-697. Returned decision carries the frozen selection: :703-708
  `return { ...decision, assembly, selection, toolSet };` (`selection` is written after
  `...decision`, so a pre-step listener cannot override it even if it returned one).
- F2. Step preparation happens after that: `step()` passes `decision.selection` into
  `prepareRequest` (`dsh-agent-loop/lib/index.js:842`), defined at :986; it seeds
  `{...controls, ...selection}` (:990-993), runs the `agent/request` waterfall (:994),
  then rejects any drift: :1000-1001
  `agent "..." : agent/request proposed "..." after step preparation fixed "..."; use agent.model.select() before step preparation`
  (plain `Error`, no code), then `llm.prepareCall` :1005.
- F3. `agent/inbox/inserted` is emitted synchronously per inserted message:
  `dsh-agent-loop/lib/index.js:200` `for (const message of event.data.inserted) this.dispatch.emit(...)`.
  The emitter invokes listeners synchronously and swallows async results:
  `dsh-agent/lib/index.js:363-379` (`for (const callback of callbacks) ...; Promise.resolve(returned).catch(...)`).
- F4. For an idle agent, waking and selection capture are in the same synchronous call stack:
  `send()` splices then wakes (`dsh-agent-loop/lib/index.js:564-569`), `wakeDriver` calls
  `kick()` (:632), `kick` calls `turn()` (:651-653), `turn` calls `await this.preStep(...)` (:742),
  and `preStep` captures at :671 before its first `await` (:673). `withInitiator` is a synchronous
  `AsyncLocalStorage.run` (`dsh-agent/lib/index.js:774-786`). So the capture happens
  before the async classifier's first continuation.
- F5. Consequence: an asynchronous (LLM) classifier started from `agent/inbox/inserted`
  cannot decide the model of the step triggered by that message. The earliest step it can
  affect is the next step whose `preStep` starts after `select()` appends `model/selection`
  (e.g. a later tool-continuation step). A **synchronous** heuristic select in the same
  inserted listener does land before capture for the wake-from-idle case.
  If the agent is already running and the message is a `steer` (next-step target), the claim
  happens at the next step boundary, so a fast classifier may still win; it is a race.
  Documented semantics agree: `dsh-agent/README.md:50` "assigns the complete choice for the
  next step whose preparation has not begun".

### 2. `agent.model.select()` / `current()`

- F6. Accepted fields and no-op rule: `dsh-agent/lib/types/model-selection.js:88-92`
  `select(selection) { if (sameModelSelection(this.recordedSelection(), selection)) return; this.session.append("model/selection", toSelection(...)); }`.
  `sameModelSelection` compares provider, model and reasoningEffort with absent effort as its
  own value (:29-32); `toSelection` accepts `{provider, model, reasoningEffort?}` (:11-13).
  `current()` returns `{...recorded}` where recorded = `pending ?? lastUsed`, else
  `AgentOptions` provider/model, else `undefined` (:81-87, :93-96).
- F7. No validation in `select()`: it only appends the event. Responsibility is the caller's:
  `dsh-agent/README.md:50` "Callers validate availability and capabilities; append failures
  retain the Session's existing guarantees."
- F8. Failure of an unregistered provider happens later and surfaces as `NO_ADAPTER`:
  `registration()` throws `LlmError(..., "NO_ADAPTER")` (`dsh-llm/lib/index.js:2267-2270`),
  called by `prepareCall` (:2228). `prepareRequest` catches only `NO_ADAPTER` and continues
  (`dsh-agent-loop/lib/index.js:1007-1010`); then `llm.stream` yields a terminal
  `{type:"finish", reason:{kind:"error", failure}}` chunk (`dsh-llm/lib/index.js:2407-2418`,
  `adapterStream` :2355-2358), and the loop throws `new LlmError(failure.message, failure.code)`
  (:938). README:95 confirms "A request naming an unregistered provider fails with `NO_ADAPTER`".
- F9. Failure of an unknown model on a registered provider: `prepareCall` rejects with the
  adapter's code, which is **not** caught by the loop's `NO_ADAPTER` branch, so it propagates out
  of `prepareRequest` (:1005). Examples: pi-ai `UNKNOWN_MODEL` (`dsh-llm-pi-ai/lib/index.js:1915`
  `pi-ai provider "..." has no configured model "..."`); deepseek refused listed models
  `MODEL_UNSUPPORTED` / `CLIENT_UPGRADE_REQUIRED` (`dsh-llm-deepseek/lib/index.js:2906-2912`).
- F10. Unsupported `reasoningEffort` fails before provider I/O with code
  `UNSUPPORTED_REASONING_EFFORT`: `resolveCallWithInfo`
  `dsh-llm/lib/index.js:2196` (model without reasoning metadata) and :2200 (effort not in
  `efforts[]`), both `throw new LlmError(..., "UNSUPPORTED_REASONING_EFFORT")`, invoked by
  `prepareCall` (:2238). README:89 "an explicit or configured reasoning effort is checked
  against the exact model before any provider I/O". pi-ai also throws the same code at
  request time (`dsh-llm-pi-ai/lib/index.js:1810-1815` `resolveReasoningLevel`).
- F11. Effect on the loop: no process crash. The turn catch records
  `turn/end: {kind:"error", error:failure}` (`dsh-agent-loop/lib/index.js:800-816`) and
  `throwError` emits `agent/error` (:641-649, payload `{turn, step, error}`); `kick()` contains
  the failure and returns the agent to idle (:651-664). However the input was already claimed at
  :670 (`claim` :103-111 records a splice with `outcome` undefined and never restores it); for a
  failure thrown from `prepareRequest` the claimed message is never appended as `user/message`
  (append happens at :860-866, after :842), so that prompt is lost. It does not retry itself.

### 3. Auxiliary LLM calls from a host plugin (`ctx.llm`)

- F12. The service exists in every base-backed profile: `dsh-base/cordis.patch.yml:34-35`
  `- id: llm / name: '@deepseek-ai/dsh-llm'`; implementation `class LlmRuntime extends ...`
  `super(ctx, "llm")` (`dsh-llm/lib/index.js:1815-1817`). `stream` is a public method:
  signature `stream(options: GenerateOptions): AsyncIterable<StreamChunk>`
  (`dsh-llm/lib/typert.host.js` declarations; impl :2398-2403, possibly wrapped by the
  `llm/stream` waterfall).
- F13. `GenerateOptions` (`dsh-llm/lib/typert.host.js`):
  `provider, model, reasoningEffort?, messages, system?, tools?, toolHistory?, temperature?, maxTokens?, stop?, signal?, sessionId?, purpose?`.
  `messages` accepts durable `Message` or request-only `{role:'user', content:[{type:'text',text}]}`;
  `purpose` is optional for ordinary requests (`dsh-llm/README.md:61`, :63). The core runtime
  never reads `purpose`; only adapters forward it as transport metadata
  (e.g. `dsh-llm-deepseek/lib/index.js:2212-2213`, :2245) and "handle unfamiliar purposes
  without rejecting the request" (README:61). No purpose validation exists in this build.
- F14. Chunk protocol (`dsh-llm/lib/typert.host.js`, `StreamChunk`):
  `block-start{index,blockType}`, `text-delta{index,text}`, `reasoning-delta{index,text}`,
  `tool-call-delta{index,id,name?,argumentsDelta}`, `block-end{index,block}`,
  `usage{usage}`, `finish{reason,replayState?}`. Text is carried exclusively by
  `text-delta.text` (reasoning text by `reasoning-delta.text`). `FinishReasonMap` kinds:
  `stop`, `tool-calls`, `max-tokens`, `aborted{failure}`, `error{failure}`; every stream ends in
  exactly one terminal `finish` chunk (`dsh-llm/README.md:95`). Failures are delivered in
  `finish.reason.failure.code`, not thrown, for adapter/dispatch/iteration errors
  (`dsh-llm/lib/index.js:2392-2418`).
- F15. `resolveModelInfo(provider, model, signal?)` (`dsh-llm/lib/index.js:2116-2122`) returns
  `LlmResolvedModelInfo` = `{provider, id, name, description?, inputModalities?,
  context?:{contextWindow}, defaultMaxTokens?, reasoning?:{efforts:[{id,name,description?}],
  defaultEffort?}, systemPromptUpdate?, toolUpdate?}` (typert declarations;
  normalization/validation :2124-2168). Throws `NO_ADAPTER` for an unregistered provider (:2269)
  and `INVALID_MODEL_*` for bad adapter metadata (:2126-2160).
- F16. Caching: the core does **no** caching (`resolveModelInfoFor` calls the adapter every time,
  :2119-2122); caller-side caching is required. It **can** do network I/O: the DeepSeek adapter's
  `resolveModel` awaits `connection(signal)` → `connect?.(signal)` (`dsh-llm-deepseek/lib/index.js:2120-2121`,
  :2144-2146), and the account provider's `connect` awaits
  `catalog.view(...)` (`dsh-llm-deepseek-account/lib/index.js:154`); the listing cache's first
  access "waits for its load" and later refreshes stale listings in the background
  (`dsh-llm-deepseek/lib/index.js:2516-2562`). pi-ai's `resolveModel` is a local snapshot read
  (`dsh-llm-pi-ai/lib/index.js:1945-1950`).

### 4. `agent/inbox/inserted` payload and ordering

- F17. Payload is per message: `{message, agent}`. Emitted at
  `dsh-agent-loop/lib/index.js:200` for each inserted message; `agentEvents` fuses the subject
  (`dsh-agent/lib/index.js:359-362` `fused = payload => ({...payload, agent})`). A batch claim
  emits nothing; the corresponding lifecycle events are `agent/inbox/claimed` per message
  (`dsh-agent-loop/lib/index.js:106-109`) and `agent/inbox/discarded` (:199).
- F18. No hook can await before capture: the only events before `model.current()` are plain
  `emit`s (inserted/claimed/`agent/status` :562); every awaited hook runs after capture
  (`agent/pre-step` :685, `agent/request` :994, `agent/turn-stopping` :790-796). The inserted
  listener gets no `next()` and its returned promise is only logged (`dsh-agent/lib/index.js:371-378`),
  so it cannot block the loop.

### 5. `agentDefaultModel` availability and this installation

- F19. Mounted by `dsh-base/cordis.patch.yml:90-94` with defaults
  `provider: deepseek-official, model: deepseek-flash`; both standard profiles include that bundle:
  `profiles/web/package.json:7-10` and `profiles/desktop/package.json:10-16` list
  `@deepseek-ai/dsh-base`. Service name `agentDefaultModel`, method `currentSelection()`
  (`dsh-agent-default-model/lib/index.js:17-45`).
- F20. Active profile (`desktop`) overrides it in `C:\Users\minio\.dsh\profiles\desktop\cordis.patch.yml:4-9`:
  `provider: deepseek-account, model: deepseek-flash, reasoningEffort: high`. The same patch
  registers pi-ai provider `opencode-go` (:29-34) and the `model-autopilot` row (:35-40).
- F21. Runtime evidence: `C:\Users\minio\.dsh\storages\session_projcache\sessions\64c45ddb-...json`
  (this session, `$env:DSH_SESSION_ID=64c45ddb-...`) has
  `modelSelection.lastUsed = {"provider":"opencode-go","model":"deepseek-v4.1-flash"}`, pending null:
  a real step was recorded with the plugin's fast/medium route.

### 6. No extra npm dependency needed

- F22. `ctx.llm.stream` produces plain JSON-serializable objects (`AssistantStreamAccumulator`
  requires lossless JSON and only knows the chunk tags: `dsh-llm/lib/types/assistant-stream.js:20-25`,
  :43-110). Text can be collected by concatenating `chunk.text` for `type === 'text-delta'`
  and treating `finish.reason.kind === 'error'|'aborted'` as failure. `BlockAssembler` is exported
  from `@deepseek-ai/dsh-llm` (`dsh-llm/lib/index.js:2434`, used by
  `dsh-session-title-llm/lib/index.js:2`) but importing it requires a resolvable package
  dependency; the plugin's `package.json` declares none, so the dependency-free chunk parse is
  the portable choice.

### 7. Provider requirements for auxiliary calls

- F23. OpenCode Go requires its per-conversation routing header on every request: the pi-ai
  provider wraps each API with `withOpenCodeSessionHeader`, which sets `x-opencode-session` from
  `options.sessionId` (`pi-ai/dist/providers/opencode-headers.js`, `opencode-go.js`). A request
  without `sessionId` is rejected by the service (visible in the OpenCode dashboard as a `400`
  with a `missing_sessi…` reason). The host plugin's `ctx.llm.stream` therefore passes the live
  session id (`agent.session.id`) and does not rely on provider-specific code.

## Consequences for the plugin

- Local heuristics must decide the triggering step and must run **synchronously** inside the
  `agent/inbox/inserted` listener (warm route cache before the first message). An LLM verdict
  (`smartClassify`) can only refine a later unprepared step; that matches `index.js` comment and
  its `messageTokens`/`agent.status` staleness guards.
- Any selection handed to `agent.model.select()` must already be valid: registered provider,
  supported effort. Otherwise the step fails outside the plugin's try/catch with
  `NO_ADAPTER` / `UNKNOWN_MODEL` / `UNSUPPORTED_REASONING_EFFORT`, the turn ends as an error,
  and for failures before request assembly the claimed user message is lost. Stripping an
  unsupported `reasoningEffort` (current `validateTarget` behavior) is the right fallback.
- `agent.model.current()` returns `pending ?? lastUsed`, so comparing with it before `select()`
  correctly avoids redundant events; effort is part of equality (absent != explicit).
- For the classifier call: `{provider, model, messages:[{role:'user',content:[{type:'text',text}]}],
  maxTokens, signal}` is sufficient; omit `purpose` (legal) and avoid `stop` (pi-ai throws
  `UNSUPPORTED_OPTION`); parse only `text-delta` and check the terminal `finish` chunk.
- `ctx.llm.resolveModelInfo` has no host cache and may await network for account-backed routes;
  keep the plugin's own cache plus the timeout, and pass an `AbortSignal` if cancellation matters.
- `agent/inbox/inserted` fires for every inbox insertion, including tool-produced runtime-context
  messages (`dsh-agent-loop/lib/index.js:972`, :976), not only user prompts, and one message at a
  time; classify defensively (current plugin does, but it cannot see the whole claimed batch).
- `agentDefaultModel.currentSelection()` is available by default in web and desktop profiles, but it
  is the deployment default; read it via `ctx.get('agentDefaultModel')` with a fallback as the
  plugin already does.

## Verdicts on the review claims

- (a) CONFIRMED: selection is captured at `dsh-agent-loop/lib/index.js:671`, before the
  `agent/pre-step` waterfall (:685) and before `prepareRequest` (:842/:986).
- (b) CONFIRMED for wake-from-idle: the capture is synchronous inside `send()` after the inserted
  emit, so an async classifier cannot affect the triggering step. Nuance: for `steer` input to a
  running agent the claim happens at a later step boundary, so a very fast classifier may affect
  that next step (race, not guarantee).
- (c) CONFIRMED: an unvalidated selection fails the step later (`NO_ADAPTER` through the stream
  finish path, or `UNKNOWN_MODEL`/`UNSUPPORTED_REASONING_EFFORT` thrown from `prepareCall`); the
  agent loop contains it, but the turn errors and the claimed input can be lost.
- (d) CONFIRMED: `ctx.llm` is mounted by `dsh-base` and exposes public `stream()`; chunks are plain
  objects and text is `text-delta.text`, so no `@deepseek-ai/dsh-llm` import is needed.

## Open questions

- No hook lets a plugin delay selection capture; is there any supported extension point planned
  for pre-selection routing, or is `agent/inbox/inserted` the only synchronous window?
- `agent/inbox/inserted` gives one message, never the eventual claimed batch; whether a batch-aware
  routing API will exist is unknown.
- `agent/model/selection` event validation for empty provider/model strings was not found in the
  runtime path (schemas are type-level only in this build); treat `select()` input as trusted.
- `resolveModelInfo` cost/latency for `deepseek-account` depends on a catalog refresh whose timeout
  and background behavior are adapter-specific; not measured here.
- The `agent/request` waterfall can change controls (temperature/maxTokens) but throws on
  provider/model/effort drift; no documented way to legally override the route at that point.
