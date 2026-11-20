# dsh-rembric-plugin — Phase 2/3 integration spec

Goal: port the upstream Rembric Pi plugin's session-capture + recall + learnings
behavior (see /tmp/core.mjs, the upstream `rembric-plugin-core.mjs`) into the DSH
bundle. The MVP (tools + crib-sheet + project resolve) is DONE and installed.

## Existing files (do not break)
- `host.js` — `apply(ctx, config)`. Registers 26 MCP tools per agent + crib-sheet.
  `withHostSessionId(params)` at host.js:54 is a NO-OP stub to be replaced.
  `agentStates` Map keyed by agent -> { fiber, client, slug, mode }.
  `setupAgent` skips subagent children (`agent.session.header.origin === 'subagent'`).
- `mcp-client.js` — `createMcpClient(endpoint, token, fingerprintHeader)`.
  Methods: `initialize(signal)`, `listTools(signal)`, `callTool(name, args, signal)`,
  `instructions()`. NOTE: this is the MCP JSON-RPC client. The session-capture
  REST endpoints (below) are NOT MCP — they need a separate plain-fetch helper.
- `project.js` — `resolveProject`, `buildEndpoint`.

## DSH lifecycle -> core.mjs mapping (LEAD DECISIONS)
DSH session id = `agent.session.id` (stable across resume). Use it as the Rembric
sessionId everywhere.

| core.mjs concept | DSH hook | notes |
|---|---|---|
| register session (ensureSession) | first user prompt of the agent | POST /sessions {id, agent, cwd}; then POST /resume |
| appendUserMessage | user message enters agent | strip <private>, truncate 2000 |
| appendAssistantMessage | assistant message produced | strip <private>, truncate 2000 |
| reportTurn (returns nudge lines) | turn about to stop | POST /turn {usedTools, title?}; cache lines for NEXT turn |
| scheduleIdleFlush | after turn stop | debounce 500ms -> POST /summary |
| endSession | session truly closing | POST /end {summary, final:false} |
| markToolUsed | any rembric tool executed | set flag for next /turn body |
| recallHints | user prompt looks like recall | POST /recall-hints {prompt} -> lines |
| fileRecall | tool touches a file path | POST /file-recall {path, siblings?} -> lines |
| postSubagentReport | subagent report has "Key Learnings" | POST /learnings {report, agentType?} |

DSH events available (verify exact payload from asar before wiring):
- `agent/created` {agent, source:'startup'|'resume'|'clear'|'compact', signal}
- `agent/inbox/inserted` — user message enters (capture user prompt here)
- `agent/turn-stopping` {agent, turn, signal} — turn about to close
- `agent/disposed` {agent} — runtime gone (NOT necessarily session end)
- `tools/pre-execute` / `tools/post-execute` — tool interception (markToolUsed, fileRecall)
- `subagent/end` — subagent finished (learnings)

DSH has NO direct "session closed by user" event like Pi's session_shutdown.
Decision: treat `agent/disposed` as the flush point (fire-and-forget summary),
NOT a hard end. Do NOT call /end on dispose (wrong-end is unrecoverable; the
server retires idle sessions as 'abandoned'). Only call /end if a real
session-close signal exists.

## Nudge delivery (Phase 2)
core.mjs nudges are injected as a hidden custom message before the agent acts.
In DSH, deliver pending nudge lines via `agent.inject(msg)` (logs to inbox,
enters next admitted step) at the start of the next turn. Keep the exact nudge
strings from core.mjs (byte-identical across clients), only run them through
`underscoreToolNames`.

## session-core.js contract (the delegated port)
Create `session-core.js` exporting `createSessionCore({ agent, baseUrl, apiToken, slug, cwd, post })`.
- `post(path, body, timeoutMs)` is INJECTED (plain fetch wrapper with Bearer auth).
  The core must NOT import DSH or mcp-client. Pure logic + injected transport.
- Faithfully port from /tmp/core.mjs: ensureSession, nudgesForTurn, markToolUsed,
  beginTurn, reportTurn, recallHints, fileRecall, postSubagentReport,
  appendUserMessage, appendAssistantMessage, upsertAssistantMessage,
  flushSessionSummary, endSession, scheduleIdleFlush, flushAllFireAndForget,
  forgetSession, isSubAgent, markSubAgent, isKnown, isRegistered.
- Keep ALL constants (MAX_ENTRY_CHARS=2000, MAX_TRANSCRIPT_CHARS=19500,
  MAX_ENTRIES_PER_SESSION=200, MAX_TITLE_CHARS=100, COMMAND_PATHS_MAX=5,
  FILE_RECALL_SIBLINGS_MAX=64, RECALL_PROMPT_MAX_CHARS=500, timeouts).
- Keep `stripPrivateTags` (<private>...</private> -> [REDACTED], unclosed -> end).
- Keep `extractCommandPaths`, `trackedRepoPath`, `sameNameSiblings` (git helpers).
- Keep the exact nudge text constants (FIRST_PROMPT_NUDGE, RECALL_NUDGE,
  SESSION_ID_NUDGE_TEMPLATE, RESUMED_READ_NUDGE, SESSION_OPENING_NUDGE,
  POST_COMPACT_NUDGE_CORE) and RECALL_REGEX, KEY_LEARNINGS_PHRASE.
- The core returns the SAME object shape as core.mjs (line 508-532).

## Phase 3 slash commands (commands.js)
4 DSH CommandDefinitions: context, recall, remember, summary.
Fetch the exact markdown from the rembric repo:
apps/plugin/commands/{context,recall,remember,summary}.md
Each handler calls the agent's MCP client (via a getter passed in) and returns
{kind:'success', text}. `remember` uses recordInput:false is NOT needed (it's a
user-facing save). Wire via ctx.commands.register.

## Verification
- `node --check` every JS file.
- Reinstall via plugin_manager install_bundle (absolute dir).
- Smoke: new session -> tools present, session registered (check server), nudge
  appears, /context works.
