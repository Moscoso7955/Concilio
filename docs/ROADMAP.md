# Concilio — integration roadmap

Parked 2026-09-02. Not started; order to be decided.

## Bank & brokerage visibility
- **Plaid** — link bank accounts; balances and transactions in the portal.
- **Fidelity** — investment holdings per user.
- **Schwab** and other brokerages — same, likely via an aggregator
  (Plaid Investments, Yodlee, or SnapTrade) rather than one-off APIs.

## Other
- **Crypto** — exchange / wallet balances.
- **QuickBooks** — carried over from Callidus (invoice `qbo` flag, chart
  of accounts tooling). Keep as-is for now.

## Notes
- Every integration is per-user: an owner links their own accounts and
  only they (plus admins) see them. Fits the existing RLS model.
- Aggregator credentials and tokens live in Supabase secrets / edge
  functions, never in the static site.
