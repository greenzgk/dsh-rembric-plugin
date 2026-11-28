// Rembric memory plugin for DeepSeek Harness.
//
// Mirrors the upstream Rembric Pi plugin: discovers the Rembric MCP tool set on the
// session's own project endpoint (cached per endpoint, never the bare /mcp), registers
// every tool under an underscored name on each agent, and forwards the
// server's usage crib-sheet into the system prompt. Project selection follows the
// working directory (.rembric file / env / git binding), exactly like the Pi client.
//
// The token is a credential reference: set it from the chat with
// /rembric-login <token> — it lands in DSH's credential store under
// REMBRIC_API_TOKEN. An exported REMBRIC_API_TOKEN works as an ambient fallback;
// the store wins when both exist. The server URL comes from plugin config, then
// REMBRIC_SERVER_URL, then the local default.

import { createMcpClient } from "./mcp-client.js";
import { resolveProject, buildEndpoint } from "./project.js";
import { createSessionCore, underscoreToolNames } from "./session-core.js";
import { registerRembricCommands, wireFileRecall, wireSubagentLearnings } from "./commands.js";
import { registerVerifyRoute } from "./verify-route.js";
import { registerConfigRoute } from "./config-route.js";

// Re-exported so the rewrite helpers are reachable from the host module;
// session-core.js holds the single implementation.
export { underscoreToolNames };

export const name = "dsh-rembric-plugin";
export const inject = [
  "tools",
  "systemPrompt",
  "credentials",
  "workingDirectory",
  "agents",
  "commands",
];

const CLIENT_NAME = "rembric-dsh";
const CREDENTIAL_REF = "REMBRIC_API_TOKEN";

// Ambient credential layers named by the credentials provider: the process
// environment and the dotenv files. Anything else the provider reports as a
// source — "file" (the local provider's writable store) or a future
// "keychain" — is treated as the store. The assumption is documented here
// rather than hard-coded to "file" so a new store backend still reads as
// "store" instead of silently degrading to "env".
const AMBIENT_CREDENTIAL_SOURCES = new Set(["env", "project-env", "user-env"]);
const DISCOVERY_TIMEOUT_MS = 10_000;
const DEFAULT_SERVER_URL = "http://127.0.0.1:8790";

// Recursively rewrite every "description" string in a JSON Schema so the model
// only ever sees underscored tool names.
export function renameToolsInDescriptions(node) {
  if (Array.isArray(node)) return node.map(renameToolsInDescriptions);
  if (node && typeof node === "object") {
    const out = {};
    for (const [key, value] of Object.entries(node)) {
      out[key] =
        key === "description" && typeof value === "string"
          ? underscoreToolNames(value)
          : renameToolsInDescriptions(value);
    }
    return out;
  }
  return node;
}

function declaresSessionId(schema) {
  return Boolean(
    schema &&
    schema.type === "object" &&
    schema.properties &&
    Object.prototype.hasOwnProperty.call(schema.properties, "sessionId"),
  );
}

// When the agent's session is registered with Rembric and the model did not supply
// a sessionId, inject the DSH session id so the server attaches the call correctly.
function withHostSessionId(params, core, sessionId) {
  if (!core || !sessionId || !core.isRegistered(sessionId)) return params;
  if (params && typeof params === "object" && params.sessionId) return params;
  return { ...params, sessionId };
}

// Session id of an Agent as a plain string. The plugin keys its indexes on
// `agent.session.id`; the CommandInvocation contract exposes the bare
// `agent.id`, so accept either and normalize for Map lookups.
function sessionIdOf(agent) {
  const sid = agent?.session?.id ?? agent?.id;
  return sid ? String(sid) : "";
}

