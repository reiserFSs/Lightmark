import type { NormalizedExif, RenderRow, UserPhotoFields } from "./types";

export const EMPTY_FIELDS: UserPhotoFields = {
  aperture: "",
  shutterSpeed: "",
  iso: "",
  focalLength: "",
  cameraBody: "",
  lens: "",
  captureTime: "",
  bitDepth: "",
  lightingModifier: "",
  lightSource: "",
  photographer: "",
  notes: "",
};

export function fieldsFromExif(exif: NormalizedExif): UserPhotoFields {
  return {
    ...EMPTY_FIELDS,
    aperture: exif.aperture ?? "",
    shutterSpeed: exif.shutterSpeed ?? "",
    iso: exif.iso ?? "",
    focalLength: exif.focalLength ?? "",
    cameraBody: exif.cameraBody ?? "",
    lens: exif.lens ?? "",
    captureTime: exif.captureTime ?? "",
    bitDepth: exif.bitDepth ?? "",
    photographer: exif.photographer ?? "",
  };
}

export function buildRenderMetadata(fields: UserPhotoFields): RenderRow[] {
  const rows: RenderRow[] = [
    { key: "aperture", label: "Aperture", value: fields.aperture, group: "technical" },
    { key: "shutterSpeed", label: "Shutter", value: fields.shutterSpeed, group: "technical" },
    { key: "iso", label: "ISO", value: fields.iso, group: "technical" },
    { key: "focalLength", label: "Focal length", value: fields.focalLength, group: "technical" },
    { key: "bitDepth", label: "Bit depth", value: fields.bitDepth, group: "technical" },
    { key: "captureTime", label: "Time", value: fields.captureTime, group: "production" },
    { key: "lightingModifier", label: "Modifier", value: fields.lightingModifier, group: "production" },
    { key: "lightSource", label: "Light", value: fields.lightSource, group: "production" },
    { key: "cameraBody", label: "Camera", value: fields.cameraBody, group: "production" },
    { key: "lens", label: "Lens", value: fields.lens, group: "production" },
    { key: "photographer", label: "Author", value: fields.photographer, group: "production" },
    { key: "notes", label: "Notes", value: fields.notes, group: "production" },
  ];

  return rows.filter((row) => row.value.trim().length > 0);
}
