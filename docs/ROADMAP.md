# Concilio — integration roadmap

Parked 2026-09-02. Not started; order to be decided.

## Bank & brokerage visibility
- **Plaid** — link bank accounts; balances and transactions in the portal.
- **Fidelity** — investment holdings per user. Christian pointed at
  Fidelity WorkplaceXchange (workplacexchange.fidelity.com/public/wpx/api-catalog).
  Those APIs (WI Balances, HRP Participant / Pay Statements / Election &
  Loan / Client Setup) are built for plan sponsors, payroll and HR
  vendors integrating with Fidelity's 401(k) recordkeeping — partner
  enrollment, not individual-investor account access. For an owner
  linking their own Fidelity brokerage/retirement account, the path is
  an aggregator (Plaid Investments covers Fidelity) unless Concilio is
  acting as a plan sponsor/vendor.
- **Schwab** and other brokerages — same, likely via an aggregator
  (Plaid Investments, Yodlee, or SnapTrade) rather than one-off APIs.

## Other
- **Crypto** — exchange / wallet balances.
- **QuickBooks** — DONE 2026-09-10: per-unit QuickBooks Online link
  (OAuth), YTD P&L sync by month, Sync-all button, plus the budget
  maker with "Inform with AI". Ported from the callidus repo and
  workspace-scoped (migrations 0038, 0039). Needs `QBO_CLIENT_ID`,
  `QBO_CLIENT_SECRET` (and `QBO_ENV=sandbox` while testing) in the
  Supabase function secrets; see SETUP.md.

## Notes
- Every integration is per-user: an owner links their own accounts and
  only they (plus admins) see them. Fits the existing RLS model.
- Aggregator credentials and tokens live in Supabase secrets / edge
  functions, never in the static site.
