export type OutputFormat = "png" | "jpg";

export type ExifFieldKey =
  | "aperture"
  | "shutterSpeed"
  | "iso"
  | "focalLength"
  | "cameraBody"
  | "lens"
  | "captureTime"
  | "bitDepth";

export type UserFieldKey =
  | ExifFieldKey
  | "lightingModifier"
  | "lightSource"
  | "photographer"
  | "notes";

export interface NormalizedExif {
  aperture?: string;
  shutterSpeed?: string;
  iso?: string;
  focalLength?: string;
  cameraBody?: string;
  lens?: string;
  captureTime?: string;
  bitDepth?: string;
  photographer?: string;
}

export interface UserPhotoFields {
  aperture: string;
  shutterSpeed: string;
  iso: string;
  focalLength: string;
  cameraBody: string;
  lens: string;
  captureTime: string;
  bitDepth: string;
  lightingModifier: string;
  lightSource: string;
  photographer: string;
  notes: string;
}

export interface PhotoAsset {
  path: string;
  fileName: string;
  mimeType: string;
  width: number;
  height: number;
  previewDataUrl: string;
  exif: NormalizedExif;
}

export interface RenderRow {
  key: UserFieldKey;
  label: string;
  value: string;
  group: "technical" | "production";
}

export interface ThemePreset {
  id: string;
  name: string;
  backgroundOverlay: string;
  panelRule: string;
  text: string;
  mutedText: string;
  accent: string;
  shadow: string;
  fontFamily: string;
}

export interface ExportSummaryRequest {
  fileName: string;
  dataUrl: string;
  outputPath?: string;
}

export interface ExportResult {
  outputPath: string;
}
