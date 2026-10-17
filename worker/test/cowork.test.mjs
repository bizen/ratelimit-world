import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Cowork の audit.jsonl から、リミット到達と今の 5時間枠を読む
test("CLI reads Cowork rate limit events", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rw-cowork-"));
  process.env.RATELIMIT_WORLD_COWORK_DIR = dir;
  const { scanCowork } = await import("../../cli/ratelimit-world.mjs");
  const sess = path.join(dir, "org", "user", "local_abc");
  fs.mkdirSync(sess, { recursive: true });
  const now = Date.now();
  const iso = (ms) => new Date(ms).toISOString();
  const sec = (ms) => Math.floor(ms / 1000);
  const ev = (ts, info) => JSON.stringify({ type: "rate_limit_event", rate_limit_info: info, _audit_timestamp: iso(ts) });
  const reset1 = now - 2 * 3600e3, reset2 = now + 3 * 3600e3;
  fs.writeFileSync(path.join(sess, "audit.jsonl"), [
    JSON.stringify({ type: "user", _audit_timestamp: iso(now - 7 * 3600e3) }),
    ev(now - 4 * 3600e3, { status: "allowed_warning", rateLimitType: "five_hour", resetsAt: sec(reset1), utilization: 0.91 }),
    ev(now - 3 * 3600e3, { status: "rejected", rateLimitType: "five_hour", resetsAt: sec(reset1) }),
    ev(now - 3 * 3600e3, { status: "rejected", rateLimitType: "seven_day", resetsAt: sec(now + 2 * 86400e3) }),
    ev(now - 1 * 3600e3, { status: "allowed", rateLimitType: "five_hour", resetsAt: sec(reset2) }),
  ].join("\n") + "\n");
  const r = scanCowork(now - 86400e3);
  assert.deepEqual(r.hits.map((h) => h.reset), [Math.floor(reset1 / 1000) * 1000]);
  assert.equal(r.weekly.length, 1);
  assert.equal(r.current.resetAt, Math.floor(reset2 / 1000) * 1000);
  assert.equal(r.current.pct, null);
  fs.rmSync(dir, { recursive: true, force: true });
});


test("Antigravity: started windows, limit hits and the restart time from /usage snapshots", async () => {
  const { updateAntigravity } = await import("../../cli/ratelimit-world.mjs");
  const H = 3600e3, M = 60e3, t0 = Date.UTC(2026, 9, 17, 0, 0);
  const iso = (ms) => new Date(ms).toISOString();
  const usage = (frac, reset, weekFrac = 1) => [{ name: "Gemini Models", buckets: [
    { window: "weekly", remaining_fraction: weekFrac, reset_time: iso(t0 + 7 * 24 * H) },
    { window: "5h", remaining_fraction: frac, reset_time: iso(reset) },
  ] }];
  // 使っていない: リセット時刻は「今から 5時間後」のまま動く → 枠は始まっていない
  let st = updateAntigravity({}, usage(1, t0 + 5 * H), t0);
  st = updateAntigravity(st, usage(1, t0 + 10 * M + 5 * H), t0 + 10 * M);
  assert.equal(st.opened.length, 0);
  // 0:20 に使い始める → 5:20 リセットの枠
  const reset = t0 + 20 * M + 5 * H;
  st = updateAntigravity(st, usage(0.6, reset), t0 + 25 * M);
  assert.deepEqual(st.opened.map((o) => [o.resetAt, o.peak]), [[reset, 40]]);
  // 使い切る
  st = updateAntigravity(st, usage(0, reset), t0 + 3 * H);
  assert.deepEqual(st.hits.map((h) => [h.ts, h.reset]), [[t0 + 3 * H, reset]]);
  // 同じ枠の 2回目の 0% は数えない。週間枠を使い切ったら週間の到達
  st = updateAntigravity(st, usage(0, reset, 0), t0 + 3 * H + 5 * M);
  assert.equal(st.hits.length, 1);
  assert.equal(st.weekly.length, 1);
});
