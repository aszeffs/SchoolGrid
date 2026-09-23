---
name: SchoolGrid
description: An official school record, set calm and hyperlegible, with one seal blue for what can be acted on and what is current.
colors:
  page: "#f7f8fa"
  band: "#eceff4"
  field: "#ffffff"
  ink: "#18202e"
  ink-soft: "#4a5467"
  seal: "#234aa6"
  seal-strong: "#1a3a88"
  on-seal: "#ffffff"
  alarm: "#a3262d"
  rule: "color-mix(in srgb, #18202e 22%, transparent)"
  rule-faint: "color-mix(in srgb, #18202e 11%, transparent)"
  wash: "color-mix(in srgb, #18202e 5%, transparent)"
  wash-seal: "color-mix(in srgb, #234aa6 8%, transparent)"
  dark-page: "#12161d"
  dark-band: "#1a1f28"
  dark-field: "#0d1016"
  dark-ink: "#e5e8ee"
  dark-ink-soft: "#a4adbb"
  dark-seal: "#8eaefc"
  dark-seal-strong: "#b3c8ff"
  dark-on-seal: "#0d1321"
  dark-alarm: "#ff9d97"
  dark-rule: "color-mix(in srgb, #e5e8ee 20%, transparent)"
  dark-rule-faint: "color-mix(in srgb, #e5e8ee 10%, transparent)"
  dark-wash: "color-mix(in srgb, #e5e8ee 6%, transparent)"
  dark-wash-seal: "color-mix(in srgb, #8eaefc 12%, transparent)"
typography:
  display:
    fontFamily: "Atkinson Hyperlegible Next, system-ui, sans-serif"
    fontSize: "2rem"
    fontWeight: 700
    lineHeight: 1.15
    letterSpacing: "-0.02em"
  headline:
    fontFamily: "Atkinson Hyperlegible Next, system-ui, sans-serif"
    fontSize: "1.75rem"
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "-0.015em"
  title:
    fontFamily: "Atkinson Hyperlegible Next, system-ui, sans-serif"
    fontSize: "1.375rem"
    fontWeight: 700
    lineHeight: 1.3
    letterSpacing: "-0.01em"
  lead:
    fontFamily: "Atkinson Hyperlegible Next, system-ui, sans-serif"
    fontSize: "1.125rem"
    fontWeight: 700
    lineHeight: 1.35
  body:
    fontFamily: "Atkinson Hyperlegible Next, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.55
  label:
    fontFamily: "Atkinson Hyperlegible Next, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 650
    lineHeight: 1.5
  small:
    fontFamily: "Atkinson Hyperlegible Next, system-ui, sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 650
  figures:
    fontFamily: "Atkinson Hyperlegible Mono, ui-monospace, monospace"
    fontSize: "0.8125rem"
    fontWeight: 400
    fontFeature: "tnum"
rounded:
  corner: "4px"
  fine: "2px"
  disc: "50%"
spacing:
  step: "8px"
  half: "4px"
  step-1-5: "12px"
  step-2: "16px"
  step-3: "24px"
  step-4: "32px"
  step-6: "48px"
  step-8: "64px"
  gutter: "clamp(1rem, 4vw, 2.5rem)"
  measure: "68ch"
  frame: "78rem"
