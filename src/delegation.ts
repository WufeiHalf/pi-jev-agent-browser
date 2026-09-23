import type { ExtensionContext, AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { NativeBrowserHost } from "pi-agent-browser-native/dist/extensions/agent-browser/index.js";
import type { JevConfig } from "./config.js";

interface Ref { role?: string; name?: string }
interface BrowserObservation { url: string; snapshot: string; refs: Record<string, Ref>; sessionName?: string }
interface BrowserTab { tabId: string; active: boolean; url?: string }
interface NativeEnvelope { success: boolean; data?: Record<string, unknown>; summary?: string; sessionName?: string }
interface Decision { operation: string; target?: string; value?: string }
interface SelectOption { ref: string; value: string; label: string }

export interface DelegationResult {
  status: "completed" | "input-required" | "blocked" | "limit" | "cancelled" | "error";
  reason: string;
  steps: number;
  url?: string;
  tabId?: string;
  sessionName?: string;
  recentActions: Array<{ operation: string; target?: string; url?: string; tabId?: string }>;
  jevCalls: number;
  browserCalls: number;
  durationMs: number;
}

const MAX_STEPS = 16;
const MAX_DURATION_MS = 90_000;
const DECISION_TIMEOUT_MS = 25_000;

function textResult(result: AgentToolResult<unknown> & { isError?: boolean }): NativeEnvelope {
  const text = result.content.find(item => item.type === "text")?.text;
  if (!text) throw new Error("Native browser returned no JSON observation");
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error("Native browser returned invalid JSON"); }
  if (!value || typeof value !== "object") throw new Error("Native browser returned invalid observation");
  const envelope = value as NativeEnvelope;
  if (result.isError || envelope.success !== true) throw new Error(envelope.summary || "Native browser command failed");
  return envelope;
}

function observation(envelope: NativeEnvelope): BrowserObservation {
  const data = envelope.data;
  if (!data || typeof data.origin !== "string" || typeof data.snapshot !== "string" || !data.refs || typeof data.refs !== "object") {
    throw new Error("Native snapshot has no current page refs");
  }
  return { url: data.origin, snapshot: data.snapshot, refs: data.refs as Record<string, Ref>, sessionName: envelope.sessionName };
}

function tabs(envelope: NativeEnvelope): BrowserTab[] {
  const values = envelope.data?.tabs;
  if (!Array.isArray(values)) throw new Error("Native browser returned no tab list");
  return values.filter(tab => typeof tab?.tabId === "string") as BrowserTab[];
}

function choice(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "choice" in value && typeof value.choice === "string") return value.choice;
  return undefined;
}

function validateProbabilities(answer: unknown, selected: string | undefined, candidates: Set<string>): void {
  if (!answer || typeof answer !== "object" || !("probabilities" in answer)) return;
  const probabilities = answer.probabilities;
  if (!probabilities || typeof probabilities !== "object" || Array.isArray(probabilities)) throw new Error("Jev returned invalid probabilities");
  const entries = Object.entries(probabilities);
  if (!entries.length || entries.some(([key, value]) => !candidates.has(key) || typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1)) {
    throw new Error("Jev returned invalid probabilities");
  }
  if (!selected || !Object.hasOwn(probabilities, selected)) {
    throw new Error("Jev selected an option missing from its probabilities");
  }
}

function selectOptions(current: BrowserObservation): Record<string, SelectOption> {
  const options: Record<string, SelectOption> = {};
  let currentSelect: { ref: string; name: string; indent: number } | undefined;
  for (const line of current.snapshot.split("\n")) {
    const indent = line.search(/\S/);
    if (indent < 0) continue;
    if (currentSelect && indent <= currentSelect.indent) currentSelect = undefined;
    const ref = line.match(/\bref=(e\d+)\b/)?.[1];
    if (!ref) continue;
    const details = current.refs[ref];
    if (details?.role === "combobox" || details?.role === "listbox") {
      currentSelect = { ref, name: details.name ?? "", indent };
    } else if (details?.role === "option" && currentSelect && details.name) {
      const id = `s${Object.keys(options).length + 1}`;
      options[id] = { ref: currentSelect.ref, value: details.name, label: `${currentSelect.name}: ${details.name}` };
    }
  }
  return options;
}

