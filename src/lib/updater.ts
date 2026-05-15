import { relaunch } from "@tauri-apps/plugin-process";
import { check, type DownloadEvent, type Update } from "@tauri-apps/plugin-updater";
import { isTauriRuntime } from "./tauriApi";

export interface AvailableAppUpdate {
  version: string;
  currentVersion: string;
  date?: string;
  body?: string;
}

export interface UpdateInstallProgress {
  downloadedBytes: number;
  contentLength?: number;
  phase: "starting" | "downloading" | "finished";
}

let pendingUpdate: Update | null = null;

export async function checkForAppUpdate(): Promise<AvailableAppUpdate | null> {
  if (!isTauriRuntime()) {
    return null;
  }

  const update = await check({ timeout: 30_000 });
  pendingUpdate = update;

  if (!update) {
    return null;
  }

  return {
    version: update.version,
    currentVersion: update.currentVersion,
    date: update.date,
    body: update.body,
  };
}

export async function installAppUpdate(onProgress: (progress: UpdateInstallProgress) => void): Promise<void> {
  const update = pendingUpdate ?? (await check({ timeout: 30_000 }));
  if (!update) {
    throw new Error("No update is available.");
  }

  let downloadedBytes = 0;
  let contentLength: number | undefined;

  await update.downloadAndInstall((event: DownloadEvent) => {
    if (event.event === "Started") {
      contentLength = event.data.contentLength;
      downloadedBytes = 0;
      onProgress({ downloadedBytes, contentLength, phase: "starting" });
      return;
    }

    if (event.event === "Progress") {
      downloadedBytes += event.data.chunkLength;
      onProgress({ downloadedBytes, contentLength, phase: "downloading" });
      return;
    }

    onProgress({ downloadedBytes, contentLength, phase: "finished" });
  });

  pendingUpdate = null;
  await relaunch();
}
