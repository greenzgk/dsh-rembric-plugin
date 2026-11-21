# Token as a credential reference

The plugin's Rembric token is stored in DSH's credential store under the
reference `REMBRIC_API_TOKEN` and read through `ctx.credentials.resolve`, with
the ambient environment as a fallback. The token never enters plugin config and
is never written back into the environment.

## Considered Options

- **Credentials record `rembric/token`** — the previous path. No GUI writes it
  and no code path creates it, so in practice it was always empty.
- **A `Config` field** — a config value is readable by any browser that can
  reach the settings page; the plugin's own routes carry no per-user auth, so
  the token would leak to whoever holds the GUI session.
- **Environment only** — requires `export REMBRIC_API_TOKEN` in the shell that
  launches DSH, which the GUI does not inherit.

## Consequences

`/rembric-status` reports the resolved source (`store`, `env`, `none`) instead
of assuming a token exists. An empty stored value is absent everywhere, so
unsetting the reference falls back to the environment rather than to silence.
