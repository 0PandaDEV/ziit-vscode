import * as vscode from "vscode";
import { log } from "./log";
import * as https from "https";
import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { StatusBarManager } from "./status-bar";

interface Heartbeat {
  timestamp: string;
  project?: string;
  language?: string;
  file?: string;
}

interface DailySummary {
  date: string;
  totalSeconds: number;
  projects: Record<string, number>;
}

interface LocalSummary {
  date: string;
  totalSeconds: number;
  lastUpdated: number;
  projects: Record<string, number>;
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
  private localSummaryPath: string;
  private isOnline: boolean = true;
  private lastActivity: number = Date.now();
  private localSummaries: Record<string, LocalSummary> = {};
  private todaySummary: LocalSummary | null = null;
  private isWindowFocused: boolean = true;
  private localSummaryWatcher: fs.FSWatcher | null = null;
  private lastFileModification: number = 0;

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
    this.localSummaryPath = path.join(ziitDir, "local_summaries.json");

    this.loadOfflineHeartbeats();
    this.loadLocalSummaries();
    this.watchLocalSummaryFile();

    this.initialize();
  }

  private initialize(): void {
    log("Initializing heartbeat manager");
    this.registerEventListeners();
    this.scheduleHeartbeat();
    this.fetchDailySummary();

    const config = vscode.workspace.getConfiguration("ziit");
    this.keystrokeTimeout =
      config.get<number>("keystrokeTimeout", 15) * 60 * 1000;
    log(`Keystroke timeout set to ${this.keystrokeTimeout / 60000} minutes`);

    this.isWindowFocused = vscode.window.state.focused;

    setInterval(() => {
      if (this.offlineHeartbeats.length > 0 && this.isOnline) {
        this.syncOfflineHeartbeats();
      }
    }, 5 * 60 * 1000);
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
    const now = Date.now();

    if (this.lastActivity > 0 && this.isUserActive()) {
      const timeGap = now - this.lastActivity;
      if (timeGap < this.keystrokeTimeout) {
        this.updateLocalSummary(Math.floor(timeGap / 1000));
      }
    }

    this.lastActivity = now;
    if (this.statusBar) {
      this.statusBar.startTracking();
    }
  }

  private updateLocalSummary(secondsToAdd: number): void {
    const today = new Date().toISOString().split("T")[0];
    
    this.loadLocalSummaries();
    
    if (!this.localSummaries[today]) {
      this.localSummaries[today] = {
        date: today,
        totalSeconds: 0,
        lastUpdated: Date.now(),
        projects: {},
      };
    }

    this.localSummaries[today].totalSeconds += secondsToAdd;
    this.localSummaries[today].lastUpdated = Date.now();

    if (this.activeDocumentInfo?.file) {
      const projectFolder = this.getProjectName();
      if (projectFolder) {
        if (!this.localSummaries[today].projects[projectFolder]) {
          this.localSummaries[today].projects[projectFolder] = 0;
        }
        this.localSummaries[today].projects[projectFolder] += secondsToAdd;
      }
    }

    this.todaySummary = this.localSummaries[today];

    if (this.statusBar) {
      this.statusBar.updateTime(this.todaySummary.totalSeconds);
    }

    this.saveLocalSummaries();
  }

  private loadLocalSummaries(): void {
    try {
      if (fs.existsSync(this.localSummaryPath)) {
        const data = fs.readFileSync(this.localSummaryPath, "utf8");
        this.localSummaries = JSON.parse(data);
        log(`Loaded local summaries from ${this.localSummaryPath}`);

        const today = new Date().toISOString().split("T")[0];
        if (this.localSummaries[today]) {
          this.todaySummary = this.localSummaries[today];

          if (this.statusBar && this.todaySummary) {
            this.statusBar.updateTime(this.todaySummary.totalSeconds);
          }
        }
      }
    } catch (error) {
      log(
        `Error loading local summaries: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      this.localSummaries = {};
    }
  }

  private saveLocalSummaries(): void {
    try {
      fs.writeFileSync(
        this.localSummaryPath,
        JSON.stringify(this.localSummaries),
        "utf8"
      );
      this.lastFileModification = Date.now();
    } catch (error) {
      log(
        `Error saving local summaries: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
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

  private async fetchDailySummary(): Promise<void> {
    log("Attempting to fetch daily summary");
    const config = vscode.workspace.getConfiguration("ziit");
    const apiKey = config.get<string>("apiKey");
    const baseUrl = config.get<string>("baseUrl");
    const enabled = config.get<boolean>("enabled");

    if (!enabled) {
      log("Ziit tracking disabled, skipping daily summary fetch");
      return;
    }

    if (!apiKey) {
      log("No API key configured, skipping daily summary fetch");
      return;
    }

    if (!baseUrl) {
      log("No base URL configured, skipping daily summary fetch");
      return;
    }

    if (!this.statusBar) {
      log("No status bar available, skipping daily summary fetch");
      return;
    }

    try {
      const today = new Date().toISOString().split("T")[0];
      const url = new URL(`${baseUrl}/api/external/stats`);
      url.searchParams.append("startDate", today);
      log(`Fetching daily summary from: ${url.toString()}`);

      const requestOptions = {
        hostname: url.hostname,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: url.pathname + url.search,
        method: "GET",
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
      };

      const responseData = await this.makeRequest<DailySummary[]>(
        requestOptions
      );

      this.isOnline = true;

      if (responseData && responseData.length > 0) {
        const todaySummary = responseData[0];
        log(
          `Daily summary received: ${todaySummary.totalSeconds} seconds total`
        );

        const localSeconds = this.todaySummary
          ? this.todaySummary.totalSeconds
          : 0;
        const serverSeconds = todaySummary.totalSeconds;

        if (serverSeconds >= localSeconds) {
          this.updateLocalSummaryFromServer(today, todaySummary);
          if (this.statusBar) {
            this.statusBar.updateTime(serverSeconds);
          }
          log(
            `Using server summary (${serverSeconds}s) over local summary (${localSeconds}s)`
          );
        } else {
          log(
            `Using local summary (${localSeconds}s) over server summary (${serverSeconds}s)`
          );
          if (this.statusBar) {
            this.statusBar.updateTime(localSeconds);
          }
        }
      } else {
        log("No daily summary data received from server, using local data");

        if (this.todaySummary && this.statusBar) {
          this.statusBar.updateTime(this.todaySummary.totalSeconds);
        }
      }
    } catch (error) {
      log(
        `Error fetching daily summary: ${
          error instanceof Error ? error.message : String(error)
        }`
      );

      this.isOnline = false;

      if (this.todaySummary && this.statusBar) {
        this.statusBar.updateTime(this.todaySummary.totalSeconds);
      }
    }
  }

  private updateLocalSummaryFromServer(
    date: string,
    serverSummary: DailySummary
  ): void {
    this.localSummaries[date] = {
      date,
      totalSeconds: serverSummary.totalSeconds,
      lastUpdated: Date.now(),
      projects: { ...serverSummary.projects },
    };

    if (date === new Date().toISOString().split("T")[0]) {
      this.todaySummary = this.localSummaries[date];
    }

    this.saveLocalSummaries();
  }

  private async sendHeartbeat(force: boolean = false): Promise<void> {
    const now = Date.now();

    if (!force && now - this.lastHeartbeat < this.heartbeatInterval) {
      return;
    }

    this.lastHeartbeat = now;
    this.heartbeatCount++;

    if (!this.activeDocumentInfo) {
      log("No active document info, skipping heartbeat");
      return;
    }

    this.lastFile = this.activeDocumentInfo.file;

    const config = vscode.workspace.getConfiguration("ziit");
    const apiKey = config.get<string>("apiKey");
    const baseUrl = config.get<string>("baseUrl");
    const enabled = config.get<boolean>("enabled");

    if (!enabled) {
      log("Ziit tracking disabled, skipping heartbeat");
      return;
    }

    if (!apiKey) {
      log("No API key configured, skipping heartbeat");
      return;
    }

    if (!baseUrl) {
      log("No base URL configured, skipping heartbeat");
      return;
    }

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    const project = workspaceFolder ? workspaceFolder.name : "unknown";

    const heartbeat: Heartbeat = {
      timestamp: new Date().toISOString(),
      project: project,
      language: this.activeDocumentInfo.language,
      file: this.activeDocumentInfo.file,
    };

    log(
      `Preparing heartbeat #${this.heartbeatCount} for file: ${heartbeat.file}`
    );
    log(`Project: ${heartbeat.project}, Language: ${heartbeat.language}`);

    if (!this.isOnline) {
      this.queueOfflineHeartbeat(heartbeat);
      return;
    }

    try {
      const data = JSON.stringify(heartbeat);
      const url = new URL(`${baseUrl}/api/external/heartbeats`);
      log(`Sending to: ${url.toString()}`);

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

      const req = (url.protocol === "https:" ? https : http).request(
        requestOptions,
        (res) => {
          let responseData = "";

          res.on("data", (chunk) => {
            responseData += chunk;
          });

          res.on("end", () => {
            if (
              res.statusCode &&
              res.statusCode >= 200 &&
              res.statusCode < 300
            ) {
              this.successCount++;
              log(
                `Heartbeat #${this.heartbeatCount} sent successfully with status code: ${res.statusCode}`
              );

              this.isOnline = true;
              if (this.offlineHeartbeats.length > 0) {
                this.syncOfflineHeartbeats();
              }
            } else {
              this.failureCount++;
              log(
                `Heartbeat #${this.heartbeatCount} failed with status code: ${res.statusCode}`
              );
              log(`Response data: ${responseData}`);

              this.queueOfflineHeartbeat(heartbeat);
            }
          });
        }
      );

      req.on("error", (e) => {
        this.failureCount++;
        log(`Error sending heartbeat #${this.heartbeatCount}: ${e.message}`);

        this.isOnline = false;
        this.queueOfflineHeartbeat(heartbeat);
      });

      req.write(data);
      req.end();
    } catch (error) {
      this.failureCount++;
      log(
        `Exception sending heartbeat #${this.heartbeatCount}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );

      this.queueOfflineHeartbeat(heartbeat);
    }
  }

  private queueOfflineHeartbeat(heartbeat: Heartbeat): void {
    this.offlineHeartbeats.push(heartbeat);
    log(
      `Queued heartbeat for offline sending. Total offline heartbeats: ${this.offlineHeartbeats.length}`
    );
    this.saveOfflineHeartbeats();
  }

  private loadOfflineHeartbeats(): void {
    try {
      if (fs.existsSync(this.offlineQueuePath)) {
        const data = fs.readFileSync(this.offlineQueuePath, "utf8");
        this.offlineHeartbeats = JSON.parse(data);
        log(
          `Loaded ${this.offlineHeartbeats.length} offline heartbeats from ${this.offlineQueuePath}`
        );
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

  private async syncOfflineHeartbeats(): Promise<void> {
    if (!this.isOnline || this.offlineHeartbeats.length === 0) {
      return;
    }

    log(
      `Attempting to sync ${this.offlineHeartbeats.length} offline heartbeats`
    );

    const config = vscode.workspace.getConfiguration("ziit");
    const apiKey = config.get<string>("apiKey");
    const baseUrl = config.get<string>("baseUrl");

    if (!apiKey || !baseUrl) {
      return;
    }

    const batchSize = 10;
    const batch = this.offlineHeartbeats.slice(0, batchSize);

    try {
      for (const heartbeat of batch) {
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
              let responseData = "";

              res.on("data", (chunk) => {
                responseData += chunk;
              });

              res.on("end", () => {
                if (
                  res.statusCode &&
                  res.statusCode >= 200 &&
                  res.statusCode < 300
                ) {
                  this.successCount++;
                  log(
                    `Offline heartbeat sent successfully with status code: ${res.statusCode}`
                  );
                  resolve();
                } else {
                  reject(
                    new Error(
                      `Failed with status code: ${res.statusCode}, response: ${responseData}`
                    )
                  );
                }
              });
            }
          );

          req.on("error", reject);
          req.write(data);
          req.end();
        });
      }

      this.offlineHeartbeats = this.offlineHeartbeats.slice(batch.length);
      this.saveOfflineHeartbeats();
      log(
        `Successfully synced ${batch.length} offline heartbeats. ${this.offlineHeartbeats.length} remaining.`
      );

      if (batch.length > 0) {
        setTimeout(() => this.fetchDailySummary(), 5000);
      }
    } catch (error) {
      log(
        `Error syncing offline heartbeats: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      this.isOnline = false;
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
                reject(new Error(`Invalid JSON response: ${data} + ${error}`));
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

  private watchLocalSummaryFile(): void {
    try {
      log(`Setting up file watcher for ${this.localSummaryPath}`);
      this.localSummaryWatcher = fs.watch(path.dirname(this.localSummaryPath), (eventType, filename) => {
        if (filename === path.basename(this.localSummaryPath) && eventType === 'change') {
          const stat = fs.statSync(this.localSummaryPath);
          if (stat.mtimeMs > this.lastFileModification + 1000) {
            log('Local summary file changed by another VS Code instance, reloading...');
            this.lastFileModification = stat.mtimeMs;
            this.loadLocalSummaries();
          }
        }
      });
    } catch (error) {
      log(`Error setting up file watcher: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private getProjectName(): string | undefined {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    return workspaceFolder ? workspaceFolder.name : undefined;
  }

  public dispose(): void {
    if (this.localSummaryWatcher) {
      this.localSummaryWatcher.close();
    }
  }
}
