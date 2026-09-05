# Shuv Flow

Clinic lost-lead recovery. Hebrew-first, responsive, guest-first.

## Routes

- `/`: Scroll Craft-informed marketing page with rule-driven interactive scenarios.
- `/guest/`: Complete local guest workspace, no account or cloud calls.
- `/guest/?tab=leads`, `/guest/?tab=results`, `/guest/?tab=settings`.
- `/login/`, `/signup/`: Existing account forms with an immediate guest route.
- `/app/*`: Existing Supabase-backed account implementation, preserved.
- `/privacy/`: Guest storage and product boundaries.

## Guest data and safety

Guest state is stored in localStorage under `shuvflow-guest-v1`, with validated JSON backup/restore. No multi-device sync. Browser data clearing or private browsing may discard data. Never enter sensitive medical records into this environment.

20 fictional contacts use `example.invalid` addresses and no real phones. No invented success or revenue. Nothing is sent by this application. Operators review a factual reason, copy a draft and separately record their manual actions. Opt-outs, medical escalation and insufficient evidence block outreach. A booking is not a calendar invitation; a closure is not revenue. Revenue requires separate explicit confirmation, once per contact.

CSV import previews data, consolidates contact identities, preserves safety flags and requires an operator permission acknowledgment. Export neutralizes spreadsheet formulas.

## Verification

```sh
npm ci
npm run typecheck
npm test
npm run build
python -m http.server 3080 --directory out
```

Browser acceptance: `e2e/visual.py` and `e2e/journey.py`, Python Playwright. Set `SHUV_URL` to a running local export or public production domain. Set `SHUV_SCREENSHOTS=qa`.

The marketing engine is pinned to `nateherkai/scroll-craft@0b816225945e45380397d6a0487efa3c98916858`; the MIT license is retained under `public/vendor/`. Its JavaScript is unmodified. The project-owned theme and interaction are in `app/flow.css` and `components/flow/landing.tsx`.

## Deployment

One existing Vercel project: `shuvflow`. Build an immutable GitHub commit, test it, then publish to the production domain, not a protected preview URL. `build-info.json` identifies the source commit. Existing cloud data is not migrated or deleted by the guest rebuild.
