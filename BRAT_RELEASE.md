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
2. 创建 GitHub repo，建议 repo 名：`bera-annotation-copilot`。
3. 创建 release `0.1.0`。
4. 上传 `dist/brat-release-assets/` 下的 `manifest.json`、`main.js`、`styles.css` 作为 release assets。
5. iOS 端安装 BRAT，运行 `BRAT: Add a beta plugin for testing`，输入 GitHub repo URL，然后启用 `Bera Annotation Copilot`。

plugin id 已合规迁移为 `bera-annotation-copilot`。官方 manifest 规范要求 plugin id 不包含 `obsidian`，并要求 id 与本地插件文件夹名一致。

## 当前推进方案

本地 id 迁移已完成，旧插件目录保留为回滚备份。当前缺口是 GitHub 账号/repo：本环境 GitHub connector 没有已安装账号，`gh` CLI 不可用。Bera 提供 repo 或完成 GitHub 授权后，上传 `dist/brat-release-assets/` 三件套并创建 `0.1.0` release。