components:
  button-primary:
    backgroundColor: "{colors.seal}"
    textColor: "{colors.on-seal}"
    typography: "{typography.body}"
    rounded: "{rounded.corner}"
    padding: "0 20px"
    height: "2.75rem"
  button-primary-hover:
    backgroundColor: "{colors.seal-strong}"
    textColor: "{colors.on-seal}"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.seal}"
    rounded: "{rounded.corner}"
    padding: "0 20px"
    height: "2.75rem"
  button-ghost-hover:
    backgroundColor: "{colors.wash-seal}"
    textColor: "{colors.seal-strong}"
  button-quiet:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    rounded: "{rounded.corner}"
    padding: "0 14px"
    height: "2.5rem"
  button-quiet-hover:
    backgroundColor: "{colors.wash-seal}"
    textColor: "{colors.seal-strong}"
  button-stamp:
    backgroundColor: "transparent"
    textColor: "{colors.alarm}"
    typography: "{typography.label}"
    rounded: "{rounded.corner}"
    padding: "0 14px"
    height: "2.75rem"
  button-disabled:
    backgroundColor: "transparent"
    textColor: "{colors.ink-soft}"
    rounded: "{rounded.corner}"
  input:
    backgroundColor: "{colors.field}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.corner}"
    padding: "9px 12px"
    height: "2.75rem"
  role-label:
    backgroundColor: "transparent"
    textColor: "{colors.seal}"
    typography: "{typography.small}"
    rounded: "{rounded.fine}"
    padding: "1px 7px"
  tab:
    backgroundColor: "transparent"
    textColor: "{colors.ink-soft}"
    typography: "{typography.label}"
    rounded: "{rounded.corner}"
    padding: "0 16px"
    height: "2.75rem"
  tab-current:
    backgroundColor: "{colors.page}"
    textColor: "{colors.ink}"
  switcher:
    backgroundColor: "{colors.field}"
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    rounded: "{rounded.corner}"
    padding: "0 14px"
    height: "2.5rem"
  mark-filled:
    backgroundColor: "{colors.seal}"
    textColor: "{colors.seal}"
    rounded: "{rounded.disc}"
    size: "0.625rem"
  mark-open:
    backgroundColor: "transparent"
    textColor: "{colors.seal}"
    rounded: "{rounded.disc}"
    size: "0.625rem"
  mark-struck:
    backgroundColor: "transparent"
    textColor: "{colors.ink-soft}"
    rounded: "{rounded.disc}"
    size: "0.625rem"
  record-head:
    textColor: "{colors.ink-soft}"
    typography: "{typography.label}"
    padding: "0 12px 8px 8px"
  record-cell:
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    padding: "12px 12px 12px 8px"
  slip:
    backgroundColor: "{colors.field}"
    textColor: "{colors.ink}"
    padding: "24px"
  notice:
    backgroundColor: "{colors.wash-seal}"
    textColor: "{colors.ink}"
    rounded: "{rounded.corner}"
    padding: "12px 16px"
  error:
    textColor: "{colors.alarm}"
    rounded: "{rounded.corner}"
    padding: "10px 14px"
  empty:
    backgroundColor: "transparent"
    textColor: "{colors.ink-soft}"
    rounded: "{rounded.corner}"
    padding: "32px 16px"
---

# Design System: SchoolGrid

## Overview

**Creative North Star: "The School Report"**

Every screen reads as an official school record: whom it concerns, who is acting, and what was recorded, in that order. The reading field is calm and nearly colourless, cool near-white in light and deep slate in dark, and a single seal blue marks what can be acted on and what is current. Colour lives in hairline edges and seal marks, never in large fills beyond the one primary button.

The page is a report: a full-width band carries the wordmark, the School's name set as the largest type on the page, "Signed in as" with the roles held, and the section tabs; the current tab is lifted onto the page and wears the seal along its top edge. Below, a narrow key sits at the left edge beside a wide ruled record. Density is comfortable, not cramped: 44px controls, ruled rows at least 56px tall on rosters, and a 68ch reading measure.

The system refuses the portal default (white cards on grey behind a left rail) and any themed costume, including the ditto sheet it replaced. There are two renditions, light and dark, and the browser's own setting picks between them (ADR-0010); there is no manual toggle.

**Key Characteristics:**
- One hyperlegible sans for words, its mono cut for identifiers and codes, tabular figures in records.
- One hue (seal blue) for action, current place and state marks; alarm red only for errors and actions that take something away.
- State is always a word with a mark beside it: filled, ringed or struck disc.
- Ruled, flat surfaces: hairlines and a one-step tonal band, no shadows.
- A fixed type scale that does not grow with the window.
- Every colour is a token defined for both renditions.

## Colors

A cool achromatic reading field with a single seal blue, and a sanctioned alarm red held back for loss and error. Each role has a light value and a dark value (`dark-*` in the frontmatter) swapped under `prefers-color-scheme: dark`.

### Primary
- **Seal Blue** (`seal`; dark `dark-seal`): primary buttons, links, the lifted tab's top edge, the wordmark's ruled square, role labels, focus rings, text caret, checkbox accent, and filled and ringed state marks. In dark it lightens so it still clears 4.5:1 as text.
- **Deep Seal** (`seal-strong`; dark `dark-seal-strong`): hover for primary buttons and links, and hover text on ghost and quiet buttons.
- **On Seal** (`on-seal`; dark `dark-on-seal`): text on a filled seal button. White in light, near-black navy in dark, where the button fill is pale.

