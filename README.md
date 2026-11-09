<div align="right"><img src="icon.svg" width="88" alt="Model Autopilot icon"></div>

# Model Autopilot — a DSH plugin

A left-sidebar panel that switches the agent model per step: **Light** for ordinary turns, **Medium** for focused code work, and **Complex** for multi-step work or after repeated tool failures.

`MIT` · `no build step` · `no runtime dependencies` · `no telemetry` · `no third-party API keys`

[Русская версия](README.ru.md)

## What it does

A coding session is not uniformly hard. Some steps look up a file, run a test, or answer a question; others plan a migration or untangle a failing trace. Running the biggest model for everything is wasteful, and running a small one for architecture is false economy. Model Autopilot classifies each incoming user message and selects the model for the next agent step from the tiers you configured.

| Tier | Id | When it is picked |
| --- | --- | --- |
| Light | `fast` | Ordinary turns, short questions, small lookups. |
| Medium | `coder` | Focused code changes, debugging, reviews. |
| Complex | `heavy` | Architecture, migrations, wide refactors, and error loops. |

Nothing is hardcoded, and the plugin is off until you enable it.

### Zero third-party API keys

The plugin only uses providers and models you already configured in DeepSeek Harness (**Settings → Models**). There are no hardcoded model ids, no external classifier service, no telemetry and no extra account. In the default `local` mode the classification never leaves the DSH process; the optional `fast` mode makes one small request through your own fast-tier model (see below).

## Requirements

- DSH Desktop or DSH Web with a profile — 0.2.x (built and tested against `0.2.2-rc.1`). The profile must provide the standard `llm`, `agentDefaultModel` and `configEditor` services — stock desktop and web profiles do.
- At least one provider configured in **Settings → Models**.
- Node.js 20 or newer to run the repository's offline self-test (`"engines"` in [package.json](package.json)). DSH runs the plugin itself.

## Install

This package is a DSH bundle plugin: `dsh.bundle.patch` in [package.json](package.json) points at [cordis.patch.yml](cordis.patch.yml), which inserts one `model-autopilot` row into the profile — with the policy off by default.

### A. One line to your agent (easiest)

Paste this into a DSH agent chat:

```
Install the plugin github:Denisplokhikh/dsh-model-autopilot
```

The agent calls `plugin_manager` → `install_bundle` with that spec: it adds the package to the profile dependencies, applies the bundle patch and enables the package. There is nothing to edit by hand — no `package.json`, no Cordis patch, no `pnpm`. The package declares no runtime dependencies, so the install runs no build scripts and asks for no approvals. Updating goes the same way: remove the package (`remove_bundle`) and install it again, because a git spec is pinned to a commit.

### B. From the plugin catalog (Discover)

The interface path. The repository ships [index.json](index.json), a catalog index pinned to a release commit.

1. Enable the optional bundle `@deepseek-ai/dsh-experimental-plugin-market-bundle` in **Settings → Plugins** (it ships with DSH, off by default) and open the **Discover** tab.
2. Add the catalog URL:
   ```
   https://raw.githubusercontent.com/Denisplokhikh/dsh-model-autopilot/main/index.json
   ```
3. Search for **Autopilot** and install it.

### C. From a clone or a local checkout (development)

```bash
git clone https://github.com/Denisplokhikh/dsh-model-autopilot.git
```

Then ask your DSH agent to install the bundle from that absolute directory (`plugin_manager` → `install_bundle`). This installs a working copy: file edits are picked up without reinstalling, and `remove_bundle` only detaches it.

### D. Manual profile dependency (advanced)

For a hand-managed profile, add the package as a dependency of the profile and install it:

```json
{
  "dependencies": {
    "dsh-model-autopilot": "github:Denisplokhikh/dsh-model-autopilot"
  }
}
```

The bundle patch then inserts the row into the profile's Cordis patch. Set its config from the [Configuration](#configuration) section and `enabled: true` when you want the autopilot on. If the row is missing, copy the `insert` block from [cordis.patch.yml](cordis.patch.yml) into the profile patch. How a profile applies patches is DSH-side; see the DSH docs. The plugin never edits `cordis.patch.yml` at runtime — the panel writes through the profile's config editor.

## After installing

