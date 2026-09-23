import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import extension from "../src/extension.js";

const cwd = await mkdtemp(join(tmpdir(), "pi-jev-live-"));
const flow = await readFile(new URL("../test/fixtures/flow.html", import.meta.url), "utf8");
const detail = await readFile(new URL("../test/fixtures/detail.html", import.meta.url), "utf8");
const server = createServer((req, res) => {
  const page = req.url === "/flow" ? flow : req.url === "/detail.html" ? detail : undefined;
  if (!page) { res.writeHead(404).end(); return; }
  res.setHeader("content-type", "text/html");
  res.end(page);
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const port = (server.address() as { port: number }).port;
const tools = new Map<string, ToolDefinition>();
const branch = [{ type: "message", message: { role: "user", content: "E2E the local project flow." } }];
extension({
  registerTool(tool: ToolDefinition) { tools.set(tool.name, tool); },
  on() { return () => {}; },
  appendEntry() {},
  getActiveTools() { return [...tools.keys()]; },
  getAllTools() { return [...tools.values()].map(tool => ({ ...tool, sourceInfo: { source: "live-e2e" } })); },
  getCommands() { return []; },
  events: { emit() {}, on() { return () => {}; } },
} as never);
const ctx = {
  cwd,
  isProjectTrusted: () => true,
  sessionManager: {
    getSessionId: () => `pi-jev-live-${cwd.split("/").at(-1)}`,
    getSessionDir: () => cwd,
    getSessionFile: () => undefined,
    getBranch: () => branch,
    getEntries: () => branch,
    buildSessionProjection: () => ({ messages: branch.map(entry => entry.message) }),
  },
} as unknown as ExtensionContext;
async function call(name: string, params: object) {
  const tool = tools.get(name);
  assert.ok(tool, `Tool not registered: ${name}`);
  return tool.execute(name, params, new AbortController().signal, undefined, ctx);
}
function text(result: Awaited<ReturnType<typeof call>>): string {
  return result.content.find(item => item.type === "text")?.text ?? "";
}
function handoff(result: Awaited<ReturnType<typeof call>>) {
  const details = result.details as { status: string; reason: string; steps: number; sessionName?: string; url?: string; tabId?: string; durationMs: number; jevCalls: number; browserCalls: number; recentActions: unknown[] };
  console.log(JSON.stringify({ status: details.status, reason: details.reason, steps: details.steps, sessionName: details.sessionName, url: details.url, tabId: details.tabId, durationMs: details.durationMs, jevCalls: details.jevCalls, browserCalls: details.browserCalls, actions: details.recentActions }));
  return details;
}
const started = performance.now();
let parentCalls = 0;
let jevCalls = 0;
let browserCalls = 0;
let close: (() => Promise<unknown>) | undefined;
try {
  const opened = await call("agent_browser", { args: ["open", `http://127.0.0.1:${port}/flow`] });
  parentCalls += 1;
  assert.notEqual((opened as typeof opened & { isError?: boolean }).isError, true, text(opened));
  close = () => call("agent_browser", { args: ["close"] });
  const session = (opened.details as { sessionName?: string }).sessionName;
  for (const [goal, acceptable] of [
    ["From the dashboard, open Projects, then New project, and stop at the project-name form without entering text.", ["completed", "input-required"]],
    ["After the calling agent entered the name, click Create and stop once the created project name is visible.", ["completed"]],
    ["Open project details in the new tab, select Engineering in Category, click Show summary, and stop when the summary is visible.", ["completed"]],
  ] as const) {
    if (goal.startsWith("After")) {
      const filled = await call("agent_browser", { args: ["fill", "#name", "E2E Demo"] });
      parentCalls += 1;
      assert.notEqual((filled as typeof filled & { isError?: boolean }).isError, true, text(filled));
    }
    const result = await call("jev_browser", { goal });
    const details = handoff(result);
    jevCalls += details.jevCalls ?? 0;
    browserCalls += details.browserCalls ?? 0;
    if (!acceptable.includes(details.status as never)) {
      const inspection = await call("agent_browser", { args: ["--json", "snapshot"] });
      const page = JSON.parse(text(inspection)) as { data?: { snapshot?: string } };
      console.log(JSON.stringify({ fixtureSnapshotAtHandoff: page.data?.snapshot }));
    }
    assert.ok(acceptable.includes(details.status as never), `Jev stopped: ${details.status}: ${details.reason}`);
    assert.equal(details.sessionName, session, "browser session changed during Jev delegation");
    if (goal.startsWith("From")) {
      const form = await call("agent_browser", { args: ["--json", "get", "count", "#name"] });
      parentCalls += 1;
      assert.match(text(form), /1/);
    } else if (goal.startsWith("After")) {
      const accepted = await call("agent_browser", { args: ["--json", "get", "text", "#result"] });
      parentCalls += 1;
      assert.match(text(accepted), /E2E Demo/);
    } else {
      const summary = await call("agent_browser", { args: ["--json", "get", "text", "#summary"] });
      parentCalls += 1;
      assert.match(text(summary), /E2E Demo details loaded/);
      const category = await call("agent_browser", { args: ["--json", "get", "value", "#category"] });
      parentCalls += 1;
      assert.match(text(category), /engineering/);
    }
  }
  console.log(JSON.stringify({ success: true, elapsedMs: Math.round(performance.now() - started), parentToolCalls: parentCalls, jevCalls, delegatedBrowserCalls: browserCalls }));
} finally {
  try { await close?.(); } catch {}
  server.closeAllConnections();
  server.close();
  await rm(cwd, { recursive: true, force: true });
}
