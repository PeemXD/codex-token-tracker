import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractPromptEvents, extractUsageEvents } from "./otel.js";
import { createStore } from "./store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const PUBLIC_DIR = path.join(ROOT_DIR, "public");
const PORT = Number(process.env.PORT ?? 4318);
const HOST = process.env.HOST ?? "127.0.0.1";
const DATA_DIR = process.env.DATA_DIR ?? path.join(ROOT_DIR, "data");
const MAX_BODY_BYTES = Number(process.env.MAX_BODY_BYTES ?? 10 * 1024 * 1024);

const store = createStore({ dataDir: DATA_DIR });

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? `${HOST}:${PORT}`}`);

    if (req.method === "GET" && url.pathname === "/") {
      return serveFile(res, path.join(PUBLIC_DIR, "index.html"), "text/html; charset=utf-8");
    }

    if (req.method === "GET" && url.pathname.startsWith("/assets/")) {
      return serveAsset(res, url.pathname);
    }

    if (req.method === "GET" && url.pathname === "/api/summary") {
      return json(res, 200, store.snapshot());
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

  if (pathname === "/v1/metrics") {
    store.addRawCounts("metrics", countMetricPoints(payload));
    store.addRawSamples(sampleMetricPoints(payload, receivedAt));
  } else if (pathname === "/v1/traces") {
    store.addRawCounts("traces", countSpanRecords(payload));
    store.addRawSamples(sampleSpanRecords(payload, receivedAt));
  } else {
    store.addRawCounts("logs", countLogRecords(payload));
    store.addRawSamples(sampleLogRecords(payload, receivedAt));
  }

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

function countLogRecords(payload) {
  let total = 0;
  for (const resourceLog of payload?.resourceLogs ?? []) {
    for (const scopeLog of resourceLog.scopeLogs ?? []) {
      total += scopeLog.logRecords?.length ?? 0;
    }
  }
  return total || 1;
}

function countMetricPoints(payload) {
  let total = 0;
  for (const resourceMetric of payload?.resourceMetrics ?? []) {
    for (const scopeMetric of resourceMetric.scopeMetrics ?? []) {
      for (const metric of scopeMetric.metrics ?? []) {
        total += metric.sum?.dataPoints?.length ?? 0;
        total += metric.gauge?.dataPoints?.length ?? 0;
        total += metric.histogram?.dataPoints?.length ?? 0;
      }
    }
  }
  return total || 1;
}

function countSpanRecords(payload) {
  let total = 0;
  for (const resourceSpan of payload?.resourceSpans ?? []) {
    for (const scopeSpan of resourceSpan.scopeSpans ?? []) {
      total += scopeSpan.spans?.length ?? 0;
    }
  }
  return total || 1;
}

function sampleLogRecords(payload, receivedAt) {
  const samples = [];
  for (const resourceLog of payload?.resourceLogs ?? []) {
    for (const scopeLog of resourceLog.scopeLogs ?? []) {
      for (const logRecord of scopeLog.logRecords ?? []) {
        samples.push({
          receivedAt,
          source: "logs",
          timeUnixNano: logRecord.timeUnixNano ?? logRecord.observedTimeUnixNano ?? null,
          body: previewValue(logRecord.body),
          attributes: previewAttributes(logRecord.attributes)
        });
      }
    }
  }
  return samples.slice(0, 10);
}

function sampleSpanRecords(payload, receivedAt) {
  const samples = [];
  for (const resourceSpan of payload?.resourceSpans ?? []) {
    for (const scopeSpan of resourceSpan.scopeSpans ?? []) {
      for (const span of scopeSpan.spans ?? []) {
        samples.push({
          receivedAt,
          source: "traces",
          name: span.name ?? null,
          startTimeUnixNano: span.startTimeUnixNano ?? null,
          attributes: previewAttributes(span.attributes)
        });
      }
    }
  }
  return samples.slice(0, 10);
}

function sampleMetricPoints(payload, receivedAt) {
  const samples = [];
  for (const resourceMetric of payload?.resourceMetrics ?? []) {
    for (const scopeMetric of resourceMetric.scopeMetrics ?? []) {
      for (const metric of scopeMetric.metrics ?? []) {
        samples.push({
          receivedAt,
          source: "metrics",
          name: metric.name ?? null,
          description: metric.description ?? null,
          unit: metric.unit ?? null
        });
      }
    }
  }
  return samples.slice(0, 10);
}

function previewAttributes(attributes) {
  return (attributes ?? []).map(attr => ({
    key: attr.key,
    value: isSensitiveAttribute(attr.key) ? { stringValue: "[redacted]" } : previewValue(attr.value)
  }));
}

function isSensitiveAttribute(key) {
  return [
    "user.email",
    "user.account_id"
  ].includes(key);
}

function previewValue(value) {
  const json = JSON.stringify(value ?? null);
  if (json.length <= 1200) {
    return value ?? null;
  }
  return {
    truncated: true,
    preview: json.slice(0, 1200)
  };
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

function serveAsset(res, pathname) {
  const requested = path.normalize(pathname.replace(/^\/assets\//, ""));
  if (requested.includes("..")) {
    return json(res, 400, { error: "invalid_asset_path" });
  }

  const file = path.join(PUBLIC_DIR, requested);
  const contentType = file.endsWith(".css")
    ? "text/css; charset=utf-8"
    : file.endsWith(".js")
      ? "text/javascript; charset=utf-8"
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