### Secondary
- **Alarm Red** (`alarm`; dark `dark-alarm`): the one sanctioned exception to the single hue. It appears only in the error block and on stamp buttons (actions that end, revoke or remove). It is used as text and outline, with at most a 9 to 10% wash behind; it never fills a control.

### Neutral
- **Page** (`page`; dark `dark-page`): the reading plane, and the ground of the current tab.
- **Band** (`band`; dark `dark-band`): the report head and tab row, and `pre` blocks; one step cooler (light) or lifted (dark) from the page.
- **Field** (`field`; dark `dark-field`): inputs, the switcher button and its list, and the slip. White in light; darker than the page in dark, so fields read as wells.
- **Ink** (`ink`; dark `dark-ink`): body text, headings, current tab text.
- **Soft Ink** (`ink-soft`; dark `dark-ink-soft`): secondary text: the key's prose, column heads, fact terms, counts, identifiers, unmarked state words, struck marks, disabled text.
- **Rule** (`rule`): section hairlines, control borders, record header underline, ringed-mark default.
- **Faint Rule** (`rule-faint`): row dividers inside records and rosters, fieldset tops, the foot's hairline, phone tab grid gaps.
- **Wash** (`wash`): hover on record rows and inactive tabs; inline code ground; the loading placeholder title bar.
- **Seal Wash** (`wash-seal`): notice ground, and hover on ghost and quiet buttons and switcher entries.

### Named Rules
**The One Seal Rule.** Seal blue is the only hue in the system. It marks what can be acted on, what is current, and what state a record is in. No second accent, no status greens or ambers.

**The Alarm Exception Rule.** Alarm red is sanctioned for two things only: an error, named in words, and an action that takes something away (the stamp button and the confirming button in a removal slip). It is text and outline; it is never a fill and never the only signal.

**The Two Renditions Rule.** Every colour is a token defined for both light and dark. A rule that names a raw colour breaks one of the renditions.

## Typography

**Body Font:** Atkinson Hyperlegible Next (variable 200 to 800, self-hosted, with system-ui, sans-serif)
**Label/Mono Font:** Atkinson Hyperlegible Mono (variable 200 to 800, self-hosted, with ui-monospace, monospace)

**Character:** A face drawn for readers with low vision, where I l 1, O 0 and rn m are told apart; it carries every heading and every word, so the School's name and a Person's name are read without doubt. The mono cut sets identifiers, action codes and inline code so columns of them line up.

### Hierarchy
- **Display** (700, 2rem, 1.15, -0.02em): the School's name in the report head only; the largest type on any School page. Drops to 1.375rem below 52rem.
- **Headline** (700, 1.75rem, 1.2, -0.015em, balanced wrap): the page title (`h1`).
- **Title** (700, 1.375rem, 1.3, -0.01em): section headings (`h2`) and the slip's heading.
- **Lead** (700, 1.125rem, 1.35): sub-sections (`h3`); roster names at 600.
- **Body** (400, 1rem, 1.55): running text, inputs, buttons (at 650), record cells. Paragraphs and plain lists hold to 68ch.
- **Label** (600 to 650, 0.875rem): form labels, column heads, fact terms, tabs, the key, state words, quiet and stamp buttons, the wordmark (at 750).
- **Small** (650, 0.8125rem): role labels; the stacked field names on phone records.
- **Figures** (Mono 400, 0.8125rem): identifiers under names and codes in records. Records set `tabular-nums` throughout.

### Named Rules
**The Fixed Ramp Rule.** One fixed scale (0.8125, 0.875, 1, 1.125, 1.375, 1.75, 2rem). A product's type does not grow with the window; the only responsive change is the School's name stepping down on a phone.

**The One Family Rule.** One sans for all words, bold for emphasis, its mono cut for figures. No second display face, no uppercase tracking labels.

## Layout

