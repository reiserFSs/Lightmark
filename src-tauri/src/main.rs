use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use exif::{In, Reader, Tag, Value};
use image::imageops::FilterType;
use image::{DynamicImage, ImageFormat, ImageReader, Limits};
use serde::{Deserialize, Serialize};
use std::fs;
use std::fs::File;
use std::io::{Cursor, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct NormalizedExif {
    aperture: Option<String>,
    shutter_speed: Option<String>,
    iso: Option<String>,
    focal_length: Option<String>,
    camera_body: Option<String>,
    lens: Option<String>,
    capture_time: Option<String>,
    bit_depth: Option<String>,
    photographer: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PhotoAsset {
    path: String,
    file_name: String,
    mime_type: String,
    width: u32,
    height: u32,
    preview_data_url: String,
    exif: NormalizedExif,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExportSummaryRequest {
    file_name: String,
    data_url: String,
    output_path: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExportResult {
    output_path: String,
}

struct PreviewImage {
    bytes: Vec<u8>,
    width: u32,
    height: u32,
}

const LARGE_NATIVE_PREVIEW_BYTES: u64 = 25 * 1024 * 1024;
const MAX_DECODE_DIMENSION: u32 = 32_000;
const MAX_DECODE_ALLOC_BYTES: u64 = 768 * 1024 * 1024;
const MAX_JPEG_METADATA_BYTES: usize = 4 * 1024 * 1024;
static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

#[tauri::command]
fn load_photo(path: String) -> Result<PhotoAsset, String> {
    let source_path = PathBuf::from(&path);
    let extension = extension_for(&source_path);
    let (width, height, preview_data_url, exif) = if can_use_native_preview(&extension) {
        let (width, height) = read_image_dimensions(&source_path)?;
        let mut exif = extract_exif_from_path(&source_path, &extension)?;
        exif.bit_depth = exif.bit_depth.or_else(|| {
            read_bit_depth_from_path(&source_path, &extension)
                .ok()
                .flatten()
        });
        let preview_data_url = if should_generate_platform_preview(&source_path, &extension) {
            match generate_platform_preview_png(&source_path, width, height) {
                Ok(preview) => format!("data:image/png;base64,{}", STANDARD.encode(preview.bytes)),
                Err(_) => String::new(),
            }
        } else {
            String::new()
        };
        (width, height, preview_data_url, exif)
    } else {
        let bytes =
            fs::read(&source_path).map_err(|error| format!("Could not read photo: {error}"))?;
        let preview = decode_to_preview_png(&source_path, &bytes)?;
        let mut exif = extract_exif(&bytes);
        exif.bit_depth = exif
            .bit_depth
            .or_else(|| bit_depth_from_bytes(&bytes, &extension));
        (
            preview.width,
            preview.height,
            format!("data:image/png;base64,{}", STANDARD.encode(preview.bytes)),
            exif,
        )
    };

    Ok(PhotoAsset {
        path,
        file_name: source_path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("photo")
            .to_string(),
        mime_type: mime_type_for(&source_path).to_string(),
        width,
        height,
        preview_data_url,
        exif,
    })
}

#[tauri::command]
fn export_summary(request: ExportSummaryRequest) -> Result<ExportResult, String> {
    let output_path = request
        .output_path
        .ok_or_else(|| "Missing export path".to_string())?;
    let (_, payload) = request
        .data_url
        .split_once(',')
        .ok_or_else(|| "Export data was not a data URL".to_string())?;
    let bytes = STANDARD
        .decode(payload)
        .map_err(|error| format!("Could not decode export image: {error}"))?;

    fs::write(&output_path, bytes)
        .map_err(|error| format!("Could not write {}: {error}", request.file_name))?;

    Ok(ExportResult { output_path })
}

fn decode_to_preview_png(path: &Path, bytes: &[u8]) -> Result<PreviewImage, String> {
    let extension = extension_for(path);

    if extension == "heic" || extension == "heif" {
        return decode_heic_to_preview_png(path);
    }

    let image = decode_image_bytes(bytes, None)
        .map_err(|error| format!("Could not decode image. Supported formats are JPEG, PNG, TIFF, and HEIC on macOS: {error}"))?;
    encode_preview_image(image)
}

fn encode_preview_image(image: DynamicImage) -> Result<PreviewImage, String> {
    let width = image.width();
    let height = image.height();
    let preview = image.resize(2400, 2400, FilterType::Triangle).to_rgba8();
    let preview_image = DynamicImage::ImageRgba8(preview);
    let mut png_bytes = Vec::new();
    preview_image
        .write_to(&mut Cursor::new(&mut png_bytes), ImageFormat::Png)
        .map_err(|error| format!("Could not encode preview image: {error}"))?;

    Ok(PreviewImage {
        bytes: png_bytes,
        width,
        height,
    })
}

#[cfg(target_os = "macos")]
fn decode_heic_to_preview_png(path: &Path) -> Result<PreviewImage, String> {
    use std::process::Command;

    let output_path = unique_temp_png("lightmark-heic")?;
    let status = Command::new("sips")
        .arg("-s")
        .arg("format")
        .arg("png")
        .arg("-Z")
        .arg("2400")
        .arg(path)
        .arg("--out")
        .arg(&output_path)
        .status()
        .map_err(|error| format!("Could not invoke macOS HEIC decoder: {error}"))?;

    if !status.success() {
        let _ = fs::remove_file(&output_path);
        return Err("macOS could not decode this HEIC/HEIF file.".to_string());
    }

    let bytes = read_and_remove_temp_file(&output_path, "converted HEIC preview")?;
    let image = decode_image_bytes(&bytes, Some(ImageFormat::Png))
        .map_err(|error| format!("Could not decode converted HEIC preview: {error}"))?;
    encode_preview_image(image)
}

#[cfg(not(target_os = "macos"))]
fn decode_heic_to_preview_png(_path: &Path) -> Result<PreviewImage, String> {
    Err("HEIC/HEIF decoding requires the platform image codec. Use JPEG, PNG, or TIFF on this build.".to_string())
}

fn decode_image_bytes(bytes: &[u8], format: Option<ImageFormat>) -> Result<DynamicImage, String> {
    let mut reader = ImageReader::new(Cursor::new(bytes));
    if let Some(format) = format {
        reader.set_format(format);
    } else {
        reader = reader
            .with_guessed_format()
            .map_err(|error| format!("Could not detect image format: {error}"))?;
    }
    reader.limits(image_decode_limits());
    reader.decode().map_err(|error| error.to_string())
}

fn image_decode_limits() -> Limits {
    let mut limits = Limits::default();
    limits.max_image_width = Some(MAX_DECODE_DIMENSION);
    limits.max_image_height = Some(MAX_DECODE_DIMENSION);
    limits.max_alloc = Some(MAX_DECODE_ALLOC_BYTES);
    limits
}

fn read_image_dimensions(path: &Path) -> Result<(u32, u32), String> {
    image::image_dimensions(path)
        .map_err(|error| format!("Could not read image dimensions: {error}"))
}

fn can_use_native_preview(extension: &str) -> bool {
    matches!(extension, "jpg" | "jpeg" | "png")
}

fn should_generate_platform_preview(path: &Path, extension: &str) -> bool {
    if !cfg!(target_os = "macos") {
        return false;
    }

    if matches!(extension, "jpg" | "jpeg") {
        return true;
    }

    matches!(extension, "png")
        && fs::metadata(path)
            .map(|metadata| metadata.len() >= LARGE_NATIVE_PREVIEW_BYTES)
            .unwrap_or(false)
}

#[cfg(target_os = "macos")]
fn generate_platform_preview_png(
    path: &Path,
    width: u32,
    height: u32,
) -> Result<PreviewImage, String> {
    use std::process::{Command, Stdio};

    let output_path = unique_temp_png("lightmark-preview")?;
    let status = Command::new("sips")
        .arg("-Z")
        .arg("2400")
        .arg(path)
        .arg("--out")
        .arg(&output_path)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|error| format!("Could not invoke macOS preview generator: {error}"))?;

    if !status.success() {
        let _ = fs::remove_file(&output_path);
        return Err("macOS could not generate a preview for this image.".to_string());
    }

    let bytes = read_and_remove_temp_file(&output_path, "generated preview")?;

    Ok(PreviewImage {
        bytes,
        width,
        height,
    })
}

#[cfg(not(target_os = "macos"))]
fn generate_platform_preview_png(
    _path: &Path,
    _width: u32,
    _height: u32,
) -> Result<PreviewImage, String> {
    Err("Platform preview generation is not available on this build.".to_string())
}

fn unique_temp_png(prefix: &str) -> Result<PathBuf, String> {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|error| format!("Could not create temporary preview path: {error}"))?
        .as_nanos();
    let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);

    Ok(std::env::temp_dir().join(format!(
        "{prefix}-{}-{stamp}-{counter}.png",
        std::process::id()
    )))
}

fn read_and_remove_temp_file(path: &Path, label: &str) -> Result<Vec<u8>, String> {
    let result = fs::read(path).map_err(|error| format!("Could not read {label}: {error}"));
    let _ = fs::remove_file(path);
    result
}

fn extract_exif_from_path(path: &Path, extension: &str) -> Result<NormalizedExif, String> {
    if extension == "png" {
        return extract_png_metadata(path);
    }

    if matches!(extension, "jpg" | "jpeg") {
        return extract_jpeg_metadata(path);
    }

    let bytes = fs::read(path).map_err(|error| format!("Could not read metadata: {error}"))?;
    Ok(extract_exif(&bytes))
}

fn extract_jpeg_metadata(path: &Path) -> Result<NormalizedExif, String> {
    let mut file =
        File::open(path).map_err(|error| format!("Could not read JPEG metadata: {error}"))?;
    let mut soi = [0; 2];
    file.read_exact(&mut soi)
        .map_err(|error| format!("Could not read JPEG signature: {error}"))?;
    if soi != [0xff, 0xd8] {
        return Err("Invalid JPEG signature".to_string());
    }

    let mut classic_exif = NormalizedExif::default();
    let mut xmp_metadata = Vec::new();

    while let Some(marker) = read_jpeg_marker(&mut file)? {
        if marker == 0xda || marker == 0xd9 {
            break;
        }

        if is_standalone_jpeg_marker(marker) {
            continue;
        }

        let mut length_bytes = [0; 2];
        file.read_exact(&mut length_bytes)
            .map_err(|error| format!("Could not read JPEG segment length: {error}"))?;
        let segment_length = u16::from_be_bytes(length_bytes) as usize;
        if segment_length < 2 {
            break;
        }

        let payload_length = segment_length - 2;
        if marker != 0xe1 {
            file.seek(SeekFrom::Current(payload_length as i64))
                .map_err(|error| format!("Could not skip JPEG segment: {error}"))?;
            continue;
        }

        let mut payload = vec![0; payload_length];
        file.read_exact(&mut payload)
            .map_err(|error| format!("Could not read JPEG metadata segment: {error}"))?;

        if payload.starts_with(b"Exif\0\0") {
            if let Ok(reader) = Reader::new().read_raw(payload[6..].to_vec()) {
                classic_exif = normalize_classic_exif(&reader);
            }
            continue;
        }

        if xmp_metadata.len() + payload.len() <= MAX_JPEG_METADATA_BYTES {
            xmp_metadata.extend_from_slice(&payload);
        }
    }

    Ok(merge_missing_metadata(
        classic_exif,
        extract_xmp_metadata(&xmp_metadata),
    ))
}

fn read_jpeg_marker(file: &mut File) -> Result<Option<u8>, String> {
    let mut byte = [0; 1];
    loop {
        match file.read_exact(&mut byte) {
            Ok(()) if byte[0] == 0xff => break,
            Ok(()) => continue,
            Err(error) if error.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
            Err(error) => return Err(format!("Could not read JPEG marker: {error}")),
        }
    }

    loop {
        match file.read_exact(&mut byte) {
            Ok(()) if byte[0] == 0xff => continue,
            Ok(()) => return Ok(Some(byte[0])),
            Err(error) if error.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
            Err(error) => return Err(format!("Could not read JPEG marker: {error}")),
        }
    }
}

fn is_standalone_jpeg_marker(marker: u8) -> bool {
    marker == 0x01 || (0xd0..=0xd8).contains(&marker)
}

fn read_bit_depth_from_path(path: &Path, extension: &str) -> Result<Option<String>, String> {
    let mut file =
        File::open(path).map_err(|error| format!("Could not read bit depth: {error}"))?;
    let read_limit = if extension == "png" { 32 } else { 65_536 };
    let mut bytes = vec![0; read_limit];
    let read = file
        .read(&mut bytes)
        .map_err(|error| format!("Could not read bit depth: {error}"))?;
    bytes.truncate(read);
    Ok(bit_depth_from_bytes(&bytes, extension))
}

fn bit_depth_from_bytes(bytes: &[u8], extension: &str) -> Option<String> {
    match extension {
        "png" => png_bit_depth(bytes),
        "jpg" | "jpeg" => jpeg_bit_depth(bytes),
        "tif" | "tiff" => tiff_bit_depth(bytes),
        _ => None,
    }
}

fn png_bit_depth(bytes: &[u8]) -> Option<String> {
    if bytes.len() >= 25 && bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return format_bit_depth(bytes[24] as u32);
    }

    None
}

