# BRAT / GitHub Beta Release Notes

## 当前判断

Bera 实测打开 `All other types` 后，`Bera_Annotations` 中的 JSON 可以同步，但 `.obsidian/plugins` 仍没有同步记录。当前判断：Obsidian Sync 对普通 Vault 非 Markdown 文件有效，但不可靠下发手工本地插件 bundle；iOS 端安装本插件转向 BRAT/GitHub beta 通道。

本地插件三件套必须最终出现在 iOS 的插件目录中：

```text
.obsidian/plugins/bera-annotation-copilot/manifest.json
.obsidian/plugins/bera-annotation-copilot/main.js
.obsidian/plugins/bera-annotation-copilot/styles.css
```

由于当前 Sync 路线没有下发 `.obsidian/plugins`，下一步使用 GitHub release + BRAT 安装。

## BRAT/GitHub 通道

Obsidian 官方开发者文档建议：插件发布前的 beta 测试可用 BRAT。BRAT 会从 GitHub release 下载 `manifest.json`、`main.js`、`styles.css` 并安装进 Vault。

本工程的 `npm run package` 会生成两类产物：

```text
dist/bera-annotation-copilot-0.1.0.zip
```

用于朋友手动安装。

```text
dist/brat-release-assets/
  manifest.json
  main.js
  styles.css
```

用于 GitHub release assets。创建 GitHub release 时，把这三个文件作为 release asset 单独上传。

## 待办

1. 重载桌面端 Obsidian，确认新 id `bera-annotation-copilot` 对应的 `Bera Annotation Copilot` 可启用。
2. 创建 GitHub repo，建议 repo 名：`bera-annotation-copilot`，建议先用 Public，且不要初始化 README / LICENSE / `.gitignore`。
3. 将本地 repo push 到 GitHub。
4. 创建 release `0.1.0`，tag 也使用 `0.1.0`，可标记为 pre-release。
5. 上传 `dist/brat-release-assets/` 下的 `manifest.json`、`main.js`、`styles.css` 作为 release assets。
6. iOS 端安装 BRAT，运行 `BRAT: Add a beta plugin for testing`，输入 GitHub repo URL，然后启用 `Bera Annotation Copilot`。

plugin id 已合规迁移为 `bera-annotation-copilot`。官方 manifest 规范要求 plugin id 不包含 `obsidian`，并要求 id 与本地插件文件夹名一致。

## 本地清理状态

- 本地工程目录：`D:\工具开发\bera-annotation-copilot\`
- 当前 Vault 插件目录：`C:\Users\sheng\Documents\obsidian\.obsidian\plugins\bera-annotation-copilot\`
- 旧 Vault 插件目录已移出 `.obsidian/plugins`，避免 Obsidian / Sync 再看到旧 id。
- 旧 `.bera-annotations` 数据已迁入 `Bera_Annotations` 后归档；代码仍保留旧目录读取兼容，便于未来遇到旧 Vault 时兜底。
- 旧 id 的 dist 包已删除；当前发布只使用 `bera-annotation-copilot` 包和 `dist/brat-release-assets/`。

## 当前推进方案

本地 id 迁移与旧目录清理已完成。当前缺口是 GitHub repo / remote：GitHub connector 当前登录为 `berayangsl`，但 GitHub App 没有安装到任何 repo；本机也没有 `gh` CLI。Bera 创建 repo 并提供 URL 后，继续执行 `git remote add`、`git push`，再创建 `0.1.0` release 并上传 `dist/brat-release-assets/` 三件套。
