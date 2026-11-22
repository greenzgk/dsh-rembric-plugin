// test/description-rewrite.test.mjs — Regression tests for the description
// rewriter exported from host.js.
//
// The bug: the rewriter stringified ANY value sitting under a `description`
// key, so the JSON-Schema object of the `description` PARAMETER of
// memory.session_start became the string "[object Object]" and DeepSeek
// rejected the whole function schema ("[object Object]" is not of types
// "boolean", "object"). The fix: only string values under `description` are
// rewritten; every non-string value passes through untouched.
//
// Contract under test: input tree -> output tree of the exported pure
// functions. Expected values are literals, never recomputed by the code
// under test.

import { describe, it, expect } from "vite-plus/test";

import { renameToolsInDescriptions, underscoreToolNames } from "../host.js";
import { underscoreToolNames as underscoreFromCore } from "../session-core.js";

// ============================================================================
// [A] The session-start bug: an object under a `description` key
// ============================================================================
describe("[A] object under a `description` key (session-start case)", () => {
  it("passes through byte-identical", () => {
    // Shape of memory.session_start's inputSchema: the tool has a PARAMETER
    // literally named `description` whose value is a JSON-Schema object.
    const input = {
      type: "object",
      properties: {
        title: { type: "string", description: "Session title" },
        description: {
          type: "object",
          description: "Structured session description payload",
          properties: {
            goal: { type: "string" },
            decisions: { type: "array", items: { type: "string" } },
          },
          required: ["goal"],
        },
      },
      required: ["title", "description"],
    };
    const output = renameToolsInDescriptions(input);
    expect(output).toEqual(input);
    expect(typeof output.properties.description).toBe("object");
    expect(JSON.stringify(output)).toBe(JSON.stringify(input));
  });
});

// ============================================================================
// [B] String `description` values keep getting the dotted -> underscored rewrite
// ============================================================================
describe("[B] string `description` values get the rewrite", () => {
  it("rewrites dotted tool names inside a string description", () => {
    const input = {
      description: "Call memory.save after decisions; use project.bind first.",
    };
    const output = renameToolsInDescriptions(input);
    expect(output).toEqual({
      description: "Call memory_save after decisions; use project_bind first.",
    });
  });

  it("rewrites a string description nested inside a schema object", () => {
    const input = {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search terms for memory.search",
        },
      },
    };
    const output = renameToolsInDescriptions(input);
    expect(output).toEqual({
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search terms for memory_search",
        },
      },
    });
  });
});

// ============================================================================
// [C] Nested objects and arrays recurse correctly
// ============================================================================
describe("[C] nested objects and arrays recurse", () => {
  it("rewrites string descriptions at every depth, inside arrays too", () => {
    const input = {
      description: "Top level: memory.context",
      anyOf: [
        {
          description: "Variant one: project.bind",
          items: [
            { description: "Deep item: memory.session_get_batch" },
            { title: "memory.save stays in non-description keys" },
          ],
        },
        { description: "Variant two: memory.learnings" },
      ],
    };
    const output = renameToolsInDescriptions(input);
    expect(output).toEqual({
      description: "Top level: memory_context",
      anyOf: [
        {
          description: "Variant one: project_bind",
          items: [
            { description: "Deep item: memory_session_get_batch" },
            { title: "memory.save stays in non-description keys" },
          ],
        },
        { description: "Variant two: memory_learnings" },
      ],
    });
  });

  it("an array directly under `description` passes through untouched", () => {
    const input = {
      description: ["memory.save", "project.bind"],
    };
    const output = renameToolsInDescriptions(input);
    expect(output).toEqual({
      description: ["memory.save", "project.bind"],
    });
  });
});

