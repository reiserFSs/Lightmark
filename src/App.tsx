import { ChangeEvent, DragEvent, useEffect, useMemo, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Download, FolderOpen, Image as ImageIcon } from "lucide-react";
import { parseBrowserExif } from "./lib/browserExif";
import { buildRenderMetadata, EMPTY_FIELDS, fieldsFromExif } from "./lib/metadata";
import {
  canvasToDataUrl,
  DEFAULT_BLUR_RADIUS,
  getRenderSize,
  loadImage,
  renderBlurredBackground,
  renderSummaryCanvas,
} from "./lib/renderer";
import { DEFAULT_THEME, THEMES } from "./lib/themes";
import {
  chooseExportPath,
  choosePhoto,
  exportSummary,
  isTauriRuntime,
  loadPhoto,
} from "./lib/tauriApi";
import { checkForAppUpdate, installAppUpdate, type AvailableAppUpdate, type UpdateInstallProgress } from "./lib/updater";
import type { BlurBackend, OverlayPosition } from "./lib/renderer";
import type { NormalizedExif, OutputFormat, PhotoAsset, UserFieldKey, UserPhotoFields } from "./lib/types";

const FIELD_GROUPS: Array<{ title: string; fields: Array<{ key: UserFieldKey; label: string }> }> = [
  {
    title: "Camera",
    fields: [
      { key: "aperture", label: "Aperture" },
      { key: "shutterSpeed", label: "Shutter" },
      { key: "iso", label: "ISO" },
      { key: "bitDepth", label: "Bit Depth" },
      { key: "focalLength", label: "Focal Length" },
      { key: "cameraBody", label: "Camera Body" },
      { key: "lens", label: "Lens" },
      { key: "captureTime", label: "Capture Time" },
    ],
  },
  {
    title: "Production",
    fields: [
      { key: "lightingModifier", label: "Lighting Modifier" },
      { key: "lightSource", label: "Light Source" },
      { key: "photographer", label: "Photographer" },
      { key: "notes", label: "Notes" },
    ],
  },
];

const APP_SETTINGS_KEY = "lightmark.settings";
const PRESETS_KEY = "lightmark.presets";
const PRODUCTION_FIELD_KEYS = ["lightingModifier", "lightSource", "photographer", "notes"] as const;
const USER_FIELD_KEYS: UserFieldKey[] = [
  "aperture",
  "shutterSpeed",
  "iso",
  "focalLength",
  "cameraBody",
  "lens",
  "captureTime",
  "bitDepth",
  "lightingModifier",
  "lightSource",
  "photographer",
  "notes",
];
const OVERLAY_POSITIONS: Array<{ value: OverlayPosition; label: string }> = [
  { value: "top-left", label: "Top left" },
  { value: "top-right", label: "Top right" },
  { value: "center-left", label: "Center left" },
  { value: "center-right", label: "Center right" },
  { value: "bottom-left", label: "Bottom left" },
  { value: "bottom-right", label: "Bottom right" },
];
const SUPPORTED_IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "heic", "heif", "tif", "tiff"]);
const SUPPORTED_IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/heic", "image/heif", "image/tiff", "image/x-tiff"]);

declare const __APP_VERSION__: string;

type BlurBackendStatus = BlurBackend | "Rendering" | "Idle";
type ActivityStepState = "pending" | "active" | "done" | "error";
type ProductionFieldKey = (typeof PRODUCTION_FIELD_KEYS)[number];
type ProductionFields = Pick<UserPhotoFields, ProductionFieldKey>;
type FieldVisibility = Record<UserFieldKey, boolean>;

interface StoredSettings {
  themeId: string;
  format: OutputFormat;
  blurRadius: number;
  showPanelRule: boolean;
  overlayPosition: OverlayPosition;
  fieldVisibility: FieldVisibility;
}

interface UserPreset {
  id: string;
  name: string;
  productionFields: ProductionFields;
  themeId: string;
  format: OutputFormat;
  blurRadius: number;
  showPanelRule: boolean;
  overlayPosition: OverlayPosition;
  fieldVisibility: FieldVisibility;
}

interface ActivityStep {
  id: string;
  label: string;
  state: ActivityStepState;
}

interface ActivityState {
  title: string;
  steps: ActivityStep[];
}

