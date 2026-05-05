import {
  App,
  Editor,
  ItemView,
  MarkdownView,
  Menu,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  WorkspaceLeaf,
  normalizePath,
  setIcon
} from "obsidian";
import { RangeSetBuilder, StateEffect, StateField } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView } from "@codemirror/view";

const VIEW_TYPE_ANNOTATION_SIDEBAR = "bera-annotation-sidebar";
const STORE_ROOT = "Bera_Annotations";
const LEGACY_STORE_ROOT = ".bera-annotations";
const NOTES_DIR = `${STORE_ROOT}/notes`;
const EXPORTS_DIR = `${STORE_ROOT}/exports`;
const INDEX_PATH = `${STORE_ROOT}/index.json`;
const LEGACY_NOTES_DIR = `${LEGACY_STORE_ROOT}/notes`;
const LEGACY_INDEX_PATH = `${LEGACY_STORE_ROOT}/index.json`;

const COLOR_OPTIONS = ["yellow", "orange", "pink", "green", "blue", "purple"] as const;
const STATUS_OPTIONS = ["unreviewed", "discussed", "distilled", "parked"] as const;
const SCOPE_OPTIONS = ["current", "all"] as const;
const SORT_OPTIONS = ["newest", "oldest", "file"] as const;

type AnnotationColor = (typeof COLOR_OPTIONS)[number];
type AnnotationStatus = (typeof STATUS_OPTIONS)[number];
type AnnotationScope = (typeof SCOPE_OPTIONS)[number];
type AnnotationSort = (typeof SORT_OPTIONS)[number];

const DEFAULT_COLOR: AnnotationColor = "yellow";
const DEFAULT_COLOR_LABELS: Record<AnnotationColor, string> = {
  yellow: "亮点",
  orange: "提醒",
  pink: "补充",
  green: "灵感",
  blue: "想法",
  purple: "原则"
};
const SWATCH_COLORS: Record<AnnotationColor, string> = {
  yellow: "#f6cf5c",
  orange: "#f4a968",
  pink: "#e48ba6",
  green: "#88be8b",
  blue: "#7eaeda",
  purple: "#a893d3"
};
const STATUS_LABELS: Record<AnnotationStatus, string> = {
  unreviewed: "未回顾",
  discussed: "已讨论",
  distilled: "已沉淀",
  parked: "暂存"
};

interface BeraAnnotationSettings {
  colorLabels: Record<AnnotationColor, string>;
}

const DEFAULT_SETTINGS: BeraAnnotationSettings = {
  colorLabels: { ...DEFAULT_COLOR_LABELS }
};

interface AnnotationAnchor {
  line: number;
  from: number;
  to: number;
  fromLine: number;
  fromCh: number;
  toLine: number;
  toCh: number;
  textHash: string;
  contextBefore: string;
  contextAfter: string;
}

interface BeraAnnotation {
  id: string;
  filePath: string;
  selectedText: string;
  note: string;
  color: AnnotationColor;
  status: AnnotationStatus;
  anchor: AnnotationAnchor;
  createdAt: string;
  updatedAt: string;
}

interface PendingAnnotationDraft {
  filePath: string;
  selectedText: string;
  anchor: AnnotationAnchor;
  rect: {
    top: number;
    bottom: number;
    left: number;
    right: number;
  };
}

interface AnnotationFileData {
  version: 1;
  filePath: string;
  annotations: BeraAnnotation[];
}

interface AnnotationIndex {
  version: 1;
  updatedAt: string;
  files: Record<string, { count: number; updatedAt: string }>;
}

const setAnnotationsEffect = StateEffect.define<BeraAnnotation[]>();

const annotationStateField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none;
  },
  update(decorations, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(setAnnotationsEffect)) {
        return buildDecorations(transaction.state.doc, effect.value);
      }
    }

    if (transaction.docChanged) {
      return decorations.map(transaction.changes);
    }

    return decorations;
  },
  provide: (field) => EditorView.decorations.from(field)
});

export default class BeraAnnotationPlugin extends Plugin {
  private floatingToolbar: AnnotationFloatingToolbar | null = null;
  private activeAnnotations: BeraAnnotation[] = [];
  private renderedHighlightRefreshFrame: number | null = null;
  private renderedHighlightObserver: MutationObserver | null = null;
  private lastMarkdownFilePath: string | null = null;
  settings: BeraAnnotationSettings = DEFAULT_SETTINGS;

