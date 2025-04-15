import * as vscode from "vscode";
import { log, showOutputChannel } from "./log";
import { HeartbeatManager } from "./heartbeat";
import { StatusBarManager } from "./status-bar";
import { setApiKey, setBaseUrl } from "./config";
import { sendHeartbeat } from "./heartbeat";

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

  const editor = vscode.window.activeTextEditor;
  if (!editor) return;

  const os = process.platform === "win32" ? "Windows" : process.platform === "darwin" ? "macOS" : "Linux";
  const editorName = vscode.env.appName;

  const disposable = vscode.window.onDidChangeActiveTextEditor(async (editor) => {
    if (!editor) return;

    const filePath = editor.document.uri.fsPath;
    const project = filePath.split(/[\\/]/).slice(0, -1).join("/");
    const language = editor.document.languageId;

    await sendHeartbeat({
      project,
      language,
      file: filePath,
      editor: editorName,
      os,
    });
  });

  context.subscriptions.push(
    openDashboardCommand,
    setApiKeyCommand,
    setBaseUrlCommand,
    showOutputCommand,
    disposable
  );
}

export function deactivate() {
  log("Ziit extension deactivated");
}