fn jpeg_bit_depth(bytes: &[u8]) -> Option<String> {
    if bytes.len() < 4 || !bytes.starts_with(&[0xff, 0xd8]) {
        return None;
    }

    let mut offset = 2;
    while offset + 9 < bytes.len() {
        while offset < bytes.len() && bytes[offset] == 0xff {
            offset += 1;
        }
        if offset >= bytes.len() {
            break;
        }

        let marker = bytes[offset];
        offset += 1;
        if marker == 0xd9 || marker == 0xda {
            break;
        }
        if offset + 2 > bytes.len() {
            break;
        }

        let length = u16::from_be_bytes([bytes[offset], bytes[offset + 1]]) as usize;
        if is_jpeg_start_of_frame(marker) && offset + 2 < bytes.len() {
            return format_bit_depth(bytes[offset + 2] as u32);
        }

        if length < 2 {
            break;
        }
        offset += length;
    }

    None
}

fn tiff_bit_depth(bytes: &[u8]) -> Option<String> {
    if bytes.len() < 8 {
        return None;
    }

    let little_endian = &bytes[0..2] == b"II";
    let big_endian = &bytes[0..2] == b"MM";
    if !little_endian && !big_endian {
        return None;
    }

    let read_u16 = |offset: usize| -> Option<u16> {
        let bytes = [*bytes.get(offset)?, *bytes.get(offset + 1)?];
        Some(if little_endian {
            u16::from_le_bytes(bytes)
        } else {
            u16::from_be_bytes(bytes)
        })
    };
    let read_u32 = |offset: usize| -> Option<u32> {
        let bytes = [
            *bytes.get(offset)?,
            *bytes.get(offset + 1)?,
            *bytes.get(offset + 2)?,
            *bytes.get(offset + 3)?,
        ];
        Some(if little_endian {
            u32::from_le_bytes(bytes)
        } else {
            u32::from_be_bytes(bytes)
        })
    };

    let ifd_offset = read_u32(4)? as usize;
    let entries = read_u16(ifd_offset)? as usize;
    for index in 0..entries {
        let entry = ifd_offset + 2 + index * 12;
        let tag = read_u16(entry)?;
        if tag != 258 {
            continue;
        }

        let count = read_u32(entry + 4)?;
        if count == 1 {
            return format_bit_depth(read_u16(entry + 8)? as u32);
        }

        let value_offset = read_u32(entry + 8)? as usize;
        return format_bit_depth(read_u16(value_offset)? as u32);
    }

    None
}