  async onload() {
    await this.loadSettings();
    this.floatingToolbar = new AnnotationFloatingToolbar(this);
    this.registerEditorExtension([
      annotationStateField,
      EditorView.updateListener.of((update) => {
        if (
          update.selectionSet ||
          update.focusChanged ||
          update.docChanged ||
          update.viewportChanged
        ) {
          this.floatingToolbar?.handleEditorUpdate(update.view);
        }

        if (update.docChanged || update.viewportChanged) {
          this.scheduleRenderedHighlightRefresh();
        }
      })
    ]);
    this.registerDomEvent(document, "selectionchange", () => {
      window.requestAnimationFrame(() => {
        const editorView = this.getEditorView();
        if (!editorView) {
          return;
        }

        this.floatingToolbar?.handleDomSelectionChange(editorView);
      });
    });

    this.registerView(
      VIEW_TYPE_ANNOTATION_SIDEBAR,
      (leaf) => new AnnotationSidebarView(leaf, this)
    );

    this.addSettingTab(new AnnotationSettingTab(this.app, this));

    this.addRibbonIcon("highlighter", "Open annotation sidebar", () => {
      void this.activateSidebar();
    });

    this.addCommand({
      id: "create-annotation-from-selection",
      name: "Create annotation from selection",
      editorCallback: (editor, context) => {
        const view =
          context instanceof MarkdownView
            ? context
            : this.app.workspace.getActiveViewOfType(MarkdownView);

        if (!view) {
          new Notice("Open a Markdown file first.");
          return;
        }

        void this.createAnnotationFromSelection(editor, view);
      }
    });

    this.addCommand({
      id: "open-annotation-sidebar",
      name: "Open annotation sidebar",
      callback: () => {
        void this.activateSidebar("current");
      }
    });

    this.addCommand({
      id: "open-annotation-inbox",
      name: "Open annotation inbox",
      callback: () => {
        void this.activateSidebar("all");
      }
    });

    this.addCommand({
      id: "export-current-file-review-pack",
      name: "Export current file annotation review pack",
      callback: () => {
        void this.exportCurrentFileReviewPack();
      }
    });

    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu: Menu, editor: Editor, view: MarkdownView) => {
        if (!editor.getSelection()) {
          return;
        }

        menu.addItem((item) => {
          item
            .setTitle("Create annotation")
            .setIcon("highlighter")
            .onClick(() => {
              void this.createAnnotationFromSelection(editor, view);
            });
        });
      })
    );

    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => {
        void this.refreshActiveFile();
      })
    );

    this.registerEvent(
      this.app.workspace.on("file-open", () => {
        void this.refreshActiveFile();
      })
    );
    this.registerEvent(
      this.app.workspace.on("layout-change", () => {
        this.scheduleRenderedHighlightRefresh();
      })
    );

    this.app.workspace.onLayoutReady(() => {
      void this.refreshActiveFile();
    });
  }

  onunload() {
    if (this.renderedHighlightRefreshFrame !== null) {
      window.cancelAnimationFrame(this.renderedHighlightRefreshFrame);
      this.renderedHighlightRefreshFrame = null;
    }
    this.renderedHighlightObserver?.disconnect();
    this.renderedHighlightObserver = null;
    this.clearRenderedHighlights();
    this.floatingToolbar?.destroy();
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_ANNOTATION_SIDEBAR);
  }

  async loadSettings() {
    const saved = (await this.loadData()) as Partial<BeraAnnotationSettings> | null;
    this.settings = {
      ...DEFAULT_SETTINGS,
      ...saved,
      colorLabels: {
        ...DEFAULT_COLOR_LABELS,
        ...(saved?.colorLabels ?? {})
      }
    };
  }

  async saveSettings() {
    await this.saveData(this.settings);
    await this.refreshSidebar();
  }

  getColorLabel(color: AnnotationColor) {
    return this.settings.colorLabels[color]?.trim() || DEFAULT_COLOR_LABELS[color];
  }

  async activateSidebar(scope?: AnnotationScope) {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_ANNOTATION_SIDEBAR);
    let leaf: WorkspaceLeaf | null = leaves.first() ?? null;

    if (!leaf) {
      leaf = this.app.workspace.getRightLeaf(false);
      if (!leaf) {
        new Notice("Could not open annotation sidebar.");
        return;
      }

      await leaf.setViewState({ type: VIEW_TYPE_ANNOTATION_SIDEBAR, active: true });
    }

    this.app.workspace.revealLeaf(leaf);
    if (leaf.view instanceof AnnotationSidebarView && scope) {
      leaf.view.setScope(scope);
    }

    await this.refreshSidebar();
  }

  async createAnnotationFromSelection(editor: Editor, view: MarkdownView) {
    const file = view.file;
    if (!file) {
      new Notice("Select text in a Markdown file first.");
      return;
    }

    const editorView = this.getEditorView();
    const draftFromEditorView = editorView ? buildDraftFromEditorView(file.path, editorView) : null;
    if (draftFromEditorView) {
      this.floatingToolbar?.showDraft(draftFromEditorView, { openNote: true });
      return;
    }

    const selectedText = editor.getSelection();
    if (!selectedText.trim()) {
      new Notice("Select text in a Markdown file first.");
      return;
    }

    const from = editor.getCursor("from");
    const to = editor.getCursor("to");
    const startLine = editor.getLine(from.line) ?? "";
    const endLine = editor.getLine(to.line) ?? "";

    const centerX = window.innerWidth / 2;
    const centerY = window.innerHeight / 2;
    const draft: PendingAnnotationDraft = {
      filePath: file.path,
      selectedText,
      anchor: {
        line: from.line,
        from: from.ch,
        to: to.ch,
        fromLine: from.line,
        fromCh: from.ch,
        toLine: to.line,
        toCh: to.ch,
        textHash: hashText(selectedText),
        contextBefore: startLine.slice(Math.max(0, from.ch - 80), from.ch),
        contextAfter: endLine.slice(to.ch, to.ch + 80)
      },
      rect: {
        top: centerY,
        bottom: centerY,
        left: centerX,
        right: centerX
      }
    };

    this.floatingToolbar?.showDraft(draft, { openNote: true });
  }

  async createAnnotationFromDraft(
    draft: PendingAnnotationDraft,
    color: AnnotationColor,
    note: string,
    options: { revealSidebar?: boolean } = {}
  ) {
    const now = new Date().toISOString();
    const annotation: BeraAnnotation = {
      id: createId(),
      filePath: draft.filePath,
      selectedText: draft.selectedText,
      note,
      color,
      status: "unreviewed",
      anchor: draft.anchor,
      createdAt: now,
      updatedAt: now
    };

    const annotations = await this.loadAnnotationsForFile(draft.filePath);
    annotations.push(annotation);
    await this.saveAnnotationsForFile(draft.filePath, annotations);

    try {
      await this.refreshActiveFile();
    } catch (error) {
      console.error("Annotation was saved, but the active editor could not be refreshed.", error);
    }

    if (options.revealSidebar ?? Boolean(note)) {
      try {
        await this.activateSidebar();
      } catch (error) {
        console.error("Annotation was saved, but the sidebar could not be opened.", error);
      }
    }

    new Notice(note ? "Annotation saved." : "Highlight saved.");
  }

  async getCurrentFileAnnotations() {
    const file = this.getActiveFile() ?? this.getLastMarkdownFile();
    if (!file) {
      return { file: null, annotations: [] as BeraAnnotation[] };
    }

    return {
      file,
      annotations: await this.loadAnnotationsForFile(file.path)
    };
  }

  async updateAnnotation(filePath: string, annotation: BeraAnnotation) {
    const annotations = await this.loadAnnotationsForFile(filePath);
    const index = annotations.findIndex((item) => item.id === annotation.id);
    if (index === -1) {
      return;
    }

    annotations[index] = {
      ...annotation,
      updatedAt: new Date().toISOString()
    };

    await this.saveAnnotationsForFile(filePath, annotations);
    await this.refreshActiveFile();
  }

  async deleteAnnotation(filePath: string, annotationId: string) {
    const annotations = await this.loadAnnotationsForFile(filePath);
    await this.saveAnnotationsForFile(
      filePath,
      annotations.filter((annotation) => annotation.id !== annotationId)
    );
    await this.refreshActiveFile();
  }

  async jumpToAnnotation(annotation: BeraAnnotation) {
    const file = this.app.vault.getAbstractFileByPath(annotation.filePath);
    if (!(file instanceof TFile)) {
      new Notice("Annotation source file not found.");
      return;
    }

    const leaf = this.app.workspace.getLeaf(false);
    await leaf.openFile(file);
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) {
      return;
    }

    const from = { line: annotation.anchor.fromLine, ch: annotation.anchor.fromCh };
    const to = { line: annotation.anchor.toLine, ch: annotation.anchor.toCh };
    view.editor.setSelection(from, to);
    view.editor.scrollIntoView({ from, to }, true);
  }

  async exportCurrentFileReviewPack() {
    const file = this.getActiveFile();
    if (!file) {
      new Notice("Open a Markdown file first.");
      return;
    }

    const annotations = await this.loadAnnotationsForFile(file.path);
    if (annotations.length === 0) {
      new Notice("No annotations to export for the current file.");
      return;
    }

    await this.exportAnnotationsReviewPack(file.path, annotations);
  }

  async exportAnnotationsReviewPack(sourceLabel: string, annotations: BeraAnnotation[]) {
    if (annotations.length === 0) {
      new Notice("No annotations to export.");
      return;
    }

    await this.ensureFolder(EXPORTS_DIR);
    const stamp = formatDateForPath(new Date());
    const exportPath = normalizePath(`${EXPORTS_DIR}/${stamp}_annotation-review.md`);
    const markdown = buildReviewPack(sourceLabel, annotations);
    await this.app.vault.adapter.write(exportPath, markdown);
    new Notice(`Annotation review pack exported: ${exportPath}`);
  }

  async refreshActiveFile() {
    const file = this.getActiveFile() ?? this.getLastMarkdownFile();
    if (file) {
      this.lastMarkdownFilePath = file.path;
    }

    const annotations = file ? await this.loadAnnotationsForFile(file.path) : [];
    this.activeAnnotations = annotations;

    if (!file) {
      this.lastMarkdownFilePath = null;
      this.clearRenderedHighlights();
      this.renderedHighlightObserver?.disconnect();
      this.renderedHighlightObserver = null;
      await this.refreshSidebar();
      return;
    }

    const editorView = this.getEditorView();
    if (editorView) {
      try {
        editorView.dispatch({
          effects: setAnnotationsEffect.of(annotations)
        });
      } catch (error) {
        console.error("Could not refresh annotation decorations", error);
      }
    }

    this.scheduleRenderedHighlightRefresh();

    await this.refreshSidebar();
  }

  private scheduleRenderedHighlightRefresh() {
    if (this.renderedHighlightRefreshFrame !== null) {
      window.cancelAnimationFrame(this.renderedHighlightRefreshFrame);
    }

    this.renderedHighlightRefreshFrame = window.requestAnimationFrame(() => {
      this.renderedHighlightRefreshFrame = null;
      this.renderRenderedHighlights(this.activeAnnotations);
    });
  }

  private clearRenderedHighlights() {
    const api = getHighlightApi();
    if (!api) {
      return;
    }

    for (const color of COLOR_OPTIONS) {
      api.registry.delete(getRenderedHighlightName(color));
    }
  }

  private renderRenderedHighlights(annotations: BeraAnnotation[]) {
    const api = getHighlightApi();
    if (!api) {
      return;
    }

    const targets = this.getRenderedHighlightTargets();
    if (targets.length === 0) {
      return;
    }

    this.clearRenderedHighlights();
    this.observeRenderedHighlightTargets(targets.map((target) => target.root));

    const rangesByColor = new Map<AnnotationColor, Range[]>();

    for (const annotation of annotations) {
      for (const target of targets) {
        const sourceRect = target.editorView
          ? getAnnotationSourceRect(target.editorView, annotation)
          : null;
        const ranges = findRenderedAnnotationRanges(target.root, annotation, sourceRect);
        if (ranges.length === 0) {
          continue;
        }

        const colorRanges = rangesByColor.get(annotation.color) ?? [];
        colorRanges.push(...ranges);
        rangesByColor.set(annotation.color, colorRanges);
      }
    }

    for (const [color, ranges] of rangesByColor) {
      api.registry.set(getRenderedHighlightName(color), new api.HighlightCtor(...ranges));
    }
  }

  private observeRenderedHighlightTargets(roots: HTMLElement[]) {
    this.renderedHighlightObserver?.disconnect();
    this.renderedHighlightObserver = null;

    if (roots.length === 0 || typeof MutationObserver === "undefined") {
      return;
    }

    const observer = new MutationObserver(() => {
      this.scheduleRenderedHighlightRefresh();
    });
    for (const root of roots) {
      observer.observe(root, {
        childList: true,
        characterData: true,
        subtree: true
      });
    }
    this.renderedHighlightObserver = observer;
  }

  private getRenderedHighlightTargets() {
    const targets: RenderedHighlightTarget[] = [];
    const seen = new Set<HTMLElement>();
    const markdownView = this.getMarkdownViewForHighlights();
    const editorView = this.getEditorView(markdownView);

    const addTarget = (root: HTMLElement | null | undefined, targetEditorView: EditorView | null) => {
      if (!root || !root.isConnected || seen.has(root)) {
        return;
      }

      seen.add(root);
      targets.push({ root, editorView: targetEditorView });
    };

    addTarget(editorView?.dom, editorView ?? null);

    for (const root of getMarkdownPreviewRoots(markdownView, editorView?.dom ?? null)) {
      addTarget(root, null);
    }

    return targets;
  }

  async refreshSidebar() {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_ANNOTATION_SIDEBAR);
    for (const leaf of leaves) {
      const view = leaf.view;
      if (view instanceof AnnotationSidebarView) {
        await view.render();
      }
    }
  }

  async loadAnnotationsForFile(filePath: string): Promise<BeraAnnotation[]> {
    const annotations: BeraAnnotation[] = [];
    const seenIds = new Set<string>();

    for (const path of this.getAnnotationFileReadPaths(filePath)) {
      if (!(await this.app.vault.adapter.exists(path))) {
        continue;
      }

      try {
        const raw = await this.app.vault.adapter.read(path);
        const parsed = JSON.parse(raw) as AnnotationFileData;
        this.appendAnnotations(parsed.annotations, annotations, seenIds);
      } catch (error) {
        console.error(`Could not read annotations from ${path}`, error);
        new Notice(`Could not read annotation data for ${filePath}.`);
      }
    }

    return annotations;
  }

  async loadAllAnnotations(): Promise<BeraAnnotation[]> {
    const annotations: BeraAnnotation[] = [];
    const seenIds = new Set<string>();

    await this.collectAnnotationsFromDirectory(NOTES_DIR, annotations, seenIds);
    await this.collectAnnotationsFromDirectory(LEGACY_NOTES_DIR, annotations, seenIds);

    return annotations;
  }

  private async saveAnnotationsForFile(filePath: string, annotations: BeraAnnotation[]) {
    await this.ensureFolder(NOTES_DIR);

    const data: AnnotationFileData = {
      version: 1,
      filePath,
      annotations
    };

    await this.app.vault.adapter.write(
      this.getAnnotationFilePath(filePath),
      JSON.stringify(data, null, 2)
    );

    await this.updateIndex(filePath, annotations.length);
  }

  private async updateIndex(filePath: string, count: number) {
    await this.ensureFolder(STORE_ROOT);
    const now = new Date().toISOString();
    let index: AnnotationIndex = {
      version: 1,
      updatedAt: now,
      files: {}
    };

    try {
      const indexPath = (await this.app.vault.adapter.exists(INDEX_PATH))
        ? INDEX_PATH
        : LEGACY_INDEX_PATH;
      if (await this.app.vault.adapter.exists(indexPath)) {
        index = JSON.parse(await this.app.vault.adapter.read(indexPath)) as AnnotationIndex;
      }
    } catch (error) {
      console.error("Could not parse annotation index; recreating it.", error);
    }

    index.version = 1;
    index.updatedAt = now;
    index.files[filePath] = { count, updatedAt: now };

    await this.app.vault.adapter.write(INDEX_PATH, JSON.stringify(index, null, 2));
  }

  private async ensureFolder(path: string) {
    const normalized = normalizePath(path);
    const parts = normalized.split("/");
    let current = "";

    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!(await this.app.vault.adapter.exists(current))) {
        await this.app.vault.adapter.mkdir(current);
      }
    }
  }

  private getAnnotationFilePath(filePath: string) {
    return normalizePath(`${NOTES_DIR}/${getAnnotationFileName(filePath)}`);
  }

  private getLegacyAnnotationFilePath(filePath: string) {
    return normalizePath(`${LEGACY_NOTES_DIR}/${getAnnotationFileName(filePath)}`);
  }

  private getLegacyHexAnnotationFilePath(filePath: string) {
    return normalizePath(`${LEGACY_NOTES_DIR}/${encodePath(filePath)}.json`);
  }

  private getAnnotationFileReadPaths(filePath: string) {
    return [
      this.getAnnotationFilePath(filePath),
      this.getLegacyAnnotationFilePath(filePath),
      this.getLegacyHexAnnotationFilePath(filePath)
    ];
  }

  private appendAnnotations(
    source: BeraAnnotation[] | undefined,
    target: BeraAnnotation[],
    seenIds: Set<string>
  ) {
    if (!Array.isArray(source)) {
      return;
    }

    for (const annotation of source) {
      if (seenIds.has(annotation.id)) {
        continue;
      }

      seenIds.add(annotation.id);
      target.push(annotation);
    }
  }

  private async collectAnnotationsFromDirectory(
    directory: string,
    annotations: BeraAnnotation[],
    seenIds: Set<string>
  ) {
    const exists = await this.app.vault.adapter.exists(directory);
    if (!exists) {
      return;
    }

    const listing = await this.app.vault.adapter.list(directory);
    for (const path of listing.files.filter((file) => file.endsWith(".json"))) {
      try {
        const raw = await this.app.vault.adapter.read(path);
        const parsed = JSON.parse(raw) as AnnotationFileData;
        this.appendAnnotations(parsed.annotations, annotations, seenIds);
      } catch (error) {
        console.error(`Could not read annotations from ${path}`, error);
      }
    }
  }

  getActiveMarkdownFile() {
    return this.getActiveFile();
  }

  private getActiveFile() {
    return this.app.workspace.getActiveFile();
  }

  private getLastMarkdownFile() {
    if (!this.lastMarkdownFilePath) {
      return null;
    }

    const file = this.app.vault.getAbstractFileByPath(this.lastMarkdownFilePath);
    return file instanceof TFile ? file : null;
  }

  private isAnnotationSidebarActive() {
    return this.app.workspace.activeLeaf?.view instanceof AnnotationSidebarView;
  }

  private getMarkdownViewForHighlights() {
    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (activeView && (!this.lastMarkdownFilePath || activeView.file?.path === this.lastMarkdownFilePath)) {
      return activeView;
    }

    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const view = leaf.view;
      if (
        view instanceof MarkdownView &&
        (!this.lastMarkdownFilePath || view.file?.path === this.lastMarkdownFilePath)
      ) {
        return view;
      }
    }

    return activeView ?? null;
  }

  private getEditorView(view = this.app.workspace.getActiveViewOfType(MarkdownView)) {
    const maybeEditorView = (view?.editor as unknown as { cm?: EditorView })?.cm;
    return maybeEditorView && typeof maybeEditorView.dispatch === "function"
      ? maybeEditorView
      : null;
  }
}

class AnnotationSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: BeraAnnotationPlugin) {
    super(app, plugin);
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Bera Annotation Copilot" });
    containerEl.createEl("p", {
      text: "Customize the display labels for highlight colors. Existing annotation data keeps the same stable color keys."
    });

    for (const color of COLOR_OPTIONS) {
      new Setting(containerEl)
        .setName(`${capitalize(color)} label`)
        .setDesc(`Default: ${DEFAULT_COLOR_LABELS[color]}`)
        .addText((text) => {
          text
            .setPlaceholder(DEFAULT_COLOR_LABELS[color])
            .setValue(this.plugin.settings.colorLabels[color] ?? DEFAULT_COLOR_LABELS[color])
            .onChange(async (value) => {
              this.plugin.settings.colorLabels[color] = value.trim() || DEFAULT_COLOR_LABELS[color];
              await this.plugin.saveSettings();
            });
        });
    }

    new Setting(containerEl)
      .setName("Reset labels")
      .setDesc("Restore the default labels: 亮点、提醒、补充、灵感、想法、原则.")
      .addButton((button) => {
        button
          .setButtonText("Reset")
          .onClick(async () => {
            this.plugin.settings.colorLabels = { ...DEFAULT_COLOR_LABELS };
            await this.plugin.saveSettings();
            this.display();
          });
      });
  }
}

class AnnotationSidebarView extends ItemView {
  private annotationScope: AnnotationScope = "current";
  private query = "";
  private statusFilter: AnnotationStatus | "all" = "all";
  private colorFilter: AnnotationColor | "all" = "all";
  private sort: AnnotationSort = "newest";
  private selectedIds = new Set<string>();
  private editingId: string | null = null;
  private editingNote = "";
  private editingColor: AnnotationColor = DEFAULT_COLOR;

  constructor(leaf: WorkspaceLeaf, private readonly plugin: BeraAnnotationPlugin) {
    super(leaf);
  }

  getViewType() {
    return VIEW_TYPE_ANNOTATION_SIDEBAR;
  }

  getDisplayText() {
    return this.annotationScope === "all" ? "Annotation Inbox" : "Annotations";
  }

  getIcon() {
    return "highlighter";
  }

  async onOpen() {
    await this.render();
  }

  setScope(scope: AnnotationScope) {
    if (this.annotationScope !== scope) {
      this.annotationScope = scope;
      this.selectedIds.clear();
    }
  }

  async render() {
    const { file, annotations: currentAnnotations } = await this.plugin.getCurrentFileAnnotations();
    const sourceAnnotations =
      this.annotationScope === "all" ? await this.plugin.loadAllAnnotations() : currentAnnotations;
    const annotations = filterAnnotations(sourceAnnotations, {
      query: this.query,
      status: this.statusFilter,
      color: this.colorFilter,
      sort: this.sort
    });

    this.selectedIds = new Set(
      Array.from(this.selectedIds).filter((id) =>
        annotations.some((annotation) => annotation.id === id)
      )
    );

    const container = this.containerEl;
    container.empty();
    container.addClass("bera-annotation-sidebar");

    const header = container.createDiv({ cls: "bera-annotation-sidebar__header" });
    header.createDiv({
      cls: "bera-annotation-sidebar__title",
      text: this.annotationScope === "all" ? "Annotation Inbox" : "Annotations"
    });
    const refreshButton = header.createEl("button", { text: "Refresh" });
    refreshButton.addEventListener("click", () => {
      void this.plugin.refreshActiveFile();
    });

    this.renderFilters(container);

    container.createDiv({
      cls: "bera-annotation-sidebar__file",
      text:
        this.annotationScope === "all"
          ? "All vault annotations"
          : file
            ? file.path
            : "Open a Markdown file to see annotations."
    });

    if (this.annotationScope === "current" && !file) {
      container.createDiv({
        cls: "bera-annotation-empty",
        text: "No active Markdown file."
      });
      return;
    }

    this.renderExportActions(container, file, annotations);

    const list = container.createDiv({ cls: "bera-annotation-sidebar__list" });
    if (annotations.length === 0) {
      list.createDiv({
        cls: "bera-annotation-empty",
        text:
          this.annotationScope === "all"
            ? "No annotations match the current filters."
            : "No annotations for this file yet. Select text, then run Create annotation from selection."
      });
      return;
    }

    for (const annotation of annotations) {
      this.renderAnnotationCard(list, annotation, this.annotationScope === "all");
    }
  }

  private renderFilters(container: HTMLElement) {
    const filters = container.createDiv({ cls: "bera-annotation-filters" });

    const scopeSelect = filters.createEl("select");
    addSelectOption(scopeSelect, "current", "Current file");
    addSelectOption(scopeSelect, "all", "All vault");
    scopeSelect.value = this.annotationScope;
    scopeSelect.addEventListener("change", () => {
      this.setScope(scopeSelect.value as AnnotationScope);
      void this.render();
    });

    const searchInput = filters.createEl("input", {
      attr: {
        type: "search",
        placeholder: "Search text, note, file"
      }
    });
    searchInput.value = this.query;
    searchInput.addEventListener("input", () => {
      this.query = searchInput.value;
      void this.render();
    });

    const statusSelect = filters.createEl("select");
    addSelectOption(statusSelect, "all", "All statuses");
    for (const status of STATUS_OPTIONS) {
      addSelectOption(statusSelect, status, STATUS_LABELS[status]);
    }
    statusSelect.value = this.statusFilter;
    statusSelect.addEventListener("change", () => {
      this.statusFilter = statusSelect.value as AnnotationStatus | "all";
      void this.render();
    });

    const colorSelect = filters.createEl("select");
    addSelectOption(colorSelect, "all", "All colors");
    for (const color of COLOR_OPTIONS) {
      addSelectOption(colorSelect, color, this.plugin.getColorLabel(color));
    }
    colorSelect.value = this.colorFilter;
    colorSelect.addEventListener("change", () => {
      this.colorFilter = colorSelect.value as AnnotationColor | "all";
      void this.render();
    });

    const sortSelect = filters.createEl("select");
    addSelectOption(sortSelect, "newest", "Newest");
    addSelectOption(sortSelect, "oldest", "Oldest");
    addSelectOption(sortSelect, "file", "File");
    sortSelect.value = this.sort;
    sortSelect.addEventListener("change", () => {
      this.sort = sortSelect.value as AnnotationSort;
      void this.render();
    });
  }

  private renderExportActions(
    container: HTMLElement,
    file: TFile | null,
    annotations: BeraAnnotation[]
  ) {
    const actions = container.createDiv({ cls: "bera-annotation-toolbar" });
    actions.createDiv({
      cls: "bera-annotation-toolbar__summary",
      text: `${annotations.length} shown · ${this.selectedIds.size} selected`
    });

    const exportFilteredButton = actions.createEl("button", { text: "Export filtered" });
    exportFilteredButton.disabled = annotations.length === 0;
    exportFilteredButton.addEventListener("click", () => {
      void this.plugin.exportAnnotationsReviewPack(
        this.annotationScope === "all" ? "Filtered annotation inbox" : file?.path ?? "Current file",
        annotations
      );
    });

    const exportSelectedButton = actions.createEl("button", { text: "Export selected" });
    exportSelectedButton.disabled = this.selectedIds.size === 0;
    exportSelectedButton.addEventListener("click", () => {
      const selected = annotations.filter((annotation) => this.selectedIds.has(annotation.id));
      void this.plugin.exportAnnotationsReviewPack(
        this.annotationScope === "all" ? "Selected annotation inbox" : file?.path ?? "Selected annotations",
        selected
      );
    });
  }