function readDecision(payload: unknown, candidates: Set<string>, refs: Record<string, Ref>, options: Record<string, SelectOption>): Decision {
  if (!payload || typeof payload !== "object") throw new Error("Jev returned an invalid decision");
  const answers = (payload as { answers?: Record<string, unknown> }).answers;
  const operation = choice(answers?.operation);
  if (!operation || !candidates.has(operation)) throw new Error("Jev selected an unavailable operation");
  validateProbabilities(answers?.operation, operation, candidates);
  const target = operation === "CLICK" ? choice(answers?.click_target) : undefined;
  if (operation === "CLICK" && (!target || !Object.hasOwn(refs, target))) throw new Error("Jev selected a stale or unavailable ref");
  if (operation === "CLICK") validateProbabilities(answers?.click_target, target, new Set(["none_of_the_above", ...Object.keys(refs)]));
  if (operation === "SELECT") {
    const optionId = choice(answers?.select_target);
    if (!optionId || !Object.hasOwn(options, optionId)) throw new Error("Jev selected an unavailable option");
    validateProbabilities(answers?.select_target, optionId, new Set(Object.keys(options)));
    return { operation, target: options[optionId]!.ref, value: options[optionId]!.value };
  }
  return { operation, target };
}

async function decide(config: JevConfig, goal: string, current: BrowserObservation, signal: AbortSignal): Promise<Decision> {
  const refs = Object.fromEntries(Object.entries(current.refs).slice(0, 180));
  const options = Object.fromEntries(Object.entries(selectOptions(current)).filter(([, option]) => Object.hasOwn(refs, option.ref)));
  const operations: Record<string, string> = {
    SCROLL_DOWN: "Scroll down to look for more controls.",
    SCROLL_UP: "Scroll up to look for more controls.",
    WAIT: "Wait briefly for the page to change.",
    DONE: "The requested stopping point is visible now; stop without another action.",
    NEEDS_INPUT: "Text needs to be entered by the calling agent; stop here.",
    BLOCKED: "The goal cannot be safely completed from this page; return control.",
  };
  if (Object.keys(refs).length) operations.CLICK = "Click a current page ref that advances the goal.";
  if (Object.keys(options).length) operations.SELECT = "Choose an existing option in a current dropdown.";
  const questions: Record<string, unknown> = {
    operation: { type: "choice", instructions: "Choose the next browser operation for this goal.", criteria: operations },
  };
  if (operations.CLICK) {
    questions.click_target = {
      type: "choice",
      instructions: "Choose one current ref to click.",
      criteria: {
        none_of_the_above: "No current ref advances the goal.",
        ...Object.fromEntries(Object.entries(refs).map(([ref, info]) => [ref, `${info.role ?? "element"}: ${info.name ?? ""}`])),
      },
    };
  }
  if (operations.SELECT) {
    questions.select_target = {
      type: "choice", instructions: "Choose an observed dropdown option.",
      criteria: Object.fromEntries(Object.entries(options).map(([id, option]) => [id, option.label])),
    };
  }
  const request = { model: config.modelId, state: { goal, url: current.url, snapshot: current.snapshot.slice(0, 18_000), refs }, questions };
  const timeout = AbortSignal.timeout(DECISION_TIMEOUT_MS);
  const response = await fetch(config.baseUrl, {
    method: "POST",
    headers: { authorization: `Bearer ${config.apiKey}`, "content-type": "application/json" },
    body: JSON.stringify(request),
    signal: AbortSignal.any([signal, timeout]),
  });
  if (!response.ok) throw new Error(`Jev provider returned HTTP ${response.status}`);
  let payload: unknown;
  try { payload = await response.json(); } catch { throw new Error("Jev provider returned invalid JSON"); }
  return readDecision(payload, new Set(Object.keys(operations)), refs, options);
}

