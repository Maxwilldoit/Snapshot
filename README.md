# Application Snapshot

[![Check](https://github.com/Maxworkinghard/Snapshot/actions/workflows/check.yml/badge.svg)](https://github.com/Maxworkinghard/Snapshot/actions/workflows/check.yml)

[简体中文](README.zh-CN.md) | English

A small desktop tool for window screenshots and screen recording, with prompt polishing and a desktop companion on the side. Built with Tauri 2 + React; one codebase for Windows, macOS and Linux.

The interface is Chinese only for now; the menu names below are translated into English.

## Interface

<table>
<tr>
<td width="50%"><img src="docs/screenshots/today.png" alt="Today: timeline and the desktop pet"></td>
<td width="50%"><img src="docs/screenshots/history.png" alt="History"></td>
</tr>
<tr>
<td width="50%"><img src="docs/screenshots/companion.png" alt="Companion appearances"></td>
<td width="50%"><img src="docs/screenshots/settings.png" alt="Shortcuts and preferences"></td>
</tr>
</table>

The desktop pet. One click switches the pose:

<p align="center">
  <img src="docs/screenshots/pet-idle.png" height="220" alt="Idle">
  <img src="docs/screenshots/pet-jump.png" height="220" alt="Jump">
  <img src="docs/screenshots/pet-peek.png" height="220" alt="Peek">
  <img src="docs/screenshots/pet-shy.png" height="220" alt="Shy">
</p>

## Features

- **Window snapshots**: capture a chosen application window straight to the clipboard, open it for annotation, or save it directly to History. Fullscreen capture is also available, plus scrolling capture on Linux (X11).
- **Window recording**: record a window to MP4, optionally with system audio and the microphone.
- **History**: snapshot and prompt records share one chronological page. Snapshot files are saved under Pictures/Snapshot by default and can be copied or annotated from the full-size preview; successful prompt polishing runs keep the original text, result, rule and time. Each type keeps its latest 200 local records.
- **Prompt polishing**: rewrite prompts through any OpenAI-compatible endpoint, with rewrite rules you can add and remove.
- **Desktop companion**: a small floating window that shows the current app's icon by default, or an animated GIF of your choice. Right-click it to open the quick menu, from which you can capture, record and polish. On Windows, it hides while a foreground app fills the same monitor and returns when you leave fullscreen or switch apps.
- **Global shortcuts**: every action above can be bound to a global shortcut, which also works while the main window is minimized. Manually pause them from the tray menu or shortcut settings to release the keys while keeping your bindings. The pause survives restarts until you manually resume.

## Platform support

| Feature | Windows | macOS | Linux |
|---|:-:|:-:|:-:|
| Window and fullscreen capture | ✓ | ✓ | ✓ |
| Window recording | ✓ | ✓ | ✓ |
| System audio while recording | ✓ | ✓ | ✓ |
| Microphone while recording | ✓ | macOS 15+ | ✓ |
| Scrolling capture | — | — | X11 only |
| Launch at login | ✓ | ✓ | ✓ |
| History, prompt polishing, preview annotation, companion | ✓ | ✓ | ✓ |

Availability is detected at runtime. On Linux, recording and audio rely on external tools; see [Runtime dependencies](#runtime-dependencies).

Windows has had the most testing on real hardware. Some features on macOS and Linux still need to be checked on real devices; see [docs/pending-device-verification.md](docs/pending-device-verification.md) (in Chinese).

## Installation

Download the package for your platform from [Releases](https://github.com/Maxworkinghard/Snapshot/releases). Windows (x64 / ARM64) and Linux (x86_64 / aarch64) packages are available; macOS follows later. You can also [build from source](#build-from-source).

System requirements:

- **macOS**: 14 or later; one universal package for Apple Silicon and Intel
- **Windows**: 10 or 11, x64 or ARM64
- **Linux**: x86_64 or aarch64 with an X11 or Wayland desktop session; the deb package for Ubuntu 22.04 / Debian 12 or later, the AppImage for other distributions with glibc 2.35 or later. Ubuntu 20.04 and older are not supported

The packages are not signed or notarized. On macOS, Control-click the app and choose Open the first time; on Windows, SmartScreen may block the installer.

### Permissions

On macOS, capture and recording need Screen Recording permission, capturing a minimized window needs Accessibility permission (to restore the window first), and recording the microphone needs Microphone permission.

### Runtime dependencies

Windows and macOS need nothing extra (on Windows 10 the installer downloads the WebView2 runtime if needed). On Linux, install these as needed:

| Tool | Used for |
|---|---|
| `ffmpeg` | Window recording; screenshots that include the mouse pointer (without it, screenshots have no pointer) |
| `pactl` (PulseAudio or PipeWire-Pulse) | Recording system audio and the microphone; ffmpeg must also be built with PulseAudio support |
| `xdotool` | Restoring a minimized window before capture; scrolling capture |
| StatusNotifierHost | System tray (built into KDE; GNOME needs the AppIndicator extension) |

## Usage

The launchpad scans installed apps in the background when Snapshot starts and warms the first batch of icons. Its catalog is cached locally and reused after restart. Opening the launchpad shows cached apps first and requests a background refresh at most once per minute; additions and removals appear on the next opening after that refresh. Preparation starts on the first run after installation; opening before the initial scan finishes may still show a brief loading message.

Open **Companion → 浏览素材库 (Browse asset library)** in a separate, resizable window to browse the [public Pets catalog](https://github.com/Maxworkinghard/Pets/blob/main/catalog/README.md) and download a companion. Opening it again focuses the same window; closing it preserves filters and ongoing downloads. The window and catalog are prepared in the background when Snapshot starts, and the catalog is cached locally; opening the library shows cached entries immediately while a background refresh checks for updates. Preview images still load on demand. Snapshot checks each ZIP's size and SHA-256 before importing it into app storage, where it remains available offline. Reimporting the same library pet updates its assets while keeping its custom name. Asset licensing is listed separately from Snapshot's code license. The library includes [event-animation guidance for creators](https://github.com/Maxworkinghard/Pets/blob/main/catalog/README.md).

Once started, the companion appears on the desktop (showing the current app's icon by default) and the app has an icon in the system tray.

- **Quick menu**: right-click the companion to open it. From here you can take a snapshot of a window, capture the full screen, record a window, or polish the prompt on the clipboard. Use the arrow keys to choose an action, Enter to run it, and Escape to close.
- **Shortcuts**: nothing is bound by default. On the Shortcuts page you can bind a global shortcut to window snapshot, fullscreen snapshot, window recording, prompt polishing and opening the quick menu, plus scrolling capture on Linux.
- **Capture**: by default a capture goes to the clipboard, which is cleared after 60 seconds (unless you copied something else in the meantime). In Preferences you can switch to opening the annotation window or saving only to History without touching the clipboard. The clear delay, image format and snapshot folder are under Shortcuts → Clipboard & saving.
- **Recording**: recordings are saved as MP4 in your Downloads folder by default. The folder and whether to include system audio and the microphone are under Shortcuts → Recording.
- **Prompt polishing**: first enter the endpoint URL, model and API key under Preferences → Machine & model. The API key is stored in the OS keychain, never in a config file. Rewrite rules are managed under Preferences → Polishing rules. Start polishing from the quick menu or its global shortcut; successful runs appear in History with the original text and result.
- **Companion**: on the Companion page, import a `.zip` of GIFs or a single GIF. Use one file per action; a file whose name contains `idle` becomes the default idle pose. The pet stays on that pose and does not switch by itself. A left click plays the next action, then returns to idle after 3 seconds; another click continues to the action after that. A double click opens the launchpad: installed apps in a grid, click one to launch it, and the mouse wheel or a horizontal drag moves with the page, then turns it. On Windows, Start Menu shortcuts and packaged apps from the system All Apps catalog are classified after scanning. The grid shows user-installed software, Microsoft Store apps, and clear desktop apps by default. System administration, accessibility, Control Panel, diagnostics, driver utilities, uninstallers, installers, updaters, configuration tools, and background components stay searchable and launchable but are hidden from the grid. Console programs (`cmd`, PowerShell, Node, Python), help files, and web links are excluded. Classification primarily uses resolved targets, installation paths, PE subsystems, and package identities, with names used for configuration and uninstall entries. Drag one icon onto another to make a folder. Folders can be renamed, and dragging an app out of a folder puts it back on the grid. Only GIF is supported and other files in the archive are skipped (each platform's WebView plays different video codecs, so video is not supported for now). Limits: 100 MB per archive, 50 MB per GIF. The size of the pet on the desktop is set under Preferences → Desktop pet (30% to 200%; at 100%, pets use 16% of the screen's short edge and floating app icons use 8%).
  - **Walking**: a file whose name contains `walk`, `run` or `move` is a walking action. It plays only while you drag the companion sideways, and a click does not select it. Add `left` or `right` to the name for its facing (e.g. `walk_left.gif`, `walk_right.gif`). If only one direction is provided it is mirrored for the other; a walk with no direction is used both ways. A walk whose character crosses the canvas is converted to walk in place automatically.
  - **Background**: if the background is painted into the GIF, it is removed automatically on import: only the background connected to the canvas border is cut out, so white parts of the figure such as a shirt stay. Edge pixels blended with the background are un-mixed, so the figure keeps a clean outline on a dark desktop.
  - **Oversized actions**: every GIF is scaled to fit the same square window, so a pack keeps the character the same size by giving every action the same canvas. When one action needs more room — a slam dunk with the hoop drawn in the frame — add a `pet.json` at the root of the zip. The normal window stays the square from Preferences. That action grows the window while it plays, then the window shrinks back. The character stays at the same scale, and the feet stay planted: the window grows up and sideways around them. Packs without `pet.json` are unchanged. Walking, dragging, click-to-cycle, double-click launchpad, the saved position and the pet scale setting all keep working; a mirrored walk plants the feet too, so the window may shift sideways if the feet are not centred in the canvas.

    `base` is the reference canvas in GIF pixels. It is fitted into the normal square the same way any GIF is today (`object-fit: contain`). `anchor` is `[x, y]` of the character's feet in that GIF, origin at the top-left, y downward. Every action's anchor is placed on the base anchor. Keys are the GIF's path inside the zip (forward slashes). Canvas size comes from the GIF header. An action whose canvas matches the base keeps the normal window; a larger canvas grows it. An action left out of `animations` is shown the old way, the whole GIF scaled into the square. A broken `pet.json` rejects the import.

    ```json
    {
      "version": 1,
      "base": { "width": 314, "height": 314, "anchor": [174.5, 303] },
      "animations": {
        "idle.gif": { "anchor": [174.5, 303] },
        "drive-dunk.gif": { "anchor": [174.5, 519] }
      }
    }
    ```

    If the pack was padded onto one shared canvas — the character is small and off-centre in every file because one action contains a prop — refit it (pixels are copied, not requantized; the file whose name contains `idle` is the reference pose and fills about 93% of the base canvas, in the same range as other pets):

    ```bash
    python3 scripts/pet-pack.py hoop-23-gifs.zip hoop-23-fitted.zip
    ```

    Re-import the new zip. `python3 scripts/pet-pack.py --self-test` checks the converter. Actions that draw outside the idle frame (a raised arm, a jump, the dunk) grow the window; the rest stay on the square.
- **Appearance**: the Themes page switches the layout, color scheme and motion.
- **Launch at login**: turn on "Launch silently at startup" in Preferences.

## Build from source

Requirements:

- Node.js 22
- Rust 1.98.1 (picked up automatically from `rust-toolchain.toml`)
- The [Tauri 2 prerequisites](https://v2.tauri.app/start/prerequisites/) for your platform
- On macOS, a Swift toolchain (Xcode or the Command Line Tools) to build the recording sidecar
- On Debian / Ubuntu, `sudo bash scripts/linux/install-deps.sh` installs the build and runtime dependencies

```bash
npm install
npm run tauri dev      # development
npm run tauri build    # installer
```

The macOS recording sidecar ([src-tauri/snapshot-recorder/](src-tauri/snapshot-recorder/)) is built automatically before `tauri dev` and `tauri build`. Linux build and environment-check scripts are described in [scripts/linux/README.md](scripts/linux/README.md).

### Tests

```bash
npm test          # front-end unit tests
npm run build     # type check + front-end build

cd src-tauri
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test
```

Every push and pull request runs [check.yml](.github/workflows/check.yml): the front-end tests and build, plus the Rust checks on Windows, macOS and Linux.

## Project layout

```text
src/                    Front end (React + TypeScript)
├── pages/              Main window pages
└── windows/            Companion, input box, annotation and other separate windows
src-tauri/              Native side (Rust)
├── src/os/<platform>/  Per-platform native code: recording, window control, launch at login, etc.
└── snapshot-recorder/  macOS recording sidecar (Swift + ScreenCaptureKit)
scripts/                Build scripts; linux/ holds Linux dependency and packaging scripts
docs/                   Documentation
```

### Implementation principles

Capabilities the operating system owns (recording, window control and so on) are implemented separately on each platform with its native APIs, rather than settling for a lowest common denominator for the sake of uniform code. Everything that does not depend on the OS (settings, history, polishing, UI) is shared.

Recording is how this came about: all three platforms once shared ffmpeg, and on Windows `gdigrab` recorded hardware-accelerated windows as black frames. Each platform now uses:

| Platform | Recording |
|---|---|
| Windows | Windows.Graphics.Capture + Media Foundation |
| macOS | ScreenCaptureKit window stream + AVAssetWriter |
| Linux | portal ScreenCast + PipeWire → ffmpeg in Wayland sessions; ffmpeg `x11grab` in X11 sessions |

Linux picks the backend from the session type, not from `$DISPLAY`: XWayland sets `$DISPLAY`, but `x11grab` cannot see native Wayland windows, so a Wayland session falls back to `x11grab` only when the portal is unavailable.

Conversely, where platforms differ only in API names and not in results, a mature cross-platform library is used. Window capture, for example, uses xcap everywhere, which is itself three native implementations.

Every extra implementation is another place for bugs that only reproduce on one kind of machine, and behavior drifts between platforms over time. Verification, not implementation, is the real bottleneck: a native path never tried on real hardware is not necessarily more reliable than a portable one that has been.

## Releases

Pushing a `v*` tag runs [release.yml](.github/workflows/release.yml). It builds on native runners for each platform (macOS universal, Windows x64 / ARM64, Linux x86_64 / aarch64 deb and AppImage), writes `SHA256SUMS.txt`, and creates a draft pre-release to be checked by hand before publishing. The Linux packages are built on Ubuntu 22.04 ([linux-packages.yml](.github/workflows/linux-packages.yml)), then installed and launched headless on both 22.04 and 24.04 before they reach the draft. The tag, the `VERSION` file and the version in `src-tauri/tauri.conf.json` must match.

## License

Copyright (C) 2026 Snapshot contributors

Released under the [GNU General Public License, version 3 or any later version](LICENSE) (GPL-3.0-or-later). You may use, modify and redistribute it; a modified version you distribute must also be released under the GPL, with its source code.