  private renderAnnotationCard(list: HTMLElement, annotation: BeraAnnotation, showFile: boolean) {
    const card = list.createDiv({ cls: "bera-annotation-card" });
    card.dataset.color = annotation.color;
    card.toggleClass("is-editing", this.editingId === annotation.id);

    const top = card.createDiv({ cls: "bera-annotation-card__top" });
    const checkbox = top.createEl("input", {
      attr: {
        type: "checkbox"
      }
    });
    checkbox.checked = this.selectedIds.has(annotation.id);
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) {
        this.selectedIds.add(annotation.id);
      } else {
        this.selectedIds.delete(annotation.id);
      }
      void this.render();
    });

    const body = top.createDiv({ cls: "bera-annotation-card__body" });
    const stickyHeader = body.createDiv({ cls: "bera-annotation-card__sticky-header" });
    stickyHeader.createSpan({ cls: "bera-annotation-card__dot" });
    stickyHeader.createSpan({
      cls: "bera-annotation-card__label",
      text: this.plugin.getColorLabel(annotation.color)
    });
    stickyHeader.createSpan({
      cls: "bera-annotation-card__time",
      text: formatDisplayDate(annotation.createdAt)
    });

    body.createDiv({
      cls: "bera-annotation-card__text",
      text: annotation.selectedText
    });

    if (showFile) {
      body.createDiv({
        cls: "bera-annotation-card__file",
        text: annotation.filePath
      });
    }

    const isEditing = this.editingId === annotation.id;
    if (isEditing) {
      const editor = body.createDiv({ cls: "bera-annotation-inline-editor" });
      renderColorSwatches(editor, this.editingColor, (color) => {
        this.editingColor = color;
      }, this.plugin);

      const textarea = editor.createEl("textarea", {
        attr: {
          placeholder: "Write a sticky note..."
        }
      });
      textarea.value = this.editingNote;
      textarea.addEventListener("input", () => {
        this.editingNote = textarea.value;
      });
    } else {
      body.createDiv({
        cls: "bera-annotation-card__note",
        text: annotation.note || "No note yet."
      });
    }

    body.createDiv({
      cls: "bera-annotation-card__meta",
      text: STATUS_LABELS[annotation.status]
    });

    const controls = card.createDiv({ cls: "bera-annotation-card__actions" });

    const statusSelect = controls.createEl("select");
    for (const status of STATUS_OPTIONS) {
      statusSelect.createEl("option", {
        text: STATUS_LABELS[status],
        value: status
      });
    }
    statusSelect.value = annotation.status;
    statusSelect.addEventListener("change", () => {
      void this.plugin.updateAnnotation(annotation.filePath, {
        ...annotation,
        status: statusSelect.value as AnnotationStatus
      });
    });

    if (isEditing) {
      const saveButton = createIconButton(controls, "check", "Save sticky note");
      saveButton.addEventListener("click", async () => {
        await this.plugin.updateAnnotation(annotation.filePath, {
          ...annotation,
          color: this.editingColor,
          note: this.editingNote.trim()
        });
        this.editingId = null;
        void this.render();
      });

      const cancelButton = createIconButton(controls, "x", "Cancel");
      cancelButton.addEventListener("click", () => {
        this.editingId = null;
        void this.render();
      });
    } else {
      const editButton = createIconButton(controls, "pencil", "Edit sticky note");
      editButton.addEventListener("click", () => {
        this.editingId = annotation.id;
        this.editingNote = annotation.note;
        this.editingColor = annotation.color;
        void this.render();
      });
    }

    const jumpButton = createIconButton(controls, "arrow-up-right", "Jump to source");
    jumpButton.addEventListener("click", () => {
      void this.plugin.jumpToAnnotation(annotation);
    });

    const deleteButton = createIconButton(controls, "trash-2", "Delete annotation");
    deleteButton.addEventListener("click", async () => {
      this.selectedIds.delete(annotation.id);
      await this.plugin.deleteAnnotation(annotation.filePath, annotation.id);
    });
  }
}

class AnnotationFloatingToolbar {
  private readonly el: HTMLDivElement;
  private draft: PendingAnnotationDraft | null = null;
  private notePanelEl: HTMLDivElement | null = null;
  private noteColor: AnnotationColor = DEFAULT_COLOR;
  private keepOpenUntil = 0;
  private isSaving = false;

  private readonly outsidePointerHandler = (event: PointerEvent) => {
    const target = event.target;
    if (target instanceof Node && this.el.contains(target)) {
      return;
    }

    this.hide();
  };

  constructor(private readonly plugin: BeraAnnotationPlugin) {
    this.el = document.createElement("div");
    this.el.className = "bera-annotation-floating-toolbar";
    this.el.setAttribute("aria-label", "Annotation toolbar");
    this.el.addEventListener("pointerdown", (event) => {
      this.keepOpenUntil = Date.now() + 1000;
      if (!(event.target instanceof HTMLTextAreaElement)) {
        event.preventDefault();
      }
      event.stopPropagation();
    });

    document.body.appendChild(this.el);
    document.addEventListener("pointerdown", this.outsidePointerHandler, true);
  }

  destroy() {
    document.removeEventListener("pointerdown", this.outsidePointerHandler, true);
    this.el.remove();
  }

  handleEditorUpdate(editorView: EditorView) {
    if (!editorView.hasFocus) {
      if (!this.notePanelEl && Date.now() > this.keepOpenUntil) {
        this.hide();
      }
      return;
    }

    this.showForEditorView(editorView);
  }

  handleDomSelectionChange(editorView: EditorView) {
    if (!getDomSelectionInsideEditor(editorView)) {
      return;
    }

    this.showForEditorView(editorView);
  }

  showForEditorView(editorView: EditorView, options: { openNote?: boolean } = {}) {
    const file = this.plugin.getActiveMarkdownFile();
    if (!file) {
      this.hide();
      return false;
    }

    const draft = buildDraftFromEditorView(file.path, editorView);
    if (!draft) {
      if (!this.notePanelEl) {
        this.hide();
      }
      return false;
    }

    this.showDraft(draft, options);
    return true;
  }

  showDraft(draft: PendingAnnotationDraft, options: { openNote?: boolean } = {}) {
    this.draft = draft;
    this.noteColor = DEFAULT_COLOR;
    this.isSaving = false;
    this.renderToolbar();
    this.el.addClass("is-visible");
    this.position();

    if (options.openNote) {
      this.openNotePanel();
    }
  }

  hide() {
    this.draft = null;
    this.isSaving = false;
    this.closeNotePanel();
    this.el.removeClass("is-visible");
  }

  private renderToolbar() {
    this.el.empty();
    this.notePanelEl = null;
    this.el.createDiv({
      cls: "bera-annotation-floating-toolbar__handle",
      attr: {
        "aria-hidden": "true"
      }
    });

    renderColorSwatches(this.el, this.noteColor, (color) => {
      this.setColor(color);

      if (this.notePanelEl) {
        return;
      }

      void this.saveDraft(color, "", false, "Could not save highlight.");
    }, this.plugin, "highlight");

    const divider = this.el.createDiv({ cls: "bera-annotation-floating-toolbar__divider" });
    divider.setAttribute("aria-hidden", "true");

    const noteButton = createIconButton(this.el, "message-square-plus", "Highlight with sticky note");
    noteButton.addClass("bera-annotation-floating-toolbar__note-button");
    bindReliableActivation(noteButton, () => {
      this.openNotePanel();
    });

    const closeButton = createIconButton(this.el, "x", "Close annotation toolbar");
    closeButton.addClass("bera-annotation-floating-toolbar__close-button");
    bindReliableActivation(closeButton, () => {
      this.hide();
    });
  }

  private openNotePanel() {
    if (!this.draft) {
      return;
    }

    this.closeNotePanel();
    this.notePanelEl = this.el.createDiv({ cls: "bera-annotation-note-popover" });
    this.notePanelEl.createDiv({
      cls: "bera-annotation-note-popover__excerpt",
      text: this.draft.selectedText
    });

    renderColorSwatches(this.notePanelEl, this.noteColor, (color) => {
      this.setColor(color);
    }, this.plugin, "note");

    const textarea = this.notePanelEl.createEl("textarea", {
      attr: {
        placeholder: "Write a sticky note..."
      }
    });

    const actions = this.notePanelEl.createDiv({ cls: "bera-annotation-note-popover__actions" });
    const saveButton = createIconButton(actions, "check", "Save sticky note");
    saveButton.addClass("mod-cta");
    bindReliableActivation(saveButton, async () => {
      saveButton.disabled = true;
      saveButton.addClass("is-saving");
      await this.saveDraft(
        this.noteColor,
        textarea.value.trim(),
        true,
        "Could not save annotation."
      );
      saveButton.disabled = false;
      saveButton.removeClass("is-saving");
    });

    const cancelButton = createIconButton(actions, "x", "Cancel sticky note");
    bindReliableActivation(cancelButton, () => {
      this.closeNotePanel();
      this.position();
    });

    window.setTimeout(() => textarea.focus(), 0);
    this.position();
  }

  private setColor(color: AnnotationColor) {
    this.noteColor = color;
    this.syncSwatchSelection();
  }

  private syncSwatchSelection() {
    const buttons = this.el.querySelectorAll<HTMLButtonElement>(".bera-annotation-swatch");
    for (const button of Array.from(buttons)) {
      const isSelected = button.dataset.color === this.noteColor;
      button.toggleClass("is-selected", isSelected);
      button.setAttribute("aria-pressed", isSelected ? "true" : "false");
    }
  }

  private async saveDraft(
    color: AnnotationColor,
    note: string,
    revealSidebar: boolean,
    failureMessage: string
  ) {
    if (!this.draft || this.isSaving) {
      return;
    }

    this.isSaving = true;

    try {
      await this.plugin.createAnnotationFromDraft(this.draft, color, note, { revealSidebar });
      this.hide();
    } catch (error) {
      console.error(failureMessage, error);
      new Notice(failureMessage);
    } finally {
      this.isSaving = false;
    }
  }

  private closeNotePanel() {
    this.notePanelEl?.remove();
    this.notePanelEl = null;
  }