export async function delegateBrowserGoal(
  host: NativeBrowserHost,
  config: JevConfig,
  goal: string,
  toolCallId: string,
  signal: AbortSignal | undefined,
  ctx: ExtensionContext,
): Promise<DelegationResult> {
  const cancellation = signal ?? new AbortController().signal;
  const deadline = AbortSignal.timeout(MAX_DURATION_MS);
  const executionSignal = AbortSignal.any([cancellation, deadline]);
  let currentUrl: string | undefined;
  let tabId: string | undefined;
  let sessionName: string | undefined;
  const recentActions: DelegationResult["recentActions"] = [];
  const started = Date.now();
  let jevCalls = 0;
  let browserCalls = 0;
  let lastActionSignature: string | undefined;
  let lastActionSnapshot: string | undefined;
  const result = (status: DelegationResult["status"], reason: string): DelegationResult => ({
    status, reason, steps: recentActions.length, url: currentUrl, tabId, sessionName, recentActions,
    jevCalls, browserCalls, durationMs: Date.now() - started,
  });
  const run = async (args: string[]): Promise<NativeEnvelope> => {
    if (executionSignal.aborted) throw new Error("Delegation cancelled");
    browserCalls += 1;
    const outcome = await host.execute({ toolCallId, args: ["--json", ...args], signal: executionSignal, ctx });
    const envelope = textResult(outcome);
    if (sessionName && envelope.sessionName && envelope.sessionName !== sessionName) throw new Error("Native browser session changed during delegation");
    sessionName ??= envelope.sessionName;
    return envelope;
  };
  const refreshLocation = async (): Promise<void> => {
    const active = tabs(await run(["tab", "list"])).find(tab => tab.active);
    if (active) { tabId = active.tabId; currentUrl = active.url ?? currentUrl; }
    const current = observation(await run(["snapshot"]));
    currentUrl = current.url;
  };
  try {
    for (let step = 0; step < MAX_STEPS; step += 1) {
      const beforeTabs = tabs(await run(["tab", "list"]));
      const active = beforeTabs.find(tab => tab.active);
      if (!active) return result("blocked", "No active browser tab");
      if (tabId && active.tabId !== tabId) return result("blocked", "Browser tab changed unexpectedly");
      tabId = active.tabId;
      const current = observation(await run(["snapshot"]));
      currentUrl = current.url;
      jevCalls += 1;
      const decision = await decide(config, goal, current, executionSignal);
      const latestTabs = tabs(await run(["tab", "list"]));
      if (latestTabs.find(tab => tab.active)?.tabId !== tabId
        || latestTabs.some(tab => !beforeTabs.some(prior => prior.tabId === tab.tabId))) {
        return result("blocked", "Browser tabs changed while Jev was deciding");
      }
      const latest = observation(await run(["snapshot"]));
      currentUrl = latest.url;
      if (latest.url !== current.url || latest.snapshot !== current.snapshot) continue;
      if (decision.operation === "DONE") return result("completed", "Jev reached the requested stopping point; calling agent must verify it");
      if (decision.operation === "NEEDS_INPUT") return result("input-required", "Calling agent needs to enter text");
      if (decision.operation === "BLOCKED") return result("blocked", "Jev could not advance the goal");
      const target = decision.target ? current.refs[decision.target] : undefined;
      const signature = `${decision.operation}|${target?.role ?? ""}|${target?.name ?? ""}`;
      if (signature === lastActionSignature && current.snapshot === lastActionSnapshot) {
        return result("blocked", "Jev repeated an action without a page change");
      }
      lastActionSignature = signature;
      lastActionSnapshot = current.snapshot;
      if (decision.operation === "WAIT") await run(["wait", "250"]);
      else if (decision.operation === "CLICK") await run(["click", `@${decision.target}`]);
      else if (decision.operation === "SELECT") await run(["select", `@${decision.target}`, decision.value!]);
      else if (decision.operation === "SCROLL_DOWN") await run(["scroll", "down", "560"]);
      else if (decision.operation === "SCROLL_UP") await run(["scroll", "up", "560"]);
      recentActions.push({ operation: decision.operation, ...(decision.target ? { target: decision.target } : {}), url: current.url, tabId });
      const afterTabs = tabs(await run(["tab", "list"]));
      const newTabs = afterTabs.filter(tab => !beforeTabs.some(old => old.tabId === tab.tabId));
      if (newTabs.length > 1) {
        const activeAfter = afterTabs.find(tab => tab.active);
        if (activeAfter) { tabId = activeAfter.tabId; currentUrl = activeAfter.url ?? currentUrl; }
        return result("blocked", "Multiple new tabs opened; target is ambiguous");
      }
      if (newTabs.length === 1) {
        await run(["tab", newTabs[0]!.tabId]);
        tabId = newTabs[0]!.tabId;
        currentUrl = newTabs[0]!.url;
      }
    }
    if (!executionSignal.aborted) try { await refreshLocation(); } catch {}
    return result("limit", "Jev reached the step limit");
  } catch (error) {
    if (cancellation.aborted) return result("cancelled", "Delegation was cancelled");
    if (deadline.aborted) return result("limit", "Jev reached the time limit");
    try { await refreshLocation(); } catch {}
    return result("error", error instanceof Error ? error.message : "Delegation failed");
  }
}
