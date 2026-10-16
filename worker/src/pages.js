// サーバーで組み立てる HTML。見た目は public/style.css、動きは public/app.js
import { TOOL_NAME, addDays, localTime, WINDOW_MS } from "./logic.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function layout({ title, user, body, head = "", bodyClass = "" }) {
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(title)}</title>
<meta name="theme-color" content="#5B4BFF">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="icon" href="/icon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/icon-192.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Dela+Gothic+One&family=JetBrains+Mono:wght@500;700&family=Zen+Maru+Gothic:wght@500;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/style.css">
${head}
</head>
<body class="${bodyClass}">
<header class="top">
  <a class="brand" href="/">ratelimit<span>.world</span></a>
  <nav>
    <a href="/leaderboard">ランキング</a>
    ${user ? `<a class="me" href="/me">${user.avatar_url ? `<img src="${esc(user.avatar_url)}" alt="">` : ""}@${esc(user.login)}</a>` : `<a class="btn small" href="/login">ログイン</a>`}
  </nav>
</header>
<main>${body}</main>
<script src="/app.js" defer></script>
</body>
</html>`;
}

export function message(title, text, href, label) {
  return layout({
    title: `${title} · ratelimit.world`,
    body: `<section class="card narrow center"><h1 class="h2">${esc(title)}</h1><p>${esc(text)}</p>${href ? `<p><a class="btn" href="${esc(href)}">${esc(label)}</a></p>` : ""}</section>`,
  });
}

export function devLogin(next) {
  return layout({
    title: "開発用ログイン",
    body: `<section class="card narrow"><h1 class="h2">開発用ログイン</h1>
<p class="muted">GITHUB_CLIENT_ID が未設定なので、名前だけでログインします（DEV_LOGIN=1 のときだけ）。</p>
<form action="/dev/login" method="get" class="row"><input name="login" value="dev" aria-label="ユーザー名"><input type="hidden" name="next" value="${esc(next)}"><button class="btn">ログイン</button></form></section>`,
  });
}

// ---------- landing ----------
// 1日の枠を 24時間の帯で描く。starts は開始時刻 (時間)。
function dayBar(starts, cls) {
  const blocks = starts.map((h, i) => {
    const left = (h / 24) * 100;
    const width = Math.min(5, 24 - h) / 24 * 100;
    const label = `${Math.floor(h)}:${String(Math.round((h % 1) * 60)).padStart(2, "0")}`;
    return `<div class="blk ${h + 5 > 24 ? "spill" : ""}" style="left:${left}%;width:${width}%"><span>${i + 1}</span><em>${label}</em></div>`;
  }).join("");
  return `<div class="bar ${cls}">${blocks}</div>`;
}

export function landing(user, origin) {
  const ticks = [0, 6, 12, 18, 24].map((h) => `<span style="left:${(h / 24) * 100}%">${h}時</span>`).join("");
  return layout({
    title: "ratelimit.world — 限界（レートリミット）を越えよう",
    user,
    bodyClass: "landing",
    body: `
<section class="hero">
  <p class="eyebrow">Claude Code · Codex の 5時間枠</p>
  <h1 class="display"><ruby>限界<rt>レートリミット</rt></ruby>を越えよう。</h1>
  <p class="lead">5時間枠は「リセット後に最初に使った時刻」から数え直されます。再開が30分遅れると、次のリセットも30分遅れる。その遅れは1日のあいだ積み重なっていきます。</p>

  <figure class="compare">
    <div class="lane">
      <p class="lane-name">リセットと同時に再開</p>
      ${dayBar([8, 13, 18, 23], "good")}
      <p class="lane-sum"><b>4</b> 枠</p>
    </div>
    <div class="lane">
      <p class="lane-name">毎回30分ずつ出遅れ</p>
      ${dayBar([8, 13.5, 19], "bad")}
      <p class="lane-sum"><b>3</b> 枠</p>
    </div>
    <div class="axis">${ticks}</div>
    <figcaption>朝8時に始めた場合。30分の出遅れが3回たまると、その日の枠が1つ消えます。</figcaption>
  </figure>

  <div class="cta">
    ${user ? `<a class="btn big" href="/me">ダッシュボードを開く</a>` : `<a class="btn big" href="/login">GitHub で始める</a>`}
    <a class="btn ghost" href="/leaderboard">今週のランキング</a>
  </div>
</section>

