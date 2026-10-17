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

test("days until the next freeze", () => {
  const s3 = computeStats(daysOf(3, "2026-10-13"), { tz: TZ, goal: 2, now: jst("2026-10-16T09:00:00") });
  assert.equal(s3.freezeIn, 4); // 3日続いた → あと4日
  const s3done = computeStats([...daysOf(3, "2026-10-13"), ...daysOf(1, "2026-10-16")], { tz: TZ, goal: 2, now: jst("2026-10-16T20:00:00") });
  assert.equal(s3done.freezeIn, 3); // 今日も達成 → あと3日
  const full = computeStats(daysOf(15, "2026-10-01"), { tz: TZ, goal: 2, now: jst("2026-10-16T09:00:00") });
  assert.equal(full.freezes, 2);
  assert.equal(full.freezeIn, null); // 最大まで持っている
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
  const { notice } = await import("../src/notice.js");
  const now = jst("2026-10-16T22:00:00");
  const ws = [
    win("claude", "2026-10-16T02:00:00", "2026-10-16T05:00:00", "2026-10-16T05:01:00"),  // 100 + 50 (即スタート)
    win("claude", "2026-10-16T08:00:00", "2026-10-16T10:00:00", null),                    // 120
    win("codex", "2026-10-16T12:00:00", "2026-10-16T15:00:00", null),                     // 150
    win("codex", "2026-10-15T12:00:00", "2026-10-15T15:00:00", null),                     // 前日: 100
  ];
  const s = computeStats(ws, { tz: TZ, goal: 2, now });
  assert.deepEqual(s.todayWindows.map((w) => w.xp), [150, 120, 150]);
  assert.equal(s.todayXp - s.todayQuestXp, 420);
  assert.deepEqual(s.tier, { key: "over" });
  assert.deepEqual(s.nextTier, { key: "beyond" });
  assert.equal(s.nextXp, 200);
  assert.equal(s.bestDay, 1);
  assert.equal(s.todayIsRecord, true);
  const m = notice({ lang: "ja" }, "hit", s, now, { tool: "codex", w: ws[2] });
  assert.match(m.title, /3枠目「目標超え」 \+150 XP/);
  assert.match(m.body, /自己ベスト更新/);
  const en = notice({ lang: "en" }, "hit", s, now, { tool: "codex", w: ws[2] });
  assert.match(en.title, /Window 3 today · Over goal \+150 XP/);
  assert.match(en.body, /New daily best/);
  const goal = notice({ lang: "ja" }, "hit", computeStats(ws.slice(0, 2), { tz: TZ, goal: 2, now }), now, { tool: "claude", w: ws[1] });
  assert.match(goal.body, /目標達成/);
});

test("tiers are relative to the user's own goal", async () => {
  const { tierOf } = await import("../src/logic.js");
  const { tierName } = await import("../src/i18n.js");
  assert.equal(tierName("ja", tierOf(1, 3)), "あと2枠");
  assert.equal(tierName("ja", tierOf(1, 1)), "目標達成");
  assert.equal(tierName("ja", tierOf(2, 1)), "目標超え");
  assert.equal(tierName("ja", tierOf(3, 1)), "限界突破");
  assert.equal(tierName("en", tierOf(5, 3)), "Beyond the limit");
  assert.equal(tierName("en", tierOf(1, 3)), "2 to go");
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
  assert.equal(s.xp - s.questXp, 100 + 120 + 100 + 120 + WEEKLY_XP);
  assert.deepEqual(s.weeklyLocks, []);
  const s2 = computeStats(ws, { tz: TZ, goal: 2, now: jst("2026-10-16T10:00:00"), weekly });
  assert.equal(s2.weeklyLocks.length, 1);
});

test("every Japanese string has an English counterpart", async () => {
  const { T } = await import("../src/i18n.js");
  const missing = Object.keys(T.ja).filter((k) => !(k in T.en));
  const extra = Object.keys(T.en).filter((k) => !(k in T.ja));
  assert.deepEqual({ missing, extra }, { missing: [], extra: [] });
});

test("all notifications render in both languages", async () => {
  const { notice } = await import("../src/notice.js");
  const now = jst("2026-10-16T21:00:00");
  const ws = daysOf(1, "2026-10-16", 1);
  const s = computeStats(ws, { tz: TZ, goal: 2, now });
  for (const lang of ["ja", "en"]) {
    for (const [kind, extra] of [["soon", { tool: "claude", w: { reset_at: now + 5 * 60000 } }], ["reset", { tool: "claude" }], ["late", { tool: "codex", minutes: 12 }], ["pinch", {}], ["goal", {}], ["hit", { tool: "claude", w: ws[0] }], ["weekly", { tool: "codex", w: { reset_at: now + 3 * 86400000 } }], ["test", {}]]) {
      const m = notice({ lang }, kind, kind === "test" ? null : s, now, extra);
      assert.ok(m.title && m.body && !/undefined|NaN/.test(m.title + m.body), `${lang} ${kind}: ${m.title} / ${m.body}`);
      if (lang === "en") assert.ok(!/[\u3040-\u30ff\u4e00-\u9fff]/.test(m.title + m.body), `${kind} has Japanese in English: ${m.title} ${m.body}`);
    }
  }
});

