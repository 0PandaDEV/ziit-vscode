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

  const setKeystrokeTimeoutCommand = vscode.commands.registerCommand(
    "ziit.setKeystrokeTimeout",
    async () => {
      const config = vscode.workspace.getConfiguration("ziit");

      const options = [
        "5 minutes",
        "15 minutes (default)",
        "30 minutes",
        "60 minutes",
        "120 minutes",
      ];

      const selection = await vscode.window.showQuickPick(options, {
        placeHolder:
          "Select keystroke timeout (how long before we stop counting you as coding)",
        canPickMany: false,
      });

      if (!selection) {
        return;
      }

      let newTimeout: number;
      switch (selection) {
        case "5 minutes":
          newTimeout = 5;
          break;
        case "15 minutes (default)":
          newTimeout = 15;
          break;
        case "30 minutes":
          newTimeout = 30;
          break;
        case "60 minutes":
          newTimeout = 60;
          break;
        case "120 minutes":
          newTimeout = 120;
          break;
        default:
          newTimeout = 15;
      }

      await config.update("keystrokeTimeout", newTimeout, true);
      vscode.window.showInformationMessage(
        `Keystroke timeout set to ${newTimeout} minutes`
      );

      heartbeatManager.updateKeystrokeTimeout(newTimeout);
    }
  );

  const showOutputCommand = vscode.commands.registerCommand(
    "ziit.showOutput",
    () => {
      showOutputChannel();
    }
  );

  statusBarManager.startTracking();

  vscode.window.onDidChangeActiveTextEditor(() => {
    statusBarManager.startTracking();
  });

  context.subscriptions.push(
    openDashboardCommand,
    setApiKeyCommand,
    setBaseUrlCommand,
    setKeystrokeTimeoutCommand,
    showOutputCommand
  );
}

export function deactivate() {
  log("Ziit extension deactivated");
}
