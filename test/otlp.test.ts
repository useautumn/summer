import { expect, test } from "bun:test";
import { parseClaudeUsageEvents } from "../src/integrations/claude/otlp.ts";
import { parseCodexUsageEvents } from "../src/integrations/codex/otlp.ts";

test("parses claude api_request OTLP log records (api key => api)", () => {
  const events = parseClaudeUsageEvents(
    {
      resourceLogs: [
        {
          scopeLogs: [
            {
              logRecords: [
                {
                  attributes: [
                    { key: "event.name", value: { stringValue: "api_request" } },
                    { key: "model", value: { stringValue: "claude-sonnet-4-6" } },
                    { key: "cost_usd", value: { doubleValue: 0.42 } },
                    { key: "input_tokens", value: { intValue: 10 } },
                    { key: "output_tokens", value: { intValue: 5 } },
                    { key: "cache_read_tokens", value: { intValue: 2 } },
                    { key: "cache_creation_tokens", value: { intValue: 1 } },
                    { key: "request_id", value: { stringValue: "req_123" } }
                  ]
                }
              ]
            }
          ]
        }
      ]
    },
    {} as NodeJS.ProcessEnv
  );

  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    harness: "claude_code",
    model: "claude-sonnet-4-6",
    estimatedCostUsd: 0.42,
    inputTokens: 10,
    cacheWriteTokens: 1,
    billingMode: "api"
  });
});

test("classifies OAuth account attrs as subscription", () => {
  const events = parseClaudeUsageEvents(
    {
      resourceLogs: [
        {
          scopeLogs: [
            {
              logRecords: [
                {
                  attributes: [
                    { key: "event.name", value: { stringValue: "api_request" } },
                    { key: "model", value: { stringValue: "claude-opus-4-8" } },
                    { key: "user.email", value: { stringValue: "dev@example.com" } },
                    { key: "input_tokens", value: { intValue: 100 } },
                    { key: "output_tokens", value: { intValue: 50 } }
                  ]
                }
              ]
            }
          ]
        }
      ]
    },
    {} as NodeJS.ProcessEnv
  );

  expect(events).toHaveLength(1);
  expect(events[0]?.billingMode).toBe("subscription");
});

test("parses snake_case OTLP JSON log records", () => {
  const events = parseClaudeUsageEvents(
    {
      resource_logs: [
        {
          scope_logs: [
            {
              log_records: [
                {
                  attributes: [
                    { key: "event.name", value: { string_value: "api_request" } },
                    { key: "model", value: { string_value: "claude-sonnet-4-6" } },
                    { key: "cost_usd", value: { double_value: 0.31 } },
                    { key: "input_tokens", value: { int_value: 11 } },
                    { key: "output_tokens", value: { int_value: 6 } },
                    { key: "cache_read_tokens", value: { int_value: 3 } },
                    { key: "cache_creation_tokens", value: { int_value: 2 } },
                    { key: "request_id", value: { string_value: "req_snake" } }
                  ]
                }
              ]
            }
          ]
        }
      ]
    },
    {} as NodeJS.ProcessEnv
  );

  expect(events).toHaveLength(1);
  expect(events[0]?.requestId).toBe("req_snake");
  expect(events[0]?.estimatedCostUsd).toBe(0.31);
  expect(events[0]?.inputTokens).toBe(11);
  expect(events[0]?.cacheWriteTokens).toBe(2);
});

test("parses codex completed response OTLP log records (chatgpt => subscription)", () => {
  const events = parseCodexUsageEvents({
    resourceLogs: [
      {
        scopeLogs: [
          {
            logRecords: [
              {
                attributes: [
                  { key: "event.name", value: { stringValue: "codex.sse_event" } },
                  { key: "type", value: { stringValue: "response.completed" } },
                  { key: "model", value: { stringValue: "gpt-5.5" } },
                  { key: "auth_mode", value: { stringValue: "swic" } },
                  { key: "input_tokens", value: { intValue: 123 } },
                  { key: "output_tokens", value: { intValue: 45 } },
                  { key: "response.id", value: { stringValue: "resp_123" } }
                ]
              }
            ]
          }
        ]
      }
    ]
  });

  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    harness: "codex",
    model: "gpt-5.5",
    billingMode: "subscription",
    inputTokens: 123,
    outputTokens: 45,
    requestId: "resp_123"
  });
});