<section class="how">
  <div class="how-item">
    <h2 class="h3">PC では、いつもどおり使うだけ</h2>
    <p>最初に1回だけコマンドを実行すると、Claude Code の hooks と Codex の notify に登録されます。リミットに当たった瞬間に、リセット時刻だけを送ります。プロンプトやコードは送りません。</p>
    <pre class="cmd"><code>curl -fsSL ${esc(origin)}/install.sh | sh</code></pre>
  </div>
  <div class="how-item">
    <h2 class="h3">リセットの瞬間に、スマホが鳴る</h2>
    <p>通知はサーバーから送るので、PC がスリープしていても届きます。リセットから10分たっても再開していなければ、もう一度声をかけます。</p>
  </div>
  <div class="how-item">
    <h2 class="h3">ストリークで続ける</h2>
    <p>1日の目標回数（はじめは2回）を達成すると🔥が1つ伸びます。7日続けるとフリーズ🧊がもらえて、うっかり休んだ日を1回だけ守ってくれます。</p>
  </div>
</section>`,
  });
}

// ---------- dashboard ----------
function pips(count, goal, max = 5) {
  const n = Math.max(goal, Math.min(max, count), 1);
  let out = "";
  for (let i = 0; i < n; i++) out += `<i class="pip ${i < count ? "on" : ""} ${i >= goal ? "extra" : ""}"></i>`;
  if (count > max) out += `<b class="pip-more">+${count - max}</b>`;
  return out;
}

function heatmap(s, days = 28) {
  let cells = "";
  for (let i = days - 1; i >= 0; i--) {
    const k = addDays(s.today, -i);
    const d = s.days[k];
    const c = d?.count ?? 0;
    const frozen = s.frozenDays.includes(k);
    const lvl = frozen ? "frozen" : c === 0 ? "l0" : c < s.goal ? "l1" : c === s.goal ? "l2" : "l3";
    const label = `${k}: ${frozen ? "フリーズで守った日" : `${c}回`}`;
    cells += `<i class="cell ${lvl} ${i === 0 ? "today" : ""}" title="${label}" aria-label="${label}"></i>`;
  }
  return `<div class="heat" role="img" aria-label="直近${days}日の到達回数">${cells}</div>`;
}

// ツールごとの「次のリセット」ダイヤル
function dial(tool, s, now) {
  const t = s.tools[tool];
  const codex = tool === "codex" ? s.codex : null;
  const last = s.lastReset[tool];
  let state, resetAt = null, frac = 0, sub;
  if (t?.state === "limited") {
    state = "limited";
    resetAt = t.resetAt;
    frac = Math.min(1, Math.max(0, (t.resetAt - now) / WINDOW_MS));
    sub = `${localTime(t.resetAt, s.tz)} にリセット`;
  } else if (codex && codex.resetAt > now && codex.at > (last?.reset_at ?? 0)) {
    state = "using";
    resetAt = codex.resetAt;
    frac = Math.min(1, codex.usedPercent / 100);
    sub = `${Math.round(codex.usedPercent)}% 使用 · ${localTime(codex.resetAt, s.tz)} にリセット`;
  } else if (last && last.resumed_at == null && now - last.reset_at < 3 * 3600 * 1000) {
    state = "ready";
    sub = `${localTime(last.reset_at, s.tz)} にリセット済み`;
  } else {
    state = "idle";
    sub = "リミットに当たるとここに出ます";
  }
  const R = 52, C = 2 * Math.PI * R;
  const label = { limited: "リセットまで", using: "使用中", ready: "今すぐ再開！", idle: "待機中" }[state];
  return `
<article class="dial ${state}" data-tool="${tool}" ${resetAt ? `data-reset="${resetAt}"` : ""} ${state === "ready" ? `data-since="${last.reset_at}"` : ""}>
  <h3>${TOOL_NAME[tool]}</h3>
  <div class="ring">
    <svg viewBox="0 0 120 120" aria-hidden="true">
      <circle class="track" cx="60" cy="60" r="${R}"/>
      <circle class="fill" cx="60" cy="60" r="${R}" stroke-dasharray="${C.toFixed(1)}" stroke-dashoffset="${(C * (1 - frac)).toFixed(1)}" data-c="${C.toFixed(1)}"/>
    </svg>
    <div class="ring-text"><small>${label}</small><b class="clock">${state === "ready" ? "GO" : state === "idle" ? "—" : ""}</b></div>
  </div>
  <p class="dial-sub">${esc(sub)}</p>
</article>`;
}

export function dashboard(user, s, { origin, vapidKey, hasCli, notify }) {
  const now = Date.now();
  const left = Math.max(0, s.goal - s.todayCount);
  const n = notify;
  const chk = (k, label) => `<label class="toggle"><input type="checkbox" name="notify.${k}" ${n[k] ? "checked" : ""}><span>${label}</span></label>`;
  return layout({
    title: "ダッシュボード · ratelimit.world",
    user,
    head: `<meta name="rw-vapid" content="${esc(vapidKey)}">`,
    bodyClass: "dash",
    body: `