test("lost windows from a delay", async () => {
  const { lostWindowsOf } = await import("../src/logic.js");
  assert.equal(lostWindowsOf(30), 30 / 330);
});

test("yesterday's count and the last time a limit was hit", () => {
  const ws = [...daysOf(1, "2026-10-15", 3), win("codex", "2026-10-16T09:30:00", "2026-10-16T12:00:00", null)];
  const s = computeStats(ws, { tz: TZ, goal: 2, now: jst("2026-10-16T14:00:00") });
  assert.equal(s.yesterdayCount, 3);
  assert.deepEqual(s.yesterdayByTool, { claude: 2, codex: 1, antigravity: 0 });
  assert.equal(s.lastHitByTool.codex, jst("2026-10-16T09:30:00"));
  assert.equal(s.lastHitByTool.claude, jst("2026-10-15T12:00:00"));
});

test("today's track lists every opened window with its state", () => {
  const now = jst("2026-10-16T16:30:00");
  const ws = [win("claude", "2026-10-16T09:00:00", "2026-10-16T12:00:00", null)];
  const sessions = [
    { tool: "claude", start_at: jst("2026-10-16T07:00:00"), reset_at: jst("2026-10-16T12:00:00"), peak_pct: 100, exact: 1 },
    { tool: "codex", start_at: jst("2026-10-16T09:55:00"), reset_at: jst("2026-10-16T14:55:00"), peak_pct: 84, exact: 1 },
    { tool: "codex", start_at: jst("2026-10-16T15:11:00"), reset_at: jst("2026-10-16T20:11:00"), peak_pct: 41, exact: 1 },
    { tool: "codex", start_at: jst("2026-10-15T15:11:00"), reset_at: jst("2026-10-15T20:11:00"), peak_pct: 90, exact: 1 },
  ];
  const s = computeStats(ws, { tz: TZ, goal: 2, now, sessions });
  assert.deepEqual(s.todayOpened.map((o) => [o.tool, o.status, o.pct]), [["claude", "maxed", 100], ["codex", "ended", 84], ["codex", "active", 41]]);
  assert.equal(s.todayOpenedCount, 3);
  assert.equal(s.todayOpened[0].xp, 100);
});

test("quick-restart task lists today's resets with their delay", () => {
  const now = jst("2026-10-16T18:00:00");
  const ws = [
    win("codex", "2026-10-16T09:00:00", "2026-10-16T12:00:00", "2026-10-16T12:03:00"),  // 3分後 → 達成
    { ...win("claude", "2026-10-16T13:00:00", "2026-10-16T16:00:00", "2026-10-16T15:50:00"), reset_at: jst("2026-10-16T15:50:00"), ended_at: jst("2026-10-16T15:50:00") }, // チケット
    win("codex", "2026-10-16T14:00:00", "2026-10-16T16:30:00", "2026-10-16T16:45:00"),  // 15分後 → 未達
    win("claude", "2026-10-16T17:00:00", "2026-10-16T21:00:00", null),                    // これから
  ];
  const s = computeStats(ws, { tz: TZ, goal: 2, now });
  assert.deepEqual(s.todayResets.map((r) => [r.tool, r.passed, r.quick, r.ticket]), [["codex", true, true, false], ["claude", true, true, true], ["codex", true, false, false], ["claude", false, false, false]]);
  assert.equal(s.todayQuick, 2);
  assert.equal(s.todayResetsPassed, 3);
  const s2 = computeStats([win("codex", "2026-10-16T00:10:00", "2026-10-16T01:17:00", "2026-10-16T04:31:00")], { tz: TZ, goal: 2, now });
  assert.equal(s2.todayResets[0].rest, true);
  assert.equal(s2.todayResetsPassed, 0);
});