  private position() {
    if (!this.draft) {
      return;
    }

    const width = Math.max(this.el.offsetWidth, this.notePanelEl ? 300 : 260);
    const centerX = (this.draft.rect.left + this.draft.rect.right) / 2;
    const maxLeft = Math.max(12, window.innerWidth - width - 12);
    const left = clamp(centerX - width / 2, 12, maxLeft);
    const top = clamp(this.draft.rect.top - this.el.offsetHeight - 12, 8, window.innerHeight - 80);

    this.el.style.left = `${left}px`;
    this.el.style.top = `${top}px`;
  }
}

function buildDraftFromEditorView(
  filePath: string,
  editorView: EditorView
): PendingAnnotationDraft | null {
  const domDraft = buildDraftFromDomSelection(filePath, editorView);
  if (domDraft) {
    return domDraft;
  }

  const selection = editorView.state.selection.main;
  if (!selection.empty) {
    return buildDraftFromOffsets(
      filePath,
      editorView,
      Math.min(selection.from, selection.to),
      Math.max(selection.from, selection.to)
    );
  }

  return null;
}

function buildDraftFromDomSelection(
  filePath: string,
  editorView: EditorView
): PendingAnnotationDraft | null {
  const selection = getDomSelectionInsideEditor(editorView);
  if (!selection) {
    return null;
  }

  const selectedText = normalizeSelectionText(selection.toString());
  if (!selectedText) {
    return null;
  }

  const selectionRect = getDomSelectionRect(selection);
  const domRange = getDomSelectionDocumentRange(editorView, selection);
  const docText = editorView.state.doc.toString();
  if (domRange) {
    const sourceText = editorView.state.doc.sliceString(domRange.from, domRange.to);
    if (sourceRangeMatchesSelectedText(sourceText, selectedText)) {
      return buildDraftFromOffsets(
        filePath,
        editorView,
        domRange.from,
        domRange.to,
        selectionRect,
        selectedText
      );
    }

    const correctedRange = findSelectedTextRange(docText, selectedText, domRange);
    if (correctedRange) {
      return buildDraftFromOffsets(
        filePath,
        editorView,
        correctedRange.from,
        correctedRange.to,
        selectionRect,
        selectedText
      );
    }

    const unanchoredRange = findSelectedTextRange(docText, selectedText);
    if (unanchoredRange) {
      return buildDraftFromOffsets(
        filePath,
        editorView,
        unanchoredRange.from,
        unanchoredRange.to,
        selectionRect,
        selectedText
      );
    }

    return null;
  }

  const fallbackRange = findSelectedTextRange(docText, selectedText);
  if (!fallbackRange) {
    return null;
  }

  return buildDraftFromOffsets(
    filePath,
    editorView,
    fallbackRange.from,
    fallbackRange.to,
    selectionRect,
    selectedText
  );
}

function buildDraftFromOffsets(
  filePath: string,
  editorView: EditorView,
  rawFrom: number,
  rawTo: number,
  rectOverride: PendingAnnotationDraft["rect"] | null = null,
  selectedTextOverride: string | null = null
): PendingAnnotationDraft | null {
  const docLength = editorView.state.doc.length;
  const from = clamp(Math.min(rawFrom, rawTo), 0, docLength);
  const to = clamp(Math.max(rawFrom, rawTo), 0, docLength);

  if (from === to) {
    return null;
  }

  const sourceSelectedText = editorView.state.doc.sliceString(from, to);
  const selectedText = selectedTextOverride
    ? normalizeSelectionText(selectedTextOverride)
    : sourceSelectedText;
  if (!selectedText.trim()) {
    return null;
  }

  const fromLine = editorView.state.doc.lineAt(from);
  const toLine = editorView.state.doc.lineAt(to);
  const fromCh = from - fromLine.from;
  const toCh = to - toLine.from;
  const fromCoords = editorView.coordsAtPos(from);
  const toCoords = editorView.coordsAtPos(to);
  const editorRect = editorView.dom.getBoundingClientRect();
  const rect = rectOverride ?? {
    top: Math.min(fromCoords?.top ?? editorRect.top, toCoords?.top ?? editorRect.top),
    bottom: Math.max(fromCoords?.bottom ?? editorRect.bottom, toCoords?.bottom ?? editorRect.bottom),
    left: Math.min(fromCoords?.left ?? editorRect.left, toCoords?.left ?? editorRect.left),
    right: Math.max(fromCoords?.right ?? editorRect.left + 240, toCoords?.right ?? editorRect.left + 240)
  };

  return {
    filePath,
    selectedText,
    anchor: {
      line: fromLine.number - 1,
      from: fromCh,
      to: toCh,
      fromLine: fromLine.number - 1,
      fromCh,
      toLine: toLine.number - 1,
      toCh,
      textHash: hashText(selectedText),
      contextBefore: fromLine.text.slice(Math.max(0, fromCh - 80), fromCh),
      contextAfter: toLine.text.slice(toCh, toCh + 80)
    },
    rect
  };
}

function getDomSelectionInsideEditor(editorView: EditorView) {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
    return null;
  }

  const selectedText = selection.toString();
  if (!selectedText.trim()) {
    return null;
  }

  const { anchorNode, focusNode } = selection;
  if (!anchorNode || !focusNode) {
    return null;
  }

  if (!editorView.dom.contains(anchorNode) || !editorView.dom.contains(focusNode)) {
    return null;
  }

  return selection;
}

function getDomSelectionRect(selection: Selection): PendingAnnotationDraft["rect"] | null {
  if (selection.rangeCount === 0) {
    return null;
  }

  try {
    const range = selection.getRangeAt(0);
    const rects = Array.from(range.getClientRects()).filter(
      (rect) => rect.width > 0 && rect.height > 0
    );
    const usableRects = rects.length > 0 ? rects : [range.getBoundingClientRect()].filter(
      (rect) => rect.width > 0 && rect.height > 0
    );

    if (usableRects.length === 0) {
      return null;
    }

    return usableRects.reduce(
      (acc, rect) => ({
        top: Math.min(acc.top, rect.top),
        bottom: Math.max(acc.bottom, rect.bottom),
        left: Math.min(acc.left, rect.left),
        right: Math.max(acc.right, rect.right)
      }),
      {
        top: usableRects[0].top,
        bottom: usableRects[0].bottom,
        left: usableRects[0].left,
        right: usableRects[0].right
      }
    );
  } catch (error) {
    return null;
  }
}

function getDomSelectionDocumentRange(editorView: EditorView, selection: Selection) {
  const { anchorNode, focusNode } = selection;
  if (!anchorNode || !focusNode) {
    return null;
  }

  try {
    const anchor = editorView.posAtDOM(anchorNode, selection.anchorOffset);
    const focus = editorView.posAtDOM(focusNode, selection.focusOffset);
    if (anchor === focus) {
      return null;
    }

    return {
      from: Math.min(anchor, focus),
      to: Math.max(anchor, focus)
    };
  } catch (error) {
    return null;
  }
}

interface DocumentTextRange {
  from: number;
  to: number;
}

function findSelectedTextRange(
  docText: string,
  selectedText: string,
  preferredRange: DocumentTextRange | null = null
) {
  const directNeedle = selectedText.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const directRanges = findDirectTextRanges(docText, directNeedle);
  const directRange = pickBestTextRange(directRanges, preferredRange);
  if (directRange) {
    return directRange;
  }

  const normalizedDoc = normalizeTextForLooseSearch(docText);
  const normalizedNeedle = normalizeTextForLooseSearch(selectedText).text;
  if (!normalizedNeedle) {
    return null;
  }

  const looseRanges = findNormalizedTextRanges(normalizedDoc, normalizedNeedle);
  const looseRange = pickBestTextRange(looseRanges, preferredRange);
  if (looseRange) {
    return looseRange;
  }

  const compactDoc = normalizeTextForCompactSearch(docText);
  const compactNeedle = normalizeTextForCompactSearch(selectedText).text;
  if (compactNeedle) {
    const compactRange = pickBestTextRange(
      findNormalizedTextRanges(compactDoc, compactNeedle),
      preferredRange
    );
    if (compactRange) {
      return compactRange;
    }

    const compactSubsequenceRange = pickBestTextRange(
      findCompactSubsequenceTextRanges(compactDoc, compactNeedle),
      preferredRange
    );
    if (compactSubsequenceRange) {
      return compactSubsequenceRange;
    }
  }

  return (
    findAnchoredTextRange(normalizedDoc, normalizedNeedle, preferredRange) ??
    (compactNeedle
      ? findAnchoredTextRange(compactDoc, compactNeedle, preferredRange)
      : null)
  );
}

function findDirectTextRanges(docText: string, needle: string) {
  const ranges: DocumentTextRange[] = [];
  if (!needle) {
    return ranges;
  }

  let index = docText.indexOf(needle);
  while (index >= 0) {
    ranges.push({
      from: index,
      to: index + needle.length
    });
    index = docText.indexOf(needle, index + Math.max(1, needle.length));
  }

  return ranges;
}

function findNormalizedTextRanges(
  normalizedDoc: { text: string; map: number[] },
  normalizedNeedle: string
) {
  const ranges: DocumentTextRange[] = [];
  let normalizedIndex = normalizedDoc.text.indexOf(normalizedNeedle);
  while (normalizedIndex >= 0) {
    const lastIndex = normalizedIndex + normalizedNeedle.length - 1;
    const from = normalizedDoc.map[normalizedIndex];
    const to = normalizedDoc.map[lastIndex] + 1;
    if (Number.isFinite(from) && Number.isFinite(to) && from < to) {
      ranges.push({ from, to });
    }
    normalizedIndex = normalizedDoc.text.indexOf(
      normalizedNeedle,
      normalizedIndex + Math.max(1, normalizedNeedle.length)
    );
  }

  return ranges;
}

function findCompactSubsequenceTextRanges(
  compactDoc: { text: string; map: number[] },
  compactNeedle: string
) {
  const ranges: DocumentTextRange[] = [];
  if (!compactNeedle) {
    return ranges;
  }

  const prefixLength = Math.min(8, compactNeedle.length);
  const prefix = compactNeedle.slice(0, prefixLength);
  const maxSpan = compactNeedle.length * 2 + 200;
  const starts = new Set(findAllTextIndexes(compactDoc.text, prefix));

  if (starts.size === 0) {
    for (const start of findAllTextIndexes(compactDoc.text, compactNeedle[0])) {
      starts.add(start);
    }
  }

  const seenRanges = new Set<string>();
  for (const start of starts) {
    let docCursor = start;
    let needleCursor = 0;

    while (docCursor < compactDoc.text.length && needleCursor < compactNeedle.length) {
      if (compactDoc.text[docCursor] === compactNeedle[needleCursor]) {
        needleCursor += 1;
      }
      docCursor += 1;

      if (docCursor - start > maxSpan) {
        break;
      }
    }

    if (needleCursor !== compactNeedle.length) {
      continue;
    }

    const lastDocIndex = docCursor - 1;
    const from = compactDoc.map[start];
    const to = compactDoc.map[lastDocIndex] + 1;
    if (Number.isFinite(from) && Number.isFinite(to) && from < to) {
      const key = `${from}:${to}`;
      if (seenRanges.has(key)) {
        continue;
      }

      seenRanges.add(key);
      ranges.push({ from, to });
    }
  }

  return ranges;
}

