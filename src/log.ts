import * as vscode from "vscode";

let outputChannel: vscode.OutputChannel;

function getOutputChannel() {
  if (!outputChannel) {
    outputChannel = vscode.window.createOutputChannel("Ziit");
  }
  return outputChannel;
}

export function showOutputChannel(): void {
  getOutputChannel().show();
}

export function log(message: string): void {
  const channel = getOutputChannel();
  channel.appendLine(`[${new Date().toLocaleString()}] ${message}`);
}

export function error(message: string): void {
  const channel = getOutputChannel();
  channel.appendLine(`[${new Date().toLocaleString()}] ERROR: ${message}`);
}
