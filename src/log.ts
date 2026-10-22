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

export function describeError(err: unknown): string {
  if (err instanceof AggregateError) {
    const parts = err.errors.map((e: any) =>
      [e?.code, e?.address && `${e.address}:${e.port}`, e?.message]
        .filter(Boolean)
        .join(" "),
    );
    return `${err.message || "AggregateError"} [${parts.join("; ")}]`;
  }
  if (err instanceof Error) {
    const code = (err as any).code;
    return code && !err.message.includes(code)
      ? `${code} ${err.message}`
      : err.message || String(err);
  }
  return String(err);
}
