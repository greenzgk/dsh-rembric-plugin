# Rembric Memory — DSH plugin

Persistent, shared long-term memory for every DeepSeek Harness agent, backed by a
[Rembric](https://github.com/susomejias/rembric) server. This is a DSH-native
port of the upstream Rembric Pi plugin: same server, same tool set, same
project-resolution rules, adapted to how DSH bundles and services work.

## What it does

- **Discovers the whole Rembric tool set once** from the server's MCP endpoint and
  registers every tool on each agent under a provider-safe underscored name
  (`memory.save` → `memory_save`, `project.current` → `project_current`, …). The
  tool descriptions and every `description` field inside each input schema are
  rewritten so the model only ever sees the underscored names.
- **Forwards the server's usage crib-sheet** (the instructions Rembric returns at
  MCP `initialize`) into the system prompt, so the agent knows when to recall,
  what to save, and how to summarize — without you writing any of that.
- **Picks the project per session** from the working directory, exactly like the Pi
  client: a `.rembric` file (walked up to the repo root) wins, then the
  `REMBRIC_PROJECT_SLUG` env / `projectSlug` config, then — inside a git repo —
  the admin-bound repository binding. It never silently falls back to the `default`
  project inside a git repo.
- **Captures every session** to the server: prompts, assistant messages, turn
  reports, and summaries (see below). The plugin holds no business logic of its
  own; the server is the source of truth.
- **Injects recall nudges** before the agent's next step, and answers the user
  directly through the `/recall` `/context` `/remember` `/summary` slash
  commands.
- **Passes every tool call through** to the server with the original dotted tool
  name. When a tool's schema declares a `sessionId` and the model omitted it, the
  DSH session id is injected automatically (only for registered sessions).

## Tools registered

All 26 Rembric MCP tools, underscored: `memory_save`, `memory_search`,
`memory_get_batch`, `memory_confirm_batch`, `memory_archive`, `memory_merge`,
`memory_session_start`, `memory_session_end`, `memory_session_summary`,
`memory_session_resume`, `memory_context`, `memory_session_get_batch`,
`memory_timeline`, `memory_capture_passive`, `memory_save_prompt`,
`memory_search_prompts`, `memory_doctor`, `memory_about`, `memory_stats`,
`project_list`, `project_current`, `project_bind_repository`, `project_create`,
`memory_suggest_topic_key`, `memory_judge_batch`, `memory_compare`.

## Session capture lifecycle

The DSH `agent.session.id` is the Rembric sessionId everywhere (stable across
resume). Subagent children never own a session: `setupAgent` skips agents whose
`session.header.origin === 'subagent'`.

1. **Register** — on the first human prompt (inbox message with
   `source.kind === 'user'`), the core POSTs `/api/{slug}/sessions`
   `{id, agent, cwd}` and then `/api/{slug}/sessions/{id}/resume`.
2. **Message feed** — user prompts are captured on inbox insert; assistant
   messages are captured from the durable `session/event` feed
   (`assistant/message`), and every `tool/call` event marks the session as
   tool-using.
3. **Entry limits** — each entry is truncated to 2000 chars; at most 200 entries
   per session (oldest evicted); the flushed transcript is capped at 19,500
   chars (the tail is kept); the title is derived from the first user message
   (≤100 chars).
4. **Turn close** (`agent/turn-stopping`) — POST
   `/api/{slug}/sessions/{id}/turn` `{usedTools, title?}`. Lines the server
   returns are cached and delivered with the **next** human prompt. Independently,
   `scheduleIdleFlush` debounces 500 ms (override: `REMBRIC_IDLE_DEBOUNCE_MS`)
   and POSTs `/api/{slug}/sessions/{id}/summary`.
5. **Dispose** — pending summaries are flushed fire-and-forget and local
   bookkeeping is cleared. `/end` is deliberately **never** called on dispose: a
   wrong end is unrecoverable, and the server retires idle sessions as
   `abandoned`.

## Nudges

Nudges are injected as synthetic user-role messages with
`source.kind: 'rembric'` via `agent.inject()`, so they never re-enter the
human-prompt capture path (feedback-loop guard). All nudge text is run through
the dotted→underscored tool-name rewrite.

- **First prompt of a session**: call `memory_context` with focus set to the
  prompt before responding.
- **Recall intent** — prompts matching
  `remember|recall|acuérdate|qué hicimos|what did we do`: call `memory_search`
  with the user's keywords.
- **Session-id nudge** — when write-directing content is pending, pass the exact
  `sessionId` explicitly to `memory_save` / `memory_session_summary` /
  `memory_save_prompt`; never guess a different one.
