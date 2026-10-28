# iOS look: Aurora with live data

The operator chose this look for the iOS app on 2026-10-27, from the canvas
[Trantor visual directions](https://claude.ai/artifact/RvU7i82bkPWAhAchD4RFQ1)
(bottom row, "Aurora glass at full strength, with the instrument panel's live data").
It replaces the flat navy stage on iOS. The desktop app keeps its own system
(memory: trantor-design-system); nothing here changes it.

Layout rules for iPhone Duo come from Apple, not from this doc: see "iPhone Duo" at the end
and card #12175. This doc defines the look; the layout rules decide where things go.

## The idea in one paragraph

A deep navy ground whose top edge is washed in a dark tint of the crew's standing state:
mint when all is well, amber while something waits on the operator, red while a seat has
failed. The tint fades to plain navy by mid-screen. Content sits on translucent glass. Controls are Liquid Glass. Every screen opens on a
status headline, and live numbers (turns, context, spend, activity) are shown as numbers and
sparklines, never as grey footnotes.

## Principles

1. **Headlines are per screen.** Each headline counts only what its screen shows: Decisions
   "1 waiting on you", Projects "4 projects · 1 waiting", Board counts by column, Crew
   "3 seats · 2 working", Fleet "5 online · 6 seats", Feed "6 events", Inbox "1 unread".
   Chat keeps only its slim model and context line. Headlines use 26pt with Dynamic Type,
   stay on one line and truncate rather than wrap. Omit the eyebrow when navigation already
   names the screen. The wash still carries the standing state. Counts only, no adjectives.
2. **Color carries state, never events.** The wash changes when the standing state changes
   and stays until it changes again. It never flashes, pulses or animates (monitoring
   doctrine: state, not event).
3. **Glass for surfaces, solid color for actions.** Panels and controls are glass. The one
   primary action on a card is solid mint. Destructive actions are glass with a red label.
4. **Real data only.** A sparkline or number appears only when the hub has the series behind
   it. No placeholder charts, no invented trends. When data is missing the element is absent,
   not faked.
5. **One accent.** Mint is the only accent. Amber and red mean state. Seat and project hues
   come from `Palette.hue(for:)` and appear only on their orbs.

## Tokens

All tokens live in `ios/Packages/TrantorDesign/Sources/TrantorDesign/Tokens.swift`, the only
file that defines a color. Existing names keep their values unless listed here.

### Ground

| Token | Value | Use |
|---|---|---|
| `Palette.auroraGround` | `#070A16` | the base under every screen |
| `Palette.text` | `#F2F5FB` (was `#E8EDF7`) | primary text on glass |
| `Palette.text2` | `#C9D2E6` (was `#AEB8CF`) | secondary text on glass |

`text2` gets lighter because glass over light lowers contrast. Both pass 4.5:1 on the
lightest glass over the brightest point of each state wash; check with the contrast test below.

### State wash

Changed 2026-10-28: the operator dropped the radial glows ("the blobs") after seeing them in
the simulator, and chose option B on the canvas row "Option: no blobs, the background itself
changes color". No radial shapes anywhere.

The background is one full-width vertical gradient over `auroraGround`, three stops:

| Standing state | 0% (top) | 45% | 100% (bottom) |
|---|---|---|---|
| all clear (nothing waits, nothing failed) | `#0F2A26` | `#0A1416` | `#070A16` |
| something waits on the operator | `#2A220C` | `#15120C` | `#070A16` |
| a seat or gate has failed | `#2C1119` | `#160C12` | `#070A16` |

Red outranks amber, which outranks mint. The stops are fractions of the screen height, so the
wash follows any size and pose. It is drawn once per screen as the background, never per card,
and never animated: a state change swaps it with the standard 0.22 s ease, nothing more.

### Glass

| Token | Fill | Stroke | Material | Use |
|---|---|---|---|---|
| `Glass.panel` | white 7% | white 14% | `.ultraThinMaterial` | cards, tiles, chat bubbles |
| `Glass.control` | white 10% | white 16% | `.ultraThinMaterial` | buttons on glass, segmented pickers |
| `Glass.selected` | white 18% | none | none | selected tab, selected segment |

The blur comes from the system material, which sets its own radius; the mockups' CSS blur of
30 has no native equivalent and is not a token.

On iOS 26 and later, controls use the system Liquid Glass (`.glassEffect`) where SwiftUI
offers it, and `Glass.control` is the fallback. Panels use `Glass.panel` as a material.

### State emphasis

- A card that waits on the operator gets an amber ring: 1 pt amber at 28% plus a soft amber
  shadow (radius 60, 12 to 14%). Nothing else on the screen uses amber.
- The orchestrator's own messages and the operator's bubbles: operator bubbles are mint at
  22% fill with a mint 35% stroke; orchestrator bubbles are `Glass.panel`.
- The focused composer gets a 1 pt mint ring at 45%.

### Orbs

A seat, person or session is a circle; a project is a rounded square (desktop rule, kept).
A seat orb is a radial gradient of its `Palette.hue(for:)` color, lighter at the top left,
with a soft glow of the same hue at 55%. Sizes: 36 on seat cards, 28 in compact rows, 26 in
the typing strip.

### Shape

| Token | Value | Use |
|---|---|---|
| `Radius.card` | 28 | seat cards, decision cards |
| `Radius.tile` | 24 | stat tiles, compact rows |
| `Radius.bubble` | 24, with the tail corner 8 | chat bubbles |
| `Radius.capsule` | height / 2 | buttons, composer, tab bar, strip |

Touch targets stay at 44 pt or more.

### Type

Geist for text, JetBrains Mono for every number that is compared (counts, percentages,
spend, card ids, timestamps). Mono never appears in chrome labels.

| Role | Size / weight |
|---|---|
| Status headline | 26 semibold, tracking -0.4, one line with tail truncation |
| Stat tile figure | 26 mono medium |
| Card title / seat name | 16 to 17 semibold |
| Body and chat | 16 regular, line height 1.55 |
| Eyebrow label | 12 mono, tracking 2, uppercase |
| Caption | 13 regular, `text2` |

All sizes scale with Dynamic Type.

## Components

Each is a TrantorDesign view; screens compose them and never restyle them inline.

- **`AuroraBackground(state:)`**: the ground plus the state wash for a standing state.
- **`StatusHeadline`**: per-screen headline counts, with an optional eyebrow only when navigation does not name the screen.
- **`StatTile`**: a mono figure and a caption on `Glass.panel`. Up to three in a row, and
  only for numbers the hub reports (turns today, cards shipped, metered spend).
- **`DecisionCard`**: amber ring, "Waiting for you · <age>", one sentence, and the two
  actions (No-go as glass, Go as solid mint). A compact one-row form is used when the
  keyboard is up.
- **`SeatCard`**: orb, name, card id and turn age, a sparkline of the seat's recent
  activity, a caption for what it is doing, and context percentage in mono. A compact row
  form (orb, name, sparkline, percentage) is used when space is short.
- **`Sparkline`**: a 2.4 pt mint line with round caps, no axes, no fill. Grey (`textFaint`)
  when the seat is idle.
- **`ChatBubble`**: the two bubble styles above. Tool calls fold into a small mono chip under
  the message ("trantor swap · 41s"), never a full code block.
- **`AskCard`**: a question with one glass capsule button per option.
- **`Composer`**: a floating `Glass.panel` capsule holding the attach button, the field and
  the mint Send button with a soft mint glow. Send is always the trailing element.

## Layout by pose

Where the strip and bars go follows Apple's iPhone Duo rules (tech talks 111462 and 111466):
horizontal bars only on the open display in portrait; everywhere else the system controls
live in the vertical strip on the right edge.

| Pose | Layout |
|---|---|
| Closed | One column. Strip on the right. Headline, then the screen's content. |
| Open, landscape | Two equal halves divided at the fold. Crew, queue or list on the left; chat or detail on the right, so Send sits at the bottom right by the thumb. Strip on the right edge. |
| Open, landscape, typing | Full-width keyboard across the bottom. Left half compacts to headline, compact decision row and compact seat rows. Right half keeps the latest messages with the composer on the keyboard. The strip overflows into a More button. |
| Open, portrait | Top bar (back, project name, segmented picker) and bottom tab bar. Crew in the top half, chat in the bottom half, composer above the tab bar. |
| Open, portrait, typing | The tab bar hides. Crew folds into one glass strip at the top (headline, seat orbs, a button to the waiting decision). Chat fills the middle, composer on the keyboard. |
| Half folded | Content and controls stay off the crease. Use the system components so their fold avoidance applies. |

The mockups for each pose are the canvas's bottom row. Half-folded screens are not drawn yet
and come with the Duo layout work.

## Accessibility

- **Reduce Transparency:** glass becomes solid `Palette.panel2` with the same strokes, and the
  state wash keeps its colors (it has no transparency to remove).
- **Increase Contrast:** strokes go to 30%, `text2` becomes `text`.
- **Reduce Motion:** nothing in this look animates, so nothing changes.
- **Contrast test:** a snapshot test renders `text` and `text2` on `Glass.panel` over each
  state wash at its top stop and fails under 4.5:1.
- Color never carries meaning alone. Every amber or red state also has words ("Waiting for
  you", "Failed").

## Performance

- The state wash is one static background per screen, not per view, and never animated.
- Blur only on panels, controls and the composer; never nested more than two deep.
- Sparklines draw from data already on the device; no extra network calls to draw them.

## Not part of this look

- No state wash or glow on the desktop app. It keeps its calm neutral system.
- No gradients inside cards, no glowing text, no emoji, no left-border accent cards.
- No decorative charts. A sparkline with no data behind it is not drawn.

## Rollout

1. **Tokens and components.** Add the tokens and the components above to TrantorDesign, with
   the contrast snapshot test. No screen changes yet.
2. **Screens on the phone as it is today.** Move Decisions, Projects (Chat, Board, Crew),
   Fleet, Feed and Inbox onto the components, single column.
3. **iPhone Duo layouts** (card #12175, then the two-pane card): the poses above, using the
   same components.

The data a seat card shows must exist first: per-seat activity history, context percentage
and turn age come from the hub. Where the hub does not publish one of them yet, that piece is
left out until it does, and gets its own card.
