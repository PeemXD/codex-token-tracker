import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractPromptEvents, extractUsageEvents, extractRawData } from "./otel.js";
import { createStore } from "./store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const PUBLIC_DIR = path.join(ROOT_DIR, "frontend");
const PORT = Number(process.env.PORT ?? 4318);
const HOST = process.env.HOST ?? "127.0.0.1";
const DATA_DIR = process.env.DATA_DIR ?? path.join(ROOT_DIR, "data");
const MAX_BODY_BYTES = Number(process.env.MAX_BODY_BYTES ?? 10 * 1024 * 1024);
const SUMMARY_RANGES = {
  "1h": 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000
};

const store = createStore({ dataDir: DATA_DIR });

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? `${HOST}:${PORT}`}`);

    if (req.method === "GET" && url.pathname === "/") {
      return serveFile(res, path.join(PUBLIC_DIR, "index.html"), "text/html; charset=utf-8");
    }

    if (req.method === "GET" && (url.pathname.startsWith("/assets/") || ["/favicon.svg", "/icons.svg"].includes(url.pathname))) {
      return serveStatic(res, url.pathname);
    }

    if (req.method === "GET" && url.pathname === "/api/summary") {
      return json(res, 200, store.snapshot(summaryOptions(url.searchParams)));
    }

    if (req.method === "GET" && url.pathname === "/api/events") {
      return json(res, 200, store.snapshot().recent);
    }

    if (req.method === "GET" && url.pathname === "/api/raw") {
      return json(res, 200, store.snapshot({ includeRaw: true }).rawSamples);
    }

    if (req.method === "POST" && url.pathname === "/api/reset") {
      store.reset();
      return json(res, 200, { ok: true });
    }

    if (req.method === "POST" && ["/v1/logs", "/v1/traces", "/v1/metrics", "/otlp"].includes(url.pathname)) {
      return handleOtlp(req, res, url.pathname);
    }

    json(res, 404, { error: "not_found" });
  } catch (error) {
    json(res, 500, { error: "internal_error", message: error.message });
  }
});

server.listen(PORT, HOST, () => {
  const baseUrl = `http://${HOST}:${PORT}`;
  console.log(`Codex Token Tracker listening on ${baseUrl}`);
  console.log(`OTLP logs endpoint: ${baseUrl}/v1/logs`);
  console.log(`Data directory: ${DATA_DIR}`);
});

function summaryOptions(searchParams, now = Date.now()) {
  const options = {};
  const range = searchParams.get("range");

  if (range && range !== "all" && SUMMARY_RANGES[range]) {
    options.since = new Date(now - SUMMARY_RANGES[range]).toISOString();
  }

  const since = searchParams.get("since");
  const until = searchParams.get("until");
  if (since) {
    options.since = since;
  }
  if (until) {
    options.until = until;
  }

  return options;
}

async function handleOtlp(req, res, pathname) {
  const receivedAt = new Date().toISOString();
  const body = await readBody(req);

  if (!body.trim()) {
    return json(res, 400, { error: "empty_body" });
  }

  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    return json(res, 400, {
      error: "invalid_json",
      hint: "Configure Codex with protocol = \"json\" for this local receiver."
    });
  }

  const rawData = extractRawData(payload, pathname, receivedAt);
  store.addRawCounts(rawData.type, rawData.count);
  store.addRawSamples(rawData.samples);

  const events = extractUsageEvents(payload, receivedAt);
  const promptEvents = extractPromptEvents(payload, receivedAt);
  let accepted = 0;

  for (const promptEvent of promptEvents) {
    store.addPrompt(promptEvent);
  }

  for (const event of events) {
    if (store.addEvent(event)) {
      accepted += 1;
    }
  }

  json(res, 200, {
    partialSuccess: {},
    accepted,
    parsed: events.length
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];

    req.on("data", chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error(`Request body exceeds ${MAX_BODY_BYTES} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function serveStatic(res, pathname) {
  const requested = path.normalize(pathname);
  if (requested.includes("..")) {
    return json(res, 400, { error: "invalid_asset_path" });
  }

  const file = path.join(PUBLIC_DIR, requested);
  const contentType = file.endsWith(".css")
    ? "text/css; charset=utf-8"
    : file.endsWith(".js") || file.endsWith(".mjs")
      ? "text/javascript; charset=utf-8"
      : file.endsWith(".svg")
        ? "image/svg+xml"
        : "application/octet-stream";

  serveFile(res, file, contentType);
}

function serveFile(res, file, contentType) {
  if (!fs.existsSync(file)) {
    return json(res, 404, { error: "not_found" });
  }

  res.writeHead(200, {
    "content-type": contentType,
    "cache-control": "no-store"
  });
  fs.createReadStream(file).pipe(res);
}

function json(res, statusCode, value) {
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(JSON.stringify(value));
}
