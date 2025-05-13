import * as vscode from "vscode";

export class StatusBarManager {
  private statusBarItem: vscode.StatusBarItem;
  private totalSeconds: number = 0;
  private trackingStartTime: number = 0;
  private isTracking: boolean = false;
  private updateInterval: NodeJS.Timeout | null = null;
  private isOnline: boolean = true;
  private hasValidApiKey: boolean = true;

  constructor() {
    this.statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      100
    );
    this.statusBarItem.command = "ziit.openDashboard";
    this.statusBarItem.show();

    const config = vscode.workspace.getConfiguration("ziit");
    if (config.get<boolean>("statusBarEnabled", true)) {
      this.statusBarItem.show();
    }

    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("ziit.statusBarEnabled")) {
        const config = vscode.workspace.getConfiguration("ziit");
        if (config.get<boolean>("statusBarEnabled", true)) {
          this.statusBarItem.show();
        } else {
          this.statusBarItem.hide();
        }
      }
    });

    this.setupUpdateInterval();
  }

  private setupUpdateInterval(): void {
    this.updateInterval = setInterval(() => {
      this.updateStatusBar(true);
    }, 60000);
  }

  public startTracking(): void {
    if (!this.isTracking) {
      this.isTracking = true;
      this.trackingStartTime = Date.now();
      this.updateStatusBar(true);
    }
  }

  public stopTracking(): void {
    if (this.isTracking) {
      this.isTracking = false;
      this.updateStatusBar(true);
    }
  }

  public updateTime(hours: number, minutes: number): void {
    this.totalSeconds = hours * 3600 + minutes * 60;
    this.updateStatusBar(true);
  }

  public setOnlineStatus(isOnline: boolean): void {
    this.isOnline = isOnline;
    this.updateStatusBar(true);
  }

  public setApiKeyStatus(isValid: boolean): void {
    this.hasValidApiKey = isValid;
    this.updateStatusBar(true);
  }

  private updateStatusBar(forceUpdate: boolean = false): void {
    const config = vscode.workspace.getConfiguration("ziit");
    if (!config.get<boolean>("statusBarEnabled", true)) {
      return;
    }

    if (!this.hasValidApiKey) {
      this.statusBarItem.text = "$(error) Unconfigured";
      this.statusBarItem.tooltip = "Invalid or missing API key. Click to configure.";
      this.statusBarItem.color = new vscode.ThemeColor("errorForeground");
      return;
    }

    let displaySeconds = this.totalSeconds;

    if (this.isTracking) {
      const elapsedSeconds = Math.floor(
        (Date.now() - this.trackingStartTime) / 1000
      );
      displaySeconds += elapsedSeconds;
    }

    const hours = Math.floor(displaySeconds / 3600);
    const minutes = Math.floor((displaySeconds % 3600) / 60);

    if (forceUpdate) {
      this.statusBarItem.color = new vscode.ThemeColor(
        "statusBarItem.prominentForeground"
      );
      setTimeout(() => {
        this.statusBarItem.color = undefined;
      }, 1000);
    }

    if (!this.isOnline) {
      this.statusBarItem.text = `$(sync~spin) ${hours} hrs ${minutes} mins (offline)`;
      this.statusBarItem.tooltip = "Working offline. Changes will be synced when online.";
      this.statusBarItem.color = new vscode.ThemeColor("statusBarItem.warningForeground");
      return;
    }

    this.statusBarItem.text = `$(clock) ${hours} hrs ${minutes} mins`;
    this.statusBarItem.tooltip = "Ziit: Today's coding time. Click to open dashboard.";
    this.statusBarItem.color = undefined;
  }

  public dispose(): void {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
    }
    this.statusBarItem.dispose();
  }
}
