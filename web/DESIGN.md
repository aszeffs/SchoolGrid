---
name: SchoolGrid
description: A school office's own printing press — one aniline violet ink struck onto coloured copy stock that floods the frame.
colors:
  ink: "#3b2a6b"
  ink-soft: "#4f3d7a"
  stamp: "#8e1e26"
  stock-goldenrod: "#f2c14e"
  stock-canary: "#f7e7a6"
  stock-blue: "#c9dae8"
  stock-pink: "#edd9e4"
  stock-mint: "#cbe0ce"
  stock-buff: "#e8cdb5"
  stock-salmon: "#eab9a1"
  rule: "color-mix(in srgb, #3b2a6b 42%, transparent)"
  rule-faint: "color-mix(in srgb, #3b2a6b 18%, transparent)"
  wash: "color-mix(in srgb, #3b2a6b 9%, transparent)"
  wash-strong: "color-mix(in srgb, #3b2a6b 15%, transparent)"
typography:
  display:
    fontFamily: "Stardos Stencil, Courier Prime, monospace"
    fontSize: "clamp(2rem, 5.5vw, 3.25rem)"
    fontWeight: 700
    lineHeight: 1.05
    letterSpacing: "0.02em"
  headline:
    fontFamily: "Stardos Stencil, Courier Prime, monospace"
    fontSize: "1.05rem"
    fontWeight: 700
    lineHeight: 1.6
    letterSpacing: "0.22em"
  title:
    fontFamily: "Courier Prime, Courier New, monospace"
    fontSize: "0.9rem"
    fontWeight: 700
    lineHeight: 1.6
    letterSpacing: "0.18em"
  body:
    fontFamily: "Courier Prime, Courier New, monospace"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.6
    letterSpacing: "normal"
  label:
    fontFamily: "Courier Prime, Courier New, monospace"
    fontSize: "0.78rem"
    fontWeight: 700
    lineHeight: 1.6
    letterSpacing: "0.18em"
  caption:
    fontFamily: "Courier Prime, Courier New, monospace"
    fontSize: "0.72rem"
    fontWeight: 700
    lineHeight: 1.6
    letterSpacing: "0.2em"
rounded:
  none: "0"
  mark: "50%"
spacing:
  step: "0.5rem"
  xs: "0.375rem"
  sm: "0.75rem"
  md: "1rem"
  lg: "1.5rem"
  xl: "2rem"
  2xl: "2.5rem"
  3xl: "3rem"
  gutter: "clamp(1.25rem, 4vw, 3rem)"
components:
  button-primary:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.stock-canary}"
    typography: "{typography.headline}"
    rounded: "{rounded.none}"
    padding: "0.625rem 1.5rem"
    height: "2.75rem"
  button-primary-hover:
    backgroundColor: "color-mix(in srgb, #3b2a6b 82%, #000)"
    textColor: "{colors.stock-canary}"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    typography: "{typography.headline}"
    rounded: "{rounded.none}"
    padding: "0.625rem 1.5rem"
    height: "2.75rem"
  button-ghost-hover:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.stock-canary}"
  button-quiet:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    rounded: "{rounded.none}"
    padding: "0.375rem 0.75rem"
    height: "2.25rem"
  button-stamp:
    backgroundColor: "transparent"
    textColor: "{colors.stamp}"
    rounded: "{rounded.none}"
    padding: "0.625rem 1rem"
    height: "2.75rem"
  button-disabled:
    backgroundColor: "transparent"
    textColor: "{colors.ink-soft}"
    rounded: "{rounded.none}"
  input:
    backgroundColor: "{colors.wash}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.none}"
    padding: "0.625rem 0.625rem"
    height: "2.75rem"
  input-focus:
    backgroundColor: "{colors.wash-strong}"
    textColor: "{colors.ink}"
  mark-struck:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.stock-canary}"
    typography: "{typography.caption}"
    rounded: "{rounded.none}"
    padding: "0.2rem 0.55rem"
  mark-open:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    typography: "{typography.caption}"
    rounded: "{rounded.none}"
    padding: "calc(0.2rem - 1px) calc(0.55rem - 1px)"
  slip:
    backgroundColor: "{colors.wash}"
    textColor: "{colors.ink}"
    rounded: "{rounded.none}"
    padding: "1.5rem"
  slip-held:
    backgroundColor: "color-mix(in srgb, #3b2a6b 9%, var(--stock))"
    textColor: "{colors.ink}"
    rounded: "{rounded.none}"
    padding: "1.5rem"
  slip-held-veil:
    backgroundColor: "color-mix(in srgb, #3b2a6b 55%, transparent)"
  record-head:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    rounded: "{rounded.none}"
    padding: "0 1rem 0.625rem 0"
  record-row:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.none}"
    padding: "0.875rem 1rem 0.875rem 0"
  record-row-hover:
    backgroundColor: "{colors.wash}"
    textColor: "{colors.ink}"
  error:
    backgroundColor: "transparent"
    textColor: "{colors.stamp}"
    rounded: "{rounded.none}"
    padding: "0.625rem 0.75rem"
