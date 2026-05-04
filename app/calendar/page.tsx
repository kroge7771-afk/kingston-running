import prisma from "@/lib/db";
import { trainingPlan } from "@/data/trainingPlan";
import {
  calculateRunRating,
  resolveRunType,
} from "@/lib/rating";
import {
  calculateRunnerRating,
  calculateHMReadiness,
  type RunnerRatingResult,
  type HMReadinessResult,
} from "@/lib/readiness";
import { dbSettingsToUserSettings, DEFAULT_SETTINGS } from "@/lib/settings";
import { getPlanWeekForDate, getSessionDate } from "@/lib/planUtils";
import { formatAEST, toAEST } from "@/lib/dateUtils";
import type { CalendarRun, CalendarData } from "./types";
import CalendarGrid from "./CalendarGrid";
import Logo from "@/components/Logo";

export const dynamic = "force-dynamic";

// ── helpers ──────────────────────────────────────────────────────────────────

function ratingColor(score: number): { bg: string; text: string } {
  if (score >= 85) return { bg: "#1e1a2e", text: "#AFA9EC" };
  if (score >= 70) return { bg: "#0a1e0f", text: "#5DCAA5" };
  if (score >= 55) return { bg: "#0a0f1e", text: "#85B7EB" };
  if (score >= 40) return { bg: "#2e1e0a", text: "#EF9F27" };
  return                  { bg: "#2e1010", text: "#F09595" };
}

function hmColor(pct: number): { bg: string; text: string } {
  return ratingColor(pct);
}

function isPlannedSession(date: Date): boolean {
  const weekNum = getPlanWeekForDate(date);
  if (weekNum <= 0 || weekNum > trainingPlan.length) return false;
  const planWeek = trainingPlan[weekNum - 1];
  const ra = toAEST(date);
  return planWeek.sessions.some((s) => {
    const sd = toAEST(getSessionDate(weekNum, s.day));
    return (
      ra.getUTCFullYear() === sd.getUTCFullYear() &&
      ra.getUTCMonth()    === sd.getUTCMonth()    &&
      ra.getUTCDate()     === sd.getUTCDate()
    );
  });
}

// ── component bars ────────────────────────────────────────────────────────────

function ComponentBar({
  label,
  value,
  max,
  accent,
}: {
  label: string;
  value: number;
  max: number;
  accent: string;
}) {
  const pct = Math.min(100, (value / max) * 100);
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="shrink-0" style={{ color: "var(--text-muted)", width: 76 }}>
        {label}
      </span>
      <div
        className="flex-1 rounded-sm overflow-hidden"
        style={{ height: 4, background: "rgba(255,255,255,0.06)" }}
      >
        <div style={{ width: `${pct}%`, height: "100%", background: accent, borderRadius: 2 }} />
      </div>
      <span className="text-white shrink-0" style={{ width: 32, textAlign: "right" }}>
        {value.toFixed(1)}
      </span>
    </div>
  );
}

function SubBar({
  label,
  pct,
  accent,
}: {
  label: string;
  pct: number;
  accent: string;
}) {
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="shrink-0" style={{ color: "var(--text-muted)", width: 80 }}>
        {label}
      </span>
      <div
        className="flex-1 rounded-sm overflow-hidden"
        style={{ height: 3, background: "rgba(255,255,255,0.06)" }}
      >
        <div style={{ width: `${pct}%`, height: "100%", background: accent, borderRadius: 2 }} />
      </div>
      <span className="text-white shrink-0" style={{ width: 28, textAlign: "right" }}>
        {pct}%
      </span>
    </div>
  );
}

// ── page ──────────────────────────────────────────────────────────────────────

