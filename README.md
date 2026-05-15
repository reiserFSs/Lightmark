# Lightmark

Lightmark is a local desktop app for turning photo metadata into clean, exportable summary cards for use on social media. Open a photo, review or edit the extracted EXIF details, add production notes, choose a visual theme, and export the result as a PNG or JPG. It's Photo Summary, but clean, faster and more feature packed. And the best of all: Open Source and free. 

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

## Releases and Updates

Lightmark uses Tauri's updater plugin with GitHub Releases. Normal development builds do not create updater artifacts; the release workflow enables signed updater artifacts with `src-tauri/tauri.release.conf.json`.

The updater public key is stored in `src-tauri/tauri.conf.json`. The matching private key was generated locally at:

```text
~/.tauri/lightmark.key
```

Add the private key to GitHub Actions before publishing releases:

```bash
gh secret set TAURI_SIGNING_PRIVATE_KEY < ~/.tauri/lightmark.key
```

This key was generated without a password, so `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` can be left unset. If you generate a new updater key, update the public key in `src-tauri/tauri.conf.json` and replace the GitHub secret.

To publish a release:

```bash
npm version patch --no-git-tag-version
```

Update `src-tauri/tauri.conf.json` and `src-tauri/Cargo.toml` to the same version, then tag and push:

```bash
git add package.json package-lock.json src-tauri/tauri.conf.json src-tauri/Cargo.toml
git commit -m "Release v0.1.1"
git tag v0.1.1
git push && git push origin v0.1.1
```

The `Release` workflow builds the Windows installer, uploads release assets, and publishes `latest.json` for automatic update checks.

## Project Structure

```text
src/              React frontend
src/lib/          Metadata parsing, rendering, themes, and Tauri API helpers
src-tauri/        Tauri/Rust desktop shell
dist/             Frontend build output
```

## Notes

Lightmark is designed to run locally. Imported images are processed on-device, and presets/settings are stored locally in the app environment.
