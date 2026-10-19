import {
  App,
  ItemView,
  Keymap,
  PaneType,
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

/** A burst of link rewrites Obsidian made in other notes after files were moved. */
interface LinkGroup {
  id: number; // creation time, epoch ms
  ts: number; // latest absorbed update, epoch ms
  moves: { from: string; to: string }[];
  paths: string[];
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
  showKindBadge: boolean;
  showSourceBadge: boolean;
  hideLinkUpdates: boolean;
  linkWindowMs: number; // ms after a rename in which modifies elsewhere count as link updates
  events: FileEvent[];
  linkGroups: LinkGroup[];
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
  showKindBadge: true,
  showSourceBadge: true,
  hideLinkUpdates: false,
  linkWindowMs: 2000,
  events: [],
  linkGroups: [],
};

// ─── Constants ────────────────────────────────────────────────────────────────

export const VIEW_TYPE = "filewatch-view";
const MAX_LINK_GROUPS = 20;

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
  private expandedGroups = new Set<number>();

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
      this.plugin.settings.linkGroups = [];
      this.expandedGroups.clear();
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
    const groups = this.plugin.settings.hideLinkUpdates ? [] : this.plugin.settings.linkGroups;

    if (events.length === 0 && groups.length === 0) {
      this.listEl.createDiv({
        cls: "filewatch-empty",
        text: "No file changes recorded yet.",
      });
      return;
    }

    // Newest first, link-update groups interleaved by time
    const items: { ts: number; ev?: FileEvent; group?: LinkGroup }[] = [
      ...events.map((ev) => ({ ts: ev.ts, ev })),
      ...groups.map((group) => ({ ts: group.ts, group })),
    ].sort((a, b) => b.ts - a.ts);

    for (const item of items) {
      if (item.group) {
        this.renderGroup(item.group);
        continue;
      }
      const ev = item.ev!;
      const { showKindBadge, showSourceBadge } = this.plugin.settings;
      const row = this.listEl.createDiv({ cls: "filewatch-row" });
      row.style.gridTemplateColumns = [
        showKindBadge ? "36px" : "",
        showSourceBadge ? "36px" : "",
        "1fr",
        "auto",
      ].filter(Boolean).join(" ");

      // Kind badge
      if (showKindBadge) {
        row.createDiv({
          cls: `filewatch-kind filewatch-kind--${ev.kind}`,
          text: ev.kind === "created" ? "NEW" : "MOD",
          attr: { "aria-label": ev.kind === "created" ? "New file created" : "File modified" },
        });
      }

      // Source badge
      if (showSourceBadge) {
        row.createDiv({
          cls: `filewatch-source filewatch-source--${ev.source}`,
          text: ev.source === "remote" ? this.plugin.settings.remoteLabel : this.plugin.settings.localLabel,
          attr: { "aria-label": ev.source === "remote" ? "External / Claude" : "You" },
        });
      }

      // File name (clickable)
      const name = row.createDiv({ cls: "filewatch-name" });
      const parts = ev.path.split("/");
      const filename = parts.pop() ?? ev.path;
      const folder = parts.join("/");

      if (folder) {
        name.createSpan({ cls: "filewatch-folder", text: folder + "/" });
      }
      const link = name.createEl("a", { cls: "filewatch-link", text: filename });
      // Cmd/Ctrl+click opens in a new tab (Obsidian's standard modifiers also
      // apply: +Alt for a split, +Alt+Shift for a new window). Middle-click
      // opens in a new tab too.
      const openLink = (e: MouseEvent, newLeaf: PaneType | boolean) => {
        e.preventDefault();
        const file = this.app.vault.getAbstractFileByPath(ev.path);
        if (file instanceof TFile) {
          this.app.workspace.getLeaf(newLeaf).openFile(file);
        }
      };
      link.addEventListener("click", (e) => openLink(e, Keymap.isModEvent(e)));
      link.addEventListener("auxclick", (e) => {
        if (e.button === 1) openLink(e, "tab");
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

  /** One collapsible row for a burst of link rewrites caused by moving files */
  private renderGroup(group: LinkGroup) {
    const expanded = this.expandedGroups.has(group.id);
    const { showKindBadge } = this.plugin.settings;
    const row = this.listEl.createDiv({ cls: "filewatch-row filewatch-group-row" });
    row.style.gridTemplateColumns = [showKindBadge ? "36px" : "", "14px", "1fr", "auto"]
      .filter(Boolean)
      .join(" ");

    if (showKindBadge) {
      row.createDiv({
        cls: "filewatch-kind filewatch-kind--link",
        text: "LNK",
        attr: { "aria-label": "Links updated by Obsidian after a move" },
      });
    }
    row.createDiv({ cls: "filewatch-group-caret", text: expanded ? "▾" : "▸" });

    const moved = group.moves.length;
    const n = group.paths.length;
    const label = `${moved} ${moved === 1 ? "file" : "files"} moved → ${n} ${n === 1 ? "note" : "notes"} had links updated`;
    row.createDiv({ cls: "filewatch-name filewatch-group-label", text: label });

    if (this.plugin.settings.showTimestamps) {
      row.createDiv({
        cls: "filewatch-ts",
        text: this.formatTs(group.ts),
        attr: { title: new Date(group.ts).toLocaleString() },
      });
    }

    row.addEventListener("click", () => {
      if (!this.expandedGroups.delete(group.id)) this.expandedGroups.add(group.id);
      this.render();
    });

    if (!expanded) return;

    const detail = this.listEl.createDiv({ cls: "filewatch-group-detail" });
    const shown = group.moves.slice(0, 3);
    for (const m of shown) {
      detail.createDiv({ cls: "filewatch-group-item filewatch-group-move", text: `${m.from} → ${m.to}` });
    }
    if (group.moves.length > shown.length) {
      detail.createDiv({
        cls: "filewatch-group-item filewatch-group-move",
        text: `…${group.moves.length - shown.length} more`,
      });
    }
    for (const path of group.paths) {
      const item = detail.createDiv({ cls: "filewatch-group-item" });
      const link = item.createEl("a", { cls: "filewatch-link", text: path });
      link.addEventListener("click", (e) => {
        e.preventDefault();
        const file = this.app.vault.getAbstractFileByPath(path);
        if (file instanceof TFile) {
          this.app.workspace.getLeaf(Keymap.isModEvent(e)).openFile(file);
        }
      });
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

  private lastBlurMs = 0;
  private isWindowActive = document.hasFocus();
  private localTouched = new Set<string>();
  private seenPaths = new Set<string>();
  private decorateTimer: number | null = null;
  // Link-update absorption: renames open a window in which modifies elsewhere
  // are Obsidian rewriting links, not real edits.
  private linkWindowUntil = 0;
  private pendingMoves: { from: string; to: string }[] = [];
  private activeGroup: LinkGroup | null = null;
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
      this.settings.linkGroups = [];
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
      this.isWindowActive = true;
    });
    this.registerDomEvent(window, "blur", () => {
      this.isWindowActive = false;
      this.lastBlurMs = Date.now();
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
        this.noteMove(oldPath, file.path);
        const remap = (p: string): string | null =>
          p === oldPath
            ? file.path
            : p.startsWith(oldPrefix)
            ? file.path + "/" + p.slice(oldPrefix.length)
            : null;
        for (const g of this.settings.linkGroups) {
          g.paths = g.paths.map((p) => {
            const np = remap(p);
            if (np) changed = true;
            return np ?? p;
          });
        }
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
        let groupsChanged = false;
        for (const g of this.settings.linkGroups) {
          const n = g.paths.length;
          g.paths = g.paths.filter((p) => p !== file.path && !p.startsWith(pathPrefix));
          if (g.paths.length !== n) groupsChanged = true;
        }
        if (groupsChanged) {
          this.settings.linkGroups = this.settings.linkGroups.filter((g) => g.paths.length > 0);
        }
        if (this.settings.events.length !== before || groupsChanged) {
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

    // Re-sync dots when a folder is expanded/collapsed. Obsidian re-attaches
    // (or rebuilds) child rows on toggle, so re-run the idempotent sync to keep
    // displayed dots aligned with the recorded events. The 100ms defer in
    // decorateFileExplorer coalesces rapid clicks and lets the DOM settle.
    this.registerDomEvent(document, "click", (e) => {
      if ((e.target as HTMLElement)?.closest(".nav-folder-title")) {
        this.decorateFileExplorer();
      }
    });
  }

  onunload() {
    this.styleEl?.remove();
    this.styleEl = null;
  }

  // ── Event handling ──────────────────────────────────────────────────────────

  /** Record a move and (re)open the window in which link rewrites are expected */
  private noteMove(from: string, to: string) {
    const now = Date.now();
    if (now >= this.linkWindowUntil) {
      this.pendingMoves = [];
      this.activeGroup = null;
    }
    this.linkWindowUntil = now + this.settings.linkWindowMs;
    const move = { from, to };
    if (this.activeGroup) this.activeGroup.moves.push(move);
    else this.pendingMoves.push(move);
  }

  /** True if this modify is Obsidian rewriting links after a move; records it in a group */
  private absorbLinkUpdate(file: TFile): boolean {
    const now = Date.now();
    if (now >= this.linkWindowUntil) return false;
    // The moved files themselves are not link rewrites
    const moves = this.activeGroup ? this.activeGroup.moves : this.pendingMoves;
    if (moves.some((m) => file.path === m.to || file.path.startsWith(m.to + "/"))) return false;

    let group = this.activeGroup;
    if (!group) {
      group = { id: now, ts: now, moves: [...this.pendingMoves], paths: [] };
      this.activeGroup = group;
      this.settings.linkGroups.unshift(group);
      if (this.settings.linkGroups.length > MAX_LINK_GROUPS) {
        this.settings.linkGroups = this.settings.linkGroups.slice(0, MAX_LINK_GROUPS);
      }
    }
    if (!group.paths.includes(file.path)) group.paths.push(file.path);
    group.ts = now;
    // Slide the window so a long burst stays in one group
    this.linkWindowUntil = now + this.settings.linkWindowMs;
    this.saveSettings();
    this.getView()?.render();
    return true;
  }

  private handleEvent(file: TFile, kind: ChangeKind) {
    if (kind === "modified" && this.absorbLinkUpdate(file)) return;

    const source = this.detectSource(file);

    const { trackSource } = this.settings;
    if (trackSource === "remote" && source !== "remote") return;
    if (trackSource === "local" && source !== "local") return;

    // Deduplicate: if this file already has an entry, update it in place
    // so each file appears only once in the list (always showing the latest change)
    const now = Date.now();
    const existing = this.settings.events.find((e) => e.path === file.path);
    // Dot is already correctly rendered when the file has an entry, is unseen,
    // and the source hasn't changed — skip decoration to avoid the blink.
    const dotAlreadyCorrect =
      existing !== undefined &&
      !this.seenPaths.has(file.path) &&
      existing.source === source;

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
    if (!dotAlreadyCorrect) this.decorateFileExplorer();
  }

  /**
   * Heuristic: if the window is currently active or lost focus within the grace
   * period, treat the change as local. Otherwise treat it as remote (external/Claude).
   */
  private detectSource(file: TFile): "local" | "remote" {
    const withinGracePeriod =
      !this.isWindowActive &&
      this.lastBlurMs > 0 &&
      Date.now() - this.lastBlurMs < this.settings.remoteWindowMs;
    const userTouchedFile = this.localTouched.has(file.path);

    if (this.isWindowActive || withinGracePeriod || userTouchedFile) return "local";
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

  /**
   * Make sure the FileWatch leaf exists in the sidebar so its tab icon is always
   * present — without stealing focus. Called on load/enable.
   *
   * Focus-safety rules (this is what the v0.4.0 startup-open got wrong):
   *  - If a leaf already exists (Obsidian restored it from the saved layout on a
   *    normal restart), do nothing, so we never change which panel is active.
   *  - Create with `active: false` so the tab is added but does not become the
   *    active sidebar panel or move editor focus.
   *  - Never call `revealLeaf()` — that is reserved for the user clicking the
   *    ribbon (activateView).
   */
  async ensureView() {
    const { workspace } = this.app;
    if (workspace.getLeavesOfType(VIEW_TYPE).length > 0) return;
    const leaf = workspace.getLeftLeaf(false);
    if (!leaf) return;
    await leaf.setViewState({ type: VIEW_TYPE, active: false });
  }

getView(): FileWatchView | null {
    const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
    // When the leaf is created but never revealed (ensureView), Obsidian 1.7+
    // backs it with a lightweight DeferredView placeholder rather than our real
    // view — so guard with instanceof. Callers treat null as "no live view yet"
    // and skip; the real view renders from settings.events once it's revealed.
    return leaf && leaf.view instanceof FileWatchView ? leaf.view : null;
  }

  // ── File Explorer decoration ────────────────────────────────────────────────

  decorateFileExplorer() {
    if (this.decorateTimer !== null) {
      window.clearTimeout(this.decorateTimer);
      this.decorateTimer = null;
    }
    // Defer so Obsidian's file explorer DOM settles after vault events / folder
    // toggles, then sync every item in one idempotent pass.
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

    // Build the set of paths that should be dotted: each unseen file plus every
    // ancestor folder. If a folder mixes local + remote changes, remote wins.
    // When dots are disabled the map stays empty, so the sync below clears
    // everything.
    const toDecorate = new Map<string, "local" | "remote">();
    if (this.settings.showExplorerDots) {
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
    }

    // Sync every known explorer item against the desired state. Iterating
    // fileItems (instead of querying the live DOM) lets us reach rows Obsidian
    // has detached for collapsed folders — their titleEl objects persist here —
    // so stale dots can't survive there and resurface on re-expand.
    for (const path in fileItems) {
      const item = fileItems[path];
      const titleEl: HTMLElement | undefined = item?.titleEl ?? item?.selfEl ?? item?.el;
      if (!titleEl) continue;
      const source = toDecorate.get(path);
      if (source) {
        // setAttribute is idempotent; only write when it actually changes to
        // avoid needless style recalcs (and the dot blink).
        if (titleEl.getAttribute("data-filewatch-dot") !== source) {
          titleEl.setAttribute("data-filewatch-dot", source);
        }
      } else if (titleEl.hasAttribute("data-filewatch-dot")) {
        titleEl.removeAttribute("data-filewatch-dot");
      }
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

    // ── Link updates ────────────────────────────────────────────────────────
    new Setting(containerEl)
      .setName("Hide link-update groups")
      .setDesc(
        "When Obsidian rewrites links in other notes after you move a file, those edits are grouped into a single LNK row. Turn this on to hide those rows entirely."
      )
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.hideLinkUpdates)
          .onChange(async (val) => {
            this.plugin.settings.hideLinkUpdates = val;
            await this.plugin.saveSettings();
            this.plugin.getView()?.render();
          });
      });

    new Setting(containerEl)
      .setName("Link-update window (ms)")
      .setDesc(
        "Modifies to other files within this long after a move (extended by each one) are counted as link updates. Default 2000."
      )
      .addText((text) => {
        text
          .setPlaceholder("2000")
          .setValue(String(this.plugin.settings.linkWindowMs))
          .onChange(async (val) => {
            const parsed = parseInt(val);
            if (!isNaN(parsed) && parsed >= 0) {
              this.plugin.settings.linkWindowMs = parsed;
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
      .setName("Show NEW / MOD badges")
      .setDesc("Show the NEW / MOD kind badge (and LNK on link-update groups) on each row.")
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.showKindBadge)
          .onChange(async (val) => {
            this.plugin.settings.showKindBadge = val;
            await this.plugin.saveSettings();
            this.plugin.getView()?.render();
          });
      });

    new Setting(containerEl)
      .setName("Show YOU / EXT badges")
      .setDesc("Show the source badge on each row. Explorer dots keep their colors either way.")
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.showSourceBadge)
          .onChange(async (val) => {
            this.plugin.settings.showSourceBadge = val;
            await this.plugin.saveSettings();
            this.plugin.getView()?.render();
          });
      });

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