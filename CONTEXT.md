# CONTEXT

Domain glossary for this repo. Specs, tickets, ADRs, and test names should use
these terms as defined here. The plugin is two modules: the **host module**
(`host.js`), the DSH-facing boundary that discovers tools, registers them, and
wires prompts and nudges, and the **session core** (defined below, in
`session-core.js`). `docs/DETAIL.md` describes the whole plugin.

## Naming

- **Dotted name** — the Rembric server's MCP tool name, with a dot between the
  namespace and the tool: `memory.save`, `project.current`,
  `memory.session_start`. Valid only on the server side; no DSH agent can call
  it.
- **Underscored name** — the provider-safe callable name derived from a dotted
  name by replacing the dot with an underscore: `memory_save`,
  `project_current`, `memory_session_start`. The only tool name a model ever
  sees in DSH.

## Rewrite

- **Rewrite** — the dotted → underscored transformation applied to
  human-readable text before it reaches the model, so the model never
  references a non-existent tool name. Applied to tool descriptions, string
  `description` values inside input schemas, the crib-sheet, and nudge text.
  Targets dotted names in the `memory` and `project` namespaces only.
- **Description rewriter** (`renameToolsInDescriptions`, `host.js`) — the
  recursive walker over a tool's input-schema tree that applies the rewrite to
  _string_ values under a `description` key. Every non-string value passes
  through untouched — including the JSON-Schema object of the parameter
  literally named `description` on `memory.session_start`. The type guard
  exists because the old blind stringify coerced that object to the string
  `"[object Object]"`, which strict providers (DeepSeek) reject (spec #2).
- **`underscoreToolNames`** (`session-core.js`) — the single implementation of
  the string-level rewrite; the host module re-exports it rather than keeping
  a second copy.

## Tool lifecycle

- **Tool definition** — one Rembric MCP tool as discovered from the server:
  its name, description, and input schema. The unit the plugin registers.
- **Registration** — adding a discovered tool definition to an agent under its
  underscored name so the model can call it. Distinct from **session
  registration**, the POST that opens a Rembric session (see below).
- **Crib-sheet** — the usage instructions the Rembric server returns at MCP
  `initialize`; forwarded (rewritten) into the system prompt so the agent
  knows when to recall, what to save, and how to summarize.

## Session and capture

- **Session core** (`session-core.js`) — the component that owns the
  per-session capture lifecycle: session registration, the message feed, turn
  close, and summary flush. It performs no direct HTTP; the transport is
  injected by the host module.
- **Session** — the Rembric capture unit for one DSH conversation. The DSH
  `agent.session.id` is the Rembric `sessionId`, stable across resume.
  Subagent children never own a session.
- **Capture** — the flow of prompts, assistant messages, turn reports, and
  summaries from the plugin to the server. The plugin holds no business logic
  of its own; the server is the source of truth.
- **Nudge** — a synthetic user-role message (`source.kind: 'rembric'`)
  injected to steer the agent: recall hints, session-id reminders,
  post-compaction recovery. Nudge text goes through the rewrite.
- **Project slug** — the Rembric project a session belongs to, resolved per
  session from the working directory: a `.rembric` file wins, then
  `REMBRIC_PROJECT_SLUG` / `projectSlug` config, then the git repository
  binding.
