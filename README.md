# dsh-rembric-plugin

Persistent shared memory for your DeepSeek Harness agent, backed by a
[Rembric](https://github.com/susomejias/rembric) server. A DSH-native port of
the upstream Rembric Pi plugin.

The plugin discovers the full Rembric MCP tool set, registers it on every agent
under underscored names (`memory_save`, `memory_search`, `memory_context`, …),
adds the server's usage crib-sheet to the system prompt, captures every session
to the server, injects recall nudges, and resolves the active project from the
working directory.

## What you get

- **26 memory tools** on every agent, forwarded to the Rembric server:
  `memory_save`, `memory_search`, `memory_get_batch`, `memory_confirm_batch`,
  `memory_archive`, `memory_merge`, `memory_session_start`, `memory_session_end`,
  `memory_session_summary`, `memory_session_resume`, `memory_context`,
  `memory_session_get_batch`, `memory_timeline`, `memory_capture_passive`,
  `memory_save_prompt`, `memory_search_prompts`, `memory_doctor`, `memory_about`,
  `memory_stats`, `project_list`, `project_current`, `project_bind_repository`,
  `project_create`, `memory_suggest_topic_key`, `memory_judge_batch`,
  `memory_compare`.
- **Automatic session capture** — user/assistant messages, turn reports, and
  idle-flushed summaries, with `<private>` blocks redacted before anything
  leaves the process.
- **Recall nudges** — first-prompt, recall-intent, file-linked recall hints,
  and post-compaction recovery, injected before the agent's next step.
- **Subagent learnings** — a finished child's report containing "key learnings"
  is posted to the parent session.
- **Slash commands**:
  - `/recall <query>` — search long-term memory.
  - `/context` — recent sessions, memories, and the review queue.
  - `/remember <text>` — save the text as a reference memory.
  - `/summary` — flush the current session summary now.
  - `/rembric-login <token>` — save the API token to DSH's credential store
    and verify it against the server.
  - `/rembric-status` — show the token source, effective server, resolved
    project, plugin mode, and tool count.

## Requirements

- A running Rembric server (default `http://127.0.0.1:8790`).
- An API token. Set it from the chat with `/rembric-login <token>` — it lands in
  DSH's credential store under `REMBRIC_API_TOKEN` and is never shown again.
  Exporting `REMBRIC_API_TOKEN` works as an ambient fallback; the store wins
  when both exist.
- A Rembric project to write to. Create one with `project_create` or the Rembric
  UI, then point the plugin at it via a `.rembric` file, the
  `REMBRIC_PROJECT_SLUG` env var, or a git repository binding.

## Install

Use the DSH plugin manager: `install_bundle` with the absolute path of this
directory (or a packed `.tgz`), e.g. target
`/Users/greenzgk/Documents/deepseek-harness/default-workspace/dsh-rembric-plugin`.
The bundle inserts its own Host row via `cordis.patch.yml`.

## Configure

Edit the `rembric` row in the profile's `cordis.patch.yml`:

```yaml
- insert:
    - id: rembric
      name: "dsh-rembric-plugin"
      config:
        serverUrl: "http://127.0.0.1:8790" # or REMBRIC_SERVER_URL
```

`serverUrl` is the only live config field. The token and the project slug are
deliberately not config — the token lives in the credential store, and the
project is resolved per session from the working directory.

## Token

Set the token from the chat: `/rembric-login <token>`. It is saved to DSH's
credential store under `REMBRIC_API_TOKEN` and verified against the server
before the command reports success. The token is never echoed back and never
written to the environment.

An exported `REMBRIC_API_TOKEN` works as an ambient fallback, but the stored
credential wins when both exist. The desktop GUI does not inherit your shell
environment, so in the GUI use `/rembric-login` rather than relying on the
export. `/rembric-status` reports where the token is coming from.

See `docs/DETAIL.md` for the full behavior reference.