---

# Design System: SchoolGrid

## Overview

**Creative North Star: "The Ditto Sheet"**

SchoolGrid is printed, not rendered. Every screen is one run off a spirit duplicator's drum: a single aniline violet ink struck onto coloured copy stock, with the stock flooding the entire frame edge to edge. The record *is* the page. There is no card, no panel, no container, and no grey page behind anything — the arrangement every school portal ships (white cards floating on grey behind a left nav rail) is the thing this world exists to refuse.

Density is a working document's, not a dashboard's: hairline-ruled rosters, a two-column head separated by a 3px double rule, a legend held level beside the record, and a foot that closes the sheet with a registration mark and the words "End of sheet". Chrome is limited to three devices, all of them printer's marks: the stapled corner struck across the top-left gutter, the registration target at the foot, and the drum-wear texture in the stock itself. State prints itself into the record as a struck mark rather than appearing as coloured product chrome.

The system is bound by three constraints that outrank expression, and the build honours all three. The Content Security Policy permits no inline `<style>`, no `style=` attribute, no `on*=` handler and no `data:` inlining, and `vite.config.ts` fails the build on any of them — every rule in this document lives in `src/styles.css` and nowhere else. UI copy uses `CONTEXT.md` domain vocabulary verbatim (School Administrator, Faculty, Class Offering, Person, Invitation, Enrollment). WCAG 2.2 AA is binding: both inks clear 4.5:1 on all seven stocks, every interactive target is at least 2.25rem tall, and focus is a 3px solid ink outline offset 2px.

**Key Characteristics:**
- One ink (violet) plus one stamp (oxblood red) for refusal and revocation only
- Seven saturated copy stocks, one per sheet, flooding the whole viewport
- Typewriter strike for every record and figure; stencil caps for heads and actions
- Zero shadows, zero rounded corners, zero floating panels
- Violet hairlines and 3px double rules carry all structure
- Exactly one animation in the app: the drum pass on sheet entry

## Colors

A one-ink press with a seven-stock paper drawer: the colour range lives in the paper, never in the ink.

### Primary
- **Aniline Violet** (`{colors.ink}`): the only ink in the system. Body copy, headings, rules, borders, roster text, the filled primary button, list markers, the caret and the selection highlight are all this one value. Darkened from a true duplicator violet until it clears 4.5:1 on every stock, goldenrod included.
- **Washed Violet** (`{colors.ink-soft}`): the same ink laid down thinner. Reserved for secondary voice — the legend's body text, the sheet number, the foot line, expiry lines, `.muted` copy, and disabled control text. Never used for a record's own value.

### Secondary
- **Office Stamp Oxblood** (`{colors.stamp}`): the rubber stamp, the only second colour the office ever saw. Used exclusively for destructive and failed states — the error block's border and text, and the revoke action. It is never decorative and never a heading colour.

### Tertiary
The seven copy stocks. One stock is assigned per kind of sheet so a School Administrator knows which sheet is in front of them before reading a word. The stock is set once on `.sheet` and inherited; it is never set on an element inside the sheet.
- **Goldenrod** (`{colors.stock-goldenrod}`): Persons — the roster sheet, the system's first viewport.
- **Canary** (`{colors.stock-canary}`): Sign in. Also the default stock for any sheet that does not name one.
- **Duplicator Blue** (`{colors.stock-blue}`): Schools.
- **Carbon Pink** (`{colors.stock-pink}`): Redeem Invitation.
- **Ledger Mint** (`{colors.stock-mint}`): How this was built.
- **Manila Buff** (`{colors.stock-buff}`): Not available.
- **Duplicator Salmon** (`{colors.stock-salmon}`): Your account — what one Person holds in one School.

