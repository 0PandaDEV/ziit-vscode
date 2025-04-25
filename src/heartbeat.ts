import * as vscode from "vscode";
import { log } from "./log";
import * as https from "https";
import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { StatusBarManager } from "./status-bar";
import { getApiKey, getBaseUrl, fetchUserSettings } from "./config";

interface Heartbeat {
  timestamp: string;
  project?: string;
  language?: string;
  file?: string;
  branch?: string;
  editor: string;
  os: string;
}

interface HeartbeatData {
  project: string;
  language: string;
  file: string;
  branch?: string;
  editor: string;
  os: string;
}

export class HeartbeatManager {
  private lastHeartbeat: number = 0;
  private lastFile: string = "";
  private heartbeatInterval: number = 120000;
  private activeDocumentInfo: { file: string; language: string } | null = null;
  private statusBar: StatusBarManager | null = null;
  private heartbeatCount: number = 0;
  private successCount: number = 0;
  private failureCount: number = 0;
  private offlineHeartbeats: Heartbeat[] = [];
  private offlineQueuePath: string;
  private isOnline: boolean = true;
  private lastActivity: number = Date.now();
  private todayLocalTotalSeconds: number = 0;
  private isWindowFocused: boolean = true;
  private keystrokeTimeout: number | undefined;

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
    
    this.isWindowFocused = vscode.window.state.focused;
    
    fetchUserSettings(this);

