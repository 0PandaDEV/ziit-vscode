import * as vscode from "vscode";
import { log } from "./log";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

const CONFIG_FILE_NAME = ".ziit.cfg";
const CONFIG_FILE_PATH = path.join(os.homedir(), CONFIG_FILE_NAME);

interface ZiitConfig {
  apiKey?: string;
  baseUrl?: string;
  enabled?: boolean;
  statusBarEnabled?: boolean;
  debug?: boolean;
}

const CONFIG_KEYS = [
  { key: "apiKey", default: undefined, iniKey: "api_key" },
  { key: "baseUrl", default: "https://ziit.app", iniKey: "base_url" },
  { key: "enabled", default: true, iniKey: "enabled" },
  { key: "statusBarEnabled", default: true, iniKey: "status_bar_enabled" },
  { key: "debug", default: false, iniKey: "debug" },
];

const KEY_MAPPING = Object.fromEntries(
  CONFIG_KEYS.map(({ iniKey, key }) => [iniKey, key])
);

const INVERSE_KEY_MAPPING = Object.fromEntries(
  CONFIG_KEYS.map(({ iniKey, key }) => [key, iniKey])
);

function parseIni(content: string): ZiitConfig {
  const config: Partial<ZiitConfig> = {};
  const lines = content.split(/\r?\n/);
  let inSettingsSection = false;

  for (const line of lines) {
    const trimmedLine = line.trim();
    if (trimmedLine.startsWith("[settings]")) {
      inSettingsSection = true;
      continue;
    }
    if (
      !inSettingsSection ||
      !trimmedLine ||
      trimmedLine.startsWith("#") ||
      trimmedLine.startsWith(";")
    ) {
      continue;
    }

    const equalsIndex = trimmedLine.indexOf("=");
    if (equalsIndex > 0) {
      const key = trimmedLine.substring(0, equalsIndex).trim();
      const value = trimmedLine.substring(equalsIndex + 1).trim();
      const mappedKey = KEY_MAPPING[key];

      if (mappedKey) {
        if (
          mappedKey === "enabled" ||
          mappedKey === "statusBarEnabled" ||
          mappedKey === "debug"
        ) {
          (config as any)[mappedKey] = value.toLowerCase() === "true";
        } else {
          (config as any)[mappedKey] = value;
        }
      }
    }
  }
  return config;
}

function formatIni(config: ZiitConfig): string {
  let content = "[settings]\n";
  for (const key of Object.keys(config) as Array<keyof ZiitConfig>) {
    const iniKey = INVERSE_KEY_MAPPING[key];
    if (iniKey && config[key] !== undefined) {
      content += `${iniKey} = ${config[key]}\n`;
    }
  }
  return content;
}

async function readConfigFile(): Promise<ZiitConfig> {
  try {
    const content = await fs.readFile(CONFIG_FILE_PATH, "utf-8");
    return parseIni(content);
  } catch (error: any) {
    if (error.code === "ENOENT") {
      throw error;
    } else {
      log(`Error reading config file: ${error.message}`);
      vscode.window.showErrorMessage(
        `Error reading Ziit config file: ${error.message}`
      );
      return {};
    }
  }
}

async function writeConfigFile(config: ZiitConfig): Promise<void> {
  try {
    const contentToWrite = formatIni(config);
    await fs.writeFile(CONFIG_FILE_PATH, contentToWrite);
    log("Config file updated (INI format).");
  } catch (error: any) {
    log(`Error writing config file: ${error.message}`);
    vscode.window.showErrorMessage(
      `Failed to write Ziit config file: ${error.message}`
    );
  }
}

async function getConfigValue<T>(
  key: keyof ZiitConfig,
  defaultValue?: T
): Promise<T | undefined> {
  let fileConfig: ZiitConfig = {};
  try {
    fileConfig = await readConfigFile();
  } catch (error: any) {
    if (error.code !== "ENOENT") {
      log(`Error reading config file in getConfigValue: ${error.message}`);
    }
  }

  if (fileConfig[key] !== undefined) {
    return fileConfig[key] as T | undefined;
  }

  const vscodeConfig = vscode.workspace.getConfiguration("ziit");
  if (defaultValue !== undefined) {
    return vscodeConfig.get<T>(key, defaultValue);
  } else {
    return vscodeConfig.get<T>(key);
  }
}

async function updateConfigValue<T>(
  key: keyof ZiitConfig,
  value: T
): Promise<void> {
  let currentConfig: ZiitConfig = {};
  try {
    currentConfig = await readConfigFile();
  } catch (error: any) {
    if (error.code !== "ENOENT") {
      log(`Error reading config file before update: ${error.message}`);
    }
  }

  const newConfig = { ...currentConfig, [key]: value };
  await writeConfigFile(newConfig);

  await vscode.workspace.getConfiguration("ziit").update(key, value, true);
  log(`${key} updated in config file (INI) and VS Code settings.`);
}

export async function setApiKey(): Promise<void> {
  const apiKey = await vscode.window.showInputBox({
    prompt: "Enter your Ziit API key",
    placeHolder: "API Key",
    password: true,
  });

  if (!apiKey) {
    log("API key setting cancelled");
    return;
  }

  await updateConfigValue("apiKey", apiKey);
  vscode.window.showInformationMessage("Ziit API key has been updated");
}

