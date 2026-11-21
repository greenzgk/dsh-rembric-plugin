// test/client-host-config.test.mjs — the card's host endpoint client.
//
// The module that talks to /plugins/rembric/config and /plugins/rembric/verify
// is plain TypeScript with an injectable fetch, so its request shape and JSON
// mapping are tested without React or a browser.

import { describe, expect, it } from "vite-plus/test";

import {
  fetchHostConfig,
  saveHostConfig,
  verifyHostConnection,
} from "../client/src/host-config.ts";

const CONFIG_PATH = "/plugins/rembric/config";
const VERIFY_PATH = "/plugins/rembric/verify";

function jsonResponse(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  };
}

function fetcher(handler) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const call = {
      url,
      method: init.method ?? "GET",
      headers: init.headers,
      body: init.body,
    };
    calls.push(call);
    return handler(call);
  };
  return { fetch, calls };
}

describe("fetchHostConfig", () => {
  it("maps the route answer onto the card's config shape", async () => {
    const host = fetcher(() =>
      jsonResponse(200, {
        serverUrl: "http://memory.test:8790",
        tokenSource: "env",
        hasToken: true,
      }),
    );
    await expect(fetchHostConfig(host.fetch)).resolves.toEqual({
      serverUrl: "http://memory.test:8790",
      tokenSource: "env",
      hasToken: true,
    });
    expect(host.calls).toEqual([
      { url: CONFIG_PATH, method: "GET", headers: undefined, body: undefined },
    ]);
  });

  it("falls back to a blank address and no token for a sparse answer", async () => {
    const host = fetcher(() => jsonResponse(200, { tokenSource: "request" }));
    await expect(fetchHostConfig(host.fetch)).resolves.toEqual({
      serverUrl: "",
      tokenSource: "none",
      hasToken: false,
    });
  });

  it("returns null when the route is unavailable", async () => {
    const unavailable = fetcher(() => jsonResponse(501, { error: "no route" }));
    await expect(fetchHostConfig(unavailable.fetch)).resolves.toBeNull();

    const broken = fetcher(() => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error("not JSON");
      },
    }));
    await expect(fetchHostConfig(broken.fetch)).resolves.toBeNull();

    const offline = fetcher(() => {
      throw new Error("connection refused");
    });
    await expect(fetchHostConfig(offline.fetch)).resolves.toBeNull();
  });
});

describe("saveHostConfig", () => {
  it("posts the address and reports success", async () => {
    const host = fetcher((call) => {
      expect(call).toMatchObject({
        url: CONFIG_PATH,
        method: "POST",
        headers: { "content-type": "application/json" },
      });
      return jsonResponse(200, { ok: true, serverUrl: "http://new.test:8790" });
    });
    await expect(saveHostConfig("http://new.test:8790", host.fetch)).resolves.toEqual({
      ok: true,
    });
    expect(JSON.parse(host.calls[0].body)).toEqual({ serverUrl: "http://new.test:8790" });
  });

  it("passes the route error message through for a 501", async () => {
    const host = fetcher(() =>
      jsonResponse(501, {
        error: "the host has no configuration editor, so the server URL cannot be saved",
      }),
    );
    await expect(saveHostConfig("http://new.test:8790", host.fetch)).resolves.toEqual({
      ok: false,
      message: "the host has no configuration editor, so the server URL cannot be saved",
    });
  });

  it("falls back to a stable message when the route or network fails", async () => {
    const noMessage = fetcher(() => jsonResponse(400, {}));
    await expect(saveHostConfig("http://new.test:8790", noMessage.fetch)).resolves.toEqual({
      ok: false,
      message: "the address could not be saved",
    });

    const rejected = fetcher(() => jsonResponse(200, { ok: false }));
    await expect(saveHostConfig("http://new.test:8790", rejected.fetch)).resolves.toEqual({
      ok: false,
      message: "the address could not be saved",
    });

    const offline = fetcher(() => {
      throw new Error("connection refused");
    });
    await expect(saveHostConfig("http://new.test:8790", offline.fetch)).resolves.toEqual({
      ok: false,
      message: "the address could not be saved",
    });
  });
});

describe("verifyHostConnection", () => {
  it("posts to the verify route and maps a success", async () => {
    const host = fetcher((call) => {
      expect(call).toMatchObject({
        url: VERIFY_PATH,
        method: "POST",
        headers: { "content-type": "application/json" },
      });
      return jsonResponse(200, {
        ok: true,
        tokenSource: "request",
        serverName: "Rembric",
        toolCount: 3,
      });
    });
    await expect(
      verifyHostConnection({ serverUrl: "http://memory.test:8790", token: "tok" }, host.fetch),
    ).resolves.toEqual({ type: "success", tokenSource: "request" });
    expect(JSON.parse(host.calls[0].body)).toEqual({
      serverUrl: "http://memory.test:8790",
      token: "tok",
    });
  });

  it("maps unknown token sources to none", async () => {
    const host = fetcher(() => jsonResponse(200, { ok: true, tokenSource: "mystery" }));
    await expect(
      verifyHostConnection({ serverUrl: "http://memory.test:8790" }, host.fetch),
    ).resolves.toEqual({ type: "success", tokenSource: "none" });
  });

  it("maps a failed check onto the card's failure shape", async () => {
    const host = fetcher(() =>
      jsonResponse(200, {
        ok: false,
        kind: "rejected-token",
        message: "the server rejected the token (HTTP 401)",
      }),
    );
    await expect(
      verifyHostConnection({ serverUrl: "http://memory.test:8790" }, host.fetch),
    ).resolves.toEqual({
      type: "failure",
      kind: "rejected-token",
      message: "the server rejected the token (HTTP 401)",
    });
  });

  it("reports unavailable when the route cannot answer", async () => {
    const broken = fetcher(() => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error("not JSON");
      },
    }));
    await expect(
      verifyHostConnection({ serverUrl: "http://memory.test:8790" }, broken.fetch),
    ).resolves.toEqual({ type: "unavailable" });

    const offline = fetcher(() => {
      throw new Error("connection refused");
    });
    await expect(
      verifyHostConnection({ serverUrl: "http://memory.test:8790" }, offline.fetch),
    ).resolves.toEqual({ type: "unavailable" });
  });
});