// Plain-fetch transport for the session core (same Bearer style as mcp-client).
// Returns the Response on arrival, null on any network/abort failure so the
// core's `if (!res)` guards treat it as a failed call.
function makePostTransport(baseUrl, apiToken) {
  return async function post(path, body, timeoutMs = 3000) {
    try {
      return await fetch(`${baseUrl}${path}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body ?? {}),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      return null;
    }
  };
}

// Join the text blocks of a message content array.
function extractText(content) {
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block && block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

// Build the synthetic UserMessage that carries one nudge line.
// `createUserMessage` from @deepseek-ai/dsh-llm is not importable from this
// plugin's module graph (the Cordis loader resolves bare specifiers natively
// from the plugin's install dir, which has no dsh-llm), so the message is
// constructed as a literal matching the UserMessage shape:
//   { id, role: 'user', content: ContentBlock[], source: MessageSource }
// The source kind is the custom producer kind 'rembric'. The MessageSourceMap
// is merge-extensible ("each producer declares its own kind in its own
// module... consumers fall through unknown kinds"), and crucially it is NOT
// 'user', so injected nudges never re-trigger the human-prompt capture path.
let nudgeSeq = 0;
function makeNudgeMessage(nudgeText) {
  const id =
    (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : `rembric-${Date.now().toString(36)}-${(nudgeSeq++).toString(36)}`) + "";
  return {
    id,
    role: "user",
    content: [{ type: "text", text: underscoreToolNames(nudgeText) }],
    source: { kind: "rembric" },
  };
}

// The token is a credential reference (ADR 0001): a named slot in DSH's
// credential store, resolved through ctx.credentials with the ambient
// environment as the fallback. The store is authoritative when it has a
// value; an empty stored value counts as absent. The plugin never writes the
// token back into the environment.
export async function resolveToken(ctx, env = process.env) {
  try {
    const resolved = await ctx.credentials.resolve(CREDENTIAL_REF);
    if (resolved && typeof resolved.value === "string" && resolved.value.trim()) {
      return {
        value: resolved.value.trim(),
        source: AMBIENT_CREDENTIAL_SOURCES.has(resolved.source) ? "env" : "store",
      };
    }
  } catch {
    // Provider failure: treat as absent and fall through to the ambient fallback.
  }
  const fromEnv =
    env && typeof env.REMBRIC_API_TOKEN === "string" ? env.REMBRIC_API_TOKEN.trim() : "";
  if (fromEnv) return { value: fromEnv, source: "env" };
  return { value: null, source: "none" };
}

// Read one plugin config field that may arrive as a plain value or wrapped in a
// live settings value (Volatile<T> exposes .get()). Never caches: a volatile
// field must reflect the current setting on every read.
export function readConfigValue(value) {
  if (value && typeof value === "object" && typeof value.get === "function") return value.get();
  return value;
}

// Effective server URL and where it came from: plugin config (volatile-aware)
// > REMBRIC_SERVER_URL > local default. Trailing slashes are stripped.
export function resolveServerUrl(config, env = process.env) {
  const fromConfig = String(readConfigValue(config?.serverUrl) ?? "").trim();
  if (fromConfig) return { url: fromConfig.replace(/\/+$/, ""), origin: "config" };
  const fromEnv = String(env?.REMBRIC_SERVER_URL ?? "").trim();
  if (fromEnv) return { url: fromEnv.replace(/\/+$/, ""), origin: "env" };
  return { url: DEFAULT_SERVER_URL, origin: "default" };
}

// Map any error thrown by a connection attempt onto one honest message.
// The single shared connection check and the settings card both
// classify through here so the user always sees the same wording per failure
// mode: rejected token / no project access / no MCP at the address / timeout /
// unreachable host.
export function classifyConnectionFailure(error) {
  const status = error && typeof error === "object" ? error.status : undefined;
  if (status === 401)
    return { kind: "rejected-token", message: "the server rejected the token (HTTP 401)" };
  if (status === 403)
    return {
      kind: "no-project-access",
      message: "the token has no access to this project (HTTP 403)",
    };
  if (status === 404)
    return { kind: "no-mcp", message: "no MCP endpoint at this address (HTTP 404)" };
  const name = error && typeof error === "object" ? String(error.name ?? "") : "";
  if (name === "TimeoutError" || name === "AbortError") {
    return { kind: "timeout", message: "the server did not answer in time" };
  }
  return { kind: "unreachable", message: "the host could not be reached" };
}

// The single shared connection check (CONTEXT.md "Connection check"): ask the
// Rembric server to accept the token and list its tools. /rembric-login and
// the settings card probe through here so every probing surface reports the
// same failure wording. /rembric-status deliberately does NOT probe — it
// reports cached session state (toolCount captured at setup). fetchImpl is
// injectable so tests run without a network.
export async function checkConnection({
  serverUrl,
  token,
  slug = null,
  fetchImpl = globalThis.fetch,
  timeoutMs = DISCOVERY_TIMEOUT_MS,
} = {}) {
  const trimmed = token == null ? "" : String(token).trim();
  if (!trimmed) {
    return { ok: false, kind: "no-token", message: "no token is configured" };
  }
  const client = createMcpClient(buildEndpoint(serverUrl, slug), trimmed, null, fetchImpl);
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    const initResult = await client.initialize(signal);
    const tools = await client.listTools(signal);
    return { ok: true, toolCount: tools.length, serverName: initResult?.serverInfo?.name ?? null };
  } catch (error) {
    return { ok: false, ...classifyConnectionFailure(error) };
  }
}

// ---- per-endpoint discovery cache --------------------------------------------
// Discovery belongs to the session's resolved project (spec #26 T4): tools and
// crib-sheet are fetched from the session's own project endpoint, never from the
// bare /mcp endpoint (the implicit `default`). Entries are keyed by endpoint and
// shared by sessions resolving to the same project; concurrent sessions on one
// endpoint share the in-flight promise. A failed discovery is NOT cached — the
// next session retries immediately (the old global failure cooldown is gone).

const discoveryCache = new Map(); // endpoint -> Promise<{ tools, instructions }>

function ensureDiscovery(serverUrl, token, slug) {
  const endpoint = buildEndpoint(serverUrl, slug);
  let pending = discoveryCache.get(endpoint);
  if (!pending) {
    pending = (async () => {
      // Session-agnostic request: no fingerprint header — a shared discovery must
      // not carry one session's repository identity.
      const client = createMcpClient(endpoint, token, null);
      const signal = AbortSignal.timeout(DISCOVERY_TIMEOUT_MS);
      await client.initialize(signal);
      const tools = await client.listTools(signal);
      return { tools, instructions: client.instructions() };
    })();
    discoveryCache.set(endpoint, pending);
    pending.catch(() => {
      if (discoveryCache.get(endpoint) === pending) discoveryCache.delete(endpoint);
    });
  }
  return pending;
}

// Resolve a tool name for a direct client.callTool(). Commands are written with
// the underscored names DSH registers the tools under (how the model sees them),
// but the MCP server only knows the name it advertised at discovery — dotted for
// Rembric (`memory.search`). Try the given name, then its dotted form, then its
// underscored form, so the call works whichever convention the server uses.
// The candidate set is the CALLING session's own discovered tools (spec #26 T4):
// one project's tool set must never rename another project's calls.
function resolveToolName(preferred, state) {
  const name = String(preferred ?? "");
  const tools = state?.tools ?? [];
  if (tools.length === 0) return name;
  const names = new Set(tools.map((tool) => tool?.name).filter(Boolean));
  if (names.has(name)) return name;
  const dotted = name.replace(/_/g, ".");
  if (names.has(dotted)) return dotted;
  const underscored = name.replace(/\./g, "_");
  if (names.has(underscored)) return underscored;
  return name;
}

// ---- per-agent state --------------------------------------------------------

const agentStates = new Map(); // agent -> { fiber, client, slug, mode, core, sid }
const sessionIndex = new Map(); // session id -> agent state (for session/event routing)
const warned = new Set(); // de-duplicate one-line warnings

function warnOnce(ctx, message) {
  if (warned.has(message)) return;
  warned.add(message);
  try {
    ctx.logger.warn(`rembric: ${message}`);
  } catch {
    // logger unavailable; nothing else to do.
  }
}

// Off-session system-prompt notice (spec #26): project resolution already
// produced a human-readable reason naming both enable paths; the notice appends
// the standing rule that ends every off notice — the model must surface the
// state to the user but never pick the project itself. The fallback keeps both
// enable paths in the text even if the resolver ever omits its message.
const OFF_NOTICE_GUARD =
  "Tell the user about this in your first reply. Do not create or edit a `.rembric` file yourself: " +
  "where a workspace's memories live is the user's decision. Only do it when the user explicitly asks, " +
  "and ask them for the project slug first.";

function offNoticeText(resolved) {
  const reason =
    resolved.message ??
    "Rembric memory is off for this session: no project was chosen — add a `.rembric` file " +
      "containing PROJECT_SLUG=<slug> in this session's starting directory, or set " +
      "REMBRIC_PROJECT_SLUG=<slug> in the environment.";
  return `${reason}\n\n${OFF_NOTICE_GUARD}`;
}

function buildToolDef(tool, client, stateRef) {
  const attaches = declaresSessionId(tool.inputSchema);
  const underscored = tool.name.replace(/\./g, "_");
  return {
    name: underscored,
    description: underscoreToolNames(tool.description ?? tool.name),
    parameters: renameToolsInDescriptions(tool.inputSchema ?? { type: "object", properties: {} }),
    output: {
      schema: { type: "string" },
      render: (_args, value) => [{ type: "text", text: String(value ?? "") }],
    },
    execute: async (args, exec) => {
      let finalArgs = args ?? {};
      if (attaches) {
        const core = stateRef?.core;
        const sid = exec?.agent?.session?.id;
        finalArgs = withHostSessionId(finalArgs, core, sid);
      }
      const { text, isError } = await client.callTool(tool.name, finalArgs, exec.signal);
      if (isError) throw new Error(text || "Rembric tool returned an error");
      return text;
    },
  };
}

async function setupAgent(ctx, config, agent) {
  if (agentStates.has(agent)) return;

  // Subagent children never own a Rembric session of their own.
  if (agent.session && agent.session.header && agent.session.header.origin === "subagent") return;

  const { url: serverUrl } = resolveServerUrl(config);
  const { value: token } = await resolveToken(ctx);

  let cwd;
  try {
    cwd = ctx.workingDirectory.get(agent.session) ?? process.cwd();
  } catch {
    cwd = process.cwd();
  }

  // Resolve the project BEFORE touching the server (spec #26): an off session
  // must make no request at all, so discovery and the token gate both move
  // behind this check. Outside git resolution needs no token — the mode is
  // known from the directory alone; inside git the resolver uses the token
  // when present and reports `refused`/no_credentials when not.
  let resolved;
  try {
    resolved = await resolveProject({
      startDir: cwd,
      env: process.env,
      serverUrl,
      apiToken: token,
    });
  } catch (error) {
    warnOnce(
      ctx,
      `project resolution failed for ${cwd}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return;
  }

  const sid = agent.session.id;

  // Off / non-project sessions (no_project / unbound / refused): memory is off
  // for the whole session lifetime. Register a state so slash commands can
  // report the mode and its reason, but with no client/core and zero tools;
  // then stop — no discovery, no connection, no request.
  if (resolved.mode !== "project") {
    const state = {
      fiber: null,
      client: null,
      slug: null,
      slugSource: null,
      mode: resolved.mode,
      reason: resolved.reason ?? null,
      message: resolved.message ?? null,
      toolCount: 0,
      core: null,
      sid,
      cwd,
      agent,
    };
    // The diagnostic line still goes to the plugin log.
    warnOnce(ctx, resolved.message ?? `off — no project (${resolved.mode})`);
    // Only a no_project session gets the system-prompt off notice: unbound and
    // refused are repository-binding states with their own remedy wording, not
    // the "choose a project" prompt.
    if (resolved.mode === "no_project") {
      try {
        state.fiber = agent.ctx.inject(["systemPrompt"], (scope) => {
          scope.systemPrompt.section({
            name: "context:rembric",
            order: 1000,
            text: offNoticeText(resolved),
            interpolate: false,
          });
        });
      } catch (error) {
        warnOnce(
          ctx,
          `off notice unavailable: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    agentStates.set(agent, state);
    sessionIndex.set(sid, state);
    return;
  }

  if (!token) {
    warnOnce(
      ctx,
      "off — no token. Set one with /rembric-login <token> or export REMBRIC_API_TOKEN.",
    );
    return;
  }

  const slug = resolved.slug ?? null;

  // Discover on the session's own project endpoint (spec #26 T4) — never the bare
  // /mcp. A cached result means this project was already discovered; a failed
  // discovery is retried by the next session (no cooldown).
  let disc;
  try {
    disc = await ensureDiscovery(serverUrl, token, slug);
  } catch (error) {
    warnOnce(
      ctx,
      `off — discovery failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return;
  }

  // Per-agent client for the actual tool calls: carries this session's own
  // fingerprint header. It is not re-initialized — discovery already opened the
  // endpoint, and re-initializing would defeat the shared per-endpoint discovery.
  const client = createMcpClient(buildEndpoint(serverUrl, slug), token, resolved.header ?? null);

  // The state object is created before registration so the tool definitions can
  // hold a late-bound reference to it: `core` is filled in after registration and
  // read at execute time by the auto-sessionId seam (withHostSessionId).
  // `cwd` and `agent` are needed by the command wiring: file recall resolves
  // candidate paths against the session's working directory and injects hints
  // through the agent. Neither is ever serialized (only the client-name string
  // goes into the session-core body), so holding them here is safe.
  const state = {
    fiber: null,
    client,
    slug,
    slugSource: resolved.source ?? null,
    mode: resolved.mode,
    // This session's discovered tool set — resolveToolName reads it per call so
    // one project's names never resolve against another project's tools.
    tools: disc.tools,
    toolCount: disc.tools.length,
    core: null,
    sid,
    cwd,
    agent,
  };

  // Register the tool set and the crib-sheet on this agent's own scope.
  let fiber;
  try {
    fiber = agent.ctx.inject(["systemPrompt", "tools"], (scope) => {
      for (const tool of disc.tools) {
        try {
          scope.tools.register(buildToolDef(tool, client, state));
        } catch (error) {
          // A name collision or schema rejection must not break the whole set.
          try {
            ctx.logger.warn(
              `rembric: skipped tool ${tool.name}: ${error instanceof Error ? error.message : String(error)}`,
            );
          } catch {
            // ignore
          }
        }
      }
      if (disc.instructions) {
        scope.systemPrompt.section({
          name: "context:rembric",
          order: 1000,
          text: underscoreToolNames(disc.instructions),
          interpolate: false,
        });
      }
    });
  } catch (error) {
    warnOnce(
      ctx,
      `off — could not register tools for '${slug ?? "default"}': ${error instanceof Error ? error.message : String(error)}`,
    );
    return;
  }

  state.fiber = fiber;

  // The per-agent session core: capture, auto sessionId and nudges.
  // The core does no fetch itself; it uses our injected post transport.
  // `agent` is passed as the client-name string (as in the upstream Pi port):
  // the core puts it verbatim into the POST /sessions body, so a raw DSH Agent
  // object (circular) would not serialize. It only needs to be truthy.
  try {
    state.core = createSessionCore({
      agent: CLIENT_NAME,
      baseUrl: serverUrl,
      apiToken: token,
      slug,
      cwd,
      post: makePostTransport(serverUrl, token),
    });
  } catch (error) {
    warnOnce(
      ctx,
      `session core unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  agentStates.set(agent, state);
  sessionIndex.set(sid, state);
}

function teardownAgent(ctx, agent) {
  const state = agentStates.get(agent);
  if (!state) return;
  agentStates.delete(agent);
  if (state.sid) sessionIndex.delete(state.sid);
  // Normal disposal: flush pending summaries fire-and-forget but do NOT end the
  // session — the server retires idle sessions as abandoned. forgetSession
  // clears the local idle timer and all per-session bookkeeping.
  if (state.core) {
    try {
      state.core.flushAllFireAndForget();
    } catch {
      // never break teardown
    }
    if (state.sid) {
      try {
        state.core.forgetSession(state.sid);
      } catch {
        // never break teardown
      }
    }
  }
  if (state.fiber) {
    Promise.resolve(state.fiber.dispose()).catch((error) => {
      try {
        ctx.logger.warn(
          `rembric: cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      } catch {
        // ignore
      }
    });
  }
}

export function apply(ctx, config) {
  // The command surface: slash commands, file-linked recall, subagent
  // learnings. Registered once on the plugin context (commands are global);
  // the wiring reaches per-agent state through these getters rather than
  // importing host internals, which keeps commands.js free of the module cycle.
  const wiring = {
    getStateForAgent: (agent) => agentStates.get(agent) ?? sessionIndex.get(sessionIdOf(agent)),
    getStateBySession: (sessionId) => sessionIndex.get(sessionId),
    makeNudgeMessage,
    resolveToolName,
    warnOnce: (message) => warnOnce(ctx, message),
    resolveToken: () => resolveToken(ctx),
    saveToken: (token) => ctx.credentials.set(CREDENTIAL_REF, token),
    checkConnection,
    serverInfo: () => resolveServerUrl(config),
  };

  const disposeCommands = registerRembricCommands(ctx, wiring);
  wireFileRecall(ctx, wiring);
  wireSubagentLearnings(ctx, wiring);
  // saveToken is the same closure /rembric-login writes through, so the
  // card's verify persists the token via the identical credential path.
  registerVerifyRoute(ctx, { checkConnection, resolveToken, saveToken: wiring.saveToken });
  // The card's server address is read from and saved through the config
  // route; its POST answers before the config editor restarts the plugin.
  registerConfigRoute(ctx, {
    serverInfo: wiring.serverInfo,
    resolveToken: wiring.resolveToken,
  });

  ctx.effect(
    () => () => {
      try {
        disposeCommands();
      } catch {
        // ignore
      }
    },
    "rembric: slash commands",
  );

  // Adopt agents that already exist when the plugin loads.
  for (const agent of ctx.agents.list()) {
    setupAgent(ctx, config, agent).catch(() => {});
  }

  ctx.on("agent/created", async ({ agent }) => {
    await setupAgent(ctx, config, agent);
  });

  ctx.on("agent/disposed", ({ agent }) => {
    teardownAgent(ctx, agent);
  });

  // Branch B: capture real human prompts and deliver nudges before the next step.
  // Only source.kind === 'user' counts as a human prompt; synthetic injects
  // (nudges we inject ourselves, goal continuations, runtime-context) carry
  // other kinds and must never re-enter this path (feedback-loop guard).
  ctx.on("agent/inbox/inserted", ({ agent, message }) => {
    const state = agentStates.get(agent);
    if (!state || !state.core) return;
    if (!message || message.role !== "user") return;
    if (!message.source || message.source.kind !== "user") return;
    const text = extractText(message.content);
    if (!text) return;
    const core = state.core;
    const sid = state.sid;
    void (async () => {
      try {
        core.appendUserMessage(sid, text);
        await core.ensureSession(sid);
        const nudges = core.nudgesForTurn(sid, text);
        for (const nudge of nudges) {
          try {
            agent.inject(makeNudgeMessage(nudge));
          } catch {
            // inject failure must not break the agent
          }
        }
      } catch (error) {
        warnOnce(
          ctx,
          `prompt capture failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    })();
  });

  // Branch C: durable post-commit session feed.
  // 'assistant/message' data: { turn, step, message: AssistantMessage, ... }
  // 'tool/call' data: { turn, step, callId, name, arguments }
  ctx.on("session/event", (session, event) => {
    const state = sessionIndex.get(session.id);
    if (!state || !state.core) return;
    try {
      if (event.type === "assistant/message") {
        const text = extractText(event.data?.message?.content);
        if (text) state.core.appendAssistantMessage(state.sid, text);
      } else if (event.type === "tool/call") {
        state.core.markToolUsed(state.sid);
      }
    } catch {
      // capture failure must not break the session feed
    }
  });

  // Branch D: turn close. reportTurn caches server-returned lines into the core's
  // pendingLines; they are delivered at the NEXT human prompt via nudgesForTurn
  // (takePendingLines is not exported, so there is nothing to inject here).
  // scheduleIdleFlush is independent of reportTurn's outcome.
  ctx.on("agent/turn-stopping", ({ agent }) => {
    const state = agentStates.get(agent);
    if (!state || !state.core) return;
    try {
      state.core.reportTurn(state.sid).catch(() => {});
    } catch {
      // ignore
    }
    try {
      state.core.scheduleIdleFlush(state.sid);
    } catch {
      // ignore
    }
  });

  ctx.effect(
    () => () => {
      for (const state of agentStates.values()) {
        if (state.fiber) Promise.resolve(state.fiber.dispose()).catch(() => {});
        if (state.core) {
          try {
            state.core.flushAllFireAndForget();
          } catch {
            // ignore
          }
        }
      }
      agentStates.clear();
      sessionIndex.clear();
    },
    "rembric: agent state",
  );
}