fn is_jpeg_start_of_frame(marker: u8) -> bool {
    matches!(
        marker,
        0xc0..=0xc3 | 0xc5..=0xc7 | 0xc9..=0xcb | 0xcd..=0xcf
    )
}

fn extract_png_metadata(path: &Path) -> Result<NormalizedExif, String> {
    let mut file =
        File::open(path).map_err(|error| format!("Could not read PNG metadata: {error}"))?;
    let mut signature = [0; 8];
    file.read_exact(&mut signature)
        .map_err(|error| format!("Could not read PNG signature: {error}"))?;
    if signature != *b"\x89PNG\r\n\x1a\n" {
        return Err("Invalid PNG signature".to_string());
    }

    let mut text_metadata = Vec::new();
    let mut raw_exif = None;
    loop {
        let mut length_bytes = [0; 4];
        if file.read_exact(&mut length_bytes).is_err() {
            break;
        }
        let length = u32::from_be_bytes(length_bytes) as usize;
        let mut chunk_type = [0; 4];
        file.read_exact(&mut chunk_type)
            .map_err(|error| format!("Could not read PNG chunk: {error}"))?;

        if is_png_metadata_chunk(&chunk_type) {
            let mut chunk = vec![0; length];
            file.read_exact(&mut chunk)
                .map_err(|error| format!("Could not read PNG metadata chunk: {error}"))?;
            if chunk_type == *b"eXIf" {
                raw_exif = Some(chunk);
            } else {
                text_metadata.extend_from_slice(&chunk);
            }
            file.seek(SeekFrom::Current(4))
                .map_err(|error| format!("Could not skip PNG chunk checksum: {error}"))?;
        } else {
            file.seek(SeekFrom::Current(length as i64 + 4))
                .map_err(|error| format!("Could not skip PNG chunk: {error}"))?;
        }

        if chunk_type == *b"IEND" {
            break;
        }
    }

    let classic_exif = raw_exif
        .and_then(|data| Reader::new().read_raw(data).ok())
        .map(|reader| normalize_classic_exif(&reader))
        .unwrap_or_default();

    Ok(merge_missing_metadata(
        classic_exif,
        extract_xmp_metadata(&text_metadata),
    ))
}