function pickBestTextRange(
  ranges: DocumentTextRange[],
  preferredRange: DocumentTextRange | null
) {
  if (ranges.length === 0) {
    return null;
  }

  if (!preferredRange) {
    return ranges[0];
  }

  const preferredCenter = (preferredRange.from + preferredRange.to) / 2;
  return ranges
    .slice()
    .sort((a, b) => {
      const aInside = a.from >= preferredRange.from && a.to <= preferredRange.to;
      const bInside = b.from >= preferredRange.from && b.to <= preferredRange.to;
      if (aInside !== bInside) {
        return aInside ? -1 : 1;
      }

      const aCenter = (a.from + a.to) / 2;
      const bCenter = (b.from + b.to) / 2;
      return Math.abs(aCenter - preferredCenter) - Math.abs(bCenter - preferredCenter);
    })[0];
}

function findAnchoredTextRange(
  normalizedDoc: { text: string; map: number[] },
  normalizedNeedle: string,
  preferredRange: DocumentTextRange | null
) {
  const fragmentLength = Math.min(32, Math.max(8, Math.floor(normalizedNeedle.length / 4)));
  if (normalizedNeedle.length < fragmentLength * 2) {
    return null;
  }

  const prefix = normalizedNeedle.slice(0, fragmentLength);
  const suffix = normalizedNeedle.slice(normalizedNeedle.length - fragmentLength);
  const prefixIndexes = findAllTextIndexes(normalizedDoc.text, prefix);
  const suffixIndexes = findAllTextIndexes(normalizedDoc.text, suffix);
  const candidates: Array<DocumentTextRange & { normalizedLength: number }> = [];
  const maxNormalizedLength = normalizedNeedle.length * 2 + 200;

  for (const prefixIndex of prefixIndexes) {
    for (const suffixIndex of suffixIndexes) {
      if (suffixIndex < prefixIndex + fragmentLength) {
        continue;
      }

      const normalizedLength = suffixIndex + fragmentLength - prefixIndex;
      if (normalizedLength > maxNormalizedLength) {
        continue;
      }

      const from = normalizedDoc.map[prefixIndex];
      const to = normalizedDoc.map[suffixIndex + fragmentLength - 1] + 1;
      if (Number.isFinite(from) && Number.isFinite(to) && from < to) {
        candidates.push({ from, to, normalizedLength });
      }
    }
  }

  return pickBestAnchoredRange(candidates, normalizedNeedle.length, preferredRange);
}

function findAllTextIndexes(text: string, needle: string) {
  const indexes: number[] = [];
  if (!needle) {
    return indexes;
  }

  let index = text.indexOf(needle);
  while (index >= 0) {
    indexes.push(index);
    index = text.indexOf(needle, index + 1);
  }

  return indexes;
}

function pickBestAnchoredRange(
  ranges: Array<DocumentTextRange & { normalizedLength: number }>,
  expectedNormalizedLength: number,
  preferredRange: DocumentTextRange | null
) {
  if (ranges.length === 0) {
    return null;
  }

  const preferredCenter = preferredRange ? (preferredRange.from + preferredRange.to) / 2 : null;
  const best = ranges
    .slice()
    .sort((a, b) => {
      const aInside = preferredRange
        ? a.from >= preferredRange.from && a.to <= preferredRange.to
        : false;
      const bInside = preferredRange
        ? b.from >= preferredRange.from && b.to <= preferredRange.to
        : false;
      if (aInside !== bInside) {
        return aInside ? -1 : 1;
      }

      const lengthScore =
        Math.abs(a.normalizedLength - expectedNormalizedLength) -
        Math.abs(b.normalizedLength - expectedNormalizedLength);
      if (lengthScore !== 0) {
        return lengthScore;
      }

      if (preferredCenter !== null) {
        const aCenter = (a.from + a.to) / 2;
        const bCenter = (b.from + b.to) / 2;
        return Math.abs(aCenter - preferredCenter) - Math.abs(bCenter - preferredCenter);
      }

      return a.from - b.from;
    })[0];

  return {
    from: best.from,
    to: best.to
  };
}

function normalizeSelectionText(input: string) {
  return input.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
}

function sourceRangeMatchesSelectedText(sourceText: string, selectedText: string) {
  if (sourceText === selectedText) {
    return true;
  }

  const normalizedSource = normalizeTextForLooseSearch(sourceText).text;
  const normalizedSelected = normalizeTextForLooseSearch(selectedText).text;
  if (normalizedSource === normalizedSelected) {
    return true;
  }

  return (
    normalizeTextForCompactSearch(sourceText).text ===
    normalizeTextForCompactSearch(selectedText).text
  );
}

function normalizeTextForLooseSearch(input: string) {
  const chars: string[] = [];
  const map: number[] = [];
  let atLineStart = true;
  let pendingSpaceIndex: number | null = null;

  const emitSpace = (index: number) => {
    if (chars.length === 0 || chars[chars.length - 1] === " ") {
      return;
    }

    pendingSpaceIndex = index;
  };

  const flushSpace = () => {
    if (pendingSpaceIndex === null) {
      return;
    }

    chars.push(" ");
    map.push(pendingSpaceIndex);
    pendingSpaceIndex = null;
  };

  for (let index = 0; index < input.length; index += 1) {
    let char = input[index];

    const htmlSpaceEntityLength = getHtmlSpaceEntityLength(input, index);
    if (htmlSpaceEntityLength > 0) {
      emitSpace(index);
      index += htmlSpaceEntityLength - 1;
      atLineStart = false;
      continue;
    }

    if (char === "\r") {
      continue;
    }

    if (char === "\n") {
      emitSpace(index);
      atLineStart = true;
      continue;
    }

    if (atLineStart) {
      while (char === " " || char === "\t") {
        index += 1;
        char = input[index];
      }

      while (char === ">") {
        index += 1;
        char = input[index];
        while (char === " " || char === "\t") {
          index += 1;
          char = input[index];
        }
      }

      const headingMarkerEnd = getMarkdownHeadingMarkerEnd(input, index);
      if (headingMarkerEnd !== null) {
        index = headingMarkerEnd;
        char = input[index];
        while (char === " " || char === "\t") {
          index += 1;
          char = input[index];
        }
      } else if (isMarkdownListMarker(input, index)) {
        index += 1;
        char = input[index];
        while (char === " " || char === "\t") {
          index += 1;
          char = input[index];
        }
      } else {
        const orderedMarkerEnd = getOrderedListMarkerEnd(input, index);
        if (orderedMarkerEnd !== null) {
          index = orderedMarkerEnd;
          char = input[index];
          while (char === " " || char === "\t") {
            index += 1;
            char = input[index];
          }
        }
      }

      atLineStart = false;
    }

    if (!char) {
      continue;
    }

    if (char === "\r") {
      continue;
    }

    if (char === "\n") {
      emitSpace(index);
      atLineStart = true;
      continue;
    }

    if (char === "*" || char === "`" || char === "_" || char === "~") {
      continue;
    }

    if (/\s/.test(char)) {
      emitSpace(index);
      continue;
    }

    const normalizedChar = normalizeSearchChar(char);
    if (!normalizedChar) {
      continue;
    }

    flushSpace();
    for (const outputChar of normalizedChar) {
      chars.push(outputChar);
      map.push(index);
    }
  }

  return {
    text: chars.join("").trim(),
    map
  };
}

function normalizeTextForCompactSearch(input: string) {
  const normalized = normalizeTextForLooseSearch(input);
  const chars: string[] = [];
  const map: number[] = [];

  for (let index = 0; index < normalized.text.length; index += 1) {
    if (/\s/.test(normalized.text[index])) {
      continue;
    }

    chars.push(normalized.text[index]);
    map.push(normalized.map[index]);
  }

  return {
    text: chars.join(""),
    map
  };
}

function normalizeSearchChar(char: string) {
  if (/[\u200B-\u200D\uFEFF]/.test(char)) {
    return "";
  }

  if (/[|｜丨∣│¦]/.test(char)) {
    return "|";
  }

  const normalized = char.normalize("NFKC");
  return normalized.length > 0 ? normalized : char;
}

function getHtmlSpaceEntityLength(input: string, index: number) {
  const rest = input.slice(index, index + 8).toLowerCase();
  for (const entity of ["&nbsp;", "&ensp;", "&emsp;", "&thinsp;"]) {
    if (rest.startsWith(entity)) {
      return entity.length;
    }
  }

  return 0;
}

function isMarkdownListMarker(input: string, index: number) {
  const char = input[index];
  return (
    (char === "-" || char === "+" || char === "*") &&
    /\s/.test(input[index + 1] ?? "")
  );
}

function getMarkdownHeadingMarkerEnd(input: string, index: number) {
  let cursor = index;
  while (input[cursor] === "#" && cursor - index < 6) {
    cursor += 1;
  }

  if (cursor === index || (input[cursor] !== " " && input[cursor] !== "\t")) {
    return null;
  }

  return cursor;
}

function getOrderedListMarkerEnd(input: string, index: number) {
  let cursor = index;
  while (/\d/.test(input[cursor] ?? "")) {
    cursor += 1;
  }

  if (cursor === index || input[cursor] !== ".") {
    return null;
  }

  return /\s/.test(input[cursor + 1] ?? "") ? cursor + 1 : null;
}

