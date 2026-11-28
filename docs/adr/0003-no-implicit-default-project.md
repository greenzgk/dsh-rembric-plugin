# No implicit `default` project

Outside a git repository a session gets memory only when the user explicitly
named a project: a `.rembric` file in the session's own directory, or
`REMBRIC_PROJECT_SLUG` — with `.rembric` winning. With neither, the session
resolves to mode `no_project` and memory stays off: no tools registered, no
server requests, and a notice in the first reply explains why and how to opt in.
The `default` project is never chosen implicitly; the supported way to use it is
a `.rembric` file naming `PROJECT_SLUG=default`. Inside git the existing binding
flow is unchanged, except that a failed git probe with a `.git` marker in an
ancestor directory is reported as `git_unavailable` rather than mistaken for
"not a repository". We chose to fail closed because the silent fallback mixed
notes from unrelated workspaces into one shared project, discoverable only by
inspecting the data afterward — the same trade ADR 0002 made against config
pinning, extended to the outside-git case.

## Considered Options

- **Keep the silent fallback to `default` outside git** — the status quo ante:
  every plain directory wrote into one shared project, and the user found out
  only by looking at the data.
- **Walk parent directories for `.rembric` outside git** — re-creates an implicit
  choice from further away; a stray `.rembric` higher up the tree would capture
  unrelated workspaces, which is exactly what this decision removes.
- **Fall through to `default` when `REMBRIC_PROJECT_SLUG` is invalid** — a typo
  in the environment would silently redirect notes into a project the user never
  named; an invalid value counts as no choice.
- **Pin a project in plugin config** — rejected in ADR 0002: config outranked
  every local signal and masked the user's explicit choice.
- **Keep discovery and the token check on bare `/mcp`** — the server treats that
  endpoint as `default`, so a token valid for its own project but without
  `default` access looked broken; discovery and the check now follow the
  session's own project endpoint.

## Consequences

- Reversing this changes where writes land again: users who opted into per-
  directory projects would start writing into `default` without being asked, and
  notes already written to their chosen projects cannot be merged back
  automatically. That is why the removal of the fallback is effectively permanent.
- `unbound` (inside git, no binding) and `refused` (credentials or server
  failure) keep their meanings; `default` stops being produced as a resolution
  outcome at all — only as an explicit `.rembric` choice.
- Off sessions are inert, not merely quiet: no tool registration and no network
  requests whatsoever.
- The off notice reaches the assistant through the system prompt (the harness has
  no user-visible message channel for plugins) and ends with a standing rule:
  never create or edit a `.rembric` file unless the user explicitly asks, and ask
  them for the project slug first.
- `/rembric-status` reports the off mode and its reason instead of "not resolved
  for this session".
- The connection check validates authentication only: an authentication rejection
  means the token is invalid; a project-access rejection means accepted with no
  `default` access.
- Existing memories in `default` are left untouched — turning off the fallback
  cannot lose data.