    setInterval(() => {
      this.syncOfflineHeartbeats();
      this.fetchDailySummary();
      fetchUserSettings(this);
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
        file: path.basename(editor.document.uri.fsPath),
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
        file: path.basename(event.document.uri.fsPath),
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
    if (this.keystrokeTimeout === undefined) {
      return this.isWindowFocused;
    }
    return (
      this.isWindowFocused && now - this.lastActivity < this.keystrokeTimeout
    );
  }

  public updateKeystrokeTimeout(timeoutMinutes: number | undefined): void {
    if (timeoutMinutes !== undefined) {
      this.keystrokeTimeout = timeoutMinutes * 60 * 1000;
      log(`Keystroke timeout updated to ${timeoutMinutes} minutes`);
    } else {
      this.keystrokeTimeout = undefined;
      log("Keystroke timeout cleared");
    }
  }

  public async fetchDailySummary(): Promise<void> {
    const config = vscode.workspace.getConfiguration("ziit");
    const apiKey = config.get<string>("apiKey");
    const baseUrl = config.get<string>("baseUrl");
    const enabled = config.get<boolean>("enabled");

    if (!enabled || !apiKey || !baseUrl) {
      return;
    }

    try {
      const url = new URL("/api/external/stats", baseUrl);
      url.searchParams.append("timeRange", "today");
      
      const now = new Date();
      const timezoneOffsetMinutes = now.getTimezoneOffset();
      const timezoneOffsetSeconds = timezoneOffsetMinutes * 60;
      url.searchParams.append("midnightOffsetSeconds", timezoneOffsetSeconds.toString());
      url.searchParams.append("t", Date.now().toString());

      const requestOptions = {
        hostname: url.hostname,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: url.pathname + url.search,
        method: "GET",
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
        protocol: url.protocol,
      };

      const apiResponse = await this.makeRequest<{
        summaries: Array<{
          date: string;
          totalSeconds: number;
          projects: Record<string, number>;
          languages: Record<string, number>;
          editors: Record<string, number>;
          os: Record<string, number>;
          hourlyData: Array<{ seconds: number }>;
        }>;
        timezone: string;
      }>(requestOptions);
      this.isOnline = true;

      if (apiResponse && apiResponse.summaries && apiResponse.summaries.length > 0) {
        const todaySummary = apiResponse.summaries[0];
        this.todayLocalTotalSeconds = todaySummary.totalSeconds;

        if (this.statusBar) {
          const hours = Math.floor(this.todayLocalTotalSeconds / 3600);
          const minutes = Math.floor((this.todayLocalTotalSeconds % 3600) / 60);
          this.statusBar.updateTime(hours, minutes);
        }
      } else {
        this.todayLocalTotalSeconds = 0;
        if (this.statusBar) {
          this.statusBar.updateTime(0, 0);
        }
      }
    } catch (error) {
      this.isOnline = false;
      log(`Error fetching daily summary: ${error}`);
    }
  }

  private async syncOfflineHeartbeats(): Promise<void> {
    if (!this.isOnline || this.offlineHeartbeats.length === 0) return;

    this.offlineHeartbeats = this.offlineHeartbeats.map(heartbeat => ({
      ...heartbeat,
      timestamp: typeof heartbeat.timestamp === 'number' 
        ? new Date(heartbeat.timestamp).toISOString() 
        : heartbeat.timestamp
    }));

    const config = vscode.workspace.getConfiguration("ziit");
    const apiKey = config.get<string>("apiKey");
    const baseUrl = config.get<string>("baseUrl");

    if (!apiKey || !baseUrl) {
      return;
    }

    const batch = [...this.offlineHeartbeats];
    this.offlineHeartbeats = [];

    try {
      const data = JSON.stringify(batch);
      const url = new URL("/api/external/batch", baseUrl);

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
        protocol: url.protocol,
      };

      await new Promise<void>((resolve, reject) => {
        const req = (url.protocol === "https:" ? https : http).request(
          requestOptions,
          (res) => {
            if (
              res.statusCode &&
              res.statusCode >= 200 &&
              res.statusCode < 300
            ) {
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

      this.saveOfflineHeartbeats();
      this.fetchDailySummary();
    } catch (error) {
      log(
        `Error syncing offline heartbeats: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      this.offlineHeartbeats = [...this.offlineHeartbeats, ...batch];
      this.saveOfflineHeartbeats();
      this.isOnline = false;
    }
  }

  private async getGitBranch(): Promise<string | undefined> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) return undefined;

    try {
      const gitExtension = vscode.extensions.getExtension('vscode.git');
      if (!gitExtension) return undefined;

      const git = gitExtension.exports.getAPI(1);
      const repository = git.repositories[0];
      if (!repository) return undefined;

      return repository.state.HEAD?.name;
    } catch (error) {
      log(`Error getting git branch: ${error}`);
      return undefined;
    }
  }

  private async sendHeartbeat(force: boolean = false): Promise<void> {
    const activeEditor = vscode.window.activeTextEditor;
    if (!activeEditor || !this.activeDocumentInfo) return;

    const now = Date.now();
    const fileChanged = this.lastFile !== activeEditor.document.uri.fsPath;
    const timeThresholdPassed = now - this.lastHeartbeat >= this.heartbeatInterval;

    if (!force && !fileChanged && !timeThresholdPassed) {
      return;
    }

    this.lastFile = activeEditor.document.uri.fsPath;
    this.lastHeartbeat = now;
    this.heartbeatCount++;

    const project = this.getProjectName();
    if (!project) {
      log("No project name found, skipping heartbeat");
      return;
    }

    const config = vscode.workspace.getConfiguration("ziit");
    const apiKey = config.get<string>("apiKey");
    const baseUrl = config.get<string>("baseUrl");
    const enabled = config.get<boolean>("enabled");

    if (!enabled || !apiKey || !baseUrl) {
      return;
    }

    const branch = await this.getGitBranch();
    const heartbeat: Heartbeat = {
      timestamp: new Date().toISOString(),
      project,
      language: this.activeDocumentInfo.language,
      file: this.activeDocumentInfo.file,
      branch,
      editor: vscode.env.appName,
      os:
        process.platform === "win32"
          ? "Windows"
          : process.platform === "darwin"
          ? "macOS"
          : "Linux",
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
            if (
              res.statusCode &&
              res.statusCode >= 200 &&
              res.statusCode < 300
            ) {
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
      log(
        `Failed to send heartbeat: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  private loadOfflineHeartbeats(): void {
    try {
      if (fs.existsSync(this.offlineQueuePath)) {
        const data = fs.readFileSync(this.offlineQueuePath, "utf8");
        this.offlineHeartbeats = JSON.parse(data);
      }
    } catch (error) {
      log(
        `Error loading offline heartbeats: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      this.offlineHeartbeats = [];
    }
  }

  private saveOfflineHeartbeats(): void {
    try {
      fs.writeFileSync(
        this.offlineQueuePath,
        JSON.stringify(this.offlineHeartbeats),
        "utf8"
      );
    } catch (error) {
      log(
        `Error saving offline heartbeats: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  private makeRequest<T>(options: http.RequestOptions): Promise<T> {
    return new Promise((resolve, reject) => {
      const req = (options.protocol === "https:" ? https : http).request(
        options,
        (res) => {
          let data = "";
          res.on("data", (chunk) => {
            data += chunk;
          });
          res.on("end", () => {
            if (
              res.statusCode &&
              res.statusCode >= 200 &&
              res.statusCode < 300
            ) {
              try {
                resolve(JSON.parse(data));
              } catch (error) {
                reject(
                  new Error(
                    `Invalid JSON response: ${
                      error instanceof Error ? error.message : String(error)
                    }`
                  )
                );
              }
            } else {
              reject(
                new Error(
                  `Request failed with status code ${res.statusCode}: ${data}`
                )
              );
            }
          });
        }
      );
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

  const file = data.file ? path.basename(data.file) : undefined;
  const project = data.project ? path.basename(data.project) : undefined;

  const heartbeatData = {
    ...data,
    project,
    file,
    timestamp: new Date().toISOString()
  };

  try {
    const url = new URL("/api/external/heartbeats", baseUrl);
    await fetch(url.toString(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(heartbeatData),
      mode: "cors",
    });
  } catch (error) {
    log(
      `Error sending heartbeat: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}
