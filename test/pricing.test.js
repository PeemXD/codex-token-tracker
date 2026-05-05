import assert from "node:assert/strict";
import test from "node:test";
import { emptyCostModes, addCostForEvent, estimateEventCost } from "../src/pricing.js";

test("estimates standard gpt-5.5 short-context cost without double-counting cached input", () => {
  const cost = estimateEventCost({
    model: "gpt-5.5",
    usage: {
      input: 10_000,
      cachedInput: 6_000,
      output: 1_000,
      reasoning: 250,
      total: 11_000
    }
  });

  assert.equal(cost.contexts.short, 1);
  assert.equal(cost.totalUsd, 0.053);
  assert.equal(cost.inputUsd, 0.02);
  assert.equal(cost.cachedInputUsd, 0.003);
  assert.equal(cost.outputUsd, 0.03);
  assert.equal(cost.reasoningUsd, 0.0075);
});

test("uses long-context rates when an event exceeds the threshold", () => {
  const cost = estimateEventCost({
    model: "gpt-5.5",
    usage: {
      input: 300_000,
      cachedInput: 100_000,
      output: 10_000,
      reasoning: 2_000,
      total: 310_000
    }
  });

  assert.equal(cost.contexts.long, 1);
  assert.ok(Math.abs(cost.totalUsd - 2.55) < 0.000001);
});

test("keeps independent totals for pricing modes", () => {
  const costsByMode = emptyCostModes();
  addCostForEvent(costsByMode, {
    model: "gpt-5.5",
    usage: {
      input: 10_000,
      cachedInput: 0,
      output: 1_000,
      reasoning: 0,
      total: 11_000
    }
  });

  assert.equal(costsByMode.standard.totalUsd, 0.08);
  assert.equal(costsByMode.batch.totalUsd, 0.04);
  assert.equal(costsByMode.flex.totalUsd, 0.04);
  assert.equal(costsByMode.priority.totalUsd, 0.2);
});

test("matches dated model snapshots to their pricing family", () => {
  const cost = estimateEventCost({
    model: "gpt-5.5-2026-05-05",
    usage: {
      input: 1_000,
      cachedInput: 0,
      output: 100,
      reasoning: 0,
      total: 1_100
    }
  });

  assert.equal(cost.rates.model, "gpt-5.5");
  assert.equal(cost.totalUsd, 0.008);
});

test("marks unknown models as unpriced", () => {
  const cost = estimateEventCost({
    model: "gpt-6",
    usage: {
      input: 1_000,
      cachedInput: 0,
      output: 100,
      reasoning: 0,
      total: 1_100
    }
  });

  assert.equal(cost.totalUsd, 0);
  assert.equal(cost.unpricedEvents, 1);
  assert.deepEqual(cost.unpricedModels, ["gpt-6"]);
});