- **Session opening** — a newly created session is told to call
  `memory_session_summary` with a title and a single `## Goal` section.
- **Resumed read** — first prompt in a process that resumed an existing session:
  read `memory_session_get_batch({ids:[sessionId]})` in full before writing a
  summary.
- **Post-compaction** — restore state with a complete six-heading summary
  (`## Goal`, `## Accomplished`, `## Decisions+why`, `## Verified+how`,
  `## Unfinished+why`, `## Files`); sent sections replace stored ones, omitted
  ones stay.
- **Server turn lines** — any lines returned by `/turn` are delivered on the next
  human prompt, read-and-clear exactly once.

## File-linked recall

- Triggered by durable `session/event` `tool/call` events for file-touching
  tools: `read`, `write`, `edit`, `glob`, `grep`, `bash` (namespaced names like
  `builtin.read` match on the last segment).
- Candidate paths come from the tool's path arguments (`file_path`, `path`,
  `notebook_path`, `filePath`); shell tools go through `extractCommandPaths`
  (absolute paths or `dir/file.ext` tokens only). At most 5 candidates per call.
- A candidate must be a **tracked** file in the git repo
  (`git ls-files --error-unmatch` with literal pathspecs); same-name siblings
  across the repo (≤64) are attached.
- POST `/api/{slug}/sessions/{id}/file-recall` `{path, siblings?}` with a
  500 ms budget. Paths already recalled are skipped per session; the server can
  answer `exhausted: true` to stop further file recall for the session.
- Returned hint lines are injected as nudges for a later step — never awaited by
  the turn, so recall adds no turn latency.

## Subagent learnings

- On `subagent/end`, the child's final assistant message is stripped of
  `<private>` blocks and gated on the **"key learnings"** phrase (case
  insensitive). Matching reports are POSTed to the **parent** session's
  `/api/{slug}/sessions/{parentSessionId}/learnings` endpoint (2 s timeout).
- The parent core is resolved from the host's session index by
  `parentSessionId`. If the creator is itself a subagent child there is no
  host-owned core for it, and the report is skipped silently — the correct
  outcome, not an error.
- `agentType` is deliberately omitted: DSH's `subagent/end` carries no child
  kind field, and posting the LLM `provider` would mislabel the learning.

## Redaction

- `stripPrivateTags` replaces every `<private>…</private>` block — and an
  unclosed `<private>` through end of text — with `[REDACTED]` **before** any
  text leaves the process: prompts, transcript entries, recall prompts, and
  learnings reports.
  The client cuts first: what never leaves the process cannot leak.
- Recall-hint prompts are additionally truncated to 500 chars client-side before
  being sent.
- The API token is only ever sent as the `Bearer` Authorization header; it is
  never logged or placed in a request body.

## Configuration

Set in the bundle's `cordis.patch.yml` row (editable after install):

- `serverUrl` — Rembric base URL. Falls back to `REMBRIC_SERVER_URL`, then
  `http://127.0.0.1:8790`.
- `projectSlug` — default project for sessions whose working directory has no
  `.rembric` file. Behaves like `REMBRIC_PROJECT_SLUG` (lower precedence than a
  `.rembric` file). Remove it to force per-directory resolution everywhere.

## Token

The API token is **not** stored in config. The plugin reads it from:

1. The DSH **`rembric/token` credential** (preferred — survives across processes).
2. The `REMBRIC_API_TOKEN` environment variable (fallback — only works if the
   process that launches DSH has it exported).

The DSH GUI launched from the desktop does **not** inherit your shell's
`REMBRIC_API_TOKEN`, so put the token in the `rembric/token` credential.

## Project resolution rules

| Situation                                                                      | Result                                                                                                                         |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `.rembric` file with `PROJECT_SLUG=…` in the tree (walked up to the repo root) | that project                                                                                                                   |
| `REMBRIC_PROJECT_SLUG` / `projectSlug` set                                     | that project (an explicit slug wins; a mismatch with the repo binding is reported as a conflict but the explicit slug is used) |
| Inside a git repo, repo bound to a project                                     | the bound project                                                                                                              |
| Inside a git repo, repo not bound                                              | **off** for the session: one warning line, the Rembric tools are not registered                                                |
| Not in git, no slug                                                            | the `default` project                                                                                                          |
| No token at all                                                                | plugin stays off, one warning line                                                                                             |

## Status

Fully implemented: tool registration + crib-sheet + project resolution + MCP
client + session capture + nudges + slash commands + file-linked recall +
subagent-learnings capture + redaction.