// ============================================================================
// [D] Keys other than `description` are never rewritten
// ============================================================================
describe("[D] keys other than `description` are untouched", () => {
  it("dotted names in other string keys pass through unchanged", () => {
    const input = {
      title: "memory.save helper",
      summary: "wraps project.bind and memory.search",
      example: "call memory.session_start",
    };
    const output = renameToolsInDescriptions(input);
    expect(output).toEqual({
      title: "memory.save helper",
      summary: "wraps project.bind and memory.search",
      example: "call memory.session_start",
    });
  });

  it("a key merely starting with `description` is not rewritten", () => {
    const input = {
      descriptionExtra: "memory.save stays dotted here",
      descriptions: "project.bind stays dotted here",
    };
    const output = renameToolsInDescriptions(input);
    expect(output).toEqual({
      descriptionExtra: "memory.save stays dotted here",
      descriptions: "project.bind stays dotted here",
    });
  });
});

// ============================================================================
// [E] null / undefined and other non-string values
// ============================================================================
describe("[E] null / undefined and other non-string values", () => {
  it("null input returns null", () => {
    expect(renameToolsInDescriptions(null)).toBeNull();
  });

  it("undefined input returns undefined", () => {
    expect(renameToolsInDescriptions(undefined)).toBeUndefined();
  });

  it("null under `description` passes through untouched (not coerced to a string)", () => {
    const output = renameToolsInDescriptions({ description: null });
    expect(output).toEqual({ description: null });
    expect(typeof output.description).toBe("object");
  });

  it("undefined under `description` passes through untouched", () => {
    const output = renameToolsInDescriptions({ description: undefined });
    expect("description" in output).toBe(true);
    expect(output.description).toBeUndefined();
  });

  it("numbers and booleans under `description` pass through untouched", () => {
    expect(renameToolsInDescriptions({ description: 42 })).toEqual({ description: 42 });
    expect(renameToolsInDescriptions({ description: true })).toEqual({ description: true });
  });
});

// ============================================================================
// [F] underscoreToolNames — the string-level rewrite helper
// ============================================================================
describe("[F] underscoreToolNames", () => {
  it("rewrites dotted memory/project names to underscored", () => {
    expect(underscoreToolNames("call memory.save now")).toBe("call memory_save now");
    expect(underscoreToolNames("memory.session_start")).toBe("memory_session_start");
    expect(underscoreToolNames("project.bind")).toBe("project_bind");
  });

  it("rewrites every occurrence in one string", () => {
    expect(underscoreToolNames("memory.search then memory.context then project.list")).toBe(
      "memory_search then memory_context then project_list",
    );
  });

  it("leaves text without dotted memory/project names unchanged", () => {
    expect(underscoreToolNames("plain text, foo.bar, Memory.save")).toBe(
      "plain text, foo.bar, Memory.save",
    );
  });

  it("null and undefined become the empty string", () => {
    expect(underscoreToolNames(null)).toBe("");
    expect(underscoreToolNames(undefined)).toBe("");
  });
});

// ============================================================================
// [G] session-core is the single source of truth for the rewrite
// ============================================================================
describe("[G] session-core:underscoreToolNames is the one implementation", () => {
  it("host re-exports the very same function object (no second copy)", () => {
    expect(underscoreToolNames).toBe(underscoreFromCore);
  });

  it("null and undefined become the empty string", () => {
    expect(underscoreFromCore(null)).toBe("");
    expect(underscoreFromCore(undefined)).toBe("");
  });

  it("a second segment may start with an underscore", () => {
    expect(underscoreFromCore("memory._private_tool")).toBe("memory__private_tool");
  });

  it("a trailing word boundary leaves names glued to uppercase text alone", () => {
    // Without the trailing \b the old core regex matched "memory.foo" inside
    // "memory.fooBar" and produced "memory_fooBar".
    expect(underscoreFromCore("memory.fooBar")).toBe("memory.fooBar");
  });

  it("rewrites dotted memory/project names to underscored", () => {
    expect(underscoreFromCore("call memory.save now")).toBe("call memory_save now");
    expect(underscoreFromCore("memory.session_start")).toBe("memory_session_start");
    expect(underscoreFromCore("project.bind")).toBe("project_bind");
  });
});
