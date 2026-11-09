<div align="right"><img src="icon.svg" width="88" alt="Model Autopilot icon"></div>

# Model Autopilot — a DSH plugin

**One panel in the left sidebar, and every agent step runs on the model that fits it: a cheap model for ordinary turns, a strong coder model for real work, the heavy model only when the agent is stuck.**

`DSH 0.2.x` · `MIT` · `no build step` · `no dependencies` · `no telemetry`

[Русская версия](README.ru.md)

---

## Why

A coding agent usually runs one model for the whole session. That is either wasteful or
underpowered:

- a **small model** is fine for “open the file”, “run the tests”, “answer this” — and 90% of steps
  are exactly that;
- a **big model** is worth its price only on the steps that matter: architecture, a tricky fix,
  a refactor, an implementation from scratch;
- when the agent is **looping on errors**, the useful move is to bring in the biggest model it has.

Model Autopilot does that switch by itself, before the step starts, and shows you the decisions.

| Tier | When it is picked | Typical choice |
| --- | --- | --- |
| **fast** | every new user message, unless something below applies | small, cheap, fast |
| **coder** | the message looks like real work: architecture, refactoring, a fix, a rewrite, optimization, an implementation | a strong coding model |
| **heavy** | a configurable number of consecutive failing tool results in the session | the largest model you have |

You choose the provider and model for each tier in the panel. Nothing is hardcoded, and the plugin
is **off until you enable it**.

## Screenshot

<!--docs/screenshot.png-->

The panel lives in the left sidebar under **Autopilot**: enable switch, three tier pickers fed from
your configured providers, the failure threshold, and the log of the last decisions.

## Requirements

- DSH Desktop or DSH Web with a profile — 0.2.x (built and tested against `0.2.2-rc.1`).
- At least one provider configured in **Settings → Models**. Tiers are picked from the models your
  providers advertise.

## Install

### A. From a plugin catalog (Discover)

DSH can read plugin catalogs — JSON indexes a user adds by URL. This repository ships one:
`index.json`.

1. Enable the optional bundle `@deepseek-ai/dsh-experimental-plugin-market-bundle` in
   **Settings → Plugins** (it ships with DSH, off by default) and open the **Discover** tab.
2. Add this index URL in the catalog settings:

   ```
   https://raw.githubusercontent.com/Denisplokhikh/dsh-model-autopilot/main/index.json
   ```

3. Search for **Autopilot** and install it. The index entry is pinned to a commit, so what you get is
   exactly the tagged code.

### B. From a clone

```bash
git clone https://github.com/Denisplokhikh/dsh-model-autopilot.git
```

Then ask your DSH agent:

> Install the DSH plugin bundle from `C:\path\to\dsh-model-autopilot`

The agent installs it with `plugin_manager` (`install_bundle`, an absolute directory). The sidebar
entry appears after the Web client reloads.

### C. npm

Not published yet. If you want it on npm, open an issue — the package metadata is ready.

## First run

1. Click **Autopilot** in the left sidebar.
2. Pick a provider and model for each tier you want to use. An empty tier is skipped; the plugin
   falls back to the first configured tier, so configuring **fast** alone is a valid start.
3. Set **Tool failures before switching to heavy** (default `2`).
4. Press **Save**, then **Enable**.

Routing applies from the next step. The switch itself is recorded in the session as a normal model
change, so the timeline stays readable.

## How the routing works

```
user message ──▶ classify text ──▶ pick tier ──▶ agent.model.select() ──▶ next step
                     ▲                                  │
tool results ──▶ consecutive failures ──▶ heavy ────────┘
```

- **Classification** reads the text of the just-inserted message and matches a keyword heuristic in
  English and Russian. A match selects `coder`, otherwise `fast`.
- **Failure escalation** counts consecutive tool results with `isError: true` per session. On the
  threshold it selects `heavy` immediately, and new messages keep `heavy` until the counter resets.
- **Reset**: a successful mutating tool call (`edit`, `write`, `apply_patch`, `edit_file`,
  `write_file`, `apply_diff`, `bash`, `run_command`, `terminal`, `run_code`) clears the counter.
- The selection is a **no-op** when the agent already runs the target model, so a long session does
  not churn model changes without reason.

### Configuration

The panel writes through the profile config editor, so the row in the profile’s Cordis patch ends up
like this:

```yaml
- insert:
    - id: model-autopilot
      name: dsh-model-autopilot
      config:
        enabled: true
        escalateAfterErrors: 2
        tiers:
          fast:
            provider: deepseek
            model: deepseek-chat
          coder:
            provider: deepseek
            model: deepseek-reasoner
          heavy:
            provider: ''
            model: ''
```

| Field | Meaning |
| --- | --- |
| `enabled` | master switch; `false` means the plugin watches nothing |
| `escalateAfterErrors` | consecutive failures before `heavy`; `0` disables escalation |
| `tiers.*.provider` / `tiers.*.model` | provider id and model id from your Models settings; both empty = tier skipped |

## Data and privacy

The panel talks to the Host half over an authenticated same-origin route
(`/api/model-autopilot/state`, `/api/model-autopilot/settings`). No conversation text, no prompts and
no provider credentials leave the machine; the plugin has no network code of its own.

## Honest limitations

This is a small, deliberately simple plugin. What it is **not**:

- **The classifier is a keyword heuristic.** Russian and English only, no model call, no session
  context. “Fix the typo” is classified like “fix the failing test”. Unusual phrasings fall back to
  `fast`.
- **Switching models mid-session can invalidate the provider’s prompt cache**, which costs tokens
  on the next request. That is the price of routing; keep the number of switches low by making the
  `fast` tier close in price to `coder`.
- **Escalation is naive**: any failing tool result counts, including a `grep` with no matches.
- **It affects every session in the profile**, subagent sessions included, while it is enabled.
- **Heavy is a dead end by design** — it does not de-escalate on its own; the counter reset on a
  successful edit or command does that.
- **No per-session policy yet** (work in progress).

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| “No models are advertised by the registered providers” | no provider configured yet: **Settings → Models** |
| Panel saves but the model never changes | every tier is empty, or the plugin is disabled |
| The sidebar entry is missing | the bundle is installed but the Web client was not reloaded |
| It keeps choosing `fast` for complex prompts | the request wording does not match the heuristic; put a shared model in `fast` and `coder` for now |

## Development

No build, no bundler, no dependencies — two ESM files:

| File | Role |
| --- | --- |
| `index.js` | Host half: events, routing, the two authenticated routes, config writes |
| `client.js` | Web client half: `sidebar.panellist` icon, the panel, the locale, the styles |
| `cordis.patch.yml` | the bundle patch that inserts the row, disabled by default |
| `locale/*.json` | panel title and description for the catalog, en and ru |
| `verify.mjs` | offline functional test of both halves (mocked `ctx`, no browser) |

```bash
npm test        # or: node verify.mjs
```

`verify.mjs` boots the Host half with a stub context and asserts routing, persistence, both Fetch
routes, the client registration, the locales and one panel render.

## License

MIT © 2026 Denisplokhikh
