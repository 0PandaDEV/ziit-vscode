import * as vscode from "vscode";
import { log } from "./log";

export class StatusBarManager {
  private statusBarItem: vscode.StatusBarItem;
  private totalSeconds: number = 0;
  private trackingStartTime: number = 0;
  private isTracking: boolean = false;
  private updateInterval: NodeJS.Timeout | null = null;

  constructor() {
    this.statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      10
    );
    this.statusBarItem.command = "ziit.openDashboard";
    this.statusBarItem.text = "$(clock) 0 hrs 0 mins";
    this.statusBarItem.tooltip = "Ziit: Today's coding time. Click to visit dashboard";

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
      if (this.isTracking) {
        this.updateStatusBar();
      }
    }, 60000);
  }

  public startTracking(): void {
    if (!this.isTracking) {
      this.isTracking = true;
      this.trackingStartTime = Date.now();
      log("Started time tracking");
    }
  }

  public stopTracking(): void {
    if (this.isTracking) {
      this.isTracking = false;
      const elapsedSeconds = Math.floor(
        (Date.now() - this.trackingStartTime) / 1000
      );
      this.totalSeconds += elapsedSeconds;
      this.updateStatusBar();
      log(`Stopped time tracking, added ${elapsedSeconds} seconds`);
    }
  }

  public updateTime(seconds: number): void {
    this.totalSeconds = seconds;
    this.updateStatusBar();
  }

  private updateStatusBar(): void {
    const config = vscode.workspace.getConfiguration("ziit");
    if (!config.get<boolean>("statusBarEnabled", true)) {
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

    const showCodingActivity = config.get<boolean>(
      "statusBarCodingActivity",
      true
    );
    if (showCodingActivity) {
      this.statusBarItem.text = `$(clock) ${hours} hrs ${minutes} mins coding`;
    } else {
      this.statusBarItem.text = `$(clock) ${hours} hrs ${minutes} mins`;
    }
  }

  public dispose(): void {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
    }
    this.statusBarItem.dispose();
  }
}
