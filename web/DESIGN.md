---
name: SchoolGrid
description: The School's week, pinned in the staff room — every Course owns a colour, blocks sit on a quiet ground, and indigo marks what can be acted on and where you are.
colors:
  ground: "#f4f5f8"
  surface: "#ffffff"
  rail: "#eef0f5"
  ink: "#161b28"
  ink-soft: "#505a6e"
  action: "#4338ca"
  action-strong: "#3730a3"
  on-action: "#ffffff"
  action-wash: "#e8e7fb"
  alarm: "#b42318"
  rule: "#dfe2ea"
  rule-strong: "#c7ccd8"
  wash: "color-mix(in srgb, #161b28 4%, transparent)"
  veil: "rgb(22 27 40 / 0.45)"
  course-indigo: "#4338ca"
  course-rose: "#be123c"
  course-teal: "#0f766e"
  course-amber: "#b45309"
  course-violet: "#6d28d9"
  course-sky: "#0369a1"
  on-course: "#ffffff"
  dark-ground: "#0e1118"
  dark-surface: "#171b25"
  dark-rail: "#12151d"
  dark-ink: "#e8ebf2"
  dark-ink-soft: "#a3acbd"
  dark-action: "#a5b4fc"
  dark-action-strong: "#c7d0ff"
  dark-on-action: "#11142a"
  dark-action-wash: "#232846"
  dark-alarm: "#ff9b8f"
  dark-rule: "#262c3a"
  dark-rule-strong: "#394155"
  dark-course-indigo: "#4f46e5"
  dark-course-violet: "#7c3aed"
typography:
  title:
    fontFamily: "Atkinson Hyperlegible Next, system-ui, sans-serif"
    fontSize: "1.875rem"
    fontWeight: 750
    lineHeight: 1.15
    letterSpacing: "-0.02em"
  section:
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
  control: "10px"
  block: "12px"
  dialog: "16px"
  row: "8px"
  label: "6px"
  disc: "50%"
spacing:
  step: "8px"
  half: "4px"
  step-1-5: "12px"
  step-2: "16px"
  step-2-5: "20px"
  step-3: "24px"
  step-4: "32px"
  step-5: "40px"
  step-8: "64px"
  gutter: "clamp(1rem, 2.5vw, 2.5rem)"
  rail-width: "clamp(14rem, 18vw, 17rem)"
  measure: "68ch"
components:
  button-primary:
    backgroundColor: "{colors.action}"
    textColor: "{colors.on-action}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "0 20px"
    height: "2.75rem"
  button-primary-hover:
    backgroundColor: "{colors.action-strong}"
    textColor: "{colors.on-action}"
  button-ghost:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "0 20px"
    height: "2.75rem"
  button-quiet:
    backgroundColor: "transparent"
    textColor: "{colors.ink-soft}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "0 12px"
    height: "2.5rem"
  button-quiet-hover:
    backgroundColor: "{colors.wash}"
    textColor: "{colors.ink}"
  button-stamp:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.alarm}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "0 14px"
    height: "2.75rem"
  input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "9px 12px"
    height: "2.75rem"
  nav-item:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    rounded: "{rounded.row}"
    padding: "0 10px"
    height: "2.5rem"
  nav-item-current:
    backgroundColor: "{colors.action-wash}"
    textColor: "{colors.action-strong}"
  school-block:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "10px"
  role-label:
    backgroundColor: "{colors.action-wash}"
    textColor: "{colors.action-strong}"
    typography: "{typography.small}"
    rounded: "{rounded.label}"
    padding: "2px 8px"
  record-panel:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.block}"
  record-head:
    textColor: "{colors.ink-soft}"
    typography: "{typography.label}"
    padding: "10px 12px 10px 20px"
  record-cell:
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    padding: "10px 12px 10px 20px"
    height: "3.5rem"
  course-block:
    backgroundColor: "{colors.course-indigo}"
    textColor: "{colors.on-course}"
    rounded: "{rounded.block}"
    padding: "14px 16px 16px"
  dialog:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.dialog}"
    padding: "24px"
  key:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink-soft}"
    typography: "{typography.label}"
    rounded: "{rounded.block}"
    padding: "16px"
  notice:
    backgroundColor: "{colors.action-wash}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "12px 16px"
  panel:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.block}"
    padding: "clamp(16px, 3vw, 24px)"
    width: "30rem"
  empty:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink-soft}"
    rounded: "{rounded.block}"
    padding: "32px 16px"
---

# Design System: SchoolGrid

## Overview

**Creative North Star: "The Timetable Wall Chart"**

Every School runs on the week pinned in the staff room: each Course a coloured block, the grid between them white, and one glance tells you where everyone is. SchoolGrid is read the same way. A quiet grey ground carries white blocks lifted by one soft shadow; each Course owns one of six saturated colours and keeps it wherever its Class Offerings appear; indigo marks what can be acted on and where you are. The reading field itself stays neutral, so the words are always on white or deep ink, never on colour, except inside a Course's own block.

