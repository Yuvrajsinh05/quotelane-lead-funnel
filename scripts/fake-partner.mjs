// Local stand-in for PARTNER_WEBHOOK_URL. Logs each delivery (no PII printed beyond ids).
//   node scripts/fake-partner.mjs [port] [mode]   mode: ok | slow | fail | flaky
import { createServer } from "node:http";

const port = Number(process.argv[2] ?? 4555);
const mode = process.argv[3] ?? "ok";
let n = 0;
createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    n++;
    let body = {};
    try { body = JSON.parse(raw); } catch {}
    console.log(JSON.stringify({ n, mode, idempotencyKey: req.headers["idempotency-key"], lead_id: body.lead_id, click_id: body.click_id, aff_id: body.aff_id, sub_id: body.sub_id, variant: body.variant, signed: Boolean(req.headers["x-quotelane-signature"]) }));
    const status = mode === "fail" ? 500 : mode === "flaky" && n % 2 === 1 ? 503 : 200;
    const delay = mode === "slow" ? 10_000 : 0;
    setTimeout(() => { res.writeHead(status, { "content-type": "application/json" }); res.end("{}"); }, delay);
  });
}).listen(port, "127.0.0.1", () => console.log(`fake partner (${mode}) on http://127.0.0.1:${port}`));
