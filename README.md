# Codex Token Tracker

Local OpenTelemetry receiver and dashboard for tracking Codex token usage.

This app does not inspect HTTPS traffic and does not proxy OpenAI requests. It listens for OTLP/HTTP JSON emitted by Codex and extracts token counts from log or metric payloads.

## Requirements

- Node.js 20 or newer
- Codex configured to export OTLP logs as JSON

## Run

```bash
cd /Users/ar677154/workspace/codex-token-tracker
npm start
```

Open the dashboard:

```text
http://127.0.0.1:4318
```

The receiver accepts:

```text
http://127.0.0.1:4318/v1/logs
http://127.0.0.1:4318/v1/traces
http://127.0.0.1:4318/v1/metrics
http://127.0.0.1:4318/otlp
```

Debug endpoints:

```text
http://127.0.0.1:4318/api/summary
http://127.0.0.1:4318/api/raw
```

`/api/raw` shows the latest raw OTLP record samples. It is useful when Codex is sending telemetry but no token usage is detected. Keep it local; raw telemetry can include tool arguments or command output. User email and account id are redacted in this debug response.

## Cost Estimate

The dashboard estimates USD cost from captured usage events. Cost is calculated per event using that event's `model`, then rolled up into the total card and the Model usage table. It supports Standard, Batch, Flex, and Priority pricing modes for the GPT-5.5 and GPT-5.4 model families.

Formula:

```text
billable_input = input - cached_input
cost = billable_input * input_rate
  + cached_input * cached_input_rate
  + output * output_rate
```

Reasoning tokens are already included in output tokens, so they are shown as a breakdown but are not added a second time. Events above 270,000 input or total tokens use long-context rates when that mode/model has a long-context price.

Pricing lives in:

```text
src/model-pricing.json
```

When a new model appears:

1. Check the official OpenAI pricing page for input, cached input, output, and long-context rates.
2. Add a new entry under `models` in `src/model-pricing.json`.
3. Put the stable model family in `match`, for example `"match": ["gpt-5.6"]`; dated snapshots like `gpt-5.6-2026-06-01` will match automatically.
4. Restart the tracker and run `npm test`.

Unknown models are counted as tokens but shown as unpriced until their rates are added.

## Codex Config

Edit:

```text
~/.codex/config.toml
```

Add or update:

```toml
[otel]
environment = "local"
log_user_prompt = true
exporter = { otlp-http = {
  endpoint = "http://127.0.0.1:4318/v1/logs",
  protocol = "json"
}}
```

Restart Codex after changing the config.

`log_user_prompt = true` is required if you want the Recent prompts table to show names like `build feature login`. Keep the tracker local because prompt text can include sensitive information.

## Data Files

Captured token events are stored locally:

```text
data/events.jsonl
data/summary.json
```

To use another directory:

```bash
DATA_DIR=/tmp/codex-token-tracker npm start
```

## Verify With A Sample Event

Start the app, then send a sample OTLP log:

```bash
curl -X POST http://127.0.0.1:4318/v1/logs \
  -H 'content-type: application/json' \
  -d '{
    "resourceLogs": [{
      "scopeLogs": [{
        "logRecords": [{
          "attributes": [
            {"key": "event.name", "value": {"stringValue": "codex.sse_event"}},
            {"key": "response.model", "value": {"stringValue": "gpt-5.5"}},
            {"key": "conversation_id", "value": {"stringValue": "demo"}},
            {"key": "usage.input_tokens", "value": {"intValue": "1200"}},
            {"key": "usage.cached_input_tokens", "value": {"intValue": "300"}},
            {"key": "usage.output_tokens", "value": {"intValue": "220"}}
          ]
        }]
      }]
    }]
  }'
```

## Scripts

```bash
npm test
npm start
```
# codex-token-tracker
