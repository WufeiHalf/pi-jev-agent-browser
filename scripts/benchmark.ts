import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const runs = Number(process.argv[2] ?? 3);
assert.ok(Number.isInteger(runs) && runs > 0 && runs <= 10, "runs must be 1..10");
const model = process.env.PI_JEV_BENCHMARK_MODEL ?? "commandcode/deepseek/deepseek-v4-flash";
const thinking = process.env.PI_JEV_BENCHMARK_THINKING;
const provider = process.env.PI_JEV_BENCHMARK_PROVIDER ?? join(getAgentDir(), "npm", "node_modules", "pi-commandcode-provider", "index.ts");
const flow = await readFile(new URL("../test/fixtures/flow.html", import.meta.url), "utf8");
const detail = await readFile(new URL("../test/fixtures/detail.html", import.meta.url), "utf8");
const server = createServer((req, res) => {
  const page = req.url === "/flow.html" ? flow : req.url === "/detail.html" ? detail : undefined;
  if (!page) { res.writeHead(404).end(); return; }
  res.setHeader("content-type", "text/html");
  res.end(page);
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/flow.html`;
const shared = `Run the local project E2E at ${url} using only browser tools. Navigate Projects then New project; enter E2E Demo in #name; click Create. Open details in its new tab, select Engineering in Category, click Show summary. Independently verify with separate agent_browser get commands: get text #result must be E2E Demo, get value #category must be engineering, and get text #summary must be E2E Demo details loaded. Close only this browser session at the end. Reply PASS only if all three checks match; otherwise reply FAIL truthfully.`;
const prompts = {
  direct: `${shared} Use agent_browser directly for every navigation, click, selection, input, and verification; do not use jev_browser.`,
  hybrid: `${shared} Open the page with agent_browser. Delegate one bounded goal to jev_browser: open Projects then New project, stop at the form. You enter #name with agent_browser. Delegate a NEW Jev goal: click Create, stop when E2E Demo is visible. Verify #result yourself. Delegate another NEW Jev goal: open details in the new tab, select Engineering, click Show summary, stop when summary visible. Verify #category and #summary yourself. Jev completion alone is not acceptance.`,
};
type Mode = keyof typeof prompts;
interface ToolEvent { type: string; toolName?: string; args?: { args?: string[] }; result?: { isError?: boolean; details?: { jevCalls?: number; browserCalls?: number; sessionName?: string }; content?: Array<{ type: string; text?: string }> }; message?: { role?: string; content?: Array<{ type: string; text?: string }> } }
async function execute(mode: Mode, index: number) {
  const args = ["--approve", "--no-extensions", "-e", ".", "-e", provider, "--model", model,
    ...(thinking ? ["--thinking", thinking] : []), "--tools", mode === "direct" ? "agent_browser" : "agent_browser,jev_browser", "--no-session", "--mode", "json", prompts[mode]];
  const started = performance.now();
  const child = spawn("pi", args, { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", part => { stdout += part; if (stdout.length > 25_000_000) child.kill(); });
  child.stderr.setEncoding("utf8").on("data", part => { stderr += part; });
  const timeout = setTimeout(() => child.kill(), 180_000);
  const [exitCode] = await once(child, "close") as [number];
  clearTimeout(timeout);
  const elapsedMs = Math.round(performance.now() - started);
  const events = stdout.split("\n").filter(Boolean).flatMap(line => { try { return [JSON.parse(line) as ToolEvent]; } catch { return []; } });
  const starts = events.filter(event => event.type === "tool_execution_start");
  const ends = events.filter(event => event.type === "tool_execution_end");
  const checks: Record<string, boolean> = { result: false, category: false, summary: false };
  for (let i = 0; i < starts.length; i++) {
    const command = starts[i]?.args?.args ?? [];
    const text = ends[i]?.result?.content?.find(item => item.type === "text")?.text ?? "";
    if (ends[i]?.result?.isError === true) continue;
    if (command.includes("#result") && command.includes("get")) checks.result ||= text.includes("E2E Demo");
    if (command.includes("#category") && command.includes("get")) checks.category ||= text.includes("engineering");
    if (command.includes("#summary") && command.includes("get")) checks.summary ||= text.includes("E2E Demo details loaded");
  }
  const jev = ends.filter(event => event.toolName === "jev_browser");
  const parentBrowserCalls = starts.filter(event => event.toolName === "agent_browser").length;
  const final = events.filter(event => event.type === "message_end" && event.message?.role === "assistant").at(-1)?.message?.content?.filter(item => item.type === "text").map(item => item.text).join(" ") ?? "";
  const success = exitCode === 0 && Object.values(checks).every(Boolean);
  const record = { mode, index, success, modelReportedPass: /\bPASS\b/i.test(final), elapsedMs, parentTurns: events.filter(event => event.type === "turn_start").length,
    parentToolCalls: starts.length, jevCalls: jev.reduce((total, event) => total + (event.result?.details?.jevCalls ?? 0), 0),
    browserCalls: parentBrowserCalls + jev.reduce((total, event) => total + (event.result?.details?.browserCalls ?? 0), 0),
    checks, jevStops: jev.map(event => (event.result?.details as { status?: string } | undefined)?.status ?? "unknown"),
    sessionNames: [...new Set(ends.map(event => event.result?.details?.sessionName).filter(Boolean))],
    closed: starts.some((event, i) => event.toolName === "agent_browser" && event.args?.args?.includes("close") && ends[i]?.result?.isError !== true),
    exitCode, stderrPresent: Boolean(stderr.trim()) };
  console.log(JSON.stringify(record));
  return record;
}
try {
  const outputPath = process.env.PI_JEV_BENCHMARK_OUTPUT ?? join("benchmarks", "local-commandcode.json");
  let records: Awaited<ReturnType<typeof execute>>[] = [];
  if (process.env.PI_JEV_BENCHMARK_FRESH !== "1") {
    try {
      const previous = JSON.parse(await readFile(outputPath, "utf8")) as { model: string; thinking?: string; records: typeof records };
      if (previous.model === model && previous.thinking === thinking) records = previous.records.filter(record => record.index <= runs);
    } catch {}
  }
  const save = async () => {
    const output = { fixture: "test/fixtures/flow.html + detail.html", model, thinking, runsPerMode: runs, timingBoundary: "Pi process spawn to close", parentTurns: "Pi turn_start events", browserCalls: "parent agent_browser calls plus delegated native host.execute calls", records };
    await mkdir("benchmarks", { recursive: true });
    await writeFile(outputPath, JSON.stringify(output, null, 2) + "\n");
  };
  for (let i = 0; i < runs; i++) {
    for (const mode of ["direct", "hybrid"] as const) {
      if (records.some(record => record.mode === mode && record.index === i + 1)) continue;
      records.push(await execute(mode, i + 1));
      await save();
    }
  }
  await save();
  console.log(JSON.stringify({ saved: outputPath, directSuccess: records.filter(r => r.mode === "direct" && r.success).length, hybridSuccess: records.filter(r => r.mode === "hybrid" && r.success).length }));
} finally {
  server.closeAllConnections();
  server.close();
}
