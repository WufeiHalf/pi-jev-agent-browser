declare module "pi-agent-browser-native/dist/extensions/agent-browser/index.js" {
  import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

  export default function agentBrowserExtension(
    pi: ExtensionAPI,
    options?: { beforeExecute?: (toolCallId: string, ctx: ExtensionContext) => Promise<void> },
  ): void;
}
