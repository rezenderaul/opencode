import { EOL } from "os"
import { Effect, Schema } from "effect"
import { Auth, AuthError } from "@/auth"
import { effectCmd, fail } from "../effect-cmd"
import { UI } from "../ui"

// Fork (change fork-terminal-wsl-resiliente, task 3.1): the `usage` command
// reports the active metered plan's limits and consumption so a provider
// rotator can decide when and where to rotate. Human-readable output here;
// `--format json` arrives in task 3.2 and reuses fetchUsage + the same data.

// Same default as the opencode provider plugin
// (packages/core/src/plugin/provider/opencode.ts): the credential metadata
// may override it for enterprise servers.
const DEFAULT_SERVER = "https://opencode.ai/console"

class UsageWindow extends Schema.Class<UsageWindow>("UsageWindow")({
  status: Schema.Union([Schema.Literal("ok"), Schema.Literal("rate-limited")]),
  percent: Schema.Number,
  resetsAt: Schema.String,
}) {}

class UsageResponse extends Schema.Class<UsageResponse>("UsageResponse")({
  usage: Schema.Struct({
    rolling: UsageWindow,
    weekly: UsageWindow,
    monthly: UsageWindow,
  }),
}) {}

export interface ResolvedCredential {
  readonly server: string
  readonly apiKey: string
}

export const resolveCredential = Effect.fn("Cli.usage.resolveCredential")(function* () {
  if (process.env.OPENCODE_API_KEY) return { server: DEFAULT_SERVER, apiKey: process.env.OPENCODE_API_KEY }
  const auth = yield* Auth.Service
  const stored = yield* auth.get("opencode")
  if (stored?.type === "api") {
    const server = stored.metadata?.server ?? DEFAULT_SERVER
    return { server, apiKey: stored.key }
  }
  if (stored?.type === "oauth") return { server: DEFAULT_SERVER, apiKey: stored.access }
  return undefined
})

export const fetchUsage = Effect.fn("Cli.usage.fetchUsage")(function* (
  credential: ResolvedCredential,
  fetcher: typeof fetch = fetch,
) {
  const response = yield* Effect.tryPromise({
    try: () =>
      fetcher(`${credential.server}/zen/go/v1/usage`, {
        headers: { authorization: `Bearer ${credential.apiKey}`, accept: "application/json" },
        signal: AbortSignal.timeout(30_000),
      }),
    catch: () => new Error(`could not reach the usage endpoint at ${credential.server}`),
  })
  if (response.status === 401 || response.status === 403) {
    return yield* Effect.fail(
      new Error("the server rejected these credentials — run `opencode auth login` to re-authenticate"),
    )
  }
  if (!response.ok) return yield* Effect.fail(new Error(`usage endpoint returned HTTP ${response.status}`))
  const json = (yield* Effect.tryPromise({
    try: () => response.json(),
    catch: () => new Error("usage endpoint returned an unreadable response"),
  })) as unknown
  return yield* Effect.try({
    try: () => Schema.decodeUnknownSync(UsageResponse)(json).usage,
    catch: () => new Error("usage endpoint returned an unexpected response shape"),
  })
})

export function formatResetWindow(resetsAt: string, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.ceil((Date.parse(resetsAt) - now) / 1000))
  if (seconds <= 0) return "resetting now"
  if (seconds < 60) return `in ${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `in ${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return minutes % 60 === 0 ? `in ${hours}h` : `in ${hours}h ${minutes % 60}m`
  const days = Math.floor(hours / 24)
  return hours % 24 === 0 ? `in ${days}d` : `in ${days}d ${hours % 24}h`
}

export function renderHuman(usage: UsageResponse["usage"], now: number = Date.now()): string {
  const line = (name: string, window: UsageWindow) => {
    const state = window.status === "rate-limited" ? "RATE LIMITED" : "ok"
    return `${name.padEnd(8)} ${window.percent}% used · ${state} · resets ${formatResetWindow(window.resetsAt, now)}`
  }
  return [
    "Usage — metered plan",
    line("rolling", usage.rolling),
    line("weekly", usage.weekly),
    line("monthly", usage.monthly),
  ].join(EOL)
}

export const UsageCommand = effectCmd({
  command: "usage",
  describe: "show active plan limits and consumption",
  handler: Effect.fn("Cli.usage")(function* () {
    const credential = yield* resolveCredential().pipe(Effect.catch((error: AuthError) => fail(error.message)))
    if (!credential) {
      UI.println("No metered plan found. Log in to check plan usage: opencode auth login")
      return
    }
    const usage = yield* fetchUsage(credential).pipe(Effect.catch((error: Error) => fail(error.message)))
    process.stdout.write(renderHuman(usage) + EOL)
  }),
})
