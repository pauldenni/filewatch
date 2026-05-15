# File Watch — Obsidian Plugin

A sidebar panel that tracks **which files were created or modified** in your vault — including changes made by external tools like Claude running in your terminal.

![File Watch sidebar panel showing NEW/MOD badges and YOU/EXT source labels]

---

## Features

- **Live sidebar panel** — lists every created/modified file, newest first
- **Source detection** — distinguishes changes made *by you* (Obsidian active) vs *externally* (Claude, scripts, git) using a window-focus heuristic
- **Kind badges** — green **NEW** for created files, amber **MOD** for modified files
- **Source badges** — blue **YOU** for local changes, purple **EXT** for external/remote changes
- **Tab badge** — unseen-count bubble appears on the sidebar tab when new changes arrive while you're elsewhere
- **Tab pulse** — the tab flashes when a change is detected (can be disabled)
- **Click to open** — click any file name to open it in the editor
- **Clear button** — wipe the list when you're done reviewing
- **Persistent** — list survives Obsidian restarts (stored in plugin data)

---

## Installation

### From source (manual)

```bash
# 1. Clone / copy this folder into your vault's plugins directory
cp -r obsidian-file-watch /path/to/your/vault/.obsidian/plugins/file-watch

# 2. Install dependencies and build
cd /path/to/your/vault/.obsidian/plugins/file-watch
npm install
npm run build
```

Then in Obsidian:
1. Go to **Settings → Community plugins**
2. Disable Safe Mode if prompted
3. Enable **File Watch**

### Dev mode (hot-reload)

```bash
npm run dev
```

This watches `main.ts` for changes and rebuilds automatically.

---

## Settings

| Setting | Description | Default |
|---|---|---|
| **Track changes from** | All / External only / Local only | All |
| **Max entries** | How many events to keep | 50 |
| **Show timestamps** | Display relative time next to each entry | On |
| **Highlight tab on change** | Flash the tab on new changes (badge always shows regardless) | On |
| **Remote detection window (ms)** | How long after the window loses focus before changes count as "external" | 2000 |

---

## How remote detection works

Obsidian's vault API fires `modify`/`create` events for **all** file changes, regardless of source — there's no native way to tell whether a change came from inside Obsidian or from an external process.

File Watch uses a **window-focus heuristic**:

- If the Obsidian window was **active within the last N ms** (configurable, default 2s) → change is marked **YOU (local)**
- If Obsidian has been **in the background** longer than that → change is marked **EXT (external)**

This works well for the Claude use case: you run a command in your terminal (Obsidian loses focus), Claude writes files, and those show up as **EXT**. When you then click back into Obsidian and save a note yourself, it shows up as **YOU**.

It's a heuristic, not perfect — if you save a file within 2 seconds of alt-tabbing away, it may be miscategorised.

---

## File structure

```
obsidian-file-watch/
├── main.ts          ← All plugin logic
├── styles.css       ← Sidebar panel styles
├── manifest.json    ← Plugin metadata
├── package.json
├── esbuild.config.mjs
└── tsconfig.json
```
