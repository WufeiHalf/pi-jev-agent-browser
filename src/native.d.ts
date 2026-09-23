declare module "pi-agent-browser-native/dist/extensions/agent-browser/index.js" {
  import type { ExtensionAPI, ExtensionContext, AgentToolResult } from "@earendil-works/pi-coding-agent";

  export interface NativeBrowserHost {
    execute(input: {
      toolCallId: string;
      args: string[];
      signal: AbortSignal | undefined;
      ctx: ExtensionContext;
    }): Promise<AgentToolResult<unknown> & { isError?: boolean }>;
  }

  export default function agentBrowserExtension(
    pi: ExtensionAPI,
    options?: {
      beforeExecute?: (toolCallId: string, ctx: ExtensionContext) => Promise<void>;
      onHostReady?: (host: NativeBrowserHost) => void;
    },
  ): void;
}
