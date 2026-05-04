import prisma from "@/lib/db";
import { formatPace } from "@/lib/strava";
import { trainingPlan, buildTrainingPlan, type Phase, type RunType } from "@/data/trainingPlan";
import {
  PLAN_START_DATE,
  getPlanWeekForDate,
  getWeekStartForPlanWeek,
  getSessionDate,
  getWeeklyTargetKm,
  inferRunType,
  getNextPhaseInfo,
} from "@/lib/planUtils";
import { formatAEST, formatDistanceToNowAEST, sameDayAEST, startOfDayAEST } from "@/lib/dateUtils";
import { calculateRunRating, resolveRunType, resolveTargetPaceSecKm } from "@/lib/rating";
import { dbSettingsToUserSettings, DEFAULT_SETTINGS } from "@/lib/settings";
import WeeklyKmChart from "@/components/charts/WeeklyKmChart";
import AvgPaceTrendChart from "@/components/charts/AvgPaceTrendChart";
import TrainingLoadChart from "@/components/charts/TrainingLoadChart";
import SyncButton from "@/components/SyncButton";
import Logo from "@/components/Logo";

export const dynamic = "force-dynamic";

// ── Style helpers ─────────────────────────────────────────────────────────────

function ratingBadgeStyle(score: number): { background: string; color: string } {
  if (score >= 9)   return { background: "#2e1065", color: "#c4b5fd" };
  if (score >= 7.5) return { background: "#052e16", color: "#4ade80" };
  if (score >= 6)   return { background: "#0c1a2e", color: "#60a5fa" };
  if (score >= 4)   return { background: "#431407", color: "#fb923c" };
  return               { background: "#450a0a", color: "#f87171" };
}

function ratingStatColor(score: number): string {
  if (score >= 7.5) return "#4ade80";
  if (score >= 6)   return "#60a5fa";
  if (score >= 4)   return "#fb923c";
  return "#f87171";
}

function phaseStyle(phase: Phase): { background: string; color: string } {
  switch (phase) {
    case "Base":                return { background: "#1e3a5f", color: "#93c5fd" };
    case "Half Marathon Build": return { background: "#14532d", color: "#86efac" };
    case "Marathon Build":      return { background: "#3b0764", color: "#d8b4fe" };
    case "Recovery":            return { background: "#1a1133", color: "#a78bfa" };
  }
}

function runTypePillStyle(type: RunType): { background: string; color: string } {
  switch (type) {
    case "easy":     return { background: "#1e1b4b", color: "#a5b4fc" };
    case "tempo":    return { background: "#134e4a", color: "#5eead4" };
    case "interval": return { background: "#431407", color: "#fb923c" };
    case "long":     return { background: "#292524", color: "#d6d3d1" };
  }
}

function formatTargetPace(minPerKm: number): string {
  const mins = Math.floor(minPerKm);
  const secs = Math.round((minPerKm - mins) * 60);
  return `${mins}:${secs.toString().padStart(2, "0")} /km`;
}

// ── Card wrapper ─────────────────────────────────────────────────────────────

