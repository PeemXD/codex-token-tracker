const els = {
  connection: document.querySelector("#connection"),
  totalTokens: document.querySelector("#totalTokens"),
  inputTokens: document.querySelector("#inputTokens"),
  cachedTokens: document.querySelector("#cachedTokens"),
  outputTokens: document.querySelector("#outputTokens"),
  reasoningTokens: document.querySelector("#reasoningTokens"),
  totalCost: document.querySelector("#totalCost"),
  costMeta: document.querySelector("#costMeta"),
  modelRows: document.querySelector("#modelRows"),
  conversationRows: document.querySelector("#conversationRows"),
  events: document.querySelector("#events"),
  acceptedCount: document.querySelector("#acceptedCount"),
  rawCount: document.querySelector("#rawCount"),
  timeRange: document.querySelector("#timeRange"),
  reset: document.querySelector("#reset")
};

const nf = new Intl.NumberFormat();
const TIME_RANGE_STORAGE_KEY = "ctt.timeRange";
const TIME_RANGES = new Set(["all", "1h", "24h", "7d", "30d"]);
const money = new Intl.NumberFormat(undefined, {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 2
});

const savedTimeRange = localStorage.getItem(TIME_RANGE_STORAGE_KEY);
if (TIME_RANGES.has(savedTimeRange)) {
  els.timeRange.value = savedTimeRange;
}

els.timeRange.addEventListener("change", async () => {
  localStorage.setItem(TIME_RANGE_STORAGE_KEY, els.timeRange.value);
  await refresh();
});

els.reset.addEventListener("click", async () => {
  if (!confirm("Reset all locally captured token data?")) {
    return;
  }

  await fetch("/api/reset", { method: "POST" });
  await refresh();
});

refresh();
setInterval(refresh, 2000);

async function refresh() {
  try {
    const res = await fetch(summaryUrl(), { cache: "no-store" });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }

    const data = await res.json();
    render(data);
    setStatus("Live", "live");
  } catch {
    setStatus("Offline", "error");
  }
}

function render(data) {
  const totals = data.totals ?? {};
  els.totalTokens.textContent = format(totals.total);
  els.inputTokens.textContent = format(totals.input);
  els.cachedTokens.textContent = format(totals.cachedInput);
  els.outputTokens.textContent = format(totals.output);
  els.reasoningTokens.textContent = format(totals.reasoning);
  renderCost(data.cost);
  els.acceptedCount.textContent = `${format(data.acceptedEventCount)} accepted`;
  els.rawCount.textContent = `${format((data.rawLogCount ?? 0) + (data.rawTraceCount ?? 0) + (data.rawMetricCount ?? 0))} raw`;

  renderRows(els.modelRows, data.byModel ?? [], ["name", "cost", "total", "input", "cachedInput", "output", "events"], emptyUsageMessage());
  renderRows(els.conversationRows, data.byConversation ?? [], ["name", "total", "input", "output", "events"], emptyUsageMessage());
  renderEvents(data.recent ?? []);
}

function summaryUrl() {
  const url = new URL("/api/summary", window.location.origin);
  if (els.timeRange.value !== "all") {
    url.searchParams.set("range", els.timeRange.value);
  }
  return url;
}

function renderCost(cost) {
  if (!cost) {
    els.totalCost.textContent = "-";
    els.costMeta.textContent = "No pricing data";
    return;
  }

  els.totalCost.textContent = money.format(cost.totalUsd ?? 0);
  const contexts = [
    cost.contexts?.short ? `${format(cost.contexts.short)} short` : null,
    cost.contexts?.long ? `${format(cost.contexts.long)} long` : null
  ].filter(Boolean).join(" / ");
  const unpriced = cost.unpricedEvents ? ` · ${format(cost.unpricedEvents)} unpriced` : "";
  els.costMeta.textContent = `Standard${contexts ? ` · ${contexts}` : ""}${unpriced}`;
  els.totalCost.title = [
    `Input ${money.format(cost.inputUsd ?? 0)}`,
    `Cached ${money.format(cost.cachedInputUsd ?? 0)}`,
    `Output ${money.format(cost.outputUsd ?? 0)}`,
    `Reasoning portion ${money.format(cost.reasoningUsd ?? 0)}`
  ].join("\n");
}

function renderRows(tbody, rows, fields, emptyMessage = "No token events captured yet") {
  tbody.textContent = "";

  if (!rows.length) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = fields.length;
    td.className = "empty";
    td.textContent = emptyMessage;
    tr.append(td);
    tbody.append(tr);
    return;
  }

  for (const row of rows.slice(0, 20)) {
    const tr = document.createElement("tr");

    for (const field of fields) {
      const td = document.createElement("td");
      const value = row[field];
      if (field === "name") {
        td.textContent = String(value ?? "unknown");
      } else if (field === "cost") {
        const cost = row.cost;
        td.textContent = cost ? money.format(cost.totalUsd ?? 0) : "-";
        if (cost?.unpricedEvents) {
          td.title = `${format(cost.unpricedEvents)} unpriced events for this model`;
        }
      } else {
        td.textContent = format(value);
      }
      tr.append(td);
    }

    tbody.append(tr);
  }
}

function renderEvents(events) {
  els.events.textContent = "";

  if (!events.length) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 6;
    td.className = "empty";
    td.textContent = els.timeRange.value === "all"
      ? "Waiting for the next Codex prompt with log_user_prompt=true"
      : "No prompts in this time range";
    tr.append(td);
    els.events.append(tr);
    return;
  }

  for (const event of events.slice(0, 40)) {
    const tr = document.createElement("tr");

    const timeTd = document.createElement("td");
    timeTd.textContent = formatTime(event.timestamp);

    const nameTd = document.createElement("td");
    nameTd.className = "event-name";
    nameTd.textContent = event.prompt ?? `${event.model} - ${event.eventName}`;

    const totalTd = document.createElement("td");
    totalTd.textContent = format(event.usage?.total);

    const inTd = document.createElement("td");
    inTd.textContent = format(event.usage?.input);

    const cachedTd = document.createElement("td");
    cachedTd.textContent = format(event.usage?.cachedInput);

    const outTd = document.createElement("td");
    outTd.textContent = format(event.usage?.output);

    tr.append(timeTd, nameTd, totalTd, inTd, cachedTd, outTd);
    els.events.append(tr);
  }
}

function cell(className, text) {
  const div = document.createElement("div");
  div.className = className;
  div.textContent = text;
  return div;
}

function pill(text) {
  return cell("token-pill", text);
}

function format(value) {
  return nf.format(Number(value ?? 0));
}

function emptyUsageMessage() {
  return els.timeRange.value === "all"
    ? "No token events captured yet"
    : "No token events in this time range";
}

function formatTime(value) {
  if (!value) {
    return "-";
  }
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    month: "short",
    day: "2-digit"
  }).format(new Date(value));
}

function setStatus(text, className) {
  els.connection.textContent = text;
  els.connection.className = `status ${className}`;
}
