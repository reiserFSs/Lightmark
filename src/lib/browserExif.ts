import * as exifr from "exifr";
import type { NormalizedExif } from "./types";

type MetadataPayload = Record<string, unknown>;

export async function parseBrowserExif(file: File): Promise<NormalizedExif> {
  const bitDepth = await readImageBitDepth(file).catch(() => undefined);

  try {
    const payload = (await exifr.parse(file, {
      tiff: true,
      ifd0: {},
      exif: true,
      gps: false,
      interop: false,
      makerNote: false,
      xmp: {
        multiSegment: true,
      },
      icc: false,
      firstChunkSize: 256000,
      chunkSize: 256000,
      chunkLimit: 12,
    })) as MetadataPayload | undefined;

    if (!payload) {
      return {};
    }

    const flat = flattenMetadata(payload);
    const fNumber = firstNumber(flat, ["FNumber", "exif.FNumber", "CameraProfiles.FNumber"]);
    const apertureValue = firstNumber(flat, ["ApertureValue", "CameraProfiles.ApertureValue"]);
    const exposure = firstNumber(flat, ["ExposureTime", "exif.ExposureTime", "CameraProfiles.ExposureTime"]);
    const shutterSpeed = normalizeShutterSpeed(flat, exposure);
    const iso = firstNumber(flat, ["ISO", "ISOSpeedRatings", "PhotographicSensitivity", "CameraProfiles.ISO"]);
    const focalLength = firstNumber(flat, ["FocalLength", "exif.FocalLength", "CameraProfiles.FocalLength"]);
    const cameraBody = firstString(flat, ["CameraPrettyName", "CameraProfiles.CameraPrettyName", "Model", "CameraProfiles.Model"]);

    return {
      aperture: fNumber ? formatAperture(fNumber) : apertureValue ? formatAperture(apertureFromApex(apertureValue)) : undefined,
      shutterSpeed,
      iso: iso ? `ISO ${iso}` : undefined,
      focalLength: focalLength ? formatFocalLength(focalLength, cameraBody) : undefined,
      cameraBody,
      lens: firstString(flat, ["LensModel", "Lens", "LensPrettyName", "CameraProfiles.LensPrettyName", "CameraProfiles.Lens"]),
      photographer: firstString(flat, ["Artist", "creator", "Creator", "dc.creator", "rights", "Rights"]),
      bitDepth,
      captureTime: formatDate(
        firstValue(flat, ["DateTimeOriginal", "CreateDate", "ModifyDate", "DateCreated"]) as Date | string | undefined,
      ),
    };
  } catch {
    return { bitDepth };
  }
}

async function readImageBitDepth(file: File): Promise<string | undefined> {
  const header = new Uint8Array(await file.slice(0, 512).arrayBuffer());
  const png = readPngBitDepth(header);
  if (png) {
    return png;
  }

  const jpeg = readJpegBitDepth(header);
  if (jpeg) {
    return jpeg;
  }

  const tiff = await readTiffBitDepth(file);
  return tiff;
}

function readPngBitDepth(header: Uint8Array): string | undefined {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (header.length < 25 || !signature.every((byte, index) => header[index] === byte)) {
    return undefined;
  }

  return formatBitDepth(header[24]);
}

function readJpegBitDepth(header: Uint8Array): string | undefined {
  if (header.length < 4 || header[0] !== 0xff || header[1] !== 0xd8) {
    return undefined;
  }

  let offset = 2;
  while (offset + 9 < header.length) {
    while (header[offset] === 0xff) {
      offset += 1;
    }
    const marker = header[offset];
    offset += 1;

    if (marker === 0xd9 || marker === 0xda) {
      break;
    }

    if (offset + 2 > header.length) {
      break;
    }

    const length = (header[offset] << 8) | header[offset + 1];
    if (isStartOfFrameMarker(marker) && offset + 2 < header.length) {
      return formatBitDepth(header[offset + 2]);
    }

    offset += length;
  }

  return undefined;
}

async function readTiffBitDepth(file: File): Promise<string | undefined> {
  const data = new Uint8Array(await file.slice(0, 65536).arrayBuffer());
  if (data.length < 8) {
    return undefined;
  }

  const littleEndian = data[0] === 0x49 && data[1] === 0x49;
  const bigEndian = data[0] === 0x4d && data[1] === 0x4d;
  if (!littleEndian && !bigEndian) {
    return undefined;
  }

  const readU16 = (offset: number) => littleEndian ? data[offset] | (data[offset + 1] << 8) : (data[offset] << 8) | data[offset + 1];
  const readU32 = (offset: number) =>
    littleEndian
      ? data[offset] | (data[offset + 1] << 8) | (data[offset + 2] << 16) | (data[offset + 3] << 24)
      : (data[offset] << 24) | (data[offset + 1] << 16) | (data[offset + 2] << 8) | data[offset + 3];
  const ifdOffset = readU32(4);
  if (ifdOffset + 2 > data.length) {
    return undefined;
  }

  const entries = readU16(ifdOffset);
  for (let index = 0; index < entries; index += 1) {
    const entry = ifdOffset + 2 + index * 12;
    if (entry + 12 > data.length) {
      return undefined;
    }

    if (readU16(entry) !== 258) {
      continue;
    }

    const count = readU32(entry + 4);
    if (count === 1) {
      return formatBitDepth(readU16(entry + 8));
    }

    const valueOffset = readU32(entry + 8);
    if (valueOffset + 2 <= data.length) {
      return formatBitDepth(readU16(valueOffset));
    }
  }

  return undefined;
}

