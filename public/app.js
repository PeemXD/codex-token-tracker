const els = {
  connection: document.querySelector("#connection"),
  totalTokens: document.querySelector("#totalTokens"),
  inputTokens: document.querySelector("#inputTokens"),
  cachedTokens: document.querySelector("#cachedTokens"),
  outputTokens: document.querySelector("#outputTokens"),
  reasoningTokens: document.querySelector("#reasoningTokens"),
  totalCost: document.querySelector("#totalCost"),
  costMeta: document.querySelector("#costMeta"),
  pricingMode: document.querySelector("#pricingMode"),
  modelRows: document.querySelector("#modelRows"),
  conversationRows: document.querySelector("#conversationRows"),
  events: document.querySelector("#events"),
  acceptedCount: document.querySelector("#acceptedCount"),
  rawCount: document.querySelector("#rawCount"),
  reset: document.querySelector("#reset")
};

const nf = new Intl.NumberFormat();
const money = new Intl.NumberFormat(undefined, {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 2
});

const savedPricingMode = localStorage.getItem("pricingMode");
if (savedPricingMode && [...els.pricingMode.options].some(option => option.value === savedPricingMode)) {
  els.pricingMode.value = savedPricingMode;
}

els.pricingMode.addEventListener("change", () => {
  localStorage.setItem("pricingMode", els.pricingMode.value);
  refresh();
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
    const res = await fetch("/api/summary", { cache: "no-store" });
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
  renderCost(data.costsByMode?.[els.pricingMode.value]);
  els.acceptedCount.textContent = `${format(data.acceptedEventCount)} accepted`;
  els.rawCount.textContent = `${format((data.rawLogCount ?? 0) + (data.rawTraceCount ?? 0) + (data.rawMetricCount ?? 0))} raw`;

  renderRows(els.modelRows, data.byModel ?? [], ["name", "cost", "total", "input", "cachedInput", "output", "events"]);
  renderRows(els.conversationRows, data.byConversation ?? [], ["name", "total", "input", "output", "events"]);
  renderEvents(data.recent ?? []);
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
  els.costMeta.textContent = `${labelize(cost.mode)}${contexts ? ` · ${contexts}` : ""}${unpriced}`;
  els.totalCost.title = [
    `Input ${money.format(cost.inputUsd ?? 0)}`,
    `Cached ${money.format(cost.cachedInputUsd ?? 0)}`,
    `Output ${money.format(cost.outputUsd ?? 0)}`,
    `Reasoning portion ${money.format(cost.reasoningUsd ?? 0)}`
  ].join("\n");
}

function renderRows(tbody, rows, fields) {
  tbody.textContent = "";

  if (!rows.length) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = fields.length;
    td.className = "empty";
    td.textContent = "No token events captured yet";
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
        const cost = row.costsByMode?.[els.pricingMode.value];
        td.textContent = cost ? money.format(cost.totalUsd ?? 0) : "-";
        if (cost?.unpricedEvents) {
          td.title = `${format(cost.unpricedEvents)} unpriced events for this mode/model`;
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
    const div = document.createElement("div");
    div.className = "empty";
    div.textContent = "Waiting for the next Codex prompt with log_user_prompt=true";
    els.events.append(div);
    return;
  }

  for (const event of events.slice(0, 40)) {
    const div = document.createElement("div");
    div.className = "event";

    div.append(
      cell("event-time", formatTime(event.timestamp)),
      cell("event-name", event.prompt ?? `${event.model} - ${event.eventName}`),
      pill(`total ${format(event.usage?.total)}`),
      pill(`in ${format(event.usage?.input)}`),
      pill(`cached ${format(event.usage?.cachedInput)}`),
      pill(`out ${format(event.usage?.output)}`)
    );

    els.events.append(div);
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

function labelize(value) {
  return String(value ?? "").replace(/^\w/, char => char.toUpperCase());
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