1. Open **Autopilot** in the left sidebar (reload the Web client if the entry is missing).
2. Check **Tiers** and **Classifier** as described in [First run](#first-run).
3. Press **Enable**. The plugin intentionally installs disabled: it will not start switching models without your consent.

The policy takes effect from the next agent step. Until then the plugin observes nothing and changes nothing.

## First run

1. Open **Autopilot** in the left sidebar.
2. Under **Tiers**, either leave a tier empty or pick a provider and model for it. An empty tier inherits your deployment default model and derives its reasoning effort (see [Auto tier resolution](#auto-tier-resolution)); the line under the picker shows the effective route and where it came from.
3. In **Classifier**, keep **Local heuristics** for the instant offline path, or choose **Fast model of my provider** to let your own model refine the classification. In fast mode pick **Model for classification** — leave it on **Light tier (default)** to reuse the Light model, or choose a dedicated cheap model. The **Classifier timeout, ms** field controls the deadline.
4. Set **Tool failures before switching to complex** if the default of `2` does not fit your workflow.
5. Save, then Enable. The policy applies from the next step.

## The panel

The panel (title **Model autopilot**, sidebar entry **Autopilot**) edits the same `config` block that the profile patch holds, and shows the effective decisions rather than only the raw settings:

- **State** — enabled or disabled (**Enabled**/**Disabled**), the Enable/Disable switch, and **Default model for new sessions**.
- **Tiers** — **Light**, **Medium**, **Complex**, each picked as a provider and model, grouped by provider. Below every picker the effective route is shown as `provider / model · effort — source`, where the source is **configured**, **auto from your default model**, **your default model (no reasoning levels)**, or **not available yet**.
- **Classifier** — **Local heuristics** or **Fast model of my provider**; in fast mode a **Model for classification** picker (**Light tier (default)** or any advertised model), the effective classifier route, and **Classifier timeout, ms** (200–10000).
- **Tool failures before switching to complex** — the escalation threshold (0–20).
- **Recent decisions** — tier, provider/model (with the reasoning effort when there is one), reason (**by request**, **after failures**, **by fast model**), classifier score, and time.

## How a step is routed

```
new user message
      │
      ▼
classifier.js local score ──(classifier: fast, message ≥ 12 chars)──▶ one small request via llm.stream
      │                                                               │ timeout / error / unclear → local verdict
      ▼                                                               ▼
pick tier (fast | coder | heavy) ──▶ validate ──▶ agent.model.select() ──▶ next unprepared step
      ▲
tool results ──▶ consecutive failures ≥ escalateAfterErrors ──▶ heavy
```

- **Local heuristics first.** [classifier.js](classifier.js) is pure and synchronous: it scores intent, scope, failure traces, code structure, planning wording and length, and lets casual signals count only when nothing else fired. It returns a tier, a score and the signals that produced it. No network, no extra latency.
- **Only your own messages route the model.** The host classifies inbox messages whose source kind is `user`. Injected context — runtime reminders, model-switch notices, subagent results, plugin messages — is ignored, because switching on a reminder would be noise.
- **Escalation.** The host counts consecutive tool results with `isError` per session. At `escalateAfterErrors` (default `2`, `0` disables escalation) it selects the Complex (`heavy`) tier for the next step. A successful editing or shell tool call resets the counter, so escalation is not a permanent state; later messages follow the classifier again.
- **Validation.** Before selecting, the host checks that the provider is registered with the `llm` service and that model metadata resolves (bounded at 4 seconds). An unknown provider or unavailable model is skipped and the agent step is not broken; a reasoning effort the model does not advertise is dropped instead of failing the selection.
- **Selection.** The host calls `agent.model.select()` for the next unprepared step; when the agent already runs the exact target it skips the call. The switch is recorded in the session as a normal model change.
- **Hot path.** A step's model is fixed before that step starts. That is why the triggering step is decided by the local heuristics: they run synchronously on message insertion, against a route cache warmed at load and after every save. (Only the very first message after a cold start, before model metadata resolves, can defer its selection to a later step.) The optional fast-model classifier, even when it answers quickly, can only change a step that has not been prepared yet — in practice a later step. It improves the classification, it does not retroactively change the triggering step.

### Auto tier resolution

Leave the provider and model of a tier empty and it inherits the deployment default model — the default selection in **Settings → Models**. The tiers then differ by reasoning effort: **Light** takes the least effort the model advertises, **Complex** the most, and **Medium** the model's default effort (or the middle of its advertised list). This is what makes a zero-config start work on a default model that has several reasoning levels. Each tier row in the panel shows the resulting route and marks it as **auto from your default model**.

If the default model advertises no reasoning levels, every tier resolves to the same route. There is nothing to switch between, so the plugin makes no model selection; the panel marks those tiers **your default model (no reasoning levels)**. Configure distinct models in that case.

### Fast-model classifier (`classifier: fast`)

When the classifier is set to the fast model, the host sends one tiny request per user message (only messages of 12 or more characters, and not while escalation is active) through the `llm` service. The route is the **Model for classification** you picked, otherwise the Light tier, otherwise the deployment default model. The request uses the prompt from [classifier.js](classifier.js), the model's least reasoning effort, and the session id (some providers, e.g. OpenCode Go, route and attribute a request by its conversation header and reject it otherwise). It is cut off at `classifierTimeoutMs` (default `1500`, valid 200–10000). A timeout, a provider error or an unparseable reply keeps the local verdict. A parsed verdict is applied only when it differs from the local one, the message is still the latest, and the agent is running.

Because the model for a step is fixed before the step starts, the verdict can only refine a step that has not been prepared yet. The panel's recent-decisions log marks these switches **by fast model**.

## Configuration

The row in the profile Cordis patch. Settings saved in the panel end up in the same block, including `classifier`, `classifierTimeoutMs` and `classifierModel`:

```yaml
- insert:
    - id: model-autopilot
      name: dsh-model-autopilot
      config:
        enabled: true
        escalateAfterErrors: 2
        classifier: local
        classifierTimeoutMs: 1500
        classifierModel:
          provider: ''
          model: ''
        tiers:
          fast:
            provider: deepseek
            model: deepseek-chat
            reasoningEffort: ''
          coder:
            provider: deepseek
            model: deepseek-reasoner
            reasoningEffort: ''
          heavy:
            provider: deepseek
            model: deepseek-reasoner
            reasoningEffort: high
```

The provider, model and effort ids above are examples for shape only: use the ids your own providers advertise in **Settings → Models**. `reasoningEffort: high` is the kind of id a model may offer; the accepted values are exactly what the model reports.

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `false` | Master switch. While false the plugin observes nothing and never changes a model. |
| `escalateAfterErrors` | `2` | Consecutive failing tool results in a session before the Complex tier is selected. Integer 0–20; `0` disables escalation. |
| `classifier` | `"local"` | `"local"`: heuristic only, no model request. `"fast"`: one small classification request through the selected classifier model, with the local verdict as fallback. |
| `classifierTimeoutMs` | `1500` | Upper bound for that request, integer 200–10000. On timeout the local verdict is used. Ignored when `classifier: local`. |
| `classifierModel.provider` / `classifierModel.model` | `""` | Explicit route for the classification request. Empty pair = the Light tier, then the deployment default model. Set both or neither; the host rejects an incomplete pair. |
| `tiers.fast.provider` / `tiers.fast.model` | `""` | Provider id and model id from **Settings → Models**. Set both or neither; an empty pair means auto resolution. |
| `tiers.fast.reasoningEffort` | `""` | Optional effort id the model advertises. The panel's tier picker chooses provider and model only; set the effort here. Empty = the model's default effort, and for an inherited tier the plugin derives the effort from the model. |
| `tiers.coder.*` | — | Same three keys for the Medium tier. |
| `tiers.heavy.*` | — | Same three keys for the Complex tier. |

Provider and model are always set together: a tier with one set and the other empty is invalid and the host rejects the save. `reasoningEffort` is optional everywhere, and the bundled patch ships it as an empty string.

## Troubleshooting

| Symptom | Cause / what to try |
| --- | --- |
| The model never changes | The plugin is disabled; every tier is empty and the default model has no reasoning levels; the agent already runs the exact target (a switch would be a no-op); or a configured provider is not registered / its model metadata is unavailable, so the target is skipped. Check the recent-decisions log in the panel. |
| The panel says no models are advertised | No provider is configured in **Settings → Models**, or this profile lacks the `llm` service. Configure a provider and reload. |
| A configured provider does not appear | The list comes from the `llm` service; a provider that failed to initialize is not listed. Recheck **Settings → Models** and the DSH logs. |
| Tiers show “your default model (no reasoning levels)” | The deployment default model advertises no reasoning efforts, so all tiers collapse to one route and no switch happens. Pick distinct provider/model pairs per tier. |
| Saving in the panel fails | The profile lacks the `configEditor` service (heavily customized profile). Set the row config in the profile patch directly. |
| No sidebar entry | The package is installed but the Web client was not reloaded. Reload the client. |
| Complex requests still go to Light | Classification is approximate, and in fast mode a verdict can only apply to a later step. Check the score and signals in the recent-decisions log; while testing, put the same model in Light and Medium. |
| Self-test fails | Run `node verify.mjs .` from the package directory with Node.js 20+. The test is offline: it exercises the classifier, the host routes, zero-config derivation, escalation, the fast-model path, settings validation, and the client registration and locales. |

## Data and privacy

- No third-party keys, accounts, telemetry or hardcoded endpoints.
- In `local` mode the message text is scored in memory only; the plugin has no network code of its own.
- In `fast` mode one small classification request goes through DSH's own `llm` service to the provider and model resolved for the fast tier. That may be your default model, so normally it is the same provider the session already uses; no new destination appears.
- The panel talks to the host over the authenticated same-origin routes `/api/model-autopilot/state` and `/api/model-autopilot/settings`. Settings are written to the profile through `configEditor`; the bundle never rewrites `cordis.patch.yml` itself.

## Limitations

- **Classification is a heuristic approximation.** The local classifier is keyword, structure and length scoring, not an understanding of the request. It will sometimes pick the wrong tier; the recent-decisions log shows the score and which signals fired.
- **A step's model cannot be changed after the step starts.** The model is fixed before the step, so a switch cannot be undone mid-step. The fast-model classifier cannot retroactively change the step that triggered it either: local heuristics decide the first step, and the verdict can only refine a later unprepared step.
- **Fast mode costs an extra request.** One small LLM call per message (12+ characters) plus up to `classifierTimeoutMs` of wait, on top of the normal step. Leave it on **Local heuristics** if that is not worth the accuracy.
- **Escalation is naive.** Any tool result with `isError` counts, including failures that are not really a loop (a search with no matches, a deliberately failing command). A successful editing or shell call resets the counter.
- **Auto resolution depends on the default model.** If it exposes no reasoning efforts, the tiers collapse to the same route and the plugin does not switch. Configure explicit models for a meaningful split.
- **Switching models can invalidate the provider's prompt cache**, so a switch can cost more tokens on the next request. That is the price of routing; a cheaper Light tier usually still wins over a long session.
- **It observes every live agent in the profile while enabled.** Only messages whose source kind is `user` are classified; messages injected by other plugins are skipped. There is no per-session policy yet.

## Architecture

| File | Role |
| --- | --- |
| [index.js](index.js) | Host half: registers the exact Fetch routes `/api/model-autopilot/state` and `/api/model-autopilot/settings`, listens to `agent/inbox/inserted`, tracks failures, derives and validates tier targets from the deployment default model, calls `agent.model.select()`, and persists config through `configEditor`. |
| [classifier.js](classifier.js) | Pure scoring and no I/O: the local heuristic, the fast-mode prompt and the verdict parser. |
| [client.js](client.js) | Client half loaded through `window.__ModuleLoader__`: the `sidebar.panellist` panel with the effective-route lines and classifier controls, its styles and the en/ru dictionaries. |
| [cordis.patch.yml](cordis.patch.yml) | Bundle patch that inserts the `model-autopilot` row, disabled by default. |
| [locale/en.json](locale/en.json), [locale/ru.json](locale/ru.json) | Panel title and description for the catalog and the UI. |
| [verify.mjs](verify.mjs) | Offline functional self-test of the classifier, both halves and the settings contract. |
| [package.json](package.json) | Package metadata, `dsh.bundle.patch`, `engines.node >= 20`, client entry and exports. |

No build step and no runtime dependencies: plain ESM loaded by DSH. After changing anything, run the offline check:

```bash
node verify.mjs .
```

## License

MIT — see [LICENSE](LICENSE). Copyright (c) 2026 Denis Plokhikh.
