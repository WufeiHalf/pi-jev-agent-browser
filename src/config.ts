import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface JevConfig {
  baseUrl: string;
  apiKey: string;
  modelId: string;
}

export function jevConfigPath(): string {
  return join(getAgentDir(), "pi-jev-agent-browser", "config.json");
}

export async function loadJevConfig(): Promise<JevConfig> {
  const path = jevConfigPath();
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new Error(`Jev config is missing or invalid: ${path}`);
  }
  if (!parsed || typeof parsed !== "object") throw new Error(`Jev config is invalid: ${path}`);
  const { baseUrl, apiKey, modelId } = parsed as Partial<JevConfig>;
  if (![baseUrl, apiKey, modelId].every(value => typeof value === "string" && value.trim())) {
    throw new Error(`Jev config requires baseUrl, apiKey and modelId: ${path}`);
  }
  let url: URL;
  try { url = new URL(baseUrl!); } catch { throw new Error(`Jev config baseUrl is invalid: ${path}`); }
  if (!["http:", "https:"].includes(url.protocol) || url.pathname === "/") {
    throw new Error(`Jev config baseUrl must be a full HTTP endpoint URL: ${path}`);
  }
  return { baseUrl: baseUrl!, apiKey: apiKey!, modelId: modelId! };
}
