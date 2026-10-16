# ratelimit.world

Claude Code と Codex の 5時間枠を、**リセットの瞬間から**使い切るためのウェブサービス。

5時間枠は「リセット後に最初に使った時刻」から数え直されます。3:00 にリセットされても 3:30 に再開すれば、次のリセットは 8:30 になる。この出遅れは1日のあいだ積み重なっていきます。ratelimit.world はリセットの瞬間にスマホへ通知し、使い切った回数をストリーク（Duolingo 方式）で記録します。

## 気持ちよさの設計

- **日をまたぐ**: 目標の枠数を使い切った日が続くと 🔥ストリーク。7日ごとにフリーズ 🧊（最大2つ）がもらえて、未達の日を自動で守る。
- **1日の中**: その日の何枠目かで XP が増えるコンボ（100 → 120 → 150 → 200 → 300）。称号は自分の目標が基準（あとn枠 / 目標達成 / 目標超え / 限界突破）で、届かない上限は見せない。リセットから5分以内の再開は +50 XP。「今日のトラック」は目標＋1マスだけを並べ、次のマスの XP と時刻を見せる。枠を使い切った瞬間にスマホへ「今日n枠目 +XP」を通知し、ダッシュボードを開くと増えた枠がポップして紙吹雪が出る。
- **ランキング**: ツール×課金プランごと（Claude Pro / Max 5x / Max 20x / ChatGPT Plus / Pro …）。プランは CLI が `~/.claude.json` の `oauthAccount.organizationType` / `organizationRateLimitTier` と、Codex のログの `rate_limits.plan_type` から読む。両方使う人は両方のボードに、そのツールの枠だけで出る。
- **週間リミット**: Claude Code（`quotaLimits.rateLimitType: seven_day*`）や Codex（10080分枠）の週間リミットを使い切ると 🏆 +1000 XP と「週間制覇」。リセットまでの日は5時間枠を使えないので、ストリークを自動で守る（フリーズは使わない）。
- **オンボーディング** (`/welcome`): コマンドを貼る → 連携した瞬間に過去60日の記録（使い切った枠・平均の出遅れ・取りこぼした時間）を見せる → 「ふだんの1日」を目安に目標を自分で選ぶ → 通知を ON。

## 構成

```
[PC]  Claude Code / Codex
        │ hooks (UserPromptSubmit / Stop / StopFailure=rate_limit)と Codex の notify
        ▼
      cli/ratelimit-world.mjs ── ローカルログから「到達・リセット・再開の時刻」だけを送る
        │
        ▼
[Cloudflare Worker + D1]  worker/
        ├ 記録・ストリーク・フリーズ・XP・ランキング
        ├ 毎分の Cron: リセット通知 / 10分出遅れ通知 / ピンチ通知
        └ Web Push (VAPID) → スマホ (PWA)
```

| ディレクトリ | 中身 |
|---|---|
| `cli/` | 依存なしの Node CLI。`setup` / `sync` / `status` / `scan` / `uninstall` |
| `worker/src/logic.js` | 集計（0時区切り・ストリーク・フリーズ・出遅れ・XP）と通知の文面 |
| `worker/src/webpush.js` | WebCrypto だけで書いた Web Push（RFC 8291 / 8292） |
| `worker/src/index.js` | API・GitHub ログイン・CLI のデバイスログイン・Cron |
| `worker/src/pages.js` | サーバーで組み立てる HTML（LP・ダッシュボード・プロフィール・ランキング・シェアカード） |
| `worker/public/` | CSS・クライアント JS・Service Worker・manifest・アイコン |

### 読み取っているログ

- **Claude Code** `~/.claude/projects/**/*.jsonl`：`error: "rate_limit"` の合成メッセージ。新しい版の `quotaLimits.resetsAt`（`rateLimitType: "five_hour"`）を優先し、なければ本文の `resets 5:20pm (Australia/Melbourne)` を読む。週次リミットは数えない。
- **Codex** `~/.codex/sessions/**/*.jsonl`：`token_count` の `rate_limits.primary`（`window_minutes: 300`）。`used_percent >= 100` を到達として数える。使用率（%）は表示しない（使っていないときは古い数字になるため）。
- 再開時刻は、リセット後の最初のプロンプト（Claude）または `task_started`（Codex）。

## ローカルで動かす

```sh
cd worker
npm install
npm run db:local                  # D1 (ローカル) にテーブルを作る
{ echo DEV_LOGIN=1; npm run -s vapid; } > .dev.vars
npm run dev                       # http://localhost:8787 (GitHub なしで /login から名前だけでログイン)
npm test                          # 集計ロジックと Web Push の暗号化のテスト
```

CLI をローカルのサーバーにつなぐ: `node cli/ratelimit-world.mjs setup --server http://localhost:8787`
（実行すると `~/.claude/settings.json` と `~/.codex/config.toml` に hooks / notify を登録します。元のファイルは `*.ratelimit-world.bak` に保存されます）

## 本番にデプロイする (Cloudflare)

1. `npx wrangler login`
2. `npx wrangler d1 create ratelimit-world` → 表示された `database_id` を `wrangler.toml` に書く
3. `npm run db:remote`
4. GitHub の OAuth App を作る（Settings → Developer settings → OAuth Apps）
   - Homepage URL: `https://ratelimit.world`
   - Authorization callback URL: `https://ratelimit.world/auth/github/callback`
5. シークレットを入れる
   ```sh
   npm run -s vapid   # 出力された 2つの値を使う
   npx wrangler secret put GITHUB_CLIENT_ID
   npx wrangler secret put GITHUB_CLIENT_SECRET
   npx wrangler secret put VAPID_PUBLIC_KEY
   npx wrangler secret put VAPID_PRIVATE_KEY
   ```
6. `npm run deploy`
7. ドメイン `ratelimit.world` を Cloudflare に追加し、Worker の Custom Domain に設定する

## 既知の制限

- iPhone で通知を受け取るには、Safari で「ホーム画面に追加」した PWA から通知を ON にする必要があります。
- Codex の notify はターンが終わったときにしか呼ばれません。Codex だけでリミットに当たって手を止めた場合、送信は次のターン（または Claude Code の次のターン）まで遅れます。
- 回数は各自の PC から送られるので、改ざんは防げません。ランキングは「楽しむためのもの」という前提です。
- Windows は未対応（install.sh は macOS / Linux 用）。
