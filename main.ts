import {
  App,
  ItemView,
  Plugin,
  PluginSettingTab,
  Setting,
  TAbstractFile,
  TFile,
  WorkspaceLeaf,
  moment,
  setIcon,
} from "obsidian";

// ─── Types ────────────────────────────────────────────────────────────────────

type ChangeSource = "all" | "remote" | "local";
type ChangeKind = "modified" | "created";

interface FileEvent {
  path: string;
  kind: ChangeKind;
  source: "local" | "remote";
  ts: number; // epoch ms
}

interface FileWatchSettings {
  trackSource: ChangeSource;
  maxEntries: number;
  showTimestamps: boolean;
  remoteWindowMs: number; // ms after a vault modify with no active window = "remote"
  highlightOnChange: boolean;
  persistHistory: boolean;
  showExplorerDots: boolean;
  localColor: string;
  remoteColor: string;
  dotSize: number;
  localLabel: string;
  remoteLabel: string;
  events: FileEvent[];
}

const DEFAULT_SETTINGS: FileWatchSettings = {
  trackSource: "all",
  maxEntries: 50,
  showTimestamps: true,
  remoteWindowMs: 2000,
  highlightOnChange: true,
  persistHistory: true,
  showExplorerDots: false,
  localColor: "#6494ed",
  remoteColor: "#c35fdc",
  dotSize: 6,
  localLabel: "YOU",
  remoteLabel: "EXT",
  events: [],
};

// ─── Constants ────────────────────────────────────────────────────────────────

export const VIEW_TYPE = "filewatch-view";

// ─── Theme helpers ────────────────────────────────────────────────────────────

function hexToRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

function buildThemeStyle(localColor: string, remoteColor: string, dotSize: number): string {
  return [
    `.filewatch-source--local{background:${hexToRgba(localColor, 0.15)};color:${localColor};border-color:${hexToRgba(localColor, 0.3)}}`,
    `.theme-dark .filewatch-source--local{background:${hexToRgba(localColor, 0.2)};color:${localColor}}`,
    `.filewatch-source--remote{background:${hexToRgba(remoteColor, 0.15)};color:${remoteColor};border-color:${hexToRgba(remoteColor, 0.3)}}`,
    `.theme-dark .filewatch-source--remote{background:${hexToRgba(remoteColor, 0.2)};color:${remoteColor}}`,
    `[data-filewatch-dot="local"]::after{background:${localColor};width:${dotSize}px;height:${dotSize}px}`,
    `[data-filewatch-dot="remote"]::after{background:${remoteColor};width:${dotSize}px;height:${dotSize}px}`,
  ].join("\n");
}

// ─── Sidebar View ─────────────────────────────────────────────────────────────

export class FileWatchView extends ItemView {
  private plugin: FileWatchPlugin;
  private listEl!: HTMLElement;
  private badgeEl: HTMLElement | null = null;
  private unseenPaths = new Set<string>();

