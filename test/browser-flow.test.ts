import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import extension from "../src/extension.js";

function browserHarness(cwd: string) {
  const tools = new Map<string, ToolDefinition>();
  const branch = [{ type: "message", message: { role: "user", content: "Route to the new project form." } }];
  const pi = {
    registerTool(tool: ToolDefinition) { tools.set(tool.name, tool); },
    on() { return () => {}; },
    appendEntry() {},
    getActiveTools() { return [...tools.keys()]; },
    getAllTools() { return [...tools.values()].map(tool => ({ ...tool, sourceInfo: { source: "test" } })); },
    getCommands() { return []; },
    events: { emit() {}, on() { return () => {}; } },
  };
  extension(pi as never);
  const ctx = {
    cwd,
    isProjectTrusted: () => true,
    sessionManager: {
      getSessionId: () => `pi-jev-${cwd.split("/").at(-1)}`, 
      getSessionDir: () => cwd,
      getSessionFile: () => undefined,
      getBranch: () => branch,
      getEntries: () => branch,
      buildSessionProjection: () => ({ messages: branch.map(entry => entry.message) }),
    },
  } as unknown as ExtensionContext;
  async function call(name: string, params: object, signal = new AbortController().signal) {
    const tool = tools.get(name);
    assert.ok(tool, `missing ${name}`);
    return tool.execute(name, params, signal, undefined, ctx);
  }
  return { call };
}

