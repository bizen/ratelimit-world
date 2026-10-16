// Web Push 用の VAPID 鍵を作る。出力を wrangler secret put (本番) / .dev.vars (ローカル) に入れる
import { b64u } from "../src/webpush.js";

const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const pub = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
const { d } = await crypto.subtle.exportKey("jwk", kp.privateKey);
console.log(`VAPID_PUBLIC_KEY=${b64u(pub)}`);
console.log(`VAPID_PRIVATE_KEY=${d}`);
