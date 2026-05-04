import builtins from "builtin-modules";
import esbuild from "esbuild";
import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const prod = process.argv[2] === "production";
const watch = process.argv.includes("--watch");
const projectRoot = fileURLToPath(new URL(".", import.meta.url));
const vaultPluginDir =
  "C:\\Users\\sheng\\Documents\\obsidian\\.obsidian\\plugins\\bera-annotation-copilot";

async function syncToVaultPluginDir() {
  await mkdir(vaultPluginDir, { recursive: true });

  for (const file of ["manifest.json", "main.js", "styles.css"]) {
    await copyFile(path.join(projectRoot, file), path.join(vaultPluginDir, file));
  }
}

const syncToVaultPluginDirPlugin = {
  name: "sync-to-vault-plugin-dir",
  setup(build) {
    build.onEnd(async (result) => {
      if (result.errors.length > 0) {
        return;
      }

      await syncToVaultPluginDir();
      console.log(`Synced development plugin to ${vaultPluginDir}`);
    });
  }
};

const context = await esbuild.context({
  absWorkingDir: projectRoot,
  banner: {
    js: "/* THIS FILE IS GENERATED. Edit src/main.ts instead. */"
  },
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: [
    "obsidian",
    "electron",
    "@codemirror/autocomplete",
    "@codemirror/collab",
    "@codemirror/commands",
    "@codemirror/language",
    "@codemirror/lint",
    "@codemirror/search",
    "@codemirror/state",
    "@codemirror/view",
    "@lezer/common",
    "@lezer/highlight",
    "@lezer/lr",
    ...builtins
  ],
  format: "cjs",
  target: "es2018",
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  outfile: "main.js",
  minify: prod,
  plugins: [syncToVaultPluginDirPlugin]
});

if (watch) {
  await context.watch();
  console.log("Watching for changes...");
} else {
  await context.rebuild();
  await context.dispose();
}
