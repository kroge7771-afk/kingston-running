import prisma from "@/lib/db";
import { formatPace as fmtPaceSec } from "@/lib/settings";
import { buildTrainingPlan, type Phase, type RunType, type TrainingWeek } from "@/data/trainingPlan";
import {
  PLAN_START_DATE,
  getPlanWeekForDate,
  getSessionDate,
  getWeeklyTargetKm,
} from "@/lib/planUtils";
import { calculateRunRating } from "@/lib/rating";
import { sameDayAEST, startOfDayAEST } from "@/lib/dateUtils";
import { dbSettingsToUserSettings, DEFAULT_SETTINGS } from "@/lib/settings";
import { reconfigurePlan, type PlanInterruption, type InterruptionType } from "@/lib/interruptions";
import PhaseOverview from "./PhaseOverview";
import ProgramSidePanel from "./ProgramSidePanel";
import PlanAdjustments from "./PlanAdjustments";
import RaceFlagBanner from "./RaceFlagBanner";
import Logo from "@/components/Logo";

export const dynamic = "force-dynamic";

// ── Static lookup tables ──────────────────────────────────────────────────────

const EFFORT_LABEL: Record<RunType, string> = {
  easy:     "Zone 2 effort",
  long:     "Zone 2 effort",
  tempo:    "Zone 4 effort",
  interval: "Zone 5 effort",
};

const WARMUP_COOLDOWN: Record<RunType, string> = {
  easy:     "5 min walk each end",
  long:     "5 min jog + 10 min walk/stretch",
  tempo:    "1.5 km easy warm-up · 1 km cool-down",
  interval: "1.5 km easy warm-up · 90 sec rest between reps · 1 km cool-down",
};

const WEEK_FOCUS: Record<number, string> = {
  1:  "Introduction to structured training",
  2:  "Building your aerobic base",
  3:  "First taste of speed work",
  4:  "Cutback — let your body adapt",
  5:  "Returning stronger with more speed",
  6:  "Completing the base phase",
  7:  "Entering half marathon build",
  8:  "Cutback — consolidating gains",
  9:  "Pushing long run to race distance",
  10: "Building lactate threshold",
  11: "Peak interval and long run week",
  12: "Cutback — absorbing the hardest block",
  13: "Final hard long run push",
  14: "Peak half marathon build week",
  15: "Entering the peak phase",
  16: "Cutback — final big recovery",
  17: "Last hard training week",
  18: "Taper — trust your training",
};

const PHASE_OVERVIEW: Record<Phase, string> = {
  "Base":
    "The base phase builds your aerobic engine. Every run is at Zone 2 or below except Wednesday intervals, which introduce speed work gradually. By the end of week 6 you should be able to run 16 km comfortably at an easy pace. Do not rush this phase — aerobic base takes weeks to build and cannot be shortcut.",
  "Half Marathon Build":
    "This phase shifts focus to half marathon-specific fitness. Long runs push toward 21 km, tempo runs get longer, and intervals increase in volume and intensity. Your body is under significant load in weeks 9–11 and 13–14 — sleep and nutrition matter more than ever here. The cutback weeks in weeks 8 and 12 are essential.",
  "Marathon Build":
    "The peak phase maintains the fitness you've built and prepares you to race. Week 18 is a taper — volume drops sharply but intensity stays. This is normal and intentional. Resist the urge to add extra runs during taper week. Trust the plan.",
  "Recovery":
    "These weeks are designed to safely return you to training after a break. Volume is deliberately low and every session is at easy effort. Do not rush or substitute harder runs — connective tissue heals slower than cardiovascular fitness, and starting too hard here leads to re-injury.",
};

// ── HR zone bounds per run type ───────────────────────────────────────────────

const HR_ZONE_BOUNDS: Record<RunType, [number, number]> = {
  easy:     [0.60, 0.75],
  long:     [0.62, 0.78],
  tempo:    [0.78, 0.88],
  interval: [0.88, 0.96],
};