fn is_png_metadata_chunk(chunk_type: &[u8; 4]) -> bool {
    matches!(chunk_type, b"iTXt" | b"tEXt" | b"zTXt" | b"eXIf")
}

fn extract_exif(bytes: &[u8]) -> NormalizedExif {
    let mut cursor = Cursor::new(bytes);
    let classic_exif = if let Ok(reader) = Reader::new().read_from_container(&mut cursor) {
        normalize_classic_exif(&reader)
    } else {
        NormalizedExif::default()
    };

    merge_missing_metadata(classic_exif, extract_xmp_metadata(bytes))
}

fn normalize_classic_exif(reader: &exif::Exif) -> NormalizedExif {
    let camera_body = reader.get_field(Tag::Model, In::PRIMARY).map(|field| {
        field
            .display_value()
            .with_unit(reader)
            .to_string()
            .trim_matches('"')
            .to_string()
    });

    NormalizedExif {
        aperture: reader
            .get_field(Tag::FNumber, In::PRIMARY)
            .and_then(|field| first_rational(&field.value))
            .map(format_aperture),
        shutter_speed: reader
            .get_field(Tag::ExposureTime, In::PRIMARY)
            .and_then(|field| first_rational(&field.value))
            .and_then(format_exposure),
        iso: reader
            .get_field(Tag::PhotographicSensitivity, In::PRIMARY)
            .or_else(|| reader.get_field(Tag::ISOSpeed, In::PRIMARY))
            .map(|field| format!("ISO {}", field.display_value().with_unit(reader))),
        focal_length: reader
            .get_field(Tag::FocalLength, In::PRIMARY)
            .and_then(|field| first_rational(&field.value))
            .map(|value| format_focal_length(value, camera_body.as_deref())),
        camera_body,
        lens: reader
            .get_field(Tag::LensModel, In::PRIMARY)
            .or_else(|| reader.get_field(Tag::LensSpecification, In::PRIMARY))
            .map(|field| {
                field
                    .display_value()
                    .with_unit(reader)
                    .to_string()
                    .trim_matches('"')
                    .to_string()
            }),
        capture_time: reader
            .get_field(Tag::DateTimeOriginal, In::PRIMARY)
            .or_else(|| reader.get_field(Tag::DateTime, In::PRIMARY))
            .map(|field| {
                normalize_capture_time(
                    field
                        .display_value()
                        .with_unit(reader)
                        .to_string()
                        .trim_matches('"'),
                )
            }),
        bit_depth: reader
            .get_field(Tag::BitsPerSample, In::PRIMARY)
            .and_then(|field| first_unsigned_short(&field.value))
            .and_then(|value| format_bit_depth(value as u32)),
        photographer: reader.get_field(Tag::Artist, In::PRIMARY).map(|field| {
            field
                .display_value()
                .with_unit(reader)
                .to_string()
                .trim_matches('"')
                .to_string()
        }),
    }
}

