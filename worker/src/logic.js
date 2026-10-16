// 集計ロジック (D1 にも Workers にも依存しない純粋な関数。test/ から直接テストする)

export const MIN = 60 * 1000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;
export const WINDOW_MS = 5 * HOUR;
export const QUICK_MS = 5 * MIN;        // これ以内に再開したら「即スタート」
export const CHASE_MS = 3 * HOUR;       // これより後の再開は出遅れではなく休憩とみなす
export const MAX_FREEZES = 2;
export const WEEKLY_XP = 1000;          // 週間リミットを使い切ったごほうび
export const QUEST_XP = 50;             // デイリークエスト 1つのごほうび

// デイリークエストの候補。毎日、人ごとに 3つ選ぶ。value(d) がその日の進み具合、target が目標
// d: その日の集計 { count, claude, codex, quick, quick15, resets, late, beforeNoon }
export const QUESTS = {
  quick2: { target: () => 2, value: (d) => d.quick },
  quick15x3: { target: () => 3, value: (d) => d.quick15 },
  late10: { target: () => 1, value: (d) => (d.resets >= 1 && d.late <= 10 ? 1 : 0) },
  both: { target: () => 2, value: (d) => (d.claude > 0 ? 1 : 0) + (d.codex > 0 ? 1 : 0) },
  extra: { target: (goal) => goal + 1, value: (d) => d.count },
  noon: { target: () => 1, value: (d) => (d.beforeNoon ? 1 : 0) },
};
const QUEST_IDS = Object.keys(QUESTS);

// 同じ人・同じ日なら同じ 3つになるよう、文字列から決まった数を作る (FNV-1a)
function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
export function questIdsFor(seed, day) {
  const ids = [...QUEST_IDS];
  let h = hash(`${seed}:${day}`);
  const out = [];
  while (out.length < 3 && ids.length) { out.push(ids.splice(h % ids.length, 1)[0]); h = hash(String(h)); }
  return out;
}
export const FREEZE_EVERY = 7;          // 7日連続ごとにフリーズを 1つもらえる

export const TOOL_NAME = { claude: "Claude Code", codex: "Codex" };

export function validTz(tz) {
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; }
}