function getZoneBadge(
  avgHR: number | null | undefined,
  runType: RunType,
  maxHR: number
): { label: string; color: string } | null {
  if (!avgHR) return null;
  const [lo, hi] = HR_ZONE_BOUNDS[runType];
  const frac = avgHR / maxHR;
  if (frac >= lo && frac <= hi) return { label: "✓ Zone", color: "#5DCAA5" };
  if (frac > hi)                return { label: "↑ Zone", color: "#EF9F27" };
  return                               { label: "↓ Zone", color: "#85B7EB" };
}

// ── Volume change vs previous week in the plan ───────────────────────────────

function getVolumeChange(planWeek: TrainingWeek, plan: TrainingWeek[]): number | null {
  const idx = plan.indexOf(planWeek);
  if (idx <= 0) return null;
  const prev = plan[idx - 1];
  const prevKm = getWeeklyTargetKm(prev);
  const currKm = getWeeklyTargetKm(planWeek);
  if (prevKm === 0) return null;
  return Math.round(((currKm - prevKm) / prevKm) * 100);
}

// ── Style helpers ─────────────────────────────────────────────────────────────

function fmtTargetPace(minPerKm: number): string {
  const m = Math.floor(minPerKm);
  const s = Math.round((minPerKm - m) * 60);
  return `${m}:${s.toString().padStart(2, "0")} /km`;
}

function ratingBadgeStyle(score: number): { background: string; color: string } {
  if (score >= 9)   return { background: "#2e1065", color: "#c4b5fd" };
  if (score >= 7.5) return { background: "#052e16", color: "#4ade80" };
  if (score >= 6)   return { background: "#0c1a2e", color: "#60a5fa" };
  if (score >= 4)   return { background: "#431407", color: "#fb923c" };
  return               { background: "#450a0a", color: "#f87171" };
}

function typePillStyle(type: RunType): { background: string; color: string } {
  switch (type) {
    case "easy":     return { background: "#1e1b4b", color: "#a5b4fc" };
    case "tempo":    return { background: "#134e4a", color: "#5eead4" };
    case "interval": return { background: "#431407", color: "#fb923c" };
    case "long":     return { background: "#292524", color: "#d6d3d1" };
  }
}

function phaseChipStyle(phase: Phase): { background: string; color: string } {
  switch (phase) {
    case "Base":                return { background: "#1e3a5f", color: "#93c5fd" };
    case "Half Marathon Build": return { background: "#14532d", color: "#86efac" };
    case "Marathon Build":      return { background: "#3b0764", color: "#d8b4fe" };
    case "Recovery":            return { background: "#1a1133", color: "#a78bfa" };
  }
}

// ── Plan section grouping ─────────────────────────────────────────────────────

interface PlanSection {
  phase: Phase;
  weeks: TrainingWeek[];
  isRecovery: boolean;
  sectionIdx: number;
}

function groupIntoSections(plan: TrainingWeek[]): PlanSection[] {
  return plan.reduce<PlanSection[]>((acc, week) => {
    if (!acc.length || acc[acc.length - 1].phase !== week.phase) {
      acc.push({ phase: week.phase, weeks: [week], isRecovery: week.isRecovery ?? false, sectionIdx: acc.length });
    } else {
      acc[acc.length - 1].weeks.push(week);
    }
    return acc;
  }, []);
}

// ── Date formatter ────────────────────────────────────────────────────────────