  constructor(leaf: WorkspaceLeaf, plugin: FileWatchPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType() {
    return VIEW_TYPE;
  }

  getDisplayText() {
    return "File Watch";
  }

  getIcon() {
    return "file-clock";
  }

  async onOpen() {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.addClass("filewatch-container");

    // Header
    const header = container.createDiv({ cls: "filewatch-header" });
    header.createEl("span", { text: "File Watch", cls: "filewatch-title" });

    const actions = header.createDiv({ cls: "filewatch-actions" });

    // Clear button
    const clearBtn = actions.createEl("button", {
      cls: "filewatch-btn",
      attr: { "aria-label": "Clear list" },
    });
    setIcon(clearBtn, "trash-2");
    clearBtn.addEventListener("click", async () => {
      this.plugin.settings.events = [];
      await this.plugin.saveSettings();
      this.unseenPaths.clear();
      this.updateBadge();
      this.render();
      this.plugin.decorateFileExplorer();
    });

    // List
    this.listEl = container.createDiv({ cls: "filewatch-list" });
    this.render();
  }

  async onClose() {}

  /** Re-render the full list from plugin.settings.events */
  render() {
    this.listEl.empty();

    const events = this.plugin.settings.events;

    if (events.length === 0) {
      this.listEl.createDiv({
        cls: "filewatch-empty",
        text: "No file changes recorded yet.",
      });
      return;
    }

    // Newest first
    const sorted = [...events].sort((a, b) => b.ts - a.ts);

    for (const ev of sorted) {
      const row = this.listEl.createDiv({ cls: "filewatch-row" });

      // Kind badge
      const kindBadge = row.createDiv({
        cls: `filewatch-kind filewatch-kind--${ev.kind}`,
        text: ev.kind === "created" ? "NEW" : "MOD",
        attr: { "aria-label": ev.kind === "created" ? "New file created" : "File modified" },
      });

      // Source badge
      row.createDiv({
        cls: `filewatch-source filewatch-source--${ev.source}`,
        text: ev.source === "remote" ? this.plugin.settings.remoteLabel : this.plugin.settings.localLabel,
        attr: { "aria-label": ev.source === "remote" ? "External / Claude" : "You" },
      });

      // File name (clickable)
      const name = row.createDiv({ cls: "filewatch-name" });
      const parts = ev.path.split("/");
      const filename = parts.pop() ?? ev.path;
      const folder = parts.join("/");

      if (folder) {
        name.createSpan({ cls: "filewatch-folder", text: folder + "/" });
      }
      const link = name.createEl("a", { cls: "filewatch-link", text: filename });
      link.addEventListener("click", (e) => {
        e.preventDefault();
        const file = this.app.vault.getAbstractFileByPath(ev.path);
        if (file instanceof TFile) {
          this.app.workspace.getLeaf(false).openFile(file);
        }
      });

      // Timestamp
      if (this.plugin.settings.showTimestamps) {
        row.createDiv({
          cls: "filewatch-ts",
          text: this.formatTs(ev.ts),
          attr: { title: new Date(ev.ts).toLocaleString() },
        });
      }
    }
  }

  /** Called by plugin on every new event — renders + pulses the tab */
  onNewEvent(path: string) {
    this.render();
    this.unseenPaths.add(path);
    this.updateBadge();

    if (this.plugin.settings.highlightOnChange) {
      this.pulseTab();
    }
  }

  // ── Badge (unseen count on tab icon) ─────────────────────────────────────

  private updateBadge() {
    const leafEl = (this.leaf as any).tabHeaderEl as HTMLElement | undefined;

    // Remove old badge
    const existing = leafEl?.querySelector(".filewatch-badge");
    existing?.remove();

    const count = this.unseenPaths.size;
    if (count > 0 && leafEl) {
      const badge = leafEl.createDiv({ cls: "filewatch-badge" });
      badge.setText(String(count > 99 ? "99+" : count));
    }
  }

  /** Reset badge when user focuses this view */
  clearBadge() {
    this.unseenPaths.clear();
    this.updateBadge();
  }

  // ── Tab pulse animation ───────────────────────────────────────────────────

  private pulseTab() {
    const tabEl = (this.leaf as any).tabHeaderEl as HTMLElement | undefined;
    if (!tabEl) return;
    tabEl.addClass("filewatch-tab-pulse");
    setTimeout(() => tabEl.removeClass("filewatch-tab-pulse"), 1200);
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private formatTs(ts: number): string {
    const now = Date.now();
    const diff = now - ts;
    if (diff < 60_000) return "just now";
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
    return (moment as any)(ts).format("MMM D");
  }
}

// ─── Plugin ───────────────────────────────────────────────────────────────────

export default class FileWatchPlugin extends Plugin {
  settings!: FileWatchSettings;

  private lastWindowActiveMs = Date.now();
  private localTouched = new Set<string>();
  private seenPaths = new Set<string>();
  private decorateTimer: number | null = null;
  private styleEl: HTMLStyleElement | null = null;

  injectThemeStyle() {
    if (!this.styleEl) {
      this.styleEl = document.createElement("style");
      this.styleEl.id = "filewatch-theme";
      document.head.appendChild(this.styleEl);
    }
    this.styleEl.textContent = buildThemeStyle(
      this.settings.localColor,
      this.settings.remoteColor,
      this.settings.dotSize
    );
  }

  async onload() {
    await this.loadSettings();
    this.injectThemeStyle();

    if (!this.settings.persistHistory) {
      this.settings.events = [];
      await this.saveSettings();
    }

    // Register sidebar view
    this.registerView(VIEW_TYPE, (leaf) => new FileWatchView(leaf, this));

    // Add ribbon icon
    this.addRibbonIcon("file-clock", "File Watch", () => {
      this.activateView();
    });

    // Window focus tracking — used to detect remote vs local changes
    this.registerDomEvent(window, "focus", () => {
      this.lastWindowActiveMs = Date.now();
    });
    this.registerDomEvent(window, "blur", () => {
      // no-op; we just use lastWindowActiveMs as a heuristic
    });

    // Track files the user explicitly opens (marks as "could be local")
    this.registerEvent(
      this.app.workspace.on("file-open", (file) => {
        if (!file) return;
        this.localTouched.add(file.path);
        const isTracked = this.settings.events.some((e) => e.path === file.path);
        if (isTracked && !this.seenPaths.has(file.path)) {
          this.seenPaths.add(file.path);
          this.decorateFileExplorer();
        }
      })
    );

    // ── Core vault watchers ──────────────────────────────────────────────────

    this.registerEvent(
      this.app.vault.on("modify", (file: TAbstractFile) => {
        if (!(file instanceof TFile)) return;
        this.handleEvent(file, "modified");
      })
    );

    this.registerEvent(
      this.app.vault.on("rename", (file: TAbstractFile, oldPath: string) => {
        const oldPrefix = oldPath + "/";
        let changed = false;
        for (const ev of this.settings.events) {
          if (ev.path === oldPath) {
            ev.path = file.path;
            changed = true;
          } else if (ev.path.startsWith(oldPrefix)) {
            ev.path = file.path + "/" + ev.path.slice(oldPrefix.length);
            changed = true;
          }
        }
        if (this.seenPaths.delete(oldPath)) this.seenPaths.add(file.path);
        for (const p of [...this.seenPaths]) {
          if (p.startsWith(oldPrefix)) {
            this.seenPaths.delete(p);
            this.seenPaths.add(file.path + "/" + p.slice(oldPrefix.length));
          }
        }
        if (changed) {
          this.saveSettings();
          this.getView()?.render();
        }
        this.decorateFileExplorer();
      })
    );

    this.registerEvent(
      this.app.vault.on("delete", (file: TAbstractFile) => {
        const pathPrefix = file.path + "/";
        const before = this.settings.events.length;
        this.settings.events = this.settings.events.filter(
          (e) => e.path !== file.path && !e.path.startsWith(pathPrefix)
        );
        for (const p of [...this.seenPaths]) {
          if (p === file.path || p.startsWith(pathPrefix)) this.seenPaths.delete(p);
        }
        if (this.settings.events.length !== before) {
          this.saveSettings();
          this.getView()?.render();
          this.decorateFileExplorer();
        }
      })
    );

    this.registerEvent(
      this.app.vault.on("create", (file: TAbstractFile) => {
        if (!(file instanceof TFile)) return;
        // Obsidian fires "create" for existing files on startup; skip those
        // by only recording if the file is very new (< 5s old)
        if (Date.now() - file.stat.ctime > 5000) return;
        this.handleEvent(file, "created");
      })
    );

    // Settings tab
    this.addSettingTab(new FileWatchSettingTab(this.app, this));

    // Ensure the view leaf exists without stealing focus from the user's active panel
    if (this.app.workspace.layoutReady) {
      this.ensureView();
      this.decorateFileExplorer();
    } else {
      this.app.workspace.onLayoutReady(() => {
        this.ensureView();
        this.decorateFileExplorer();
      });
    }

    // Clear badge when user focuses the view
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf) => {
        if (leaf?.view.getViewType() === VIEW_TYPE) {
          (leaf.view as FileWatchView).clearBadge();
        }
      })
    );
  }

  onunload() {
    this.styleEl?.remove();
    this.styleEl = null;
  }

  // ── Event handling ──────────────────────────────────────────────────────────

  private handleEvent(file: TFile, kind: ChangeKind) {
    const source = this.detectSource(file);

    const { trackSource } = this.settings;
    if (trackSource === "remote" && source !== "remote") return;
    if (trackSource === "local" && source !== "local") return;

    // Deduplicate: if this file already has an entry, update it in place
    // so each file appears only once in the list (always showing the latest change)
    const now = Date.now();
    const existing = this.settings.events.find((e) => e.path === file.path);
    if (existing) {
      existing.ts = now;
      existing.kind = kind;
      existing.source = source;
    } else {
      const ev: FileEvent = { path: file.path, kind, source, ts: now };
      this.settings.events.unshift(ev);

      // Cap list length
      if (this.settings.events.length > this.settings.maxEntries) {
        this.settings.events = this.settings.events.slice(0, this.settings.maxEntries);
      }
    }

    this.seenPaths.delete(file.path);
    this.saveSettings();
    this.getView()?.onNewEvent(file.path);
    this.decorateFileExplorer();
  }

  /**
   * Heuristic: if the window hasn't been active recently AND the file wasn't
   * opened by the user, treat it as a remote (external/Claude) change.
   */
  private detectSource(file: TFile): "local" | "remote" {
    const windowWasRecentlyActive =
      Date.now() - this.lastWindowActiveMs < this.settings.remoteWindowMs;
    const userTouchedFile = this.localTouched.has(file.path);

    if (windowWasRecentlyActive || userTouchedFile) return "local";
    return "remote";
  }

  // ── View helpers ────────────────────────────────────────────────────────────

  async activateView() {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
      leaf = workspace.getLeftLeaf(false) ?? workspace.getLeaf(false);
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    workspace.revealLeaf(leaf);
  }

  async ensureView() {
    const { workspace } = this.app;
    if (workspace.getLeavesOfType(VIEW_TYPE).length === 0) {
      const leaf = workspace.getLeftLeaf(false) ?? workspace.getLeaf(false);
      await leaf.setViewState({ type: VIEW_TYPE, active: false });
    }
  }

  getView(): FileWatchView | null {
    const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
    return leaf ? (leaf.view as FileWatchView) : null;
  }

  // ── File Explorer decoration ────────────────────────────────────────────────

  decorateFileExplorer() {
    // Synchronously clear all dot attributes so stale indicators never linger
    document.querySelectorAll("[data-filewatch-dot]").forEach((el) =>
      el.removeAttribute("data-filewatch-dot")
    );

    if (this.decorateTimer !== null) {
      window.clearTimeout(this.decorateTimer);
      this.decorateTimer = null;
    }
    if (!this.settings.showExplorerDots) return;

    // Defer re-addition so Obsidian's file explorer DOM settles after vault events
    this.decorateTimer = window.setTimeout(() => {
      this.decorateTimer = null;
      this.applyDots();
    }, 100);
  }

  private applyDots() {
    const explorerLeaf = this.app.workspace.getLeavesOfType("file-explorer")[0];
    if (!explorerLeaf) return;

    const explorerView = explorerLeaf.view as any;
    const fileItems = explorerView.fileItems as Record<string, any> | undefined;
    if (!fileItems) return;

    // Build the full set of paths to dot: each unseen file plus every ancestor folder.
    // If a folder contains both local and remote changes, remote (purple) wins.
    const toDecorate = new Map<string, "local" | "remote">();
    for (const ev of this.settings.events) {
      if (this.seenPaths.has(ev.path)) continue;
      if (!toDecorate.has(ev.path) || ev.source === "remote") {
        toDecorate.set(ev.path, ev.source);
      }
      const parts = ev.path.split("/");
      for (let i = 1; i < parts.length; i++) {
        const folderPath = parts.slice(0, i).join("/");
        if (!toDecorate.has(folderPath) || ev.source === "remote") {
          toDecorate.set(folderPath, ev.source);
        }
      }
    }

    const decorated = new Set<HTMLElement>();
    for (const [path, source] of toDecorate) {
      const item = fileItems[path];
      if (!item) continue;
      const titleEl: HTMLElement | undefined = item.titleEl ?? item.selfEl ?? item.el;
      if (!titleEl || decorated.has(titleEl)) continue;
      decorated.add(titleEl);
      // Using a data attribute + CSS ::after avoids child-span accumulation entirely —
      // setting the same attribute twice just overwrites it
      titleEl.setAttribute("data-filewatch-dot", source);
    }
  }

  // ── Settings persistence ────────────────────────────────────────────────────

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    // Deduplicate persisted events: keep only the most recent entry per path
    this.settings.events.sort((a, b) => b.ts - a.ts);
    const seen = new Set<string>();
    this.settings.events = this.settings.events.filter((e) => {
      if (seen.has(e.path)) return false;
      seen.add(e.path);
      return true;
    });
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}

