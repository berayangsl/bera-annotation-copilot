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

The zip includes an `INSTALL.md` guide, including iPhone/iPad notes. Mobile installation is easiest when the desktop plugin setup is synced through Obsidian Sync with installed and active community plugin lists enabled.

## Release Notes

For private sharing, a zip release is the easiest path. For smoother updates later, publish the repo to GitHub and install via BRAT. For public distribution, follow Obsidian's community plugin submission process.