export function App() {
  const [initialSettings] = useState(loadStoredSettings);
  const [asset, setAsset] = useState<PhotoAsset | null>(null);
  const [fields, setFields] = useState<UserPhotoFields>(EMPTY_FIELDS);
  const [themeId, setThemeId] = useState(initialSettings.themeId);
  const [format, setFormat] = useState<OutputFormat>(initialSettings.format);
  const [blurInput, setBlurInput] = useState(initialSettings.blurRadius);
  const [blurRadius, setBlurRadius] = useState(initialSettings.blurRadius);
  const [showPanelRule, setShowPanelRule] = useState(initialSettings.showPanelRule);
  const [overlayPosition, setOverlayPosition] = useState(initialSettings.overlayPosition);
  const [fieldVisibility, setFieldVisibility] = useState(initialSettings.fieldVisibility);
  const [presets, setPresets] = useState<UserPreset[]>(loadStoredPresets);
  const [selectedPresetId, setSelectedPresetId] = useState("");
  const [presetName, setPresetName] = useState("");
  const [status, setStatus] = useState("Open a photo to begin.");
  const [activity, setActivity] = useState<ActivityState | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const [availableUpdate, setAvailableUpdate] = useState<AvailableAppUpdate | null>(null);
  const [updateStatus, setUpdateStatus] = useState("Running latest release");
  const [isCheckingUpdate, setIsCheckingUpdate] = useState(false);
  const [isInstallingUpdate, setIsInstallingUpdate] = useState(false);
  const [isDraggingPhoto, setIsDraggingPhoto] = useState(false);
  const [previewImage, setPreviewImage] = useState<HTMLImageElement | null>(null);
  const [previewBackground, setPreviewBackground] = useState<HTMLCanvasElement | null>(null);
  const [blurBackend, setBlurBackend] = useState<BlurBackendStatus>("Idle");
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const pendingBrowserOpenRef = useRef(false);
  const photoLoadIdRef = useRef(0);
  const renderFrameRef = useRef<number | null>(null);
  const blurBackendRef = useRef<BlurBackend | null>(null);

  const theme = useMemo(() => THEMES.find((candidate) => candidate.id === themeId) ?? DEFAULT_THEME, [themeId]);
  const rows = useMemo(
    () => buildRenderMetadata(fields).filter((row) => fieldVisibility[row.key]),
    [fields, fieldVisibility],
  );
  const selectedPreset = useMemo(
    () => presets.find((preset) => preset.id === selectedPresetId) ?? null,
    [presets, selectedPresetId],
  );
  const renderSize = useMemo(
    () => (asset ? getRenderSize(asset.width, asset.height) : getRenderSize(16, 9)),
    [asset],
  );

  useEffect(() => {
    saveStoredSettings({ themeId, format, blurRadius, showPanelRule, overlayPosition, fieldVisibility });
  }, [themeId, format, blurRadius, showPanelRule, overlayPosition, fieldVisibility]);

  useEffect(() => {
    saveStoredPresets(presets);
  }, [presets]);

  useEffect(() => {
    if (!isTauriRuntime() || isDevBuild()) {
      return;
    }

    void checkForUpdates(false);
  }, []);

  useEffect(() => {
    if (!isTauriRuntime()) {
      return;
    }

    let unlisten: (() => void) | null = null;
    getCurrentWindow()
      .onDragDropEvent((event) => {
        if (event.payload.type === "enter" || event.payload.type === "over") {
          setIsDraggingPhoto(true);
          return;
        }

        setIsDraggingPhoto(false);
        if (event.payload.type !== "drop") {
          return;
        }

        const path = event.payload.paths.find(isSupportedImagePath);
        if (!path) {
          setStatus("Drop a supported photo file: JPEG, PNG, TIFF, or HEIC.");
          return;
        }

        void loadTauriPhoto(path);
      })
      .then((cleanup) => {
        unlisten = cleanup;
      })
      .catch((error: Error) => setStatus(error.message));

    return () => {
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    if (blurInput === blurRadius) {
      return;
    }

    if (blurBackendRef.current === "WebGL") {
      setBlurRadius(blurInput);
      return;
    }

    const timeout = window.setTimeout(() => setBlurRadius(blurInput), 180);
    return () => window.clearTimeout(timeout);
  }, [blurInput, blurRadius]);

  useEffect(() => {
    if (!asset) {
      setPreviewImage(null);
      setPreviewBackground(null);
      blurBackendRef.current = null;
      setBlurBackend("Idle");
      return;
    }

    let cancelled = false;
    loadImage(asset.previewDataUrl)
      .then((image) => {
        if (!cancelled) {
          setPreviewImage(image);
        }
      })
      .catch((error: Error) => {
        if (!cancelled) {
          failActiveActivityStep();
          setStatus(error.message);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [asset]);

  useEffect(() => {
    if (!previewImage) {
      setPreviewBackground(null);
      blurBackendRef.current = null;
      setBlurBackend("Idle");
      return;
    }

    let cancelled = false;
    setBlurBackend(blurBackendRef.current ?? "Rendering");
    window.requestAnimationFrame(() => {
      if (!cancelled) {
        const background = renderBlurredBackground(previewImage, renderSize, 0.5, blurRadius);
        setPreviewBackground(background.canvas);
        blurBackendRef.current = background.backend;
        setBlurBackend(background.backend);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [previewImage, renderSize, blurRadius]);

  useEffect(() => {
    if (!previewImage || !previewBackground || !canvasRef.current) {
      return;
    }

    if (renderFrameRef.current) {
      window.cancelAnimationFrame(renderFrameRef.current);
    }

    renderFrameRef.current = window.requestAnimationFrame(() => {
      if (canvasRef.current) {
        renderSummaryCanvas(
          canvasRef.current,
          previewImage,
          rows,
          theme,
          renderSize,
          0.5,
          previewBackground,
          blurRadius,
          showPanelRule,
          overlayPosition,
        );
        completeActivityStep("render");
        finishActivitySoon();
      }
    });

    return () => {
      if (renderFrameRef.current) {
        window.cancelAnimationFrame(renderFrameRef.current);
        renderFrameRef.current = null;
      }
    };
  }, [previewImage, previewBackground, rows, theme, renderSize, blurRadius, showPanelRule, overlayPosition]);

  async function handleOpenPhoto() {
    setIsBusy(true);
    setStatus("Choose a photo...");

    try {
      if (isTauriRuntime()) {
        const path = await choosePhoto();
        if (!path) {
          setStatus("Open cancelled.");
          return;
        }

        await loadTauriPhoto(path);
        return;
      }

      pendingBrowserOpenRef.current = true;
      const handleFocus = () => {
        window.setTimeout(() => {
          if (pendingBrowserOpenRef.current) {
            pendingBrowserOpenRef.current = false;
            setStatus("No photo selected.");
          }
          window.removeEventListener("focus", handleFocus);
        }, 300);
      };
      window.addEventListener("focus", handleFocus);
      fileInputRef.current?.click();
    } catch (error) {
      setStatus(errorMessage(error, "Could not open photo."));
    } finally {
      setIsBusy(false);
    }
  }

  async function loadTauriPhoto(path: string) {
    const loadId = beginPhotoLoad();
    setIsBusy(true);
    setStatus(`Loading ${fileNameFromPath(path)}...`);
    startActivity("Opening photo", [
      { id: "prepare", label: "Read metadata and prepare preview" },
      { id: "render", label: "Render preview" },
    ]);
    try {
      setActivityStep("prepare", "active");
      const loaded = await withTimeout(loadPhoto(path), 45000, "Photo loading timed out. Try a smaller JPEG/PNG/TIFF file.");
      if (!isCurrentPhotoLoad(loadId)) {
        return;
      }
      setActivityStep("prepare", "done");
      setActivityStep("render", "active");
      setLoadedPhoto(loaded);
    } catch (error) {
      if (!isCurrentPhotoLoad(loadId)) {
        return;
      }
      setActivityStep("prepare", "error");
      setStatus(errorMessage(error, "Could not open photo."));
    } finally {
      if (isCurrentPhotoLoad(loadId)) {
        setIsBusy(false);
      }
    }
  }

  async function handleBrowserFile(event: ChangeEvent<HTMLInputElement>) {
    pendingBrowserOpenRef.current = false;
    const file = event.target.files?.[0];
    if (!file) {
      setStatus("Open cancelled.");
      return;
    }

    await loadBrowserPhoto(file);
    event.target.value = "";
  }

  async function loadBrowserPhoto(file: File) {
    if (!isSupportedImageFile(file)) {
      setStatus("Drop a supported photo file: JPEG, PNG, TIFF, or HEIC.");
      return;
    }

    const loadId = beginPhotoLoad();
    setIsBusy(true);
    setStatus(`Reading ${file.name}...`);
    startActivity("Opening photo", [
      { id: "metadata", label: "Read browser metadata" },
      { id: "image", label: "Load image data" },
      { id: "render", label: "Render preview" },
    ]);
    try {
      setActivityStep("metadata", "active");
      const exif = await parseBrowserExif(file);
      if (!isCurrentPhotoLoad(loadId)) {
        return;
      }
      setActivityStep("metadata", "done");
      setActivityStep("image", "active");
      const previewDataUrl = await readFileAsDataUrl(file);
      if (!isCurrentPhotoLoad(loadId)) {
        return;
      }
      const dimensions = await withTimeout(
        readImageDimensions(previewDataUrl),
        15000,
        "This browser preview cannot decode the selected file. Use JPEG/PNG here, or run the Tauri app for TIFF/HEIC.",
      );
      if (!isCurrentPhotoLoad(loadId)) {
        return;
      }
      setActivityStep("image", "done");
      setActivityStep("render", "active");
      setLoadedPhoto({
        path: file.name,
        fileName: file.name,
        mimeType: file.type || "application/octet-stream",
        width: dimensions.width,
        height: dimensions.height,
        previewDataUrl,
        exif,
      });
    } catch (error) {
      if (!isCurrentPhotoLoad(loadId)) {
        return;
      }
      failActiveActivityStep();
      setStatus(errorMessage(error, "Could not read photo."));
    } finally {
      if (isCurrentPhotoLoad(loadId)) {
        setIsBusy(false);
      }
    }
  }

  function beginPhotoLoad(): number {
    photoLoadIdRef.current += 1;
    return photoLoadIdRef.current;
  }

  function isCurrentPhotoLoad(loadId: number): boolean {
    return photoLoadIdRef.current === loadId;
  }

  function handleStageDragOver(event: DragEvent<HTMLElement>) {
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setIsDraggingPhoto(true);
  }

  function handleStageDragLeave(event: DragEvent<HTMLElement>) {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) {
      return;
    }

    setIsDraggingPhoto(false);
  }

  function handleStageDrop(event: DragEvent<HTMLElement>) {
    event.preventDefault();
    setIsDraggingPhoto(false);

    const file = Array.from(event.dataTransfer.files).find(isSupportedImageFile);
    if (!file) {
      setStatus("Drop a supported photo file: JPEG, PNG, TIFF, or HEIC.");
      return;
    }

    void loadBrowserPhoto(file);
  }

  function setLoadedPhoto(loaded: PhotoAsset) {
    setPreviewImage(null);
    setPreviewBackground(null);
    blurBackendRef.current = null;
    setBlurBackend("Rendering");
    setAsset(loaded);
    setFields((current) => mergeLoadedFields(fieldsFromExif(loaded.exif), current));
    const exifCount = Object.values(loaded.exif).filter(Boolean).length;
    const exifStatus = exifCount > 0 ? `${exifCount} metadata fields` : "no EXIF/XMP found";
    setStatus(`${loaded.fileName} loaded (${loaded.width} x ${loaded.height}, ${exifStatus}).`);
  }

  function updateField(key: UserFieldKey, value: string) {
    setFields((current) => ({ ...current, [key]: value }));
  }

  function updateFieldVisibility(key: UserFieldKey, visible: boolean) {
    setFieldVisibility((current) => ({ ...current, [key]: visible }));
  }

  function commitBlur() {
    setBlurRadius(blurInput);
  }

  function updateBlur(value: number) {
    setBlurInput(value);

    if (blurBackendRef.current === "WebGL") {
      setBlurRadius(value);
    }
  }

  function handlePresetSelection(id: string) {
    setSelectedPresetId(id);
    const preset = presets.find((candidate) => candidate.id === id);
    setPresetName(preset?.name ?? "");
  }

  function saveCurrentPreset() {
    const name = presetName.trim() || selectedPreset?.name || "Untitled preset";
    const preset: UserPreset = {
      id: selectedPreset?.id ?? createPresetId(),
      name,
      productionFields: productionFieldsFrom(fields),
      themeId,
      format,
      blurRadius,
      showPanelRule,
      overlayPosition,
      fieldVisibility,
    };

    setPresets((current) => {
      const existingIndex = current.findIndex((candidate) => candidate.id === preset.id);
      if (existingIndex === -1) {
        return [...current, preset].sort(comparePresetName);
      }

      return current
        .map((candidate) => (candidate.id === preset.id ? preset : candidate))
        .sort(comparePresetName);
    });
    setSelectedPresetId(preset.id);
    setPresetName(name);
    setStatus(`Saved preset "${name}".`);
  }

  function applySelectedPreset() {
    if (!selectedPreset) {
      setStatus("Choose a preset to apply.");
      return;
    }

    setFields((current) => ({ ...current, ...selectedPreset.productionFields }));
    setThemeId(selectedPreset.themeId);
    setFormat(selectedPreset.format);
    setBlurInput(selectedPreset.blurRadius);
    setBlurRadius(selectedPreset.blurRadius);
    setShowPanelRule(selectedPreset.showPanelRule);
    setOverlayPosition(selectedPreset.overlayPosition);
    setFieldVisibility(selectedPreset.fieldVisibility);
    setStatus(`Applied preset "${selectedPreset.name}".`);
  }

  function deleteSelectedPreset() {
    if (!selectedPreset) {
      setStatus("Choose a preset to delete.");
      return;
    }

    const deletedName = selectedPreset.name;
    setPresets((current) => current.filter((preset) => preset.id !== selectedPreset.id));
    setSelectedPresetId("");
    setPresetName("");
    setStatus(`Deleted preset "${deletedName}".`);
  }

  async function handleExport() {
    if (!asset) {
      setStatus("Open a photo before exporting.");
      return;
    }

    setIsBusy(true);
    setStatus("Rendering export...");
    startActivity("Exporting summary", [
      { id: "load", label: "Load preview image" },
      { id: "background", label: "Render blurred background" },
      { id: "compose", label: "Compose summary" },
      { id: "encode", label: "Encode output" },
      { id: "save", label: isTauriRuntime() ? "Save file" : "Download file" },
    ]);
    try {
      setActivityStep("load", "active");
      await nextFrame();
      const image = await loadImage(asset.previewDataUrl);
      setActivityStep("load", "done");

      setActivityStep("background", "active");
      await nextFrame();
      const canvas = document.createElement("canvas");
      const background = renderBlurredBackground(image, renderSize, 1, blurRadius);
      setActivityStep("background", "done");

      setActivityStep("compose", "active");
      await nextFrame();
      renderSummaryCanvas(
        canvas,
        image,
        rows,
        theme,
        renderSize,
        1,
        background.canvas,
        blurRadius,
        showPanelRule,
        overlayPosition,
      );
      setActivityStep("compose", "done");

      setActivityStep("encode", "active");
      await nextFrame();
      const dataUrl = canvasToDataUrl(canvas, format);
      setActivityStep("encode", "done");
      const extension = format === "jpg" ? "jpg" : "png";
      const fileName = `${stripExtension(asset.fileName)}-summary.${extension}`;

      if (isTauriRuntime()) {
        setActivityStep("save", "active");
        const outputPath = await chooseExportPath(fileName);
        if (!outputPath) {
          setStatus("Export cancelled.");
          setActivity(null);
          return;
        }

        const result = await exportSummary({ fileName, dataUrl, outputPath });
        setActivityStep("save", "done");
        finishActivitySoon();
        setStatus(`Exported ${result.outputPath}.`);
        return;
      }

      setActivityStep("save", "active");
      downloadDataUrl(dataUrl, fileName);
      setActivityStep("save", "done");
      finishActivitySoon();
      setStatus(`Exported ${fileName}.`);
    } catch (error) {
      failActiveActivityStep();
      setStatus(errorMessage(error, "Could not export image."));
    } finally {
      setIsBusy(false);
    }
  }

  async function checkForUpdates(showUpToDateStatus = true) {
    if (!isTauriRuntime()) {
      setUpdateStatus("Updates are available in desktop builds.");
      return;
    }

    setIsCheckingUpdate(true);
    setUpdateStatus("Checking for updates...");

    try {
      const update = await checkForAppUpdate();
      setAvailableUpdate(update);
      if (update) {
        setUpdateStatus(`Version ${update.version} is available.`);
        return;
      }

      setUpdateStatus("Running latest release");
    } catch (error) {
      setAvailableUpdate(null);
      const message = errorMessage(error, "Could not check for updates.");
      setUpdateStatus(isMissingReleaseMetadata(message) ? "Running latest release" : message);
    } finally {
      setIsCheckingUpdate(false);
    }
  }

  async function installAvailableUpdate() {
    setIsInstallingUpdate(true);
    setUpdateStatus("Preparing update...");

    try {
      await installAppUpdate((progress) => {
        setUpdateStatus(formatUpdateProgress(progress));
      });
      setUpdateStatus("Update installed. Restarting...");
    } catch (error) {
      setUpdateStatus(errorMessage(error, "Could not install update."));
    } finally {
      setIsInstallingUpdate(false);
    }
  }

  function startActivity(title: string, steps: Array<{ id: string; label: string }>) {
    setActivity({
      title,
      steps: steps.map((step, index) => ({
        ...step,
        state: index === 0 ? "active" : "pending",
      })),
    });
  }

  function setActivityStep(id: string, state: ActivityStepState) {
    setActivity((current) => {
      if (!current) {
        return current;
      }

      return {
        ...current,
        steps: current.steps.map((step) => {
          if (step.id === id) {
            return { ...step, state };
          }

          if (state === "active" && step.state === "active") {
            return { ...step, state: "done" };
          }

          return step;
        }),
      };
    });
  }

  function completeActivityStep(id: string) {
    setActivity((current) => {
      if (!current?.steps.some((step) => step.id === id && step.state === "active")) {
        return current;
      }

      return {
        ...current,
        steps: current.steps.map((step) => (step.id === id ? { ...step, state: "done" } : step)),
      };
    });
  }

  function failActiveActivityStep() {
    setActivity((current) => {
      if (!current) {
        return current;
      }

      return {
        ...current,
        steps: current.steps.map((step) => (step.state === "active" ? { ...step, state: "error" } : step)),
      };
    });
  }

  function finishActivitySoon() {
    window.setTimeout(() => {
      setActivity((current) => {
        if (!current || current.steps.some((step) => step.state === "active" || step.state === "error")) {
          return current;
        }

        return null;
      });
    }, 1800);
  }

  return (
    <main className="app-shell">
      <input
        ref={fileInputRef}
        className="hidden-input"
        type="file"
        accept="image/jpeg,image/png,image/tiff,image/heic,image/heif"
        onChange={handleBrowserFile}
      />

      <section className="workspace">
        <aside className="left-rail">
          <div className="brand-block">
            <ImageIcon aria-hidden="true" size={24} />
            <div>
              <h1>Lightmark</h1>
              <p>{status}</p>
            </div>
          </div>

          {activity && <ActivityPanel activity={activity} />}

          <button className="primary-action" type="button" onClick={handleOpenPhoto} disabled={isBusy}>
            <FolderOpen aria-hidden="true" size={18} />
            Open Photo
          </button>

          <div className="control-block">
            <label htmlFor="theme">Theme</label>
            <select id="theme" value={themeId} onChange={(event) => setThemeId(event.target.value)}>
              {THEMES.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.name}
                </option>
              ))}
            </select>
          </div>

          <div className="control-block">
            <label htmlFor="overlay-position">Overlay position</label>
            <select
              id="overlay-position"
              value={overlayPosition}
              onChange={(event) => setOverlayPosition(event.target.value as OverlayPosition)}
            >
              {OVERLAY_POSITIONS.map((position) => (
                <option key={position.value} value={position.value}>
                  {position.label}
                </option>
              ))}
            </select>
          </div>

          <div className="control-block">
            <div className="range-label">
              <label htmlFor="blur">Blur</label>
              <span>{blurInput}</span>
            </div>
            <input
              id="blur"
              className="range-input"
              type="range"
              min="0"
              max="28"
              step="1"
              value={blurInput}
              onBlur={commitBlur}
              onChange={(event) => updateBlur(Number(event.target.value))}
              onKeyUp={commitBlur}
              onPointerUp={commitBlur}
            />
            <div className="backend-status" aria-live="polite">
              <span>Renderer</span>
              <strong className={`backend-pill ${backendClassName(blurBackend)}`}>
                {backendLabel(blurBackend)}
              </strong>
            </div>
          </div>

          <div className="control-block">
            <span className="control-label">Export as</span>
            <div className="segmented-control" aria-label="Export format">
              <button className={format === "png" ? "selected" : ""} type="button" onClick={() => setFormat("png")}>
                PNG
              </button>
              <button className={format === "jpg" ? "selected" : ""} type="button" onClick={() => setFormat("jpg")}>
                JPG
              </button>
            </div>
          </div>

          <div className="control-block">
            <label className="toggle-row">
              <span>Divider line</span>
              <input
                type="checkbox"
                checked={showPanelRule}
                onChange={(event) => setShowPanelRule(event.target.checked)}
              />
              <span className="switch-control" aria-hidden="true" />
            </label>
          </div>

          <div className="control-block preset-block">
            <label htmlFor="preset">Preset</label>
            <select id="preset" value={selectedPresetId} onChange={(event) => handlePresetSelection(event.target.value)}>
              <option value="">No preset selected</option>
              {presets.map((preset) => (
                <option key={preset.id} value={preset.id}>
                  {preset.name}
                </option>
              ))}
            </select>
            <input
              aria-label="Preset name"
              value={presetName}
              placeholder="Preset name"
              onChange={(event) => setPresetName(event.target.value)}
            />
            <div className="preset-actions">
              <button className="secondary-action" type="button" onClick={saveCurrentPreset}>
                Save
              </button>
              <button className="secondary-action" type="button" onClick={applySelectedPreset} disabled={!selectedPreset}>
                Apply
              </button>
              <button className="danger-action" type="button" onClick={deleteSelectedPreset} disabled={!selectedPreset}>
                Delete
              </button>
            </div>
          </div>

          <button className="export-action" type="button" onClick={handleExport} disabled={!asset || isBusy}>
            <Download aria-hidden="true" size={18} />
            Export
          </button>

          <div className="update-panel">
            <div>
              <strong>Updates</strong>
              <p>{updateStatus}</p>
              {availableUpdate?.body && <pre className="release-notes">{availableUpdate.body}</pre>}
            </div>
            {availableUpdate ? (
              <button className="update-action" type="button" onClick={installAvailableUpdate} disabled={isInstallingUpdate}>
                {isInstallingUpdate ? "Installing" : "Install"}
              </button>
            ) : (
              <button
                className="update-action"
                type="button"
                onClick={() => void checkForUpdates()}
                disabled={isCheckingUpdate || isInstallingUpdate}
              >
                {isCheckingUpdate ? "Checking" : "Check"}
              </button>
            )}
          </div>

          <div className="version-indicator">Lightmark v{__APP_VERSION__}</div>
        </aside>

        <section
          className={`preview-stage ${isDraggingPhoto ? "drag-active" : ""}`}
          onDragOver={handleStageDragOver}
          onDragLeave={handleStageDragLeave}
          onDrop={handleStageDrop}
        >
          {isDraggingPhoto && (
            <div className="drop-overlay" aria-hidden="true">
              <ImageIcon size={34} />
              <span>Drop photo to open</span>
            </div>
          )}
          {asset ? (
            <canvas
              ref={canvasRef}
              className="summary-canvas"
              aria-label="Photo summary preview"
              width={Math.round(renderSize.width / 2)}
              height={Math.round(renderSize.height / 2)}
            />
          ) : (
            <button className="drop-zone" type="button" onClick={handleOpenPhoto}>
              <ImageIcon aria-hidden="true" size={42} />
              <span>Open Photo</span>
            </button>
          )}
        </section>

          <aside className="field-panel">
          {FIELD_GROUPS.map((group) => (
            <fieldset key={group.title}>
              <legend>{group.title}</legend>
              {group.fields.map((field) => (
                <div key={field.key} className="field-row">
                  <div className="field-row-heading">
                    <label htmlFor={`field-${field.key}`}>{field.label}</label>
                    <label className="visibility-toggle">
                      <span>Show</span>
                      <input
                        type="checkbox"
                        checked={fieldVisibility[field.key]}
                        onChange={(event) => updateFieldVisibility(field.key, event.target.checked)}
                      />
                      <span className="switch-control" aria-hidden="true" />
                    </label>
                  </div>
                  <input
                    id={`field-${field.key}`}
                    value={fields[field.key]}
                    placeholder={placeholderFor(field.key, asset?.exif)}
                    onChange={(event) => updateField(field.key, event.target.value)}
                  />
                </div>
              ))}
            </fieldset>
          ))}
        </aside>
      </section>
    </main>
  );
}

function backendLabel(status: BlurBackendStatus): string {
  if (status === "WebGL") {
    return "WebGL GPU";
  }

  if (status === "CPU") {
    return "CPU fallback";
  }

  return status;
}

function formatUpdateProgress(progress: UpdateInstallProgress): string {
  if (progress.phase === "starting") {
    return "Downloading update...";
  }

  if (progress.phase === "finished") {
    return "Installing update...";
  }

  if (!progress.contentLength) {
    return "Downloading update...";
  }

  const percent = Math.min(100, Math.round((progress.downloadedBytes / progress.contentLength) * 100));
  return `Downloading update ${percent}%...`;
}

function isDevBuild(): boolean {
  return Boolean((import.meta as ImportMeta & { env?: { DEV?: boolean } }).env?.DEV);
}

function isMissingReleaseMetadata(message: string): boolean {
  return /valid release json|latest\.json|404|not found/i.test(message);
}

function backendClassName(status: BlurBackendStatus): string {
  return status.toLowerCase();
}

function ActivityPanel({ activity }: { activity: ActivityState }) {
  return (
    <div className="activity-panel" aria-live="polite">
      <div className="activity-title">{activity.title}</div>
      <ol>
        {activity.steps.map((step) => (
          <li key={step.id} className={`activity-step ${step.state}`}>
            <span aria-hidden="true" />
            {step.label}
          </li>
        ))}
      </ol>
    </div>
  );
}

function mergeLoadedFields(next: UserPhotoFields, current: UserPhotoFields): UserPhotoFields {
  return {
    ...next,
    lightingModifier: current.lightingModifier,
    lightSource: current.lightSource,
    photographer: current.photographer || next.photographer,
    notes: current.notes,
  };
}

function productionFieldsFrom(fields: UserPhotoFields): ProductionFields {
  return {
    lightingModifier: fields.lightingModifier,
    lightSource: fields.lightSource,
    photographer: fields.photographer,
    notes: fields.notes,
  };
}

function loadStoredSettings(): StoredSettings {
  const fallback: StoredSettings = {
    themeId: DEFAULT_THEME.id,
    format: "png",
    blurRadius: DEFAULT_BLUR_RADIUS,
    showPanelRule: true,
    overlayPosition: "center-left",
    fieldVisibility: defaultFieldVisibility(),
  };
  const parsed = readJson<Partial<StoredSettings>>(APP_SETTINGS_KEY);
  if (!parsed) {
    return fallback;
  }

  return {
    themeId: validThemeId(parsed.themeId) ? parsed.themeId : fallback.themeId,
    format: parsed.format === "jpg" || parsed.format === "png" ? parsed.format : fallback.format,
    blurRadius: clampBlurSetting(parsed.blurRadius),
    showPanelRule: typeof parsed.showPanelRule === "boolean" ? parsed.showPanelRule : fallback.showPanelRule,
    overlayPosition: validOverlayPosition(parsed.overlayPosition) ? parsed.overlayPosition : fallback.overlayPosition,
    fieldVisibility: normalizeFieldVisibility(parsed.fieldVisibility),
  };
}

function saveStoredSettings(settings: StoredSettings): void {
  writeJson(APP_SETTINGS_KEY, settings);
}

function loadStoredPresets(): UserPreset[] {
  const parsed = readJson<unknown>(PRESETS_KEY);
  if (!Array.isArray(parsed)) {
    return [];
  }

  return parsed
    .map(normalizePreset)
    .filter((preset): preset is UserPreset => Boolean(preset))
    .sort(comparePresetName);
}

function saveStoredPresets(presets: UserPreset[]): void {
  writeJson(PRESETS_KEY, presets);
}

function normalizePreset(value: unknown): UserPreset | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = value as Partial<UserPreset>;
  if (typeof candidate.id !== "string" || typeof candidate.name !== "string") {
    return null;
  }

  const productionFields = candidate.productionFields;
  if (!productionFields || typeof productionFields !== "object") {
    return null;
  }

  return {
    id: candidate.id,
    name: candidate.name,
    productionFields: {
      lightingModifier: stringValue(productionFields.lightingModifier),
      lightSource: stringValue(productionFields.lightSource),
      photographer: stringValue(productionFields.photographer),
      notes: stringValue(productionFields.notes),
    },
    themeId: validThemeId(candidate.themeId) ? candidate.themeId : DEFAULT_THEME.id,
    format: candidate.format === "jpg" || candidate.format === "png" ? candidate.format : "png",
    blurRadius: clampBlurSetting(candidate.blurRadius),
    showPanelRule: typeof candidate.showPanelRule === "boolean" ? candidate.showPanelRule : true,
    overlayPosition: validOverlayPosition(candidate.overlayPosition) ? candidate.overlayPosition : "center-left",
    fieldVisibility: normalizeFieldVisibility(candidate.fieldVisibility),
  };
}

function readJson<T>(key: string): T | null {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage can be unavailable in restricted webviews; presets are optional.
  }
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function validThemeId(value: unknown): value is string {
  return typeof value === "string" && THEMES.some((theme) => theme.id === value);
}

function validOverlayPosition(value: unknown): value is OverlayPosition {
  return typeof value === "string" && OVERLAY_POSITIONS.some((position) => position.value === value);
}

function defaultFieldVisibility(): FieldVisibility {
  return USER_FIELD_KEYS.reduce((visibility, key) => {
    visibility[key] = true;
    return visibility;
  }, {} as FieldVisibility);
}

function normalizeFieldVisibility(value: unknown): FieldVisibility {
  const fallback = defaultFieldVisibility();
  if (!value || typeof value !== "object") {
    return fallback;
  }

  const candidate = value as Partial<Record<UserFieldKey, unknown>>;
  return USER_FIELD_KEYS.reduce((visibility, key) => {
    visibility[key] = typeof candidate[key] === "boolean" ? candidate[key] : true;
    return visibility;
  }, {} as FieldVisibility);
}

function clampBlurSetting(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(28, Math.max(0, Math.round(value))) : DEFAULT_BLUR_RADIUS;
}

function createPresetId(): string {
  return window.crypto?.randomUUID?.() ?? `preset-${Date.now()}`;
}

function comparePresetName(a: UserPreset, b: UserPreset): number {
  return a.name.localeCompare(b.name);
}

function placeholderFor(key: UserFieldKey, exif?: NormalizedExif): string {
  if (exif && key in exif) {
    return exif[key as keyof NormalizedExif] ?? "";
  }

  const placeholders: Partial<Record<UserFieldKey, string>> = {
    aperture: "f 1.4",
    shutterSpeed: "1/2000s",
    iso: "ISO 100",
    focalLength: "35mm",
    bitDepth: "16-bit",
  };

  return placeholders[key] ?? "";
}

function stripExtension(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, "");
}

function fileNameFromPath(path: string): string {
  return path.split(/[\\/]/).pop() ?? "photo";
}

function isSupportedImageFile(file: File): boolean {
  return isSupportedImagePath(file.name) || SUPPORTED_IMAGE_MIME_TYPES.has(file.type.toLowerCase());
}

function isSupportedImagePath(path: string): boolean {
  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  return SUPPORTED_IMAGE_EXTENSIONS.has(extension);
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  return fallback;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => reject(new Error(message)), timeoutMs);
    promise
      .then((value) => {
        window.clearTimeout(timeout);
        resolve(value);
      })
      .catch((error) => {
        window.clearTimeout(timeout);
        reject(error);
      });
  });
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Could not read file"));
    reader.readAsDataURL(file);
  });
}

async function readImageDimensions(src: string): Promise<{ width: number; height: number }> {
  const image = await loadImage(src);
  return { width: image.naturalWidth, height: image.naturalHeight };
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => window.requestAnimationFrame(() => resolve()));
}

function downloadDataUrl(dataUrl: string, fileName: string): void {
  const link = document.createElement("a");
  link.href = dataUrl;
  link.download = fileName;
  link.style.display = "none";
  document.body.append(link);
  link.click();
  link.remove();
}
