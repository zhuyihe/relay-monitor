# Frontend mobile-readiness audit

## Existing strengths

- Root metadata already declares `width: device-width`.
- Dashboard, analytics, usage and own-site KPI/chart sections already use Ant Design responsive columns in several places.
- Station rows already enable wrapping.
- Own-site tables already use `scroll={{ x: "max-content" }}`.
- Chart containers use `minWidth: 0` and overflow containment.
- Login card uses `width: 100%` with a desktop maximum width.

## Main risks found

### Global shell

- `app/(dashboard)/layout.tsx` uses a fixed sidebar ProLayout and desktop-oriented header actions. Mobile collapse/drawer behavior and content padding need explicit verification.
- `app/globals.css` only contains box sizing and root dimensions; there is no project-wide mobile baseline.

### Headers and controls

- Multiple `PageContainer` instances place timestamps, segmented controls and buttons in `extra`; these can crowd narrow headers.
- Several filters have desktop minimum widths, for example the station selector on the usage page.

### Lists and forms

- Station rows rely on generic `flex-wrap`; this prevents some overflow but does not guarantee a deliberate mobile reading order.
- Notification and settings `SetRow` components retain a `minWidth: 220` description block.
- Notification list actions contain four adjacent controls.
- Fixed-cost purchase rows combine amount, days, date and delete controls in one horizontal flex row.
- Password fields use fixed 180px widths and depend on wrapping.

### Tables and charts

- Own-site tables already contain local horizontal scrolling and should be treated as the reference behavior.
- The usage page `ProTable` does not currently declare a horizontal scroll strategy.
- Charts are responsive at the grid level, but axis labels, legends, titles and fixed chart heights still require viewport testing.

### Dialogs

- Station and trend dialogs use fixed desktop widths (520px and 760px).
- Daily-report preview uses a 720px dialog and contains a fixed-height iframe.
- Dialog footer actions may become crowded on 320px-wide screens.

## Recommended implementation order

1. Shell, breakpoints and page-header behavior.
2. Dashboard and station list/dialogs.
3. Usage, own-site and analytics data surfaces.
4. Notification, settings and remaining dialogs.
5. Login and full viewport/theme regression.

## Verification note

Do not treat wrapping alone as success. Verify reading order, tap reachability, local versus page-level scrolling, and the ability to complete forms at each target viewport.