const partsCache = new Map();
function fmt(tz, opts) {
  const k = tz + JSON.stringify(opts);
  let f = partsCache.get(k);
  if (!f) partsCache.set(k, (f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", ...opts })));
  return f;
}
function parts(ms, tz) {
  const o = {};
  for (const p of fmt(tz, { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short" }).formatToParts(new Date(ms))) o[p.type] = p.value;
  return o;
}

// その時刻がユーザーのタイムゾーンで何日か (0時区切り)
export function dayKey(ms, tz) {
  const p = parts(ms, tz);
  return `${p.year}-${p.month}-${p.day}`;
}

export function localTime(ms, tz) {
  const p = parts(ms, tz);
  return `${p.hour}:${p.minute}`;
}

export function addDays(key, n) {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

// ユーザーのタイムゾーンで次の 0時になる時刻
export function nextMidnight(now, tz) {
  const p = parts(now, tz);
  const minsToday = (+p.hour) * 60 + (+p.minute);
  // 秒は無視してよい精度で十分
  return now - (now % MIN) + (24 * 60 - minsToday) * MIN;
}

// 今すぐ始めて毎回使い切った場合、今日あと何回到達できるか
export function possibleToday(now, tz) {
  const left = nextMidnight(now, tz) - now;
  return Math.max(0, Math.ceil(left / WINDOW_MS));
}

const DOW = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
// 週 (月曜はじまり) の初日
export function weekKey(ms, tz) {
  return addDays(dayKey(ms, tz), -DOW[parts(ms, tz).weekday]);
}

// リセットから再開までの時間。再開していない・休憩とみなす場合は null
export function delayOf(w) {
  if (w.resumed_at == null) return null;
  const d = Math.max(0, w.resumed_at - w.reset_at);
  return d <= CHASE_MS ? d : null;
}

// その日の何枠目かで XP が増える (コンボ)。n は 1 始まり
export const COMBO_XP = [100, 120, 150, 200, 300];
export const comboXp = (n) => COMBO_XP[Math.min(n, COMBO_XP.length) - 1];

// 「AI が書いた量」の段階: [キー, その長さの出力トークン数 (だいたい)]。名前は i18n.js の w.<キー>
export const WRITTEN = [
  ["haiku", 15], ["tweet", 140], ["loveLetter", 800], ["principal", 3000], ["melos", 1e4], ["terms", 2.5e4],
  ["pokedex", 6e4], ["neko", 3.5e5], ["warPeace", 7.8e5], ["potter", 1.45e6], ["kochikame", 2.4e6], ["kojien", 1.2e7],
  ["britannica", 6e7], ["linux", 3e8], ["lifetime", 6e8], ["wikipedia", 6.5e9], ["ndl", 1e12], ["allBooks", 1.3e13],
  ["web", 1e14], ["allSpeech", 1e19], ["akashic", Infinity],
];

// 今どの段階まで書いたか。reached = 届いたいちばん上の段 (-1 = まだ俳句にも届いていない)、pct = 次の段までの進み具合
export function writtenLevel(total) {
  let reached = -1;
  for (let i = 0; i < WRITTEN.length; i++) if (total >= WRITTEN[i][1]) reached = i;
  const next = Math.min(reached + 1, WRITTEN.length - 1);
  const from = reached >= 0 ? WRITTEN[reached][1] : 0, to = WRITTEN[next][1];
  const pct = Number.isFinite(to) ? Math.min(100, Math.max(0, ((total - from) / (to - from)) * 100)) : 0;
  return { reached, next, pct, total, left: Number.isFinite(to) ? Math.max(0, to - total) : Infinity };
}

// 出遅れ d 分は、その日の枠を d / (300 + d) 枠ぶん減らす (5時間の枠が 5時間+d 分かかるのと同じ)
export const lostWindowsOf = (delayMin) => delayMin / (300 + delayMin);

// 称号は「自分の目標」が基準。目標1枠の人も3枠の人も、同じように限界突破までたどり着ける。
// 表示する言葉は i18n.js の tierName が決める
export function tierOf(n, goal) {
  if (n <= 0) return null;
  if (n < goal) return { key: "left", n: goal - n };
  if (n === goal) return { key: "goal" };
  if (n === goal + 1) return { key: "over" };
  return { key: "beyond" };
}

export function quickBonus(w) {
  const d = delayOf(w);
  return d == null ? 0 : d <= QUICK_MS ? 50 : d <= 15 * MIN ? 20 : 0;
}

export function xpOf(w, n = 1) {
  return comboXp(n) + quickBonus(w);
}

// windows: [{tool, hit_at, reset_at, resumed_at}] / weekly: [{tool, hit_at, reset_at}] (週間リミットの到達)
// キャラクター「リミ」の気分: 今日の状況から表情と一言を決める
export function moodOf(s, now) {
  if (s.weeklyLocks?.length) return { mood: "cheer", key: "weekly" };
  if (s.todayDone) return { mood: "cheer", key: "goal", n: s.streak };
  const passed = (s.todayResets ?? []).filter((r) => r.passed && !r.rest);
  const last = passed.at(-1);
  if (last?.waiting) {
    const m = Math.round((now - last.resetAt) / MIN);
    return m <= 10 ? { mood: "excited", key: "go", tool: last.tool } : { mood: "sad", key: "waiting", m, tool: last.tool };
  }
  if (last && now - last.resetAt < 2 * HOUR) {
    return last.quick ? { mood: "happy", key: "quick", m: last.ticket ? 0 : last.delayMin ?? 0 } : { mood: "sad", key: "late", m: last.delayMin ?? 0 };
  }
  const left = Math.max(0, s.goal - s.todayCount);
  if (+localTime(now, s.tz).slice(0, 2) >= 20) return { mood: "worried", key: "pinch", left, n: s.streak };
  return { mood: "neutral", key: "hello", left };
}

export function computeStats(windows, { tz = "UTC", goal = 2, now = Date.now(), weekly = [], sessions = [], seed = "" } = {}) {
  const ws = [...windows].sort((a, b) => a.hit_at - b.hit_at);
  const today = dayKey(now, tz);
  const thisWeek = weekKey(now, tz);
  const days = {};
  const todayWindows = [];
  const xpLog = []; // いつ何 XP もらったか (リーグは世界共通の週で数えるので、時刻つきで残す)
  let xp = 0, weekXp = 0;
  for (const w of ws) {
    const k = dayKey(w.hit_at, tz);
    const d = (days[k] ??= { count: 0, claude: 0, codex: 0, xp: 0, lateMin: 0 });
    d.count++;
    const x = xpOf(w, d.count);
    if (k === today) todayWindows.push({ tool: w.tool, hitAt: w.hit_at, resetAt: w.reset_at, n: d.count, xp: x, combo: comboXp(d.count), bonus: quickBonus(w), tier: tierOf(d.count, goal) });
    d[w.tool] = (d[w.tool] ?? 0) + 1;
    d.xp += x;
    const late = delayOf(w);
    if (late != null) d.lateMin += Math.round(late / MIN);
    xp += x;
    xpLog.push({ at: w.hit_at, xp: x });
    if (weekKey(w.hit_at, tz) === thisWeek) weekXp += x;
  }
  // 週間リミット: 大きなごほうび。さらにリセットまでの日は 5時間枠を使えないので、ストリークを自動で守る
  const locked = new Set();
  for (const w of weekly) {
    xp += WEEKLY_XP;
    xpLog.push({ at: w.hit_at, xp: WEEKLY_XP });
    if (weekKey(w.hit_at, tz) === thisWeek) weekXp += WEEKLY_XP;
    const k = dayKey(w.hit_at, tz);
    (days[k] ??= { count: 0, claude: 0, codex: 0, xp: 0, lateMin: 0 }).weekly = (days[k].weekly ?? 0) + 1;
    days[k].xp += WEEKLY_XP;
    for (let d = k, end = dayKey(w.reset_at, tz); d <= end; d = addDays(d, 1)) locked.add(d);
  }
  // デイリークエスト用の 1日ごとの集計 (再開の速さはリセットされた日で数える)
  const qd = (k) => (qdays[k] ??= { count: days[k]?.count ?? 0, claude: days[k]?.claude ?? 0, codex: days[k]?.codex ?? 0, quick: 0, quick15: 0, resets: 0, late: 0, beforeNoon: false });
  const qdays = {};
  for (const w of ws) {
    const hk = dayKey(w.hit_at, tz);
    if (+localTime(w.hit_at, tz).slice(0, 2) < 12) qd(hk).beforeNoon = true;
    qd(hk).lastAt = Math.max(qd(hk).lastAt ?? 0, w.hit_at);
    if (w.reset_at > now) continue;
    const d = w.resumed_at != null ? Math.max(0, w.resumed_at - w.reset_at) : now - w.reset_at;
    if (!w.ended_at && d > CHASE_MS) continue; // 休憩扱い
    const r = qd(dayKey(w.reset_at, tz));
    r.resets++;
    r.lastAt = Math.max(r.lastAt ?? 0, w.resumed_at ?? w.reset_at);
    const done = w.ended_at || w.resumed_at != null;
    if (w.ended_at || (done && d <= QUICK_MS)) r.quick++;
    if (w.ended_at || (done && d <= 15 * MIN)) r.quick15++;
    if (!w.ended_at) r.late += Math.round(d / MIN);
  }
  // 達成したクエストの XP を足す
  const questsOf = (k) => questIdsFor(seed, k).map((id) => {
    const q = QUESTS[id], d = qd(k);
    const target = q.target(goal), value = Math.min(target, q.value(d));
    return { id, value, target, done: value >= target, xp: QUEST_XP };
  });
  let questXp = 0;
  for (const k of Object.keys(qdays)) {
    const n = questsOf(k).filter((q) => q.done).length;
    if (!n) continue;
    const add = n * QUEST_XP;
    questXp += add;
    (days[k] ??= { count: 0, claude: 0, codex: 0, xp: 0, lateMin: 0 }).xp += add;
    days[k].quests = n;
    xp += add;
    xpLog.push({ at: qdays[k].lastAt ?? 0, xp: add });
    if (k >= thisWeek && k <= today) weekXp += add;
  }
  const todayQuests = questsOf(today);

  const met = (k) => (days[k]?.count ?? 0) >= goal;

  // ストリーク: 最初の記録日から昨日までをたどる。未達の日はフリーズがあれば自動で使う
  let run = 0, best = 0, freezes = 0, metRun = 0;
  const frozen = [];
  const lockedDays = [];
  const first = ws.length ? dayKey(ws[0].hit_at, tz) : today;
  for (let k = first; k < today; k = addDays(k, 1)) {
    if (met(k)) {
      run++; metRun++;
      if (metRun % FREEZE_EVERY === 0) freezes = Math.min(MAX_FREEZES, freezes + 1);
    } else if (locked.has(k)) {
      lockedDays.push(k);           // 週間リミット中: 伸びないが途切れない (フリーズも使わない)
    } else if (run > 0 && freezes > 0) {
      freezes--; frozen.push(k);
    } else {
      run = 0; metRun = 0;
    }
    best = Math.max(best, run);
  }
  // 今日は未達でもまだ途切れていない (Duolingo と同じ)
  const todayDone = met(today);
  const streak = run + (todayDone ? 1 : 0);
  // 次のフリーズまで: 達成した日が 7日続くごとに 1つ (最大 2つ)。今日の達成も数える
  const metNow = metRun + (todayDone ? 1 : 0);
  const freezeIn = freezes >= MAX_FREEZES ? null : FREEZE_EVERY - (metNow % FREEZE_EVERY);
  best = Math.max(best, streak);

  // 即スタート連続: 新しい枠から順に、5分以内に再開できた回数
  let quickRun = 0;
  for (const w of [...ws].sort((a, b) => b.reset_at - a.reset_at)) {
    if (w.reset_at > now) continue;                                       // まだリセット前
    if (w.resumed_at == null && now - w.reset_at < CHASE_MS) continue;     // 再開待ち
    const d = delayOf(w);
    if (d != null && d <= QUICK_MS) quickRun++;
    else break;
  }

  // ツールごとの今の状態 (リミット中なら次のリセット時刻)
  const tools = {};
  for (const w of ws) {
    if (w.reset_at > now && (!tools[w.tool] || w.reset_at > tools[w.tool].resetAt)) {
      tools[w.tool] = { state: "limited", resetAt: w.reset_at, hitAt: w.hit_at };
    }
  }
  const lastReset = {};
  for (const w of ws) {
    if (w.reset_at <= now && (!lastReset[w.tool] || w.reset_at > lastReset[w.tool].reset_at)) lastReset[w.tool] = w;
  }

  // 今日開けた枠 (1マス = 1枠)。使い切った枠 (windows) と照らし合わせて状態を決める:
  //   maxed = 使い切った / active = 使用中 / ended = 使い切らずに終わった
  const todayOpened = [];
  const usedWin = new Set();
  for (const o of sessions) {
    if (dayKey(o.start_at, tz) !== today) continue;
    const w = ws.find((x) => x.tool === o.tool && Math.abs((x.orig_reset_at ?? x.reset_at) - o.reset_at) < 15 * MIN);
    if (w) usedWin.add(w);
    const status = w ? "maxed" : o.reset_at > now ? "active" : "ended";
    todayOpened.push({ tool: o.tool, startAt: o.start_at, resetAt: o.reset_at, pct: w ? 100 : o.peak_pct, exact: !!o.exact, status, hitAt: w?.hit_at ?? null });
  }
  // 開けた枠の記録がない使い切りの枠 (古いデータなど) も入れる
  for (const w of ws) {
    if (dayKey(w.hit_at, tz) === today && !usedWin.has(w)) todayOpened.push({ tool: w.tool, startAt: w.reset_at - WINDOW_MS, resetAt: w.reset_at, pct: 100, exact: true, status: "maxed", hitAt: w.hit_at });
  }
  todayOpened.sort((a, b) => a.startAt - b.startAt);
  // 使い切った枠には XP を付ける (何枠目かは使い切った順)
  for (const o of todayOpened) {
    if (o.status !== "maxed") continue;
    const tw = todayWindows.find((x) => x.tool === o.tool && x.hitAt === o.hitAt);
    if (tw) { o.n = tw.n; o.xp = tw.xp; }
  }

  // 「リセット後すぐ再開」タスク: 今日リセットされた (される) 使い切りの枠ごとに、再開までの時間
  const todayResets = ws.filter((w) => dayKey(w.reset_at, tz) === today).map((w) => {
    const passed = w.reset_at <= now;
    const d = w.resumed_at != null ? Math.max(0, w.resumed_at - w.reset_at) : null;
    const ticket = !!w.ended_at;
    // 3時間以上あとの再開 (または 3時間以上たっても未再開) は寝ていた・休んでいたとみなし、タスクに数えない
    const rest = !ticket && passed && (d != null ? d > CHASE_MS : now - w.reset_at > CHASE_MS);
    return {
      tool: w.tool, resetAt: w.reset_at, passed, ticket, rest,
      delayMin: d == null ? null : Math.round(d / MIN),
      quick: ticket || (d != null && d <= QUICK_MS),
      waiting: passed && !rest && w.resumed_at == null,
    };
  }).sort((a, b) => a.resetAt - b.resetAt);

  // 今日を除いた 1日の最多枠数 (今日それを超えたら自己ベスト更新)
  let bestDay = 0;
  for (const [k, d] of Object.entries(days)) if (k !== today) bestDay = Math.max(bestDay, d.count);
  const todayCount = days[today]?.count ?? 0;

  return {
    today, goal, tz,
    todayCount,
    yesterdayCount: days[addDays(today, -1)]?.count ?? 0,
    // ツールごとの「昨日の枠数」と「最後にリミットに当たった時刻」(ダイヤルの下に出す)
    yesterdayByTool: { claude: days[addDays(today, -1)]?.claude ?? 0, codex: days[addDays(today, -1)]?.codex ?? 0 },
    lastHitByTool: Object.fromEntries(["claude", "codex"].map((tool) => [tool, ws.filter((w) => w.tool === tool).at(-1)?.hit_at ?? null])),
    todayWindows,
    todayOpened,
    todayQuests,
    questXp,
    todayQuestXp: (days[today]?.quests ?? 0) * QUEST_XP,
    todayResets,
    todayQuick: todayResets.filter((r) => r.passed && !r.rest && r.quick).length,
    todayResetsPassed: todayResets.filter((r) => r.passed && !r.rest).length,
    todayOpenedCount: todayOpened.length,
    todayXp: days[today]?.xp ?? 0,
    tier: tierOf(todayCount, goal),
    nextTier: tierOf(todayCount + 1, goal),
    nextXp: comboXp(todayCount + 1),
    bestDay,
    todayIsRecord: todayCount > 0 && todayCount > bestDay,
    todayDone,
    todayLateMin: days[today]?.lateMin ?? 0,
    possibleToday: possibleToday(now, tz),
    streak, bestStreak: best, freezes, freezeIn, frozenDays: frozen, lockedDays,
    weeklyLocks: weekly.filter((w) => w.reset_at > now).map((w) => ({ tool: w.tool, resetAt: w.reset_at })),
    trophies: weekly.length,
    quickRun,
    xp, weekXp, week: thisWeek, xpLog,
    total: ws.length,
    days,
    tools,
    lastReset,
  };
}

// プロフィールに出す、これまでの全記録からの集計 (今ある記録を数え直すだけ)
// ws: 使い切った枠 (全期間) / opened: 開けた枠 [{start_at}] / s: 同じ ws の computeStats
export function profileStats(ws, opened, s, { tz = "UTC", now = Date.now() } = {}) {
  const sorted = [...ws].sort((a, b) => a.hit_at - b.hit_at);
  // 1日の最多 (今日も含める)
  let bestDay = null;
  for (const [day, d] of Object.entries(s.days)) if (d.count > 0 && (!bestDay || d.count > bestDay.count)) bestDay = { count: d.count, day };
  // 1日に開いた枠の最多
  const openedByDay = {};
  for (const o of opened) { const k = dayKey(o.start_at, tz); openedByDay[k] = (openedByDay[k] ?? 0) + 1; }
  let bestOpened = null;
  for (const [day, n] of Object.entries(openedByDay)) if (!bestOpened || n > bestOpened.count) bestOpened = { count: n, day };
  // 最高の週 (XP)
  const weeks = {};
  for (const [day, d] of Object.entries(s.days)) { const k = addDays(day, -((new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7)); weeks[k] = (weeks[k] ?? 0) + d.xp; }
  let bestWeek = null;
  for (const [week, xp] of Object.entries(weeks)) if (xp > 0 && (!bestWeek || xp > bestWeek.xp)) bestWeek = { xp, week };
  // リセット後の再開: 即スタート率・出遅れ・即スタートの最長連続
  const delays = [];
  let run = 0, bestQuickRun = 0;
  for (const w of sorted) {
    if (w.reset_at > now) continue;
    const d = delayOf(w);
    if (d == null) continue;
    delays.push(d);
    run = d <= QUICK_MS ? run + 1 : 0;
    bestQuickRun = Math.max(bestQuickRun, run);
  }
  const quick = delays.filter((d) => d <= QUICK_MS).length;
  const med = [...delays].sort((a, b) => a - b)[Math.floor((delays.length - 1) / 2)];
  // よく使い切る時間帯と曜日
  const hours = Array(24).fill(0), weekdays = Array(7).fill(0);
  for (const w of sorted) {
    hours[+localTime(w.hit_at, tz).slice(0, 2)]++;
    weekdays[(new Date(`${dayKey(w.hit_at, tz)}T00:00:00Z`).getUTCDay() + 6) % 7]++;
  }
  const argmax = (a) => (a.some((n) => n > 0) ? a.indexOf(Math.max(...a)) : null);
  const active = Object.values(s.days).filter((d) => d.count > 0);
  return {
    bestDay, bestOpened, bestWeek, bestQuickRun,
    byTool: { claude: sorted.filter((w) => w.tool === "claude").length, codex: sorted.filter((w) => w.tool === "codex").length },
    activeDays: active.length,
    goalDays: active.filter((d) => d.count >= s.goal).length,
    restarts: delays.length,
    quick,
    quickRate: delays.length ? Math.round((quick / delays.length) * 100) : null,
    medianLateMin: med == null ? null : Math.round(med / MIN),
    lostMin: Math.round(delays.reduce((a, b) => a + b, 0) / MIN),
    hours, weekdays, topHour: argmax(hours), topWeekday: argmax(weekdays),
    firstAt: sorted[0]?.hit_at ?? null,
  };
}
