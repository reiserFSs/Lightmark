import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import type { ExportResult, ExportSummaryRequest, PhotoAsset } from "./types";

export function isTauriRuntime(): boolean {
  return "__TAURI_INTERNALS__" in window || "__TAURI__" in window;
}

export async function choosePhoto(): Promise<string | null> {
  if (!isTauriRuntime()) {
    return null;
  }

  const selected = await open({
    multiple: false,
    filters: [
      {
        name: "Photos",
        extensions: ["jpg", "jpeg", "png", "heic", "heif", "tif", "tiff"],
      },
    ],
  });

  return typeof selected === "string" ? selected : null;
}

export async function chooseExportPath(fileName: string): Promise<string | null> {
  if (!isTauriRuntime()) {
    return null;
  }

  const selected = await save({
    defaultPath: fileName,
    filters: [
      { name: "PNG image", extensions: ["png"] },
      { name: "JPEG image", extensions: ["jpg", "jpeg"] },
    ],
  });

  return selected ?? null;
}

export async function loadPhoto(path: string): Promise<PhotoAsset> {
  const asset = await invoke<PhotoAsset>("load_photo", { path });
  return {
    ...asset,
    previewDataUrl: asset.previewDataUrl || convertFileSrc(path),
  };
}

export async function exportSummary(request: ExportSummaryRequest): Promise<ExportResult> {
  return invoke<ExportResult>("export_summary", { request });
}
