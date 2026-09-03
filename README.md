# Shuv Flow

Shuv Flow tells a clinic which lost leads are worth revisiting today, and why.

The customer product has only three permanent areas:

- `היום` — one prioritized action
- `פניות` — a simple, human-readable lead list
- `תוצאות` — returned leads, bookings, closures and manually confirmed revenue

The hard product rule is enforced in both the interface and database:

> NO REASON. NO MESSAGE.

## Architecture

- Frontend: Next.js 16, deployed from this repository to one Vercel project
- Auth and database: Supabase project `inmftuoucmdypbautxaj`
- Browser access uses the public publishable key and row-level security
- No frontend HTML is served from Supabase Edge Functions
- Manual message sending for V1; nothing is sent without approval

## Local development

```bash
npm install
npm run dev
```

Copy `.env.example` if overriding the production public Supabase configuration.

## Verification

```bash
npm run typecheck
npm test
npm run build
```

The production journey is additionally verified with a real browser on desktop and iPhone-sized viewports.
