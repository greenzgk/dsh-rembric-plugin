# Project selection stays per session

The plugin config has no `projectSlug`. A session's Rembric project is resolved
from its working directory: a `.rembric` file, then `REMBRIC_PROJECT_SLUG`, then
the server-side repository binding. Config cannot pin a project.

## Considered Options

- **Keep `projectSlug` in config** — it was injected into the environment before
  resolution, so it outranked both `.rembric` and the repository binding. Every
  session started outside a `.rembric` directory was silently attached to the
  configured project, which is the opposite of one project per workspace.
- **Keep it as the last fallback** — a wider fallback than the server's binding,
  so it would still mask the user's explicit choice for sessions that cannot
  resolve a directory-level project.

## Consequences

A project is never shared between workspaces by accident. Setting one up now
means a `.rembric` file, an environment variable, or binding the repository on
the server.