// ─── Settings Tab ─────────────────────────────────────────────────────────────

class FileWatchSettingTab extends PluginSettingTab {
  plugin: FileWatchPlugin;

  constructor(app: App, plugin: FileWatchPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "File Watch Settings" });

    // ── Track source ────────────────────────────────────────────────────────
    new Setting(containerEl)
      .setName("Track changes from")
      .setDesc(
        "All: every file change. External only: changes made while Obsidian was in the background (e.g. Claude). Local only: changes you make while Obsidian is active."
      )
      .addDropdown((drop) => {
        drop
          .addOption("all", "All changes")
          .addOption("remote", "External only (Claude / scripts)")
          .addOption("local", "Local only (you)")
          .setValue(this.plugin.settings.trackSource)
          .onChange(async (val) => {
            this.plugin.settings.trackSource = val as ChangeSource;
            await this.plugin.saveSettings();
          });
      });

    // ── Max entries ─────────────────────────────────────────────────────────
    new Setting(containerEl)
      .setName("Max entries")
      .setDesc("Maximum number of file events to keep in the list.")
      .addSlider((slider) => {
        slider
          .setLimits(10, 200, 10)
          .setValue(this.plugin.settings.maxEntries)
          .setDynamicTooltip()
          .onChange(async (val) => {
            this.plugin.settings.maxEntries = val;
            await this.plugin.saveSettings();
          });
      });

    // ── Timestamps ──────────────────────────────────────────────────────────
    new Setting(containerEl)
      .setName("Show timestamps")
      .setDesc("Display relative time (e.g. '3m ago') next to each entry.")
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.showTimestamps)
          .onChange(async (val) => {
            this.plugin.settings.showTimestamps = val;
            await this.plugin.saveSettings();
            this.plugin.getView()?.render();
          });
      });

    // ── Highlight on change ─────────────────────────────────────────────────
    new Setting(containerEl)
      .setName("Highlight tab on change")
      .setDesc(
        "Flash the File Watch tab and show an unseen-count badge whenever a new change comes in."
      )
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.highlightOnChange)
          .onChange(async (val) => {
            this.plugin.settings.highlightOnChange = val;
            await this.plugin.saveSettings();
          });
      });

    // ── Remote window ───────────────────────────────────────────────────────
    new Setting(containerEl)
      .setName("Remote detection window (ms)")
      .setDesc(
        "If Obsidian has been in the background for longer than this many milliseconds when a file changes, it's counted as external/remote. Default 2000 (2 seconds)."
      )
      .addText((text) => {
        text
          .setPlaceholder("2000")
          .setValue(String(this.plugin.settings.remoteWindowMs))
          .onChange(async (val) => {
            const parsed = parseInt(val);
            if (!isNaN(parsed) && parsed >= 0) {
              this.plugin.settings.remoteWindowMs = parsed;
              await this.plugin.saveSettings();
            }
          });
      });

    // ── Persist history ─────────────────────────────────────────────────────
    new Setting(containerEl)
      .setName("Persist history across restarts")
      .setDesc(
        "When enabled, the file change list is saved and restored when Obsidian restarts. Turn this off to start each session with a fresh list. Changes take effect on the next restart."
      )
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.persistHistory)
          .onChange(async (val) => {
            this.plugin.settings.persistHistory = val;
            await this.plugin.saveSettings();
          });
      });

    // ── Explorer dots ───────────────────────────────────────────────────────
    new Setting(containerEl)
      .setName("Show dots in Files panel")
      .setDesc(
        "Display a small colored dot next to recently changed files in the Files panel."
      )
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.showExplorerDots)
          .onChange(async (val) => {
            this.plugin.settings.showExplorerDots = val;
            await this.plugin.saveSettings();
            this.plugin.decorateFileExplorer();
          });
      });

    // ── Appearance ──────────────────────────────────────────────────────────
    containerEl.createEl("h3", { text: "Appearance", cls: "filewatch-settings-h3" });

    new Setting(containerEl)
      .setName('"You" label')
      .setDesc("Text on the badge for your own changes.")
      .addText((text) => {
        text
          .setPlaceholder("YOU")
          .setValue(this.plugin.settings.localLabel)
          .onChange(async (val) => {
            this.plugin.settings.localLabel = val.trim() || DEFAULT_SETTINGS.localLabel;
            await this.plugin.saveSettings();
            this.plugin.getView()?.render();
          });
      });

    this.addColorSetting(
      containerEl,
      '"You" color',
      "Color for your own change badges and explorer dots.",
      () => this.plugin.settings.localColor,
      async (val) => {
        this.plugin.settings.localColor = val;
        await this.plugin.saveSettings();
        this.plugin.injectThemeStyle();
        this.plugin.getView()?.render();
      }
    );

    new Setting(containerEl)
      .setName('"External" label')
      .setDesc("Text on the badge for externally-made changes.")
      .addText((text) => {
        text
          .setPlaceholder("EXT")
          .setValue(this.plugin.settings.remoteLabel)
          .onChange(async (val) => {
            this.plugin.settings.remoteLabel = val.trim() || DEFAULT_SETTINGS.remoteLabel;
            await this.plugin.saveSettings();
            this.plugin.getView()?.render();
          });
      });

    this.addColorSetting(
      containerEl,
      '"External" color',
      "Color for external change badges and explorer dots.",
      () => this.plugin.settings.remoteColor,
      async (val) => {
        this.plugin.settings.remoteColor = val;
        await this.plugin.saveSettings();
        this.plugin.injectThemeStyle();
        this.plugin.getView()?.render();
      }
    );

    new Setting(containerEl)
      .setName("Explorer dot size")
      .setDesc("Diameter of the indicator dots in the Files panel (pixels).")
      .addSlider((slider) => {
        slider
          .setLimits(4, 12, 1)
          .setValue(this.plugin.settings.dotSize)
          .setDynamicTooltip()
          .onChange(async (val) => {
            this.plugin.settings.dotSize = val;
            await this.plugin.saveSettings();
            this.plugin.injectThemeStyle();
          });
      });

    new Setting(containerEl)
      .setName("Reset appearance to defaults")
      .setDesc("Restore default colors, dot size, and labels.")
      .addButton((btn) => {
        btn.setButtonText("Reset").onClick(async () => {
          this.plugin.settings.localColor = DEFAULT_SETTINGS.localColor;
          this.plugin.settings.remoteColor = DEFAULT_SETTINGS.remoteColor;
          this.plugin.settings.dotSize = DEFAULT_SETTINGS.dotSize;
          this.plugin.settings.localLabel = DEFAULT_SETTINGS.localLabel;
          this.plugin.settings.remoteLabel = DEFAULT_SETTINGS.remoteLabel;
          await this.plugin.saveSettings();
          this.plugin.injectThemeStyle();
          this.plugin.getView()?.render();
          this.display();
        });
      });

    // ── Clear button ────────────────────────────────────────────────────────
    new Setting(containerEl)
      .setName("Clear all recorded events")
      .setDesc("Wipes the current list. This cannot be undone.")
      .addButton((btn) => {
        btn
          .setButtonText("Clear now")
          .setWarning()
          .onClick(async () => {
            this.plugin.settings.events = [];
            await this.plugin.saveSettings();
            this.plugin.getView()?.render();
            this.plugin.decorateFileExplorer();
          });
      });
  }

  private addColorSetting(
    containerEl: HTMLElement,
    name: string,
    desc: string,
    getValue: () => string,
    onChange: (val: string) => Promise<void>
  ): void {
    const setting = new Setting(containerEl).setName(name).setDesc(desc);
    const ctrl = setting.controlEl.createDiv({ cls: "filewatch-color-control" });

    const swatch = ctrl.createEl("span", { cls: "filewatch-color-swatch" });
    swatch.style.background = getValue();

    const input = ctrl.createEl("input", { cls: "filewatch-color-input" });
    input.type = "color";
    input.value = getValue();
    input.addEventListener("input", (e) => {
      const val = (e.target as HTMLInputElement).value;
      swatch.style.background = val;
      onChange(val);
    });
  }
}