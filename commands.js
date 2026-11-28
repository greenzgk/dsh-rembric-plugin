// commands.js — slash commands, file-linked recall and subagent learnings.
//
// Three pieces, all registered from host.js apply():
//
//   1. registerRembricCommands — four global slash commands (/recall, /context,
//      /remember, /summary). Each handler answers the user directly; the text it
//      returns is shown without a model turn.
//   2. wireFileRecall — when a durable `session/event` of type `tool/call`
//      touches a file, ask the Rembric server for recall hints about that path
//      and inject them through the host's nudge-message helper.
//   3. wireSubagentLearnings — when a finished child's final assistant message
//      carries the "key learnings" phrase, post it to the PARENT session's
//      /learnings endpoint.
//
// This module owns no session logic. Every Rembric call goes through the agent's
// existing MCP client or the session-core instance host.js already created, and
// injected messages are built by the host's makeNudgeMessage (passed in as a
// dependency), so there is exactly one place that shapes an injected message.
//
// Failure policy: a command answers with an error line; a recall or learnings
// failure is swallowed. Nothing in this file may break a turn or the session feed.

import { extractCommandPaths } from "./session-core.js";

// A slash command blocks the UI until it settles, so cap the round trip well
// below the MCP discovery timeout used elsewhere in the plugin.
const COMMAND_TIMEOUT_MS = 8_000;
// Mirrors COMMAND_PATHS_MAX in session-core.js; fileRecall slices to the same cap.
const MAX_RECALL_PATHS = 5;
const TITLE_MAX_CHARS = 60;
const SNIPPET_MAX_CHARS = 240;
const CONTEXT_LIST_MAX = 5;

const NOT_CONNECTED = "rembric: not connected for this session";

// Tools whose arguments can name a file worth recalling against.
const FILE_TOOL_NAMES = new Set(["read", "write", "edit", "glob", "grep", "bash"]);
// Only the shell tool needs command-line path extraction; the others carry a
// dedicated path argument.
const SHELL_TOOL_NAMES = new Set(["bash", "shell", "exec", "terminal"]);
// Argument keys that hold a file path across the file tools.
const PATH_ARG_KEYS = ["file_path", "path", "notebook_path", "filePath"];

// ---- small helpers ----------------------------------------------------------

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

function err(text) {
  return { kind: "error", text: `rembric: ${text}` };
}

// Tool names may arrive namespaced (`builtin.read`, `dsh:read`). Compare on the
// last segment so the match survives a prefix without swallowing dotted Rembric
// names — `memory.save` reduces to `save`, which is not a file tool.
function baseToolName(name) {
  const text = String(name ?? "");
  const cut = Math.max(text.lastIndexOf(":"), text.lastIndexOf("."));
  return (cut >= 0 ? text.slice(cut + 1) : text).toLowerCase();
}

function isFileTouchingTool(name) {
  return FILE_TOOL_NAMES.has(baseToolName(name));
}

