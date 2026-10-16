// 集計ロジック (D1 にも Workers にも依存しない純粋な関数。test/ から直接テストする)

export const MIN = 60 * 1000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;
export const WINDOW_MS = 5 * HOUR;
export const QUICK_MS = 5 * MIN;        // これ以内に再開したら「即スタート」
export const CHASE_MS = 3 * HOUR;       // これより後の再開は出遅れではなく休憩とみなす
export const MAX_FREEZES = 2;
export const WEEKLY_XP = 1000;          // 週間リミットを使い切ったごほうび
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
export function computeStats(windows, { tz = "UTC", goal = 2, now = Date.now(), weekly = [] } = {}) {
  const ws = [...windows].sort((a, b) => a.hit_at - b.hit_at);
  const today = dayKey(now, tz);
  const thisWeek = weekKey(now, tz);
  const days = {};
  const todayWindows = [];
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
    if (weekKey(w.hit_at, tz) === thisWeek) weekXp += x;
  }
  // 週間リミット: 大きなごほうび。さらにリセットまでの日は 5時間枠を使えないので、ストリークを自動で守る
  const locked = new Set();
  for (const w of weekly) {
    xp += WEEKLY_XP;
    if (weekKey(w.hit_at, tz) === thisWeek) weekXp += WEEKLY_XP;
    const k = dayKey(w.hit_at, tz);
    (days[k] ??= { count: 0, claude: 0, codex: 0, xp: 0, lateMin: 0 }).weekly = (days[k].weekly ?? 0) + 1;
    days[k].xp += WEEKLY_XP;
    for (let d = k, end = dayKey(w.reset_at, tz); d <= end; d = addDays(d, 1)) locked.add(d);
  }
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

  // 今日を除いた 1日の最多枠数 (今日それを超えたら自己ベスト更新)
  let bestDay = 0;
  for (const [k, d] of Object.entries(days)) if (k !== today) bestDay = Math.max(bestDay, d.count);
  const todayCount = days[today]?.count ?? 0;

  return {
    today, goal, tz,
    todayCount,
    todayWindows,
    todayXp: days[today]?.xp ?? 0,
    tier: tierOf(todayCount, goal),
    nextTier: tierOf(todayCount + 1, goal),
    nextXp: comboXp(todayCount + 1),
    bestDay,
    todayIsRecord: todayCount > 0 && todayCount > bestDay,
    todayDone,
    todayLateMin: days[today]?.lateMin ?? 0,
    possibleToday: possibleToday(now, tz),
    streak, bestStreak: best, freezes, frozenDays: frozen, lockedDays,
    weeklyLocks: weekly.filter((w) => w.reset_at > now).map((w) => ({ tool: w.tool, resetAt: w.reset_at })),
    trophies: weekly.length,
    quickRun,
    xp, weekXp, week: thisWeek,
    total: ws.length,
    days,
    tools,
    lastReset,
  };
}