test("daily quests: three per day, stable per user and day, with progress", async () => {
  const { questIdsFor, QUEST_XP } = await import("../src/logic.js");
  assert.deepEqual(questIdsFor("u1", "2026-10-16"), questIdsFor("u1", "2026-10-16"));
  assert.equal(new Set(questIdsFor("u1", "2026-10-16")).size, 3);
  const now = jst("2026-10-16T20:00:00");
  const ws = [
    win("claude", "2026-10-16T08:00:00", "2026-10-16T10:00:00", "2026-10-16T10:02:00"),
    win("codex", "2026-10-16T13:00:00", "2026-10-16T15:00:00", "2026-10-16T15:03:00"),
  ];
  // シードを変えて、各クエストの判定を確かめる
  const all = {};
  for (let i = 0; i < 60; i++) for (const q of computeStats(ws, { tz: TZ, goal: 2, now, seed: `s${i}` }).todayQuests) all[q.id] = q;
  assert.equal(all.quick2.done, true);      // 2分・3分で再開
  assert.equal(all.both.done, true);        // 両方のツール
  assert.equal(all.noon.done, true);        // 8時に到達
  assert.equal(all.late10.done, true);      // 出遅れ 5分
  assert.equal(all.extra.done, false);      // 2枠 < 目標+1
  assert.equal(all.quick15x3.value, 2);
  const s = computeStats(ws, { tz: TZ, goal: 2, now, seed: "s1" });
  assert.equal(s.todayQuestXp, s.todayQuests.filter((q) => q.done).length * QUEST_XP);
});

test("profileStats: bests, restarts and patterns", async () => {
  const { profileStats, computeStats } = await import("../src/logic.js");
  const H = 3600e3, M = 60e3;
  const base = Date.UTC(2026, 9, 5, 0, 0); // 月曜 (UTC)
  const ws = [
    { tool: "claude", hit_at: base + 9 * H, reset_at: base + 14 * H, resumed_at: base + 14 * H + 2 * M },
    { tool: "claude", hit_at: base + 15 * H, reset_at: base + 20 * H, resumed_at: base + 20 * H + 1 * M },
    { tool: "codex", hit_at: base + 15 * H + 30 * M, reset_at: base + 20 * H + 30 * M, resumed_at: base + 20 * H + 50 * M },
    { tool: "claude", hit_at: base + 24 * H + 15 * H, reset_at: base + 24 * H + 20 * H, resumed_at: null },
  ];
  const now = base + 3 * 24 * H;
  const s = computeStats(ws, { tz: "UTC", goal: 2, now });
  const opened = [{ start_at: base + 1 * H }, { start_at: base + 10 * H }, { start_at: base + 16 * H }, { start_at: base + 26 * H }];
  const p = profileStats(ws, opened, s, { tz: "UTC", now });
  assert.deepEqual(p.bestDay, { count: 3, day: "2026-10-05" });
  assert.deepEqual(p.bestOpened, { count: 3, day: "2026-10-05" });
  assert.equal(p.bestQuickRun, 2);
  assert.equal(p.restarts, 3);
  assert.equal(p.quickRate, 67);
  assert.equal(p.medianLateMin, 2);
  assert.equal(p.lostMin, 23);
  assert.equal(p.topHour, 15);
  assert.equal(p.topWeekday, 0);
  assert.deepEqual(p.byTool, { claude: 3, codex: 1, antigravity: 0 });
  assert.equal(p.activeDays, 2);
  assert.equal(p.goalDays, 1);
  assert.equal(p.bestWeek.week, "2026-10-05");
});

test("league: week bounds, XP in the week, zones and settlement", async () => {
  const { leagueWeek, leagueXp, zones, settle, nextTier } = await import("../src/league.js");
  const w = leagueWeek(Date.UTC(2026, 9, 18, 23, 0)); // 日曜 (UTC)
  assert.equal(w.id, "2026-10-12");
  assert.equal(leagueWeek(Date.UTC(2026, 9, 19, 0, 0)).id, "2026-10-19");
  const H = 3600e3, M = 60e3;
  // 月曜 0:30 UTC の枠は今週、日曜 23:30 UTC の枠は先週
  const ws = [
    { tool: "claude", hit_at: Date.UTC(2026, 9, 11, 23, 30), reset_at: Date.UTC(2026, 9, 12, 4, 30), resumed_at: Date.UTC(2026, 9, 12, 4, 31) },
    { tool: "claude", hit_at: Date.UTC(2026, 9, 12, 0, 30), reset_at: Date.UTC(2026, 9, 12, 5, 30), resumed_at: null },
  ];
  const s = computeStats(ws, { tz: "UTC", goal: 5, now: Date.UTC(2026, 9, 14) });
  // 今週の枠 100 XP + 月曜に達成したデイリークエスト
  assert.equal(leagueXp(s, w), 100 + (s.days["2026-10-12"].quests ?? 0) * 50);
  assert.equal(leagueXp(s, { start: w.start - 7 * 24 * H, end: w.start }), s.days["2026-10-11"].xp);
  assert.deepEqual(zones(30, 0), { up: 7, down: 0 });
  assert.deepEqual(zones(30, 3), { up: 7, down: 5 });
  assert.deepEqual(zones(3, 3), { up: 1, down: 0 });
  assert.deepEqual(zones(30, 9), { up: 0, down: 5 });
  const r = settle([{ user_id: 1, xp: 50, joined_at: 2 }, { user_id: 2, xp: 900, joined_at: 3 }, { user_id: 3, xp: 50, joined_at: 1 }, { user_id: 4, xp: 10, joined_at: 1 }, { user_id: 5, xp: 5, joined_at: 1 }], 2);
  assert.deepEqual(r.map((x) => [x.user_id, x.rank, x.result]), [[2, 1, "up"], [3, 2, "up"], [1, 3, "stay"], [4, 4, "stay"], [5, 5, "down"]]);
  assert.equal(nextTier({ tier: 2, result: "up" }), 3);
  assert.equal(nextTier({ tier: 0, result: "down" }), 0);
  assert.equal(nextTier(null), 0);
});