function fmtWeekStartDate(weekNumber: number): string {
  const d = new Date(PLAN_START_DATE.getTime() + (weekNumber - 1) * 7 * 24 * 60 * 60 * 1000);
  // shift to AEST (+10h) to get local date
  const aest = new Date(d.getTime() + 10 * 60 * 60 * 1000);
  return aest.toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default async function ProgramPage() {
  const today        = new Date();
  const todayMidnight = startOfDayAEST(today);
  const rawWeek      = getPlanWeekForDate(today);

  const [profile, userSettingsRow, activities, bestPaceRow, interruptionRows] = await Promise.all([
    prisma.profile.findUnique({ where: { id: 1 } }),
    prisma.userSettings.findUnique({ where: { id: 1 } }),
    prisma.activity.findMany({
      where: { activityType: { in: ["running", "trail_running"] } },
    }),
    prisma.activity.findFirst({
      where:   { activityType: { in: ["running", "trail_running"] } },
      orderBy: { avgPaceSecKm: "asc" },
    }),
    prisma.planInterruption.findMany({ orderBy: { startDate: "asc" } }),
  ]);

  const settings   = userSettingsRow ? dbSettingsToUserSettings(userSettingsRow) : DEFAULT_SETTINGS;
  const distTargets: Record<string, number> = {
    easy:     settings.distTargetEasyM     / 1000,
    tempo:    settings.distTargetTempoM    / 1000,
    interval: settings.distTargetIntervalM / 1000,
    long:     settings.distTargetLongM     / 1000,
  };
  const athleteAge = profile?.dateOfBirth
    ? Math.floor((Date.now() - new Date(profile.dateOfBirth).getTime()) / (365.25 * 86400000))
    : 23;
  const pbPaceSecKm = bestPaceRow?.avgPaceSecKm ?? null;
  const maxHR       = settings.maxHR;

  // Build VDOT-adjusted base plan
  const basePlan = buildTrainingPlan(settings);

  // Compute normal weekly km from base plan
  const normalWeeklyKm =
    basePlan.reduce((sum, w) => sum + getWeeklyTargetKm(w), 0) / basePlan.length;

  // Map DB rows to PlanInterruption
  const interruptions: PlanInterruption[] = interruptionRows.map(row => ({
    id:               row.id,
    reason:           row.reason,
    type:             row.type as InterruptionType,
    startDate:        new Date(row.startDate),
    endDate:          row.endDate ? new Date(row.endDate) : null,
    weeklyKmEstimate: row.weeklyKmEstimate ?? null,
    notes:            row.notes ?? null,
    weeksAffected:    row.weeksAffected ?? null,
  }));

  const { plan: planToRender, totalWeeksAdded, adjustmentSummary, extendsPastRace } =
    reconfigurePlan(basePlan, interruptions, {
      isBeginnerCurve: true,
      raceDate: settings.raceDate ? new Date(settings.raceDate) : null,
      normalWeeklyKm,
    });

  const currentWeek = rawWeek > 0 ? Math.min(planToRender[planToRender.length - 1]?.week ?? 18, rawWeek) : 1;
  const currentPlanEntry = planToRender.find(w => w.week === currentWeek) ?? planToRender[0];

  const sections = groupIntoSections(planToRender);

  // Race date warning info
  const lastPlanWeek = planToRender[planToRender.length - 1];
  const planEndDateStr = lastPlanWeek ? fmtWeekStartDate(lastPlanWeek.week + 1) : "";
  const raceDateStr = settings.raceDate ? settings.raceDate.slice(0, 10) : "";
  const weeksOver = extendsPastRace && settings.raceDate && lastPlanWeek
    ? Math.ceil(
        (PLAN_START_DATE.getTime() + lastPlanWeek.week * 7 * 24 * 60 * 60 * 1000 -
          new Date(settings.raceDate).getTime()) /
          (7 * 24 * 60 * 60 * 1000)
      )
    : 0;

  return (
    <div className="flex items-start gap-0">

      {/* ── Main content ─────────────────────────────────────────────── */}
      <div className="flex-1 min-w-0 space-y-8 pr-6">

        {/* Page header */}
        <div className="flex items-center gap-3 flex-wrap">
          <Logo size="sm" showWordmark={false} />
          <h1 className="text-xl font-bold text-white">Kingston&apos;s Training Program</h1>
          <span
            className="text-xs font-semibold px-2.5 py-1 rounded-full"
            style={phaseChipStyle(currentPlanEntry?.phase ?? "Base")}
          >
            {currentPlanEntry?.phase ?? "Base"}
          </span>
          <span className="text-sm" style={{ color: "var(--text-muted)" }}>
            Week {currentWeek} of {planToRender.length}
          </span>
        </div>

        {/* Race flag banner (only when plan extends past race date) */}
        {extendsPastRace && settings.raceDate && (
          <RaceFlagBanner
            planEndDate={planEndDateStr}
            raceDate={raceDateStr}
            weeksOver={weeksOver}
          />
        )}

        {/* Plan adjustments panel */}
        {adjustmentSummary.length > 0 && (
          <PlanAdjustments
            adjustmentSummary={adjustmentSummary}
            totalWeeksAdded={totalWeeksAdded}
            newPlanEndDate={planEndDateStr}
          />
        )}

        {/* Plan sections */}
        {sections.map((section) => {
          const phaseStart  = section.weeks[0].week;
          const phaseEnd    = section.weeks[section.weeks.length - 1].week;
          const phaseTotal  = section.weeks.length;
          const avgKm       =
            Math.round(
              (section.weeks.reduce((s, w) => s + getWeeklyTargetKm(w), 0) / phaseTotal) * 10
            ) / 10;
          const chip        = phaseChipStyle(section.phase);
          const progressPct = Math.max(
            0,
            Math.min(100, Math.round(((currentWeek - phaseStart) / phaseTotal) * 100))
          );

          return (
            <section key={`${section.phase}-${section.sectionIdx}`} className="space-y-1.5">

              {/* Phase header */}
              {section.isRecovery ? (
                // Simplified recovery header
                <div
                  className="rounded-xl px-4 py-3"
                  style={{
                    background: "#181818",
                    border: "1px solid rgba(167,139,250,0.15)",
                  }}
                >
                  <div className="flex items-center gap-3 flex-wrap">
                    <span className="text-xs font-semibold px-2.5 py-1 rounded-full" style={chip}>
                      Return to Training
                    </span>
                    <span className="text-xs font-medium text-white">
                      Week{phaseTotal > 1 ? "s" : ""} {phaseStart}{phaseTotal > 1 ? `–${phaseEnd}` : ""}
                    </span>
                    <span className="text-xs" style={{ color: "var(--text-muted)" }}>
                      ~{avgKm} km/week · easy effort only
                    </span>
                  </div>
                </div>
              ) : (
                // Full phase header
                <div
                  className="rounded-xl px-4 py-3"
                  style={{ background: "#181818", border: "1px solid rgba(255,255,255,0.08)" }}
                >
                  <div className="flex items-center justify-between gap-4 mb-2 flex-wrap">
                    <div className="flex items-center gap-3 flex-wrap">
                      <span className="text-xs font-semibold px-2.5 py-1 rounded-full" style={chip}>
                        {section.phase}
                      </span>
                      <span className="text-xs font-medium text-white">
                        Weeks {phaseStart}–{phaseEnd}
                      </span>
                      <span className="text-xs" style={{ color: "var(--text-muted)" }}>
                        ~{avgKm} km/week avg
                      </span>
                    </div>
                    <span className="text-xs" style={{ color: "var(--text-muted)" }}>
                      {progressPct}% complete
                    </span>
                  </div>
                  <div className="h-1 rounded-full overflow-hidden" style={{ background: "rgba(255,255,255,0.08)" }}>
                    <div className="h-full rounded-full" style={{ width: `${progressPct}%`, background: chip.color }} />
                  </div>
                </div>
              )}

              {/* Phase overview card — only for non-recovery sections */}
              {!section.isRecovery && (
                <PhaseOverview description={PHASE_OVERVIEW[section.phase]} />
              )}

              {/* Week rows */}
              {section.weeks.map((planWeek) => {
                const isCurrentWeek = planWeek.week === currentWeek;
                const weekTotalKm   = getWeeklyTargetKm(planWeek);
                const volumeChange  = getVolumeChange(planWeek, planToRender);
                const focusLabel    = WEEK_FOCUS[planWeek.originalWeek ?? planWeek.week];

                return (
                  <div
                    key={planWeek.week}
                    className="rounded-xl px-3 py-2.5"
                    style={{
                      background:  isCurrentWeek ? "#1f1f1f" : "#181818",
                      border:      "1px solid rgba(255,255,255,0.08)",
                      borderLeft:  planWeek.isRecovery
                        ? "2px solid rgba(167,139,250,0.4)"
                        : undefined,
                    }}
                  >
                    {/* Weekly focus label */}
                    {focusLabel && (
                      <p
                        className="text-[11px] mb-1.5 pl-[87px]"
                        style={{ color: "rgba(232,230,224,0.3)" }}
                      >
                        {focusLabel}
                      </p>
                    )}

                    <div className="flex items-start gap-3">
                      {/* Week label */}
                      <div className="w-[84px] shrink-0 pt-1">
                        <p className="text-xs font-bold text-white leading-tight">
                          Week {planWeek.week}
                          {planWeek.isCutback && (
                            <span style={{ color: "#fbbf24" }}> · Cutback</span>
                          )}
                          {planWeek.isRecovery && (
                            <span style={{ color: "#a78bfa" }}> · Return</span>
                          )}
                        </p>
                        {isCurrentWeek && (
                          <p className="text-[11px] mt-0.5 leading-tight" style={{ color: "#a5b4fc" }}>
                            Current
                          </p>
                        )}
                      </div>

                      {/* Session cards */}
                      <div className="flex-1 grid grid-cols-3 gap-2 min-w-0">
                        {planWeek.sessions.map((session) => {
                          const sessionDate = getSessionDate(planWeek.week, session.day);
                          const isPast      = sessionDate < todayMidnight;
                          const isToday     = sameDayAEST(sessionDate, today);
                          const matchedAct  = activities.find((a) =>
                            sameDayAEST(new Date(a.date), sessionDate)
                          );
                          const isCompleted = !!matchedAct;
                          const showRating  = isCompleted && (isPast || isCurrentWeek);

                          let rating = null;
                          if (showRating && matchedAct) {
                            rating = calculateRunRating({
                              distanceKm:              matchedAct.distanceKm,
                              avgPaceSecKm:             matchedAct.avgPaceSecKm,
                              avgHeartRate:             matchedAct.avgHeartRate,
                              temperatureC:             matchedAct.temperatureC,
                              humidityPct:              matchedAct.humidityPct,
                              runType:                  session.type,
                              personalBestPaceSecKm:    pbPaceSecKm,
                              athleteAgeYears:          athleteAge,
                              maxHROverride:            maxHR,
                              distTargetKmOverride:     distTargets[session.type],
                              targetPaceSecKmOverride:  Math.round(session.targetPaceMinPerKm * 60),
                              settings,
                            });
                          }

                          const zoneBadge = showRating && matchedAct
                            ? getZoneBadge(matchedAct.avgHeartRate, session.type, maxHR)
                            : null;

                          let leftBorder: string;
                          if (planWeek.isCutback) {
                            leftBorder = "2px solid #854F0B";
                          } else if (showRating) {
                            leftBorder = "2px solid #1D9E75";
                          } else if (isCurrentWeek && !isCompleted) {
                            leftBorder = "2px solid #534AB7";
                          } else {
                            leftBorder = "1px solid rgba(255,255,255,0.06)";
                          }

                          const pill     = typePillStyle(session.type);
                          const dayLabel = { wed: "Wed", sat: "Sat", sun: "Sun" }[session.day];

                          return (
                            <div
                              key={session.day}
                              className="rounded-lg p-3"
                              style={{
                                background:   "#111111",
                                borderTop:    "1px solid rgba(255,255,255,0.06)",
                                borderRight:  "1px solid rgba(255,255,255,0.06)",
                                borderBottom: "1px solid rgba(255,255,255,0.06)",
                                borderLeft:   leftBorder,
                              }}
                            >
                              {/* Day + rating + zone badges */}
                              <div className="flex items-start justify-between gap-1 mb-2">
                                <span
                                  className="text-[10px] font-semibold uppercase tracking-wider"
                                  style={{ color: "var(--text-muted)" }}
                                >
                                  {dayLabel}
                                </span>
                                <div className="flex flex-col items-end gap-0.5 shrink-0">
                                  {rating && (
                                    <span
                                      className="text-[11px] font-bold px-1.5 py-0.5 rounded"
                                      style={ratingBadgeStyle(rating.total)}
                                    >
                                      {rating.total.toFixed(1)}
                                    </span>
                                  )}
                                  {zoneBadge && (
                                    <span
                                      className="text-[10px] font-medium px-1.5 py-0.5 rounded"
                                      style={{
                                        color:      zoneBadge.color,
                                        background: `${zoneBadge.color}22`,
                                      }}
                                    >
                                      {zoneBadge.label}
                                    </span>
                                  )}
                                </div>
                              </div>

                              {/* Run type pill */}
                              <span
                                className="inline-block text-[11px] px-2 py-0.5 rounded-full font-medium"
                                style={pill}
                              >
                                {session.type.charAt(0).toUpperCase() + session.type.slice(1)}
                              </span>

                              {/* Effort label */}
                              <p
                                className="text-[11px] mt-0.5 mb-2"
                                style={{ color: "rgba(232,230,224,0.35)" }}
                              >
                                {EFFORT_LABEL[session.type]}
                              </p>

                              {/* Description */}
                              <p className="text-xs font-medium text-white mb-1 leading-snug">
                                {session.description}
                              </p>

                              {/* Warm-up / cool-down */}
                              <p
                                className="text-[11px] mb-1.5 leading-snug"
                                style={{ color: "rgba(232,230,224,0.25)" }}
                              >
                                {WARMUP_COOLDOWN[session.type]}
                              </p>

                              {/* Target */}
                              <p className="text-xs" style={{ color: "var(--text-muted)" }}>
                                {session.targetDistanceKm} km · {fmtTargetPace(session.targetPaceMinPerKm)}
                              </p>

                              {/* Actual (completed) */}
                              {showRating && matchedAct && (
                                <p
                                  className="text-xs mt-0.5"
                                  style={{ color: "rgba(232,230,224,0.4)" }}
                                >
                                  {matchedAct.distanceKm.toFixed(2)} km · {fmtPaceSec(matchedAct.avgPaceSecKm)}
                                </p>
                              )}

                              {/* Today label */}
                              {isToday && (
                                <p
                                  className="text-[11px] font-semibold mt-1.5"
                                  style={{ color: "#a5b4fc" }}
                                >
                                  Today
                                </p>
                              )}
                            </div>
                          );
                        })}
                      </div>

                      {/* Total km + volume change */}
                      <div className="w-16 shrink-0 text-right pt-1">
                        <p className="text-sm font-bold text-white">{weekTotalKm}</p>
                        <p className="text-[11px]" style={{ color: "var(--text-muted)" }}>km</p>
                        {volumeChange !== null && (
                          <span
                            className="text-[10px] font-medium mt-1 inline-block px-1.5 py-0.5 rounded-sm"
                            style={{
                              background: volumeChange > 0
                                ? "rgba(93,202,165,0.12)"
                                : "rgba(239,159,39,0.12)",
                              color: volumeChange > 0 ? "#5DCAA5" : "#EF9F27",
                            }}
                          >
                            {volumeChange > 0 ? `↑${volumeChange}%` : `↓${Math.abs(volumeChange)}%`}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </section>
          );
        })}
      </div>

      {/* ── Side panel ───────────────────────────────────────────────── */}
      <ProgramSidePanel maxHR={maxHR} />
    </div>
  );
}