function isStartOfFrameMarker(marker: number): boolean {
  return (
    (marker >= 0xc0 && marker <= 0xc3) ||
    (marker >= 0xc5 && marker <= 0xc7) ||
    (marker >= 0xc9 && marker <= 0xcb) ||
    (marker >= 0xcd && marker <= 0xcf)
  );
}

function formatBitDepth(value: number): string | undefined {
  return value > 0 ? `${value}-bit` : undefined;
}

function flattenMetadata(payload: MetadataPayload): Map<string, unknown> {
  const flat = new Map<string, unknown>();

  function visit(value: unknown, path: string): void {
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, path ? `${path}.${index}` : String(index)));
      return;
    }

    if (value instanceof Date || value === null || typeof value !== "object") {
      if (path) {
        flat.set(path, value);
        flat.set(path.split(".").at(-1) ?? path, value);
      }
      return;
    }

    for (const [key, child] of Object.entries(value as MetadataPayload)) {
      visit(child, path ? `${path}.${key}` : key);
    }
  }

  visit(payload, "");
  return flat;
}

function firstValue(flat: Map<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (flat.has(key)) {
      return flat.get(key);
    }
  }

  return undefined;
}

function firstString(flat: Map<string, unknown>, keys: string[]): string | undefined {
  const value = firstValue(flat, keys);

  if (typeof value === "string") {
    return value.trim() || undefined;
  }

  if (typeof value === "number") {
    return String(value);
  }

  if (Array.isArray(value)) {
    const first = value.find((item) => typeof item === "string" && item.trim().length > 0);
    return typeof first === "string" ? first.trim() : undefined;
  }

  return undefined;
}

function firstNumber(flat: Map<string, unknown>, keys: string[]): number | undefined {
  const value = firstValue(flat, keys);

  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    return parseMetadataNumber(value);
  }

  if (Array.isArray(value) && value.length > 0) {
    const [first] = value;
    if (typeof first === "number" && Number.isFinite(first)) {
      return first;
    }

    if (typeof first === "string") {
      return parseMetadataNumber(first);
    }
  }

  return undefined;
}

function apertureFromApex(apertureValue: number): number {
  return Math.pow(2, apertureValue / 2);
}

function formatAperture(value: number): string {
  return `f ${value.toFixed(1)}`;
}

function formatFocalLength(value: number, cameraBody: string | undefined): string {
  const focalLength = `${formatDecimal(value)}mm`;

  if (!cameraBody || !/\bgfx\b/i.test(cameraBody)) {
    return focalLength;
  }

  return `${focalLength} (${Math.round(value * 0.79)}mm FF)`;
}

function normalizeShutterSpeed(flat: Map<string, unknown>, exposureSeconds: number | undefined): string | undefined {
  const exposure = exposureSeconds ? formatExposure(exposureSeconds) : undefined;
  if (exposure) {
    return exposure;
  }

  const shutterText = firstString(flat, ["ShutterSpeed", "CameraProfiles.ShutterSpeed"]);
  if (shutterText && isReasonableShutterText(shutterText)) {
    return shutterText;
  }

  const apex = firstNumber(flat, ["ShutterSpeedValue", "CameraProfiles.ShutterSpeedValue"]);
  if (apex !== undefined && apex > -16 && apex < 32) {
    return formatExposure(Math.pow(2, -apex));
  }

  return undefined;
}

function formatExposure(seconds: number): string | undefined {
  if (seconds <= 0 || seconds > 3600) {
    return undefined;
  }

  if (seconds < 1) {
    return `1/${Math.round(1 / seconds)}s`;
  }

  return `${formatDecimal(seconds)}s`;
}

function isReasonableShutterText(value: string): boolean {
  if (/^\d+\/\d+s?$/.test(value) || /^\d+(\.\d+)?s$/.test(value)) {
    return true;
  }

  const numeric = Number.parseFloat(value);
  return Number.isFinite(numeric) && numeric > 0 && numeric <= 3600;
}

function formatDecimal(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function parseMetadataNumber(value: string): number | undefined {
  const trimmed = value.trim();
  const rational = trimmed.match(/^(-?\d+(?:\.\d+)?)\/(-?\d+(?:\.\d+)?)$/);

  if (rational) {
    const numerator = Number.parseFloat(rational[1]);
    const denominator = Number.parseFloat(rational[2]);
    return denominator !== 0 ? numerator / denominator : undefined;
  }

  const number = Number.parseFloat(trimmed);
  return Number.isFinite(number) ? number : undefined;
}

function formatDate(value: Date | string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  if (value instanceof Date) {
    return formatDateParts(
      value.getFullYear(),
      value.getMonth() + 1,
      value.getDate(),
      value.getHours(),
      value.getMinutes(),
      value.getSeconds(),
    );
  }

  const trimmed = value.trim();
  const match = trimmed.match(/^(\d{4})[-:](\d{2})[-:](\d{2})[T\s](\d{2}):(\d{2}):(\d{2})/);

  if (!match) {
    return trimmed;
  }

  return formatDateParts(
    Number(match[1]),
    Number(match[2]),
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6]),
  );
}

function formatDateParts(year: number, month: number, day: number, hour: number, minute: number, second: number): string {
  const monthName = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ][month - 1];

  return `${day}${ordinalSuffix(day)} ${monthName} ${year} ${padTime(hour)}:${padTime(minute)}:${padTime(second)}`;
}

function ordinalSuffix(day: number): string {
  if (day >= 11 && day <= 13) {
    return "th";
  }

  switch (day % 10) {
    case 1:
      return "st";
    case 2:
      return "nd";
    case 3:
      return "rd";
    default:
      return "th";
  }
}

function padTime(value: number): string {
  return String(value).padStart(2, "0");
}
