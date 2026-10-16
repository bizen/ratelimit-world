// ratelimit.world: Cloudflare Worker (API + ページ + 毎分の通知 Cron)
import { computeStats, validTz, localTime, dayKey, delayOf, MIN, HOUR, DAY, WINDOW_MS, CHASE_MS } from "./logic.js";
import { sendPush, b64u } from "./webpush.js";
import { pickLang, tr, LANGS } from "./i18n.js";
import { notice } from "./notice.js";
import { costOf, lostWindowsOf, PRICING_AS_OF } from "./pricing.js";
import * as pages from "./pages.js";

const SESSION_COOKIE = "rw_session";
const SESSION_DAYS = 90;
const STATS_DAYS = 120;    // ストリーク計算に読む期間
const LATE_AFTER = 10 * MIN;

// ---------- small helpers ----------
const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", ...headers } });
const html = (body, status = 200, headers = {}) =>
  new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", ...headers } });
const redirect = (to, headers = {}) => new Response(null, { status: 302, headers: { location: to, ...headers } });

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

const NOTIFY_DEFAULTS = { hit: true, soon: true, reset: true, late: true, pinch: true, goal: true };
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
  return { ...computeStats(ws, { tz: user.tz, goal: user.goal, now, weekly, sessions }), nextReset };
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

  // トークン数 (API 料金換算に使う)。形がおかしいものは捨てる
  const cleanTokens = (t) => {
    if (!t || typeof t !== "object") return null;
    const out = {};
    for (const [model, a] of Object.entries(t).slice(0, 10)) {
      if (/^[\w.:<>-]{1,60}$/.test(model) && Array.isArray(a) && a.length === 5 && a.every((n) => Number.isFinite(n) && n >= 0 && n < 1e11)) out[model] = a.map(Math.round);
    }
    return Object.keys(out).length ? JSON.stringify(out) : null;
  };

  // 「今使っている」合図 (hook の UserPromptSubmit) は、ログに残る前でも再開時刻として使う
  const active = {};
  for (const [tool, t] of Object.entries(body.active || {})) if (TOOLS.has(tool) && isTime(t) && t <= now + MIN) active[tool] = t;

  const existing = await userWindows(env, user.id, 70);
  const stmts = [];
  const added = [];
  for (const w of incoming) {
    // Codex のリセット時刻は数秒ぶれることがあるので、15分以内なら同じ枠とみなす
    const same = existing.find((e) => e.tool === w.tool && Math.abs(e.orig_reset_at - w.resetAt) < 15 * MIN);
    const tokens = cleanTokens(w.tokens);
    if (same) {
      const hit = Math.min(same.hit_at, w.hitAt);
      const resumed = same.resumed_at ?? w.resumedAt ?? null;
      if (hit !== same.hit_at || resumed !== same.resumed_at || tokens) {
        // トークン数は新しい送信のほうがログを多く読めているので上書きする
        stmts.push(env.DB.prepare("UPDATE windows SET hit_at = ?, resumed_at = ?, tokens = COALESCE(?, tokens) WHERE user_id = ? AND tool = ? AND reset_at = ?")
          .bind(hit, resumed, tokens, user.id, w.tool, same.orig_reset_at));
        same.hit_at = hit; same.resumed_at = resumed;
      }
    } else {
      stmts.push(env.DB.prepare("INSERT OR IGNORE INTO windows (user_id, tool, reset_at, hit_at, resumed_at, tokens) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(user.id, w.tool, w.resetAt, w.hitAt, w.resumedAt ?? null, tokens));
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
  stmts.push(env.DB.prepare("UPDATE users SET tz = ?, claude_plan = ?, codex_plan = ?, next_reset = ?, last_sync_at = ? WHERE id = ?")
    .bind(tz, claudePlan, codexPlan, JSON.stringify(nextReset), now, user.id));
  await env.DB.batch(stmts);

  const fresh = { ...user, tz };
  const s = await statsFor(env, fresh, now);
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
  return json({ ok: true, accepted: incoming.length, today: s.todayCount, goal: s.goal, streak: s.streak, lang: user.lang ?? null, statusline: !!user.claude_statusline });
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
  const tz = validTz(b.tz) ? b.tz : user.tz;
  const remindAt = /^([01]\d|2[0-3]):[0-5]\d$/.test(b.remindAt) ? b.remindAt : user.remind_at;
  const lead = LEAD_CHOICES.includes(+b.notifyLead) ? +b.notifyLead : user.notify_lead;
  const n = parseNotify(user);
  for (const k of Object.keys(n)) if (typeof b.notify?.[k] === "boolean") n[k] = b.notify[k];
  const pub = typeof b.public === "boolean" ? (b.public ? 1 : 0) : user.public;
  const lang = LANGS.includes(b.lang) ? b.lang : user.lang;
  const statusline = typeof b.statusline === "boolean" ? (b.statusline ? 1 : 0) : user.claude_statusline;
  await env.DB.prepare("UPDATE users SET goal = ?, tz = ?, remind_at = ?, notify_lead = ?, notify = ?, public = ?, lang = ?, claude_statusline = ? WHERE id = ?")
    .bind(goal, tz, remindAt, lead, JSON.stringify(n), pub, lang, statusline, user.id).run();
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

// 出遅れで失ったもの: 時間・枠・API 料金換算。1年あたりの見込みも出す
function lossSummary(ws, now = Date.now()) {
  // ツールごとに「使い切った 1枠は API 料金でいくら分か」の平均を出す
  const perTool = {};
  let estimated = false, valueUsd = 0;
  for (const w of ws) {
    let t = null;
    try { t = w.tokens ? JSON.parse(w.tokens) : null; } catch {}
    if (!t) continue;
    const c = costOf(w.tool, t);
    const a = (perTool[w.tool] ??= { usd: 0, n: 0 });
    a.usd += c.usd; a.n++;
    valueUsd += c.usd;
    estimated ||= c.estimated;
  }
  const avg = (tool) => (perTool[tool]?.n ? perTool[tool].usd / perTool[tool].n : null);
  let lostMin = 0, lostWindows = 0, lostUsd = 0;
  for (const w of ws) {
    const d = delayOf(w);
    if (d == null) continue;
    const m = d / MIN;
    lostMin += m;
    lostWindows += lostWindowsOf(m);
    lostUsd += lostWindowsOf(m) * (avg(w.tool) ?? 0);
  }
  // 1年あたりに直す (記録のある期間で割る。短すぎると大げさになるので最低 14日とみなす)
  const first = ws.length ? Math.min(...ws.map((w) => w.hit_at)) : now;
  const spanDays = Math.min(60, Math.max(14, (now - first) / DAY));
  const perYear = 365 / spanDays;
  return {
    lostMin: Math.round(lostMin),
    lostWindows: Math.round(lostWindows * 10) / 10,
    lostUsd: Math.round(lostUsd),
    valueUsd: Math.round(valueUsd),
    avgWindowUsd: { claude: avg("claude") && Math.round(avg("claude")), codex: avg("codex") && Math.round(avg("codex")) },
    year: { hours: Math.round((lostMin * perYear) / 60), windows: Math.round(lostWindows * perYear), usd: Math.round(lostUsd * perYear) },
    priced: Object.keys(perTool).length > 0,
    estimated,
    pricingAsOf: PRICING_AS_OF,
  };
}

// オンボーディングで「連携できた！」の瞬間に見せる要約
async function meSummary(env, user) {
  const { results: ws } = await env.DB.prepare("SELECT tool, hit_at, COALESCE(ended_at, reset_at) AS reset_at, resumed_at, tokens FROM windows WHERE user_id = ? AND hit_at > ?")
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

// ---------- pages data ----------
// ランキングはツール×課金プランごと (Pro と Max では 1枠の重さがまるで違うので混ぜない)。
// 両方使う人は両方のボードに出て、それぞれそのツールの枠だけで数える。
async function leaderboards(env, now = Date.now()) {
  const { results } = await env.DB.prepare(
    `SELECT u.id, u.login, u.name, u.avatar_url, u.tz, u.goal, u.claude_plan, u.codex_plan FROM users u
     WHERE u.public = 1 AND (EXISTS (SELECT 1 FROM windows w WHERE w.user_id = u.id AND w.hit_at > ?)
       OR EXISTS (SELECT 1 FROM weekly_hits h WHERE h.user_id = u.id AND h.hit_at > ?))`,
  ).bind(now - 8 * DAY, now - 8 * DAY).all();
  const boards = {};
  for (const u of results) {
    const [all, allWeekly] = await Promise.all([userWindows(env, u.id), userWeekly(env, u.id)]);
    for (const tool of ["claude", "codex"]) {
      const ws = all.filter((w) => w.tool === tool);
      const weekly = allWeekly.filter((w) => w.tool === tool);
      if (!ws.length && !weekly.length) continue;
      const s = computeStats(ws, { tz: u.tz, goal: u.goal, now, weekly });
      if (s.weekXp <= 0) continue;
      const key = `${tool}:${u[`${tool}_plan`] || "unknown"}`;
      (boards[key] ??= []).push({ ...u, weekXp: s.weekXp, weekWindows: Object.entries(s.days).filter(([k]) => k >= s.week).reduce((n, [, d]) => n + d.count, 0) });
    }
  }
  for (const k of Object.keys(boards)) boards[k] = boards[k].sort((a, b) => b.weekXp - a.weekXp).slice(0, 100);
  return boards;
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
  if (p === "/leaderboard") return html(pages.leaderboard(ctx, await leaderboards(env), url.searchParams.get("board")));

  const prof = p.match(/^\/@([\w-]{1,39})(\/card\.svg)?$/);
  if (prof) {
    const u = await env.DB.prepare("SELECT * FROM users WHERE login = ?").bind(prof[1]).first();
    const visible = u && (u.public || user?.id === u.id);
    if (prof[2]) {
      if (!visible) return new Response("not found", { status: 404 });
      // シェアカードは ?lang= で言語を選べる (SNS のクローラーは cookie を持たないため)
      const cl = LANGS.includes(url.searchParams.get("lang")) ? url.searchParams.get("lang") : u.lang || ctx.lang;
      return new Response(pages.card({ ...ctx, lang: cl, t: tr(cl) }, u, await statsFor(env, u)), { headers: { "content-type": "image/svg+xml; charset=utf-8", "cache-control": "public, max-age=300" } });
    }
    if (!visible) return html(pages.message(ctx, ctx.t("err.profile.title"), ctx.t("err.profile.text")), 404);
    return html(pages.profile(ctx, u, await statsFor(env, u), origin));
  }

  // ここから先はログインが必要
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
    return html(pages.dashboard(ctx, await statsFor(env, user), { origin, vapidKey: env.VAPID_PUBLIC_KEY || "", hasCli: hasCli.n > 0, notify: parseNotify(user) }));
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