export async function setBaseUrl(): Promise<void> {
  const currentBaseUrl = await getBaseUrl();

  const baseUrl = await vscode.window.showInputBox({
    prompt: "Enter your Ziit instance URL",
    placeHolder: "https://ziit.app",
    value: currentBaseUrl,
  });

  if (!baseUrl) {
    log("Base URL setting cancelled");
    return;
  }

  await updateConfigValue("baseUrl", baseUrl);
  vscode.window.showInformationMessage("Ziit instance URL has been updated");
}

export async function getApiKey(): Promise<string | undefined> {
  return getConfigValue<string>("apiKey");
}

export async function getBaseUrl(): Promise<string> {
  return (
    (await getConfigValue<string>("baseUrl", "https://ziit.app")) ??
    "https://ziit.app"
  );
}

export async function getEnabled(): Promise<boolean> {
  return (await getConfigValue<boolean>("enabled", true)) ?? true;
}

export async function getStatusBarEnabled(): Promise<boolean> {
  return (await getConfigValue<boolean>("statusBarEnabled", true)) ?? true;
}

export async function getDebug(): Promise<boolean> {
  return (await getConfigValue<boolean>("debug", false)) ?? false;
}

export function getKeystrokeTimeout(): number | undefined {
  return vscode.workspace
    .getConfiguration("ziit")
    .get<number>("keystrokeTimeout");
}

export function setKeystrokeTimeout(timeoutMinutes: number): void {
  vscode.workspace
    .getConfiguration("ziit")
    .update("keystrokeTimeout", timeoutMinutes, true);
  log(
    `Keystroke timeout updated to ${timeoutMinutes} minutes in VS Code settings.`
  );
}

export async function fetchUserSettings(heartbeatManager?: any): Promise<void> {
  const apiKey = await getApiKey();
  const baseUrl = await getBaseUrl();

  if (!apiKey || !baseUrl) {
    log(
      "Can't fetch user settings: missing API key or base URL from config file or VSCode settings."
    );
    return;
  }

  try {
    const url = new URL("/api/external/user", baseUrl);
    const response = await fetch(url.toString(), {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    });

    if (!response.ok) {
      if (response.status === 401) {
        log("Invalid API key detected when fetching user settings");
        if (heartbeatManager?.setApiKeyStatus) {
          heartbeatManager.setApiKeyStatus(false);
        }
      }
      throw new Error(`Error fetching user settings: ${response.statusText}`);
    }

    if (heartbeatManager?.setApiKeyStatus) {
      heartbeatManager.setApiKeyStatus(true);
    }

    const data = await response.json();

    if (data.keystrokeTimeout !== undefined) {
      setKeystrokeTimeout(data.keystrokeTimeout);
      log(
        `Keystroke timeout fetched from API: ${data.keystrokeTimeout} minutes`
      );

      if (heartbeatManager?.updateKeystrokeTimeout) {
        heartbeatManager.updateKeystrokeTimeout(data.keystrokeTimeout);
      }
    }
  } catch (error) {
    if (heartbeatManager?.setOnlineStatus) {
      heartbeatManager.setOnlineStatus(false);
    }
    log(
      `Failed to fetch user settings: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

export async function initializeAndSyncConfig(): Promise<void> {
  log("Initializing or syncing config file (INI) with VS Code settings...");
  let fileConfig: ZiitConfig;
  let fileNeedsCreation = false;

  try {
    fileConfig = await readConfigFile();
    log("Config file found (INI format).");
  } catch (error: any) {
    if (error.code === "ENOENT") {
      log(`Config file not found at ${CONFIG_FILE_PATH}. Will create it.`);
      fileNeedsCreation = true;
      fileConfig = {};
    } else {
      return;
    }
  }

  const vscodeConfig = vscode.workspace.getConfiguration("ziit");

  if (fileNeedsCreation) {
    log("Populating new config file from current VS Code settings...");
    const initialConfig: ZiitConfig = {};
    for (const { key } of CONFIG_KEYS) {
      const value = vscodeConfig.get(key);
      if (value !== undefined) {
        initialConfig[key as keyof ZiitConfig] = value as any;
      }
    }
    await writeConfigFile(initialConfig);
    fileConfig = initialConfig;
    log("Config file created and populated (INI format).");
  }

  log("Syncing VS Code settings FROM config file (INI)...");
  let updated = false;
  for (const { key } of CONFIG_KEYS) {
    const fileValue = fileConfig[key as keyof ZiitConfig];
    const vscodeValue = vscodeConfig.get(key);
    const inspect = vscodeConfig.inspect(key);

    if (fileValue !== undefined) {
      if (vscodeValue !== fileValue) {
        await vscodeConfig.update(key, fileValue, true);
        log(`Synced VS Code setting '${key}' from config file value.`);
        updated = true;
      }
    } else {
      const defaultValue = inspect?.defaultValue;
      if (vscodeValue !== undefined && vscodeValue !== defaultValue) {
        await vscodeConfig.update(key, undefined, true);
        log(
          `Reset VS Code setting '${key}' to default as it's not in config file.`
        );
        updated = true;
      }
    }
  }

  if (updated) {
    log("VS Code settings synced.");
  } else {
    log("No VS Code settings needed syncing.");
  }
}
