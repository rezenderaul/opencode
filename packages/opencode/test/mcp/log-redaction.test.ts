import { describe, expect, test } from "bun:test"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import { GetPromptRequestSchema, ListPromptsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Logger } from "effect"
import { McpCatalog } from "@/mcp/catalog"
import { MCP } from "../../src/mcp/index"
import { testEffect } from "../lib/effect"

// Fork regression tests for task 2.4 (upstream anomalyco/opencode#53051):
// an MCP server can echo configured secrets in error text. The engine log
// must carry a fixed message plus safe metadata only — never the secret.
// Capturing the structured log entries is stronger than reading the flushed
// file: a value that never enters the logging pipeline can never reach the
// flushed opencode.log.

const SECRET = "FAKE_MCP_LOG_SECRET_ONLY"

type Logged = Array<unknown>

function collector(seen: Logged) {
  return Logger.make((opts) => {
    seen.push(opts.message)
  })
}

function text(seen: Logged) {
  return JSON.stringify(seen)
}

function entriesWith(seen: Logged, message: string) {
  return seen.filter(
    (entry): entry is [unknown, ...Array<unknown>] =>
      Array.isArray(entry) && entry.some((part) => part === message),
  )
}

describe("mcp error metadata", () => {
  test("drops free-text messages but keeps error name and code", () => {
    const serverError = new Error(`list failed: ${SECRET}`) as Error & { code: number }
    serverError.name = "McpError"
    serverError.code = -32603
    expect(McpCatalog.errorMeta(serverError)).toEqual({ errorName: "McpError", errorCode: -32603 })
  })

  test("never stringifies unknown failures", () => {
    expect(McpCatalog.errorMeta(`raw string ${SECRET}`)).toEqual({ errorName: "UnknownError" })
  })
})

test("failed list logging keeps the secret out of the engine log", async () => {
  const seen: Logged = []
  await Effect.runPromise(
    McpCatalog.fetch("secret-server", {} as never, () => Promise.reject(new Error(`boom ${SECRET}`)), "prompts").pipe(
      Effect.provide(Logger.layer([collector(seen)])),
    ),
  )
  expect(text(seen)).not.toContain(SECRET)
  const entries = entriesWith(seen, "failed to get prompts")
  expect(entries.length).toBeGreaterThan(0)
  expect(text(entries)).toContain("secret-server")
  expect(text(entries)).toContain("Error")
})

const it = testEffect(LayerNode.compile(MCP.node))

// Echo-error server in the shape of the issue repro: every request handler
// answers with an error carrying the configured secret value.
function echoErrorServer() {
  return Effect.acquireRelease(
    Effect.promise(async () => {
      const protocol = new Server({ name: "echo-error", version: "1.0.0" }, { capabilities: { prompts: {} } })
      protocol.setRequestHandler(ListPromptsRequestSchema, () => {
        throw new Error(`list failed: ${SECRET}`)
      })
      protocol.setRequestHandler(GetPromptRequestSchema, () => {
        throw new Error(`get failed: ${SECRET}`)
      })
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        enableJsonResponse: true,
      })
      await protocol.connect(transport)
      const http = Bun.serve({
        port: 0,
        fetch: (request) => transport.handleRequest(request),
      })
      return {
        url: http.url.toString(),
        close: async () => {
          await protocol.close().catch(() => {})
          http.stop(true)
        },
      }
    }),
    (server) => Effect.promise(server.close),
  )
}

it.instance("echoing server errors never reach the engine log", () =>
  Effect.gen(function* () {
    const seen: Logged = []
    yield* Effect.provide(
      Effect.gen(function* () {
        const server = yield* echoErrorServer()
        const mcp = yield* MCP.Service
        yield* mcp.add("echo-error", { type: "remote", url: server.url, oauth: false })

        // List path (McpCatalog.fetch sink) and single-request path
        // (withClient sink) both fail with the secret-bearing server error.
        yield* mcp.prompts()
        yield* mcp.getPrompt("echo-error", "anything")
      }),
      Logger.layer([collector(seen)]),
    )

    expect(text(seen)).not.toContain(SECRET)
    const lists = entriesWith(seen, "failed to get prompts")
    const singles = entriesWith(seen, "failed to getPrompt")
    expect(lists.length).toBeGreaterThan(0)
    expect(singles.length).toBeGreaterThan(0)
    expect(text([...lists, ...singles])).toContain("echo-error")
  }),
)
