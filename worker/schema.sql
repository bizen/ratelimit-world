-- ratelimit.world の D1 スキーマ。時刻はすべて epoch ミリ秒。

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  github_id INTEGER UNIQUE,
  login TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT,
  avatar_url TEXT,
  tz TEXT NOT NULL DEFAULT 'UTC',
  goal INTEGER NOT NULL DEFAULT 1,
  remind_at TEXT NOT NULL DEFAULT '21:00',         -- ピンチ通知の時刻 (ユーザーのタイムゾーン)
  notify_lead INTEGER NOT NULL DEFAULT 5,          -- リセットの何分前に「もうすぐリセット」を送るか
  notify TEXT NOT NULL DEFAULT '{"hit":true,"reset":true,"late":true,"pinch":true,"goal":true}',
  public INTEGER NOT NULL DEFAULT 1,
  claude_statusline INTEGER NOT NULL DEFAULT 0, -- Claude Code のステータスラインを中継して使用率を読むか (オン/オフ)
  lang TEXT,                                       -- 'ja' | 'en' (スマホ通知の言語。画面は cookie が優先)
  claude_plan TEXT,                                -- 'pro' | 'max_5x' | 'max_20x' ... (CLI が ~/.claude.json から読む)
  codex_plan TEXT,                                 -- 'plus' | 'pro' ... (Codex のログの plan_type)
  next_reset TEXT,                                 -- 今の 5時間枠のリセット予定 {claude|codex: {resetAt, exact}}
  last_sync_at INTEGER,
  onboarded_at INTEGER,                            -- /welcome を終えた時刻
  created_at INTEGER NOT NULL
);

-- ブラウザのログインセッション (トークンは SHA-256 で保存)
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

-- CLI の認証トークン
CREATE TABLE IF NOT EXISTS cli_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  platform TEXT,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);

-- CLI のログイン待ち (デバイスフロー)
CREATE TABLE IF NOT EXISTS cli_logins (
  device_code TEXT PRIMARY KEY,
  user_code TEXT NOT NULL UNIQUE,
  user_id INTEGER,
  token TEXT,
  platform TEXT,
  expires_at INTEGER NOT NULL
);

-- 5時間枠のリミット到達。1つの枠 = (user, tool, reset_at)
CREATE TABLE IF NOT EXISTS windows (
  user_id INTEGER NOT NULL,
  tool TEXT NOT NULL,                -- 'claude' | 'codex'
  reset_at INTEGER NOT NULL,
  hit_at INTEGER NOT NULL,
  resumed_at INTEGER,                -- リセット後に最初に使い始めた時刻
  ended_at INTEGER,                  -- リセットチケットなどで予定より早く終わった時刻 (あれば実際のリセットはこちら)
  tokens TEXT,                       -- その枠で使ったトークン {model: [入力, 書き込み5分, 書き込み1時間, 読み出し, 出力]}
  PRIMARY KEY (user_id, tool, reset_at)
);
CREATE INDEX IF NOT EXISTS windows_reset ON windows (reset_at);
CREATE INDEX IF NOT EXISTS windows_user_hit ON windows (user_id, hit_at);

-- 開けた枠 (使い切ったかどうかに関係なく)。今日のトラックで「使用中 / 使い切らずに終了」を見せるのに使う
CREATE TABLE IF NOT EXISTS opened_windows (
  user_id INTEGER NOT NULL,
  tool TEXT NOT NULL,
  reset_at INTEGER NOT NULL,
  start_at INTEGER NOT NULL,
  peak_pct REAL,                     -- その枠で到達した最大の使用率 (分からなければ NULL)
  exact INTEGER NOT NULL DEFAULT 0,  -- 時刻が正確か (Claude Code の推定は 0)
  PRIMARY KEY (user_id, tool, reset_at)
);

-- 週間リミットの到達 (ごほうびと、リセットまでのストリーク保護に使う)
CREATE TABLE IF NOT EXISTS weekly_hits (
  user_id INTEGER NOT NULL,
  tool TEXT NOT NULL,
  reset_at INTEGER NOT NULL,
  hit_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, tool, reset_at)
);

CREATE TABLE IF NOT EXISTS push_subs (
  endpoint TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS push_subs_user ON push_subs (user_id);

-- 同じ通知を二度送らないための記録
CREATE TABLE IF NOT EXISTS sent (
  user_id INTEGER NOT NULL,
  key TEXT NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (user_id, key)
);

-- フレンド (一方向のフォロー)。フォローできるのはプロフィールを公開している人だけ
CREATE TABLE IF NOT EXISTS follows (
  follower_id INTEGER NOT NULL,
  followee_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (follower_id, followee_id)
);
CREATE INDEX IF NOT EXISTS follows_followee ON follows (followee_id);
