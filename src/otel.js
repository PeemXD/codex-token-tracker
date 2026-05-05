const TOKEN_KEY_PATTERNS = {
  input: [
    "input_tokens",
    "input_token_count",
    "prompt_tokens",
    "gen_ai.usage.input_tokens",
    "usage.input_tokens",
    "usage.prompt_tokens"
  ],
  cachedInput: [
    "cached_input_tokens",
    "cached_token_count",
    "cached_tokens",
    "gen_ai.usage.cache_read.input_tokens",
    "input_tokens_details.cached_tokens",
    "prompt_tokens_details.cached_tokens",
    "usage.cached_input_tokens",
    "usage.input_tokens_details.cached_tokens",
    "usage.prompt_tokens_details.cached_tokens"
  ],
  output: [
    "output_tokens",
    "output_token_count",
    "completion_tokens",
    "gen_ai.usage.output_tokens",
    "usage.output_tokens",
    "usage.completion_tokens"
  ],
  reasoning: [
    "reasoning_tokens",
    "reasoning_token_count",
    "codex.usage.reasoning_output_tokens",
    "output_tokens_details.reasoning_tokens",
    "completion_tokens_details.reasoning_tokens",
    "usage.reasoning_tokens",
    "usage.output_tokens_details.reasoning_tokens",
    "usage.completion_tokens_details.reasoning_tokens"
  ],
  total: [
    "total_tokens",
    "tool_token_count",
    "codex.usage.total_tokens",
    "gen_ai.usage.total_tokens",
    "usage.total_tokens"
  ]
};

const MODEL_KEYS = [
  "model",
  "response.model",
  "request.model",
  "gen_ai.request.model",
  "gen_ai.response.model",
  "openai.model"
];

const CONVERSATION_KEYS = [
  "conversation_id",
  "conversation.id",
  "thread_id",
  "thread.id",
  "session_id",
  "session.id",
  "turn_id",
  "turn.id",
  "rollout_id"
];

const RESPONSE_ID_KEYS = [
  "response_id",
  "response.id"
];

const EVENT_NAME_KEYS = [
  "event.name",
  "event_name",
  "codex.event",
  "gen_ai.operation.name"
];

const PROMPT_TEXT_KEYS = [
  "prompt",
  "user_prompt",
  "user.prompt",
  "input",
  "message",
  "text",
  "content"
];

export function extractUsageEvents(payload, receivedAt = new Date().toISOString()) {
  const records = collectRecords(payload);

  return records
    .map(({ source, record, resource, scope }) => {
      const normalized = normalizeRecord(record);
      const merged = mergeMaps(resource, scope, normalized.attributes, normalized.bodyMap);
      const usage = pickUsage(merged);

      if (!hasUsage(usage)) {
        return null;
      }

      if (source === "traces" && normalized.name === "handle_responses") {
        return null;
      }

      const model = firstString(merged, MODEL_KEYS) ?? "unknown";
      const conversationId = firstString(merged, CONVERSATION_KEYS) ?? "unknown";
      const responseId = firstString(merged, RESPONSE_ID_KEYS) ?? null;
      const eventName = firstString(merged, EVENT_NAME_KEYS) ?? normalized.name ?? source;
      const timestamp = normalized.timestamp ?? parseTimestamp(firstString(merged, ["event.timestamp"])) ?? receivedAt;

      return {
        id: stableEventId({ timestamp, model, conversationId, responseId, usage, eventName }),
        timestamp,
        receivedAt,
        source,
        eventName,
        model,
        conversationId,
        responseId,
        usage,
        raw: compactRaw(record)
      };
    })
    .filter(Boolean);
}

export function extractPromptEvents(payload, receivedAt = new Date().toISOString()) {
  return collectRecords(payload)
    .map(({ source, record, resource, scope }) => {
      const normalized = normalizeRecord(record);
      const merged = mergeMaps(resource, scope, normalized.attributes, normalized.bodyMap);
      const eventName = firstString(merged, EVENT_NAME_KEYS) ?? normalized.name ?? source;
      const eventKind = firstString(merged, ["event.kind", "kind", "type"]) ?? "";

      if (!isPromptEvent(eventName, eventKind, merged)) {
        return null;
      }

      const prompt = firstString(merged, PROMPT_TEXT_KEYS);
      const timestamp = normalized.timestamp ?? parseTimestamp(firstString(merged, ["event.timestamp"])) ?? receivedAt;
      const conversationId = firstString(merged, CONVERSATION_KEYS) ?? "unknown";

      return {
        id: [timestamp, conversationId, eventName, prompt ?? ""].join("|"),
        timestamp,
        receivedAt,
        source,
        eventName,
        conversationId,
        prompt: cleanPrompt(prompt),
        raw: compactRaw(record)
      };
    })
    .filter(Boolean);
}