// Tool arguments arrive as a JSON string on the durable event, but accept an
// already-parsed object too. null means "no usable argument object".
function parseArgs(raw) {
  if (raw && typeof raw === "object") return raw;
  if (typeof raw !== "string" || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function parseJson(text) {
  return parseArgs(text);
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function pickArray(node, keys) {
  if (Array.isArray(node)) return node;
  if (!node || typeof node !== "object") return null;
  for (const key of keys) {
    if (Array.isArray(node[key])) return node[key];
  }
  return null;
}

// Collapse whitespace so a multi-line value still fits on one display line.
function truncate(value, max) {
  const text = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function titleOf(item) {
  if (!item || typeof item !== "object") return "";
  return truncate(item.title ?? item.name ?? item.label ?? item.id ?? "", TITLE_MAX_CHARS);
}

function snippetOf(item) {
  if (!item || typeof item !== "object") return "";
  return String(item.snippet ?? item.content ?? item.summary ?? item.text ?? item.body ?? "");
}

function textFromBlocks(blocks) {
  if (!Array.isArray(blocks)) return "";
  return blocks
    .filter((block) => block && block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

// Combine the caller's signal with a hard timeout without depending on
// AbortSignal.any (not available on every runtime DSH ships on).
function withTimeoutSignal(signal, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (typeof timer.unref === "function") timer.unref();
  const abort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", abort, { once: true });
  }
  return {
    signal: controller.signal,
    done() {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", abort);
    },
  };
}

// ---- MCP call + formatting ---------------------------------------------------

// `preferredName` is the underscored name DSH registers the tool under; the MCP
// server owns the real (usually dotted) name, so it is resolved through the
// host's discovery cache before the call goes out.
async function callRembric(deps, state, preferredName, args, signal) {
  if (!state || !state.client) throw new Error(NOT_CONNECTED);
  const name = deps.resolveToolName(preferredName);
  const timed = withTimeoutSignal(signal, COMMAND_TIMEOUT_MS);
  try {
    const { text, isError } = await state.client.callTool(name, args ?? {}, timed.signal);
    if (isError) throw new Error(text || `${name} returned an error`);
    return text ?? "";
  } finally {
    timed.done();
  }
}

function formatMemoryLine(item) {
  if (typeof item === "string") return `- ${truncate(item, SNIPPET_MAX_CHARS)}`;
  const title = titleOf(item);
  const snippet = truncate(snippetOf(item), SNIPPET_MAX_CHARS);
  if (title && snippet) return `- ${title}: ${snippet}`;
  return `- ${title || snippet || "(empty)"}`;
}

function formatSearchResults(query, text) {
  const payload = parseJson(text);
  const items =
    payload === null ? null : pickArray(payload, ["results", "memories", "hits", "items", "found"]);
  if (items === null) {
    // Not a shape we recognize: show the server's own text rather than invent one.
    const raw = String(text ?? "").trim();
    return raw ? `rembric: ${raw}` : "rembric: no memories found";
  }
  if (items.length === 0) return `rembric: no memories found for "${truncate(query, 80)}"`;
  const lines = [`rembric: ${items.length} memories for "${truncate(query, 80)}"`];
  for (const item of items) lines.push(formatMemoryLine(item));
  return lines.join("\n");
}

function formatContextResult(text) {
  const payload = parseJson(text);
  const knownShape =
    payload !== null &&
    !Array.isArray(payload) &&
    (payload.recentSessions !== undefined ||
      payload.sessions !== undefined ||
      payload.recentMemories !== undefined ||
      payload.memories !== undefined ||
      payload.needsReview !== undefined);
  if (!knownShape) {
    const raw = String(text ?? "").trim();
    return raw ? `rembric: ${raw}` : "rembric: no context available";
  }
  const sessions = asArray(pickArray(payload, ["recentSessions", "sessions"]));
  const memories = asArray(pickArray(payload, ["recentMemories", "memories"]));
  const review = payload.needsReview;
  const reviewCount = typeof review === "number" ? review : asArray(review).length;

  const lines = ["rembric: context"];
  lines.push(`Recent sessions: ${sessions.length}`);
  for (const session of sessions.slice(0, CONTEXT_LIST_MAX)) {
    const label =
      typeof session === "string"
        ? truncate(session, TITLE_MAX_CHARS)
        : titleOf(session) || truncate(snippetOf(session), TITLE_MAX_CHARS);
    lines.push(`  - ${label || "(untitled)"}`);
  }
  lines.push(`Recent memories: ${memories.length}`);
  for (const memory of memories.slice(0, CONTEXT_LIST_MAX)) {
    const label =
      typeof memory === "string"
        ? truncate(memory, SNIPPET_MAX_CHARS)
        : `${titleOf(memory) ? `${titleOf(memory)}: ` : ""}${truncate(snippetOf(memory), SNIPPET_MAX_CHARS)}`;
    lines.push(`  - ${label || "(empty)"}`);
  }
  lines.push(`Needs review: ${reviewCount}`);
  return lines.join("\n");
}

// ---- command handlers --------------------------------------------------------

async function handleRecall(deps, invocation) {
  const query = String(invocation?.rawInput ?? "").trim();
  if (!query) return err("usage: /recall <query>");
  const state = deps.getStateForAgent(invocation.agent);
  if (!state || !state.client) return err(NOT_CONNECTED);
  try {
    const text = await callRembric(
      deps,
      state,
      "memory_search",
      { query, limit: 8 },
      invocation.signal,
    );
    return { kind: "success", text: formatSearchResults(query, text) };
  } catch (error) {
    return err(`recall failed: ${errorText(error)}`);
  }
}

async function handleContext(deps, invocation) {
  const state = deps.getStateForAgent(invocation.agent);
  if (!state || !state.client) return err(NOT_CONNECTED);
  try {
    const text = await callRembric(deps, state, "memory_context", {}, invocation.signal);
    return { kind: "success", text: formatContextResult(text) };
  } catch (error) {
    return err(`context failed: ${errorText(error)}`);
  }
}

async function handleRemember(deps, invocation) {
  const content = String(invocation?.rawInput ?? "").trim();
  if (!content) return err("usage: /remember <text to save>");
  const state = deps.getStateForAgent(invocation.agent);
  if (!state || !state.client) return err(NOT_CONNECTED);
  const title = truncate(content, TITLE_MAX_CHARS) || "remembered note";
  try {
    await callRembric(
      deps,
      state,
      "memory_save",
      { type: "reference", title, content, tags: ["remember-command"] },
      invocation.signal,
    );
    return { kind: "success", text: `saved: ${title}` };
  } catch (error) {
    return err(`save failed: ${errorText(error)}`);
  }
}

async function handleSummary(deps, invocation) {
  const state = deps.getStateForAgent(invocation.agent);
  if (!state || !state.core || !state.sid) {
    return err("no Rembric session for this chat");
  }
  if (!state.core.isKnown(state.sid)) {
    return err("session not registered with Rembric yet (send a message first)");
  }
  try {
    await state.core.flushSessionSummary(state.sid);
    return { kind: "success", text: "summary flushed" };
  } catch (error) {
    return err(`summary flush failed: ${errorText(error)}`);
  }
}

// /rembric-login <token> — save the token to the credential store, then
// verify it against the server BEFORE reporting success. The
// token is never echoed back in any reply. On a failed check the token stays
// saved but the failure is reported with the shared classifier wording.
async function handleLogin(deps, invocation) {
  const token = String(invocation?.rawInput ?? "").trim();
  if (!token) return err("usage: /rembric-login <token>");
  try {
    await deps.saveToken(token);
  } catch (error) {
    // A provider error could embed the submitted value, so the chat reply
    // stays generic; the real reason goes to the host log instead.
    deps.warnOnce(`could not save the token: ${errorText(error)}`);
    return err("could not save the token (the host log has the reason)");
  }
  const info = deps.serverInfo();
  const check = await deps.checkConnection({ serverUrl: info.url, token });
  if (!check.ok) {
    return err(`token saved, but the connection check failed: ${check.message}`);
  }
  return {
    kind: "success",
    text: `rembric: token saved — the server accepted it (${check.toolCount} tools available). Never shown again; manage it with /rembric-status.`,
  };
}

// /rembric-status — honest readout: token source, effective server URL and
// where it came from, resolved project slug and its resolution method, plugin
// mode and — for an off session — its off reason, and tool count. A missing
// token is reported as an absence, never as a connection error, and no
// connection attempt is made. An off session is never reported as `on`.
const SLUG_SOURCE_LABELS = {
  rembric: ".rembric file",
  "rembric-root": ".rembric file",
  "rembric-nested": ".rembric file",
  env: "REMBRIC_PROJECT_SLUG",
  fingerprint: "repository binding",
};

const SERVER_ORIGIN_LABELS = {
  config: "config",
  env: "REMBRIC_SERVER_URL",
  default: "default",
};

async function handleStatus(deps, invocation) {
  const token = await deps.resolveToken();
  const info = deps.serverInfo();
  const state = deps.getStateForAgent(invocation?.agent);
  const lines = ["rembric: status"];
  lines.push(
    token.value ? `Token: ${token.source}` : "Token: none — set it with /rembric-login <token>",
  );
  const originLabel = SERVER_ORIGIN_LABELS[info.origin] ?? info.origin;
  lines.push(`Server: ${info.url} (${originLabel})`);
  if (state && state.slug) {
    const label = SLUG_SOURCE_LABELS[state.slugSource] ?? "unknown source";
    lines.push(`Project: ${state.slug} (${label})`);
  } else if (state && state.mode === "no_project") {
    lines.push(`Project: no project (${state.reason ?? "no_choice"})`);
  } else if (!state) {
    lines.push("Project: not resolved for this session");
  }
  if (state) {
    lines.push(state.mode === "project" ? "Mode: on (project)" : `Mode: off (${state.mode})`);
    if (state.mode !== "project" && state.reason) lines.push(`Reason: ${state.reason}`);
  } else {
    lines.push(token.value ? "Mode: off" : "Mode: off (no token)");
  }
  lines.push(`Tools: ${state && state.toolCount != null ? state.toolCount : 0}`);
  return { kind: "success", text: lines.join("\n") };
}

// ---- public wiring -----------------------------------------------------------

// Registers the four commands globally (plain plugin context). Handlers resolve
// the calling agent's state at invocation time, so one registration serves every
// agent. Returns a disposer for all four.
export function registerRembricCommands(ctx, deps) {
  const definitions = [
    {
      name: "recall",
      description: "Search Rembric long-term memory for a query.",
      input: { hint: "<query>" },
      handler: (invocation) => handleRecall(deps, invocation),
    },
    {
      name: "context",
      description: "Show recent Rembric sessions, memories, and the review queue.",
      handler: (invocation) => handleContext(deps, invocation),
    },
    {
      name: "remember",
      description: "Save the given text to Rembric as a reference memory.",
      input: { hint: "<text to save>" },
      handler: (invocation) => handleRemember(deps, invocation),
    },
    {
      name: "summary",
      description: "Flush the current session summary to Rembric now.",
      handler: (invocation) => handleSummary(deps, invocation),
    },
    {
      name: "rembric-login",
      description:
        "Save the Rembric API token to DSH's credential store and verify it against the server.",
      input: { hint: "<token>" },
      recordInput: false,
      handler: (invocation) => handleLogin(deps, invocation),
    },
    {
      name: "rembric-status",
      description:
        "Show Rembric token source, effective server, resolved project, mode, and tool count.",
      handler: (invocation) => handleStatus(deps, invocation),
    },
  ];

  const disposers = [];
  for (const definition of definitions) {
    try {
      disposers.push(ctx.commands.register(definition));
    } catch (error) {
      deps.warnOnce(`could not register /${definition.name}: ${errorText(error)}`);
    }
  }

  return function disposeCommands() {
    for (const dispose of disposers) {
      try {
        dispose();
      } catch {
        // a failed disposer must not block the rest
      }
    }
  };
}

// Candidate file paths for one tool call. Shell tools go through the upstream
// command-path extractor; the file tools carry the path directly. When neither
// yields anything (unknown argument shape), fall back to running the extractor
// over the raw argument text — it only accepts absolute paths or `dir/file.ext`
// tokens, so the fallback cannot pull in junk.
export function recallCandidates(toolName, rawArgs) {
  const out = [];
  const push = (value) => {
    const text = typeof value === "string" ? value.trim() : "";
    if (text && !out.includes(text)) out.push(text);
  };

  const args = parseArgs(rawArgs);
  if (args) {
    if (SHELL_TOOL_NAMES.has(baseToolName(toolName))) {
      for (const path of extractCommandPaths(
        typeof args.command === "string" ? args.command : "",
      )) {
        push(path);
      }
    } else {
      for (const key of PATH_ARG_KEYS) push(args[key]);
    }
  }
  if (out.length === 0) {
    for (const path of extractCommandPaths(typeof rawArgs === "string" ? rawArgs : "")) push(path);
  }
  return out.slice(0, MAX_RECALL_PATHS);
}

// Fire-and-forget recall on the durable post-commit tool feed. fileRecall
// carries its own budgets (500ms per request, 1000ms for the git helpers) and
// de-duplicates per session internally, so this adds no turn latency: the
// result is injected for a later step, never awaited by the caller.
export function wireFileRecall(ctx, deps) {
  ctx.on("session/event", (session, event) => {
    try {
      if (!event || event.type !== "tool/call") return;
      const toolName = event.data?.name;
      if (!isFileTouchingTool(toolName)) return;

      const state = deps.getStateBySession(String(session?.id ?? ""));
      if (!state || !state.core || !state.cwd) return;
      const agent = state.agent;
      if (!agent || typeof agent.inject !== "function") return;

      const candidates = recallCandidates(toolName, event.data?.arguments);
      if (candidates.length === 0) return;

      void state.core
        .fileRecall(state.sid, state.cwd, candidates)
        .then((lines) => {
          if (!Array.isArray(lines) || lines.length === 0) return;
          for (const line of lines) {
            try {
              // makeNudgeMessage runs underscoreToolNames over the text, so a
              // dotted tool name coming back from the server is surfaced with
              // the underscored name the agent can actually call.
              agent.inject(deps.makeNudgeMessage(line));
            } catch {
              // an inject failure must not break the turn
            }
          }
        })
        .catch(() => {
          // recall failure is never fatal
        });
    } catch {
      // the durable session feed must not be broken by recall
    }
  });
}

// Subagent → parent learnings. `subagent/end` carries SubagentRunEndInfo:
// { runId, provider, parentSessionId, id, local, stopReason,
//   lastAssistantMessage?: readonly ContentBlock[] } (verified via
// cordis_inspect_query host/Event listEvents subagent/end).
//
// The parent core is resolved from the host's sessionIndex by
// String(info.parentSessionId). parentSessionId is the DIRECT creator: when the
// creator is itself a subagent child there is no host-owned core for it (the
// host skips subagent children in setupAgent), so the lookup misses and the
// report is skipped silently — that is the correct outcome, not an error.
//
// agentType is deliberately omitted. SubagentRunEndInfo has no child
// agent-type/name field; `provider` is the LLM provider, not the subagent kind,
// so posting it as agentType would mislabel the learning. session-core treats
// agentType as optional (only added to the body when a non-empty string).
//
// The "key learnings" phrase gate is NOT duplicated here: session-core keeps
// KEY_LEARNINGS_PHRASE private and applies it inside postSubagentReport after
// stripping <private> blocks, which is the correct place (a report that is
// entirely private must not pass the gate on raw text). A non-matching report
// settles as false without any request going out.
export function wireSubagentLearnings(ctx, deps) {
  ctx.on("subagent/end", (info) => {
    try {
      const report = textFromBlocks(info?.lastAssistantMessage);
      if (!report) return;
      const parentSessionId = info?.parentSessionId ? String(info.parentSessionId) : "";
      if (!parentSessionId) return;

      const state = deps.getStateBySession(parentSessionId);
      if (!state || !state.core) return;

      void state.core.postSubagentReport(parentSessionId, report, undefined).catch(() => {
        // learnings capture is never fatal
      });
    } catch {
      // the subagent lifecycle must not be broken by learnings capture
    }
  });
}