export default async function CalendarPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params       = await searchParams;
  const today        = new Date();
  const todayAEST    = toAEST(today);
  const defaultYear  = todayAEST.getUTCFullYear();
  const year         = parseInt(params.year as string) || defaultYear;

  // AEST midnight of Jan 1 and Jan 1 (next year) = UTC Dec 31 14:00
  const yearStart = new Date(Date.UTC(year - 1, 11, 31, 14, 0, 0));
  const yearEnd   = new Date(Date.UTC(year,     11, 31, 14, 0, 0));

  // Stats always use the last 90 days regardless of displayed year
  const statsStart = new Date(today.getTime() - 90 * 24 * 60 * 60 * 1000);

  const [profile, userSettingsRow, yearActivities, statsActivities, bestPaceRow] = await Promise.all([
    prisma.profile.findUnique({ where: { id: 1 } }),
    prisma.userSettings.findUnique({ where: { id: 1 } }),
    prisma.activity.findMany({
      where: {
        activityType: { in: ["running", "trail_running"] },
        date: { gte: yearStart, lt: yearEnd },
      },
      orderBy: { date: "asc" },
    }),
    prisma.activity.findMany({
      where: {
        activityType: { in: ["running", "trail_running"] },
        date: { gte: statsStart, lt: today },
      },
      orderBy: { date: "asc" },
    }),
    prisma.activity.findFirst({
      where:   { activityType: { in: ["running", "trail_running"] } },
      orderBy: { avgPaceSecKm: "asc" },
    }),
  ]);

  const settings    = userSettingsRow ? dbSettingsToUserSettings(userSettingsRow) : DEFAULT_SETTINGS;
  const athleteAge  = profile?.dateOfBirth
    ? Math.floor((Date.now() - new Date(profile.dateOfBirth).getTime()) / (365.25 * 86400000))
    : 23;
  const pbPaceSecKm = bestPaceRow?.avgPaceSecKm ?? null;

  // ── Compute top-strip stats ──────────────────────────────────────────────
  const runnerRating = calculateRunnerRating(statsActivities, trainingPlan, settings, pbPaceSecKm);
  const hmReadiness  = calculateHMReadiness(statsActivities, trainingPlan, settings);

  // Derive stats strip values
  const todayMidnight = new Date(
    Date.UTC(todayAEST.getUTCFullYear(), todayAEST.getUTCMonth(), todayAEST.getUTCDate()) -
      10 * 60 * 60 * 1000
  );
  const MS         = 24 * 60 * 60 * 1000;
  const past28     = new Date(todayMidnight.getTime() - 28 * MS);
  const past42     = new Date(todayMidnight.getTime() - 42 * MS);
  const monthStart = new Date(
    Date.UTC(todayAEST.getUTCFullYear(), todayAEST.getUTCMonth(), 1) - 10 * 60 * 60 * 1000
  );

  function aestKey(d: Date): string {
    const a = toAEST(d);
    return `${a.getUTCFullYear()}-${String(a.getUTCMonth() + 1).padStart(2, "0")}-${String(a.getUTCDate()).padStart(2, "0")}`;
  }

  const PLAN_DOW = new Set([0, 3, 6]); // Sun, Wed, Sat in AEST

  // Extra runs this month
  const extraRunsThisMonth = statsActivities.filter((r) => {
    const d = new Date(r.date);
    if (d < monthStart || d >= todayMidnight) return false;
    return !PLAN_DOW.has(toAEST(d).getUTCDay());
  }).length;

  // Long runs: last 6 weeks
  let longPlanned = 0;
  let longDone    = 0;
  const statsKeys = new Set(statsActivities.map((r) => aestKey(new Date(r.date))));

  for (const pw of trainingPlan) {
    const ls = pw.sessions.find((s) => s.type === "long");
    if (!ls) continue;
    const sd = getSessionDate(pw.week, ls.day);
    if (sd >= todayMidnight || sd < past42) continue;
    longPlanned++;
    if (statsKeys.has(aestKey(sd))) longDone++;
  }

  // All plan sessions this month
  let sessPlanned = 0;
  let sessDone    = 0;
  for (const pw of trainingPlan) {
    for (const sess of pw.sessions) {
      const sd = getSessionDate(pw.week, sess.day);
      if (sd < monthStart || sd >= todayMidnight) continue;
      sessPlanned++;
      if (statsKeys.has(aestKey(sd))) sessDone++;
    }
  }

  // Avg rating last 4 weeks
  const runsLast28 = statsActivities.filter((r) => new Date(r.date) >= past28 && new Date(r.date) < todayMidnight);
  const ratings28  = runsLast28.map((r) => {
    const type = resolveRunType(r, trainingPlan, settings);
    return calculateRunRating({
      distanceKm: r.distanceKm, avgPaceSecKm: r.avgPaceSecKm,
      avgHeartRate: r.avgHeartRate, temperatureC: r.temperatureC,
      humidityPct: r.humidityPct, runType: type,
      personalBestPaceSecKm: pbPaceSecKm, athleteAgeYears: athleteAge,
      settings,
    }).total;
  });
  const avgRating28 = ratings28.length > 0
    ? Math.round((ratings28.reduce((s, r) => s + r, 0) / ratings28.length) * 10) / 10
    : null;

  // ── Build calendar data map ──────────────────────────────────────────────
  const calendarData: CalendarData = {};

  for (const act of yearActivities) {
    const dateKey = formatAEST(act.date, "yyyy-MM-dd");
    if (!calendarData[dateKey]) calendarData[dateKey] = [];

    const runType  = resolveRunType(act, trainingPlan, settings);
    const hasRating = act.avgPaceSecKm > 0 && act.avgHeartRate != null;
    const rating   = hasRating
      ? calculateRunRating({
          distanceKm: act.distanceKm, avgPaceSecKm: act.avgPaceSecKm,
          avgHeartRate: act.avgHeartRate, temperatureC: act.temperatureC,
          humidityPct: act.humidityPct, runType,
          personalBestPaceSecKm: pbPaceSecKm, athleteAgeYears: athleteAge,
          settings,
        })
      : null;

    const run: CalendarRun = {
      id: act.id,
      name: act.name,
      dateIso: act.date.toISOString(),
      distanceKm: act.distanceKm,
      durationSecs: act.durationSecs,
      avgPaceSecKm: act.avgPaceSecKm,
      avgHeartRate: act.avgHeartRate,
      maxHeartRate: act.maxHeartRate,
      calories: act.calories,
      elevationGainM: act.elevationGainM,
      temperatureC: act.temperatureC,
      humidityPct: act.humidityPct,
      activityType: act.activityType,
      rating,
      runType,
      isPlanned: isPlannedSession(act.date),
    };

    calendarData[dateKey].push(run);
  }

  // ── Render ────────────────────────────────────────────────────────────────
  const rrColor  = ratingColor(runnerRating.total);
  const hmColor_ = hmColor(hmReadiness.total);
  const todayKey = formatAEST(today, "yyyy-MM-dd");

  const COMPONENT_LABELS: Array<{ key: keyof RunnerRatingResult & string; label: string; max: number }> = [
    { key: "consistency", label: "Consistency", max: 20 },
    { key: "progress",    label: "Progress",    max: 20 },
    { key: "longRuns",    label: "Long Runs",   max: 25 },
    { key: "injuryFree",  label: "Injury-free", max: 20 },
    { key: "extras",      label: "Extras",      max: 15 },
  ];

  return (
    <div className="space-y-5">
      {/* ── Page header ──────────────────────────────────────────────────── */}
      <div className="flex items-center gap-3">
        <Logo size="sm" showWordmark={false} />
        <h1 className="text-xl font-bold text-white">Calendar</h1>
      </div>

      {/* ── Top strip ───────────────────────────────────────────────────── */}
      <div className="grid grid-cols-3 gap-4">

        {/* Panel 1: Kingston&apos;s Runner Rating */}
        <div
          className="rounded-[10px] p-4 space-y-3"
          style={{ background: "#181818", border: "1px solid rgba(255,255,255,0.08)" }}
        >
          <p className="text-xs uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>
            Kingston&apos;s Runner Rating
          </p>
          <div className="flex items-end gap-3">
            <span
              className="text-5xl font-bold leading-none"
              style={{ color: rrColor.text }}
            >
              {runnerRating.total}
            </span>
            <span className="text-sm mb-1" style={{ color: "var(--text-muted)" }}>
              / 100
            </span>
          </div>
          <div className="space-y-1.5 pt-1">
            {COMPONENT_LABELS.map(({ key, label, max }) => (
              <ComponentBar
                key={key}
                label={label}
                value={runnerRating[key] as number}
                max={max}
                accent={rrColor.text}
              />
            ))}
          </div>
        </div>

        {/* Panel 2: HM Readiness */}
        <div
          className="rounded-[10px] p-4 space-y-3"
          style={{ background: "#181818", border: "1px solid rgba(255,255,255,0.08)" }}
        >
          <p className="text-xs uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>
            HM Readiness
          </p>
          <div className="flex items-end gap-3">
            <span
              className="text-5xl font-bold leading-none"
              style={{ color: hmColor_.text }}
            >
              {hmReadiness.total}%
            </span>
          </div>
          {/* Filled bar */}
          <div
            className="h-1.5 rounded-full overflow-hidden"
            style={{ background: "rgba(255,255,255,0.08)" }}
          >
            <div
              className="h-full rounded-full"
              style={{ width: `${hmReadiness.total}%`, background: hmColor_.text }}
            />
          </div>
          <div className="space-y-1.5 pt-1">
            <SubBar label="Pace"        pct={hmReadiness.pace}        accent={hmColor_.text} />
            <SubBar label="Consistency" pct={hmReadiness.consistency} accent={hmColor_.text} />
            <SubBar label="Long Run"    pct={hmReadiness.longRun}     accent={hmColor_.text} />
          </div>
        </div>

        {/* Panel 3: Stats strip */}
        <div
          className="rounded-[10px] p-4"
          style={{ background: "#181818", border: "1px solid rgba(255,255,255,0.08)" }}
        >
          <p className="text-xs uppercase tracking-wider mb-3" style={{ color: "var(--text-muted)" }}>
            Stats
          </p>
          <div className="space-y-3">
            {[
              { label: "Injury-free streak",     value: `${runnerRating.injuryFreeWeeks} wks` },
              { label: "Extra runs this month",   value: String(extraRunsThisMonth) },
              { label: "Long runs (last 6 wks)",  value: `${longDone}/${longPlanned}` },
              { label: "Sessions this month",     value: `${sessDone}/${sessPlanned}` },
              { label: "Avg rating (last 4 wks)", value: avgRating28 != null ? `${avgRating28}/10` : "—" },
            ].map(({ label, value }) => (
              <div key={label} className="flex items-center justify-between">
                <span className="text-xs" style={{ color: "var(--text-muted)" }}>
                  {label}
                </span>
                <span className="text-sm font-semibold text-white">{value}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ── Calendar grid (client) ───────────────────────────────────────── */}
      <CalendarGrid
        year={year}
        todayKey={todayKey}
        calendarData={calendarData}
        pbPaceSecKm={pbPaceSecKm}
        athleteAge={athleteAge}
      />
    </div>
  );
}
