import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MILLION = 1_000_000;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PRICING_CATALOG = readPricingCatalog(path.join(__dirname, "model-pricing.json"));

const PRICING_MODES = PRICING_CATALOG.modes;

export function emptyCostModes() {
  return Object.fromEntries(PRICING_MODES.map(mode => [mode, emptyCost(mode)]));
}

export function addCostForEvent(costsByMode, event) {
  for (const mode of PRICING_MODES) {
    addCost(costsByMode[mode], estimateEventCost(event, mode));
  }
}

export function estimateEventCost(event, mode = "standard") {
  const usage = event?.usage ?? {};
  const model = event?.model ?? "unknown";
  const context = inferContextTier(usage);
  const rates = findRates(model, mode, context);
  const billableInput = Math.max((usage.input ?? 0) - (usage.cachedInput ?? 0), 0);
  const cachedInput = Math.max(usage.cachedInput ?? 0, 0);
  const output = Math.max(usage.output ?? 0, 0);
  const reasoning = Math.max(usage.reasoning ?? 0, 0);

  if (!rates) {
    return {
      ...emptyCost(mode),
      unpricedEvents: 1,
      unpricedModels: [model],
      unpricedTokens: usage.total ?? 0
    };
  }

  const inputUsd = billableInput * rates.input / MILLION;
  const cachedInputUsd = cachedInput * rates.cachedInput / MILLION;
  const outputUsd = output * rates.output / MILLION;
  const reasoningUsd = reasoning * rates.output / MILLION;

  return {
    ...emptyCost(mode),
    inputUsd,
    cachedInputUsd,
    outputUsd,
    reasoningUsd,
    totalUsd: inputUsd + cachedInputUsd + outputUsd,
    pricedEvents: 1,
    contexts: { [context]: 1 },
    rates: {
      model: normalizeModel(model)?.name ?? String(model ?? "unknown"),
      context,
      input: rates.input,
      cachedInput: rates.cachedInput,
      output: rates.output
    }
  };
}

function emptyCost(mode) {
  return {
    currency: PRICING_CATALOG.currency,
    mode,
    totalUsd: 0,
    inputUsd: 0,
    cachedInputUsd: 0,
    outputUsd: 0,
    reasoningUsd: 0,
    pricedEvents: 0,
    unpricedEvents: 0,
    unpricedTokens: 0,
    unpricedModels: [],
    contexts: { short: 0, long: 0 }
  };
}

function addCost(target, cost) {
  target.totalUsd += cost.totalUsd;
  target.inputUsd += cost.inputUsd;
  target.cachedInputUsd += cost.cachedInputUsd;
  target.outputUsd += cost.outputUsd;
  target.reasoningUsd += cost.reasoningUsd;
  target.pricedEvents += cost.pricedEvents;
  target.unpricedEvents += cost.unpricedEvents;
  target.unpricedTokens += cost.unpricedTokens;
  target.contexts.short += cost.contexts?.short ?? 0;
  target.contexts.long += cost.contexts?.long ?? 0;
  target.unpricedModels = [...new Set([...target.unpricedModels, ...cost.unpricedModels])];
}

function findRates(model, mode, context) {
  const modelMatch = normalizeModel(model);
  return modelMatch?.rates?.[mode]?.[context] ?? null;
}

function normalizeModel(model) {
  const name = String(model ?? "").toLowerCase();
  return Object.entries(PRICING_CATALOG.models)
    .flatMap(([modelName, config]) => (config.match ?? [modelName]).map(match => ({
      name: modelName,
      match: match.toLowerCase(),
      rates: config.rates
    })))
    .sort((a, b) => b.match.length - a.match.length)
    .find(candidate => name === candidate.match || name.startsWith(`${candidate.match}-`)) ?? null;
}

function inferContextTier(usage) {
  const contextTokens = Math.max(usage?.input ?? 0, usage?.total ?? 0);
  return contextTokens > PRICING_CATALOG.longContextThresholdTokens ? "long" : "short";
}

function readPricingCatalog(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}