function Card({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={className}
      style={{
        background: "#181818",
        border: "1px solid rgba(255,255,255,0.08)",
        borderRadius: 12,
      }}
    >
      {children}
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p
      className="text-xs uppercase tracking-wider"
      style={{ color: "var(--text-muted)" }}
    >
      {children}
    </p>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default async function Dashboard({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const oauthError = params.error as string | undefined;
  const oauthDetail = params.detail as string | undefined;

  const today = new Date();

  // ── Plan week maths ───────────────────────────────────────────────────────
  const rawWeek = getPlanWeekForDate(today);
  const currentWeek = Math.max(1, Math.min(trainingPlan.length, rawWeek));
  const currentPlanWeek = trainingPlan[currentWeek - 1];
  const currentPhase = currentPlanWeek?.phase ?? "Base";

  const weekStart = getWeekStartForPlanWeek(currentWeek);
  const weekEnd = new Date(weekStart.getTime() + 7 * 24 * 60 * 60 * 1000);

  const chartStartWeek = Math.max(1, currentWeek - 3);

  // ── DB queries ────────────────────────────────────────────────────────────
  const chartRangeStart = getWeekStartForPlanWeek(chartStartWeek);

  const [
    profile,
    userSettingsRow,
    recentRuns,
    weekActivities,
    chartActivities,
    bestPaceRow,
    lastSyncRow,
  ] = await Promise.all([
    prisma.profile.findUnique({ where: { id: 1 } }),
    prisma.userSettings.findUnique({ where: { id: 1 } }),
    prisma.activity.findMany({
      where: { activityType: { in: ["running", "trail_running"] } },
      orderBy: { date: "desc" },
      take: 3,
    }),
    prisma.activity.findMany({
      where: {
        date: { gte: weekStart, lt: weekEnd },
        activityType: { in: ["running", "trail_running"] },
      },
    }),
    prisma.activity.findMany({
      where: {
        date: { gte: chartRangeStart },
        activityType: { in: ["running", "trail_running"] },
      },
      orderBy: { date: "asc" },
    }),
    prisma.activity.findFirst({
      where: { activityType: { in: ["running", "trail_running"] } },
      orderBy: { avgPaceSecKm: "asc" },
    }),
    prisma.activity.findFirst({ orderBy: { syncedAt: "desc" } }),
  ]);

  const settings   = userSettingsRow ? dbSettingsToUserSettings(userSettingsRow) : DEFAULT_SETTINGS;
  const ratingPlan = buildTrainingPlan(settings);
  const distTargets: Record<string, number> = {
    easy:     settings.distTargetEasyM     / 1000,
    tempo:    settings.distTargetTempoM    / 1000,
    interval: settings.distTargetIntervalM / 1000,
    long:     settings.distTargetLongM     / 1000,
  };

  const athleteAge = profile?.dateOfBirth
    ? Math.floor(
        (Date.now() - new Date(profile.dateOfBirth).getTime()) /
          (365.25 * 86400000)
      )
    : 23;
  const pbPaceSecKm = bestPaceRow?.avgPaceSecKm ?? null;

  // ── Stat tile data ────────────────────────────────────────────────────────
  const weekTargetKm = currentPlanWeek ? getWeeklyTargetKm(currentPlanWeek) : 0;
  const weekActualKm = weekActivities.reduce((s, a) => s + a.distanceKm, 0);
  const weekPlanned = currentPlanWeek?.sessions.length ?? 0;
  const weekDone = weekActivities.length;

  const weekRatings = weekActivities.map((a) => {
    const type = resolveRunType(a, ratingPlan, settings);
    return calculateRunRating({
      distanceKm: a.distanceKm,
      avgPaceSecKm: a.avgPaceSecKm,
      avgHeartRate: a.avgHeartRate,
      temperatureC: a.temperatureC,
      humidityPct: a.humidityPct,
      runType: type,
      personalBestPaceSecKm: pbPaceSecKm,
      athleteAgeYears: athleteAge,
      maxHROverride: settings.maxHR,
      distTargetKmOverride: distTargets[type],
      targetPaceSecKmOverride: resolveTargetPaceSecKm(a, ratingPlan),
      settings,
    }).total;
  });
  const avgWeekRating =
    weekRatings.length > 0
      ? Math.round(
          (weekRatings.reduce((a, b) => a + b, 0) / weekRatings.length) * 10
        ) / 10
      : null;

  // ── Chart data ────────────────────────────────────────────────────────────
  const chartWeekNums = Array.from({ length: 4 }, (_, i) => chartStartWeek + i);

  const weeklyKmData = chartWeekNums.map((wn) => {
    const planWeek = trainingPlan.find((w) => w.week === wn);
    const wStart = getWeekStartForPlanWeek(wn);
    const wEnd = new Date(wStart.getTime() + 7 * 24 * 60 * 60 * 1000);
    const actual = chartActivities
      .filter((a) => {
        const d = new Date(a.date);
        return d >= wStart && d < wEnd;
      })
      .reduce((s, a) => s + a.distanceKm, 0);
    return {
      week: `W${wn}`,
      actual: Math.round(actual * 10) / 10,
      target: planWeek ? getWeeklyTargetKm(planWeek) : 0,
    };
  });

  const paceData = chartWeekNums.map((wn) => {
    const planWeek = trainingPlan.find((w) => w.week === wn);
    const wStart = getWeekStartForPlanWeek(wn);
    const wEnd = new Date(wStart.getTime() + 7 * 24 * 60 * 60 * 1000);
    const easyRuns = chartActivities.filter((a) => {
      const d = new Date(a.date);
      return d >= wStart && d < wEnd && inferRunType(a, planWeek?.sessions) === "easy";
    });
    const avgPace =
      easyRuns.length > 0
        ? Math.round(
            easyRuns.reduce((s, a) => s + a.avgPaceSecKm, 0) / easyRuns.length
          )
        : null;
    return { week: `W${wn}`, paceSecKm: avgPace };
  });

  const loadData = chartWeekNums.map((wn) => {
    const planWeek = trainingPlan.find((w) => w.week === wn);
    const wStart = getWeekStartForPlanWeek(wn);
    const wEnd = new Date(wStart.getTime() + 7 * 24 * 60 * 60 * 1000);
    const groups = { easy: 0, tempo: 0, interval: 0, long: 0 };
    chartActivities
      .filter((a) => {
        const d = new Date(a.date);
        return d >= wStart && d < wEnd;
      })
      .forEach((a) => {
        const type = inferRunType(a, planWeek?.sessions);
        groups[type] = Math.round((groups[type] + a.distanceKm) * 10) / 10;
      });
    return { week: `W${wn}`, ...groups };
  });

  // ── Recent runs with ratings ──────────────────────────────────────────────
  const recentRunsRated = recentRuns.map((a) => {
    const type = resolveRunType(a, ratingPlan, settings);
    const rating = calculateRunRating({
      distanceKm: a.distanceKm,
      avgPaceSecKm: a.avgPaceSecKm,
      avgHeartRate: a.avgHeartRate,
      temperatureC: a.temperatureC,
      humidityPct: a.humidityPct,
      runType: type,
      personalBestPaceSecKm: pbPaceSecKm,
      athleteAgeYears: athleteAge,
      maxHROverride: settings.maxHR,
      distTargetKmOverride: distTargets[type],
      targetPaceSecKmOverride: resolveTargetPaceSecKm(a, ratingPlan),
      settings,
    });
    return { ...a, runType: type, rating };
  });

  // ── Upcoming sessions ─────────────────────────────────────────────────────
  const todayAESTMidnight = startOfDayAEST(today);
  const upcomingSessions = (currentPlanWeek?.sessions ?? [])
    .map((s) => ({
      ...s,
      date: getSessionDate(currentWeek, s.day),
    }))
    .filter((s) => {
      if (s.date < todayAESTMidnight) return false;
      return !weekActivities.some((a) => sameDayAEST(new Date(a.date), s.date));
    })
    .slice(0, 2);

  // ── Sidebar: session checklist ────────────────────────────────────────────
  const sessionChecklist = (currentPlanWeek?.sessions ?? []).map((s) => {
    const date = getSessionDate(currentWeek, s.day);
    const completed = weekActivities.some((a) => sameDayAEST(new Date(a.date), date));
    return { session: s, date, completed, future: date > todayAESTMidnight };
  });

  // ── Sidebar: phase progress ───────────────────────────────────────────────
  const phaseWeeks = trainingPlan.filter((w) => w.phase === currentPhase);
  const phaseStart = phaseWeeks[0]?.week ?? 1;
  const phaseEnd = phaseWeeks[phaseWeeks.length - 1]?.week ?? trainingPlan.length;
  const phaseProgress = Math.min(
    100,
    Math.round(
      ((currentWeek - phaseStart) / Math.max(1, phaseEnd - phaseStart + 1)) * 100
    )
  );
  const nextPhase = getNextPhaseInfo(currentPhase);

  // ── Sync timestamps (Strava) ──────────────────────────────────────────────
  const lastSyncedAt = lastSyncRow?.syncedAt?.toISOString() ?? null;
  const lastRunImportedLabel = lastSyncRow?.syncedAt
    ? formatDistanceToNowAEST(lastSyncRow.syncedAt, { addSuffix: true })
    : "never";
  const lastRefreshedLabel = profile?.lastRefreshedAt
    ? formatDistanceToNowAEST(profile.lastRefreshedAt, { addSuffix: true })
    : "Never refreshed";

  // ─────────────────────────────────────────────────────────────────────────
  return (
    <div className="flex gap-5 items-start">
      {/* ── Main column ──────────────────────────────────────────────────── */}
      <div className="flex-1 min-w-0 space-y-4">

        {/* OAuth error */}
        {oauthError && (
          <div
            className="rounded-xl px-4 py-3 text-sm"
            style={{ background: "#2d1515", border: "1px solid #7f1d1d" }}
          >
            <p className="font-semibold text-red-400">
              {oauthError === "strava_denied"
                ? "Strava authorisation denied"
                : "Strava connection failed"}
            </p>
            {oauthDetail && (
              <p className="mt-1 font-mono text-xs break-all" style={{ color: "#fca5a5" }}>
                {oauthDetail}
              </p>
            )}
          </div>
        )}

        {/* Logo icon + phase header */}
        <Logo size="md" showWordmark={false} />

        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="text-xl font-bold text-white">Kingston&apos;s Dashboard</span>
            <span
              className="text-xs font-semibold px-2.5 py-1 rounded-full"
              style={phaseStyle(currentPhase)}
            >
              Week {currentWeek} · {currentPhase}
            </span>
          </div>
          <p className="text-xs hidden sm:block" style={{ color: "var(--text-muted)" }}>
            {formatAEST(today, "EEEE, d MMMM yyyy")}
          </p>
        </div>
        <p className="text-xs -mt-2" style={{ color: "var(--text-muted)" }}>
          Kingston · Male · 19 · DOB 10/10/2006
        </p>

        {/* ── Stat tiles ─────────────────────────────────────────────────── */}
        <div className="grid grid-cols-3 gap-3">
          {/* Weekly distance */}
          <Card className="p-4">
            <SectionLabel>Weekly Distance</SectionLabel>
            <p className="text-2xl font-bold text-white mt-2">
              {weekActualKm.toFixed(1)}
              <span className="text-sm font-normal ml-1" style={{ color: "var(--text-muted)" }}>
                / {weekTargetKm.toFixed(0)} km
              </span>
            </p>
            <div
              className="mt-3 h-1 rounded-full overflow-hidden"
              style={{ background: "rgba(255,255,255,0.08)" }}
            >
              <div
                className="h-full rounded-full transition-all"
                style={{
                  width: `${Math.min(100, weekTargetKm > 0 ? (weekActualKm / weekTargetKm) * 100 : 0)}%`,
                  background: "var(--accent)",
                }}
              />
            </div>
          </Card>

          {/* Runs completed */}
          <Card className="p-4">
            <SectionLabel>Runs Completed</SectionLabel>
            <p className="text-2xl font-bold text-white mt-2">
              {weekDone}
              <span className="text-sm font-normal ml-1" style={{ color: "var(--text-muted)" }}>
                / {weekPlanned}
              </span>
            </p>
            <p className="text-xs mt-3" style={{ color: "var(--text-muted)" }}>
              this week
            </p>
          </Card>

          {/* Avg rating */}
          <Card className="p-4">
            <SectionLabel>Avg Run Rating</SectionLabel>
            {avgWeekRating !== null ? (
              <>
                <p
                  className="text-2xl font-bold mt-2"
                  style={{ color: ratingStatColor(avgWeekRating) }}
                >
                  {avgWeekRating.toFixed(1)}
                  <span className="text-sm font-normal ml-1 text-white">/ 10</span>
                </p>
                <p className="text-xs mt-3" style={{ color: "var(--text-muted)" }}>
                  from {weekRatings.length} {weekRatings.length === 1 ? "run" : "runs"}
                </p>
              </>
            ) : (
              <>
                <p className="text-2xl font-bold mt-2" style={{ color: "var(--text-muted)" }}>
                  —
                </p>
                <p className="text-xs mt-3" style={{ color: "var(--text-muted)" }}>
                  no runs this week
                </p>
              </>
            )}
          </Card>
        </div>

        {/* ── Weekly km chart ─────────────────────────────────────────────── */}
        <Card className="p-4">
          <SectionLabel>Weekly Distance (km)</SectionLabel>
          <div className="mt-4">
            <WeeklyKmChart data={weeklyKmData} />
          </div>
        </Card>

        {/* ── Pace + Load charts side by side ─────────────────────────────── */}
        <div className="grid grid-cols-2 gap-3">
          <Card className="p-4">
            <SectionLabel>Avg Easy Pace</SectionLabel>
            <p className="text-xs mt-0.5 mb-3" style={{ color: "rgba(156,163,175,0.6)" }}>
              easy runs only · lower = faster
            </p>
            <AvgPaceTrendChart data={paceData} />
          </Card>
          <Card className="p-4">
            <SectionLabel>Training Load</SectionLabel>
            <p className="text-xs mt-0.5 mb-3" style={{ color: "rgba(156,163,175,0.6)" }}>
              km by run type
            </p>
            <TrainingLoadChart data={loadData} />
          </Card>
        </div>

        {/* ── Recent runs ─────────────────────────────────────────────────── */}
        <Card>
          <div className="px-4 pt-4 pb-2">
            <SectionLabel>Recent Runs</SectionLabel>
          </div>

          {recentRunsRated.length === 0 && upcomingSessions.length === 0 ? (
            <div className="px-4 py-6 text-center">
              <p className="text-sm" style={{ color: "var(--text-muted)" }}>
                No activities synced yet. Connect Strava to see your runs here.
              </p>
            </div>
          ) : (
            <div>
              {/* Completed runs */}
              {recentRunsRated.map((run) => {
                const badge = ratingBadgeStyle(run.rating.total);
                const pill = runTypePillStyle(run.runType);
                return (
                  <div
                    key={run.id}
                    className="flex items-center gap-3 px-4 py-3"
                    style={{ borderTop: "1px solid rgba(255,255,255,0.06)" }}
                  >
                    {/* Rating badge */}
                    <div
                      className="w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0 text-sm font-bold"
                      style={badge}
                    >
                      {run.rating.total.toFixed(1)}
                    </div>

                    {/* Name + meta */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-white font-semibold text-sm truncate">
                          {run.name ?? `${run.distanceKm.toFixed(1)} km run`}
                        </span>
                        <span
                          className="text-xs px-2 py-0.5 rounded-full font-medium flex-shrink-0"
                          style={pill}
                        >
                          {run.runType}
                        </span>
                      </div>
                      <p className="text-xs mt-0.5" style={{ color: "var(--text-muted)" }}>
                        {formatAEST(run.date, "EEE d MMM")}
                      </p>
                    </div>

                    {/* Stats */}
                    <div className="flex gap-4 text-xs text-right flex-shrink-0">
                      <div>
                        <p className="text-white font-medium">{run.distanceKm.toFixed(2)} km</p>
                        <p style={{ color: "var(--text-muted)" }}>dist</p>
                      </div>
                      <div>
                        <p className="text-white font-medium">{formatPace(run.avgPaceSecKm)}</p>
                        <p style={{ color: "var(--text-muted)" }}>pace</p>
                      </div>
                      {run.avgHeartRate && (
                        <div>
                          <p className="text-white font-medium">{run.avgHeartRate}</p>
                          <p style={{ color: "var(--text-muted)" }}>bpm</p>
                        </div>
                      )}
                      {run.temperatureC != null && (
                        <div>
                          <p className="text-white font-medium">{run.temperatureC}°C</p>
                          <p style={{ color: "var(--text-muted)" }}>temp</p>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}

              {/* Upcoming planned sessions */}
              {upcomingSessions.map((s) => {
                const pill = runTypePillStyle(s.type);
                return (
                  <div
                    key={`upcoming-${s.day}`}
                    className="flex items-center gap-3 px-4 py-3"
                    style={{
                      borderTop: "1px solid rgba(255,255,255,0.06)",
                      opacity: 0.5,
                    }}
                  >
                    {/* Dash badge */}
                    <div
                      className="w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0 text-sm font-bold"
                      style={{
                        background: "rgba(255,255,255,0.05)",
                        color: "var(--text-muted)",
                      }}
                    >
                      —
                    </div>

                    {/* Session info */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-white font-semibold text-sm">
                          {s.targetDistanceKm} km {s.type}
                        </span>
                        <span
                          className="text-xs px-2 py-0.5 rounded-full font-medium flex-shrink-0"
                          style={pill}
                        >
                          {s.type}
                        </span>
                      </div>
                      <p className="text-xs mt-0.5" style={{ color: "var(--text-muted)" }}>
                        {formatAEST(s.date, "EEE d MMM")} · planned
                      </p>
                    </div>

                    {/* Target stats */}
                    <div className="flex gap-4 text-xs text-right flex-shrink-0">
                      <div>
                        <p className="text-white font-medium">{s.targetDistanceKm} km</p>
                        <p style={{ color: "var(--text-muted)" }}>target</p>
                      </div>
                      <div>
                        <p className="text-white font-medium">
                          {formatTargetPace(s.targetPaceMinPerKm)}
                        </p>
                        <p style={{ color: "var(--text-muted)" }}>target pace</p>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </Card>

        {/* ── Strava sync indicator ────────────────────────────────────────── */}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:flex-wrap px-1 pb-2">
          <div
            className="flex flex-col gap-0.5 text-xs sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-1"
            style={{ color: "var(--text-muted)" }}
          >
            <span>Synced via Strava</span>
            <span className="hidden sm:inline" aria-hidden>
              ·
            </span>
            <span>Last run imported {lastRunImportedLabel}</span>
            <span className="hidden sm:inline" aria-hidden>
              ·
            </span>
            <span>Last refreshed {lastRefreshedLabel}</span>
          </div>
          <SyncButton
            lastSynced={lastSyncedAt}
            stravaConnected={profile?.stravaConnected ?? false}
          />
        </div>

      </div>

      {/* ── Sidebar ──────────────────────────────────────────────────────── */}
      <aside className="w-[220px] shrink-0 space-y-3 hidden lg:block">

        {/* This week panel */}
        <Card className="p-4">
          <SectionLabel>This Week</SectionLabel>
          <p className="text-sm font-semibold text-white mt-2 mb-1">
            Week {currentWeek} · {currentPhase}
          </p>

          {/* Progress bar */}
          <div className="flex justify-between text-xs mb-1">
            <span style={{ color: "var(--text-muted)" }}>{weekActualKm.toFixed(1)} km</span>
            <span style={{ color: "var(--text-muted)" }}>{weekTargetKm} km</span>
          </div>
          <div
            className="h-1.5 rounded-full overflow-hidden mb-4"
            style={{ background: "rgba(255,255,255,0.08)" }}
          >
            <div
              className="h-full rounded-full"
              style={{
                width: `${Math.min(100, weekTargetKm > 0 ? (weekActualKm / weekTargetKm) * 100 : 0)}%`,
                background: "var(--accent)",
              }}
            />
          </div>

          {/* Session checklist */}
          <div className="space-y-2.5">
            {sessionChecklist.map(({ session, date, completed, future }) => (
              <div key={session.day} className="flex items-start gap-2.5">
                <div
                  className="w-4 h-4 rounded mt-0.5 flex items-center justify-center text-xs flex-shrink-0"
                  style={{
                    background: completed
                      ? "var(--accent)"
                      : "rgba(255,255,255,0.08)",
                    color: completed ? "#fff" : "transparent",
                  }}
                >
                  {completed ? "✓" : ""}
                </div>
                <div className="flex-1 min-w-0">
                  <p
                    className="text-xs font-medium leading-tight"
                    style={{ color: completed ? "var(--text-muted)" : "white" }}
                  >
                    {formatAEST(date, "EEE")} · {session.type}{" "}
                    {session.targetDistanceKm} km
                  </p>
                  {future && !completed && (
                    <p
                      className="text-xs leading-tight"
                      style={{ color: "rgba(156,163,175,0.5)" }}
                    >
                      {formatAEST(date, "d MMM")}
                    </p>
                  )}
                </div>
              </div>
            ))}
            {sessionChecklist.length === 0 && (
              <p className="text-xs" style={{ color: "var(--text-muted)" }}>
                No sessions this week
              </p>
            )}
          </div>
        </Card>

        {/* Phase progress */}
        <Card className="p-4">
          <SectionLabel>Phase Progress</SectionLabel>
          <p className="text-sm font-semibold text-white mt-2">{currentPhase}</p>
          <p className="text-xs mt-0.5 mb-2" style={{ color: "var(--text-muted)" }}>
            Week {currentWeek - phaseStart + 1} of {phaseEnd - phaseStart + 1}
          </p>
          <div
            className="h-1.5 rounded-full overflow-hidden mb-3"
            style={{ background: "rgba(255,255,255,0.08)" }}
          >
            <div
              className="h-full rounded-full"
              style={{
                width: `${phaseProgress}%`,
                background: phaseStyle(currentPhase).color,
              }}
            />
          </div>
          {nextPhase ? (
            <p className="text-xs" style={{ color: "var(--text-muted)" }}>
              {nextPhase.label} starts Week {nextPhase.week}
            </p>
          ) : (
            <p className="text-xs" style={{ color: "var(--text-muted)" }}>
              Race week is here 🏁
            </p>
          )}
        </Card>

        {/* Plan start reference */}
        <p className="text-xs px-1" style={{ color: "rgba(156,163,175,0.4)" }}>
          Plan started {formatAEST(PLAN_START_DATE, "d MMM yyyy")}
        </p>

      </aside>
    </div>
  );
}
