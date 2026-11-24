# Snapshot

Snapshot's main workflow is capture → copy or annotate → find it in History. Recording,
clipboard history, prompt rewriting, saved prompts, and the desktop companion support
their own contexts.

## Map

- `src/app/`: application context, navigation, and toolbar.
- `src/pages/`: main-window pages (`History`, `Clipboard`, `Prompts`, `PromptLibrary`, `Trash`, `Capture`, `Shortcuts`, `Pet`). Keep page-specific code with its page.
- `src/components/`: shared views (`PhotoViewer`, `HoverPreview`, `JustifiedGrid`, `RulesPanel`, etc.) and accessible controls.
- `src/windows/`: standalone windows (`PetWindow`, `QuickMenuWindow`, `AnnotateWindow`, `PetCatalogWindow`, and non-macOS `LaunchpadWindow`).
- `src/lib/`, `src/hooks/`: pure domain logic and React integrations.
- `src/styles/`: design tokens (`variables.css`), main/library app surface (`main-window.css`, `library.css`), and shared window/component rules (`app.css`, `src/styles.css`).
- `src/i18n/messages/`: English translations of Chinese source strings; backend errors have a separate catalog.
- `src-tauri/src/`: shared Rust application behavior; `os/{macos,windows,linux}` owns native adapters.
- `src-tauri/snapshot-recorder/`: macOS ScreenCaptureKit sidecar.
- `scripts/`: checks, contract snapshots, packaging, and platform smoke tests.
- `DESIGN.md`: current visual tokens, layout frame, and interaction rules.

## Engineering principles

1. **No legacy code shims; protect active user data and fault tolerance.** Delete obsolete code, retired windows, dead IPC commands, and one-off migration shims outright — no compatibility wrappers or dead fallbacks. Keep currently active user data files (`settings.json`, `index.json`, `saved-prompts.json`, `clipboard-history.json`, Keychain) readable via `#[serde(default)]`, and preserve runtime OS/IO fault tolerance (atomic writes, missing tray/portal graceful degradation).
2. **Long-term boundaries, simplest implementation.** Make architectural decisions (process boundaries, protocols, data schemas, module ownership) for the long term — no throwaway "fix it later" hacks. Inside each boundary, write the simplest direct implementation that satisfies current requirements without speculative abstractions or "just in case" config layers.
3. **Layered growth; don't break what works.** Build end-to-end minimal slices first, then layer capabilities on top. Never tear down a working, tested module (such as `PhotoViewer`, `AnnotateWindow` crop/coordinate math, `JustifiedGrid`, or transparent WebM compositing) merely for hypothetical future complexity.
4. **Modular separation of concerns.** Separate pure calculation/state models, React presentation, and native OS adapters. Keep one source of truth for each behavior and setting while allowing context-appropriate entry points.
5. **Inspect existing dependencies and proven patterns first.** Before writing custom infrastructure or adding packages, check what `Cargo.toml` and `package.json` already provide, and check how mature desktop reference apps solve the same interaction problem. Prefer maintained libraries for new infrastructure without churning lean, verified domain code.

## Commands

Use Node 22+ (`nvm use`), Rust from `rust-toolchain.toml`, and `npm ci`.

- `npm run check`: frontend tests, translations, production build, Knip, Rust format, Clippy, and tests.
- `npm run check:frontend` / `npm run check:rust`: the same checks split for CI.
- `npm run check:i18n`: translation coverage (zero missing and zero unreferenced strings).
- `npm run check:unused`: Knip report; preserve code used by platform adapters and tests.
- `npm run dev`: browser preview with an in-memory mock backend; `?demo` (`?demo&os=macos`) adds sample content.
- `npm run tauri dev`: native development app. Uses isolated dev directories when configured; browser preview is faster for visual iteration.
- `bash scripts/contract-snapshot.sh`: inspect IPC command/event names, settings fields, window labels, and storage keys before/after a change.

## Change rules

- Remove explanatory copy only when layout, controls, and state still make the task self-evident.
- Preserve accessible labels, keyboard focus, permission recovery, and actionable errors.
- Update Chinese and English together.
- Capturing a screenshot always copies to the clipboard and saves to History. Do not introduce flags that skip copying or saving.
- Companion global scale and per-asset base scale have different scopes. The two autonomy hooks (`usePetAutonomy`, `usePetBehaviorAutonomy`) are mutually gated; do not merge them just because they share a caller.
- Preserve all four CI runners (macOS, Windows, Ubuntu 22.04, Ubuntu 24.04). Linux checks cannot compile or validate macOS/Windows adapters.

## Verification and recovery

Make each complete task a separate commit on a `codex/` branch and leave `main` intact.
Run relevant tests while editing and `npm run check` before accepting each batch.
Compare affected pages in Chinese and English using the browser preview, including keyboard interaction, empty states, and failure states. Native capture, recording, window levels, and transparency require separate smoke checks; record unavailable hardware checks in `docs/pending-device-verification.md`.
Use `git revert <commit>` to undo an accepted batch cleanly without rewriting history.
