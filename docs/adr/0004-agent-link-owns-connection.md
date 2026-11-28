# The Agent link owns the connection; the Host module owns DSH resources

The per-agent connection — project and token resolution, discovery, the client,
the session core, and the agent/session indexes — moves out of the Host module
into a deep module, the Agent link, which answers `link(agent)` with
`Connected | Off | Refused` (a project without a token is `Refused` with reason
`no_token`, not a fourth state) and serves `unlink`, `relink`, `forAgent`,
`forSession` and `call`. What only exists inside a DSH context stays in the Host
module: the inject fiber that carries tool registrations and the
`context:rembric` prompt section, tool-definition building, and event wiring. The
Host hands the link two callbacks, `attach(agent, outcome)` and
`detach(agent)`, so commands learn one interface instead of the twelve-key state
record. The split follows what each side can own: the link is state and network
and has no DSH dependency, while the fiber is a runtime resource whose lifecycle
DSH dictates.

## Considered Options

- **The module injects itself (`register(agent)`, `notice(agent)`)** — it would
  have to build tool definitions and decide what to register, widening its
  interface and coupling it to DSH registration rules; the depth gained by
  owning the connection would be spent again.
- **Both stay in the Host, commands get `relink`** — commands would know two
  interfaces for one concept, and the state record would keep leaking into five
  handlers.
- **Keep the flat state record, add `no_token` as a field combination** — every
  consumer keeps re-learning the off shape, and an impossible combination
  (project set, client null) stays representable.

## Consequences

- The Agent link is testable without a Host: the resolver, token resolution,
  discovery, the client factory and the core factory are injected.
- One fiber per agent, disposed before a relink re-injects — two live fibers
  duplicate tools (name collisions are swallowed as warnings) and the prompt
  section.
- `unlink` is the only path that drops a connection, which makes `teardownAgent`
  a thin wrapper over it instead of a second, untested teardown.
- `relink` runs only from `/rembric-login`, after a successful connection check,
  and only when the current outcome is not `Connected`; a healthy session never
  churns.
- Command handlers read outcomes, never state fields; an off or refused session
  prints the outcome's notice instead of a hardcoded "not connected" string.
- Reversing this reshapes every command handler and the Host registration path,
  so the split is recorded rather than re-litigated.