function renderColorSwatches(
  container: HTMLElement,
  selectedColor: AnnotationColor,
  onPick: (color: AnnotationColor) => void,
  plugin: BeraAnnotationPlugin,
  variant = "default"
) {
  const wrap = container.createDiv({
    cls: `bera-annotation-color-swatches bera-annotation-color-swatches--${variant}`
  });
  const buttons: HTMLButtonElement[] = [];

  for (const color of COLOR_OPTIONS) {
    const button = wrap.createEl("button", {
      cls: `bera-annotation-swatch bera-annotation-swatch--${color}`,
      attr: {
        type: "button",
        title: `${plugin.getColorLabel(color)} color`,
        "aria-label": `${plugin.getColorLabel(color)} color`
      }
    });
    button.dataset.color = color;
    button.style.setProperty("background-color", SWATCH_COLORS[color], "important");
    button.style.setProperty("background-image", "none", "important");
    button.toggleClass("is-selected", color === selectedColor);
    bindReliableActivation(button, () => {
      for (const item of buttons) {
        item.removeClass("is-selected");
        item.setAttribute("aria-pressed", "false");
      }
      button.addClass("is-selected");
      button.setAttribute("aria-pressed", "true");
      onPick(color);
    });
    button.setAttribute("aria-pressed", color === selectedColor ? "true" : "false");
    buttons.push(button);
  }

  return wrap;
}

function bindReliableActivation(
  element: HTMLElement,
  handler: (event: MouseEvent | PointerEvent) => void | Promise<void>
) {
  let lastPointerActivation = 0;

  const activate = (event: MouseEvent | PointerEvent) => {
    if ("button" in event && event.button !== 0) {
      return;
    }

    if (element instanceof HTMLButtonElement && element.disabled) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    const now = Date.now();
    if (event.type === "click" && now - lastPointerActivation < 500) {
      return;
    }

    if (event.type === "pointerup") {
      lastPointerActivation = now;
    }

    void handler(event);
  };

  element.addEventListener("pointerup", activate);
  element.addEventListener("click", activate);
}

function createIconButton(container: HTMLElement, icon: string, label: string) {
  const button = container.createEl("button", {
    cls: "bera-annotation-icon-button",
    attr: {
      type: "button",
      title: label,
      "aria-label": label
    }
  });
  setIcon(button, icon);
  return button;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

interface HighlightRegistryLike {
  set(name: string, highlight: unknown): void;
  delete(name: string): boolean;
}

type HighlightConstructor = new (...ranges: Range[]) => unknown;

interface DomTextPosition {
  node: Text;
  offset: number;
}

interface RenderedTextNodeInfo {
  block: Element | null;
  rect: DOMRect | null;
}

interface RenderedRangeCandidate {
  ranges: Range[];
  rect: DOMRect;
}

interface RenderedHighlightTarget {
  root: HTMLElement;
  editorView: EditorView | null;
}

function getHighlightApi() {
  if (typeof CSS === "undefined") {
    return null;
  }

  const registry = (CSS as typeof CSS & { highlights?: HighlightRegistryLike }).highlights;
  const HighlightCtor = (window as typeof window & { Highlight?: HighlightConstructor }).Highlight;
  if (!registry || !HighlightCtor) {
    return null;
  }

  return { registry, HighlightCtor };
}

function getRenderedHighlightName(color: AnnotationColor) {
  return `bera-annotation-rendered-${color}`;
}

function getAnnotationSourceRect(editorView: EditorView, annotation: BeraAnnotation) {
  const sourceRange = getAnnotationRange(editorView.state.doc, annotation);
  return sourceRange ? getSourceRangeRect(editorView, sourceRange) : null;
}

function getMarkdownPreviewRoots(
  markdownView: MarkdownView | null,
  editorRoot: HTMLElement | null
) {
  const containers = getMarkdownViewContainers(markdownView);
  const candidates: HTMLElement[] = [];

  for (const container of containers) {
    candidates.push(
      ...Array.from(
        container.querySelectorAll<HTMLElement>(".markdown-preview-view, .markdown-rendered")
      )
    );
  }

  if (candidates.length === 0 && isMarkdownViewInPreviewMode(markdownView)) {
    const fallback = containers[0];
    if (fallback) {
      candidates.push(fallback);
    }
  }

  return uniqueTopLevelElements(candidates).filter((root) => {
    if (!editorRoot) {
      return true;
    }

    return root !== editorRoot && !root.contains(editorRoot) && !editorRoot.contains(root);
  });
}

function getMarkdownViewContainers(markdownView: MarkdownView | null) {
  if (!markdownView) {
    return [];
  }

  const maybeView = markdownView as unknown as {
    contentEl?: HTMLElement;
    containerEl?: HTMLElement;
    previewMode?: { containerEl?: HTMLElement };
  };
  const containers = [
    maybeView.previewMode?.containerEl,
    maybeView.contentEl,
    maybeView.containerEl
  ].filter((element): element is HTMLElement => Boolean(element));

  return uniqueTopLevelElements(containers);
}

function isMarkdownViewInPreviewMode(markdownView: MarkdownView | null) {
  const maybeMode = (markdownView as unknown as { getMode?: () => string } | null)?.getMode;
  try {
    return typeof maybeMode === "function" && maybeMode.call(markdownView) === "preview";
  } catch (error) {
    return false;
  }
}

function uniqueTopLevelElements(elements: HTMLElement[]) {
  const unique = Array.from(new Set(elements)).filter((element) => element.isConnected);
  return unique.filter(
    (element) => !unique.some((other) => other !== element && other.contains(element))
  );
}

function findRenderedAnnotationRanges(
  root: HTMLElement,
  annotation: BeraAnnotation,
  sourceRect: DOMRect | null
): Range[] {
  const normalizedNeedle = normalizeTextForLooseSearch(annotation.selectedText).text;
  if (!normalizedNeedle) {
    return [];
  }

  const renderedText = collectVisibleDomText(root);
  const matches = getRenderedTextMatches(renderedText, annotation.selectedText, normalizedNeedle);
  if (matches.length === 0) {
    return [];
  }

  const candidates: RenderedRangeCandidate[] = [];

  for (const match of matches) {
    const start = match.map[match.index];
    const end = match.map[match.index + match.length - 1];
    if (!start || !end) {
      continue;
    }

    const ranges = createRenderedMatchRanges(
      match.map,
      match.index,
      match.length
    );
    const rect = mergeRangeRects(ranges);
    if (!rect) {
      continue;
    }

    candidates.push({ ranges, rect });
  }

  return pickBestRenderedRange(candidates, sourceRect)?.ranges ?? [];
}

function getRenderedTextMatches(
  renderedText: { text: string; map: DomTextPosition[] },
  selectedText: string,
  normalizedNeedle: string
) {
  const directIndexes = findAllTextIndexes(renderedText.text, normalizedNeedle);
  if (directIndexes.length > 0) {
    return directIndexes.map((index) => ({
      map: renderedText.map,
      index,
      length: normalizedNeedle.length
    }));
  }

  const compactRenderedText = compactRenderedTextMap(renderedText);
  const compactNeedle = normalizeTextForCompactSearch(selectedText).text;
  if (!compactNeedle) {
    return [];
  }

  return findAllTextIndexes(compactRenderedText.text, compactNeedle).map((index) => ({
    map: compactRenderedText.map,
    index,
    length: compactNeedle.length
  }));
}

function compactRenderedTextMap(renderedText: { text: string; map: DomTextPosition[] }) {
  const chars: string[] = [];
  const map: DomTextPosition[] = [];

  for (let index = 0; index < renderedText.text.length; index += 1) {
    if (/\s/.test(renderedText.text[index])) {
      continue;
    }

    chars.push(renderedText.text[index]);
    map.push(renderedText.map[index]);
  }

  return {
    text: chars.join(""),
    map
  };
}

function createRenderedMatchRanges(
  map: DomTextPosition[],
  startIndex: number,
  length: number
) {
  const ranges: Range[] = [];
  let currentNode: Text | null = null;
  let rangeStart = 0;
  let previousOffset = -1;

  const closeRange = () => {
    if (!currentNode || previousOffset < rangeStart) {
      return;
    }

    const range = document.createRange();
    range.setStart(currentNode, rangeStart);
    range.setEnd(currentNode, previousOffset + 1);
    if (getUsableRangeRect(range)) {
      ranges.push(range);
    }
  };

  for (let cursor = startIndex; cursor < startIndex + length; cursor += 1) {
    const position = map[cursor];
    if (!position) {
      continue;
    }

    if (
      currentNode !== position.node ||
      (previousOffset >= 0 && position.offset > previousOffset + 1)
    ) {
      closeRange();
      currentNode = position.node;
      rangeStart = position.offset;
      previousOffset = position.offset;
      continue;
    }

    previousOffset = Math.max(previousOffset, position.offset);
  }

  closeRange();
  return ranges;
}

function collectVisibleDomText(root: HTMLElement) {
  const chars: string[] = [];
  const map: DomTextPosition[] = [];
  let pendingSpace: DomTextPosition | null = null;

  const emitSpace = (position: DomTextPosition) => {
    if (chars.length === 0 || chars[chars.length - 1] === " ") {
      return;
    }

    pendingSpace = position;
  };

  const flushSpace = () => {
    if (!pendingSpace) {
      return;
    }

    chars.push(" ");
    map.push(pendingSpace);
    pendingSpace = null;
  };

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      return shouldUseRenderedTextNode(node as Text, root)
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT;
    }
  });

  let current = walker.nextNode() as Text | null;
  let previousInfo: RenderedTextNodeInfo | null = null;
  while (current) {
    const value = current.data;
    const firstTextOffset = getFirstNonWhitespaceOffset(value);
    if (
      firstTextOffset !== null &&
      shouldInsertRenderedBoundarySpace(previousInfo, current, root)
    ) {
      emitSpace({ node: current, offset: firstTextOffset });
    }

    for (let offset = 0; offset < value.length; offset += 1) {
      const char = value[offset];
      if (char === "\r") {
        continue;
      }

      const position = { node: current, offset };
      if (/\s/.test(char)) {
        emitSpace(position);
        continue;
      }

      const normalizedChar = normalizeSearchChar(char);
      if (!normalizedChar) {
        continue;
      }

      flushSpace();
      for (const outputChar of normalizedChar) {
        chars.push(outputChar);
        map.push(position);
      }
    }

    previousInfo = getRenderedTextNodeInfo(current, root);
    current = walker.nextNode() as Text | null;
  }

  return {
    text: chars.join(""),
    map
  };
}

function getFirstNonWhitespaceOffset(value: string) {
  for (let offset = 0; offset < value.length; offset += 1) {
    if (!/\s/.test(value[offset])) {
      return offset;
    }
  }

  return null;
}