<section class="stats-row" aria-label="記録">
  <div class="stat flame"><b>${s.streak}</b><span>日連続</span></div>
  <div class="stat ice" title="7日続けるごとに1つ。最大2つ"><b>${s.freezes}</b><span>フリーズ</span></div>
  <div class="stat xp"><b>${s.weekXp.toLocaleString()}</b><span>今週の XP</span></div>
</section>

<section class="card today">
  <div class="today-head">
    <h1 class="h2">今日 <span class="num">${s.todayCount}</span><span class="of">/ ${s.goal}</span></h1>
    <p class="muted">${s.todayDone ? "目標達成！記録を伸ばそう" : `あと ${left} 回 · 今から始めれば最大 ${s.possibleToday} 回`}</p>
  </div>
  <div class="pips">${pips(s.todayCount, s.goal)}</div>
  <p class="late">今日の出遅れ <b>${s.todayLateMin}</b> 分${s.quickRun > 0 ? ` · 即スタート <b>${s.quickRun}</b> 連続` : ""}</p>
</section>

<section class="dials">
  ${dial("claude", s, now)}
  ${dial("codex", s, now)}
</section>

<section class="card">
  <h2 class="h3">直近4週間</h2>
  ${heatmap(s)}
  <p class="legend"><i class="cell l0"></i>0 <i class="cell l1"></i>目標未満 <i class="cell l2"></i>達成 <i class="cell l3"></i>超え <i class="cell frozen"></i>フリーズ</p>
</section>

<section class="card" id="notify">
  <h2 class="h3">スマホに通知</h2>
  <p class="muted" data-push-hint>iPhone の場合は、Safari の共有ボタンから「ホーム画面に追加」をして、追加したアイコンから開いてください。</p>
  <div class="row">
    <button class="btn" data-push-enable>この端末で通知を受け取る</button>
    <button class="btn ghost" data-push-test hidden>テスト通知を送る</button>
  </div>
  <p class="status" data-push-status role="status"></p>
</section>

<section class="card ${hasCli ? "" : "attention"}" id="setup">
  <h2 class="h3">${hasCli ? "PC の連携" : "まず PC を連携する"}</h2>
  <p>${hasCli ? "連携済みです。別の PC を追加するときも同じコマンドを使います。" : "Claude Code や Codex を使う PC のターミナルで、1回だけ実行してください。"}</p>
  <pre class="cmd"><code>curl -fsSL ${esc(origin)}/install.sh | sh</code><button class="copy" data-copy aria-label="コマンドをコピー">コピー</button></pre>
  <p class="muted small">Node.js 18 以上が必要です。外すときは <code>node ~/.ratelimit-world/ratelimit-world.mjs uninstall</code>。最終受信: ${user.last_sync_at ? new Date(user.last_sync_at).toLocaleString("ja-JP", { timeZone: s.tz }) : "まだありません"}</p>
</section>

<section class="card">
  <h2 class="h3">設定</h2>
  <form class="settings" data-settings>
    <label>1日の目標 <select name="goal">${[1, 2, 3, 4, 5].map((g) => `<option ${g === s.goal ? "selected" : ""}>${g}</option>`).join("")}</select> 回</label>
    <label>ピンチ通知の時刻 <input type="time" name="remindAt" value="${esc(user.remind_at)}"></label>
    <label>タイムゾーン <input name="tz" value="${esc(user.tz)}" list="tzs"><datalist id="tzs" data-tz-list></datalist></label>
    <fieldset><legend>通知</legend>
      ${chk("reset", "リセットした瞬間")}
      ${chk("late", "リセットから10分たっても再開していないとき")}
      ${chk("pinch", "ピンチ（指定時刻に目標未達）")}
      ${chk("goal", "目標達成")}
    </fieldset>
    <label class="toggle"><input type="checkbox" name="public" ${user.public ? "checked" : ""}><span>プロフィールを公開してランキングに参加する</span></label>
    <div class="row"><button class="btn">設定を保存</button><span class="status" data-settings-status role="status"></span></div>
  </form>
</section>

<section class="row share">
  <a class="btn ghost" href="/@${esc(user.login)}">公開プロフィール</a>
  <form method="post" action="/logout"><button class="btn ghost">ログアウト</button></form>
</section>`,
  });
}

// ---------- profile / leaderboard ----------
export function profile(viewer, u, s, origin) {
  const url = `${origin}/@${u.login}`;
  const text = `🔥${s.streak}日連続でAIのレートリミットを使い切っています`;
  return layout({
    title: `@${u.login} · ratelimit.world`,
    user: viewer,
    head: `<meta property="og:title" content="@${esc(u.login)} — 🔥${s.streak}日連続"><meta property="og:description" content="今日 ${s.todayCount}/${s.goal} 回 · 今週 ${s.weekXp} XP"><meta property="og:image" content="${esc(url)}/card.svg"><meta name="twitter:card" content="summary_large_image">`,
    body: `