export function emptyUsage() {
  return {
    input: 0,
    cachedInput: 0,
    output: 0,
    reasoning: 0,
    total: 0
  };
}

function collectRecords(payload) {
  const records = [];

  collectLogRecords(payload, records);
  collectSpanRecords(payload, records);
  collectMetricPoints(payload, records);

  if (records.length === 0 && payload && typeof payload === "object") {
    records.push({ source: "json", record: payload, resource: {}, scope: {} });
  }

  return records;
}

function collectLogRecords(payload, records) {
  for (const resourceLog of asArray(payload?.resourceLogs)) {
    const resource = attributesToMap(resourceLog.resource?.attributes);

    for (const scopeLog of asArray(resourceLog.scopeLogs)) {
      const scope = attributesToMap(scopeLog.scope?.attributes);

      for (const logRecord of asArray(scopeLog.logRecords)) {
        records.push({
          source: "logs",
          record: logRecord,
          resource,
          scope
        });
      }
    }
  }
}

function collectMetricPoints(payload, records) {
  for (const resourceMetric of asArray(payload?.resourceMetrics)) {
    const resource = attributesToMap(resourceMetric.resource?.attributes);

    for (const scopeMetric of asArray(resourceMetric.scopeMetrics)) {
      const scope = attributesToMap(scopeMetric.scope?.attributes);

      for (const metric of asArray(scopeMetric.metrics)) {
        const points = collectPoints(metric);

        for (const point of points) {
          const pointAttrs = attributesToMap(point.attributes);
          const value = numberFrom(point.asInt ?? point.asDouble ?? point.value);

          records.push({
            source: "metrics",
            record: {
              name: metric.name,
              attributes: objectToAttributes({
                ...pointAttrs,
                [metric.name]: value
              }),
              timeUnixNano: point.timeUnixNano
            },
            resource,
            scope
          });
        }
      }
    }
  }
}

function collectSpanRecords(payload, records) {
  for (const resourceSpan of asArray(payload?.resourceSpans)) {
    const resource = attributesToMap(resourceSpan.resource?.attributes);

    for (const scopeSpan of asArray(resourceSpan.scopeSpans)) {
      const scope = attributesToMap(scopeSpan.scope?.attributes);

      for (const span of asArray(scopeSpan.spans)) {
        records.push({
          source: "traces",
          record: span,
          resource,
          scope
        });
      }
    }
  }
}

function collectPoints(metric) {
  return [
    ...asArray(metric.sum?.dataPoints),
    ...asArray(metric.gauge?.dataPoints),
    ...asArray(metric.histogram?.dataPoints),
    ...asArray(metric.exponentialHistogram?.dataPoints)
  ];
}

function normalizeRecord(record) {
  const attributes = attributesToMap(record?.attributes);
  const body = parseMaybeJson(otelValueToJs(record?.body));
  const bodyMap = flatten(body);

  return {
    attributes,
    bodyMap,
    name: record?.name,
    timestamp: parseTimestamp(record?.timeUnixNano ?? record?.observedTimeUnixNano ?? record?.startTimeUnixNano ?? record?.timestamp)
  };
}

function attributesToMap(attributes) {
  const out = {};

  for (const attr of asArray(attributes)) {
    if (!attr || typeof attr.key !== "string") {
      continue;
    }
    out[attr.key] = otelValueToJs(attr.value);
  }

  return out;
}

function objectToAttributes(obj) {
  return Object.entries(obj).map(([key, value]) => ({ key, value: jsToOtelValue(value) }));
}

function jsToOtelValue(value) {
  if (typeof value === "number") {
    return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value };
  }
  if (typeof value === "boolean") {
    return { boolValue: value };
  }
  return { stringValue: String(value ?? "") };
}

function otelValueToJs(value) {
  if (value == null || typeof value !== "object") {
    return value;
  }

  if ("stringValue" in value) {
    return value.stringValue;
  }
  if ("intValue" in value) {
    return numberFrom(value.intValue);
  }
  if ("doubleValue" in value) {
    return numberFrom(value.doubleValue);
  }
  if ("boolValue" in value) {
    return Boolean(value.boolValue);
  }
  if ("bytesValue" in value) {
    return value.bytesValue;
  }
  if ("arrayValue" in value) {
    return asArray(value.arrayValue.values).map(otelValueToJs);
  }
  if ("kvlistValue" in value) {
    const out = {};
    for (const item of asArray(value.kvlistValue.values)) {
      out[item.key] = otelValueToJs(item.value);
    }
    return out;
  }

  return value;
}