fn extract_xmp_metadata(bytes: &[u8]) -> NormalizedExif {
    let text = String::from_utf8_lossy(bytes);
    let f_number = xmp_number(&text, "exif:FNumber");
    let aperture_value = xmp_number(&text, "CameraProfiles:ApertureValue")
        .or_else(|| xmp_number(&text, "stCamera:ApertureValue"))
        .or_else(|| xmp_number(&text, "crs:ApertureValue"))
        .or_else(|| xmp_number(&text, "exif:ApertureValue"));
    let camera_body = xmp_value(&text, "CameraProfiles:CameraPrettyName")
        .or_else(|| xmp_value(&text, "stCamera:CameraPrettyName"))
        .or_else(|| xmp_value(&text, "CameraProfiles:Model"))
        .or_else(|| xmp_value(&text, "stCamera:Model"))
        .or_else(|| xmp_value(&text, "tiff:Model"));

    NormalizedExif {
        aperture: f_number
            .map(format_aperture)
            .or_else(|| aperture_value.map(|value| format_aperture(2_f64.powf(value / 2.0)))),
        shutter_speed: xmp_shutter_speed(&text),
        iso: xmp_value(&text, "CameraProfiles:ISO")
            .or_else(|| xmp_value(&text, "exif:ISO"))
            .or_else(|| xmp_bag_first(&text, "exif:ISOSpeedRatings"))
            .map(|value| format!("ISO {value}")),
        focal_length: xmp_number(&text, "CameraProfiles:FocalLength")
            .or_else(|| xmp_number(&text, "stCamera:FocalLength"))
            .or_else(|| xmp_number(&text, "crs:FocalLength"))
            .or_else(|| xmp_number(&text, "exif:FocalLength"))
            .map(|value| format_focal_length(value, camera_body.as_deref())),
        camera_body,
        lens: xmp_value(&text, "CameraProfiles:LensPrettyName")
            .or_else(|| xmp_value(&text, "stCamera:LensPrettyName"))
            .or_else(|| xmp_value(&text, "CameraProfiles:Lens"))
            .or_else(|| xmp_value(&text, "stCamera:Lens"))
            .or_else(|| xmp_value(&text, "exifEX:LensModel"))
            .or_else(|| xmp_value(&text, "aux:Lens")),
        capture_time: xmp_value(&text, "exif:DateTimeOriginal")
            .or_else(|| xmp_value(&text, "xmp:CreateDate"))
            .or_else(|| xmp_value(&text, "xmp:ModifyDate"))
            .map(|value| normalize_capture_time(&value)),
        bit_depth: xmp_number(&text, "tiff:BitsPerSample")
            .or_else(|| xmp_number(&text, "exif:BitsPerSample"))
            .and_then(|value| format_bit_depth(value.round() as u32)),
        photographer: xmp_value(&text, "tiff:Artist")
            .or_else(|| xmp_value(&text, "photoshop:AuthorsPosition"))
            .or_else(|| xmp_bag_first(&text, "dc:creator")),
    }
}

