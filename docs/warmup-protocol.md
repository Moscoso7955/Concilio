# Concilio Mail — Warm-up Protocol

*How the Owner Portal ramps a new sending domain so venue newsletters
land in inboxes, not spam folders. Built into the Marketing tab;
nothing here requires manual bookkeeping.*

## Why warm-up exists

Gmail, Outlook, and Yahoo score every sending domain on history. A
brand-new domain (e.g. `news.barphoebe.com`) has none — and a
history-less domain that suddenly blasts thousands of emails looks
exactly like a spammer warming up a burner. The consequence isn't a
bounce you'd notice; it's silent spam-foldering that can take months to
undo. The fix is universal: start small, grow steadily, let positive
signals (opens, non-complaints) accumulate. This protocol automates
that.

## The ramp

Each venue's daily send allowance grows with its **lifetime delivered
volume** — every email actually handed to Resend is recorded
per-recipient in the `mail_deliveries` ledger, and the cap is enforced
over a rolling 24-hour window:

| Lifetime delivered | Daily cap |
| ---: | ---: |
| 0 – 499 | **150 / day** |
| 500 – 1,999 | **400 / day** |
| 2,000 – 4,999 | **1,000 / day** |
| 5,000 – 14,999 | **3,000 / day** |
| 15,000 + | **unlimited** |

Example: a venue with a 900-address list sends its first campaign as
150 → 150 → 400 → 200 over four days, then the next campaign starts at
the 400/day tier and clears in three.

Rules of the ramp:

- **Rolling 24 hours, not calendar days.** If 150 went out at 6 PM
  Tuesday, the next chunk unlocks around 6 PM Wednesday.
- **Per venue.** Every sending domain earns its own history; Bar
  Phoebe's volume doesn't loosen Barranco's cap.
- **All campaigns share the venue's window.** Two campaigns in one day
  split the day's allowance; they don't double it.
- **Test sends are exempt** — they go only to you and don't count.

## What you see in the portal

1. **Send** a campaign as normal. If the active list fits inside
   today's remaining allowance, it all goes out and the campaign is
   marked **SENT**.
2. If the list is bigger, the campaign sends up to the cap and sits in
   **SENDING** with an exact "N so far" count and a **Continue send**
   button.
3. Click **Continue send** any time after the window frees up (next
   day is the simple habit) — it sends the next chunk *only to people
   who haven't received it*. Repeat until the campaign flips to
   **SENT**.
4. Trying to continue before the window frees up just tells you the
   cap is used — nothing sends, nothing breaks.

**Nobody can ever receive a campaign twice.** Every delivery is
recorded individually before the next chunk is computed, so stopping,
resuming, retrying after an error, or even double-clicking is always
safe.

## The per-venue toggle

Each sender profile has a **Warm-up** checkbox, ON by default.

- **Leave it on** for any domain that has never sent bulk email —
  which is every `news.*` subdomain we just created.
- **Turn it off** only for a domain with an established bulk-sending
  history. Once a venue crosses 15,000 lifetime deliveries the cap is
  gone anyway, so there's rarely a reason to touch it.

## How it plays with the rest of the system

- **Suppression comes first.** Unsubscribed, bounced, and complained
  addresses are excluded before the cap is applied — the allowance is
  never wasted on dead addresses.
- **Bounces/complaints during a ramp** (Resend webhook) suppress the
  address immediately and notify the venue app, so later chunks of the
  same campaign already skip them. High early bounce rates are the #1
  warm-up killer; this contains them automatically.
- **Sent counts are exact** — the campaign list shows true delivered
  numbers from the ledger, not batch estimates.

## First-campaign playbook (per venue)

1. Sync or import the list; check the active-subscriber count.
2. **Send test** to yourself — check branding, footer address,
   unsubscribe link, and that it landed in the inbox (not spam).
3. Send for real. Day one goes to the first 150.
4. Next day, **Continue send**. Repeat until SENT.
5. Watch the Resend dashboard the first week: keep bounce rate under
   ~3% and complaints under ~0.1%. If either spikes, pause (just stop
   continuing) and clean the list before resuming.

Content matters during warm-up too: real venue news people want,
a recognizable from-name, and no link-shortener URLs.

## Mechanics (for the technically curious)

- Enforced server-side in the `mail-send` function — the UI can't
  bypass it.
- `mail_deliveries` rows: campaign, venue, recipient, timestamp.
  Unique per (campaign, recipient) — the double-send guarantee.
- Cap check = stage (from lifetime count) minus deliveries in the last
  24 h; the send takes `min(remaining recipients, allowance)`.
- Campaign status: `sending` while chunks remain, `sent` when the
  last active subscriber has it.
