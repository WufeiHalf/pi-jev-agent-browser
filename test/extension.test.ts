import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  assert.ok(tools.includes("jev_browser"));
});

test("Jev delegation reports missing configuration without disclosing credentials", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-jev-empty-config-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    const tools = new Map<string, { execute: (...args: any[]) => Promise<any> }>();
    extension({ registerTool(tool: { name: string }) { tools.set(tool.name, tool as never); }, on() {} } as never);
    const result = await tools.get("jev_browser")?.execute("call", { goal: "Reach the new project form" }, new AbortController().signal, undefined, {});
    assert.equal(result?.details.status, "error");
    assert.match(result?.content[0]?.text ?? "", /config/i);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  }
});
