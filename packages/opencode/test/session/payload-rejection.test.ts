import { describe, expect, test } from "bun:test"
import { APICallError } from "ai"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { MessageV2 } from "../../src/session/message-v2"
import { ProviderError } from "../../src/provider/error"

// Fork contract tests for task 2.2 (upstream anomalyco/opencode#53107):
// an HTTP 413 payload rejection MUST classify as context overflow so the
// run loop takes the overflow-compaction recovery path instead of bricking
// the session. Live-gateway loop verification is deferred to task 7.1.

const providerID = ProviderV2.ID.make("test")

function apiCallError(statusCode: number, message: string) {
  return new APICallError({
    message,
    url: "https://example.com",
    requestBodyValues: {},
    statusCode,
    responseHeaders: { "content-type": "application/json" },
    isRetryable: false,
  })
}

describe("payload rejection recovery contract", () => {
  test("413 with a non-overflow message still classifies as context overflow", () => {
    // "Payload Too Large" matches none of the message-text patterns: only the
    // statusCode === 413 branch can classify this.
    const parsed = ProviderError.parseAPICallError({
      providerID,
      error: apiCallError(413, "Payload Too Large"),
    })
    expect(parsed.type).toBe("context_overflow")
  })

  test("413 surfaces as ContextOverflowError at the session boundary", () => {
    const result = MessageV2.fromError(apiCallError(413, "Request Entity Too Large"), { providerID })
    expect(SessionV1.ContextOverflowError.isInstance(result)).toBe(true)
  })

  test("same shape without 413 is not context overflow", () => {
    const result = MessageV2.fromError(apiCallError(500, "Internal Server Error"), { providerID })
    expect(SessionV1.ContextOverflowError.isInstance(result)).toBe(false)
    expect(SessionV1.APIError.isInstance(result)).toBe(true)
  })
})