The page is a three-row grid: the report head band, the section tabs, and the body. The band and tabs run the full width with their contents held to a 78rem frame, padded by a fluid gutter (clamp(1rem, 4vw, 2.5rem)). The body is a two-column grid, the key at 11 to 14rem and the record in the rest, separated by 48px; the record column caps at 62rem. Screens with no key use a single column.

Spacing counts in an 8px step: 4, 6, 10, 12, 16, 20, 24, 32, 48 and 64px are the multiples in use. Headings open generous space above (48px before a section, 32px before a sub-section); forms stack at 20px and cap at 30rem.

There is one breakpoint, 52rem. Below it: the School's name keeps its line with Sign out held at its right; the switcher list opens inside the head, full width, pushing the tabs down rather than covering them; the tabs become ruled rows of pages, three to a row, edge to edge, with a short last row stretched to fill; the key moves below the record behind a rule; records stack each row into an entry whose values carry their own field names; forms stretch to full width.

The key (`legend`) is sticky at 24px from the top on wide screens, so it never scrolls away from the record it explains.

## Elevation & Depth

The system is flat. There are no shadows anywhere. Depth is tonal and ruled: the band sits one step off the page, hairlines close each part, and the current tab is "lifted" only by taking the page's ground and borders while the band's closing rule stops under it. The only things that sit over the page are the switcher list (field ground, rule border) and the slip dialog over a dark 55% veil.

### Named Rules
**The Ruled, Not Raised Rule.** Separate things with hairlines and the band's one tonal step, never with shadow or a floating card in the reading plane.

## Shapes

Gently squared: controls, fields, notices, errors, empty states, the switcher, `pre` blocks and the top corners of tabs share a 4px corner (`corner`). The wordmark's ruled square and the role labels use a finer 2px corner (`fine`). State marks are full discs (`disc`, 50%) at 0.625rem. The slip is square-cornered, its top edge a 3px seal rule. Borders are 1px hairlines; the seal edge on the lifted tab and slip is 3px; focus is a 3px seal outline offset 2px. Glyphs are drawn from borders and gradients, not icon fonts: the wordmark's ruled square is a bordered box crossed by two 2px seal lines, and the switcher chevron is two 2px borders rotated 45 degrees, turning to point the way the list opens.

## Components

### Buttons
Plain, firm, and never costumed.
- **Shape:** 4px corner, 44px tall (40px for quiet), 1px border.
- **Primary:** seal fill, on-seal text, body size at 650, 20px side padding. Hover goes to deep seal. Press drops 1px (90ms).
- **Ghost:** the second action beside a first: transparent, rule border, seal text. Hover lays the seal wash with a 55% seal border and deep seal text.
- **Quiet:** head actions such as Sign out and pager steps: transparent, rule border, ink text, label size at 600. Same hover as ghost.
- **Stamp:** an action that takes something away: transparent, 55% alarm border, alarm text, label size. Hover adds a 10% alarm wash and a full alarm border; its focus ring turns alarm.
- **Disabled (held):** transparent, dashed rule border, soft ink at 80%, not-allowed cursor, no hover or press. Pager steps that go nowhere use `aria-disabled` and draw the same way.
- **Focus:** 3px seal outline, 2px offset, on every interactive element.

### Role labels
Each role held in the School, beside "Signed in as": seal text at 0.8125rem 650, a 1px 45% seal border, 2px corner, no fill. Never a pill.

### Inputs / Fields
- **Style:** field ground, 1px rule border, 4px corner, 44px tall, body size at 400, soft-ink placeholder. Labels sit above at label size 650, 6px gap.
- **Hover:** border darkens to 40% ink.
- **Focus:** border turns seal, plus the 3px seal outline.
- **Checkbox:** 24px, seal accent, in a 36px row with its label at body size.
- **Fieldset:** no box; a faint rule on top and a label-size legend.

### Navigation: the lifted tab and the seal
Tabs sit in the band as report pages: label size 600, soft ink, 44px tall, 16px padding, 4px top corners. Hover lays the wash and inks the text. The current tab takes the page ground, a rule border on three sides, ink text, and the seal: a 3px seal bar along its top edge. There is only ever one seal; it is named for the view transition, so moving sections slides it to the new tab in 240ms on cubic-bezier(0.22, 1, 0.36, 1) while the page swaps in place without a fade. On a phone the tabs are a three-column grid of band cells separated by faint 1px gaps; the current cell takes the page ground and keeps its square seal.

