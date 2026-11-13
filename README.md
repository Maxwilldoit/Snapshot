# Snapshot

[![Check](https://github.com/Maxwilldoit/Snapshot/actions/workflows/check.yml/badge.svg)](https://github.com/Maxwilldoit/Snapshot/actions/workflows/check.yml)

[简体中文](README.zh-CN.md) | English

Capture a window, copy or annotate it, and find it again in History.
Snapshot also records windows, rewrites and stores prompts, and provides a desktop companion.
Built with Tauri 2, React, and native adapters for Windows, macOS, and Linux.

## Features

- **Screenshots**: capture windows or the full screen; copy, annotate, or save only to History. Linux X11 also supports scrolling screenshots.
- **Recording**: record a selected window to MP4, with optional system audio and microphone input.
- **History**: screenshots and recordings share one searchable timeline, newest first. Prompt rewrites have their own page and keep the original, result, rule, and time.
- **Prompts**: rewrite clipboard text using an OpenAI-compatible endpoint and reusable rules. API keys stay in the operating system credential store. A separate Prompt library stores text you want to reuse.
- **Companion**: show the active app icon or import GIF/WebM actions. Optional roaming, random actions, gravity, and a right-click quick menu keep tools within reach. Windows and Linux also provide a launchpad.
- **Shortcuts**: bind common actions or pause global shortcuts without losing saved bindings.
- **Interface**: English and Simplified Chinese, with system light/dark appearance. Change language in General.

## Platform support

| Feature | Windows | macOS | Linux |
|---|:-:|:-:|:-:|
| Window and fullscreen capture | ✓ | ✓ | ✓ |
| Window recording | ✓ | ✓ | ✓ |
| System audio and microphone | ✓ | macOS 15+ for microphone | ✓ |
| Scrolling capture | — | — | X11 only |
| History, annotation, prompt rewriting and library, companion | ✓ | ✓ | ✓ |
| Launchpad | ✓ | — | ✓ |
| Launch at login | ✓ | ✓ | ✓ |
| Global shortcuts | ✓ | ✓ | Depends on the desktop session |

Capabilities are detected at runtime. Windows has received the most hardware testing; remaining platform checks are tracked in [docs/pending-device-verification.md](docs/pending-device-verification.md).

## Install

Download the package for your platform from [Releases](https://github.com/Maxwilldoit/Snapshot/releases).

| Platform | Package |
|---|---|
| Windows 10/11 | x64 or ARM64 installer |
| macOS 14+ | Universal ZIP for Apple Silicon and Intel |
| Ubuntu 22.04+ / Debian 12+ | x86_64 or aarch64 `.deb` |
| Other Linux distributions | x86_64 or aarch64 AppImage, glibc 2.35+ |

The packages are not code-signed or notarized. On macOS, Control-click the app and choose **Open** the first time. On Windows, SmartScreen may show a warning. Windows 10 downloads the WebView2 runtime during installation when needed.

macOS requires Screen Recording permission to list windows, capture, and record, Accessibility permission to restore minimized windows, and Microphone permission for audio recording. If the window picker requests access, use **Open System Settings** to allow Snapshot under **Privacy & Security → Screen Recording**, then choose **Reload windows**. If access is already enabled but windows still cannot be read, quit and reopen Snapshot. Missing access is shown as a permission request rather than an empty window list.

If access is still required after updating and restarting, an old ad-hoc signature may no longer match the saved authorization. Select the old Snapshot entry in Screen Recording settings, remove it with **−**, then use **+** to add `/Applications/snapshot.app` and enable access. Quit and reopen Snapshot. There is no need to reset permissions for other apps.

### Linux dependencies

Windows and macOS need no additional runtime tools. Install these Linux tools as needed:

| Tool | Purpose |
|---|---|
| `ffmpeg` | Window recording and pointer-inclusive still capture |
| `pactl` | System audio and microphone recording through PulseAudio or PipeWire-Pulse |
| `xdotool` | Restoring minimized windows and scrolling capture |
| StatusNotifierHost | System tray; GNOME requires the AppIndicator extension |

See [scripts/linux/README.md](scripts/linux/README.md) for distribution details and build dependencies.

## Use

- **Capture**: use the capture control, the companion's quick menu, or a global shortcut. In **Capture & Recording**, choose clipboard, annotation, or save-only behavior, and configure History, clipboard clearing, image format, and folders. Clipboard images clear after 60 seconds by default, unless replaced by something else.
- **Record**: choose a window from the recording menu. MP4 files go to Downloads by default; change the folder in **Capture & Recording**. Recordings appear alongside screenshots in **History**; the MP4 files stay in the recording folder.
- **Rewrite prompts**: configure the model and rules in **Prompts → Settings**, then rewrite clipboard text from the quick menu or its shortcut. Results appear in **Prompts**.
- **Reuse prompts**: open the Prompt library from Prompt History, the quick menu, or its shortcut (default `Ctrl/Cmd+Shift+P`). Search, edit, and copy entries without closing the window.
- **Companion**: import a GIF/WebM or ZIP from the sidebar, select a companion, and configure its desktop behavior on its page. On Windows and Linux, double-click it for the launchpad; macOS uses single clicks for actions.

## Companion assets

- Use one GIF or WebM per action. A file whose name contains `idle` or `待机` becomes the default pose.
- Files containing `walk`, `run`, `move`, `走`, or `跑` become walking actions. Include `left`/`左` or `right`/`右` in the filename to select a direction; the other direction is mirrored when only one is available.
- Painted backgrounds are removed from imported GIFs while interior colors such as a white shirt are preserved. WebM files should carry their own alpha channel.
- Archives are limited to 100 MB; individual animation files are limited to 50 MB.
- WebM should use VP9 with an alpha channel. It is played directly by the WebView; transparent playback support depends on the platform WebView.
- For GIFs, Snapshot measures the union of every frame's visible pixels during import, so a short pose or effect is never cropped because the first frame was smaller. A WebM keeps its full action canvas until one complete playback has been observed; the exact union is then cached for later runs.
- Actions with a larger canvas can use a `pet.json` file for a shared base canvas and foot anchors. The [Pets authoring guide](https://github.com/Maxwilldoit/Pets/blob/main/catalog/README.md#给素材作者按事件设计动作) documents the format.
- GIF/WebM companions without an authored layout automatically adapt their default size to the visible content of the idle animation. Large transparent margins are compensated up to 2×, and the result is reused across actions and restarts. Packages with `pet.json` keep their authored proportions. A manual **Size at 100%** adjustment affects only the current companion; **Auto fit** restores its automatic baseline.

## Build from source

Requirements: Node.js 22, Rust 1.98.1, the [Tauri 2 prerequisites](https://v2.tauri.app/start/prerequisites/) for your platform, and a Swift toolchain on macOS for the ScreenCaptureKit recorder.

```bash
nvm use
npm ci
npm run tauri dev
npm run tauri build
```

Local macOS `build` / `bundle` commands use the single valid **Apple Development** identity in Keychain to keep the authorization identity stable across updates. If none or several exist, the build stops and asks you to select one. Set `APPLE_SIGNING_IDENTITY="certificate name or fingerprint" npm run tauri build` to use another installed identity. Do not re-sign the resulting bundle with `codesign --sign -`. CI builds and explicit `APPLE_SIGNING_IDENTITY=-` can still produce ad-hoc bundles, but replacing an installed app may require reauthorization as described above; these bundles are not notarized.

On Debian or Ubuntu, `sudo bash scripts/linux/install-deps.sh` installs the required build and runtime packages.

## Validation

```bash
nvm use
npm ci
npm run check              # frontend tests, translations, build, Rust fmt/Clippy/tests
npm run check:frontend     # frontend portion only
npm run check:rust         # Rust portion only; prepares the macOS recorder when needed
npm run check:unused       # Knip dead-code report
npm audit --audit-level=moderate
```

CI uses the same check entry points on macOS, Windows, Ubuntu 22.04, and Ubuntu 24.04, plus dependency audits. Browser preview (`npm run dev`, optionally `?demo`) uses mock data; native capture, recording, and permissions require platform smoke checks.

See [AGENTS.md](AGENTS.md) for the code map, [DESIGN.md](DESIGN.md) for interface rules, and [docs/SIMPLIFY.md](docs/SIMPLIFY.md) for current simplification checkpoints and recovery commands.

## Project structure

```text
src/
├── pages/              Main window pages
├── windows/            Companion, quick menu, annotation, launchpad, and library windows
└── i18n/               English UI messages and coverage checks
src-tauri/
├── src/os/<platform>/  Platform-specific capture, recording, input, and startup code
└── snapshot-recorder/  macOS ScreenCaptureKit recorder
scripts/                 Build, packaging, and localization checks
docs/                    Platform verification notes and screenshots
```

Shared product behavior lives in the React and Rust application layers. Features owned by the operating system use native APIs per platform, including Windows.Graphics.Capture with Media Foundation, ScreenCaptureKit with AVAssetWriter on macOS, and portal/PipeWire or ffmpeg on Linux.

## Releases

Pushing a `v*` tag runs the release workflow. It builds macOS universal, Windows x64/ARM64, and Linux x86_64/aarch64 packages, validates the Linux packages on Ubuntu 22.04 and 24.04, writes `SHA256SUMS.txt`, and creates a draft GitHub release for final review.

## License

Copyright (C) 2026 Snapshot contributors.

Released under the [GNU General Public License, version 3 or later](LICENSE) (GPL-3.0-or-later). Modified versions distributed to others must also be released under the GPL with corresponding source code.
