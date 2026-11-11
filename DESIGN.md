# Snapshot interface

## Purpose

Make capture, copy/annotation, and retrieval easy to see and complete. Recording,
prompts, and companion controls appear in their relevant context. Use the current
desktop visual language; this work does not introduce a new theme or UI framework.

## Existing tokens

`src/styles/variables.css` is the source of truth:

- Surfaces: `--paper`, `--paper-raised`, `--paper-sunk`.
- Text: `--ink`, `--ink-2`, `--ink-3`, `--ink-4`; `--ink-fill` for filled controls.
- Borders: `--rule`, `--rule-soft`, `--rule-strong`.
- Destructive/error/recording state: `--signal`, `--signal-soft`.
- Fonts: `--font-sans`, `--font-mono`.
- Type sizes: `--text` (13px), `--text-small` (12px), `--text-lead` (15px).
- Existing spacing: 4/8/12/16/20/24/32px. Reuse adjacent component spacing.
- Motion: `--t-press`, `--t-fade`, `--t-open`, `--t-exit`, and existing easing variables.

The app follows system light/dark colors. Preserve token-driven dark colors and
existing reduced-motion handling. Reuse current Lucide icons and button styles.

## Layout and components

- Sidebar contains navigation. A stable capture/record control belongs in the main
  window shell; page headers contain the page title and local actions.
- Pages use the existing `mw-page`, `mw-toolbar`, `mw-scroll`, `panel`, `row`, `btn`,
  `tb-btn`, `input`, and dialog patterns. Independent windows may reuse these visual
  primitives without importing main-window context or navigation.
- Hierarchy comes from position, type, and whitespace. Avoid decorative cards,
  gradients, slogans, sequence numbers, and permanent metadata counters.
- An empty collection shows a title and an actionable primary button. A shortcut
  accompanies the action only when it is bound and enabled.
- Prompt model/rule controls belong with Prompt history; general preferences hold
  app-wide settings. Recording audio choices belong at the recording entry point.

## Interaction and text

- Button labels describe actions. State labels explain the current result.
- Every control keeps default, hover, visible keyboard focus, and disabled states.
- Keep accessible labels when removing visible hints. A dash may mean an unbound
  shortcut only inside an obvious, keyboard-operable shortcut control.
- Keep recoverable errors and permission actions. Disabled functionality needs a
  discoverable reason, not a silent disappearance.
- Remove success notices only when the resulting control or content visibly confirms
  success. Keep recording completion feedback until recordings have a visible home.
- Preserve persistent field labels. Placeholders provide optional examples, not labels.
- Preserve meaningful time, selection, and position information; show secondary metadata
  on demand only when the interaction remains discoverable and keyboard accessible.
- Keep Chinese and English terminology consistent: 截图/Screenshot, 录屏/Recording,
  长截图/Scrolling screenshot. Use Window/Fullscreen where the distinction changes behavior.

## Validation

Use the native main-window dimensions (960×580, minimum 820×520) for browser visual
comparison, and check the affected UI in both languages. Use preview fixtures rather
than personal app data. Record screenshots and viewport details in the simplification
log. Browser screenshots validate presentation; native smoke checks validate OS behavior.
