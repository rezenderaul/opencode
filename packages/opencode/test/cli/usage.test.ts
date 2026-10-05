import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { fetchUsage, formatResetWindow, renderHuman } from "../../src/cli/cmd/usage"

// Fork tests for task 3.1 (change fork-terminal-wsl-resiliente): the usage
// command reports the active metered plan's limits and consumption, and the
// human-readable output shows limits with reset windows.

const NOW = Date.parse("2026-10-05T09:00:00.000Z")

function saasBody() {
  return {
    usage: {
      rolling: { status: "ok", percent: 12, resetsAt: new Date(NOW + 5 * 3_600_000 + 20 * 60_000).toISOString() },
      weekly: { status: "ok", percent: 45, resetsAt: new Date(NOW + 2 * 86_400_000 + 4 * 3_600_000).toISOString() },
      monthly: { status: "rate-limited", percent: 100, resetsAt: new Date(NOW + 6 * 86_400_000).toISOString() },
    },
  }
}

function stubFetch(handler: (url: string) => Response): typeof fetch {
  return ((url: unknown) => Promise.resolve(handler(String(url)))) as typeof fetch
}

describe("usage reset windows", () => {
  test("formats seconds, minutes, hours, and days", () => {
    expect(formatResetWindow(new Date(NOW + 45_000).toISOString(), NOW)).toBe("in 45s")
    expect(formatResetWindow(new Date(NOW + 20 * 60_000).toISOString(), NOW)).toBe("in 20m")
    expect(formatResetWindow(new Date(NOW + 5 * 3_600_000).toISOString(), NOW)).toBe("in 5h")
    expect(formatResetWindow(new Date(NOW + (5 * 3_600_000 + 20 * 60_000)).toISOString(), NOW)).toBe("in 5h 20m")
    expect(formatResetWindow(new Date(NOW + 6 * 86_400_000).toISOString(), NOW)).toBe("in 6d")
    expect(formatResetWindow(new Date(NOW +  (2 * 86_400_000 + 4 * 3_600_000)).toISOString(), NOW)).toBe("in 2d 4h")
  })

  test("handles already-passed reset times", () => {
    expect(formatResetWindow(new Date(NOW - 1_000).toISOString(), NOW)).toBe("resetting now")
  })
})

describe("usage fetching", () => {
  test("reports limits and consumption from the gateway", async () => {
    const usage = await Effect.runPromise(
      fetchUsage(
        { server: "https://example.com", apiKey: "key" },
        stubFetch(() => Response.json(saasBody())),
      ),
    )
    expect(usage.rolling.percent).toBe(12)
    expect(usage.weekly.percent).toBe(45)
    expect(usage.monthly.status).toBe("rate-limited")
    expect(usage.monthly.resetsAt).toBe(saasBody().usage.monthly.resetsAt)
  })

  test("sends the metered credential as a bearer token", async () => {
    let observed = ""
    await Effect.runPromise(
      fetchUsage(
        { server: "https://example.com", apiKey: "secret-key" },
        stubFetch((url) => {
          observed = url
          return Response.json(saasBody())
        }),
      ),
    )
    expect(observed).toBe("https://example.com/zen/go/v1/usage")
  })

  test("rejected credentials fail with re-authentication guidance", async () => {
    const failure = await Effect.runPromise(
      fetchUsage({ server: "https://example.com", apiKey: "stale" }, stubFetch(() => new Response("no", { status: 401 }))).pipe(
        Effect.flip,
      ),
    )
    expect(failure.message).toContain("re-authenticate")
  })

  test("unexpected response shapes fail instead of printing garbage", async () => {
    const failure = await Effect.runPromise(
      fetchUsage({ server: "https://example.com", apiKey: "key" }, stubFetch(() => Response.json({ nope: true }))).pipe(
        Effect.flip,
      ),
    )
    expect(failure.message).toContain("unexpected response shape")
  })
})

describe("usage human-readable output", () => {
  test("shows limits with consumption and reset windows", async () => {
    const usage = await Effect.runPromise(
      fetchUsage(
        { server: "https://example.com", apiKey: "key" },
        stubFetch(() => Response.json(saasBody())),
      ),
    )
    const out = renderHuman(usage, NOW)
    expect(out).toContain("12%")
    expect(out).toContain("45%")
    expect(out).toContain("100%")
    expect(out).toContain("in 5h 20m")
    expect(out).toContain("in 2d 4h")
    expect(out).toContain("in 6d")
    expect(out).toContain("RATE LIMITED")
  })
})
