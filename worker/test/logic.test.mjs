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
  assert.equal(s.todayXp, 420);
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
  assert.equal(s.xp, 100 + 120 + 100 + 120 + WEEKLY_XP);
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

test("API value of a window and lost windows from a delay", async () => {
  const { costOf, lostWindowsOf, priceOf } = await import("../src/pricing.js");
  // Opus 5.5: 入力 $4, 書き込み5分 $5, 書き込み1時間 $8, 読み出し $0.20, 出力 $20 (100万トークンあたり)
  const c = costOf("claude", { "claude-opus-5-5": [1e6, 1e6, 1e6, 1e6, 1e6] });
  assert.equal(Math.round(c.usd * 100) / 100, 4 + 5 + 8 + 0.2 + 20);
  assert.equal(c.estimated, false);
  assert.equal(costOf("codex", { "codex-auto-review": [1e6, 0, 0, 0, 0] }).estimated, true);
  assert.deepEqual(priceOf("codex", "gpt-6.1-sol").p, [2, 10, 0.1]);
  assert.equal(lostWindowsOf(30), 30 / 330);
});

test("yesterday's count and the last time a limit was hit", () => {
  const ws = [...daysOf(1, "2026-10-15", 3), win("codex", "2026-10-16T09:30:00", "2026-10-16T12:00:00", null)];
  const s = computeStats(ws, { tz: TZ, goal: 2, now: jst("2026-10-16T14:00:00") });
  assert.equal(s.yesterdayCount, 3);
  assert.deepEqual(s.yesterdayByTool, { claude: 2, codex: 1 });
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