test("calling agent delegates a multi-step goal and takes over the same browser", { timeout: 120_000 }, async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-jev-flow-"));
  const agentDir = join(cwd, "agent");
  const previous = process.env.PI_CODING_AGENT_DIR;
  const observed: string[] = [];
  const receivedGoals: string[] = [];
  const createSnapshots: string[] = [];
  const html = await readFile(new URL("./fixtures/flow.html", import.meta.url), "utf8");
  const detailHtml = await readFile(new URL("./fixtures/detail.html", import.meta.url), "utf8");
  const server = createServer(async (req, res) => {
    if (req.url === "/flow") { res.setHeader("content-type", "text/html"); res.end(html); return; }
    if (req.url === "/detail.html") { res.setHeader("content-type", "text/html"); res.end(detailHtml); return; }
    if (req.url !== "/jev") { res.writeHead(404).end(); return; }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString()) as { state: { goal: string; snapshot: string; refs: Record<string, { name: string }>; recentActions?: unknown[] }; questions: { select_target?: { criteria: Record<string, string> } } };
    const names = Object.values(body.state.refs).map(ref => ref.name?.trim());
    observed.push(names.join(","));
    receivedGoals.push(body.state.goal);
    if (body.state.goal.includes("Create")) createSnapshots.push(body.state.snapshot);
    const needsSelection = body.state.goal.includes("details") && names.includes("Category") && body.state.snapshot.includes(": Choose category");
    const targetName = body.state.goal.includes("details")
      ? body.state.snapshot.includes('StaticText "E2E Demo details loaded"') ? undefined
        : names.includes("Show summary") ? "Show summary" : "Open details"
      : body.state.goal.includes("Create")
      ? body.state.snapshot.includes('- paragraph\n  - StaticText "E2E Demo"') ? undefined : "Create"
      : names.includes("New project") && body.state.recentActions?.length === 1 ? "Projects"
      : names.includes("New project") && !names.includes("Project name") ? "New project"
      : names.includes("Projects") && !names.includes("New project") ? "Projects" : undefined;
    const target = Object.entries(body.state.refs).find(([, ref]) => ref.name === targetName)?.[0];
    const operation = body.state.goal.includes("Fill") ? "NEEDS_INPUT" : needsSelection ? "SELECT" : target ? "CLICK" : "DONE";
    const selectChoice = Object.entries(body.questions.select_target?.criteria ?? {}).find(([, label]) => label.includes("Engineering"))?.[0];
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ answers: { operation: { choice: operation, probabilities: { [operation]: 0.2, BLOCKED: 0.8 } },
      click_target: target ? { choice: target, probabilities: { [target]: 0.2, none_of_the_above: 0.8 } } : undefined,
      select_target: needsSelection ? { choice: selectChoice, probabilities: { [selectChoice!]: 0.2, s1: 0.8 } } : undefined } }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    await mkdir(join(agentDir, "pi-jev-agent-browser"), { recursive: true });
    await writeFile(join(agentDir, "pi-jev-agent-browser", "config.json"), JSON.stringify({ baseUrl: `http://127.0.0.1:${port}/jev`, apiKey: "test-key", modelId: "test-jev" }));
    const { call } = browserHarness(cwd);
    const page = await call("agent_browser", { args: ["open", `http://127.0.0.1:${port}/flow`] });
    assert.notEqual((page as typeof page & { isError?: boolean }).isError, true, JSON.stringify(page.content));
    const delegated = await call("jev_browser", { goal: "Navigate to the new project form and stop" });
    assert.equal((delegated.details as { status?: string }).status, "completed", `${JSON.stringify(delegated.content)} observations=${JSON.stringify(observed)}`);
    assert.ok(observed.length >= 3, `expected multiple decisions: ${observed.join(";")}`);
    const metrics = delegated.details as { jevCalls?: number; browserCalls?: number; durationMs?: number };
    assert.equal(metrics.jevCalls, observed.length);
    assert.equal((delegated.details as { sessionName?: string }).sessionName, (page.details as { sessionName?: string }).sessionName);
    assert.ok((metrics.browserCalls ?? 0) > metrics.jevCalls!);
    assert.ok((metrics.durationMs ?? 0) > 0);
    const input = await call("jev_browser", { goal: "Fill the project name" });
    assert.equal((input.details as { status?: string }).status, "input-required");
    const takeover = await call("agent_browser", { args: ["--json", "snapshot", "-i"] });
    const snapshot = JSON.parse(takeover.content[0]?.type === "text" ? takeover.content[0].text : "{}");
    const field = Object.entries(snapshot.data.refs as Record<string, { role: string }>).find(([, ref]) => ref.role === "textbox")?.[0];
    assert.ok(field, "calling agent can see the form field");
    const filled = await call("agent_browser", { args: ["fill", `@${field}`, "E2E Demo"] });
    assert.notEqual((filled as typeof filled & { isError?: boolean }).isError, true);
    const second = await call("jev_browser", { goal: "Create the project and stop when E2E Demo appears" });
    assert.equal((second.details as { status?: string }).status, "completed", `${JSON.stringify(second.content)} snapshots=${JSON.stringify(createSnapshots)}`);
    assert.equal(receivedGoals.filter(goal => goal.includes("Navigate")).length, 4);
    assert.doesNotMatch(observed[2] ?? "", /Projects/, "stalled click must not be offered again");
    assert.ok(receivedGoals.filter(goal => goal.includes("Create")).length >= 2);
    const accepted = await call("agent_browser", { args: ["--json", "get", "text", "#result"] });
    assert.match(accepted.content[0]?.type === "text" ? accepted.content[0].text : "", /E2E Demo/);
    const third = await call("jev_browser", { goal: "Open details in a new tab, select Engineering category, show summary and stop" });
    assert.equal((third.details as { status?: string }).status, "completed", JSON.stringify(third.content));
    const detail = await call("agent_browser", { args: ["--json", "get", "text", "#summary"] });
    assert.match(detail.content[0]?.type === "text" ? detail.content[0].text : "", /E2E Demo details loaded/);
    const category = await call("agent_browser", { args: ["--json", "get", "value", "#category"] });
    assert.match(category.content[0]?.type === "text" ? category.content[0].text : "", /engineering/);
    await call("agent_browser", { args: ["close"] });
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    server.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("repeated Jev clicks stop and hand control back before the step limit", { timeout: 120_000 }, async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-jev-stuck-"));
  const agentDir = join(cwd, "agent");
  const previous = process.env.PI_CODING_AGENT_DIR;
  let closeBrowser: (() => Promise<unknown>) | undefined;
  let decisions = 0;
  const html = '<!doctype html><html><body><button onclick="void 0">Projects</button></body></html>';
  const server = createServer(async (req, res) => {
    if (req.url === "/flow") { res.setHeader("content-type", "text/html"); res.end(html); return; }
    if (req.url !== "/jev") { res.writeHead(404).end(); return; }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const { state } = JSON.parse(Buffer.concat(chunks).toString()) as { state: { refs: Record<string, { name: string }> } };
    decisions++;
    const target = Object.entries(state.refs).find(([, ref]) => ref.name === "Projects")?.[0];
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ answers: { operation: { choice: "CLICK" }, click_target: { choice: target } } }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    await mkdir(join(agentDir, "pi-jev-agent-browser"), { recursive: true });
    await writeFile(join(agentDir, "pi-jev-agent-browser", "config.json"), JSON.stringify({ baseUrl: `http://127.0.0.1:${port}/jev`, apiKey: "test-key", modelId: "test-jev" }));
    const { call } = browserHarness(cwd);
    closeBrowser = () => call("agent_browser", { args: ["close"] });
    await call("agent_browser", { args: ["open", `http://127.0.0.1:${port}/flow`] });
    const stuck = await call("jev_browser", { goal: "Get to the project form" });
    assert.equal((stuck.details as { status?: string }).status, "blocked", JSON.stringify(stuck.content));
    assert.ok(decisions < 16, `Jev was asked ${decisions} times`);
    const takeover = await call("agent_browser", { args: ["--json", "get", "url"] });
    assert.match(takeover.content[0]?.type === "text" ? takeover.content[0].text : "", /\/flow/);
  } finally {
    try { await closeBrowser?.(); } catch {}
    server.closeAllConnections();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    server.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("Stop cancels a waiting Jev decision and the calling agent keeps the page", { timeout: 120_000 }, async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-jev-stop-"));
  const agentDir = join(cwd, "agent");
  const previous = process.env.PI_CODING_AGENT_DIR;
  const html = await readFile(new URL("./fixtures/flow.html", import.meta.url), "utf8");
  let notifyDecision!: () => void;
  const decisionStarted = new Promise<void>(resolve => { notifyDecision = resolve; });
  const server = createServer((req, res) => {
    if (req.url === "/flow") { res.setHeader("content-type", "text/html"); res.end(html); return; }
    if (req.url === "/jev") { notifyDecision(); return; }
    res.writeHead(404).end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  let closeBrowser: (() => Promise<unknown>) | undefined;
  try {
    await mkdir(join(agentDir, "pi-jev-agent-browser"), { recursive: true });
    await writeFile(join(agentDir, "pi-jev-agent-browser", "config.json"), JSON.stringify({ baseUrl: `http://127.0.0.1:${port}/jev`, apiKey: "test-key", modelId: "test-jev" }));
    const { call } = browserHarness(cwd);
    closeBrowser = () => call("agent_browser", { args: ["close"] });
    await call("agent_browser", { args: ["open", `http://127.0.0.1:${port}/flow`] });
    const controller = new AbortController();
    const delegated = call("jev_browser", { goal: "Reach the new project form" }, controller.signal);
    await decisionStarted;
    controller.abort();
    const stopped = await delegated;
    assert.equal((stopped.details as { status?: string }).status, "cancelled", JSON.stringify(stopped.content));
    const page = await call("agent_browser", { args: ["--json", "snapshot", "-i"] });
    assert.match(page.content[0]?.type === "text" ? page.content[0].text : "", /Projects/);
    assert.doesNotMatch(page.content[0]?.type === "text" ? page.content[0].text : "", /New project/);
  } finally {
    try { await closeBrowser?.(); } catch {}
    server.closeAllConnections();
    server.close();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(cwd, { recursive: true, force: true });
  }
});

test("invalid Jev refs and provider failures hand the unchanged page back", { timeout: 120_000 }, async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-jev-bad-choice-"));
  const agentDir = join(cwd, "agent");
  const previous = process.env.PI_CODING_AGENT_DIR;
  const html = await readFile(new URL("./fixtures/flow.html", import.meta.url), "utf8");
  let failureMode: "bad-ref" | "bad-probability" | "unsupported" | "http" = "bad-ref";
  const server = createServer((req, res) => {
    if (req.url === "/flow") { res.setHeader("content-type", "text/html"); res.end(html); return; }
    if (req.url !== "/jev") { res.writeHead(404).end(); return; }
    if (failureMode === "http") { res.writeHead(503).end("provider unavailable"); return; }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ answers: failureMode === "bad-probability"
      ? { operation: { choice: "CLICK", probabilities: { CLICK: -1 } } }
      : failureMode === "unsupported" ? { operation: { choice: "TYPE" } }
      : { operation: { choice: "CLICK" }, click_target: { choice: "e999999" } } }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  let closeBrowser: (() => Promise<unknown>) | undefined;
  try {
    await mkdir(join(agentDir, "pi-jev-agent-browser"), { recursive: true });
    await writeFile(join(agentDir, "pi-jev-agent-browser", "config.json"), JSON.stringify({ baseUrl: `http://127.0.0.1:${port}/jev`, apiKey: "test-key", modelId: "test-jev" }));
    const { call } = browserHarness(cwd);
    closeBrowser = () => call("agent_browser", { args: ["close"] });
    await call("agent_browser", { args: ["open", `http://127.0.0.1:${port}/flow`] });
    const invalid = await call("jev_browser", { goal: "Reach the project form" });
    assert.equal((invalid.details as { status?: string }).status, "error");
    assert.match(invalid.content[0]?.type === "text" ? invalid.content[0].text : "", /unavailable ref/);
    failureMode = "bad-probability";
    const probability = await call("jev_browser", { goal: "Reach the project form" });
    assert.equal((probability.details as { status?: string }).status, "error");
    assert.match(probability.content[0]?.type === "text" ? probability.content[0].text : "", /probabilit/);
    failureMode = "unsupported";
    const unsupported = await call("jev_browser", { goal: "Reach the project form" });
    assert.equal((unsupported.details as { status?: string }).status, "error");
    assert.equal((unsupported.details as { steps?: number }).steps, 0);
    failureMode = "http";
    const failed = await call("jev_browser", { goal: "Reach the project form" });
    assert.equal((failed.details as { status?: string }).status, "error");
    assert.match(failed.content[0]?.type === "text" ? failed.content[0].text : "", /HTTP 503/);
    assert.doesNotMatch(JSON.stringify([invalid, probability, unsupported, failed]), /test-key/);
    const page = await call("agent_browser", { args: ["--json", "snapshot", "-i"] });
    assert.match(page.content[0]?.type === "text" ? page.content[0].text : "", /Projects/);
    assert.doesNotMatch(page.content[0]?.type === "text" ? page.content[0].text : "", /New project/);
  } finally {
    try { await closeBrowser?.(); } catch {}
    server.closeAllConnections();
    server.close();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(cwd, { recursive: true, force: true });
  }
});

test("an external tab change during Jev's decision stops before clicking", { timeout: 120_000 }, async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-jev-tab-drift-"));
  const agentDir = join(cwd, "agent");
  const previous = process.env.PI_CODING_AGENT_DIR;
  const html = await readFile(new URL("./fixtures/flow.html", import.meta.url), "utf8");
  let changeTarget: (() => Promise<unknown>) | undefined;
  let terminalMode = false;
  const server = createServer(async (req, res) => {
    if (req.url === "/flow") { res.setHeader("content-type", "text/html"); res.end(html); return; }
    if (req.url === "/changed") { res.setHeader("content-type", "text/html"); res.end('<h1>Changed page</h1>'); return; }
    if (req.url !== "/jev") { res.writeHead(404).end(); return; }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const { state } = JSON.parse(Buffer.concat(chunks).toString()) as { state: { url: string; refs: Record<string, { name: string }> } };
    if (!state.url.endsWith("/changed")) await changeTarget?.();
    const target = Object.entries(state.refs).find(([, ref]) => ref.name === "Projects")?.[0];
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ answers: { operation: { choice: terminalMode ? state.url.endsWith("/changed") ? "BLOCKED" : "DONE" : "CLICK" }, click_target: { choice: target } } }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  let closeBrowser: (() => Promise<unknown>) | undefined;
  try {
    await mkdir(join(agentDir, "pi-jev-agent-browser"), { recursive: true });
    await writeFile(join(agentDir, "pi-jev-agent-browser", "config.json"), JSON.stringify({ baseUrl: `http://127.0.0.1:${port}/jev`, apiKey: "test-key", modelId: "test-jev" }));
    const { call } = browserHarness(cwd);
    closeBrowser = async () => { await call("agent_browser", { args: ["tab", "close"] }); await call("agent_browser", { args: ["close"] }); };
    changeTarget = () => call("agent_browser", { args: ["tab", "new"] });
    await call("agent_browser", { args: ["open", `http://127.0.0.1:${port}/flow`] });
    const delegated = await call("jev_browser", { goal: "Reach the project form" });
    assert.equal((delegated.details as { status?: string }).status, "blocked", JSON.stringify(delegated.content));
    assert.equal((delegated.details as { steps?: number }).steps, 0);
    await call("agent_browser", { args: ["open", `http://127.0.0.1:${port}/flow`] });
    changeTarget = () => call("agent_browser", { args: ["open", `http://127.0.0.1:${port}/changed`] });
    const stale = await call("jev_browser", { goal: "Reach the project form" });
    assert.equal((stale.details as { steps?: number }).steps, 0, JSON.stringify(stale.content));
    assert.ok(["blocked", "error"].includes((stale.details as { status: string }).status));
    assert.match((stale.details as { url?: string }).url ?? "", /\/changed/);
    const page = await call("agent_browser", { args: ["--json", "get", "url"] });
    assert.match(page.content[0]?.type === "text" ? page.content[0].text : "", /\/changed/);
    await call("agent_browser", { args: ["open", `http://127.0.0.1:${port}/flow`] });
    terminalMode = true;
    const staleDone = await call("jev_browser", { goal: "Reach the project form" });
    assert.equal((staleDone.details as { status?: string }).status, "blocked", JSON.stringify(staleDone.content));
    assert.match((staleDone.details as { url?: string }).url ?? "", /\/changed/);
  } finally {
    try { await closeBrowser?.(); } catch {}
    server.closeAllConnections();
    server.close();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(cwd, { recursive: true, force: true });
  }
});
