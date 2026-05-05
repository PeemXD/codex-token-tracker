import assert from "node:assert/strict";
import test from "node:test";
import { extractPromptEvents, extractUsageEvents } from "../src/otel.js";

test("extracts usage from OTLP log attributes", () => {
  const payload = {
    resourceLogs: [
      {
        resource: {
          attributes: [
            { key: "service.name", value: { stringValue: "codex" } }
          ]
        },
        scopeLogs: [
          {
            logRecords: [
              {
                timeUnixNano: "1777948404065000000",
                attributes: [
                  { key: "event.name", value: { stringValue: "codex.sse_event" } },
                  { key: "response.model", value: { stringValue: "gpt-5.5" } },
                  { key: "conversation_id", value: { stringValue: "abc" } },
                  { key: "usage.input_tokens", value: { intValue: "1200" } },
                  { key: "usage.cached_input_tokens", value: { intValue: "300" } },
                  { key: "usage.output_tokens", value: { intValue: "220" } }
                ]
              }
            ]
          }
        ]
      }
    ]
  };

  const events = extractUsageEvents(payload);
  assert.equal(events.length, 1);
  assert.equal(events[0].model, "gpt-5.5");
  assert.equal(events[0].conversationId, "abc");
  assert.equal(events[0].usage.input, 1200);
  assert.equal(events[0].usage.cachedInput, 300);
  assert.equal(events[0].usage.output, 220);
  assert.equal(events[0].usage.total, 1420);
});

test("extracts usage from JSON body string", () => {
  const payload = {
    resourceLogs: [
      {
        scopeLogs: [
          {
            logRecords: [
              {
                body: {
                  stringValue: JSON.stringify({
                    type: "response.completed",
                    response: {
                      id: "resp_1",
                      model: "gpt-5.4",
                      usage: {
                        input_tokens: 100,
                        input_tokens_details: { cached_tokens: 80 },
                        output_tokens: 40,
                        output_tokens_details: { reasoning_tokens: 12 }
                      }
                    }
                  })
                }
              }
            ]
          }
        ]
      }
    ]
  };

  const events = extractUsageEvents(payload);
  assert.equal(events.length, 1);
  assert.equal(events[0].responseId, "resp_1");
  assert.equal(events[0].usage.input, 100);
  assert.equal(events[0].usage.cachedInput, 80);
  assert.equal(events[0].usage.output, 40);
  assert.equal(events[0].usage.reasoning, 12);
  assert.equal(events[0].usage.total, 140);
});

test("extracts usage from OTLP span attributes", () => {
  const payload = {
    resourceSpans: [
      {
        scopeSpans: [
          {
            spans: [
              {
                name: "turn.token_usage",
                startTimeUnixNano: "1777948404065000000",
                attributes: [
                  { key: "model", value: { stringValue: "gpt-5.4-mini" } },
                  { key: "thread_id", value: { stringValue: "thread-1" } },
                  { key: "input_tokens", value: { intValue: "10" } },
                  { key: "cached_input_tokens", value: { intValue: "4" } },
                  { key: "output_tokens", value: { intValue: "8" } }
                ]
              }
            ]
          }
        ]
      }
    ]
  };

  const events = extractUsageEvents(payload);
  assert.equal(events.length, 1);
  assert.equal(events[0].source, "traces");
  assert.equal(events[0].eventName, "turn.token_usage");
  assert.equal(events[0].model, "gpt-5.4-mini");
  assert.equal(events[0].conversationId, "thread-1");
  assert.equal(events[0].usage.total, 18);
});

test("extracts actual Codex sse token count fields", () => {
  const payload = {
    resourceLogs: [
      {
        scopeLogs: [
          {
            logRecords: [
              {
                attributes: [
                  { key: "event.name", value: { stringValue: "codex.sse_event" } },
                  { key: "event.kind", value: { stringValue: "response.completed" } },
                  { key: "input_token_count", value: { stringValue: "162203" } },
                  { key: "output_token_count", value: { stringValue: "98" } },
                  { key: "cached_token_count", value: { intValue: "161664" } },
                  { key: "reasoning_token_count", value: { intValue: "0" } },
                  { key: "tool_token_count", value: { stringValue: "162301" } },
                  { key: "model", value: { stringValue: "gpt-5.5" } },
                  { key: "conversation.id", value: { stringValue: "conversation-1" } }
                ]
              }
            ]
          }
        ]
      }
    ]
  };

  const events = extractUsageEvents(payload);
  assert.equal(events.length, 1);
  assert.equal(events[0].model, "gpt-5.5");
  assert.equal(events[0].conversationId, "conversation-1");
  assert.equal(events[0].usage.input, 162203);
  assert.equal(events[0].usage.cachedInput, 161664);
  assert.equal(events[0].usage.output, 98);
  assert.equal(events[0].usage.total, 162301);
});

test("does not count tool call max_output_tokens as model usage", () => {
  const payload = {
    resourceLogs: [
      {
        scopeLogs: [
          {
            logRecords: [
              {
                attributes: [
                  { key: "event.name", value: { stringValue: "codex.tool_result" } },
                  { key: "arguments", value: { stringValue: "{\"max_output_tokens\":6000}" } },
                  { key: "model", value: { stringValue: "gpt-5.5" } }
                ]
              }
            ]
          }
        ]
      }
    ]
  };

  assert.equal(extractUsageEvents(payload).length, 0);
});

test("uses event.timestamp when OTLP timeUnixNano is zero", () => {
  const payload = {
    resourceLogs: [
      {
        scopeLogs: [
          {
            logRecords: [
              {
                timeUnixNano: "0",
                attributes: [
                  { key: "event.name", value: { stringValue: "codex.sse_event" } },
                  { key: "event.timestamp", value: { stringValue: "2026-05-05T02:55:31.257Z" } },
                  { key: "input_token_count", value: { stringValue: "10" } },
                  { key: "output_token_count", value: { stringValue: "2" } }
                ]
              }
            ]
          }
        ]
      }
    ]
  };

  const [event] = extractUsageEvents(payload);
  assert.equal(event.timestamp, "2026-05-05T02:55:31.257Z");
});

test("extracts user prompt events", () => {
  const payload = {
    resourceLogs: [
      {
        scopeLogs: [
          {
            logRecords: [
              {
                attributes: [
                  { key: "event.name", value: { stringValue: "codex.user_prompt" } },
                  { key: "prompt", value: { stringValue: "build feature login" } },
                  { key: "conversation.id", value: { stringValue: "conversation-1" } },
                  { key: "event.timestamp", value: { stringValue: "2026-05-05T03:00:00.000Z" } }
                ]
              }
            ]
          }
        ]
      }
    ]
  };

  const [event] = extractPromptEvents(payload);
  assert.equal(event.prompt, "build feature login");
  assert.equal(event.conversationId, "conversation-1");
  assert.equal(event.timestamp, "2026-05-05T03:00:00.000Z");
});
