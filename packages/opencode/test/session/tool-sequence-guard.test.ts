import { describe, expect, test } from "bun:test"
import type { ModelMessage } from "ai"
import { sanitizeOrphanedToolParts } from "../../src/session/message-v2"

// Fork regression test for upstream anomalyco/opencode#53109: the retained
// context tail can start in the middle of a tool-call group, so the lowered
// outgoing window carries a tool-result whose tool-call was cut off. Strict
// OpenAI-compatible gateways reject that with HTTP 400 (invalid_request_error)
// until the orphan leaves the window.

const assistantWithCall: ModelMessage = {
  role: "assistant",
  content: [
    { type: "text", text: "done" },
    { type: "tool-call", toolCallId: "call-1", toolName: "bash", input: { cmd: "ls" } },
  ],
}

const validResult: ModelMessage = {
  role: "tool",
  content: [{ type: "tool-result", toolCallId: "call-1", toolName: "bash", output: { type: "text", value: "ok" } }],
}

const orphanResult: ModelMessage = {
  role: "tool",
  content: [{ type: "tool-result", toolCallId: "call-cut-off", toolName: "bash", output: { type: "text", value: "stale" } }],
}

function gatewayValid(messages: readonly ModelMessage[]) {
  const calls = new Set<string>()
  for (const message of messages) {
    if (typeof message.content === "string" || !Array.isArray(message.content)) continue
    for (const part of message.content) {
      if (part.type === "tool-call") calls.add(part.toolCallId)
    }
  }
  for (const message of messages) {
    if (typeof message.content === "string" || !Array.isArray(message.content)) continue
    for (const part of message.content) {
      if (part.type === "tool-result" && !calls.has(part.toolCallId)) return false
    }
  }
  return true
}

describe("sanitizeOrphanedToolParts", () => {
  test("drops orphaned tool results and keeps valid pairs", () => {
    const input: ModelMessage[] = [assistantWithCall, validResult, orphanResult]
    const sanitized = sanitizeOrphanedToolParts(input)
    expect(sanitized).toStrictEqual([assistantWithCall, validResult])
    // Stored history is untouched: the input still carries the orphan.
    expect(input).toStrictEqual([assistantWithCall, validResult, orphanResult])
  })

  test("leaves windows without orphans untouched", () => {
    const input: ModelMessage[] = [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      assistantWithCall,
      validResult,
    ]
    expect(sanitizeOrphanedToolParts(input)).toStrictEqual(input)
  })

  test("mid-group tail cut stays gateway-valid after sanitize", () => {
    // Deterministic repro: a valid window whose head (the tool-call side) is
    // cut off, exactly what a retained tail starting mid-group produces.
    const fullWindow: ModelMessage[] = [assistantWithCall, validResult, orphanResult]
    const cutWindow = fullWindow.slice(1)
    expect(gatewayValid(cutWindow)).toBe(false)
    const sanitized = sanitizeOrphanedToolParts(cutWindow)
    expect(gatewayValid(sanitized)).toBe(true)
    expect(sanitized).toStrictEqual([])
  })

  test("keeps text parts of a message that also carried an orphan", () => {
    const mixed: ModelMessage = {
      role: "assistant",
      content: [
        { type: "text", text: "keep me" },
        { type: "tool-result", toolCallId: "call-gone", toolName: "bash", output: { type: "text", value: "x" } },
      ],
    }
    expect(sanitizeOrphanedToolParts([mixed])).toStrictEqual([
      { role: "assistant", content: [{ type: "text", text: "keep me" }] },
    ])
  })
})