Inside a School the shell is a sidebar: the wordmark, the School on a raised block with its initials, the sections grouped under You, People, Academic and School, and at the foot who is acting and the way out. The sheet fills the rest of the window at any width, with the page's key as a block at its right once there is room for both. Density stays comfortable for use mid-lesson: 44px controls, 56px table rows.

It refuses the colourless "official record" it replaced and the anonymous grey-card admin panel. There are two renditions, light and dark, and the browser's setting picks between them (ADR-0010); there is no manual toggle.

**Key Characteristics:**
- One hyperlegible sans for every word, its mono cut for identifiers and codes, tabular figures in records.
- Indigo for action, the current place and state marks; six Course colours for Course identity only; alarm red for errors and removals.
- White blocks on a grey ground, one soft shadow step, generous 10 to 16px corners.
- State is a word with a mark: filled, ringed or struck disc; a held control is hatched.
- Layout in rem and fluid clamps, so it fills any window and follows the reader's zoom.

## Colors

A cool neutral ground with white blocks, indigo for action, and a six-colour Course set. Each role has a light value and a dark value (`dark-*`) swapped under `prefers-color-scheme: dark`.

### Primary
- **Indigo** (`action`; dark `dark-action`): primary buttons, links, the current section's glyph, the School badge, focus rings, caret, checkbox accent, filled and ringed state marks, and text selection. It lightens in dark so it clears 4.5:1 as text.
- **Deep Indigo** (`action-strong`): hover on primary buttons and links; current section and role label text.
- **Indigo Wash** (`action-wash`): the current section's row, role labels, notices, and hover on switcher entries.

### Secondary
- **The Course set** (`course-indigo`, `course-rose`, `course-teal`, `course-amber`, `course-violet`, `course-sky`): a Course's identity, as the fill of its block and the chip beside its name. Each carries `on-course` white words at 4.5:1 or better in both renditions. The wordmark uses four of them.
- **Alarm Red** (`alarm`): errors named in words and actions that take something away; text and outline on a white block, never a fill.

### Neutral
- **Ground** (`ground`): the plane every block sits on.
- **Surface** (`surface`): blocks: records, the key, dialogs, fields, the School block, secondary buttons, the top bars.
- **Rail** (`rail`): the sidebar.
- **Ink** / **Soft Ink** (`ink`, `ink-soft`): text; soft ink for secondary text, column heads, group headings, glyphs, placeholders.
- **Rule** / **Strong Rule** (`rule`, `rule-strong`): block edges and row dividers; control borders.
- **Wash** (`wash`): hover on rows and quiet buttons, the hatch on held controls, the loading placeholder.
- **Veil** (`veil`): behind a dialog, with a 3px blur.

### Named Rules
**The Course Colour Rule.** A Course colour means that Course and nothing else. Never use one for status, emphasis or decoration.

**The Neutral Reading Rule.** Running text sits on surface or ground. Only a Course's own block puts words on colour, and then only white words on its deep fill.

**The Two Renditions Rule.** Every colour is a token defined for both light and dark. A rule that names a raw colour breaks one of them.

## Typography

**Body Font:** Atkinson Hyperlegible Next (variable 200 to 800, self-hosted)
**Figures Font:** Atkinson Hyperlegible Mono (variable, self-hosted)

**Character:** A face drawn for readers with low vision, where I l 1, O 0 and rn m are told apart; it carries every heading and every word. The mono cut sets identifiers, codes and times so columns line up.

### Hierarchy
- **Title** (750, 1.875rem, 1.15, -0.02em, balanced): the page title (`h1`).
- **Section** (700, 1.375rem, 1.3): section headings (`h2`) and dialog headings.
- **Lead** (700, 1.125rem): sub-sections (`h3`), the wordmark (750), roster names (600).
- **Body** (400, 1rem, 1.55): running text, inputs, table cells; buttons at 650.
- **Label** (650, 0.875rem): form labels, column heads, the key, sidebar sections (600), quiet buttons.
- **Small** (650, 0.8125rem): role labels, sidebar group headings, stacked field names on phones.
- **Figures** (Mono, 0.8125rem): identifiers, codes and the trial's time left.

### Named Rules
**The Fixed Ramp Rule.** One fixed scale in rem. Type never grows with the window; it grows only with the reader's zoom.

## Layout

Inside a School the page is two columns: the sidebar at `clamp(14rem, 18vw, 17rem)`, sticky and full height, scrolling on its own when it overflows; and the sheet in the rest, with no maximum width, so it covers the whole window. The sheet's body is the record in a fluid column plus the key at 13 to 17rem on its right. A Trial School adds a bar across the top of the sheet. Outside a School the header is a bar across the top and the body is held to 80rem, centred.

