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
    placeHolder: "https://ziit.pandadev.net",
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
  return baseUrl || "https://ziit.pandadev.net";
}