fn merge_missing_metadata(mut primary: NormalizedExif, fallback: NormalizedExif) -> NormalizedExif {
    primary.aperture = primary.aperture.or(fallback.aperture);
    primary.shutter_speed = primary.shutter_speed.or(fallback.shutter_speed);
    primary.iso = primary.iso.or(fallback.iso);
    primary.focal_length = primary.focal_length.or(fallback.focal_length);
    primary.camera_body = primary.camera_body.or(fallback.camera_body);
    primary.lens = primary.lens.or(fallback.lens);
    primary.capture_time = primary.capture_time.or(fallback.capture_time);
    primary.bit_depth = primary.bit_depth.or(fallback.bit_depth);
    primary.photographer = primary.photographer.or(fallback.photographer);
    primary
}

fn xmp_number(text: &str, tag: &str) -> Option<f64> {
    xmp_value(text, tag).and_then(|value| parse_metadata_number(&value))
}

fn parse_metadata_number(value: &str) -> Option<f64> {
    let trimmed = value.trim();

    if let Some((numerator, denominator)) = trimmed.split_once('/') {
        let numerator = numerator.trim().parse::<f64>().ok()?;
        let denominator = denominator.trim().parse::<f64>().ok()?;
        if denominator == 0.0 {
            return None;
        }

        return Some(numerator / denominator);
    }

    trimmed.parse::<f64>().ok()
}

