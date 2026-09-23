import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, DefaultResourceLoader, SessionManager } from "@earendil-works/pi-coding-agent";

test("Pi loads one browser plugin with both tools", { timeout: 30_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-jev-load-"));
  const loader = new DefaultResourceLoader({
    cwd: process.cwd(),
    agentDir: dir,
    additionalExtensionPaths: [process.cwd()],
  });
  try {
    await loader.reload();
    const { session } = await createAgentSession({ resourceLoader: loader, sessionManager: SessionManager.inMemory() });
    try {
      const names = session.getActiveToolNames();
      assert.equal(names.filter(name => name === "agent_browser").length, 1);
      assert.equal(names.filter(name => name === "jev_browser").length, 1);
      assert.ok(session.getToolDefinition("agent_browser_code"));
    } finally {
      session.dispose();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
