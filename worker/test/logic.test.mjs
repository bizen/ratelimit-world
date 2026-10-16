import test from "node:test";
import assert from "node:assert/strict";
import { computeStats, dayKey, weekKey, possibleToday, nextMidnight, delayOf, xpOf, HOUR, MIN } from "../src/logic.js";

const TZ = "Asia/Tokyo";
// 東京の壁時計で時刻を作る
const jst = (s) => Date.parse(s + "+09:00");
const win = (tool, hit, reset, resumed) => ({ tool, hit_at: jst(hit), reset_at: jst(reset), resumed_at: resumed ? jst(resumed) : null });

test("day boundary is midnight in the user's timezone", () => {
  assert.equal(dayKey(jst("2026-10-16T23:59:00"), TZ), "2026-10-16");
  assert.equal(dayKey(jst("2026-10-17T00:00:00"), TZ), "2026-10-17");
  assert.equal(dayKey(jst("2026-10-17T00:30:00"), "UTC"), "2026-10-16");
  assert.equal(weekKey(jst("2026-10-18T12:00:00"), TZ), "2026-10-12"); // 日曜 → その週の月曜
  assert.equal(weekKey(jst("2026-10-19T00:10:00"), TZ), "2026-10-19");
});

test("possible windows left today", () => {
  assert.equal(nextMidnight(jst("2026-10-16T21:00:00"), TZ), jst("2026-10-17T00:00:00"));
  assert.equal(possibleToday(jst("2026-10-16T21:00:00"), TZ), 1);
  assert.equal(possibleToday(jst("2026-10-16T14:00:00"), TZ), 2);
  assert.equal(possibleToday(jst("2026-10-16T00:00:00"), TZ), 5);
});

test("delay and xp", () => {
  assert.equal(delayOf(win("claude", "2026-10-16T01:00:00", "2026-10-16T03:00:00", "2026-10-16T03:30:00")), 30 * MIN);
  assert.equal(delayOf(win("claude", "2026-10-16T01:00:00", "2026-10-16T03:00:00", "2026-10-16T09:00:00")), null); // 休憩扱い
  assert.equal(xpOf(win("claude", "2026-10-16T01:00:00", "2026-10-16T03:00:00", "2026-10-16T03:02:00")), 150);
  assert.equal(xpOf(win("claude", "2026-10-16T01:00:00", "2026-10-16T03:00:00", "2026-10-16T03:10:00")), 120);
  assert.equal(xpOf(win("claude", "2026-10-16T01:00:00", "2026-10-16T03:00:00", null)), 100);
});

function daysOf(n, from, perDay = 2) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(Date.parse(from + "T12:00:00Z") + i * 24 * HOUR).toISOString().slice(0, 10);
    for (let j = 0; j < perDay; j++) out.push(win(j % 2 ? "codex" : "claude", `${d}T${10 + j}:00:00`, `${d}T${14 + j}:00:00`, null));
  }
  return out;
}

test("streak continues while today is not yet done (Duolingo rule)", () => {
  const ws = daysOf(3, "2026-10-13"); // 13,14,15 達成
  const s = computeStats(ws, { tz: TZ, goal: 2, now: jst("2026-10-16T09:00:00") });
  assert.equal(s.streak, 3);
  assert.equal(s.todayDone, false);
  const s2 = computeStats([...ws, ...daysOf(1, "2026-10-16")], { tz: TZ, goal: 2, now: jst("2026-10-16T20:00:00") });
  assert.equal(s2.streak, 4);
  assert.equal(s2.todayDone, true);
});

test("a missed day breaks the streak without a freeze", () => {
  const ws = [...daysOf(3, "2026-10-10"), ...daysOf(2, "2026-10-14")]; // 13日が抜け
  const s = computeStats(ws, { tz: TZ, goal: 2, now: jst("2026-10-16T09:00:00") });
  assert.equal(s.streak, 2);
  assert.equal(s.bestStreak, 3);
  assert.equal(s.freezes, 0);
});

test("7-day run earns a freeze that saves a missed day", () => {
  const ws = [...daysOf(7, "2026-10-01"), ...daysOf(3, "2026-10-09")]; // 8日が抜け
  const s = computeStats(ws, { tz: TZ, goal: 2, now: jst("2026-10-12T09:00:00") });
  assert.deepEqual(s.frozenDays, ["2026-10-08"]);
  assert.equal(s.freezes, 0);
  assert.equal(s.streak, 10);
});

