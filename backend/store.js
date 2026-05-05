import fs from "node:fs";
import path from "node:path";
import { emptyUsage } from "./otel.js";
import { addCostForEvent, emptyCost } from "./pricing.js";

export function createStore({ dataDir }) {
  fs.mkdirSync(dataDir, { recursive: true });

  const eventsFile = path.join(dataDir, "events.jsonl");
  const summaryFile = path.join(dataDir, "summary.json");
  const seen = new Set();
  const seenPrompts = new Set();
  const history = [];

  const state = {
    startedAt: new Date().toISOString(),
    lastEventAt: null,
    totals: emptyUsage(),
    cost: emptyCost(),
    byModel: {},
    byConversation: {},
    recent: [],
    activePrompts: {},
    rawSamples: [],
    rawLogCount: 0,
    rawTraceCount: 0,
    rawMetricCount: 0,
    acceptedEventCount: 0,
    duplicateEventCount: 0
  };

  loadExistingEvents(eventsFile, event => addStoredEvent(event, { persist: false }));

  function addStoredEvent(stored, options = {}) {
    if (stored?.type === "prompt") {
      return addPrompt(stored, options);
    }

    if (stored?.type === "usage" && stored.event) {
      return addEvent(stored.event, options);
    }

    return addEvent(stored, options);
  }

  function addRawCounts(kind, count = 1) {
    if (kind === "metrics") {
      state.rawMetricCount += count;
    } else if (kind === "traces") {
      state.rawTraceCount += count;
    } else {
      state.rawLogCount += count;
    }
  }

  function addRawSamples(samples) {
    if (!samples.length) {
      return;
    }

    state.rawSamples.unshift(...samples);
    state.rawSamples = state.rawSamples.slice(0, 50);
  }

  function addEvent(event, options = {}) {
    if (seen.has(event.id)) {
      state.duplicateEventCount += 1;
      return false;
    }

    seen.add(event.id);
    history.push({ type: "usage", event });
    state.acceptedEventCount += 1;
    state.lastEventAt = event.timestamp ?? event.receivedAt ?? new Date().toISOString();
    addUsage(state.totals, event.usage);
    addCostForEvent(state.cost, event);
    addBucket(state.byModel, event.model, event.usage, event);
    addBucket(state.byConversation, event.conversationId, event.usage);
    addUsageToRecentPrompt(state, event);

    if (options.persist !== false) {
      fs.appendFileSync(eventsFile, `${JSON.stringify(event)}\n`);
      writeSummary();
    }

    return true;
  }

  function addPrompt(promptEvent, options = {}) {
    if (seenPrompts.has(promptEvent.id)) {
      return false;
    }

    seenPrompts.add(promptEvent.id);
    history.push({ type: "prompt", event: promptEvent });
    addPromptToState(state, promptEvent);

    if (options.persist !== false) {
      fs.appendFileSync(eventsFile, `${JSON.stringify({ type: "prompt", ...promptEvent })}\n`);
      writeSummary();
    }

    return true;
  }

  function snapshot({ includeRaw = false, since, until } = {}) {
    const bounds = normalizeTimeBounds({ since, until });
    const source = bounds ? buildFilteredState(history, bounds, state) : state;
    const base = publicSnapshot(source, includeRaw);

    if (bounds) {
      base.timeFilter = {
        since: bounds.sinceMs == null ? null : new Date(bounds.sinceMs).toISOString(),
        until: bounds.untilMs == null ? null : new Date(bounds.untilMs).toISOString()
      };
    }

    return base;
  }

  function writeSummary() {
    fs.writeFileSync(summaryFile, JSON.stringify(snapshot(), null, 2));
  }

  function reset() {
    seen.clear();
    state.startedAt = new Date().toISOString();
    state.lastEventAt = null;
    state.totals = emptyUsage();
    state.cost = emptyCost();
    state.byModel = {};
    state.byConversation = {};
    state.recent = [];
    state.activePrompts = {};
    state.rawSamples = [];
    state.rawLogCount = 0;
    state.rawTraceCount = 0;
    state.rawMetricCount = 0;
    state.acceptedEventCount = 0;
    state.duplicateEventCount = 0;
    history.length = 0;
    seenPrompts.clear();

    fs.writeFileSync(eventsFile, "");
    writeSummary();
  }

  return {
    addRawCounts,
    addRawSamples,
    addPrompt,
    addEvent,
    snapshot,
    reset,
    eventsFile,
    summaryFile
  };
}

function loadExistingEvents(eventsFile, onEvent) {
  if (!fs.existsSync(eventsFile)) {
    return;
  }

  const lines = fs.readFileSync(eventsFile, "utf8").split("\n");
  for (const line of lines) {
    if (!line.trim()) {
      continue;
    }

    try {
      onEvent(JSON.parse(line));
    } catch {
      // Ignore corrupted historical lines but keep the file for manual inspection.
    }
  }
}

