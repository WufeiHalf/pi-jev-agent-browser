import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import agentBrowserExtension from "pi-agent-browser-native/dist/extensions/agent-browser/index.js";

export default function browserPlugin(pi: ExtensionAPI): void {
  agentBrowserExtension(pi);
}