### Neutral
There are no neutrals. Where a lighter or darker plane is needed, the ink is mixed into the stock rather than a grey being introduced.
- **Rule** (`{colors.rule}`): the standard violet hairline — under headings, above rosters and facts lists, around `pre` blocks.
- **Faint Rule** (`{colors.rule-faint}`): the between-rows hairline in a roster and the legend's right edge; quieter so rows read as a run, not as a table.
- **Wash** (`{colors.wash}`) and **Strong Wash** (`{colors.wash-strong}`): ink bled into the stock. Wash fills inputs, code spans, `pre` blocks and the torn-off slip; Strong Wash is the hover/focus lift on inputs and links.

### Named Rules
**The One Ink Rule.** Violet is the only ink. If a new surface needs to distinguish something, it distinguishes it with a rule, a wash, caps, or a struck mark — not with a new hue. Oxblood is not an accent; it may appear only on a refusal, an error, or a revocation.

**The Flooded Stock Rule.** The stock paints the entire frame, edge to edge, with no margin and no container. A white panel on a grey page is forbidden, and cream and grey are not stocks in this family — they are the light ground this world exists to refuse.

**The One Stock Per Sheet Rule.** `--stock` is overridden on the sheet, never on an element. Two stocks never appear in one viewport.

## Typography

**Display Font:** Stardos Stencil (self-hosted woff2, 400/700; falls back to Courier Prime, then monospace)
**Body Font:** Courier Prime (self-hosted woff2, 400/400-italic/700; falls back to Courier New, then monospace)
**Label/Mono Font:** Courier Prime — the body font is the mono font; there is no third face.

**Character:** A stencilled crate-mark meeting a typewriter carriage. The stencil says *this sheet was labelled*; the typewriter says *this record was struck, not rendered*. Both are self-hosted, so the world never falls back to a system display face.

### Hierarchy
- **Display** (Stardos Stencil 700, `clamp(2rem, 5.5vw, 3.25rem)`, line-height 1.05, uppercase): the sheet's `h1`, one per page, closed with a violet hairline beneath it.
- **Headline** (Stardos Stencil 700, 1.05rem, tracked 0.22em, uppercase): the SchoolGrid wordmark in the head, and — at 0.95rem with 0.16em tracking — every button label. Stencil means "struck onto the sheet by the office", so it marks identity and action, nothing else.
- **Title** (Courier Prime 700, 0.9rem, tracked 0.18em, uppercase): section `h2`s inside the record.
- **Body** (Courier Prime 400, 1rem, line-height 1.6, measure capped at 68ch): every record value, name, figure, paragraph and code span. Italic body is reserved for the empty state.
- **Label** (Courier Prime 700, 0.78rem, tracked 0.18em, uppercase): form labels, facts-list terms, legend headings and legend terms. Inputs override the label's caps and tracking so typed values read as struck data.
- **Caption** (Courier Prime 700, 0.72rem, tracked 0.2em, uppercase): status marks, the foot line; at 0.8rem/0.18em it carries the sheet's name and the signed-in line in the head.

### Named Rules
**The Struck Record Rule.** Anything that is a record — a name, a figure, a date, an identifier — is set in Courier Prime. Stencil is for the wordmark, the page's one `h1`, button labels and the slip's heading. A record set in stencil is a defect.

**The Caps-and-Track Rule.** Every type role below 0.9rem is uppercase and tracked between 0.12em and 0.22em. Small type in this world is a printed label, never shrunken prose. The one exception is input text, which is sentence-case and untracked.

## Layout

