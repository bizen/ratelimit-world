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