test("written level: steps, progress and the last level", async () => {
  const { writtenLevel, WRITTEN } = await import("../src/logic.js");
  assert.deepEqual(writtenLevel(0), { reached: -1, next: 0, pct: 0, total: 0, left: 15 });
  const p = writtenLevel(1.5e6);
  assert.equal(WRITTEN[p.reached][0], "potter");
  assert.equal(WRITTEN[p.next][0], "kochikame");
  assert.ok(p.pct > 0 && p.pct < 10);
  // 1,000京を超えても、最後のアカシックレコードには届かない
  const top = writtenLevel(1e20);
  assert.equal(WRITTEN[top.reached][0], "allSpeech");
  assert.equal(WRITTEN[top.next][0], "akashic");
  assert.equal(top.left, Infinity);
});

test("warmupPlan: same times every day (anchor 08:00, Tokyo)", async () => {
  const { warmupPlan } = await import("../src/logic.js");
  const T = (s) => Date.parse(`${s}+09:00`);
  const plan = (s) => new Date(warmupPlan(T(s), "08:00", "Asia/Tokyo")).toISOString();
  const iso = (s) => new Date(T(s)).toISOString();
  assert.equal(plan("2026-10-17T13:00:00"), iso("2026-10-17T13:00:00"));   // 予定どおり
  assert.equal(plan("2026-10-17T12:30:00"), iso("2026-10-17T13:00:00"));   // 30分待ってそろえる
  assert.equal(plan("2026-10-17T11:30:00"), iso("2026-10-17T11:30:00"));   // 90分は待たない
  assert.equal(plan("2026-10-17T04:00:00"), iso("2026-10-17T08:00:00"));   // 夜の休み → 朝にそろえる
  assert.equal(plan("2026-10-17T23:30:00"), iso("2026-10-17T23:30:00"));   // ずれたまま始める
  assert.equal(plan("2026-10-18T04:30:00"), iso("2026-10-18T08:00:00"));   // 次の朝にはそろう
  assert.equal(plan("2026-10-17T08:00:00"), iso("2026-10-17T08:00:00"));
  assert.equal(plan("2026-10-17T13:00:05"), iso("2026-10-17T13:00:05"));   // 数秒の遅れはそのまま
  assert.equal(warmupPlan(T("2026-10-17T12:30:00"), null, "Asia/Tokyo"), T("2026-10-17T12:30:00"));
});

test("delays are counted from the planned restart time (due_at)", () => {
  const H = 3600e3, M = 60e3;
  const reset = jst("2026-10-16T04:00:00"), due = jst("2026-10-16T08:00:00");
  // 04:00 にリセット、そろえて 08:00 に始める予定、08:01 に再開 → 即スタート
  const ws = [{ tool: "claude", hit_at: reset - 3 * H, reset_at: reset, due_at: due, resumed_at: due + M }];
  const s = computeStats(ws, { tz: TZ, goal: 1, now: jst("2026-10-16T09:00:00") });
  const r = s.todayResets[0];
  assert.equal(r.dueAt, due);
  assert.equal(r.quick, true);
  assert.equal(r.delayMin, 1);
  assert.equal(delayOf(ws[0]), M);
  // 予定の時刻の前は「待っている」ではない
  const s2 = computeStats([{ ...ws[0], resumed_at: null }], { tz: TZ, goal: 1, now: jst("2026-10-16T07:00:00") });
  assert.equal(s2.todayResets[0].passed, false);
  assert.equal(s2.todayResets[0].waiting, false);
});
