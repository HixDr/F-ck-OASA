# Modular Home layout — design

**Date:** 2026-08-08
**Version:** 1.2.5
**Scope:** Saved stops on the Home screen become freely placed, resizable cards.

## Context

Home shows saved stops as a single-column virtualized `FlatList` of full-width
cards. Every stop gets the same width and the same amount of the user's attention,
whether it is the stop they use twice a day or one they saved once.

The request is to let each card be moved anywhere and resized — a dashboard the
user arranges, with multiple columns, rather than one ordered column.

The user's own framing set two constraints. Placement should be free-form **with
snapping as an assist, not a rule** ("can be snapped, not has to"), and the size
range has to be chosen so that "the UI of the buses is nice" at every size — which
is really a question about what a card can legibly show as it shrinks.

## The measurements this design rests on

At ~412dp screen width (a 6.7" phone):

- Home's list uses `paddingHorizontal: spacing.lg` (24), so **today's card is 364dp
  wide** with 332dp of content inside its own 16dp padding.
- Card height is driven by line count: `header.minHeight` 32, `lineRow.minHeight`
  62 each, footer 22, padding 14. One line ≈ 132dp, three ≈ 256dp, four ≈ 318dp.
- **A line row needs 100dp before anything else**: `lineBadge.minWidth` 44 +
  `arrivalBlock.minWidth` 56.

That 100dp is what decides the tiers.

## Principles

1. **The arrival number survives as long as possible.** It is the reason the app
   exists. Content is dropped around it before it is shrunk.
2. **Snapping assists, never forces.** Free placement is the model; magnets are a
   convenience the user can always override.
3. **A saved layout must outlive the screen it was made on.** Rotation, a different
   phone, and a larger font scale must not strand a card off-screen.
4. **Nothing may overlap.** A card covering another card's minutes is strictly
   worse than any arrangement it could enable.

## Layout model

Each saved stop gains `{ x, y, w, h }`.

**Stored as fractions of screen width**, not pixels — `x` and `w` as fractions of
the usable width, `y` and `h` in the same unit so aspect is preserved. A layout
authored on a 412dp phone therefore reconstructs sensibly on a 360dp one, in
landscape, and at a larger font scale. Storing pixels would mean every one of those
cases needs a reflow pass that throws the user's arrangement away.

**Overlap is prevented at drop time.** A move or resize that would overlap another
card resolves to the nearest free position rather than being rejected outright —
rejection makes the gesture feel broken, silent resolution reads as magnetism.

**Magnetic snapping** applies while dragging and resizing: within ~8dp, an edge
snaps to a neighbouring card's edge or to the screen margin, with the target edge
briefly highlighted. Pulling further releases it. Both axes snap independently, so
a card can align to one neighbour horizontally and another vertically.

**The canvas scrolls vertically** and grows to fit the lowest card.

## Size tiers

Chosen by the card's **measured** width, so a tier change is a consequence of
resizing rather than a mode the user selects.

| Tier | Width | Content width | Shows |
|---|---|---|---|
| **Compact** | 120–177dp | ~88dp | Stop name (truncated) + soonest arrival only. Badge and figure **stacked**, figure ~24pt |
| **Standard** | 178–299dp | ~146dp | Name + line rows, badge + full 34pt figure, **no** destination labels |
| **Detailed** | ≥300dp | ~268dp+ | Today's card: destinations, timetable pill, alert bell |

Why those boundaries:

- **120dp** is the floor. Content is ~88dp, and badge + figure (100dp) cannot sit
  side by side, so the compact tier stacks them and drops the figure to ~24pt. This
  is the one place the principle above is traded away, deliberately, for density —
  three cards across a phone.
- **178dp** (half width) is where badge + figure fit side by side at full size,
  leaving ~46dp — enough for the pair and a gap, not for a destination label.
- **300dp** is where a destination label becomes legible alongside them.

**Minimum height ~80dp** — a name plus one arrival row. Past ~6 line rows a card
scrolls internally rather than growing without bound.

## Interaction

**Long-press enters arrange mode.** Long-press already means "pick this card up",
so the gesture is preserved rather than relearned. In arrange mode:

- drag the card body to move
- drag the bottom-right handle to resize
- a Done control exits

Outside arrange mode the cards behave exactly as they do now, including tapping a
line to open its map.

Haptics follow the existing vocabulary: impact on lift, selection on each snap,
impact on commit.

## Accessibility

Drag and resize are both unusable with a screen reader, and unlike the 1.2.1 line
grid there is no chevron equivalent for two-dimensional placement.

Each card exposes `accessibilityActions` in arrange mode: **Move up / down / left /
right**, **Grow**, **Shrink** — each nudging by one snap step and running through
the same overlap resolution as a gesture. This mirrors the approach already used
for saved-line badges, where a 44dp target had nowhere to put visible controls.

All motion honours `useReduceMotion()`.

## Persistence and migration

Layout lives with the stop, written through the existing `updateFavoriteStop`.

**Existing users migrate to today's appearance**: every saved stop is assigned a
full-width card stacked in its current order, so the screen looks unchanged until
the user deliberately rearranges. A stop saved later appends below the lowest card
at full width.

## What this replaces, and what it costs

Stated plainly, because these are real losses:

- **The 1.2.1 drag machinery is deleted.** `CellRendererComponent`, the three 1-D
  worklets (`restingTop`, `slotFor`, `clampOffset`) and the vertical-slot maths were
  built for a single-column list and do not generalise to 2-D free placement.
- **Virtualization is lost.** A free-form canvas cannot be a `FlatList`, so every
  saved stop renders at once, and each card owns live arrival queries. This is
  acceptable at 5–20 stops and is not acceptable without limit; the existing
  `active` focus-gating becomes load-bearing rather than an optimisation.
- **The card gains layout responsibility it did not have.** `FavoriteStopCard`
  currently sizes itself from its content. It must now render into a given box, at
  one of three tiers, which is a genuine change to its contract.

## Out of scope

Unchanged by this work, and stated so the boundary is not guessed at: the Home
header and its live-status indicator, the search / Nearby / Go To row, the saved
**lines** grid and its own drag-reorder from 1.2.1, and every other screen. Only
the saved-**stops** region becomes a canvas.

## Verification

No test infrastructure exists, and this pass does not add it. Verification is
`npx tsc --noEmit` plus explicit manual checks:

1. Arrange three cards side by side at the 120dp floor; confirm the name and figure
   are legible and nothing clips.
2. Resize one card across all three tier boundaries; confirm content appears and
   disappears at 178dp and 300dp without layout jumping.
3. Drag a card against a neighbour; confirm it snaps, and that pulling further
   releases it.
4. Attempt to drop a card onto another; confirm it resolves to a free position.
5. Rotate the device, and repeat at maximum system font size; confirm no card is
   stranded off-screen and none overlap.
6. TalkBack: move and resize a card entirely through accessibility actions.
7. Existing install: confirm the migrated layout is visually identical to 1.2.4.

## Sequencing

| Phase | Content | Ships |
|---|---|---|
| 1 | Layout model, storage, migration; render existing layout unchanged | Yes |
| 2 | Size tiers in `FavoriteStopCard` — render into a given box | Yes |
| 3 | Arrange mode: move, with snapping and overlap resolution | Yes |
| 4 | Resize handle, min/max clamping | Yes |
| 5 | Accessibility actions, reduce-motion, responsive sweep | Yes |

Phase 1 is deliberately invisible: it changes how the screen is laid out without
changing how it looks, so a regression there is caught before any gesture work sits
on top of it.
