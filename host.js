// Rembric memory plugin for DeepSeek Harness.
//
// Mirrors the upstream Rembric Pi plugin: discovers the Rembric MCP tool set once,
// registers every tool under an underscored name on each agent, and forwards the
// server's usage crib-sheet into the system prompt. Project selection follows the
// working directory (.rembric file / env / git binding), exactly like the Pi client.
//
// The token comes from a DSH credentials record (rembric/token) first, then the
// REMBRIC_API_TOKEN environment variable. The server URL comes from plugin config,
// then REMBRIC_SERVER_URL, then the local default.

import { createMcpClient } from "./mcp-client.js";
import { resolveProject, buildEndpoint } from "./project.js";
import { createSessionCore, underscoreToolNames as _unusedUnderscore } from "./session-core.js";
import { registerRembricCommands, wireFileRecall, wireSubagentLearnings } from "./commands.js";

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
const CREDENTIAL_KEY = "rembric/token";
const DISCOVERY_TIMEOUT_MS = 10_000;
const FAILURE_COOLDOWN_MS = 30_000;
const DEFAULT_SERVER_URL = "http://127.0.0.1:8790";

// Rewrite dotted Rembric tool names to the underscored names DSH registers them under.
function underscoreToolNames(text) {
  return String(text ?? "").replace(/\b(memory|project)\.([a-z_][a-z0-9_]*)\b/g, "$1_$2");
}

// Recursively rewrite every "description" string in a JSON Schema so the model
// only ever sees underscored tool names.
function renameToolsInDescriptions(node) {
  if (Array.isArray(node)) return node.map(renameToolsInDescriptions);
  if (node && typeof node === "object") {
    const out = {};
    for (const [key, value] of Object.entries(node)) {
      out[key] =
        key === "description" ? underscoreToolNames(value) : renameToolsInDescriptions(value);
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

function extractToken(record) {
  if (!record || typeof record !== "object") return null;
  if (record.kind === "grant" && record.payload && typeof record.payload.token === "string") {
    return record.payload.token;
  }
  if (record.kind === "api-key" && typeof record.key === "string" && record.key) {
    return record.key;
  }
  return null;
}

async function readCredential(ctx) {
  try {
    const record = await ctx.credentials.modifyRecord(CREDENTIAL_KEY, async () => undefined);
    return extractToken(record);
  } catch {
    return null;
  }
}

async function resolveToken(ctx) {
  const fromRecord = await readCredential(ctx);
  if (fromRecord) return fromRecord;
  const fromEnv = process.env.REMBRIC_API_TOKEN;
  return fromEnv && fromEnv.trim() ? fromEnv.trim() : null;
}

function resolveServerUrl(config) {
  const fromConfig = config && typeof config.serverUrl === "string" ? config.serverUrl.trim() : "";
  if (fromConfig) return fromConfig.replace(/\/+$/, "");
  const fromEnv = process.env.REMBRIC_SERVER_URL;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim().replace(/\/+$/, "");
  return DEFAULT_SERVER_URL;
}

// ---- global discovery cache -------------------------------------------------

let discovery = null; // { tools, instructions }
let discoveryPromise = null;
let failedAt = 0;

async function ensureDiscovery(serverUrl, token) {
  if (discovery) return discovery;
  if (Date.now() - failedAt < FAILURE_COOLDOWN_MS) {
    throw new Error("Rembric discovery is cooling down after a recent failure");
  }
  if (!discoveryPromise) {
    discoveryPromise = (async () => {
      const client = createMcpClient(buildEndpoint(serverUrl, null), token, null);
      const signal = AbortSignal.timeout(DISCOVERY_TIMEOUT_MS);
      await client.initialize(signal);
      const tools = await client.listTools(signal);
      discovery = { tools, instructions: client.instructions() };
      return discovery;
    })().catch((error) => {
      failedAt = Date.now();
      discoveryPromise = null;
      throw error;
    });
  }
  return discoveryPromise;
}

// Resolve a tool name for a direct client.callTool(). Commands are written with
// the underscored names DSH registers the tools under (how the model sees them),
// but the MCP server only knows the name it advertised at discovery — dotted for
// Rembric (`memory.search`). Try the given name, then its dotted form, then its
// underscored form, so the call works whichever convention the server uses.
function resolveToolName(preferred) {
  const name = String(preferred ?? "");
  const tools = discovery?.tools ?? [];
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

  const serverUrl = resolveServerUrl(config);
  const token = await resolveToken(ctx);
  if (!token) {
    warnOnce(ctx, "off — no token. Set the rembric/token credential or export REMBRIC_API_TOKEN.");
    return;
  }

  let disc;
  try {
    disc = await ensureDiscovery(serverUrl, token);
  } catch (error) {
    warnOnce(
      ctx,
      `off — discovery failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return;
  }

  let cwd;
  try {
    cwd = ctx.workingDirectory.get(agent.session) ?? process.cwd();
  } catch {
    cwd = process.cwd();
  }

  let resolved;
  try {
    const env = { ...process.env };
    if (config && config.projectSlug) env.REMBRIC_PROJECT_SLUG = String(config.projectSlug);
    resolved = await resolveProject({ startDir: cwd, env, serverUrl, apiToken: token });
  } catch (error) {
    warnOnce(
      ctx,
      `project resolution failed for ${cwd}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return;
  }

  if (resolved.mode === "refused") {
    warnOnce(ctx, resolved.message ?? "off — repository could not be resolved to a project");
    return;
  }
  if (resolved.mode === "unbound") {
    warnOnce(
      ctx,
      resolved.message ?? "repository is not bound to a project; memory off for this session",
    );
    return;
  }

  const slug = resolved.slug ?? (config && config.projectSlug) ?? null;
  const client = createMcpClient(buildEndpoint(serverUrl, slug), token, resolved.header ?? null);
  try {
    await client.initialize(AbortSignal.timeout(DISCOVERY_TIMEOUT_MS));
  } catch (error) {
    warnOnce(
      ctx,
      `off — connect to project '${slug ?? "default"}' failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return;
  }

  // The state object is created before registration so the tool definitions can
  // hold a late-bound reference to it: `core` is filled in after registration and
  // read at execute time by the auto-sessionId seam (withHostSessionId).
  const sid = agent.session.id;
  // `cwd` and `agent` are needed by the Phase 3 wiring: file recall resolves
  // candidate paths against the session's working directory and injects hints
  // through the agent. Neither is ever serialized (only the client-name string
  // goes into the session-core body), so holding them here is safe.
  const state = { fiber: null, client, slug, mode: resolved.mode, core: null, sid, cwd, agent };

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

  // Phase 2: per-agent session core (capture + auto sessionId + nudges).
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
  // Phase 3: slash commands, file-linked recall, subagent learnings.
  // Registered once on the plugin context (commands are global); the wiring
  // reaches per-agent state through these getters rather than importing
  // host internals, which keeps commands.js free of the module cycle.
  const phase3 = {
    getStateForAgent: (agent) => agentStates.get(agent) ?? sessionIndex.get(sessionIdOf(agent)),
    getStateBySession: (sessionId) => sessionIndex.get(sessionId),
    makeNudgeMessage,
    resolveToolName,
    warnOnce: (message) => warnOnce(ctx, message),
  };

  const disposeCommands = registerRembricCommands(ctx, phase3);
  wireFileRecall(ctx, phase3);
  wireSubagentLearnings(ctx, phase3);

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
