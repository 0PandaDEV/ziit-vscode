import * as vscode from "vscode";
import { log } from "./log";
import * as https from "https";
import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { StatusBarManager } from "./status-bar";
import { getApiKey, getBaseUrl } from "./config";

interface Heartbeat {
  timestamp: string;
  project?: string;
  language?: string;
  file?: string;
  editor: string;
  os: string;
}

interface DailySummary {
  date: string;
  totalSeconds: number;
  projects: Record<string, number>;
}

interface HeartbeatData {
  project: string;
  language: string;
  file: string;
  editor: string;
  os: string;
}

export class HeartbeatManager {
  private lastHeartbeat: number = 0;
  private lastFile: string = "";
  private heartbeatInterval: number = 120000;
  private keystrokeTimeout: number = 15 * 60 * 1000;
  private activeDocumentInfo: { file: string; language: string } | null = null;
  private statusBar: StatusBarManager | null = null;
  private heartbeatCount: number = 0;
  private successCount: number = 0;
  private failureCount: number = 0;
  private offlineHeartbeats: Heartbeat[] = [];
  private offlineQueuePath: string;
  private isOnline: boolean = true;
  private lastActivity: number = Date.now();
  private todaySummary: DailySummary | null = null;
  private isWindowFocused: boolean = true;

  constructor(
    private context: vscode.ExtensionContext,
    statusBar?: StatusBarManager
  ) {
    this.statusBar = statusBar || null;

    const homeDir = os.homedir();
    const ziitDir = path.join(homeDir, ".ziit");
    if (!fs.existsSync(ziitDir)) {
      fs.mkdirSync(ziitDir, { recursive: true });
    }
    this.offlineQueuePath = path.join(ziitDir, "offline_heartbeats.json");
    this.loadOfflineHeartbeats();
    this.initialize();
  }

  private initialize(): void {
    this.registerEventListeners();
    this.scheduleHeartbeat();
    this.syncOfflineHeartbeats();

    const config = vscode.workspace.getConfiguration("ziit");
    this.keystrokeTimeout = config.get<number>("keystrokeTimeout", 15) * 60 * 1000;
    this.isWindowFocused = vscode.window.state.focused;

    setInterval(() => {
      this.syncOfflineHeartbeats();
      this.fetchDailySummary();
    }, 30000);
  }

  private registerEventListeners(): void {
    log("Registering event listeners for editor changes");

    vscode.window.onDidChangeActiveTextEditor(
      this.handleActiveEditorChange,
      null,
      this.context.subscriptions
    );

    vscode.workspace.onDidChangeTextDocument(
      this.handleDocumentChange,
      null,
      this.context.subscriptions
    );

    vscode.workspace.onDidSaveTextDocument(
      this.handleDocumentSave,
      null,
      this.context.subscriptions
    );

    vscode.window.onDidChangeWindowState(
      this.handleWindowStateChange,
      null,
      this.context.subscriptions
    );

    if (vscode.window.activeTextEditor) {
      this.handleActiveEditorChange(vscode.window.activeTextEditor);
    }
  }

  private handleActiveEditorChange = (
    editor: vscode.TextEditor | undefined
  ): void => {
    if (editor) {
      log(
        `Editor changed: ${editor.document.uri.fsPath} (${editor.document.languageId})`
      );

      this.activeDocumentInfo = {
        file: editor.document.uri.fsPath,
        language: editor.document.languageId,
      };

      this.updateActivity();
      this.sendHeartbeat(true);
    }
  };

  private handleDocumentChange = (
    event: vscode.TextDocumentChangeEvent
  ): void => {
    const activeEditor = vscode.window.activeTextEditor;
    if (activeEditor && activeEditor.document === event.document) {
      this.activeDocumentInfo = {
        file: event.document.uri.fsPath,
        language: event.document.languageId,
      };

      this.updateActivity();

      const now = Date.now();
      const fileChanged = this.lastFile !== event.document.uri.fsPath;
      const timeThresholdPassed =
        now - this.lastHeartbeat >= this.heartbeatInterval;

      if (fileChanged || timeThresholdPassed) {
        this.sendHeartbeat();
      }
    }
  };

  private handleDocumentSave = (document: vscode.TextDocument): void => {
    const activeEditor = vscode.window.activeTextEditor;
    if (activeEditor && activeEditor.document === document) {
      this.updateActivity();
      this.sendHeartbeat(true);
    }
  };

