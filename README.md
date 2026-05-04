# Bera Annotation Copilot

Personal Obsidian plugin for sidecar Markdown annotations.

## What it does

- Capture selected Markdown text from the active editor.
- Show a floating highlight toolbar after text selection.
- Save highlight data to `Bera_Annotations/notes/<pathHash>-<encodedPrefix>.json`, while still reading legacy `.bera-annotations/` data.
- Render non-invasive CodeMirror highlights.
- Show current file and vault-wide annotations in a right sidebar.
- Export annotation review packs for AI discussion.
- Keep the plugin mobile-compatible by avoiding Node/Electron runtime APIs; `manifest.json` sets `isDesktopOnly` to `false`.

## Development Commands

```powershell
npm install
npm run build
npm run install:dev
```

## Package For A Friend

```powershell
npm run package
```

This creates:

```text
dist/bera-annotation-copilot-<version>.zip
```

Send that zip to a friend. They can extract it into:

```text
<their-vault>/.obsidian/plugins/bera-annotation-copilot/
```

The zip includes an `INSTALL.md` guide. For iPhone/iPad, use the GitHub + BRAT beta path because Obsidian Sync did not reliably sync a manually copied `.obsidian/plugins/` bundle in testing.

## BRAT / GitHub Beta

Run:

```powershell
npm run package
```

Then create a GitHub release whose tag matches `manifest.json` version, and upload these release assets:

```text
dist/brat-release-assets/manifest.json
dist/brat-release-assets/main.js
dist/brat-release-assets/styles.css
```

On iOS/iPadOS, install BRAT and add the GitHub repository as a beta plugin.

## Release Notes

For private sharing, a zip release is the easiest path. For smoother updates later, publish the repo to GitHub and install via BRAT. For public distribution, follow Obsidian's community plugin submission process.