function shouldInsertRenderedBoundarySpace(
  previousInfo: RenderedTextNodeInfo | null,
  current: Text,
  root: HTMLElement
) {
  if (!previousInfo) {
    return false;
  }

  const currentInfo = getRenderedTextNodeInfo(current, root);
  if (previousInfo.block && currentInfo.block && previousInfo.block !== currentInfo.block) {
    return true;
  }

  if (!previousInfo.rect || !currentInfo.rect) {
    return false;
  }

  return currentInfo.rect.top > previousInfo.rect.bottom + 2;
}

function getRenderedTextNodeInfo(node: Text, root: HTMLElement): RenderedTextNodeInfo {
  return {
    block: getRenderedBlockElement(node.parentElement, root),
    rect: getTextNodeRect(node)
  };
}

function getRenderedBlockElement(element: HTMLElement | null, root: HTMLElement) {
  for (let current = element; current && current !== root; current = current.parentElement) {
    const style = window.getComputedStyle(current);
    if (
      style.display === "block" ||
      style.display === "list-item" ||
      style.display === "table" ||
      style.display === "flex" ||
      style.display === "grid"
    ) {
      return current;
    }
  }

  return root;
}

function getTextNodeRect(node: Text) {
  const range = document.createRange();
  range.selectNodeContents(node);
  return getUsableRangeRect(range);
}

function shouldUseRenderedTextNode(node: Text, root: HTMLElement) {
  if (!node.data.trim()) {
    return false;
  }

  const parent = node.parentElement;
  if (!parent || !root.contains(parent)) {
    return false;
  }

  if (
    parent.closest(
      ".bera-annotation-floating-toolbar, .bera-annotation-note-popover, .cm-gutters, .cm-tooltip, .cm-selectionLayer, .cm-cursorLayer"
    )
  ) {
    return false;
  }

  for (let el: HTMLElement | null = parent; el && el !== root.parentElement; el = el.parentElement) {
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
      return false;
    }

    if (el === root) {
      break;
    }
  }

  const range = document.createRange();
  range.selectNodeContents(node);
  const rect = getUsableRangeRect(range);
  return rect !== null;
}

function getUsableRangeRect(range: Range) {
  const rects = Array.from(range.getClientRects()).filter(
    (rect) => rect.width > 0 && rect.height > 0
  );
  if (rects.length > 0) {
    return mergeRects(rects);
  }

  const rect = range.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0 ? rect : null;
}

function mergeRangeRects(ranges: Range[]) {
  const rects = ranges
    .map((range) => getUsableRangeRect(range))
    .filter((rect): rect is DOMRect => rect !== null);

  return rects.length > 0 ? mergeRects(rects) : null;
}

function mergeRects(rects: DOMRect[]) {
  const first = rects[0];
  const box = rects.reduce(
    (acc, rect) => ({
      top: Math.min(acc.top, rect.top),
      bottom: Math.max(acc.bottom, rect.bottom),
      left: Math.min(acc.left, rect.left),
      right: Math.max(acc.right, rect.right)
    }),
    {
      top: first.top,
      bottom: first.bottom,
      left: first.left,
      right: first.right
    }
  );

  return DOMRect.fromRect({
    x: box.left,
    y: box.top,
    width: box.right - box.left,
    height: box.bottom - box.top
  });
}

function getSourceRangeRect(
  editorView: EditorView,
  range: { from: number; to: number }
) {
  const fromCoords = editorView.coordsAtPos(range.from);
  const toCoords = editorView.coordsAtPos(range.to);
  if (!fromCoords && !toCoords) {
    return null;
  }

  const top = Math.min(fromCoords?.top ?? toCoords!.top, toCoords?.top ?? fromCoords!.top);
  const bottom = Math.max(
    fromCoords?.bottom ?? toCoords!.bottom,
    toCoords?.bottom ?? fromCoords!.bottom
  );
  const left = Math.min(fromCoords?.left ?? toCoords!.left, toCoords?.left ?? fromCoords!.left);
  const right = Math.max(
    fromCoords?.right ?? toCoords!.right,
    toCoords?.right ?? fromCoords!.right
  );

  return DOMRect.fromRect({
    x: left,
    y: top,
    width: right - left,
    height: bottom - top
  });
}

function pickBestRenderedRange(
  candidates: RenderedRangeCandidate[],
  sourceRect: DOMRect | null
) {
  if (candidates.length === 0) {
    return null;
  }

  if (!sourceRect) {
    return candidates[0];
  }

  const sourceCenter = getRectCenter(sourceRect);
  return candidates
    .slice()
    .sort((a, b) => {
      const aCenter = getRectCenter(a.rect);
      const bCenter = getRectCenter(b.rect);
      return distanceSquared(aCenter, sourceCenter) - distanceSquared(bCenter, sourceCenter);
    })[0];
}

function getRectCenter(rect: DOMRect) {
  return {
    x: rect.left + rect.width / 2,
    y: rect.top + rect.height / 2
  };
}

function distanceSquared(a: { x: number; y: number }, b: { x: number; y: number }) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

function buildDecorations(doc: EditorView["state"]["doc"], annotations: BeraAnnotation[]) {
  const builder = new RangeSetBuilder<Decoration>();

  const ranges = annotations
    .map((annotation) => {
      const range = getAnnotationRange(doc, annotation);
      return range ? { ...range, annotation } : null;
    })
    .filter((range): range is { from: number; to: number; annotation: BeraAnnotation } => range !== null)
    .sort((a, b) => a.from - b.from || a.to - b.to);

  for (const { from, to, annotation } of ranges) {
    if (from >= to) {
      continue;
    }

    builder.add(
      from,
      to,
      Decoration.mark({
        class: `bera-annotation-highlight bera-annotation-${annotation.color}`,
        attributes: {
          "data-annotation-id": annotation.id,
          title: annotation.note || annotation.selectedText
        }
      })
    );
  }

  return builder.finish();
}

function getAnnotationRange(doc: EditorView["state"]["doc"], annotation: BeraAnnotation) {
  const anchor = annotation.anchor;
  const hasStoredRange =
    anchor.fromLine >= 0 &&
    anchor.toLine >= anchor.fromLine &&
    anchor.toLine < doc.lines;

  if (hasStoredRange) {
    const fromLine = doc.line(anchor.fromLine + 1);
    const toLine = doc.line(anchor.toLine + 1);
    const from = fromLine.from + anchor.fromCh;
    const to = toLine.from + anchor.toCh;
    const selectedAtAnchor = doc.sliceString(from, to);

    if (
      selectedAtAnchor === annotation.selectedText ||
      sourceRangeMatchesSelectedText(selectedAtAnchor, annotation.selectedText)
    ) {
      return { from, to };
    }
  }

  const docText = doc.toString();
  const fallbackIndex = docText.indexOf(annotation.selectedText);
  if (fallbackIndex >= 0) {
    return {
      from: fallbackIndex,
      to: fallbackIndex + annotation.selectedText.length
    };
  }

  const looseFallback = findSelectedTextRange(docText, annotation.selectedText);
  if (looseFallback) {
    return looseFallback;
  }

  return null;
}

function buildReviewPack(sourceLabel: string, annotations: BeraAnnotation[]) {
  const sorted = annotations.slice().sort(sortOldestFirst);
  const lines: string[] = [
    "# 标注回顾包",
    "",
    `> 来源范围：${sourceLabel}`,
    `> 导出时间：${new Date().toISOString()}`,
    `> 标注数量：${sorted.length}`,
    "> 默认请求：先和我讨论这些想法，不要直接写入项目文件。",
    "",
    "## AI 请先判断",
    "",
    "1. 哪些只是临时想法？",
    "2. 哪些值得继续追问？",
    "3. 哪些可能关联到我的阅读、成长、投资研究或工作项目？",
    "4. 你想先问我哪 2-3 个问题？",
    "5. 暂时不要自动沉淀，先和我聊。",
    "",
    "## 原始标注"
  ];

  sorted.forEach((annotation, index) => {
    lines.push(
      "",
      `### ${index + 1}. ${annotation.filePath} / ${formatDisplayDate(annotation.createdAt)}`,
      "",
      "原文：",
      `> ${annotation.selectedText.replace(/\n/g, "\n> ")}`,
      "",
      "我的即时想法：",
      annotation.note ? `> ${annotation.note.replace(/\n/g, "\n> ")}` : "> ",
      "",
      `颜色：${annotation.color}`,
      `状态：${annotation.status}`,
      `原文位置：line ${annotation.anchor.fromLine + 1}, ch ${annotation.anchor.fromCh}`
    );
  });

  lines.push("");
  return lines.join("\n");
}

function filterAnnotations(
  annotations: BeraAnnotation[],
  filters: {
    query: string;
    status: AnnotationStatus | "all";
    color: AnnotationColor | "all";
    sort: AnnotationSort;
  }
) {
  const query = filters.query.trim().toLowerCase();
  const filtered = annotations.filter((annotation) => {
    if (filters.status !== "all" && annotation.status !== filters.status) {
      return false;
    }

    if (filters.color !== "all" && annotation.color !== filters.color) {
      return false;
    }

    if (!query) {
      return true;
    }

    return `${annotation.filePath}\n${annotation.selectedText}\n${annotation.note}`
      .toLowerCase()
      .includes(query);
  });

  if (filters.sort === "oldest") {
    return filtered.sort(sortOldestFirst);
  }

  if (filters.sort === "file") {
    return filtered.sort(
      (a, b) =>
        a.filePath.localeCompare(b.filePath) ||
        a.anchor.fromLine - b.anchor.fromLine ||
        a.createdAt.localeCompare(b.createdAt)
    );
  }

  return filtered.sort(sortNewestFirst);
}

function addSelectOption(select: HTMLSelectElement, value: string, text: string) {
  const option = select.createEl("option", { text });
  option.value = value;
}

function capitalize(value: string) {
  return value.slice(0, 1).toUpperCase() + value.slice(1);
}

function encodePath(filePath: string) {
  const bytes = new TextEncoder().encode(filePath);
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function getAnnotationFileName(filePath: string) {
  const normalized = normalizePath(filePath);
  const encodedPrefix = encodePath(normalized).slice(0, 48);
  return `${hashText(normalized)}-${encodedPrefix}.json`;
}

function createId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function hashText(text: string) {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return (hash >>> 0).toString(16);
}

function formatDateForPath(date: Date) {
  return date.toISOString().replace(/[:.]/g, "-");
}

function formatDisplayDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleString();
}

function sortNewestFirst(a: BeraAnnotation, b: BeraAnnotation) {
  return b.createdAt.localeCompare(a.createdAt);
}

function sortOldestFirst(a: BeraAnnotation, b: BeraAnnotation) {
  return a.createdAt.localeCompare(b.createdAt);
}
