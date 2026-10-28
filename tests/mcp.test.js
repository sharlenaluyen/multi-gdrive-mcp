import test from "node:test";
import assert from "node:assert/strict";
import { createToolDefiner, jsonResult } from "../src/mcp.js";

// Records registerTool calls the way McpServer would receive them.
function fakeServer() {
  const tools = {};
  return {
    tools,
    registerTool(name, config, handler) {
      tools[name] = { config, handler };
    },
  };
}

test("defineTool refuses a tool with no annotations entry", () => {
  const define = createToolDefiner(fakeServer(), {});
  assert.throws(() => define("mystery", "d", {}, async () => ({})), /no entry in TOOL_ANNOTATIONS/);
});

test("a thrown error becomes an MCP error result instead of escaping", async () => {
  const server = fakeServer();
  const define = createToolDefiner(server, { boom: { readOnlyHint: true } });
  define("boom", "d", {}, async () => {
    throw new Error("Google said no");
  });
  const result = await server.tools.boom.handler({});
  assert.equal(result.isError, true);
  assert.equal(result.content[0].text, "boom failed: Google said no");
  assert.deepEqual(server.tools.boom.config.annotations, { readOnlyHint: true });
});

test("jsonResult wraps an object as pretty-printed text content", () => {
  assert.deepEqual(jsonResult({ a: 1 }), { content: [{ type: "text", text: '{\n  "a": 1\n}' }] });
});
