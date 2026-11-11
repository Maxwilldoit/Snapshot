# Snapshot

Snapshot's main workflow is capture → copy or annotate → find it in History. Recording,
prompt rewriting, saved prompts, and the desktop companion support their own contexts.
Keep existing capabilities and user data compatible while simplifying their presentation.

## Map

- `src/app/`: application context, navigation, toolbar, capture controls.
- `src/pages/`: main-window pages. Keep page-specific code with its page.
- `src/components/`: shared views and accessible controls.
- `src/windows/`: companion, quick menu, annotation, launchpad, and library windows.
- `src/lib/`, `src/hooks/`: pure behavior and React integrations.
- `src/i18n/messages/`: English translations of Chinese source strings; backend errors have a separate catalog.
- `src-tauri/src/`: shared Rust application behavior; `os/{macos,windows,linux}` owns native adapters.
- `src-tauri/snapshot-recorder/`: macOS ScreenCaptureKit sidecar.
- `scripts/`: checks, contract snapshots, packaging, and platform smoke tests.
- `docs/SIMPLIFY.md`: current simplification scope, checkpoints, results, and deferred work.
- `DESIGN.md`: existing visual tokens and interaction rules.

## Commands

Use Node 22 (`nvm use`), Rust from `rust-toolchain.toml`, and `npm ci`.

- `npm run check`: frontend tests, translations, production build, Rust format, Clippy, and tests.
- `npm run check:frontend` / `npm run check:rust`: the same checks split for CI.
- `npm run check:i18n`: translation coverage.
- `npm run check:unused`: Knip report; preserve code used by platform adapters and tests.
- `npm run dev`: browser preview with an in-memory mock backend; `?demo` adds sample content.
- `npm run tauri dev`: native development app. This uses real app data; browser preview is safer for visual iteration.
- `bash scripts/contract-snapshot.sh`: capture IPC command/event names, settings fields, window labels, and storage keys before/after a refactor.

## Change rules

- Keep one source for each behavior and setting; allow context-appropriate entry points.
- Remove explanatory copy only when the layout, controls, and state still make the task clear.
- Preserve labels, keyboard focus, permission recovery, and actionable errors.
- Update Chinese and English together. Static scans do not prove dynamically selected text is unused.
- Do not rename serialized settings, IPC names, window labels, or storage keys during a structural refactor.
- `afterCapture` is `clipboard | annotate | saveas`. `saveas` always saves to History, even when `autoSaveLocal` is false. Do not introduce a hidden flag that makes a visible Copy selection skip copying.
- Companion global scale and per-asset base scale have different scopes. The two autonomy hooks are mutually gated; sharing a caller alone is not a reason to merge them.
- Preserve all four CI runners. Linux checks cannot compile or validate macOS/Windows adapters.

## Verification and recovery

Make each complete task a separate commit on a `codex/` branch. Leave `main` intact.
Run relevant tests while editing and `npm run check` before accepting each batch.
For a refactor, compare contract snapshots; explain any intended difference.
Compare affected pages before/after in English and Chinese using the browser preview,
including keyboard interaction, empty states, and failure states. Native capture/recording
requires separate smoke checks; a mocked preview does not establish platform correctness.
Record unavailable hardware checks in `docs/pending-device-verification.md`.

Use `git revert <commit>` to undo an accepted batch without rewriting history. The initial
simplification snapshot is tagged `backup/simplify-20261111`. To inspect it safely, create a
new recovery branch from the tag; do not reset or clean a working tree with unrelated edits.
