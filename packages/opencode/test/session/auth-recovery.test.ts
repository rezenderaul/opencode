import { describe, expect, test } from "bun:test"
import { APICallError, LoadAPIKeyError } from "ai"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { MessageV2 } from "../../src/session/message-v2"
import { AuthError } from "../../src/session/message-error"
import { ProviderError } from "../../src/provider/error"
import { SessionRetry } from "../../src/session/retry"

// Fork contract tests for task 2.3 (upstream anomalyco/opencode#53106):
// authentication failures MUST fail fast as auth errors — never burn retries,
// never trigger compaction — so the session stays open and the user can
// re-authenticate in place and continue with prior context intact.
// Session-continuity through the run loop is covered by the processor test in
// processor-effect.test.ts ("recovers the same session after re-authentication").

const providerID = ProviderV2.ID.make("test")

function apiCallError(statusCode: number, message: string, isRetryable = false) {
  return new APICallError({
    message,
    url: "https://example.com",
    requestBodyValues: {},
    statusCode,
    responseHeaders: { "content-type": "application/json" },
    isRetryable,
  })
}

describe("auth recovery contract", () => {
  test("missing credentials classify as AuthError at the session boundary", () => {
    const result = MessageV2.fromError(new LoadAPIKeyError({ message: "No API key provided" }), { providerID })
    expect(AuthError.isInstance(result)).toBe(true)
    expect(SessionV1.ContextOverflowError.isInstance(result)).toBe(false)
  })

  test("AuthError never burns retries", () => {
    const error = new AuthError({ providerID: "test", message: "No API key provided" }).toObject()
    expect(SessionRetry.retryable(error, "test")).toBeUndefined()
  })

  test("expired credentials (401) never burn retries", () => {
    const parsed = ProviderError.parseAPICallError({
      providerID,
      error: apiCallError(401, "Unauthorized"),
    })
    expect(parsed.type).toBe("api_error")
    if (parsed.type !== "api_error") return
    expect(parsed.isRetryable).toBe(false)
    const result = MessageV2.fromError(apiCallError(401, "Unauthorized"), { providerID })
    expect(SessionV1.APIError.isInstance(result)).toBe(true)
    expect(SessionV1.ContextOverflowError.isInstance(result)).toBe(false)
    expect(SessionRetry.retryable(result, "test")).toBeUndefined()
  })

  test("401 keeps its status code so the client can prompt re-authentication", () => {
    const result = MessageV2.fromError(apiCallError(401, "Unauthorized"), { providerID })
    expect(SessionV1.APIError.isInstance(result)).toBe(true)
    if (!SessionV1.APIError.isInstance(result)) return
    expect(result.data.statusCode).toBe(401)
  })
})
