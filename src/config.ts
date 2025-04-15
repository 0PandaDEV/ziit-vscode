import * as vscode from "vscode";
import { log } from "./log";

export async function setApiKey(): Promise<void> {
  const apiKey = await vscode.window.showInputBox({
    prompt: "Enter your Ziit API key",
    placeHolder: "API Key",
    password: true
  });

  if (!apiKey) {
    log("API key setting cancelled");
    return;
  }

  await vscode.workspace.getConfiguration("ziit").update("apiKey", apiKey, true);
  log("API key updated");
  vscode.window.showInformationMessage("Ziit API key has been updated");
}

export async function setBaseUrl(): Promise<void> {
  const currentBaseUrl = getBaseUrl();
  
  const baseUrl = await vscode.window.showInputBox({
    prompt: "Enter your Ziit instance URL",
    placeHolder: "https://ziit.app",
    value: currentBaseUrl
  });

  if (!baseUrl) {
    log("Base URL setting cancelled");
    return;
  }

  await vscode.workspace.getConfiguration("ziit").update("baseUrl", baseUrl, true);
  log("Base URL updated");
  vscode.window.showInformationMessage("Ziit instance URL has been updated");
}

export function getApiKey(): string | undefined {
  return vscode.workspace.getConfiguration("ziit").get<string>("apiKey");
}

export function getBaseUrl(): string {
  const baseUrl = vscode.workspace.getConfiguration("ziit").get<string>("baseUrl");
  return baseUrl || "https://ziit.app";
}

export function getKeystrokeTimeout(): number | undefined {
  return vscode.workspace.getConfiguration("ziit").get<number>("keystrokeTimeout");
}

export function setKeystrokeTimeout(timeoutMinutes: number): void {
  vscode.workspace.getConfiguration("ziit").update("keystrokeTimeout", timeoutMinutes, true);
  log(`Keystroke timeout updated to ${timeoutMinutes} minutes`);
}

export async function fetchUserSettings(heartbeatManager?: any): Promise<void> {
  const apiKey = getApiKey();
  const baseUrl = getBaseUrl();
  
  if (!apiKey || !baseUrl) {
    log("Can't fetch user settings: missing API key or base URL");
    return;
  }
  
  try {
    const url = new URL("/api/external/user", baseUrl);
    const response = await fetch(url.toString(), {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`
      }
    });
    
    if (!response.ok) {
      throw new Error(`Error fetching user settings: ${response.statusText}`);
    }
    
    const data = await response.json();
    
    if (data.keystrokeTimeout !== undefined) {
      setKeystrokeTimeout(data.keystrokeTimeout);
      log(`Keystroke timeout fetched from API: ${data.keystrokeTimeout} minutes`);
      
      if (heartbeatManager && typeof heartbeatManager.updateKeystrokeTimeout === 'function') {
        heartbeatManager.updateKeystrokeTimeout(data.keystrokeTimeout);
      }
    }
  } catch (error) {
    log(`Failed to fetch user settings: ${error instanceof Error ? error.message : String(error)}`);
  }
}