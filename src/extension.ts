import * as vscode from "vscode";
import { log, showOutputChannel } from "./log";
import { HeartbeatManager } from "./heartbeat";
import { StatusBarManager } from "./status-bar";
import { setApiKey, setBaseUrl } from "./config";

export function activate(context: vscode.ExtensionContext) {
  log("Ziit extension activated");

  const statusBarManager = new StatusBarManager();
  context.subscriptions.push(statusBarManager);

  const heartbeatManager = new HeartbeatManager(context, statusBarManager);
  context.subscriptions.push(heartbeatManager);

  heartbeatManager.fetchDailySummary();

  const openDashboardCommand = vscode.commands.registerCommand(
    "ziit.openDashboard",
    () => {
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
    () => {
      setApiKey();
    }
  );

  const setBaseUrlCommand = vscode.commands.registerCommand(
    "ziit.setBaseUrl",
    () => {
      setBaseUrl();
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
