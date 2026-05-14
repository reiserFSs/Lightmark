# Lightmark

Lightmark is a local desktop app for turning photo metadata into clean, exportable summary cards. Open a photo, review or edit the extracted EXIF details, add production notes, choose a visual theme, and export the result as a PNG or JPG.

## Features

- Open JPEG, PNG, TIFF, HEIC, and HEIF images.
- Extract common camera metadata, including aperture, shutter speed, ISO, focal length, camera body, lens, capture time, and bit depth.
- Add production metadata such as lighting modifier, light source, photographer, and notes.
- Preview a styled summary card with a blurred image background.
- Switch themes, adjust blur strength, and save reusable presets.
- Export rendered cards as PNG or JPG.
- Runs as a Tauri desktop app, with browser-based development support through Vite.

## Tech Stack

- React 18
- TypeScript
- Vite
- Tauri 2
- Rust

## Requirements

- Node.js and npm
- Rust toolchain
- Tauri system dependencies for your platform

For Tauri setup details, see the official prerequisites: https://v2.tauri.app/start/prerequisites/

## Getting Started

Install dependencies:

```bash
npm install
```

Run the desktop app in development mode:

```bash
npm run tauri:dev
```

Run the web frontend only:

```bash
npm run dev
```

## Quality Checks

Run TypeScript and Rust checks:

```bash
npm run check
```

Run tests:

```bash
npm test
```

Build the frontend:

```bash
npm run build
```

Build the desktop app:

```bash
npm run tauri:build
```

## Project Structure

```text
src/              React frontend
src/lib/          Metadata parsing, rendering, themes, and Tauri API helpers
src-tauri/        Tauri/Rust desktop shell
dist/             Frontend build output
```

## Notes

Lightmark is designed to run locally. Imported images are processed on-device, and presets/settings are stored locally in the app environment.
