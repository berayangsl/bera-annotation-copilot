# Bera Annotation Copilot 安装说明

## 适合谁

这是一个 Obsidian Markdown 标注插件：选中文字后高亮、写便签批注，标注数据单独保存在 `Bera_Annotations/`，不会改写原 Markdown 文件。

## 桌面端安装方式

1. 关闭 Obsidian，或至少关闭当前 Vault。
2. 找到你的 Vault 文件夹。
3. 在 Vault 里打开这个目录：

```text
.obsidian/plugins/
```

如果没有 `plugins` 文件夹，就手动创建。

4. 解压本 zip，确认最终目录结构是：

```text
你的Vault/.obsidian/plugins/bera-annotation-copilot/
  manifest.json
  main.js
  styles.css
```

不要多套一层文件夹，例如不要变成：

```text
plugins/bera-annotation-copilot/bera-annotation-copilot/main.js
```

5. 打开 Obsidian。
6. 进入 Settings -> Community plugins。
7. 关闭 Safe mode / Restricted mode。
8. 在 Installed plugins 里启用 `Bera Annotation Copilot`。

## iPhone / iPad 使用建议

插件 manifest 已声明 `isDesktopOnly: false`，目标是兼容 iOS / iPadOS。但 iOS 上不方便直接访问 `.obsidian/plugins/` 隐藏配置目录，所以更推荐：

1. 先在桌面端按上面的方式安装并启用插件。
2. 如果使用 Obsidian Sync，在桌面端和移动端都打开 Settings -> Sync。
3. 在 Vault configuration sync 中启用 `Installed community plugin list` 和 `Active community plugin list`。
4. 等待手机端同步完成后，重启 Obsidian 移动端。
5. 在手机端 Settings -> Community plugins 里确认 `Bera Annotation Copilot` 已安装并启用。

如果不用 Obsidian Sync，而是 iCloud / 第三方同步，需要确保 `.obsidian/plugins/bera-annotation-copilot/` 和 `Bera_Annotations/` 都会被同步到移动端。

## 使用

- 在 Markdown 文件中选中文字，会出现浮动工具条。
- 直接点颜色可以一键高亮。
- 点便签图标可以写批注。
- 右侧栏可以查看、筛选、跳转和导出标注。

## 标注数据在哪里

插件会在 Vault 根目录创建：

```text
Bera_Annotations/
  notes/
  exports/
  index.json
```

旧版本使用过的历史目录仍可读取：

```text
.bera-annotations/
```

新标注和新导出的 AI 回顾包会写入 `Bera_Annotations/`。原 Markdown 文件不会被写入高亮语法或批注内容。