function buildFilteredState(history, bounds, sourceState) {
  const filtered = {
    startedAt: bounds.sinceMs == null ? sourceState.startedAt : new Date(bounds.sinceMs).toISOString(),
    lastEventAt: null,
    totals: emptyUsage(),
    cost: emptyCost(),
    byModel: {},
    byConversation: {},
    recent: [],
    activePrompts: {},
    rawSamples: sourceState.rawSamples,
    rawLogCount: sourceState.rawLogCount,
    rawTraceCount: sourceState.rawTraceCount,
    rawMetricCount: sourceState.rawMetricCount,
    acceptedEventCount: 0,
    duplicateEventCount: sourceState.duplicateEventCount
  };

  for (const record of history) {
    if (!isWithinTimeBounds(record.event, bounds)) {
      continue;
    }

    if (record.type === "prompt") {
      addPromptToState(filtered, record.event);
      continue;
    }

    filtered.acceptedEventCount += 1;
    filtered.lastEventAt = record.event.timestamp ?? record.event.receivedAt ?? filtered.lastEventAt;
    addUsage(filtered.totals, record.event.usage);
    addCostForEvent(filtered.cost, record.event);
    addBucket(filtered.byModel, record.event.model, record.event.usage, record.event);
    addBucket(filtered.byConversation, record.event.conversationId, record.event.usage);
    addUsageToRecentPrompt(filtered, record.event);
  }

  return filtered;
}

function addPromptToState(targetState, promptEvent) {
  const conversationId = promptEvent.conversationId || "unknown";
  const row = {
    id: promptEvent.id,
    timestamp: promptEvent.timestamp,
    receivedAt: promptEvent.receivedAt,
    conversationId,
    prompt: promptEvent.prompt || fallbackPromptName(promptEvent.timestamp),
    model: "pending",
    eventName: promptEvent.eventName,
    usage: emptyUsage(),
    completed: false,
    source: promptEvent.source
  };

  targetState.lastEventAt = promptEvent.timestamp ?? promptEvent.receivedAt ?? targetState.lastEventAt;
  targetState.activePrompts[conversationId] = row;
  targetState.recent.unshift(row);
  targetState.recent = dedupeRecent(targetState.recent).slice(0, 100);
}

function addUsageToRecentPrompt(targetState, event) {
  const conversationId = event.conversationId || "unknown";
  const prompt = targetState.activePrompts[conversationId];
  if (!prompt) {
    return;
  }

  prompt.lastUsageAt = event.timestamp ?? prompt.lastUsageAt;
  prompt.receivedAt = event.receivedAt ?? prompt.receivedAt;
  prompt.model = event.model;
  prompt.eventName = event.eventName;
  prompt.completed = true;
  addUsage(prompt.usage, event.usage);

  delete prompt.raw;
  targetState.activePrompts[conversationId] = prompt;
  targetState.recent = [prompt, ...targetState.recent.filter(row => row.id !== prompt.id)].slice(0, 100);
}

function publicSnapshot(sourceState, includeRaw) {
  const base = {
    ...sourceState,
    byModel: sortBuckets(sourceState.byModel),
    byConversation: sortBuckets(sourceState.byConversation),
    recent: includeRaw ? sourceState.recent : sourceState.recent.map(stripRaw)
  };

  if (!includeRaw) {
    delete base.rawSamples;
  }
  delete base.activePrompts;

  return base;
}

function normalizeTimeBounds({ since, until } = {}) {
  const sinceMs = toTimeMs(since);
  const untilMs = toTimeMs(until);

  if (sinceMs == null && untilMs == null) {
    return null;
  }

  return { sinceMs, untilMs };
}

function isWithinTimeBounds(event, bounds) {
  const timestampMs = toTimeMs(event?.timestamp ?? event?.receivedAt);
  if (timestampMs == null) {
    return false;
  }

  if (bounds.sinceMs != null && timestampMs < bounds.sinceMs) {
    return false;
  }

  if (bounds.untilMs != null && timestampMs > bounds.untilMs) {
    return false;
  }

  return true;
}

function toTimeMs(value) {
  if (!value) {
    return null;
  }

  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function addBucket(buckets, name, usage, event) {
  const key = name || "unknown";
  buckets[key] ??= { name: key, ...emptyUsage(), events: 0 };
  buckets[key].events += 1;
  addUsage(buckets[key], usage);
  if (event) {
    buckets[key].cost ??= emptyCost();
    addCostForEvent(buckets[key].cost, event);
  }
}

function addUsage(target, usage) {
  target.input += usage.input ?? 0;
  target.cachedInput += usage.cachedInput ?? 0;
  target.output += usage.output ?? 0;
  target.reasoning += usage.reasoning ?? 0;
  target.total += usage.total ?? 0;
}

function fallbackPromptName(timestamp) {
  if (!timestamp) {
    return "Prompt";
  }
  return `Prompt at ${new Date(timestamp).toLocaleString()}`;
}

function dedupeRecent(rows) {
  const seen = new Set();
  return rows.filter(row => {
    if (seen.has(row.id)) {
      return false;
    }
    seen.add(row.id);
    return true;
  });
}

function sortBuckets(buckets) {
  return Object.values(buckets).sort((a, b) => b.total - a.total);
}

function stripRaw(event) {
  const { raw, ...safeEvent } = event;
  return safeEvent;
}
