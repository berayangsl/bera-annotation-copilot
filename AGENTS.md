# Obsidian Annotation Copilot — AGENTS.md

本目录是 Bera 的 Obsidian 标注插件本地代码工程。

长期项目真相源：

```text
C:\Users\sheng\Documents\obsidian\01_Projects\工具开发与自动化\工具项目\Obsidian标注插件\
```

本地插件工程：

```text
D:\工具开发\bera-annotation-copilot\
```

开发安装目标：

```text
C:\Users\sheng\Documents\obsidian\.obsidian\plugins\bera-annotation-copilot\
```

## 启动必读

进入本目录开发前先读取：

1. `D:\工具开发\AGENTS.md`
2. `C:\Users\sheng\Documents\obsidian\01_Projects\工具开发与自动化\Current_State.md`
3. `C:\Users\sheng\Documents\obsidian\01_Projects\工具开发与自动化\Next_Actions.md`
4. `C:\Users\sheng\Documents\obsidian\01_Projects\工具开发与自动化\工具项目\Obsidian标注插件\功能计划.md`
5. `C:\Users\sheng\Documents\obsidian\01_Projects\工具开发与自动化\工具项目\Obsidian标注插件\开发接续卡.md`

## 开发边界

- 第一版只做 Markdown 标注，不做 PDF。
- 插件目标兼容 iOS / iPadOS；运行时代码不要引入 Node/Electron API，桌面专属能力必须显式隔离。
- 原 Markdown 文件不能被写入高亮语法或批注内容。
- 新标注数据写入 Vault 下 `Bera_Annotations/` sidecar 目录；旧 `.bera-annotations/` 必须保留读取兼容。
- 插件只生成 AI 回顾包，不自动写入阅读、成长、投资研究或知识库文件。
- 代码变更后至少跑 `npm run build`。
- 需要安装到本机 Vault 时跑 `npm run install:dev`。

## 默认同步到 Vault 插件目录

- 本工程的 `esbuild.config.mjs` 已配置构建后自动同步：`manifest.json`、`main.js`、`styles.css` 会复制到 `C:\Users\sheng\Documents\obsidian\.obsidian\plugins\bera-annotation-copilot\`。
- 后续插件代码更新默认运行 `npm run build`；如果使用 `npm run dev` watch，esbuild 每次成功重建后也会同步到 Vault 插件目录。
- `npm run install:dev` 保留为显式重装命令；不要删除安装目录里的 `data.json`。
- 移动端验证前继续确认 `manifest.json` 的 `isDesktopOnly` 为 `false`，并确认 `.obsidian/community-plugins.json` 包含 `bera-annotation-copilot`。
## UTF-8 写入规则

修改 Obsidian 中文项目文件、开发日志、AGENTS 或长 Markdown 时，使用：

```powershell
C:\Users\sheng\.codex\write_utf8.ps1
```

写后必须回读检查中文可读、无截断、必要章节齐全。

## 收尾检查

每个可验证阶段结束后：

1. 更新 `工具项目/Obsidian标注插件/开发日志/`。
2. 如下一步动作变化，更新工具项目 `Next_Actions.md` 或 `开发接续卡.md`。
3. 回答中说明已验证命令和当前插件安装状态。