Spacing counts in an 8px step with a fluid gutter of `clamp(1rem, 2.5vw, 2.5rem)`. More space above a heading than below it; forms stack at 20px and cap at 30rem.

There is one breakpoint, 52rem, which a zoomed desktop reaches too. Below it the sidebar folds into a header across the top: the wordmark with Sign out at its right, the School block, the role and School switchers, and every section as a grid of bordered cells three to a row, all reachable in the first screen at 360px. The key moves below the record, and tables stack each row into an entry whose values carry their own field names.

## Elevation & Depth

Two shadow steps and no more. `shadow` (a 1px contact shadow plus a soft 14px blur) lifts every block off the ground: records, the key, the School block, secondary buttons, switcher lists. `shadow-lift` (a 32px blur) is reserved for what sits over the page: an open dialog, and a Course block under the pointer. The sidebar is set apart by its rail colour and a hairline, not by shadow.

## Shapes

Soft, consistent corners: 10px on controls, fields, notices and the School block; 12px on blocks (records, the key, Course blocks, empty states); 16px on dialogs; 8px on sidebar rows; 6px on role labels. State marks are full discs at 0.625rem. Borders are 1px hairlines; focus is a 3px indigo outline offset 2px. Glyphs are authored stroke icons on a 24-unit grid at 1.75 stroke, drawn inline as SVG; the wordmark is four Course-coloured squares drawn from gradients.

## Components

### Buttons
- **Primary:** indigo fill, white words at 650, 10px corner, 44px tall, a 1px contact shadow and a faint inner highlight. Hover deepens; press drops 1px.
- **Ghost (secondary):** a white block: surface fill, strong-rule border, ink words, the block shadow. Hover darkens the border.
- **Quiet:** words on nothing, soft ink, 40px tall; hover lays the wash and inks the words. Sign out and Start over.
- **Stamp:** an action that takes something away: surface fill, 55% alarm border, alarm words; hover adds a 10% alarm tint.
- **Held:** a dashed border and a diagonal hatch of the wash, soft-ink words, no shadow.

### Sidebar
Group headings in small soft ink; each section a 40px row with its glyph. The current section sits on an indigo-washed row (the seal), named for the view transition so it slides to the next row in 240ms when the section changes. The School block is a white raised block with a 2rem indigo badge of the School's initials.

### Switchers
Native disclosures: a full-width field-like button with a chevron drawn from two borders; the list opens in flow beneath it as a white block, entries 6px-cornered with the indigo wash on hover.

### Records
A table in a white block: 12px corner, rule border, block shadow. Column heads on a 3% ink tint, label size, soft ink. Rows at least 56px, divided by rules, washed on hover; actions right-aligned. Below 52rem each row stacks into an entry. Rosters use the same block.

### Course blocks (wall chart)
A Class Offering as its Course's colour: a solid block at 12px corner with white code, name, Faculty and a large roster figure; lifted 2px with `shadow-lift` under the pointer. Every block and row of the pointed-at Course stays bright while the others dim. (Built with the Class Offerings screen.)

### Dialog
The app's one overlay, a native modal `<dialog>`: surface, 16px corner, `shadow-lift`, over the veil with a 3px blur; rises 8px into place in 220ms. Its actions sit in a tinted footer bar pinned to its bottom, right-aligned.

### Panel
A form that stands on its own (signing in, redeeming an Invitation), or a short message with its one way on (a trial that ended, a page not available), sits in a white block: 12px corner, rule border, block shadow, at most 30rem wide. Its heading stays above it on the ground.

### Key, notice, error, empty
The key is a white block at the page's right, sticky on wide screens. A notice is indigo-washed with a 30% indigo border. An error is alarm words on a 9% alarm tint with a 45% alarm border. An empty record is a white block with a dashed border and centred soft-ink words.

## Do's and Don'ts

### Do:
- **Do** name every colour through a token with both a light and a dark value.
- **Do** give a Course one colour and use it for that Course everywhere, and only there.
- **Do** pair every state with a word and a filled, ringed or struck disc.
- **Do** keep indigo for action, the current place, links, focus and marks.
- **Do** size layout in rem and clamps so the page fills any window and follows zoom.
- **Do** keep controls at least 44px (40px for quiet) with the 3px indigo focus ring.
- **Do** draw a held control hatched and dashed.
- **Do** settle in 200ms on cubic-bezier(0.22, 1, 0.36, 1), and drop motion under reduced motion.

### Don't:
- **Don't** use a Course colour for status, emphasis or decoration.
- **Don't** put running text on colour, or fill a control with alarm red.
- **Don't** add a third shadow step, hard offset shadows, or glass as decoration.
- **Don't** use a coloured border-left stripe on rows, cards or notices.
- **Don't** put a kicker or eyebrow label above a heading.
- **Don't** use emoji or Unicode glyphs as icons; draw them as stroke SVG.
- **Don't** scale type with the viewport.
- **Don't** reach for an inline style; the Content Security Policy forbids it and the build fails on it.