  private handleWindowStateChange = (windowState: vscode.WindowState): void => {
    const wasFocused = this.isWindowFocused;
    this.isWindowFocused = windowState.focused;

    log(`Window focus state changed: ${wasFocused} -> ${this.isWindowFocused}`);

    if (!this.isWindowFocused && wasFocused) {
      this.updateActivity();
      if (this.statusBar) {
        this.statusBar.stopTracking();
      }
    } else if (this.isWindowFocused && !wasFocused) {
      this.lastActivity = Date.now();
      if (this.statusBar) {
        this.statusBar.startTracking();
      }
    }
  };

  private updateActivity(): void {
    this.lastActivity = Date.now();
  }

  private scheduleHeartbeat(): void {
    log(
      `Setting up heartbeat schedule with interval: ${this.heartbeatInterval}ms`
    );

    setInterval(() => {
      if (this.activeDocumentInfo && this.isUserActive()) {
        this.sendHeartbeat();
      } else {
        log("User inactive or no active document, skipping heartbeat");
        if (this.statusBar && !this.isUserActive()) {
          this.statusBar.stopTracking();
        }
      }
    }, this.heartbeatInterval);

    setInterval(() => {
      this.fetchDailySummary();
      log(
        `Heartbeat stats - Total: ${this.heartbeatCount}, Success: ${this.successCount}, Failed: ${this.failureCount}, Offline: ${this.offlineHeartbeats.length}`
      );
    }, 15 * 60 * 1000);
  }

  private isUserActive(): boolean {
    const now = Date.now();
    return (
      this.isWindowFocused && now - this.lastActivity < this.keystrokeTimeout
    );
  }

  public updateKeystrokeTimeout(timeoutMinutes: number): void {
    this.keystrokeTimeout = timeoutMinutes * 60 * 1000;
    log(`Keystroke timeout updated to ${timeoutMinutes} minutes`);
  }

