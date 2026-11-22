# Rembric Memory Plugin

Persistent long-term memory shared across DeepSeek Harness agents, backed by a
Rembric server. The shared vocabulary for specs, tickets, and ADRs about this
plugin.

## Language

**Dotted name**:
The canonical Rembric tool name as the server knows it — `memory.save`,
`memory.session_start`. The plugin uses it in direct calls to the server; the
model never sees it.
_Avoid_: Server name, MCP name

**Underscored name**:
The provider-safe callable name the model sees and references — `memory_save`,
`memory_session_start` — derived from the dotted name by replacing the dot with
an underscore.
_Avoid_: Safe name, short name

**Rewrite** (`renameToolsInDescriptions`, `underscoreToolNames`):
The dotted → underscored transformation applied to human-readable text before
it reaches the model: tool descriptions, the crib-sheet, nudges, and string
`description` values inside input schemas. Inside a schema only string values
under a `description` key are rewritten; non-string content — like the
`description` parameter of `memory_session_start` — is never coerced, though
the walk continues inside it and rewrites nested string descriptions.
_Avoid_: Rename

**Tool definition**:
A single Rembric tool as discovered from the server: its name, description,
and input schema. The unit of registration.
_Avoid_: Tool spec, function schema

**Registration**:
Adding a discovered tool to an agent under its underscored name so the model
can call it. Distinct from session registration, which opens a Rembric
session.
_Avoid_: Binding, mounting

**Crib-sheet**:
The usage instructions the Rembric server returns when the plugin connects,
telling the agent when to recall, what to save, and how to summarize.
_Avoid_: Instructions, usage guide

**Host module**:
The plugin's DSH-facing side: it discovers the tool set, registers tools with
agents, and wires prompts, nudges, and the capture lifecycle to the session
core.
_Avoid_: Adapter, bridge

**Session core**:
The plugin's capture side: owns each session's lifecycle from session
registration through turn close and summary flush.
_Avoid_: Capture engine, core service

**Session**:
The Rembric capture unit for one DSH conversation, stable across resume.
Subagent children never own a session.
_Avoid_: Thread, dialogue

**Capture**:
The flow of prompts, assistant messages, turn reports, and summaries from the
plugin to the server; the server stays the source of truth.
_Avoid_: Logging, sync

**Nudge**:
A synthetic message injected into the agent's conversation to steer it: recall
hints, session-id reminders, post-compaction recovery.
_Avoid_: System message

**Credential reference**:
The named slot `REMBRIC_API_TOKEN` in DSH's credential store; the plugin's only
source for its token, resolved through `ctx.credentials` with the ambient
environment as a fallback.
_Avoid_: API key setting, token record

**Token source**:
Where the token came from on the last resolution — `store`, `env`, `none`, or
`request` (carried in the verify request itself and persisted to the store on
success, after which the effective source is `store`); `/rembric-status`
reports the first three so a missing GUI setup is distinguishable from a
stale shell export.
_Avoid_: Origin, provider

**Connection check**:
The single probe that asks the Rembric server to accept the token and list its
tools; the settings card and `/rembric-login` share it. `/rembric-status` does
not probe — it reports the cached session state captured at setup.
_Avoid_: Handshake, ping

**Settings card**:
The plugin's own block on the DSH settings page; it persists the server URL to
config, while its token field writes only to the credential reference — never
to config, because anything persisted to config is readable by every browser
that can open that page.
_Avoid_: Config form, preferences

**Project slug**:
The Rembric project a session belongs to, resolved per session from the working
directory (`.rembric`, then `REMBRIC_PROJECT_SLUG`, then the server's repository
binding). Never pinned by plugin config.
_Avoid_: Project id, namespace
