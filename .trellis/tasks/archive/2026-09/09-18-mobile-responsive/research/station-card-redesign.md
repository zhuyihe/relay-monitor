# Mobile station card implementation plan

## Scope guardrail

Change only the mobile station page header and station-card presentation. Keep provider calculations, refresh behavior, trend loading, APIs, dialogs, and desktop management behavior unchanged.

## Files

### `app/(dashboard)/stations/page.tsx`

- Read the Ant Design breakpoint once in `StationsPage` and pass a compact/mobile flag into each station row.
- Keep the existing desktop station-row markup as the desktop branch to minimise regression risk.
- Add a purpose-built mobile branch using the already computed station view data.
- Render explicit fields instead of reusing the desktop `pieces[]` stream:
  - identity/status;
  - amount;
  - compact metadata;
  - today usage and optional token detail;
  - ETA;
  - full-width sparkline;
  - trend and refresh actions.
- Mobile page-header toolbar omits the add button. Desktop header remains unchanged.
- Fixed-cost rows use the same mobile skeleton without trend/refresh actions that do not apply.

### `app/globals.css`

- Replace the generic mobile `.station-row` stacking rules with dedicated station-card classes.
- Use a top grid with `40px minmax(0, 1fr) auto` for icon, identity, and amount.
- Use a two-column metric grid below the header.
- Let the sparkline occupy the full content width.
- Use a compact footer with a text trend action and refresh action.
- Reduce the mobile station-list card padding to 16px without changing desktop ProCard padding.
- Hide mobile management actions structurally or through an explicit mobile-only branch, not through accidental overflow.

## Suggested mobile skeleton

```text
[NA]  Station name   [status]        ¥8,851.62
      New API · account · 22s ago

Today usage                         Estimated runway
¥5.83                               188 days

48h balance trend ─────────────────────────────

View trend                                  Refresh
```

## Verification loop

1. Render `/stations` at 320 × 568 with representative station data.
2. Assert root `scrollWidth <= clientWidth`.
3. Measure the first normal station card height; target `<=190px`.
4. Confirm amount bounding box does not overlap or wrap into the identity block.
5. Confirm add/edit/delete are absent below 768px and present at 768px/desktop.
6. Repeat with long identity, error state, missing sparkline, and fixed-cost fixtures.
7. Recheck 768px and 1440px desktop screenshots before running build and tests.

## Non-goals

- No new responsive framework.
- No station data or forecasting changes.
- No mobile adaptation of edit/add dialogs in this rework.
- No visual redesign of other routes.
