# Grid Home layout — design

**Date:** 2026-08-08
**Version:** 1.2.5 (rework of the free-form layout in the same release)
**Supersedes:** the placement half of `2026-08-08-modular-home-layout-design.md`

## Context

1.2.5 made saved stops freely placeable and resizable in both axes. It works, but
free-form width has two costs the user hit immediately: a card can be any width,
so its content has to adapt at measured breakpoints, and nothing lines up.

The rework keeps free vertical sizing and constrains only the horizontal axis.

> "I want the height to be modular in a way that a big stop can grow vertically
> without needing a grid. The only forced grid are the 3 columns."

Three further requirements came with it:

1. The schedule, alarm and filter controls must be reachable at **every** size.
   Today the schedule is gated on `tier === 'detailed'`
   (`FavoriteStopCard.tsx:868`), so at smaller sizes it does not exist.
2. The schedule must stop expanding **inline**. It currently grows the card
   downward, which is both a bug and impossible in a fixed-width tile.
3. A bug, which (2) fixes: opening the schedule on the bottom-most bus row shows
   nothing until the user scrolls, because the expansion renders below the
   viewport.

## The model

**Columns are the only grid. Height is free.**

- `col` ∈ {0, 1, 2} and `span` ∈ {1, 2, 3}, with `col + span <= 3`.
- `y` and `h` stay continuous, as they are now, with the existing magnetic
  snapping to neighbours' edges keeping things aligned without a row grid.

At a 412dp screen the canvas is 364dp (`paddingHorizontal: spacing.lg` twice),
so with the existing 8dp `CARD_GAP_DP` a column is **116dp**:

| Span | Width |
|---|---|
| 1 | 116dp |
| 2 | 240dp |
| 3 | 364dp — exactly today's detailed card |

This replaces the fractional `x`/`w` and the measured-width tier lookup. It is
strictly less code: integer columns have a search space of six placements, where
the fraction maths had to resolve arbitrary overlap.

## One rule, not three sizes

**Column span picks the bus layout. Height picks how many buses.**

| Span | Bus layout | Height gives |
|---|---|---|
| 1 col | compact — badge stacked over figure, one across | 1 bus, 2, 3… |
| 2 col | compact, two across | 2 buses, 4, 6… |
| 3 col | today's detailed rows, full width | 1 bus, 2, 3… |

The user-facing names fall out of it:

- **small** — 1 col at minimum height, one bus
- **medium** — 2 col (two buses side by side) *or* 1 col one notch taller (two
  stacked)
- **big** — 3 col, as tall as dragged

Compact stacks badge over figure because `lineBadge.minWidth` 44 +
`arrivalBlock.minWidth` 56 = 100dp will not fit in 88dp of content at one column.

**Minimum heights** are per span, from the content each must show: one compact
bus plus the controls footer is roughly 10 pad + 16 name + 22 badge + 26 figure
+ 12 caption + 38 controls + 4 pad ≈ **132dp** at span 1 and 2. Span 3 is
header + one 62dp bus row + footer + padding ≈ **130dp**. The implementation must
measure rather than trust these; they are the design intent, not a contract.

## Controls at every size

A footer row carries schedule, alarm and filter at all three spans.

**Accepted compromise:** three targets across a 116dp tile is about **38dp**
each, under the 44pt floor (`HIT_SIZE`) the rest of the app holds. This is a
deliberate trade for having all three visible at the smallest size, and it should
be commented as such so it is not "fixed" into a single overflow menu later.

## The schedule becomes a sheet

`ScheduleGrid` moves out of the card and into `src/ui/BottomSheet.tsx`, which
already exists.

This is not cosmetic. Inline expansion grows the card, which a fixed-width tile
cannot absorb, and it is why the bottom-most row's timetable renders off-screen
today. A sheet is size-independent, so the schedule works identically at one
column and at three, and the bug cannot recur because nothing grows.

The alarm already uses `AlertPickerModal`. The line filter currently renders an
inline panel (`s.editScroll`) and should follow the schedule into a sheet for the
same reason.

## Migration

1.2.5 is unreleased, so in practice every install takes the fresh path: no stored
layout means a stop *flows* — full span, content height, stacked in order —
reproducing the 1.2.4 column. Any fractional layout written during 1.2.5
development quantises to the nearest column on load.

## What carries over

`layout.ts` keeps its shape and most of its content: the collision resolver, the
magnets, `fitAll`, and the accessibility nudges. `x`/`w` become integers, which
shrinks the search space; `y`/`h` are untouched. The RN-free structure stays,
because the same maths still runs in a render pass, in worklets and in
accessibility actions.

The tier function changes from measuring rendered width to reading `span`, which
removes a measurement round-trip.

## Out of scope

The Home header and live-status indicator, the search / Nearby / Go To row, the
saved **lines** grid and its drag, and every other screen.

## Verification

No test infrastructure; verification is `npx tsc --noEmit`, the property-test
harness `layout.ts` already has, and manual checks:

1. Place tiles at every span and confirm the three column widths.
2. Grow a 1-col tile and confirm buses appear one at a time; same at 2 col in
   pairs; same at 3 col in detailed rows.
3. Confirm schedule, alarm and filter are reachable at all three spans.
4. Open the schedule on the **bottom-most** bus of the **lowest** tile and
   confirm it appears without scrolling — the reported bug.
5. Rotate, and repeat at maximum font scale; confirm columns recompute and no
   tile is stranded.
6. TalkBack: move and resize through accessibility actions only.
7. Fresh install: confirm the flowed layout matches 1.2.4.

## Sequencing

| Phase | Content |
|---|---|
| 1 | `layout.ts`: columns replace fractional x/w; span-based tier; migration |
| 2 | `FavoriteStopCard`: one-rule bus layout by span, buses by height |
| 3 | Controls footer at every span |
| 4 | Schedule and filter into sheets — fixes the reported bug |
| 5 | Accessibility, reduce-motion, responsive sweep |
