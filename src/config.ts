import * as vscode from "vscode";
import { log } from "./log";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

const CONFIG_FILE_NAME = ".ziit.json";
const CONFIG_FILE_PATH = path.join(os.homedir(), CONFIG_FILE_NAME);
const OLD_CONFIG_FILE_NAME = ".ziit.cfg";
const OLD_CONFIG_FILE_PATH = path.join(os.homedir(), OLD_CONFIG_FILE_NAME);

interface ZiitConfig {
  apiKey?: string;
  baseUrl?: string;
}

async function migrateOldConfigIfNeeded() {
  try {
    await fs.access(OLD_CONFIG_FILE_PATH);
    const content = await fs.readFile(OLD_CONFIG_FILE_PATH, "utf-8");
    let apiKey: string | undefined;
    let baseUrl: string | undefined;
    const lines = content.split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith("api_key")) {
        apiKey = trimmed.split("=")[1]?.trim();
      }
      if (trimmed.startsWith("base_url")) {
        baseUrl = trimmed.split("=")[1]?.trim().replace(/\\:/g, ":");
      }
    }
    const jsonConfig: ZiitConfig = {};
    if (apiKey) jsonConfig.apiKey = apiKey;
    if (baseUrl) jsonConfig.baseUrl = baseUrl;
    await fs.writeFile(CONFIG_FILE_PATH, JSON.stringify(jsonConfig, null, 2));
    await fs.unlink(OLD_CONFIG_FILE_PATH);
    log("Migrated old .ziit.cfg to .ziit.json");
  } catch {}
}

async function readConfigFile(): Promise<ZiitConfig> {
  await migrateOldConfigIfNeeded();
  try {
    const content = await fs.readFile(CONFIG_FILE_PATH, "utf-8");
    return JSON.parse(content);
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
    await fs.writeFile(CONFIG_FILE_PATH, JSON.stringify(config, null, 2));
    log("Config file updated (.ziit.json)");
  } catch (error: any) {
    log(`Error writing config file: ${error.message}`);
    vscode.window.showErrorMessage(
      `Failed to write Ziit config file: ${error.message}`
    );
  }
}

async function getConfigValue<T>(
  key: keyof ZiitConfig
): Promise<T | undefined> {
  const vscodeConfig = vscode.workspace.getConfiguration("ziit");

  const workspaceValue = vscodeConfig.inspect<T>(key)?.workspaceValue;
  if (workspaceValue !== undefined) {
    return workspaceValue;
  }

  const userValue = vscodeConfig.inspect<T>(key)?.globalValue;
  if (userValue !== undefined) {
    return userValue;
  }

  try {
    const fileConfig: ZiitConfig = await readConfigFile();
    if (fileConfig[key] !== undefined) {
      return fileConfig[key] as T;
    }
  } catch (error: any) {
    if (error.code !== "ENOENT") {
      log(`Error reading config file in getConfigValue: ${error.message}`);
    }
  }

  return undefined;
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
  log(`${key} updated in config file (.ziit.json) and VS Code settings.`);
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
  return (await getConfigValue<string>("baseUrl")) ?? "https://ziit.app";
}

export async function initializeAndSyncConfig(): Promise<void> {
  log(
    "Initializing or syncing config file (.ziit.json) with VS Code settings..."
  );
  let fileConfig: ZiitConfig;
  let fileNeedsCreation = false;
  try {
    fileConfig = await readConfigFile();
    log("Config file found (.ziit.json)");
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
    for (const key of ["apiKey", "baseUrl"]) {
      const value = vscodeConfig.get(key);
      if (value !== undefined) {
        initialConfig[key as keyof ZiitConfig] = value as any;
      }
    }
    await writeConfigFile(initialConfig);
    fileConfig = initialConfig;
    log("Config file created and populated (.ziit.json)");
  }
  let updated = false;
  for (const key of ["apiKey", "baseUrl"]) {
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
