# Snapshot interface

## Purpose

Make capture, copy/annotation, and retrieval easy to see and complete. Recording,
prompts, and companion controls appear in their relevant context. Use the current
desktop visual language; this work does not introduce a new theme or UI framework.

## Existing tokens

`src/styles/variables.css` defines shared tokens. `src/styles/main-window.css`
defines the native app surface and aliases those shared tokens to its palette.
Main, Prompt library, and Pet Gallery use that surface; transparent windows retain
their existing palette. Native app tokens are `--win`, `--pane`, `--group`,
`--text1` through `--text4`, `--accent`, `--sep`, `--fill`, `--btn`, and `--red`.
Reuse these mappings rather than introducing a third palette. Shared tokens:

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

- Sidebar contains navigation only; capture and recording are reached through the pet
  quick menu and global shortcuts. Page headers contain the page title and local actions.
- Each pet row has a deselectable toggle dot left of the name: pressing it shows that pet
  on the desktop, pressing the selected one hides the desktop pet entirely (the app keeps
  running). The rest of the row opens the detail page. The dot is an `aria-pressed` toggle
  button, not a standard radio, because it can be deselected.
- Pages use the existing `mw-page`, `mw-toolbar`, `mw-scroll`, `panel`, `row`, `btn`,
  `tb-btn`, `input`, and dialog patterns. Independent windows may reuse these visual
  primitives without importing main-window context or navigation.
- Toolbar actions are uniform icon buttons: no background until hover or an expanded
  state, a tooltip and an accessible label on every one. A clear gap separates page
  actions from the window controls. Toolbar search stays collapsed to an icon until
  focused (click, Tab, or Ctrl/Cmd+F) and stays open while it holds a query.
- Hierarchy comes from position, type, and whitespace. Avoid decorative cards,
  gradients, slogans, sequence numbers, and permanent metadata counters.
- An empty collection shows a title and an actionable primary button. A shortcut
  accompanies the action only when it is bound and enabled.
- Prompt model/rule controls belong with Prompt history; general preferences hold
  app-wide settings. Recording audio choices belong at the recording entry point.
- Saved prompts live on the Prompt Library page in the main window. The quick menu
  and existing global library shortcut focus that page. Keep one New action in each
  state and leave it unbound; search and save retain their keyboard commands. Page
  navigation preserves unfinished drafts without letting hidden editors handle keys.

## Interaction and text

- Button labels describe actions. State labels explain the current result.
- Every control keeps default, hover, visible keyboard focus, and disabled states.
- Keep accessible labels when removing visible hints. A dash may mean an unbound
  shortcut only inside an obvious, keyboard-operable shortcut control.
- Keep recoverable errors and permission actions. Disabled functionality needs a
  discoverable reason, not a silent disappearance.
- Remove success notices only when the resulting control or content visibly confirms
  success. Recordings now land in History (mixed with screenshots by time), so stopping
  a recording dismisses the quick menu without a completion toast; keep the busy and
  error feedback while saving.
- Preserve persistent field labels. Placeholders provide optional examples, not labels.
- Preserve meaningful time, selection, and position information; show secondary metadata
  on demand only when the interaction remains discoverable and keyboard accessible.
- Keep Chinese and English terminology consistent: 历史/History, 截图/Screenshot,
  录屏/Recording, 长截图/Scrolling screenshot. Use Window/Fullscreen where the
  distinction changes behavior.

## Motion

- Page changes animate the content area and the navigation mark only. On a transparent
  native surface (macOS sidebar vibrancy) the old root view-transition snapshot must stay
  hidden: that bitmap loses the material underneath and paints the sidebar as a pale
  opaque plate. Keep the sidebar and title bar live; hide `::view-transition-old(root)`
  for page transitions and let the `page` and `nav-mark` groups carry the motion.

## Validation

Use the native main-window dimensions (960×580, minimum 820×520) for browser visual
comparison, and check the affected UI in both languages. Use preview fixtures rather
than personal app data. Record screenshots and viewport details in the simplification
log. Browser screenshots validate presentation; native smoke checks validate OS behavior.
