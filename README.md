# Cameron's Running

Personal marathon training tracker — half marathon first, then the full 42.2.

Built with Next.js 16, Tailwind CSS 4, Recharts, Prisma 5 + SQLite, and Strava API.

---

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Fill in Strava credentials in .env.local (see Strava Setup below)
# DATABASE_URL is already set to file:./dev.db

# 3. Create and seed the database
DATABASE_URL=file:./dev.db npx prisma db push
node prisma/seed.js

# 4. Run the dev server
DATABASE_URL=file:./dev.db npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

---

## Strava API Setup (required for activity sync)

1. Go to [strava.com/settings/api](https://www.strava.com/settings/api) and create an application
2. Set the **Authorization Callback Domain** to `localhost` (dev) or `kingston-running.vercel.app` (prod)
3. Copy your **Client ID** and **Client Secret** into `.env.local`:
   ```env
   STRAVA_CLIENT_ID=235112
   STRAVA_CLIENT_SECRET=your_client_secret
   REDIRECT_URI=https://kingston-running.vercel.app/api/auth/callback/strava
   STRAVA_REDIRECT_URI=http://localhost:3000/api/strava/callback
   DATABASE_URL=file:./dev.db
   ```
4. Visit the site and click **Connect Strava** to complete the OAuth flow
5. Once connected, activities sync on page load and via the **Sync with Strava** button

The OAuth flow requests the `activity:read_all` scope so all your runs (including private ones) are visible.

---

## Pages

| Route | Description |
|---|---|
| `/` | Dashboard — greeting, stats, weekly chart, today's workout, weather, recent runs |
| `/program` | Training plan table — week-by-week with completion ticks from Strava |
| `/profile` | Personal details, training stats, weight tracker, goals |

---

## Weather

Live conditions via [Open-Meteo](https://open-meteo.com/) (no API key needed).
Brisbane coordinates: lat `-27.4698`, lon `153.0251`.

---

## Deploying to Vercel

1. Push this repo to GitHub
2. Import in Vercel dashboard
3. Add environment variables:
   - `STRAVA_CLIENT_ID`
   - `STRAVA_CLIENT_SECRET`
   - `REDIRECT_URI` → `https://kingston-running.vercel.app/api/auth/callback/strava`
   - `STRAVA_REDIRECT_URI` → optional legacy override (for old `/api/strava/callback` flows)
   - `DATABASE_URL` → `file:./dev.db`
4. Update your Strava app's callback domain to your Vercel domain
5. Deploy — the build command runs `prisma generate && prisma db push && next build`

---

## Training Plans

Both plans hardcoded from Hal Higdon, all distances in km (miles × 1.60934):

- **Half Marathon Novice** — 12 weeks
- **Marathon Novice 1** — 18 weeks, unlocked after marking the half marathon complete

---

## Stack

Next.js 16 · Tailwind CSS 4 · Recharts · Prisma 5 · SQLite · Strava API · Vercel
