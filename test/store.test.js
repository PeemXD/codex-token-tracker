import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createStore } from "../backend/store.js";

test("recent prompts only shows actual prompts and aggregates usage until the next prompt", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-token-tracker-"));
  try {
    const store = createStore({ dataDir: dir });

    store.addEvent(usageEvent("orphan", "conversation-1", 10, 2));
    assert.equal(store.snapshot().recent.length, 0);
    assert.equal(store.snapshot().totals.total, 12);

    store.addPrompt(promptEvent("prompt-1", "conversation-1", "build feature login"));
    store.addEvent(usageEvent("usage-1", "conversation-1", 100, 20));
    store.addEvent(usageEvent("usage-2", "conversation-1", 50, 5));

    let recent = store.snapshot().recent;
    assert.equal(recent.length, 1);
    assert.equal(recent[0].prompt, "build feature login");
    assert.equal(recent[0].usage.input, 150);
    assert.equal(recent[0].usage.output, 25);
    assert.equal(recent[0].usage.total, 175);

    store.addPrompt(promptEvent("prompt-2", "conversation-1", "fix dashboard row labels"));
    store.addEvent(usageEvent("usage-3", "conversation-1", 7, 3));

    recent = store.snapshot().recent;
    assert.equal(recent.length, 2);
    assert.equal(recent[0].prompt, "fix dashboard row labels");
    assert.equal(recent[0].usage.total, 10);
    assert.equal(recent[1].prompt, "build feature login");
    assert.equal(recent[1].usage.total, 175);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("prompt rows survive store reload", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-token-tracker-"));
  try {
    const store = createStore({ dataDir: dir });
    store.addPrompt(promptEvent("prompt-1", "conversation-1", "build feature login"));
    store.addEvent(usageEvent("usage-1", "conversation-1", 100, 20));

    const restored = createStore({ dataDir: dir });
    const recent = restored.snapshot().recent;

    assert.equal(recent.length, 1);
    assert.equal(recent[0].prompt, "build feature login");
    assert.equal(recent[0].usage.input, 100);
    assert.equal(recent[0].usage.output, 20);
    assert.equal(recent[0].usage.total, 120);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("model buckets include model-specific cost estimates", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-token-tracker-"));
  try {
    const store = createStore({ dataDir: dir });
    store.addEvent(usageEvent("usage-1", "conversation-1", 1_000, 100));

    const [model] = store.snapshot().byModel;
    assert.equal(model.name, "gpt-5.5");
    assert.equal(model.cost.totalUsd, 0.008);
    assert.equal(model.cost.pricing, "standard");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("snapshot can filter usage and prompt rows by time", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-token-tracker-"));
  try {
    const store = createStore({ dataDir: dir });
    store.addPrompt(promptEvent("prompt-old", "conversation-1", "old prompt", "2026-05-04T03:00:00.000Z"));
    store.addEvent(usageEvent("usage-old", "conversation-1", 100, 20, "2026-05-04T03:00:01.000Z"));
    store.addPrompt(promptEvent("prompt-new", "conversation-1", "new prompt", "2026-05-05T03:00:00.000Z"));
    store.addEvent(usageEvent("usage-new", "conversation-1", 10, 5, "2026-05-05T03:00:01.000Z"));

    const allTime = store.snapshot();
    assert.equal(allTime.totals.total, 135);
    assert.equal(allTime.recent.length, 2);

    const filtered = store.snapshot({ since: "2026-05-05T00:00:00.000Z" });
    assert.equal(filtered.totals.input, 10);
    assert.equal(filtered.totals.output, 5);
    assert.equal(filtered.totals.total, 15);
    assert.equal(filtered.acceptedEventCount, 1);
    assert.equal(filtered.byModel.length, 1);
    assert.equal(filtered.byModel[0].events, 1);
    assert.equal(filtered.recent.length, 1);
    assert.equal(filtered.recent[0].prompt, "new prompt");
    assert.equal(filtered.recent[0].usage.total, 15);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("new models without pricing are visible as unpriced", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-token-tracker-"));
  try {
    const store = createStore({ dataDir: dir });
    store.addEvent({
      ...usageEvent("usage-1", "conversation-1", 1_000, 100),
      model: "gpt-6"
    });

    const [model] = store.snapshot().byModel;
    assert.equal(model.name, "gpt-6");
    assert.equal(model.cost.totalUsd, 0);
    assert.equal(model.cost.unpricedEvents, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function promptEvent(id, conversationId, prompt, timestamp = "2026-05-05T03:00:00.000Z") {
  return {
    id,
    timestamp,
    receivedAt: addMilliseconds(timestamp, 100),
    source: "logs",
    eventName: "codex.user_prompt",
    conversationId,
    prompt
  };
}

function usageEvent(id, conversationId, input, output, timestamp = "2026-05-05T03:00:01.000Z") {
  return {
    id,
    timestamp,
    receivedAt: addMilliseconds(timestamp, 100),
    source: "logs",
    eventName: "codex.sse_event",
    model: "gpt-5.5",
    conversationId,
    usage: {
      input,
      cachedInput: 0,
      output,
      reasoning: 0,
      total: input + output
    }
  };
}

function addMilliseconds(timestamp, milliseconds) {
  return new Date(Date.parse(timestamp) + milliseconds).toISOString();
}
