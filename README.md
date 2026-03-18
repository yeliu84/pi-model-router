# pi-model-router

Extension-first model router for pi.

Current status: working development preview.

## What it does

- registers a logical custom provider: `router`
- exposes logical models like `router/auto`
- chooses `high` / `medium` / `low` per turn using heuristics
- delegates the real request to an underlying configured model via `@mariozechner/pi-ai`
- persists router state in session entries
- surfaces router state through commands and footer status
- supports explicit router activation/deactivation and tier pinning commands

## Install locally for development

From this project directory:

```bash
pi install .
```

Or load directly for one run:

```bash
pi -e ./extensions/index.ts
```

## Configure profiles

Copy the example config to one of:

- `~/.pi/agent/model-router.json`
- `.pi/model-router.json`

Example:

```bash
cp model-router.example.json ~/.pi/agent/model-router.json
```

Config shape:

```json
{
  "defaultProfile": "auto",
  "debug": false,
  "profiles": {
    "auto": {
      "high": { "model": "openai/gpt-5.4-pro", "thinking": "high" },
      "medium": { "model": "google/gemini-flash-latest", "thinking": "medium" },
      "low": { "model": "openai/gpt-5.4-nano", "thinking": "low" }
    }
  }
}
```

The extension validates config on load and falls back to built-in defaults when a profile or tier is invalid.

## Usage

After loading the extension:

```text
/model router/auto
/router
/router-profile auto
/router-on
/router-pin high
/router-pin cheap low
/router-pin auto
/router-off
/router-reload
/router-debug
```

`/router-on` switches to the selected or default router profile.
`/router-pin high|medium|low` forces that tier for future routed turns on the current profile.
`/router-pin <profile> <high|medium|low|auto>` lets you change another profile without switching to it first.
`/router-pin auto` clears the current profile pin and restores heuristic routing.
`/router-off` switches back to the last concrete non-router model.

Pins are remembered per profile, so `router/auto` and `router/cheap` can keep different pinned tiers.

If `router/auto` does not appear in `/model`, run `/router-reload` after adding config.

## Status behavior

When the active model is a router profile, the extension status shows the effective routed target, and a widget shows the current profile, pin, and last routed target.

```text
router:auto -> high -> openai/gpt-5
router:auto [pin:high] -> high -> openai/gpt-5
```

When router is not active, status shows the selected profile, that profile's active pin if any, and the last non-router fallback model.

## Notes

- This is a provider-based router, not repeated invisible `setModel()` switching per turn.
- The selected model remains `router/<profile>` while the extension chooses the effective model behind the scenes.
- The built-in footer still shows the logical router model; the extension status shows the effective routed tier/model.
- State is restored from session history on resume, fork, and session switch.
- `/router-debug` now shows recent routing decisions and can be controlled with `on`, `off`, `toggle`, and `clear`.