test("tool state, today's late minutes and quick-start run", () => {
  const now = jst("2026-10-16T15:00:00");
  const ws = [
    win("codex", "2026-10-16T01:00:00", "2026-10-16T03:00:00", "2026-10-16T03:02:00"),
    win("codex", "2026-10-16T06:00:00", "2026-10-16T08:00:00", "2026-10-16T08:01:00"),
    win("claude", "2026-10-16T09:00:00", "2026-10-16T11:00:00", "2026-10-16T11:30:00"),
    win("claude", "2026-10-16T14:00:00", "2026-10-16T16:20:00", null),
  ];
  const s = computeStats(ws, { tz: TZ, goal: 2, now });
  assert.equal(s.todayCount, 4);
  assert.equal(s.todayLateMin, 33);
  assert.equal(s.tools.claude.state, "limited");
  assert.equal(s.tools.claude.resetAt, jst("2026-10-16T16:20:00"));
  assert.equal(s.tools.codex, undefined);
  assert.equal(s.quickRun, 0); // 直近の claude は 30分出遅れ
  const s2 = computeStats(ws.slice(0, 2), { tz: TZ, goal: 2, now });
  assert.equal(s2.quickRun, 2);
});

test("combo XP grows with each window in the same day", async () => {
  const { msg } = await import("../src/logic.js");
  const now = jst("2026-10-16T22:00:00");
  const ws = [
    win("claude", "2026-10-16T02:00:00", "2026-10-16T05:00:00", "2026-10-16T05:01:00"),  // 100 + 50 (即スタート)
    win("claude", "2026-10-16T08:00:00", "2026-10-16T10:00:00", null),                    // 120
    win("codex", "2026-10-16T12:00:00", "2026-10-16T15:00:00", null),                     // 150
    win("codex", "2026-10-15T12:00:00", "2026-10-15T15:00:00", null),                     // 前日: 100
  ];
  const s = computeStats(ws, { tz: TZ, goal: 2, now });
  assert.deepEqual(s.todayWindows.map((w) => w.xp), [150, 120, 150]);
  assert.equal(s.todayXp, 420);
  assert.equal(s.tier, "目標超え");
  assert.equal(s.nextTier, "限界突破");
  assert.equal(s.nextXp, 200);
  assert.equal(s.bestDay, 1);
  assert.equal(s.todayIsRecord, true);
  const m = msg.hit("codex", s, ws[2]);
  assert.match(m.title, /3枠目「目標超え」 \+150 XP/);
  assert.match(m.body, /自己ベスト更新/);
  const goal = msg.hit("claude", computeStats(ws.slice(0, 2), { tz: TZ, goal: 2, now }), ws[1]);
  assert.match(goal.body, /目標達成/);
});

test("tiers are relative to the user's own goal", async () => {
  const { tierOf } = await import("../src/logic.js");
  assert.equal(tierOf(1, 3), "あと2枠");
  assert.equal(tierOf(1, 1), "目標達成");
  assert.equal(tierOf(2, 1), "目標超え");
  assert.equal(tierOf(3, 1), "限界突破");
  assert.equal(tierOf(5, 3), "限界突破");
});

test("weekly limit hit gives a big reward and protects the streak until reset", async () => {
  const { WEEKLY_XP } = await import("../src/logic.js");
  // 13, 14 日は達成。14日に週間リミット到達 (リセットは 17日) → 15, 16 日は未達でも途切れない
  const ws = daysOf(2, "2026-10-13");
  const weekly = [{ tool: "claude", hit_at: jst("2026-10-14T20:00:00"), reset_at: jst("2026-10-17T09:00:00") }];
  const s = computeStats(ws, { tz: TZ, goal: 2, now: jst("2026-10-17T10:00:00"), weekly });
  assert.equal(s.streak, 2);
  assert.deepEqual(s.lockedDays, ["2026-10-15", "2026-10-16"]);
  assert.equal(s.freezes, 0);
  assert.equal(s.trophies, 1);
  assert.equal(s.xp, 100 + 120 + 100 + 120 + WEEKLY_XP);
  assert.deepEqual(s.weeklyLocks, []);
  const s2 = computeStats(ws, { tz: TZ, goal: 2, now: jst("2026-10-16T10:00:00"), weekly });
  assert.equal(s2.weeklyLocks.length, 1);
});