fn xmp_shutter_speed(text: &str) -> Option<String> {
    let text_value = xmp_value(text, "CameraProfiles:ShutterSpeed")
        .or_else(|| xmp_value(text, "crs:ShutterSpeed"));
    if let Some(value) = text_value {
        if is_reasonable_shutter_text(&value) {
            return Some(value);
        }
    }

    let apex = xmp_number(text, "CameraProfiles:ShutterSpeedValue")
        .or_else(|| xmp_number(text, "exif:ShutterSpeedValue"));
    if let Some(value) = apex {
        if value > -16.0 && value < 32.0 {
            return format_exposure(2_f64.powf(-value));
        }
    }

    None
}

fn format_exposure(seconds: f64) -> Option<String> {
    if seconds <= 0.0 || seconds > 3600.0 {
        return None;
    }

    if seconds < 1.0 {
        return Some(format!("1/{}s", (1.0 / seconds).round() as i64));
    }

    Some(format!("{}s", trim_float(seconds)))
}

fn is_reasonable_shutter_text(value: &str) -> bool {
    let trimmed = value.trim();
    if trimmed.contains('/') {
        return true;
    }

    let numeric = trimmed.trim_end_matches('s').parse::<f64>();
    matches!(numeric, Ok(value) if value > 0.0 && value <= 3600.0)
}

fn xmp_value(text: &str, tag: &str) -> Option<String> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    if let Some(start) = text.find(&open) {
        let value_start = start + open.len();
        if let Some(end) = text[value_start..].find(&close) {
            return clean_xmp_value(&text[value_start..value_start + end]);
        }
    }

    let attr = format!("{tag}=\"");
    if let Some(start) = text.find(&attr) {
        let value_start = start + attr.len();
        if let Some(end) = text[value_start..].find('"') {
            return clean_xmp_value(&text[value_start..value_start + end]);
        }
    }

    None
}

fn xmp_bag_first(text: &str, tag: &str) -> Option<String> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let start = text.find(&open)? + open.len();
    let end = text[start..].find(&close)?;
    let body = &text[start..start + end];
    let li_open = "<rdf:li";
    let li_start = body.find(li_open)?;
    let value_start = body[li_start..].find('>')? + li_start + 1;
    let value_end = body[value_start..].find("</rdf:li>")?;
    clean_xmp_value(&body[value_start..value_start + value_end])
}

fn clean_xmp_value(value: &str) -> Option<String> {
    let cleaned = value
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .trim()
        .to_string();

    if cleaned.is_empty() {
        None
    } else {
        Some(cleaned)
    }
}

fn first_rational(value: &Value) -> Option<f64> {
    match value {
        Value::Rational(values) => values
            .first()
            .map(|value| value.num as f64 / value.denom as f64),
        Value::SRational(values) => values
            .first()
            .map(|value| value.num as f64 / value.denom as f64),
        _ => None,
    }
}

fn first_unsigned_short(value: &Value) -> Option<u16> {
    match value {
        Value::Short(values) => values.first().copied(),
        _ => None,
    }
}

fn trim_float(value: f64) -> String {
    if (value - value.round()).abs() < 0.05 {
        format!("{}", value.round() as i64)
    } else {
        format!("{value:.1}")
    }
}

fn format_aperture(value: f64) -> String {
    format!("f {value:.1}")
}

