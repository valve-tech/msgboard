# TreeView data-view redesign

Date: 2026-06-02
Status: Approved (brainstormed via visual companion; direction C — compact flat list)

## Goal

Declutter the message data tree: clicking a value copies it, the separate copy
button is removed, long values wrap instead of pushing controls off-screen, and
expand/collapse uses chevrons.

## Approved design (direction C — compact flat list)

The component stays recursive (`TreeView` renders itself per child). Two row shapes,
chosen by whether the node has children:

- **Header rows** (nodes with children — e.g. category, message):
  `chevron · value · trailing pill`. Clicking the **chevron or the row** toggles
  expand/collapse; clicking the **value** copies it. The chevron rotates 90° when open.
- **Field rows** (leaf key:value nodes):
  `key (right-aligned, muted) · value (monospace, wraps) · decode pill`.
  Clicking the **value** copies it.

Indentation comes from the existing per-level recursion.

## Interactions

- **Click value → copy.** Copy cursor on the value; hover shows a subtle outline and a
  native `title="click to copy"` hint; on click the value **flashes** (brief green
  highlight, ~300ms). No toast, no copy button. `stopPropagation` so copying a value on a
  header row does not also toggle expansion.
- **Click chevron or header row → expand/collapse.** Replaces the current whole-row
  expand. Chevron is `mdi:chevron-right`, rotated when expanded.
- **Decode:** the per-row `0x`/`txt` control becomes a light text pill (not the switch)
  shown only on decodable values. The global "decode all" switch is unchanged.
- **Expiry:** faint pill on message rows, with the existing "time until removed" tooltip.
- **Long values wrap** (`min-w-0` + `break-all` + `whitespace-pre-wrap`); fixed siblings
  (chevron, decode, expiry) are `shrink-0`.

## Colors

Use the app's existing light palette — gray for keys/meta, indigo for accents/hover,
green for the copy flash, faint gray for pills. (The brainstorm mockup's dark colors were
illustrative only; final colors are tuned in the live app.)

## Components

- **Modify:** `packages/ui/src/components/TreeView.svelte` — new row markup, inline
  click-to-copy with flash state, chevron, decode pill, remove the `<Copy>` usage.
- **Unchanged:** `packages/ui/src/components/Copy.svelte` stays (still used by
  `SelectChain` for the RPC URL). `Summary.svelte` "decode all" toggle unchanged.

## Out of scope

Other components' copy buttons, the SelectChain layout, broader theming.
