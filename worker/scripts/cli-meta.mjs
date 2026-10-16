// 配布する CLI (public/cli.mjs) のバージョンと SHA-256 を public/cli.json に書く。PC 側の自動更新が見る
import fs from "node:fs";
import { createHash } from "node:crypto";

const file = new URL("../public/cli.mjs", import.meta.url);
const body = fs.readFileSync(file);
const version = body.toString("utf8").match(/const VERSION = "([^"]+)"/)?.[1] ?? "0.0.0";
const sha256 = createHash("sha256").update(body).digest("hex");
fs.writeFileSync(new URL("../public/cli.json", import.meta.url), JSON.stringify({ version, sha256 }) + "\n");
console.log(`cli ${version} ${sha256.slice(0, 12)}`);
