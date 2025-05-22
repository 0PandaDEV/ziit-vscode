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
  private hasValidApiKey: boolean = true;
  private lastActivity: number = Date.now();
  private todayLocalTotalSeconds: number = 0;
  private isWindowFocused: boolean = true;
  private unsyncedLocalSeconds: number = 0;

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

    setInterval(() => {
      this.syncOfflineHeartbeats();
      this.fetchDailySummary();
    }, 30000);

    if (this.statusBar) {
      this.statusBar.setOnlineStatus(this.isOnline);
      this.statusBar.setApiKeyStatus(this.hasValidApiKey);
    }
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
    const now = Date.now();
    if (this.isUserActive() && this.lastActivity > 0) {
      const elapsedSeconds = Math.floor((now - this.lastActivity) / 1000);
      if (elapsedSeconds > 0) {
        this.unsyncedLocalSeconds += elapsedSeconds;
      }
    }
    this.lastActivity = now;
  }

  private scheduleHeartbeat(): void {
    log(
      `Setting up heartbeat schedule with interval: ${this.heartbeatInterval}ms`
    );

    setInterval(() => {
      if (this.activeDocumentInfo && this.isUserActive()) {
        this.updateActivity();
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
    return this.isWindowFocused;
  }

  public async fetchDailySummary(): Promise<void> {
    this.updateActivity();

    const apiKey = await getApiKey();
    const baseUrl = await getBaseUrl();
    if (!apiKey || !baseUrl) {
      return;
    }

    try {
      const url = new URL("/api/external/stats", baseUrl);
      url.searchParams.append("timeRange", "today");

      const now = new Date();
      const timezoneOffsetMinutes = now.getTimezoneOffset();
      const timezoneOffsetSeconds = timezoneOffsetMinutes * 60;
      url.searchParams.append(
        "midnightOffsetSeconds",
        timezoneOffsetSeconds.toString()
      );
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

      this.setOnlineStatus(true);
      this.setApiKeyStatus(true);

      if (
        apiResponse &&
        apiResponse.summaries &&
        apiResponse.summaries.length > 0
      ) {
        const todaySummary = apiResponse.summaries[0];
        this.todayLocalTotalSeconds = todaySummary.totalSeconds;

        const totalSeconds =
          this.todayLocalTotalSeconds + this.unsyncedLocalSeconds;

        if (this.statusBar) {
          const hours = Math.floor(totalSeconds / 3600);
          const minutes = Math.floor((totalSeconds % 3600) / 60);
          this.statusBar.updateTime(hours, minutes);
        }
      } else {
        const totalSeconds = this.unsyncedLocalSeconds;
        if (this.statusBar) {
          const hours = Math.floor(totalSeconds / 3600);
          const minutes = Math.floor((totalSeconds % 3600) / 60);
          this.statusBar.updateTime(hours, minutes);
        }
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes("401")) {
        this.setApiKeyStatus(false);
        log(`Error fetching daily summary: Invalid API key`);
      } else {
        this.setOnlineStatus(false);
        log(`Error fetching daily summary: ${error}`);
      }

      if (this.statusBar && this.unsyncedLocalSeconds > 0) {
        const totalSeconds =
          this.todayLocalTotalSeconds + this.unsyncedLocalSeconds;
        const hours = Math.floor(totalSeconds / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);
        this.statusBar.updateTime(hours, minutes);
      }
    }
  }

  private async syncOfflineHeartbeats(): Promise<void> {
    if (!this.isOnline || this.offlineHeartbeats.length === 0) return;
    const apiKey = await getApiKey();
    const baseUrl = await getBaseUrl();
    if (!apiKey || !baseUrl) {
      return;
    }

    this.offlineHeartbeats = this.offlineHeartbeats.map((heartbeat) => ({
      ...heartbeat,
      timestamp:
        typeof heartbeat.timestamp === "number"
          ? new Date(heartbeat.timestamp).toISOString()
          : heartbeat.timestamp,
    }));

    while (this.offlineHeartbeats.length > 0) {
      const batch = this.offlineHeartbeats.slice(0, 1000);
      this.offlineHeartbeats = this.offlineHeartbeats.slice(1000);

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
              } else if (res.statusCode === 401) {
                this.setApiKeyStatus(false);
                reject(
                  new Error(`Invalid API key (status code: ${res.statusCode})`)
                );
              } else {
                reject(new Error(`Failed with status code: ${res.statusCode}`));
              }
            }
          );

          req.on("error", (err) => {
            this.setOnlineStatus(false);
            reject(err);
          });
          req.write(data);
          req.end();
        });

        this.setOnlineStatus(true);
        this.setApiKeyStatus(true);
        this.saveOfflineHeartbeats();

        this.unsyncedLocalSeconds = 0;
      } catch (error) {
        log(
          `Error syncing offline heartbeats batch: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
        this.offlineHeartbeats = [...batch, ...this.offlineHeartbeats];
        this.saveOfflineHeartbeats();

        if (error instanceof Error && error.message.includes("API key")) {
          this.setApiKeyStatus(false);
        } else {
          this.setOnlineStatus(false);
        }
        break;
      }
    }

    if (this.offlineHeartbeats.length === 0) {
      this.fetchDailySummary();
    }
  }

  private async getGitBranch(): Promise<string | undefined> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) return undefined;

    try {
      const gitExtension = vscode.extensions.getExtension("vscode.git");
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
    const timeThresholdPassed =
      now - this.lastHeartbeat >= this.heartbeatInterval;
    if (!force && !fileChanged && !timeThresholdPassed) {
      return;
    }
    this.lastFile = activeEditor.document.uri.fsPath;
    this.lastHeartbeat = now;
    this.heartbeatCount++;
    const project = await this.getProjectName(activeEditor.document.uri);
    if (!project) {
      log("No project name found for the current file, skipping heartbeat");
      return;
    }
    const apiKey = await getApiKey();
    const baseUrl = await getBaseUrl();
    if (!apiKey || !baseUrl) {
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
              this.successCount++;
              this.setOnlineStatus(true);
              this.setApiKeyStatus(true);

              this.unsyncedLocalSeconds = 0;

              resolve();
            } else if (res.statusCode === 401) {
              this.setApiKeyStatus(false);
              reject(
                new Error(`Invalid API key (status code: ${res.statusCode})`)
              );
            } else {
              this.failureCount++;
              reject(new Error(`Failed with status code: ${res.statusCode}`));
            }
          }
        );

        req.on("error", (err) => {
          this.failureCount++;
          this.setOnlineStatus(false);
          reject(err);
        });
        req.write(data);
        req.end();
      });
    } catch (error) {
      if (error instanceof Error && error.message.includes("API key")) {
        this.setApiKeyStatus(false);
      } else {
        this.setOnlineStatus(false);
      }

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
            } else if (res.statusCode === 401) {
              this.setApiKeyStatus(false);
              reject(
                new Error(`Invalid API key (status code: ${res.statusCode})`)
              );
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
      req.on("error", (error) => {
        this.setOnlineStatus(false);
        reject(error);
      });
      req.end();
    });
  }

  private async getProjectName(
    fileUri: vscode.Uri
  ): Promise<string | undefined> {
    try {
      const gitExtension = vscode.extensions.getExtension<{
        getAPI(version: number): any;
      }>("vscode.git");
      if (!gitExtension) {
        log("Git extension not found.");
        return this.getProjectNameFromWorkspaceFolder(fileUri);
      }

      if (!gitExtension.isActive) {
        await gitExtension.activate();
        log("Git extension activated.");
      }

      const git = gitExtension.exports.getAPI(1);
      if (!git) {
        log("Git API not available.");
        return this.getProjectNameFromWorkspaceFolder(fileUri);
      }

      const repository = git.getRepository(fileUri);
      if (!repository) {
        log(`No Git repository found containing the file: ${fileUri.fsPath}`);
        return this.getProjectNameFromWorkspaceFolder(fileUri);
      }

      log(
        `Found repository for file ${fileUri.fsPath}: ${repository.rootUri.fsPath}`
      );
      const remotes = repository.state.remotes;

      const getProjectNameFromUrl = (url: string): string | undefined => {
        try {
          const lastSeparator = Math.max(
            url.lastIndexOf("/"),
            url.lastIndexOf(":")
          );
          if (lastSeparator === -1) return undefined;
          let name = url.substring(lastSeparator + 1);
          if (name.endsWith(".git")) name = name.slice(0, -4);
          return name || undefined;
        } catch (e) {
          log(`Error parsing git remote URL ${url}: ${e}`);
          return undefined;
        }
      };

      const getProjectNameFromLocalPath = (repo: any): string | undefined => {
        const repoPath = repo?.rootUri?.fsPath;
        if (repoPath) {
          let name = path.basename(repoPath);
          if (name.endsWith(".git")) name = name.slice(0, -4);
          return name || undefined;
        }
        return undefined;
      };

      if (remotes.length > 0) {
        const originRemote = remotes.find(
          (remote: any) => remote.name === "origin"
        );
        const remoteToUse = originRemote || remotes[0];
        const remoteUrl = remoteToUse.fetchUrl || remoteToUse.pushUrl;
        if (remoteUrl) {
          const projectName = getProjectNameFromUrl(remoteUrl);
          if (projectName) return projectName;
        }
      }

      const localProjectName = getProjectNameFromLocalPath(repository);
      if (localProjectName) return localProjectName;

      return undefined;
    } catch (error) {
      log(
        `Error getting project name from Git: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      return this.getProjectNameFromWorkspaceFolder(fileUri);
    }
  }

  private getProjectNameFromWorkspaceFolder(
    fileUri: vscode.Uri
  ): string | undefined {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(fileUri);
    log(
      `Falling back to workspace folder name for ${fileUri.fsPath}. Found: ${workspaceFolder?.name}`
    );
    return workspaceFolder?.name;
  }

  private setOnlineStatus(isOnline: boolean): void {
    if (this.isOnline !== isOnline) {
      this.isOnline = isOnline;
      if (this.statusBar) {
        this.statusBar.setOnlineStatus(isOnline);
      }
      log(`Online status changed to: ${isOnline ? "online" : "offline"}`);
    }
  }

  private setApiKeyStatus(isValid: boolean): void {
    if (this.hasValidApiKey !== isValid) {
      this.hasValidApiKey = isValid;
      if (this.statusBar) {
        this.statusBar.setApiKeyStatus(isValid);
      }
      log(`API key status changed to: ${isValid ? "valid" : "invalid"}`);
    }
  }

  public dispose(): void {
    this.saveOfflineHeartbeats();
  }
}