<section class="profile-head">
  ${u.avatar_url ? `<img class="avatar" src="${esc(u.avatar_url)}" alt="">` : ""}
  <div><h1 class="h2">@${esc(u.login)}</h1>${u.name && u.name !== u.login ? `<p class="muted">${esc(u.name)}</p>` : ""}</div>
</section>
<section class="stats-row">
  <div class="stat flame"><b>${s.streak}</b><span>日連続</span></div>
  <div class="stat"><b>${s.bestStreak}</b><span>最長</span></div>
  <div class="stat xp"><b>${s.weekXp.toLocaleString()}</b><span>今週の XP</span></div>
  <div class="stat"><b>${s.total}</b><span>使い切った枠</span></div>
</section>
<section class="card">
  <h2 class="h3">今日 ${s.todayCount} / ${s.goal}</h2>
  <div class="pips">${pips(s.todayCount, s.goal)}</div>
  ${heatmap(s)}
</section>
<section class="card share-card">
  <img src="/@${esc(u.login)}/card.svg" alt="@${esc(u.login)} の記録カード" width="600" height="315">
  <div class="row">
    <a class="btn" target="_blank" rel="noopener" href="https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}">X でシェア</a>
    <button class="btn ghost" data-copy-text="${esc(url)}">リンクをコピー</button>
  </div>
</section>`,
  });
}

export function leaderboard(viewer, rows) {
  const list = rows.length
    ? rows.map((r, i) => `<li class="${viewer?.id === r.id ? "you" : ""}"><span class="rank">${i + 1}</span>${r.avatar_url ? `<img src="${esc(r.avatar_url)}" alt="">` : `<span class="noav"></span>`}<a href="/@${esc(r.login)}">@${esc(r.login)}</a><span class="fl">🔥${r.streak}</span><b>${r.weekXp.toLocaleString()} XP</b></li>`).join("")
    : `<li class="empty">今週はまだ誰もいません。最初の1枠を使い切りましょう。</li>`;
  return layout({
    title: "今週のランキング · ratelimit.world",
    user: viewer,
    body: `<section class="card"><h1 class="h2">今週のランキング</h1><p class="muted">月曜 0時（各自のタイムゾーン）からの XP。1枠使い切ると 100 XP、リセットから5分以内に再開すると +50 XP。</p><ol class="board">${list}</ol></section>`,
  });
}

export function cliVerify(user, code) {
  return layout({
    title: "PC を連携 · ratelimit.world",
    user,
    body: `<section class="card narrow center">
<h1 class="h2">この PC を連携しますか？</h1>
<p>ターミナルに表示されたコードと同じか確認してください。</p>
<form method="post" action="/cli/verify">
  <input class="code" name="code" value="${esc(code)}" aria-label="確認コード" autocomplete="off">
  <p><button class="btn big">@${esc(user.login)} として連携する</button></p>
</form>
<p class="muted small">連携すると、その PC から「リミット到達とリセットの時刻」だけが送られます。</p>
</section>`,
  });
}

// ---------- share card (SVG 1200x630) ----------
export function card(u, s) {
  const days = [];
  for (let i = 13; i >= 0; i--) {
    const k = addDays(s.today, -i);
    const c = s.days[k]?.count ?? 0;
    const fill = s.frozenDays.includes(k) ? "#7FD8F5" : c === 0 ? "#2E2A5C" : c < s.goal ? "#8F84FF" : "#FF7A1A";
    days.push(`<rect x="${80 + (13 - i) * 74}" y="470" width="62" height="62" rx="14" fill="${fill}"/>`);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
<rect width="1200" height="630" fill="#17153A"/>
<circle cx="1080" cy="120" r="260" fill="#5B4BFF" opacity=".35"/>
<text x="80" y="110" fill="#B9B3FF" font-family="Helvetica, Arial, sans-serif" font-size="34" font-weight="700">ratelimit.world</text>
<text x="80" y="170" fill="#FFFFFF" font-family="Helvetica, Arial, sans-serif" font-size="44" font-weight="700">@${esc(u.login)}</text>
<text x="72" y="380" fill="#FF7A1A" font-family="Helvetica, Arial, sans-serif" font-size="210" font-weight="900">${s.streak}</text>
<text x="${90 + String(s.streak).length * 118}" y="380" fill="#FFFFFF" font-family="Hiragino Sans, Noto Sans JP, sans-serif" font-size="64" font-weight="800">日連続</text>
<text x="80" y="440" fill="#B9B3FF" font-family="Hiragino Sans, Noto Sans JP, sans-serif" font-size="30">5時間枠を使い切った日 · 今週 ${s.weekXp.toLocaleString()} XP · 最長 ${s.bestStreak} 日</text>
${days.join("")}
</svg>`;
}
