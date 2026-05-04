import prisma from "./db";
import { fetchHistoricalWeather, BRISBANE_LAT, BRISBANE_LON } from "./weather";

const STRAVA_AUTH_URL = "https://www.strava.com/oauth/authorize";
const STRAVA_TOKEN_URL = "https://www.strava.com/oauth/token";
const STRAVA_API = "https://www.strava.com/api/v3";

const CLIENT_ID = process.env.STRAVA_CLIENT_ID!;
const CLIENT_SECRET = process.env.STRAVA_CLIENT_SECRET!;
const REDIRECT_URI = process.env.STRAVA_REDIRECT_URI!;

export function getStravaAuthUrl(): string {
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    approval_prompt: "auto",
    scope: "activity:read_all",
  });
  return `${STRAVA_AUTH_URL}?${params}`;
}

export async function exchangeStravaCode(code: string): Promise<{
  access_token: string;
  refresh_token: string;
  expires_at: number;
}> {
  // Use form-encoded: Strava's token endpoint requires client_id as a number,
  // which URLSearchParams handles correctly (vs JSON where env vars are strings).
  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    code,
    grant_type: "authorization_code",
    redirect_uri: REDIRECT_URI,
  });

  console.log("[strava] exchanging code, client_id:", CLIENT_ID, "redirect_uri:", REDIRECT_URI);

  const res = await fetch(STRAVA_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!res.ok) {
    const text = await res.text();
    console.error("[strava] token exchange failed:", res.status, text);
    throw new Error(`Strava token exchange failed: ${res.status} — ${text}`);
  }

  return res.json();
}

export async function refreshStravaToken(refreshToken: string): Promise<{
  access_token: string;
  refresh_token: string;
  expires_at: number;
}> {
  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });

  const res = await fetch(STRAVA_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!res.ok) {
    const text = await res.text();
    console.error("[strava] token refresh failed:", res.status, text);
    throw new Error(`Strava token refresh failed: ${res.status} — ${text}`);
  }

  return res.json();
}

async function getValidToken(): Promise<string | null> {
  const profile = await prisma.profile.findUnique({ where: { id: 1 } });
  if (!profile?.stravaToken) return null;

  const now = new Date();
  const expiry = profile.stravaTokenExpiry;
  // Refresh 60 seconds early to avoid edge-case expiry
  if (expiry && expiry.getTime() - 60_000 > now.getTime()) return profile.stravaToken;

  if (!profile.stravaRefresh) return null;

  try {
    const tokens = await refreshStravaToken(profile.stravaRefresh);
    const newExpiry = new Date(tokens.expires_at * 1000);
    await prisma.profile.update({
      where: { id: 1 },
      data: {
        stravaToken: tokens.access_token,
        stravaRefresh: tokens.refresh_token,
        stravaTokenExpiry: newExpiry,
      },
    });
    return tokens.access_token;
  } catch {
    return null;
  }
}

interface StravaActivity {
  id: number;
  name?: string;
  start_date: string;
  distance: number;
  moving_time: number;
  elapsed_time: number;
  average_speed: number;
  average_heartrate?: number;
  max_heartrate?: number;
  calories?: number;
  kilojoules?: number;
  sport_type: string;
  type: string;
  total_elevation_gain?: number;
  start_latlng?: [number, number];
  manual?: boolean;
}

export interface StravaSplit {
  distance: number;
  moving_time: number;
  average_speed: number;
  average_grade_adjusted_speed?: number;
  average_heartrate?: number;
}

export interface StravaFullActivity extends StravaActivity {
  elapsed_time: number;
  splits_metric?: StravaSplit[];
}

export async function fetchFullActivity(activityId: string): Promise<StravaFullActivity | null> {
  const token = await getValidToken();
  if (!token) return null;

  const res = await fetch(
    `${STRAVA_API}/activities/${activityId}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );

  if (!res.ok) {
    console.error("[strava] fetchFullActivity failed:", res.status);
    return null;
  }

  return res.json();
}

function sportTypeToLabel(sportType: string): string {
  switch (sportType) {
    case "Run":
    case "VirtualRun":
      return "running";
    case "TrailRun":
      return "trail_running";
    case "Ride":
    case "VirtualRide":
    case "EBikeRide":
    case "GravelRide":
      return "cycling";
    case "Swim":
      return "swimming";
    case "Walk":
    case "Hike":
      return "walking";
    default:
      return sportType.toLowerCase();
  }
}

export async function syncActivities(): Promise<{ synced: number; errors: number }> {
  const token = await getValidToken();
  if (!token) return { synced: 0, errors: 0 };

  const thirtyDaysAgo = Math.floor((Date.now() - 30 * 24 * 60 * 60 * 1000) / 1000);

  const res = await fetch(
    `${STRAVA_API}/athlete/activities?after=${thirtyDaysAgo}&per_page=50`,
    { headers: { Authorization: `Bearer ${token}` } }
  );

  if (!res.ok) return { synced: 0, errors: 1 };

  const activities: StravaActivity[] = await res.json();

  let synced = 0;
  let errors = 0;

  for (const act of activities) {
    try {
      const id = String(act.id);
      const existing = await prisma.activity.findUnique({ where: { id } });
      if (existing) continue;

      // average_speed is m/s → convert to sec/km
      const avgPaceSecKm = act.average_speed > 0 ? Math.round(1000 / act.average_speed) : 0;

      // Strava gives kilojoules for cycling, calories for running
      const calories = act.calories
        ? Math.round(act.calories)
        : act.kilojoules
        ? Math.round(act.kilojoules * 0.239)
        : null;

      const actDate  = new Date(act.start_date);
      const startLat = act.start_latlng?.[0] ?? null;
      const startLon = act.start_latlng?.[1] ?? null;

      await prisma.activity.create({
        data: {
          id,
          name:           act.name ?? null,
          date:           actDate,
          distanceKm:     act.distance / 1000,
          durationSecs:   act.moving_time,
          avgPaceSecKm,
          avgHeartRate:   act.average_heartrate ? Math.round(act.average_heartrate) : null,
          maxHeartRate:   act.max_heartrate     ? Math.round(act.max_heartrate)     : null,
          calories,
          activityType:   sportTypeToLabel(act.sport_type || act.type),
          elevationGainM: act.total_elevation_gain ?? null,
          startLat,
          startLon,
        },
      });

      // Fetch and store historical weather inline
      const weather = await fetchHistoricalWeather(
        startLat ?? BRISBANE_LAT,
        startLon ?? BRISBANE_LON,
        actDate
      );
      if (weather) {
        await prisma.activity.update({
          where: { id },
          data:  { temperatureC: weather.temperatureC, humidityPct: weather.humidityPct },
        });
      }

      synced++;
    } catch {
      errors++;
    }
  }

  return { synced, errors };
}

export function formatPace(secPerKm: number): string {
  if (!secPerKm || secPerKm <= 0) return "—";
  const mins = Math.floor(secPerKm / 60);
  const secs = secPerKm % 60;
  return `${mins}:${secs.toString().padStart(2, "0")} /km`;
}

export function formatDuration(secs: number): string {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  if (h > 0) return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  return `${m}:${s.toString().padStart(2, "0")}`;
}
