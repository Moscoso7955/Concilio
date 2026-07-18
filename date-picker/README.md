# Terminal-green date pickers

Zero-dependency React + TypeScript date pickers with a dark "terminal green"
theme. **Weeks always start on Monday.** No date libraries, no picker libraries,
no icon fonts — plain React and component-scoped inline CSS.

## Files

- `DateRangePicker.tsx` — the flagship continuous-scroll range picker.
- `DatePicker.tsx` — a compact month-paged single-date picker (`YYYY-MM-DD`).
- `Demo.tsx` — mounts both so you can verify against the spec.

All three import only from `react`. Drop them into any React app (Vite, Next,
CRA) — no other setup.

## Usage

```tsx
import DateRangePicker from "./DateRangePicker";
import DatePicker from "./DatePicker";

<DateRangePicker
  presets={["today", "thisWeek", "thisMonth", "last3Months"]}
  onChange={(start, end) => console.log(start, end)}
/>

<DatePicker value={ymd} onChange={setYmd} />   // "YYYY-MM-DD"
```

### DateRangePicker props

| prop              | type                                   | default                                                              |
| ----------------- | -------------------------------------- | ------------------------------------------------------------------- |
| `initialStartDate`| `Date \| null`                         | `null` → today                                                      |
| `initialEndDate`  | `Date \| null`                         | `null` → today                                                      |
| `onChange`        | `(start: Date, end: Date) => void`     | —                                                                   |
| `weeksToRender`   | `number`                               | `61` (centered on today)                                            |
| `minDate`         | `Date \| null`                         | `null` (no floor)                                                   |
| `maxDate`         | `Date \| null \| undefined`            | `undefined` → **today is the max**; `null` → no cap; `Date` → cap   |
| `presets`         | `DateRangePreset[]`                    | `['today','yesterday','thisWeek','lastWeek','thisMonth','lastMonth']`; `[]` hides the column |

Committed ranges are **clamped** into `[minDate, maxDate]` (never rejected).
Clicking a day starts a fresh range; a second click commits and the popover
**stays open** (close via outside-click, Escape, or Apply). Typed `MM/DD/YYYY`
inputs are strictly validated; Apply commits and closes.

### SSR

`today`/defaults seed in a post-mount effect and the trigger renders an
invisible placeholder until mounted, so there's no hydration mismatch under
Next.js. CSS is injected via a single scoped `<style>` tag.

## Verifying visually

`Demo.tsx` needs a React runtime. Fastest path:

```bash
npm create vite@latest picker-demo -- --template react-ts
# copy the three .tsx files into src/, render <Demo /> in main.tsx
npm i && npm run dev
```

## Note for this repo

`callidus-coming-soon` is a static, no-build site (vanilla JS + Supabase), so
these `.tsx` components can't mount in the live portal without a build step.
They live here as a standalone, framework-ready library. To wire the same
look/behavior into the current portal's native date inputs, a vanilla-JS port
is required — see the conversation for options.