fn format_bit_depth(value: u32) -> Option<String> {
    if value > 0 {
        Some(format!("{value}-bit"))
    } else {
        None
    }
}

fn format_focal_length(value: f64, camera_body: Option<&str>) -> String {
    let focal_length = format!("{}mm", trim_float(value));

    if !camera_body
        .map(|body| body.to_lowercase().contains("gfx"))
        .unwrap_or(false)
    {
        return focal_length;
    }

    format!("{focal_length} ({}mm FF)", (value * 0.79).round() as i64)
}

fn normalize_capture_time(value: &str) -> String {
    let trimmed = value.trim().trim_matches('"');
    let Some(year) = trimmed.get(0..4) else {
        return trimmed.to_string();
    };
    let Some(month) = trimmed.get(5..7) else {
        return trimmed.to_string();
    };
    let Some(day) = trimmed.get(8..10) else {
        return trimmed.to_string();
    };
    let Some(hour) = trimmed.get(11..13) else {
        return trimmed.to_string();
    };
    let Some(minute) = trimmed.get(14..16) else {
        return trimmed.to_string();
    };
    let Some(second) = trimmed.get(17..19) else {
        return trimmed.to_string();
    };

    let Ok(day_number) = day.parse::<u32>() else {
        return trimmed.to_string();
    };
    let Ok(month_number) = month.parse::<usize>() else {
        return trimmed.to_string();
    };
    let Some(month_name) = month_name(month_number) else {
        return trimmed.to_string();
    };

    format!(
        "{}{} {} {} {}:{}:{}",
        day_number,
        ordinal_suffix(day_number),
        month_name,
        year,
        hour,
        minute,
        second
    )
}

fn month_name(month: usize) -> Option<&'static str> {
    [
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
    ]
    .get(month.checked_sub(1)?)
    .copied()
}

fn ordinal_suffix(day: u32) -> &'static str {
    if (11..=13).contains(&day) {
        return "th";
    }

    match day % 10 {
        1 => "st",
        2 => "nd",
        3 => "rd",
        _ => "th",
    }
}

fn extension_for(path: &Path) -> String {
    path.extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or_default()
        .to_lowercase()
}

fn mime_type_for(path: &Path) -> &'static str {
    match extension_for(path).as_str() {
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "tif" | "tiff" => "image/tiff",
        "heic" => "image/heic",
        "heif" => "image/heif",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_capture_time() {
        assert_eq!(
            normalize_capture_time("2024:05:02 09:08:07"),
            "2nd May 2024 09:08:07"
        );
    }

    #[test]
    fn leaves_malformed_capture_time_unchanged() {
        assert_eq!(normalize_capture_time("not a timestamp"), "not a timestamp");
        assert_eq!(
            normalize_capture_time("2024:05:é2 09:08:07"),
            "2024:05:é2 09:08:07"
        );
    }

    #[test]
    fn parses_metadata_numbers() {
        assert_eq!(parse_metadata_number("35/10"), Some(3.5));
        assert_eq!(parse_metadata_number("2.8"), Some(2.8));
        assert_eq!(parse_metadata_number("1/0"), None);
    }

    #[test]
    fn rounds_shutter_speed_fraction_noise() {
        assert_eq!(
            format_exposure(1.0 / 124.99999406281887),
            Some("1/125s".to_string())
        );
    }

    #[test]
    fn identifies_supported_jpeg_markers() {
        assert!(is_standalone_jpeg_marker(0xd0));
        assert!(is_standalone_jpeg_marker(0xd8));
        assert!(!is_standalone_jpeg_marker(0xe1));
    }
}

fn main() {
    if let Ok(path) = std::env::var("PHOTO_REDUX_TEST_LOAD") {
        match load_photo(path) {
            Ok(asset) => {
                println!(
                    "loaded {} {}x{} preview={} bytes",
                    asset.file_name,
                    asset.width,
                    asset.height,
                    asset.preview_data_url.len()
                );
                return;
            }
            Err(error) => {
                eprintln!("{error}");
                std::process::exit(1);
            }
        }
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![load_photo, export_summary])
        .run(tauri::generate_context!())
        .expect("error while running Lightmark");
}
