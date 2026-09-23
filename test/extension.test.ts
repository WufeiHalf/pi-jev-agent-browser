import assert from "node:assert/strict";
import { test } from "node:test";
import extension from "../src/extension.js";

test("the browser plugin registers the original browser tool once", () => {
  const tools: string[] = [];
  const pi = {
    registerTool(tool: { name: string }) { tools.push(tool.name); },
    on() {},
  };

  extension(pi as never);

  assert.equal(tools.filter(name => name === "agent_browser").length, 1);
  assert.ok(tools.includes("agent_browser_code"));
});
