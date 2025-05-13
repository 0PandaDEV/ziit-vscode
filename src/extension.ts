import * as vscode from "vscode";
import { log, showOutputChannel } from "./log";
import { HeartbeatManager } from "./heartbeat";
import { StatusBarManager } from "./status-bar";
import {
  setApiKey,
  setBaseUrl,
  initializeAndSyncConfig,
  fetchUserSettings,
} from "./config";

export async function activate(context: vscode.ExtensionContext) {
  await initializeAndSyncConfig();

  log("Ziit extension activated");

  const statusBarManager = new StatusBarManager();
  context.subscriptions.push(statusBarManager);

  const heartbeatManager = new HeartbeatManager(context, statusBarManager);
  context.subscriptions.push(heartbeatManager);

  heartbeatManager.fetchDailySummary();

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("ziit.apiKey")) {
        log("API key changed in settings, validating...");
        fetchUserSettings(heartbeatManager);
      }
    })
  );

  const openDashboardCommand = vscode.commands.registerCommand(
    "ziit.openDashboard",
    async () => {
      const config = vscode.workspace.getConfiguration("ziit");
      const baseUrl = config.get<string>("baseUrl");
      if (baseUrl) {
        vscode.env.openExternal(vscode.Uri.parse(`${baseUrl}/`));
      } else {
        vscode.window.showErrorMessage("No base URL configured for Ziit");
      }
    }
  );

  const setApiKeyCommand = vscode.commands.registerCommand(
    "ziit.setApiKey",
    async () => {
      await setApiKey();
      fetchUserSettings(heartbeatManager);
    }
  );

  const setBaseUrlCommand = vscode.commands.registerCommand(
    "ziit.setBaseUrl",
    async () => {
      await setBaseUrl();
    }
  );

  const showOutputCommand = vscode.commands.registerCommand(
    "ziit.showOutput",
    () => {
      showOutputChannel();
    }
  );

  context.subscriptions.push(
    openDashboardCommand,
    setApiKeyCommand,
    setBaseUrlCommand,
    showOutputCommand
  );
}

export function deactivate() {
  log("Ziit extension deactivated");
}
