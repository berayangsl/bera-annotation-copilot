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

    this.app.workspace.onLayoutReady(() => {
      void this.refreshActiveFile();
    });
  }

  onunload() {
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
    const file = this.getActiveFile();
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
    const file = this.getActiveFile();
    const editorView = this.getEditorView();
    if (!editorView) {
      await this.refreshSidebar();
      return;
    }

    const annotations = file ? await this.loadAnnotationsForFile(file.path) : [];
    try {
      editorView.dispatch({
        effects: setAnnotationsEffect.of(annotations)
      });
    } catch (error) {
      console.error("Could not refresh annotation decorations", error);
    }

    await this.refreshSidebar();
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

  private getEditorView() {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
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

  const selectionRect = getDomSelectionRect(selection);
  const domRange = getDomSelectionDocumentRange(editorView, selection);
  if (domRange) {
    return buildDraftFromOffsets(filePath, editorView, domRange.from, domRange.to, selectionRect);
  }

  const fallbackRange = findSelectedTextRange(editorView.state.doc.toString(), selection.toString());
  if (!fallbackRange) {
    return null;
  }

  return buildDraftFromOffsets(
    filePath,
    editorView,
    fallbackRange.from,
    fallbackRange.to,
    selectionRect
  );
}

function buildDraftFromOffsets(
  filePath: string,
  editorView: EditorView,
  rawFrom: number,
  rawTo: number,
  rectOverride: PendingAnnotationDraft["rect"] | null = null
): PendingAnnotationDraft | null {
  const docLength = editorView.state.doc.length;
  const from = clamp(Math.min(rawFrom, rawTo), 0, docLength);
  const to = clamp(Math.max(rawFrom, rawTo), 0, docLength);

  if (from === to) {
    return null;
  }

  const selectedText = editorView.state.doc.sliceString(from, to);
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

function findSelectedTextRange(docText: string, selectedText: string) {
  const directNeedle = selectedText.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const directIndex = docText.indexOf(directNeedle);
  if (directIndex >= 0) {
    return {
      from: directIndex,
      to: directIndex + directNeedle.length
    };
  }

  const normalizedDoc = normalizeTextForLooseSearch(docText);
  const normalizedNeedle = normalizeTextForLooseSearch(selectedText).text;
  if (!normalizedNeedle) {
    return null;
  }

  const normalizedIndex = normalizedDoc.text.indexOf(normalizedNeedle);
  if (normalizedIndex < 0) {
    return null;
  }

  const lastIndex = normalizedIndex + normalizedNeedle.length - 1;
  return {
    from: normalizedDoc.map[normalizedIndex],
    to: normalizedDoc.map[lastIndex] + 1
  };
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

      if (isMarkdownListMarker(input, index)) {
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

    if (char === "*" || char === "`") {
      continue;
    }

    if (/\s/.test(char)) {
      emitSpace(index);
      continue;
    }

    flushSpace();
    chars.push(char);
    map.push(index);
  }

  return {
    text: chars.join("").trim(),
    map
  };
}

function isMarkdownListMarker(input: string, index: number) {
  const char = input[index];
  return (char === "-" || char === "+" || char === "*") && /\s/.test(input[index + 1] ?? "");
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

    if (selectedAtAnchor === annotation.selectedText) {
      return { from, to };
    }
  }

  const fallbackIndex = doc.toString().indexOf(annotation.selectedText);
  if (fallbackIndex >= 0) {
    return {
      from: fallbackIndex,
      to: fallbackIndex + annotation.selectedText.length
    };
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
