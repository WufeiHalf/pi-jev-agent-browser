import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import agentBrowserExtension from "pi-agent-browser-native/dist/extensions/agent-browser/index.js";
import { loadJevConfig } from "./config.js";
import { delegateBrowserGoal } from "./delegation.js";

export default function browserPlugin(pi: ExtensionAPI): void {
  agentBrowserExtension(pi, {
    onHostReady(host) {
      pi.registerTool({
        name: "jev_browser",
        label: "Jev Browser",
        description: "Delegate one multi-step browser goal on the current page to Jev, then hand control back.",
        parameters: Type.Object({ goal: Type.String() }),
        executionMode: "sequential",
        async execute(toolCallId, { goal }, signal, _onUpdate, ctx) {
          try {
            const config = await loadJevConfig();
            const handoff = await delegateBrowserGoal(host, config, goal, toolCallId, signal, ctx);
            const recent = handoff.recentActions.slice(-6).map(action => `${action.operation}${action.target ? ` @${action.target}` : ""}`).join(", ") || "none";
            return {
              content: [{ type: "text" as const, text: `Jev ${handoff.status}: ${handoff.reason}. Last observed URL: ${handoff.url ?? "unknown"}; tab: ${handoff.tabId ?? "unknown"}; actions: ${handoff.steps} (recent: ${recent}). Calling agent retains E2E acceptance.` }],
              details: handoff,
              isError: handoff.status === "error",
            };
          } catch (error) {
            const message = error instanceof Error ? error.message : "Jev config is invalid";
            return { content: [{ type: "text", text: message }], details: { status: "error", reason: message }, isError: true };
          }
        },
      });
    },
  });
}