One sheet fills the viewport: a three-row grid (`head / body / foot`) at `min-height: 100dvh`, with the stock as its background and no outer margin. The head is a baseline-aligned flex row — wordmark plus sheet name at the left, contextual head content (the signed-in line and Sign out, joined inside a School by the School's name and the switcher) hard right — closed by a 3px double ink rule. The foot mirrors it with a 3px double rule above, the registration mark at the far left and "End of sheet" at the far right.

The body is a two-column grid: a `minmax(13rem, 17rem)` legend strip and a `minmax(0, 1fr)` record column, separated by `1.2 × gutter` and a faint vertical hairline. The legend is `position: sticky` at `top: 1rem` — held level so it never scrolls away from the record it explains. The record column caps at 62rem; prose inside it caps at 68ch. A sheet with no legend (a refusal, or a sheet still coming off the drum) switches to a single full-width column rather than leaving the strip empty.

Rhythm is a 0.5rem step used in multiples: 0.75 and 1 for intra-control gaps, 1.5–2 for stacked blocks, 3 for heading separation, 4–6 for section breaks. Horizontal padding is always the gutter, `clamp(1.25rem, 4vw, 3rem)`.

There is one breakpoint, 52rem, and it does everything. Below it: the legend drops under the record (`order: 2`) with a hairline above instead of beside; forms stretch to full width; demo-role buttons go full width; the dotted leader in a roster row is hidden so the name takes the freed space; and the stapled corner is dropped, because the gutter is too narrow to hold it without crowding the head's type.

### Named Rules
**The Level Legend Rule.** The legend explains the sheet's own marks and never names a record. It stays sticky and visible while the record scrolls on wide sheets, and moves below the record — never away — on narrow ones.

**The No Rail Rule.** There is no left nav rail. Inside a School, the School's pages are a single row of register tabs ruled under the head, wrapping rather than scrolling at 360px; everywhere else, movement between sheets happens through links struck into the record and its foot.

## Elevation & Depth

This system has no shadows. `box-shadow` does not appear once in the stylesheet and must not be added: paper laid on a drum has no drop shadow, and a lifted card would reintroduce the floating panel this world refuses. Depth is entirely tonal and linear — ink mixed into the stock (9% wash, 15% strong wash) for recessed fields and slips, hairlines at 18% and 42% for structure, and a 3px double ink rule where a major plane changes (head, foot, the "Try a role" break).

The only volumetric cue in the world is the press itself: the stock carries a fixed drum-wear texture — 1px violet pinstripes at 3% every 3px, plus a 5% wash falling off at 97° across the first 38% of the sheet, heavier where the roller bites and washed out toward the tail. That texture is part of the paper and is never used to imply an element is raised.

Motion is one gesture. On sheet entry, a fixed full-viewport violet gradient wipes top to bottom over 560ms `cubic-bezier(0.16, 1, 0.3, 1)` — the drum pass. It is an overlay with `pointer-events: none`, so no content is ever hidden waiting for it, and it is the only animation in the app. Controls carry short state transitions only (140ms ease-out on colour, 90ms on the button's 1px press). `prefers-reduced-motion: reduce` removes both.

### Named Rules
**The No Shadow Rule.** No `box-shadow`, no `filter: drop-shadow`, no hard offset shadow, ever — including as a "brutalist" device. Separation is a rule, a wash, or a double rule.

**The One Pass Rule.** The drum pass is the only animation in the system. New surfaces inherit it by being a sheet; they do not add entrances, parallax, or scroll-triggered motion.

**The Honest Gradient Rule.** Gradients exist in this world only as printing artifacts and drawn marks — drum wear, the dotted leader, the registration target, the drum pass. A gradient used to imply light, gloss or elevation is forbidden.

## Shapes

Every corner in the system is square. `border-radius` is `0` on buttons and inputs — set explicitly, because the browser default is not — and no card, panel or chip exists to round. The single curved shape in the world is the registration mark at the foot: a 1.5rem circle, 2px ink border, crossed by two 8%-wide ink bars drawn as gradients.

Form language is drawn with rules, not with boxes. An input is a wash field with no border except a 2px ink underline that thickens to 3px on focus. A roster row is a name, a dotted leader, and a state mark separated by a 1px faint hairline — never a bordered cell. Where a real boundary is needed, it is a 2px solid ink box (the torn-off slip, the error block) or a 3px double rule (head, foot, section break). The stapled corner is a 2.6rem × 5px ink bar rotated -45° in the top-left gutter, shown only at 52rem and above.

### Named Rules
**The Square Corner Rule.** `border-radius: 0` everywhere. The registration mark's circle is the one exception, and it is a printed mark, not a container.

## Components

### Buttons
- **Shape:** square (`0` radius), 2px solid ink border, minimum height 2.75rem, stencil caps at 0.95rem tracked 0.16em.
- **Primary:** solid ink fill with stock-coloured type, padded 0.625rem × 1.5rem. It sits at the foot of the record where a form's action sits on paper — never floating top-right.
- **Hover / Focus / Active:** hover (pointer devices only) deepens the fill to 82% ink mixed with black; focus-visible draws a 3px solid ink outline offset 2px; active translates down 1px — the stamp meeting the page.
- **Ghost:** transparent with ink border and ink type, inverting to solid ink on hover. The office's second-choice action: demo roles, "Use an existing account", secondary form actions.
- **Quiet:** a 1px-bordered, 2.25rem-tall, 0.78rem variant for in-head and in-row actions (Sign out, Issue an Invitation).
- **Stamp:** transparent with oxblood border and type at 0.8rem, filling oxblood on hover, with an oxblood focus ring. Destructive only (Revoke).
- **Disabled:** transparent fill, dashed border, washed-violet type, `not-allowed` cursor. The border going dashed is the signal, not a reduced opacity.

### Inputs / Fields
- **Style:** wash-filled field, no border except a 2px ink bottom rule, square corners, 2.75rem minimum height, body type at 1rem with label caps and tracking explicitly cleared.
- **Focus:** field deepens to strong wash and the bottom rule thickens to 3px, with the outline offset collapsed to 0 so the ring meets the field.
- **Hover:** deepens to strong wash on pointer devices.
- **Label:** always visible above the field in label caps; there are no placeholder-only fields.
- **Error:** a separate oxblood block (2px border, oxblood bold text) rendered with `role="alert"` above or below the control; the field itself is not recoloured.

### Navigation
The head carries identity (wordmark, sheet name) and, on a signed-in sheet, the shell's part: the School in stencil caps, who the sheet was run for, a School switcher when the account reaches more than one, and sign-out. The switcher is a native `<details>` whose slip of the same stock hangs from the head on wide sheets and is struck in line on narrow ones, so it never lies over the tabs.

Inside a School, `.shell-nav` rules a row of tabs under the head: 0.78rem bold caps tracked 0.16em, each at least 2.75rem tall. The page being shown carries `aria-current="page"` and is struck with a strong wash and a 3px ink underline. It lists only the pages the actor's roles reach. Elsewhere, movement is by links in the record and in the `.foot` block. Links are ink-coloured with a 1px underline offset 0.22em, thickening to 2px over a strong-wash highlight on hover.

### Status Mark (signature component)
State prints itself into the record instead of appearing as chrome. A mark is 0.72rem bold caps tracked 0.2em, `white-space: nowrap`, in one of two renditions: **held** — solid ink block with stock-coloured type, for a settled fact (CLAIMED, COPIED) — or **open** — 1px dashed ink outline with ink type, padding reduced by the border width so both renditions sit on the same baseline grid (UNCLAIMED). An empty mark sets `display: none`, so a status with nothing to report is not a blank box waiting to be read.

### Roster (signature component)
The record itself: an unstyled `ul` opened with a 1px rule, each row a baseline-aligned flex line padded 0.875rem vertically and closed with a faint hairline. Name at the left in 1.05rem body type, a **dotted leader** (a 2px-on/4px-off repeating gradient, 1px tall, centred) filling the gap, and the state group pushed hard right with `margin-left: auto`. Rows wash on hover. The leader is hidden below 52rem. Its empty counterpart is an italic washed-violet line ruled top and bottom.

### Legend (signature component)
A sticky `<dl>` strip beside the record: a "THIS SHEET" heading in label caps, an optional sentence of context, then term/definition pairs where the term is the mark as it appears in the record. It explains the sheet's marks and never names a record — and a sheet shown for a refusal carries no legend at all, so nothing about what exists can be read off it.

### Slip (signature component)
The issued Invitation, torn off the sheet: a wash-filled block with a 2px solid ink border, 1.5rem padding, a stencil heading at 1.1rem, and inputs that reverse to the raw stock so the handed-over link reads as a fresh strip of paper.

### Held slip (signature component)
The same slip, lifted off the sheet and held over it: a native `<dialog>` opened with `showModal()`, and the only overlay in the system. It is a `min(34rem, 100vw − 2 × gutter)` block with the slip's 2px ink border and 1.5rem padding, centred, over a veil of 55% ink across the whole sheet. Its fill is the 9% wash *mixed into* the stock rather than laid over it, because a translucent slip would let the sheet read through the record it is holding.

Two shapes, and no third. **Acknowledge** holds something the server will never say again — an Invitation's link above all — and refuses both Escape and a click on the veil, so it cannot be dismissed by a stray keystroke; one control closes it. **Confirm** names what an action will do before it is done, in glossary language, and Cancel holds the focus on open so the consequence is read before the key that confirms it is under the hand; cancelling sends nothing.

No component library supplies it, and none can: `style-src 'self'` has no inline exception and the build fails on a `style=` attribute, which is how every kit positions its overlays (ADR-0006). The element itself brings the inert page, the focus trap and the Escape handling.

### Record (signature component)
A record with more than one thing to say about each row, where `roster` carries the sheet's flat name-and-mark line. One `<table>` carries both renditions. Above 52rem it is a table: terms struck across the head in label caps over a 1px rule, rows ruled off with faint hairlines, the last column set hard right, rows washing on hover. Below 52rem the columns stack — the head is dropped, each row becomes an entry ruled off from the next, and every value is struck under its own term in caption caps — so a record that could not hold 360px is read down instead of scrolled across. A column of controls carries its term for a screen reader only, struck but never printed.

### Facts (signature component)
A typed two-column `max-content / 1fr` definition grid, ruled above, with terms in label caps and values in body type set to break anywhere. Used for provenance and record detail.

## Do's and Don'ts

### Do:
- **Do** flood the frame with exactly one stock per sheet, set on `.sheet` via `--stock`, and pick the stock by kind of sheet (goldenrod Persons, canary Sign in, blue Schools, pink Redeem, mint How this was built, buff Not available).
- **Do** keep every rule in `src/styles.css`: the CSP forbids inline `<style>`, `style=`, `on*=` and `data:` inlining, and the Vite build fails on any of them.
- **Do** set records, names and figures in Courier Prime and reserve Stardos Stencil for the wordmark, the single `h1`, button labels and the slip heading.
- **Do** draw structure with violet hairlines (`{colors.rule}`, `{colors.rule-faint}`) and 3px double rules; use washes (9% / 15%) for recessed fields.
- **Do** print state as a struck mark — solid ink for settled, dashed outline for open. A mark with nothing to report prints nothing, but stays in the page: one of these is a `role="status"` region, and `display: none` would take it out of the accessibility tree so the word arriving goes unannounced.
- **Do** put the primary action at the foot of the record, where a form's action sits on paper.
- **Do** keep every interactive target at 2.75rem (2.25rem for quiet variants), with a visible 3px ink focus ring offset 2px, and keep ink and stamp above 4.5:1 on every stock.
- **Do** use `CONTEXT.md` vocabulary verbatim in all UI copy — School Administrator, Faculty, Class Offering, Person, Invitation, Enrollment.

### Don't:
- **Don't** put a white or grey panel, card or container on the stock. There is no cream and no grey ground in this system.
- **Don't** add a `box-shadow` of any kind, including a hard offset one; this is not a neobrutalist world and nothing in it is raised.
- **Don't** round a corner. `border-radius` is `0` outside the registration mark.
- **Don't** introduce a third colour. Oxblood is for errors, refusals and revocation only, and never for a heading or a highlight.
- **Don't** use a gradient to imply light, gloss or depth; gradients are printing artifacts and drawn marks only.
- **Don't** add animation. The drum pass is the system's only entrance, and reduced-motion removes it.
- **Don't** add a left nav rail, a floating top-right action bar, or any persistent chrome region beyond the head and, inside a School, its row of tabs.
- **Don't** print a figure the app cannot source — a run number, a count, or a status the API did not give — in the same hand as its records.
- **Don't** let a refusal sheet carry a legend, a reason, or any variation: one `NotAvailable` state, identical for absent, out-of-School and forbidden.
- **Don't** add a kicker or eyebrow line above a heading. The head's sheet name is chrome in the head, not a device for the record column.
- **Don't** use a glyph or icon font; the only marks in the world are the CSS-drawn staple and registration target.