  public async fetchDailySummary(): Promise<void> {
    const config = vscode.workspace.getConfiguration("ziit");
    const apiKey = config.get<string>("apiKey");
    const baseUrl = config.get<string>("baseUrl");
    const enabled = config.get<boolean>("enabled");

    if (!enabled || !apiKey || !baseUrl || !this.statusBar) {
      return;
    }

    try {
      const today = new Date().toISOString().split("T")[0];
      const url = new URL("/api/external/stats", baseUrl);
      url.searchParams.append("startDate", today);

      const requestOptions = {
        hostname: url.hostname,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: url.pathname + url.search,
        method: "GET",
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
        protocol: url.protocol
      };

      const responseData = await this.makeRequest<DailySummary[]>(requestOptions);
      this.isOnline = true;

      if (responseData && responseData.length > 0) {
        const todaySummary = responseData[0];
        this.todaySummary = todaySummary;
        if (this.statusBar) {
          this.statusBar.updateTime(Math.floor(todaySummary.totalSeconds / 3600), Math.floor((todaySummary.totalSeconds % 3600) / 60));
        }
      }
    } catch (error) {
      this.isOnline = false;
      log(`Error fetching daily summary: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async syncOfflineHeartbeats(): Promise<void> {
    if (!this.isOnline || this.offlineHeartbeats.length === 0) {
      return;
    }

    const config = vscode.workspace.getConfiguration("ziit");
    const apiKey = config.get<string>("apiKey");
    const baseUrl = config.get<string>("baseUrl");

    if (!apiKey || !baseUrl) {
      return;
    }

    const batch = [...this.offlineHeartbeats];
    this.offlineHeartbeats = [];

    try {
      for (const heartbeat of batch) {
        const data = JSON.stringify(heartbeat);
        const url = new URL("/api/external/heartbeats", baseUrl);

        const requestOptions = {
          hostname: url.hostname,
          port: url.port || (url.protocol === "https:" ? 443 : 80),
          path: url.pathname + url.search,
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(data),
            Authorization: `Bearer ${apiKey}`,
          },
          protocol: url.protocol
        };

        await new Promise<void>((resolve, reject) => {
          const req = (url.protocol === "https:" ? https : http).request(
            requestOptions,
            (res) => {
              if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                resolve();
              } else {
                reject(new Error(`Failed with status code: ${res.statusCode}`));
              }
            }
          );

          req.on("error", reject);
          req.write(data);
          req.end();
        });
      }

      this.saveOfflineHeartbeats();
      this.fetchDailySummary();
    } catch (error) {
      log(`Error syncing offline heartbeats: ${error instanceof Error ? error.message : String(error)}`);
      this.offlineHeartbeats = [...this.offlineHeartbeats, ...batch];
      this.saveOfflineHeartbeats();
      this.isOnline = false;
    }
  }

  private async sendHeartbeat(force: boolean = false): Promise<void> {
    const now = Date.now();

    if (!force && now - this.lastHeartbeat < this.heartbeatInterval) {
      return;
    }

    this.lastHeartbeat = now;
    this.heartbeatCount++;

    if (!this.activeDocumentInfo) {
      return;
    }

    this.lastFile = this.activeDocumentInfo.file;

    const config = vscode.workspace.getConfiguration("ziit");
    const apiKey = config.get<string>("apiKey");
    const baseUrl = config.get<string>("baseUrl");
    const enabled = config.get<boolean>("enabled");

    if (!enabled || !apiKey || !baseUrl) {
      return;
    }

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    const project = workspaceFolder ? workspaceFolder.name : "unknown";

    const heartbeat: Heartbeat = {
      timestamp: new Date().toISOString(),
      project: project,
      language: this.activeDocumentInfo.language,
      file: this.activeDocumentInfo.file,
      editor: vscode.env.appName,
      os: process.platform === 'win32' ? 'Windows' : process.platform === 'darwin' ? 'macOS' : 'Linux'
    };

    if (!this.isOnline) {
      this.offlineHeartbeats.push(heartbeat);
      this.saveOfflineHeartbeats();
      return;
    }

    try {
      const data = JSON.stringify(heartbeat);
      const url = new URL(`${baseUrl}/api/external/heartbeats`);

      const requestOptions = {
        hostname: url.hostname,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: url.pathname + url.search,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
          Authorization: `Bearer ${apiKey}`,
        },
      };

      await new Promise<void>((resolve, reject) => {
        const req = (url.protocol === "https:" ? https : http).request(
          requestOptions,
          (res) => {
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              this.isOnline = true;
              resolve();
            } else {
              reject(new Error(`Failed with status code: ${res.statusCode}`));
            }
          }
        );

        req.on("error", reject);
        req.write(data);
        req.end();
      });
    } catch (error) {
      this.isOnline = false;
      this.offlineHeartbeats.push(heartbeat);
      this.saveOfflineHeartbeats();
      log(`Failed to send heartbeat: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private loadOfflineHeartbeats(): void {
    try {
      if (fs.existsSync(this.offlineQueuePath)) {
        const data = fs.readFileSync(this.offlineQueuePath, "utf8");
        this.offlineHeartbeats = JSON.parse(data);
      }
    } catch (error) {
      log(`Error loading offline heartbeats: ${error instanceof Error ? error.message : String(error)}`);
      this.offlineHeartbeats = [];
    }
  }

  private saveOfflineHeartbeats(): void {
    try {
      fs.writeFileSync(this.offlineQueuePath, JSON.stringify(this.offlineHeartbeats), "utf8");
    } catch (error) {
      log(`Error saving offline heartbeats: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private makeRequest<T>(options: http.RequestOptions): Promise<T> {
    return new Promise((resolve, reject) => {
      const req = (options.protocol === "https:" ? https : http).request(options, (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve(JSON.parse(data));
            } catch (error) {
              reject(new Error(`Invalid JSON response: ${error instanceof Error ? error.message : String(error)}`));
            }
          } else {
            reject(new Error(`Request failed with status code ${res.statusCode}: ${data}`));
          }
        });
      });
      req.on("error", reject);
      req.end();
    });
  }

  private getProjectName(): string | undefined {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    return workspaceFolder ? workspaceFolder.name : undefined;
  }

  public dispose(): void {
    this.saveOfflineHeartbeats();
  }
}

export async function sendHeartbeat(data: HeartbeatData) {
  const apiKey = getApiKey();
  const baseUrl = getBaseUrl();

  if (!apiKey || !baseUrl) return;

  try {
    const url = new URL("/api/external/heartbeats", baseUrl);
    await fetch(url.toString(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(data),
      mode: "cors",
      credentials: "include"
    });
  } catch (error) {
    log(`Error sending heartbeat: ${error instanceof Error ? error.message : String(error)}`);
  }
}
