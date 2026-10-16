// ratelimit.world: Cloudflare Worker (API + ページ + 毎分の通知 Cron)
import { profileStats, lostWindowsOf, computeStats, validTz, localTime, dayKey, delayOf, MIN, HOUR, DAY, WINDOW_MS, CHASE_MS } from "./logic.js";
import { sendPush, b64u } from "./webpush.js";
import { pickLang, tr, LANGS } from "./i18n.js";
import { notice } from "./notice.js";
import * as pages from "./pages.js";
import { svgToPng, avatarData } from "./og.js";
import { leagueWeek, prevWeek, leagueXp, settle, nextTier, byStanding, zones, LEAGUE_SIZE } from "./league.js";

const SESSION_COOKIE = "rw_session";
const SESSION_DAYS = 90;
const STATS_DAYS = 120;    // ストリーク計算に読む期間
const LATE_AFTER = 10 * MIN;

// ---------- small helpers ----------
const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", ...headers } });
const html = (body, status = 200, headers = {}) =>
  new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", ...headers } });
const redirect = (to, headers = {}, status = 302) => new Response(null, { status, headers: { location: to, ...headers } });

const randomToken = (bytes = 32) => b64u(crypto.getRandomValues(new Uint8Array(bytes)));
async function sha256(s) {
  return b64u(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
}

function getCookie(req, name) {
  const m = (req.headers.get("cookie") || "").match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? decodeURIComponent(m[1]) : null;
}
const cookie = (name, value, maxAge) =>
  `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
const langCookie = (lang) => cookie("rw_lang", lang, 365 * 86400);

// cookie 認証の POST は同じオリジンからだけ受け付ける (CSRF 対策)
function sameOrigin(req) {
  const o = req.headers.get("origin");
  return !o || o === new URL(req.url).origin;
}

const NOTIFY_DEFAULTS = { hit: true, soon: true, reset: true, late: true, pinch: true, goal: true, league: true };
const LEAD_CHOICES = [1, 3, 5, 10, 15]; // 「もうすぐリセット」を送る何分前
const parseNotify = (u) => { try { return { ...NOTIFY_DEFAULTS, ...JSON.parse(u.notify) }; } catch { return { ...NOTIFY_DEFAULTS }; } };

// ---------- auth ----------
async function currentUser(req, env) {
  const t = getCookie(req, SESSION_COOKIE);
  if (!t) return null;
  return env.DB.prepare(
    "SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?",
  ).bind(await sha256(t), Date.now()).first();
}

async function startSession(env, userId, location) {
  const t = randomToken();
  await env.DB.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)")
    .bind(await sha256(t), userId, Date.now() + SESSION_DAYS * DAY).run();
  return redirect(location, { "set-cookie": cookie(SESSION_COOKIE, t, SESSION_DAYS * 86400) });
}

async function cliUser(req, env) {
  const m = (req.headers.get("authorization") || "").match(/^Bearer (.+)$/);
  if (!m) return null;
  const h = await sha256(m[1]);
  const u = await env.DB.prepare("SELECT u.* FROM cli_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = ?").bind(h).first();
  if (u) await env.DB.prepare("UPDATE cli_tokens SET last_used_at = ? WHERE token_hash = ?").bind(Date.now(), h).run();
  return u;
}

const safeNext = (n) => (n && /^\/[^/\\]/.test(n) ? n : "/me");
// 画面を組み立てるときの共通情報 (ログイン中のユーザー・言語・翻訳関数)
const makeCtx = (req, user) => {
  const lang = pickLang(req, user);
  const url = new URL(req.url);
  return { user, lang, t: tr(lang), path: url.pathname + url.search };
};

async function githubLogin(req, env) {
  const url = new URL(req.url);
  const state = randomToken(16);
  const next = safeNext(url.searchParams.get("next"));
  const gh = new URL("https://github.com/login/oauth/authorize");
  gh.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
  gh.searchParams.set("redirect_uri", `${url.origin}/auth/github/callback`);
  gh.searchParams.set("scope", "read:user");
  gh.searchParams.set("state", state);
  return redirect(gh.toString(), { "set-cookie": cookie("rw_oauth", `${state}|${next}`, 600) });
}

async function githubCallback(req, env) {
  const url = new URL(req.url);
  const [state, next] = (getCookie(req, "rw_oauth") || "").split("|");
  const ctx = makeCtx(req, null);
  const fail = (key) => html(pages.message(ctx, ctx.t("err.login.title"), ctx.t(key)), 400);
  if (!state || state !== url.searchParams.get("state")) return fail("err.login.retry");
  const tok = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, code: url.searchParams.get("code") }),
  }).then((r) => r.json());
  if (!tok.access_token) return fail("err.login.token");
  const gh = await fetch("https://api.github.com/user", {
    headers: { authorization: `Bearer ${tok.access_token}`, "user-agent": "ratelimit.world", accept: "application/vnd.github+json" },
  }).then((r) => r.json());
  if (!gh.id) return fail("err.login.user");
  const user = await upsertUser(env, { githubId: gh.id, login: gh.login, name: gh.name, avatar: gh.avatar_url, lang: ctx.lang });
  return startSession(env, user.id, safeNext(next));
}

async function upsertUser(env, { githubId, login, name, avatar, lang }) {
  const now = Date.now();
  if (githubId) {
    const u = await env.DB.prepare("SELECT * FROM users WHERE github_id = ?").bind(githubId).first();
    if (u) {
      await env.DB.prepare("UPDATE users SET login = ?, name = ?, avatar_url = ? WHERE id = ?").bind(login, name, avatar, u.id).run();
      return { ...u, login };
    }
  } else {
    const u = await env.DB.prepare("SELECT * FROM users WHERE login = ?").bind(login).first();
    if (u) return u;
  }
  return env.DB.prepare("INSERT INTO users (github_id, login, name, avatar_url, lang, created_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING *")
    .bind(githubId ?? null, login, name ?? null, avatar ?? null, LANGS.includes(lang) ? lang : null, now).first();
}

// ---------- data ----------
// reset_at は実際のリセット (早く終わった枠は ended_at)。orig_reset_at は PC が送ってきた予定のリセット (同じ枠かの照合に使う)
async function userWindows(env, userId, days = STATS_DAYS) {
  const { results } = await env.DB.prepare(
    "SELECT tool, hit_at, COALESCE(ended_at, reset_at) AS reset_at, reset_at AS orig_reset_at, resumed_at, ended_at FROM windows WHERE user_id = ? AND hit_at > ? ORDER BY hit_at",
  ).bind(userId, Date.now() - days * DAY).all();
  return results;
}

async function userWeekly(env, userId, days = STATS_DAYS) {
  const { results } = await env.DB.prepare("SELECT tool, hit_at, reset_at FROM weekly_hits WHERE user_id = ? AND hit_at > ? ORDER BY hit_at")
    .bind(userId, Date.now() - days * DAY).all();
  return results;
}

async function userSessions(env, userId, days = 3) {
  const { results } = await env.DB.prepare("SELECT tool, reset_at, start_at, peak_pct, exact FROM opened_windows WHERE user_id = ? AND reset_at > ? ORDER BY start_at")
    .bind(userId, Date.now() - days * DAY).all();
  return results;
}

async function statsFor(env, user, now = Date.now()) {
  const [ws, weekly, sessions] = await Promise.all([userWindows(env, user.id), userWeekly(env, user.id), userSessions(env, user.id)]);
  let nextReset = {};
  try { nextReset = JSON.parse(user.next_reset || "{}"); } catch {}
  return { ...computeStats(ws, { tz: user.tz, goal: user.goal, now, weekly, sessions, seed: user.id }), nextReset };
}

// 「AI が書いた量」の合計 (Claude と ChatGPT の出力トークン数)
async function writtenTotal(env, userId) {
  const r = await env.DB.prepare("SELECT COALESCE(SUM(tokens), 0) AS n FROM output_days WHERE user_id = ?").bind(userId).first();
  return r.n;
}

// ---------- friends ----------
const MAX_FOLLOWS = 100;

// フォローしている人 (プロフィールを公開している人だけ) と、それぞれの今の記録
async function friendsOf(env, user, now = Date.now()) {
  const { results } = await env.DB.prepare(
    "SELECT u.* FROM follows f JOIN users u ON u.id = f.followee_id WHERE f.follower_id = ? AND u.public = 1 ORDER BY f.created_at LIMIT ?",
  ).bind(user.id, MAX_FOLLOWS).all();
  return Promise.all(results.map(async (u) => ({ u, s: await statsFor(env, u, now) })));
}

// フォロー / フォロー解除 (フォームの POST)。終わったら元のページに戻り、結果を ?friend= で伝える
async function follow(req, env, user) {
  const f = await req.formData();
  const login = String(f.get("login") || "").trim().replace(/^@/, "");
  const unfollow = f.get("action") === "unfollow";
  const back = (result) => {
    const u = new URL(safeNext(String(f.get("next") || "")), "https://x");
    u.searchParams.set("friend", result);
    u.searchParams.set("who", login.slice(0, 39));
    return redirect(`${u.pathname}${u.search}${u.pathname === `/@${user.login}` ? "#friends" : ""}`);
  };
  if (!/^[\w-]{1,39}$/.test(login)) return back("notfound");
  const target = await env.DB.prepare("SELECT id, public FROM users WHERE login = ?").bind(login).first();
  if (target?.id === user.id) return back("self");
  if (unfollow) {
    if (target) await env.DB.prepare("DELETE FROM follows WHERE follower_id = ? AND followee_id = ?").bind(user.id, target.id).run();
    return back("removed");
  }
  if (!target || !target.public) return back("notfound");
  const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM follows WHERE follower_id = ?").bind(user.id).first();
  if (n.n >= MAX_FOLLOWS) return back("full");
  await env.DB.prepare("INSERT OR IGNORE INTO follows (follower_id, followee_id, created_at) VALUES (?, ?, ?)").bind(user.id, target.id, Date.now()).run();
  return back("added");
}

// ---------- leagues ----------
const LEAGUE_TOOLS = ["claude", "codex"];
const boardOf = (u, tool) => `${tool}:${u[`${tool}_plan`] || "unknown"}`;

// 同期のたびに: 今週 (と、まだ確定していない先週) のリーグの XP を更新する。
// 今週はじめて XP が入ったら、前の週の結果で決まる段位の、空きのあるグループに入る。プロフィール非公開の人は参加しない
async function syncLeagues(env, user, now = Date.now()) {
  if (!user.public) return;
  const week = leagueWeek(now), prev = prevWeek(week);
  const [{ results: ws }, weekly, { results: mine }] = await Promise.all([
    env.DB.prepare("SELECT tool, hit_at, COALESCE(ended_at, reset_at) AS reset_at, resumed_at, ended_at FROM windows WHERE user_id = ? AND hit_at > ?").bind(user.id, prev.start - 2 * DAY).all(),
    userWeekly(env, user.id, 16),
    env.DB.prepare("SELECT m.*, g.settled FROM league_members m JOIN league_groups g ON g.id = m.group_id WHERE m.user_id = ? AND m.week >= ?").bind(user.id, prev.id).all(),
  ]);
  for (const tool of LEAGUE_TOOLS) {
    const s = computeStats(ws.filter((w) => w.tool === tool), { tz: user.tz, goal: user.goal, now, weekly: weekly.filter((w) => w.tool === tool), seed: user.id });
    const last = mine.find((m) => m.tool === tool && m.week === prev.id);
    if (last && !last.settled) await env.DB.prepare("UPDATE league_members SET xp = ? WHERE user_id = ? AND tool = ? AND week = ?").bind(leagueXp(s, prev), user.id, tool, prev.id).run();
    const xp = leagueXp(s, week);
    const cur = mine.find((m) => m.tool === tool && m.week === week.id);
    if (cur) {
      if (cur.xp !== xp) await env.DB.prepare("UPDATE league_members SET xp = ? WHERE user_id = ? AND tool = ? AND week = ?").bind(xp, user.id, tool, week.id).run();
    } else if (xp > 0) {
      await joinLeague(env, user, tool, week, xp, now);
    }
  }
}

async function joinLeague(env, user, tool, week, xp, now) {
  // 段位は、いちばん最近参加した週の結果で決まる (確定していなければここで確定させる)
  let prev = await env.DB.prepare("SELECT m.*, g.settled FROM league_members m JOIN league_groups g ON g.id = m.group_id WHERE m.user_id = ? AND m.tool = ? AND m.week < ? ORDER BY m.week DESC LIMIT 1")
    .bind(user.id, tool, week.id).first();
  if (prev && !prev.settled) {
    await settleGroup(env, prev.group_id, now);
    prev = await env.DB.prepare("SELECT * FROM league_members WHERE user_id = ? AND tool = ? AND week = ?").bind(user.id, tool, prev.week).first();
  }
  const tier = nextTier(prev), board = boardOf(user, tool);
  let g = await env.DB.prepare("SELECT id FROM league_groups WHERE week = ? AND board = ? AND tier = ? AND size < ? ORDER BY id LIMIT 1").bind(week.id, board, tier, LEAGUE_SIZE).first();
  g ??= await env.DB.prepare("INSERT INTO league_groups (week, board, tier) VALUES (?, ?, ?) RETURNING id").bind(week.id, board, tier).first();
  const r = await env.DB.prepare("INSERT OR IGNORE INTO league_members (user_id, tool, week, group_id, tier, xp, joined_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(user.id, tool, week.id, g.id, tier, xp, now).run();
  if (r.meta.changes) await env.DB.prepare("UPDATE league_groups SET size = size + 1 WHERE id = ?").bind(g.id).run();
}

// 週が終わったグループの順位と昇格/降格を確定し、結果を通知する
async function settleGroup(env, groupId, now = Date.now()) {
  const g = await env.DB.prepare("SELECT * FROM league_groups WHERE id = ?").bind(groupId).first();
  if (!g || g.settled) return;
  const { results: members } = await env.DB.prepare(
    "SELECT m.user_id, m.tool, m.xp, m.joined_at, u.lang, u.notify FROM league_members m JOIN users u ON u.id = m.user_id WHERE m.group_id = ?",
  ).bind(groupId).all();
  const out = settle(members, g.tier);
  const claimed = await env.DB.prepare("UPDATE league_groups SET settled = 1 WHERE id = ? AND settled = 0").bind(groupId).run();
  if (!claimed.meta.changes) return; // 別の処理が先に確定した
  await env.DB.batch(out.map((r) => env.DB.prepare("UPDATE league_members SET rank = ?, result = ? WHERE group_id = ? AND user_id = ?").bind(r.rank, r.result, groupId, r.user_id)));
  for (const r of out) {
    const m = members.find((x) => x.user_id === r.user_id);
    if (!parseNotify(m).league || !(await claim(env, m.user_id, `league:${m.tool}:${g.week}`))) continue;
    await pushToUser(env, m.user_id, notice(m, "league", null, now, { tool: m.tool, league: { ...r, tier: g.tier, n: members.length } }));
  }
}

const hasLeague = (mine, tool) => mine.some((m) => m.tool === tool);

// ダッシュボード用: 今週のリーグ (ツールごと) と、先週の結果
async function leaguesFor(env, user, now = Date.now()) {
  const week = leagueWeek(now), prev = prevWeek(week);
  const { results: mine } = await env.DB.prepare("SELECT * FROM league_members WHERE user_id = ? ORDER BY week DESC LIMIT 20").bind(user.id).all();
  const out = [];
  for (const tool of LEAGUE_TOOLS) {
    const cur = mine.find((m) => m.tool === tool && m.week === week.id);
    const last = mine.find((m) => m.tool === tool && m.week === prev.id);
    // 使っていないツールのリーグは出さない (今週・先週の参加か、PC から届いた課金プランがあれば使っているとみなす)
    if (!cur && !hasLeague(mine, tool) && !user[`${tool}_plan`]) continue;
    let members = [];
    // まだ今週参加していなければ、いちばん最近の結果から入る段位を出す
    const latest = mine.find((m) => m.tool === tool && m.week < week.id);
    let board = boardOf(user, tool), tier = nextTier(latest?.result ? latest : latest ? { tier: latest.tier } : null);
    if (cur) {
      const g = await env.DB.prepare("SELECT board, tier FROM league_groups WHERE id = ?").bind(cur.group_id).first();
      board = g.board; tier = g.tier;
      ({ results: members } = await env.DB.prepare(
        "SELECT m.user_id, m.xp, m.joined_at, u.login, u.avatar_url FROM league_members m JOIN users u ON u.id = m.user_id WHERE m.group_id = ?",
      ).bind(cur.group_id).all());
      members.sort(byStanding);
    }
    out.push({ tool, board, tier, joined: !!cur, members, zones: zones(members.length, tier), last: last?.result ? last : null });
  }
  return { week, leagues: out };
}

// 同じ通知を二度送らない。初めてなら true
async function claim(env, userId, key) {
  const r = await env.DB.prepare("INSERT OR IGNORE INTO sent (user_id, key, at) VALUES (?, ?, ?)").bind(userId, key, Date.now()).run();
  return r.meta.changes > 0;
}

async function pushToUser(env, userId, message) {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return 0;
  const { results } = await env.DB.prepare("SELECT * FROM push_subs WHERE user_id = ?").bind(userId).all();
  const vapid = { publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY, subject: env.VAPID_SUBJECT || "mailto:hello@ratelimit.world" };
  let sent = 0;
  for (const sub of results) {
    try {
      const r = await sendPush(sub, { url: "/me", ...message }, vapid);
      if (r.status === 404 || r.status === 410) await env.DB.prepare("DELETE FROM push_subs WHERE endpoint = ?").bind(sub.endpoint).run();
      else if (r.ok) sent++;
      else console.log("push failed", r.status, r.text.slice(0, 200));
    } catch (e) {
      console.log("push error", e.message);
    }
  }
  return sent;
}

// ---------- CLI からの送信 ----------
const TOOLS = new Set(["claude", "codex"]);
const isTime = (n) => Number.isFinite(n) && n > 1.5e12 && n < 4e12;

async function handleSync(req, env) {
  const user = await cliUser(req, env);
  if (!user) return json({ error: "unauthorized" }, 401);
  const body = await req.json().catch(() => null);
  if (!body || !Array.isArray(body.windows)) return json({ error: "bad request" }, 400);
  const now = Date.now();

  // 明らかにおかしいものは捨てる (到達からリセットまでは 5時間+α 以内、未来の到達はない)
  const incoming = body.windows.slice(0, 1000).filter((w) =>
    TOOLS.has(w.tool) && isTime(w.hitAt) && isTime(w.resetAt) && w.hitAt <= now + 5 * MIN &&
    w.resetAt > w.hitAt && w.resetAt - w.hitAt <= WINDOW_MS + 15 * MIN &&
    (w.resumedAt == null || (isTime(w.resumedAt) && w.resumedAt >= w.resetAt && w.resumedAt <= now + 5 * MIN)));

  // 「今使っている」合図 (hook の UserPromptSubmit) は、ログに残る前でも再開時刻として使う
  const active = {};
  for (const [tool, t] of Object.entries(body.active || {})) if (TOOLS.has(tool) && isTime(t) && t <= now + MIN) active[tool] = t;

  const existing = await userWindows(env, user.id, 70);
  const stmts = [];
  const added = [];
  for (const w of incoming) {
    // Codex のリセット時刻は数秒ぶれることがあるので、15分以内なら同じ枠とみなす
    const same = existing.find((e) => e.tool === w.tool && Math.abs(e.orig_reset_at - w.resetAt) < 15 * MIN);
    if (same) {
      const hit = Math.min(same.hit_at, w.hitAt);
      const resumed = same.resumed_at ?? w.resumedAt ?? null;
      if (hit !== same.hit_at || resumed !== same.resumed_at) {
        stmts.push(env.DB.prepare("UPDATE windows SET hit_at = ?, resumed_at = ? WHERE user_id = ? AND tool = ? AND reset_at = ?")
          .bind(hit, resumed, user.id, w.tool, same.orig_reset_at));
        same.hit_at = hit; same.resumed_at = resumed;
      }
    } else {
      stmts.push(env.DB.prepare("INSERT OR IGNORE INTO windows (user_id, tool, reset_at, hit_at, resumed_at) VALUES (?, ?, ?, ?, ?)")
        .bind(user.id, w.tool, w.resetAt, w.hitAt, w.resumedAt ?? null));
      const row = { tool: w.tool, reset_at: w.resetAt, orig_reset_at: w.resetAt, hit_at: w.hitAt, resumed_at: w.resumedAt ?? null };
      existing.push(row);
      added.push(row);
    }
  }
  for (const [tool, t] of Object.entries(active)) {
    for (const e of existing) {
      if (e.tool === tool && e.resumed_at == null && e.reset_at <= t && t - e.reset_at <= CHASE_MS) {
        stmts.push(env.DB.prepare("UPDATE windows SET resumed_at = ? WHERE user_id = ? AND tool = ? AND reset_at = ?").bind(t, user.id, tool, e.orig_reset_at));
        e.resumed_at = t;
      }
    }
  }

  // 週間リミットの到達
  const weeklyIn = (Array.isArray(body.weeklyHits) ? body.weeklyHits : []).slice(0, 100).filter((w) =>
    TOOLS.has(w.tool) && isTime(w.hitAt) && isTime(w.resetAt) && w.hitAt <= now + 5 * MIN && w.resetAt > w.hitAt && w.resetAt - w.hitAt <= 7 * DAY + HOUR);
  const weeklyOld = await userWeekly(env, user.id, 70);
  const weeklyAdded = [];
  for (const w of weeklyIn) {
    if (weeklyOld.some((e) => e.tool === w.tool && Math.abs(e.reset_at - w.resetAt) < 6 * HOUR)) continue;
    const row = { tool: w.tool, hit_at: w.hitAt, reset_at: w.resetAt };
    weeklyOld.push(row);
    weeklyAdded.push(row);
    stmts.push(env.DB.prepare("INSERT OR IGNORE INTO weekly_hits (user_id, tool, reset_at, hit_at) VALUES (?, ?, ?, ?)").bind(user.id, w.tool, w.resetAt, w.hitAt));
  }
  // 開けた枠。リセット時刻が 15分以内なら同じ枠とみなし、最大の使用率を更新する
  const sessIn = (Array.isArray(body.sessions) ? body.sessions : []).slice(0, 500).filter((o) =>
    TOOLS.has(o.tool) && isTime(o.startAt) && isTime(o.resetAt) && o.resetAt > o.startAt && o.resetAt - o.startAt <= WINDOW_MS + 15 * MIN && o.startAt <= now + MIN);
  if (sessIn.length) {
    const old = await userSessions(env, user.id, 70);
    for (const o of sessIn) {
      const peak = Number.isFinite(o.peakPct) ? Math.max(0, Math.min(100, o.peakPct)) : null;
      const same = old.find((e) => e.tool === o.tool && Math.abs(e.reset_at - o.resetAt) < 15 * MIN);
      if (same) {
        const p = peak == null ? same.peak_pct : Math.max(same.peak_pct ?? 0, peak);
        // 推定 → 正確な値が届いたら時刻も置き換える
        const useNew = o.exact && !same.exact;
        stmts.push(env.DB.prepare("UPDATE opened_windows SET peak_pct = ?, exact = ?, start_at = ? WHERE user_id = ? AND tool = ? AND reset_at = ?")
          .bind(p, same.exact || o.exact ? 1 : 0, useNew ? o.startAt : same.start_at, user.id, o.tool, same.reset_at));
        same.peak_pct = p;
      } else {
        stmts.push(env.DB.prepare("INSERT OR IGNORE INTO opened_windows (user_id, tool, reset_at, start_at, peak_pct, exact) VALUES (?, ?, ?, ?, ?, ?)")
          .bind(user.id, o.tool, o.resetAt, o.startAt, peak, o.exact ? 1 : 0));
        old.push({ tool: o.tool, reset_at: o.resetAt, start_at: o.startAt, peak_pct: peak, exact: o.exact ? 1 : 0 });
      }
    }
  }

  // タイムゾーンは設定画面で変えていなければ PC のものに合わせる
  const tz = user.tz === "UTC" && validTz(body.client?.tz) ? body.client.tz : user.tz;
  // 課金プラン (ランキングを分けるのに使う)。読めなかったときは前の値を残す
  const plan = (v, prev) => (typeof v === "string" && /^[a-z0-9_]{1,20}$/.test(v) ? v : prev);
  const claudePlan = plan(body.plans?.claude, user.claude_plan);
  const codexPlan = plan(body.plans?.codex, user.codex_plan);
  // 今の 5時間枠のリセット予定。届いたツールだけ上書きし、過ぎたものは捨てる
  let nextReset = {};
  try { nextReset = JSON.parse(user.next_reset || "{}"); } catch {}
  for (const tool of TOOLS) {
    const r = body.nextReset?.[tool];
    const pct = (x) => (Number.isFinite(x) ? Math.max(0, Math.min(100, x)) : null);
    if (r && isTime(r.resetAt) && r.resetAt > now && r.resetAt - now <= WINDOW_MS + 15 * MIN) {
      nextReset[tool] = { resetAt: r.resetAt, exact: !!r.exact, pct: pct(r.pct), at: isTime(r.at) ? r.at : null };
    }
    // 週間枠の使用率 (Codex のみ。ログに正確な値が書かれる)
    if (r?.week && isTime(r.week.resetAt) && r.week.resetAt > now && pct(r.week.pct) != null) {
      (nextReset[tool] ??= {}).week = { pct: pct(r.week.pct), resetAt: r.week.resetAt };
    }
    if (nextReset[tool] && !(nextReset[tool].resetAt > now)) { delete nextReset[tool].resetAt; delete nextReset[tool].pct; }
    if (nextReset[tool]?.week && !(nextReset[tool].week.resetAt > now)) delete nextReset[tool].week;
    if (nextReset[tool] && !Object.keys(nextReset[tool]).some((k) => k === "resetAt" || k === "week")) delete nextReset[tool];
    // リセットチケットなどで枠が予定より早く終わった: 新しい枠が始まったのは前の枠の予定リセットより前
    const cur = nextReset[tool];
    if (cur?.exact && cur.resetAt > now) {
      const newStart = cur.resetAt - WINDOW_MS;
      for (const e of existing) {
        if (e.tool !== tool || e.ended_at || !(e.hit_at < newStart && e.reset_at > newStart + MIN)) continue;
        stmts.push(env.DB.prepare("UPDATE windows SET ended_at = ?, resumed_at = COALESCE(resumed_at, ?) WHERE user_id = ? AND tool = ? AND reset_at = ?")
          .bind(newStart, newStart, user.id, tool, e.orig_reset_at));
        e.ended_at = newStart; e.reset_at = newStart; e.resumed_at ??= newStart;
      }
    }
  }
  // 「AI が書いた量」: 日付ごと・ツールごとの出力トークン数。CLI は毎回ログから数え直すので、大きい方を残す
  const outRows = [];
  if (body.output && typeof body.output === "object") {
    for (const [day, v] of Object.entries(body.output).slice(0, 80)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Math.abs(Date.parse(day) - now) > 72 * DAY) continue;
      for (const tool of TOOLS) {
        const n = Math.round(Number(v?.[tool]));
        if (Number.isFinite(n) && n > 0 && n < 1e10) outRows.push([day, tool, n]);
      }
    }
  }
  for (const [day, tool, n] of outRows) {
    stmts.push(env.DB.prepare("INSERT INTO output_days (user_id, day, tool, tokens) VALUES (?, ?, ?, ?) ON CONFLICT (user_id, day, tool) DO UPDATE SET tokens = MAX(tokens, excluded.tokens)")
      .bind(user.id, day, tool, n));
  }
  stmts.push(env.DB.prepare("UPDATE users SET tz = ?, claude_plan = ?, codex_plan = ?, next_reset = ?, last_sync_at = ? WHERE id = ?")
    .bind(tz, claudePlan, codexPlan, JSON.stringify(nextReset), now, user.id));
  await env.DB.batch(stmts);

  const fresh = { ...user, tz, next_reset: JSON.stringify(nextReset), claude_plan: claudePlan, codex_plan: codexPlan };
  const s = await statsFor(env, fresh, now);
  // リーグの XP の更新に失敗しても、同期そのものは成功として返す
  try { await syncLeagues(env, fresh, now); } catch (e) { console.log("league sync", e.message); }
  const prefs = parseNotify(fresh);
  // 週間リミットに当たったばかりなら、いちばん大きなごほうびを知らせる
  for (const w of weeklyAdded.filter((x) => now - x.hit_at < 60 * MIN)) {
    if ((await claim(env, user.id, `weekly:${w.tool}:${w.reset_at}`)) && prefs.hit) await pushToUser(env, user.id, notice(fresh, "weekly", s, now, { tool: w.tool, w }));
  }
  // たった今リミットに当たった枠があれば「n枠目」を知らせる (過去分の取り込みでは鳴らさない)
  const justHit = added.filter((w) => now - w.hit_at < 30 * MIN).sort((a, b) => b.hit_at - a.hit_at)[0];
  if (justHit && (await claim(env, user.id, `hit:${justHit.tool}:${justHit.reset_at}`))) {
    // 目標達成も同じ通知の中で伝えるので、goal 通知は送り済みにしておく
    if (s.todayDone) await claim(env, user.id, `goal:${s.today}`);
    if (prefs.hit) await pushToUser(env, user.id, notice(fresh, "hit", s, now, { tool: justHit.tool, w: justHit }));
  } else if (s.todayDone && prefs.goal && (await claim(env, user.id, `goal:${s.today}`))) {
    await pushToUser(env, user.id, notice(fresh, "goal", s, now));
  }
  return json({
    ok: true, accepted: incoming.length, today: s.todayCount, goal: s.goal, streak: s.streak, lang: user.lang ?? null, statusline: !!user.claude_statusline,
    // 自動ウォームアップの設定 (PC がリセット時刻に合わせて予約する)。quiet は 'HH:MM-HH:MM' (この時間帯は送らない)
    warmup: { on: !!user.warmup, quiet: user.warmup_quiet || null },
    // 正式なドメインに移ったら、PC の CLI に送り先を切り替えてもらう
    ...(env.CANONICAL_ORIGIN ? { server: env.CANONICAL_ORIGIN } : {}),
    // PC のステータスライン・メニューバー用 (PC 側が保存し、残り時間はその場で計算する)
    status: { streak: s.streak, today: s.todayCount, goal: s.goal, tools: { claude: toolStatus(s, "claude", now), codex: toolStatus(s, "codex", now) } },
  });
}

// ツールの今の状態 (ダイヤルと同じ考え方): weekly / limited / using / ready / idle
function toolStatus(s, tool, now) {
  const lock = s.weeklyLocks.find((w) => w.tool === tool);
  if (lock) return { state: "weekly", resetAt: lock.resetAt };
  const lim = s.tools[tool];
  if (lim?.state === "limited") return { state: "limited", resetAt: lim.resetAt, pct: 100 };
  const r = s.nextReset?.[tool];
  if (r?.resetAt > now) return { state: "using", resetAt: r.resetAt, pct: r.pct ?? null, exact: !!r.exact };
  const last = s.lastReset[tool];
  if (last && last.resumed_at == null && now - last.reset_at < 3 * HOUR) return { state: "ready", since: last.reset_at };
  return { state: "idle" };
}

// ---------- CLI ログイン (デバイスフロー) ----------
async function cliStart(req, env) {
  const body = await req.json().catch(() => ({}));
  const deviceCode = randomToken();
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const rnd = crypto.getRandomValues(new Uint8Array(8));
  const raw = [...rnd].map((b) => alphabet[b % alphabet.length]).join("");
  const userCode = `${raw.slice(0, 4)}-${raw.slice(4)}`;
  await env.DB.prepare("DELETE FROM cli_logins WHERE expires_at < ?").bind(Date.now()).run();
  await env.DB.prepare("INSERT INTO cli_logins (device_code, user_code, platform, expires_at) VALUES (?, ?, ?, ?)")
    .bind(deviceCode, userCode, String(body.platform || "").slice(0, 20), Date.now() + 10 * MIN).run();
  const origin = new URL(req.url).origin;
  return json({ deviceCode, userCode, verifyUrl: `${origin}/cli/verify?code=${userCode}` });
}

async function cliPoll(req, env) {
  const { deviceCode } = await req.json().catch(() => ({}));
  const row = await env.DB.prepare("SELECT c.*, u.login, u.lang FROM cli_logins c LEFT JOIN users u ON u.id = c.user_id WHERE device_code = ?").bind(deviceCode || "").first();
  if (!row) return json({ error: "invalid" }, 400);
  if (row.expires_at < Date.now()) return json({ error: "expired" }, 400);
  if (!row.token) return json({ pending: true });
  await env.DB.prepare("DELETE FROM cli_logins WHERE device_code = ?").bind(deviceCode).run();
  return json({ token: row.token, login: row.login, lang: row.lang });
}

async function cliVerify(req, env, ctx) {
  const { user, t } = ctx;
  const url = new URL(req.url);
  if (req.method === "GET") {
    return html(pages.cliVerify(ctx, url.searchParams.get("code") || ""));
  }
  if (!sameOrigin(req)) return html(pages.message(ctx, t("err.error"), t("err.forbidden")), 403);
  const form = await req.formData();
  const code = String(form.get("code") || "").toUpperCase().trim();
  const row = await env.DB.prepare("SELECT * FROM cli_logins WHERE user_code = ? AND expires_at > ? AND token IS NULL").bind(code, Date.now()).first();
  if (!row) return html(pages.message(ctx, t("err.code.title"), t("err.code.text")), 400);
  const token = `rw_${randomToken()}`;
  await env.DB.batch([
    env.DB.prepare("INSERT INTO cli_tokens (token_hash, user_id, platform, created_at) VALUES (?, ?, ?, ?)").bind(await sha256(token), user.id, row.platform, Date.now()),
    env.DB.prepare("UPDATE cli_logins SET user_id = ?, token = ? WHERE device_code = ?").bind(user.id, token, row.device_code),
  ]);
  return html(pages.message(ctx, t("cli.linked.title"), t("cli.linked.text"), user.onboarded_at ? "/me" : "/welcome", t(user.onboarded_at ? "cli.linked.toDash" : "cli.linked.toWelcome")));
}

// ---------- settings / push ----------
async function saveSettings(req, env, user) {
  const b = await req.json().catch(() => ({}));
  // Claude Code と Codex は別々の 5時間枠なので、両方使えば 1日 10枠まであり得る
  const goal = Math.min(10, Math.max(1, parseInt(b.goal ?? user.goal, 10) || user.goal));
  const tz = typeof b.tz === "string" && validTz(b.tz) ? b.tz : user.tz;
  const remindAt = /^([01]\d|2[0-3]):[0-5]\d$/.test(b.remindAt) ? b.remindAt : user.remind_at;
  const lead = LEAD_CHOICES.includes(+b.notifyLead) ? +b.notifyLead : user.notify_lead;
  const n = parseNotify(user);
  for (const k of Object.keys(n)) if (typeof b.notify?.[k] === "boolean") n[k] = b.notify[k];
  const pub = typeof b.public === "boolean" ? (b.public ? 1 : 0) : user.public;
  const lang = LANGS.includes(b.lang) ? b.lang : user.lang;
  const statusline = typeof b.statusline === "boolean" ? (b.statusline ? 1 : 0) : user.claude_statusline;
  const warmup = typeof b.warmup === "boolean" ? (b.warmup ? 1 : 0) : user.warmup;
  // しない時間帯: 開始と終了がどちらも時刻で、同じでなければ使う。空なら一日中
  const hm = /^([01]\d|2[0-3]):[0-5]\d$/;
  const quiet = b.warmupQuiet === undefined ? user.warmup_quiet
    : hm.test(b.warmupQuiet?.from) && hm.test(b.warmupQuiet?.to) && b.warmupQuiet.from !== b.warmupQuiet.to ? `${b.warmupQuiet.from}-${b.warmupQuiet.to}` : null;
  await env.DB.prepare("UPDATE users SET goal = ?, tz = ?, remind_at = ?, notify_lead = ?, notify = ?, public = ?, lang = ?, claude_statusline = ?, warmup = ?, warmup_quiet = ? WHERE id = ?")
    .bind(goal, tz, remindAt, lead, JSON.stringify(n), pub, lang, statusline, warmup, quiet, user.id).run();
  // 画面の言語も合わせる
  return json({ ok: true }, 200, lang ? { "set-cookie": langCookie(lang) } : {});
}

async function subscribe(req, env, user) {
  const b = await req.json().catch(() => ({}));
  const { endpoint, keys } = b.subscription || {};
  if (!/^https:\/\//.test(endpoint || "") || !keys?.p256dh || !keys?.auth) return json({ error: "bad subscription" }, 400);
  await env.DB.prepare("INSERT INTO push_subs (endpoint, user_id, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth")
    .bind(endpoint, user.id, keys.p256dh, keys.auth, Date.now()).run();
  return json({ ok: true });
}

// 出遅れで失ったもの: 時間と枠。1年あたりの見込みも出す
function lossSummary(ws, now = Date.now()) {
  let lostMin = 0, lostWindows = 0;
  for (const w of ws) {
    const d = delayOf(w);
    if (d == null) continue;
    lostMin += d / MIN;
    lostWindows += lostWindowsOf(d / MIN);
  }
  // 1年あたりに直す (記録のある期間で割る。短すぎると大げさになるので最低 14日とみなす)
  const first = ws.length ? Math.min(...ws.map((w) => w.hit_at)) : now;
  const spanDays = Math.min(60, Math.max(14, (now - first) / DAY));
  const perYear = 365 / spanDays;
  return {
    lostMin: Math.round(lostMin),
    lostWindows: Math.round(lostWindows * 10) / 10,
    year: { hours: Math.round((lostMin * perYear) / 60), windows: Math.round(lostWindows * perYear) },
  };
}

// プロフィール: 全期間の記録から、自己ベストや習慣を数え直す
async function profileData(env, u, now = Date.now()) {
  const [{ results: ws }, weekly, { results: opened }, sessions] = await Promise.all([
    env.DB.prepare("SELECT tool, hit_at, COALESCE(ended_at, reset_at) AS reset_at, resumed_at, ended_at FROM windows WHERE user_id = ? ORDER BY hit_at").bind(u.id).all(),
    userWeekly(env, u.id, 3650),
    env.DB.prepare("SELECT start_at FROM opened_windows WHERE user_id = ?").bind(u.id).all(),
    userSessions(env, u.id),
  ]);
  // 今の 5時間枠の使用率 (次の枠のマスに出す) は、ダッシュボードと同じく PC から届いた予定を使う
  let nextReset = {};
  try { nextReset = JSON.parse(u.next_reset || "{}"); } catch {}
  const s = { ...computeStats(ws, { tz: u.tz, goal: u.goal, now, weekly, sessions, seed: u.id }), nextReset };
  return { s, p: profileStats(ws, opened, s, { tz: u.tz, now }) };
}

// オンボーディングで「連携できた！」の瞬間に見せる要約
async function meSummary(env, user) {
  const { results: ws } = await env.DB.prepare("SELECT tool, hit_at, COALESCE(ended_at, reset_at) AS reset_at, resumed_at FROM windows WHERE user_id = ? AND hit_at > ?")
    .bind(user.id, Date.now() - 60 * DAY).all();
  const cli = await env.DB.prepare("SELECT COUNT(*) AS n FROM cli_tokens WHERE user_id = ?").bind(user.id).first();
  const delays = ws.map(delayOf).filter((d) => d != null);
  const s = await statsFor(env, user);
  // 「ふだんの1日」= 使った日の枠数の中央値。オンボーディングで目標の目安に使う
  const active = Object.values(s.days).map((d) => d.count).sort((a, b) => a - b);
  const typicalDay = active.length ? active[Math.floor((active.length - 1) / 2)] : 0;
  return {
    user: { login: user.login, tz: user.tz, goal: user.goal },
    linked: cli.n > 0,
    lastSyncAt: user.last_sync_at,
    history: {
      total: ws.length,
      claude: ws.filter((w) => w.tool === "claude").length,
      codex: ws.filter((w) => w.tool === "codex").length,
      avgLateMin: delays.length ? Math.round(delays.reduce((a, b) => a + b, 0) / delays.length / MIN) : null,
      lostMin: Math.round(delays.reduce((a, b) => a + b, 0) / MIN),
      bestDay: Math.max(s.bestDay, s.todayCount),
      typicalDay,
      activeDays: active.length,
      loss: lossSummary(ws),
    },
    plans: { claude: user.claude_plan, codex: user.codex_plan },
    stats: { streak: s.streak, todayCount: s.todayCount, goal: s.goal, xp: s.xp, weekXp: s.weekXp },
  };
}

// ---------- cron: 毎分 ----------
async function runCron(env, now = Date.now()) {
  // 0) もうすぐリセット: リミット中の枠が、各自が選んだ分数 (1〜15分) 以内にリセットされる
  const soon = await env.DB.prepare(
    `SELECT w.*, u.tz, u.goal, u.notify, u.lang, u.notify_lead FROM windows w JOIN users u ON u.id = w.user_id
     WHERE w.ended_at IS NULL AND w.reset_at > ? AND w.reset_at <= ? AND EXISTS (SELECT 1 FROM push_subs p WHERE p.user_id = w.user_id)`,
  ).bind(now + MIN, now + 15 * MIN).all();
  for (const w of soon.results) {
    if (!parseNotify(w).soon || w.reset_at - now > (w.notify_lead ?? 5) * MIN) continue;
    if (!(await claim(env, w.user_id, `soon:${w.tool}:${w.reset_at}`))) continue;
    const s = await statsFor(env, { id: w.user_id, tz: w.tz, goal: w.goal }, now);
    await pushToUser(env, w.user_id, notice(w, "soon", s, now, { tool: w.tool, w }));
  }

  // 0.5) リーグ: 週が終わったグループの順位を確定する
  const open = await env.DB.prepare("SELECT id FROM league_groups WHERE settled = 0 AND week < ? LIMIT 25").bind(leagueWeek(now).id).all();
  for (const g of open.results) {
    try { await settleGroup(env, g.id, now); } catch (e) { console.log("league settle", g.id, e.message); }
  }

  // 1) リセット通知: 直近 3分以内にリセットされた枠
  const due = await env.DB.prepare(
    `SELECT w.*, u.tz, u.goal, u.notify, u.lang FROM windows w JOIN users u ON u.id = w.user_id
     WHERE w.ended_at IS NULL AND w.reset_at > ? AND w.reset_at <= ? AND EXISTS (SELECT 1 FROM push_subs p WHERE p.user_id = w.user_id)`,
  ).bind(now - 3 * MIN, now).all();
  for (const w of due.results) {
    if (!parseNotify(w).reset) continue;
    if (!(await claim(env, w.user_id, `reset:${w.tool}:${w.reset_at}`))) continue;
    const s = await statsFor(env, { id: w.user_id, tz: w.tz, goal: w.goal }, now);
    await pushToUser(env, w.user_id, notice(w, "reset", s, now, { tool: w.tool }));
  }

  // 2) 出遅れ通知: リセットから 10分たっても再開していない枠
  const late = await env.DB.prepare(
    `SELECT w.*, u.tz, u.goal, u.notify, u.lang FROM windows w JOIN users u ON u.id = w.user_id
     WHERE w.ended_at IS NULL AND w.resumed_at IS NULL AND w.reset_at > ? AND w.reset_at <= ? AND EXISTS (SELECT 1 FROM push_subs p WHERE p.user_id = w.user_id)`,
  ).bind(now - LATE_AFTER - 5 * MIN, now - LATE_AFTER).all();
  for (const w of late.results) {
    if (!parseNotify(w).late) continue;
    if (!(await claim(env, w.user_id, `late:${w.tool}:${w.reset_at}`))) continue;
    const s = await statsFor(env, { id: w.user_id, tz: w.tz, goal: w.goal }, now);
    await pushToUser(env, w.user_id, notice(w, "late", s, now, { tool: w.tool, minutes: Math.round((now - w.reset_at) / MIN) }));
  }

  // 3) ピンチ通知: 各自の remind_at (現地時刻) から 10分以内で、今日まだ目標未達
  const users = await env.DB.prepare(
    "SELECT u.* FROM users u WHERE EXISTS (SELECT 1 FROM push_subs p WHERE p.user_id = u.id)",
  ).all();
  for (const u of users.results) {
    const t = localTime(now, u.tz);
    const [h, m] = u.remind_at.split(":").map(Number);
    const [th, tm] = t.split(":").map(Number);
    const diff = th * 60 + tm - (h * 60 + m);
    if (diff < 0 || diff >= 10 || !parseNotify(u).pinch) continue;
    const day = dayKey(now, u.tz);
    const s = await statsFor(env, u, now);
    // 達成済み、または週間リミット中 (今日は自動で守られる) なら催促しない
    if (s.todayDone || s.weeklyLocks.length) continue;
    if (!(await claim(env, u.id, `pinch:${day}`))) continue;
    await pushToUser(env, u.id, notice(u, "pinch", s, now));
  }

  // 古い記録の掃除 (1日 1回で十分なので 0分台だけ)
  if (new Date(now).getUTCMinutes() === 0) {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM sent WHERE at < ?").bind(now - 14 * DAY),
      env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(now),
      env.DB.prepare("DELETE FROM cli_logins WHERE expires_at < ?").bind(now),
    ]);
  }
}

// ---------- install script ----------
function installScript(origin) {
  return `#!/bin/sh
# ratelimit.world setup: put the CLI in ~/.ratelimit-world and log in
set -e
case "\${LC_ALL:-\${LANG:-}}" in ja*) NEED="Node.js 18 以上が必要です" ;; *) NEED="Node.js 18 or later is required" ;; esac
command -v node >/dev/null 2>&1 || { echo "$NEED: https://nodejs.org" >&2; exit 1; }
mkdir -p "$HOME/.ratelimit-world"
curl -fsSL "${origin}/cli.mjs" -o "$HOME/.ratelimit-world/ratelimit-world.mjs"
# setup needs no input; use /dev/null so it never reads the rest of this piped script
node "$HOME/.ratelimit-world/ratelimit-world.mjs" setup --server "${origin}" < /dev/null
`;
}

// ---------- router ----------
async function route(req, env) {
  const url = new URL(req.url);
  const p = url.pathname;
  const m = req.method;
  const origin = url.origin;

  // 正式なドメイン (CANONICAL_ORIGIN) ができたら、古いアドレス (workers.dev) で開いたページはそちらへ移す。
  // PC の CLI が使う API とインストール用のファイル、ログインの途中 (/auth/) は古いアドレスのままでも動かす
  const canonical = env.CANONICAL_ORIGIN;
  if (canonical && origin !== canonical && (m === "GET" || m === "HEAD") && !/^\/(api|auth)\//.test(p) && p !== "/install.sh") {
    return redirect(canonical + p + url.search, {}, 301);
  }

  if (p === "/api/sync" && m === "POST") return handleSync(req, env);
  if (p === "/api/cli/start" && m === "POST") return cliStart(req, env);
  if (p === "/api/cli/poll" && m === "POST") return cliPoll(req, env);
  if (p === "/install.sh") return new Response(installScript(origin), { headers: { "content-type": "text/plain; charset=utf-8" } });

  if (p === "/login") {
    if (env.DEV_LOGIN === "1" && !env.GITHUB_CLIENT_ID) return html(pages.devLogin(makeCtx(req, null), url.searchParams.get("next") || "/me"));
    return githubLogin(req, env);
  }
  if (p === "/auth/github/callback") return githubCallback(req, env);
  if (p === "/dev/login" && env.DEV_LOGIN === "1") {
    const login = (url.searchParams.get("login") || "dev").replace(/[^\w-]/g, "").slice(0, 39) || "dev";
    const user = await upsertUser(env, { login, name: login, lang: pickLang(req, null) });
    return startSession(env, user.id, safeNext(url.searchParams.get("next")));
  }

  const user = await currentUser(req, env);
  const ctx = makeCtx(req, user);

  // 言語の切り替え: cookie に覚え、ログイン中ならスマホ通知の言語も変える
  const langSwitch = p.match(/^\/lang\/(ja|en)$/);
  if (langSwitch) {
    const next = url.searchParams.get("next") || "/";
    if (user) await env.DB.prepare("UPDATE users SET lang = ? WHERE id = ?").bind(langSwitch[1], user.id).run();
    return redirect(/^\/(?![/\\])/.test(next) ? next : "/", { "set-cookie": langCookie(langSwitch[1]) });
  }

  if (p === "/logout" && m === "POST") {
    const t = getCookie(req, SESSION_COOKIE);
    if (t) await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256(t)).run();
    return redirect("/", { "set-cookie": cookie(SESSION_COOKIE, "", 0) });
  }

  if (p === "/") {
    return html(pages.landing(ctx, origin));
  }
  // ランキングはリーグに置きかえた
  if (p === "/leaderboard") return redirect(user ? "/me" : "/", {}, 301);

  const prof = p.match(/^\/@([\w-]{1,39})(\/card\.(?:svg|png))?$/);
  if (prof) {
    const u = await env.DB.prepare("SELECT * FROM users WHERE login = ?").bind(prof[1]).first();
    const visible = u && (u.public || user?.id === u.id);
    if (prof[2]) {
      if (!visible) return new Response("not found", { status: 404 });
      // シェアカードは ?lang= で言語を選べる (SNS のクローラーは cookie を持たないため)
      const cl = LANGS.includes(url.searchParams.get("lang")) ? url.searchParams.get("lang") : u.lang || ctx.lang;
      const lg = await env.DB.prepare("SELECT tier FROM league_members WHERE user_id = ? ORDER BY week DESC LIMIT 1").bind(u.id).first();
      const svg = pages.card({ ...ctx, lang: cl, t: tr(cl) }, u, await statsFor(env, u), { avatar: await avatarData(u.avatar_url), league: u.public ? lg : null });
      if (prof[2].endsWith(".svg")) return new Response(svg, { headers: { "content-type": "image/svg+xml; charset=utf-8", "cache-control": "public, max-age=300" } });
      return new Response(await svgToPng(svg), { headers: { "content-type": "image/png", "cache-control": "public, max-age=300" } });
    }
    if (!visible) return html(pages.message(ctx, ctx.t("err.profile.title"), ctx.t("err.profile.text")), 404);
    const [followers, following] = await Promise.all([
      env.DB.prepare("SELECT COUNT(*) AS n FROM follows WHERE followee_id = ?").bind(u.id).first(),
      user && user.id !== u.id ? env.DB.prepare("SELECT 1 AS y FROM follows WHERE follower_id = ? AND followee_id = ?").bind(user.id, u.id).first() : null,
    ]);
    // 今いるリーグ (今週まだ参加していなければ、いちばん最近の週)
    const { results: lg } = await env.DB.prepare(
      "SELECT tool, tier, MAX(week) AS week FROM league_members WHERE user_id = ? GROUP BY tool",
    ).bind(u.id).all();
    const self = user?.id === u.id;
    const social = {
      followers: followers.n, following: !!following, flash: url.searchParams.get("friend"), leagues: u.public ? lg : [],
      // 自分のプロフィールには、フレンドの一覧とフォローの入力欄を出す
      ...(self ? { friends: await friendsOf(env, u), friendFlash: { kind: url.searchParams.get("friend"), who: url.searchParams.get("who") } } : {}),
    };
    const [{ s, p: ps }, written] = await Promise.all([profileData(env, u), writtenTotal(env, u.id)]);
    return html(pages.profile(ctx, u, s, origin, { ...social, ps, written }));
  }

  // ここから先はログインが必要
  if (p === "/follow" && m === "POST") {
    if (!user) return redirect("/login?next=/me");
    if (!sameOrigin(req)) return json({ error: "forbidden" }, 403);
    return follow(req, env, user);
  }
  if (p === "/cli/verify") {
    if (!user) return redirect(`/login?next=${encodeURIComponent(p + url.search)}`);
    return cliVerify(req, env, ctx);
  }
  if (p === "/welcome") {
    if (!user) return redirect("/login?next=/welcome");
    return html(pages.welcome(ctx, { origin, vapidKey: env.VAPID_PUBLIC_KEY || "" }));
  }
  if (p === "/me") {
    if (!user) return redirect("/login?next=/me");
    if (!user.onboarded_at) return redirect("/welcome");
    const hasCli = await env.DB.prepare("SELECT COUNT(*) AS n FROM cli_tokens WHERE user_id = ?").bind(user.id).first();
    try { await syncLeagues(env, user); } catch (e) { console.log("league sync", e.message); }
    const [s, friends, leagues, push] = await Promise.all([
      statsFor(env, user), friendsOf(env, user), leaguesFor(env, user),
      env.DB.prepare("SELECT COUNT(*) AS n FROM push_subs WHERE user_id = ?").bind(user.id).first(),
    ]);
    return html(pages.dashboard(ctx, s, { origin, vapidKey: env.VAPID_PUBLIC_KEY || "", hasCli: hasCli.n > 0, hasPush: push.n > 0, friends, leagues }));
  }
  if (p === "/settings") {
    if (!user) return redirect("/login?next=/settings");
    const hasCli = await env.DB.prepare("SELECT COUNT(*) AS n FROM cli_tokens WHERE user_id = ?").bind(user.id).first();
    return html(pages.settingsPage(ctx, { origin, vapidKey: env.VAPID_PUBLIC_KEY || "", hasCli: hasCli.n > 0, notify: parseNotify(user) }));
  }
  if (p.startsWith("/api/")) {
    if (!user) return json({ error: "unauthorized" }, 401);
    if (m === "POST" && !sameOrigin(req)) return json({ error: "forbidden" }, 403);
    if (p === "/api/me" && m === "GET") return json(await meSummary(env, user));
    if (p === "/api/onboarded" && m === "POST") {
      await env.DB.prepare("UPDATE users SET onboarded_at = COALESCE(onboarded_at, ?) WHERE id = ?").bind(Date.now(), user.id).run();
      return json({ ok: true });
    }
    if (p === "/api/settings" && m === "POST") return saveSettings(req, env, user);
    if (p === "/api/push/subscribe" && m === "POST") return subscribe(req, env, user);
    if (p === "/api/push/unsubscribe" && m === "POST") {
      const b = await req.json().catch(() => ({}));
      await env.DB.prepare("DELETE FROM push_subs WHERE endpoint = ? AND user_id = ?").bind(b.endpoint || "", user.id).run();
      return json({ ok: true });
    }
    if (p === "/api/push/test" && m === "POST") {
      const n = await pushToUser(env, user.id, notice({ lang: ctx.lang }, "test", null, Date.now()));
      return json({ ok: n > 0, sent: n });
    }
  }
  return null;
}

export default {
  async fetch(req, env) {
    try {
      const res = await route(req, env);
      if (res) return res;
      // 静的ファイル (sw.js, app.js など) は assets が先に返すので、ここに来るのは見つからないものだけ
      const ctx = makeCtx(req, null);
      return html(pages.message(ctx, ctx.t("err.notfound.title"), ""), 404);
    } catch (e) {
      console.log("error", e.stack || e.message);
      return json({ error: "internal error" }, 500);
    }
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runCron(env, event.scheduledTime));
  },
};

export { runCron };
