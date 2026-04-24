# WebUI TUI Bridge Overlay

This is an optional WebUI-only overlay. It does not modify Hermes agent files.

Enable with:

```bash
export HERMES_WEBUI_BRIDGE=1
export HERMES_TUI_ROOT=/home/xl/.hermes/hermes-publish.HkvvHk
export HERMES_PYTHON=/home/xl/.hermes/hermes-agent/venv/bin/python
```

When enabled, new `/v1/runs` requests with a `session_id` are handled by a child
`python -m tui_gateway.entry` bridge process. The bridge receives Hermes TUI
`approval.request` events and WebUI approval buttons call `approval.respond`, so
buttons do not send `/approve` or `/deny` as chat text.

Existing historical WebUI sessions remain readable. A new turn in an old WebUI
session can be routed through the bridge, but an already-blocked old run cannot
be adopted because its approval queue lives inside the original Hermes API server
process and is not exposed by `/v1/runs`.

To keep this overlay after upstream updates, preserve these WebUI files:

- `packages/server/src/services/hermes/tui-bridge.ts`
- the small bridge hooks in `packages/server/src/routes/hermes/proxy-handler.ts`
- the bridge-first branch in `packages/server/src/services/hermes/approval.ts`
- the response shape passthrough in `packages/server/src/controllers/hermes/approval.ts`
