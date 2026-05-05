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
dist/bera-annotation-copilot-<version>.zip
```

用于朋友手动安装。

```text
dist/brat-release-assets/
  manifest.json
  main.js
  styles.css
```

用于 GitHub release assets。创建 GitHub release 时，把这三个文件作为 release asset 单独上传。

## 已发布

- Repo：`https://github.com/berayangsl/bera-annotation-copilot`
- Release：`https://github.com/berayangsl/bera-annotation-copilot/releases/tag/0.1.3`
- Tag：`0.1.3`
- Assets：`manifest.json`、`main.js`、`styles.css`
- Release 类型：正式 release

plugin id 已合规迁移为 `bera-annotation-copilot`。官方 manifest 规范要求 plugin id 不包含 `obsidian`，并要求 id 与本地插件文件夹名一致。

`0.1.3` 已包含 2026-05-05 真实阅读修复：阅读视图 / 折叠 callout 渲染高亮、sidebar 点击后高亮保持、跨署名行 / 跨标题行 / 跨段落选区触发。Bera 桌面端已复测折叠 callout 标题行选区可以触发工具条；GitHub release 远端 assets 已下载并与本地 `dist/brat-release-assets/` SHA256 校验一致。

## 本地清理状态

- 本地工程目录：`D:\工具开发\bera-annotation-copilot\`
- 当前 Vault 插件目录：`C:\Users\sheng\Documents\obsidian\.obsidian\plugins\bera-annotation-copilot\`
- 旧 Vault 插件目录已移出 `.obsidian/plugins`，避免 Obsidian / Sync 再看到旧 id。
- 旧 `.bera-annotations` 数据已迁入 `Bera_Annotations` 后归档；代码仍保留旧目录读取兼容，便于未来遇到旧 Vault 时兜底。
- 旧 id 的 dist 包已删除；当前发布只使用 `bera-annotation-copilot` 包和 `dist/brat-release-assets/`。


## 跨端版本一致性规则

当前桌面端来自本地工程构建产物，iOS / iPadOS 端来自 GitHub release assets。当前 `0.1.3` 已核对：桌面 Vault 插件目录、`dist/brat-release-assets/` 与 GitHub release assets 的 `manifest.json`、`main.js`、`styles.css` hash 一致。

后续规则：

1. 只运行 `npm run build`：只更新桌面 Vault 插件目录，可用于桌面端先行试验。
2. 要同步到 iOS / iPadOS：必须 bump version，运行 `npm run package`，推送 git，并创建同版本 GitHub release。
3. Release tag 必须与 `manifest.json` version 保持一致。
4. Release assets 必须包含：`manifest.json`、`main.js`、`styles.css`。
5. 发布后校验 GitHub release assets 数量和名称；必要时再比对本地 hash。
6. 数据结构变更默认要求向后兼容，尤其是 `Bera_Annotations/`、sidecar JSON、annotation 字段、索引格式。
## 下一步

在 iOS / iPadOS 端通过 BRAT 更新到 `0.1.3`，复测阅读视图高亮和折叠 callout 复杂选区。
