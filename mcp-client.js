// Minimal MCP streamable-HTTP client for the Rembric DSH plugin.
// Ported from the upstream Rembric Pi plugin's createMcpClient.
// Talks JSON-RPC 2.0 over a single POST per request; decodes SSE or plain JSON.

const PROTOCOL_VERSION = "2025-06-18";

function decodeEventStream(body) {
  if (!body.startsWith("event:") && !body.startsWith("data:")) return null;
  for (const line of body.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    try {
      return JSON.parse(line.slice(5).trim());
    } catch {
      // Ignore malformed frames and keep scanning.
    }
  }
  return null;
}

export function createMcpClient(endpoint, apiToken, fingerprint) {
  let nextId = 1;
  let protocolVersion = PROTOCOL_VERSION;
  let sessionId = null;
  let instructions = "";

  async function send(method, params, signal, isNotification = false) {
    const headers = {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": protocolVersion,
    };
    if (sessionId) headers["mcp-session-id"] = sessionId;
    if (fingerprint) headers["X-Rembric-Repo-Fingerprint"] = fingerprint;

    const body = { jsonrpc: "2.0", method };
    if (params !== undefined) body.params = params;
    let id = null;
    if (!isNotification) {
      id = nextId++;
      body.id = id;
    }

    const response = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal,
    });
    if (response.headers.get("mcp-session-id")) {
      sessionId = response.headers.get("mcp-session-id");
    }
    if (!response.ok) {
      throw new Error(`Rembric MCP request failed: HTTP ${response.status}`);
    }
    if (isNotification) return null;

    const text = await response.text();
    const decoded = decodeEventStream(text) ?? JSON.parse(text);
    if (decoded.error) {
      const message = decoded.error?.message ?? "unknown error";
      throw new Error(`Rembric MCP error: ${message}`);
    }
    return decoded.result;
  }

  async function initialize(signal) {
    const result = await send(
      "initialize",
      {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "rembric-dsh", version: "0.1.0" },
      },
      signal,
    );
    if (result?.protocolVersion) protocolVersion = result.protocolVersion;
    if (typeof result?.instructions === "string") instructions = result.instructions;
    send("notifications/initialized", undefined, signal, true).catch(() => {});
    return result;
  }

  async function listTools(signal) {
    const tools = [];
    let cursor = null;
    do {
      const params = cursor ? { cursor } : {};
      const page = await send("tools/list", params, signal);
      tools.push(...(page?.tools ?? []));
      cursor = page?.nextCursor ?? null;
    } while (cursor);
    return tools;
  }

  async function callTool(name, args, signal) {
    const result = await send("tools/call", { name, arguments: args ?? {} }, signal);
    const parts = Array.isArray(result?.content) ? result.content : [];
    const text = parts
      .filter((part) => part?.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("\n");
    return { text, isError: Boolean(result?.isError) };
  }

  return {
    initialize,
    listTools,
    callTool,
    instructions: () => instructions,
    protocolVersion: () => protocolVersion,
  };
}