### Switcher
The way to another School: a field-ground button with rule border, 4px corner, 40px tall, label size 600, and a border-drawn chevron. Its list opens under it, right-aligned, 14 to 22rem wide, field ground, rule border, 4px corner; entries pad 8px by 16px and take the seal wash on hover; the last entry sits behind a faint rule. On a phone the list opens in the head's flow at full width.

### Records
- **Record table:** full width, tabular figures. Column heads in soft ink, label size 650, bottom-aligned over a rule. Cells pad 12px, divided by faint rules; rows take the wash on hover. Times never wrap; identifiers break only at hyphens. Actions align right. Below 52rem each row becomes a stacked entry, its field names printed above each value at small size.
- **Roster:** a ruled list under a rule, rows at least 56px, name at lead size 600, a faint leader rule carrying the name across to its state (hidden on phone).
- **Facts:** a two-column term and value list under a rule; terms in soft ink at label size 650.
- **Identifier:** mono at small size in soft ink, set on its own line under the name it belongs to.
- **Loading:** the record's shape (a wash title bar and faint ruled rows) pulsing between full and 45% opacity over 1.6s; no spinner.

### State marks
State prints itself into the record as a word with a disc before it, label size 600.
- **Filled:** solid seal disc, seal word. Done, claimed, permitted ("Claimed", "May read", "Copied").
- **Open (ringed):** 2px seal ring, seal word. Open or still to come ("Open", "Unclaimed", "Starts later").
- **Struck:** soft-ink ring with a diagonal rule through it, soft-ink word. Withheld or ended ("May not read").
- **Bare:** a soft-ink word with a rule-coloured ring, neither.
An empty mark keeps its box (a live status region must not vanish), but draws no disc.

### The key
The narrow left column that explains the page's terms and marks: soft ink at label size, 1.5 line height, headed "Key" in ink at 700, terms in ink at 650. It never names a record.

### Slip / Dialog
A slip of record: field ground, 1px rule border, a 3px seal top edge, 24px padding, 12px internal gap, square corners. Inline it marks an issued Invitation; as the app's one overlay it is a native modal `<dialog>`, up to 34rem wide, centred, over a veil of near-black at 55%. A removal slip confirms with a stamp button.

### Notice
What a setting does or does not yet do, read before the record: seal wash ground, 25% seal border, 4px corner, 12px by 16px padding, ink text, 68ch measure.

### Error
A problem named in words: alarm text at 600, a 9% alarm wash behind and a 45% alarm border, 4px corner, 10px by 14px padding.

### Empty
An empty record says so in the place the record would be: a dashed rule border, 4px corner, 32px by 16px padding, centred soft-ink text.

## Do's and Don'ts

### Do:
- **Do** name every colour through a token that has both a light and a dark value.
- **Do** pair every state with a word and a filled, ringed or struck seal disc; the mark is never the only difference.
- **Do** keep seal blue for action, the current place, links, focus and marks, and nothing else.
- **Do** confine alarm red to errors and to actions that take something away, as text and outline.
- **Do** separate with 1px hairlines (`rule` for sections, `rule-faint` between rows) and the band's one tonal step.
- **Do** set identifiers in Atkinson Hyperlegible Mono and keep records in tabular figures.
- **Do** keep controls at least 44px tall (40px for quiet and switcher), with the 3px seal focus outline.
- **Do** draw a held control with a dashed rule border and softened words.
- **Do** let things settle in 200ms on cubic-bezier(0.22, 1, 0.36, 1), and honour reduced motion by dropping transitions and the seal slide.

### Don't:
- **Don't** use shadows, or float cards in the reading plane; the switcher list and the slip dialog are the only things over the page.
- **Don't** fill a control with alarm red, or use colour alone to carry state.
- **Don't** introduce a second accent hue or status colours (green, amber).
- **Don't** round role labels or tags into pills; they keep a 2px corner.
- **Don't** scale type with the viewport.
- **Don't** add a second typeface, uppercase tracked labels, or icon-font glyphs; draw small marks from borders.
- **Don't** put more than one seal edge in the tab row.
- **Don't** reach for an inline style; the Content Security Policy forbids it and the build fails on it.