function parseMaybeJson(value) {
  if (typeof value !== "string") {
    return value;
  }

  const trimmed = value.trim();
  if (!trimmed || !["{", "["].includes(trimmed[0])) {
    return value;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function mergeMaps(...maps) {
  const out = {};

  for (const map of maps) {
    for (const [key, value] of Object.entries(flatten(map))) {
      if (value !== undefined && value !== null && value !== "") {
        out[key] = value;
      }
    }
  }

  return out;
}

function flatten(value, prefix = "", out = {}) {
  if (value == null) {
    return out;
  }

  if (typeof value !== "object") {
    if (prefix) {
      out[prefix] = value;
    }
    return out;
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => flatten(item, prefix ? `${prefix}.${index}` : String(index), out));
    return out;
  }

  for (const [key, item] of Object.entries(value)) {
    flatten(item, prefix ? `${prefix}.${key}` : key, out);
  }

  return out;
}

function pickUsage(map) {
  const usage = emptyUsage();

  for (const [field, patterns] of Object.entries(TOKEN_KEY_PATTERNS)) {
    usage[field] = findBestNumericBySuffixes(map, patterns) ?? 0;
  }

  if (!usage.total) {
    usage.total = usage.input + usage.output;
  }

  return usage;
}

function findBestNumericBySuffixes(map, suffixes) {
  const matches = new Map();

  for (const suffix of suffixes) {
    const normalizedSuffix = normalizeKey(suffix);
    const direct = map[suffix];
    if (direct != null && Number.isFinite(numberFrom(direct))) {
      matches.set(suffix, numberFrom(direct));
    }

    for (const [key, value] of Object.entries(map)) {
      const normalizedKey = normalizeKey(key);
      if (isUsageKeyMatch(normalizedKey, normalizedSuffix) && Number.isFinite(numberFrom(value))) {
        matches.set(key, numberFrom(value));
      }
    }
  }

  if (matches.size === 0) {
    return null;
  }

  return Math.max(...matches.values());
}

function isUsageKeyMatch(normalizedKey, normalizedSuffix) {
  if (normalizedKey === normalizedSuffix) {
    return true;
  }

  if (!normalizedKey.endsWith(`.${normalizedSuffix}`)) {
    return false;
  }

  return !normalizedKey.includes("max.output.tokens")
    && !normalizedKey.includes("max.input.tokens")
    && !normalizedKey.includes("max.total.tokens");
}

function normalizeKey(key) {
  return String(key).toLowerCase().replaceAll("_", ".");
}

function firstString(map, keys) {
  for (const key of keys) {
    const direct = map[key];
    if (typeof direct === "string" && direct.trim()) {
      return direct;
    }
  }

  for (const [key, value] of Object.entries(map)) {
    const normalized = normalizeKey(key);
    if (keys.some(candidate => normalized === normalizeKey(candidate) || normalized.endsWith(`.${normalizeKey(candidate)}`))) {
      if (typeof value === "string" && value.trim()) {
        return value;
      }
    }
  }

  return null;
}

function hasUsage(usage) {
  return usage.input > 0 || usage.cachedInput > 0 || usage.output > 0 || usage.reasoning > 0 || usage.total > 0;
}

function isPromptEvent(eventName, eventKind, map) {
  const combined = `${eventName} ${eventKind}`.toLowerCase();

  if (combined.includes("user_prompt") || combined.includes("user.prompt") || combined.includes("prompt_submitted")) {
    return true;
  }

  if ((combined.includes("prompt") || combined.includes("input")) && firstString(map, PROMPT_TEXT_KEYS)) {
    return true;
  }

  return false;
}

function cleanPrompt(prompt) {
  if (!prompt) {
    return null;
  }

  return prompt.replace(/\s+/g, " ").trim().slice(0, 240);
}

function parseTimestamp(value) {
  if (value == null) {
    return null;
  }

  if (typeof value === "string" && /^\d+$/.test(value)) {
    if (value === "0") {
      return null;
    }
    const nanos = BigInt(value);
    const millis = Number(nanos / 1000000n);
    return new Date(millis).toISOString();
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    if (value === 0) {
      return null;
    }
    if (value > 1_000_000_000_000_000) {
      return new Date(Math.floor(value / 1_000_000)).toISOString();
    }
    return new Date(value).toISOString();
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function stableEventId(event) {
  const parts = [
    event.timestamp,
    event.model,
    event.conversationId,
    event.responseId,
    event.eventName,
    event.usage.input,
    event.usage.cachedInput,
    event.usage.output,
    event.usage.reasoning,
    event.usage.total
  ];

  return parts.map(part => String(part ?? "")).join("|");
}

function compactRaw(record) {
  const json = JSON.stringify(record);
  if (json.length <= 5000) {
    return record;
  }
  return { truncated: true, preview: json.slice(0, 5000) };
}

function numberFrom(value) {
  if (value == null || value === "") {
    return 0;
  }
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}
