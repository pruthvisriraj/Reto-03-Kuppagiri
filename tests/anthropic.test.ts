import { describe, expect, test } from "bun:test"
import { ErrorLLM, type Mensaje } from "../src/llm/adapter.ts"
import { aMensajesAnthropic, construirCuerpo, ProveedorAnthropic } from "../src/llm/anthropic.ts"

const HERRAMIENTAS = [{ nombre: "oc_validar", descripcion: "Validates a case.", parametros: { $schema: "x", type: "object", properties: { caso: { type: "string" } } } }]

const HISTORIAL: Mensaje[] = [
  { rol: "system", contenido: "system prompt" },
  { rol: "user", contenido: "Process sol-001" },
  { rol: "assistant", contenido: "", llamadas: [{ id: "t1", nombre: "oc_validar", args: { caso: "sol-001" } }] },
  { rol: "tool", resultados: [{ idLlamada: "t1", nombre: "oc_validar", contenido: '{"ok":true}', esError: false }] },
  { rol: "user", contenido: "and sol-002" },
]

function respuestaJson(cuerpo: unknown, estado = 200): Response {
  return new Response(JSON.stringify(cuerpo), { status: estado, headers: { "content-type": "application/json" } })
}

describe("Anthropic adapter", () => {
  test("maps neutral messages: system apart, tool results as user turn, same-role turns merged", () => {
    const turnos = aMensajesAnthropic(HISTORIAL)
    expect(turnos.map((t) => t.role)).toEqual(["user", "assistant", "user"])
    expect(turnos[2]?.content.map((b) => b.type)).toEqual(["tool_result", "text"])
    const cuerpo = construirCuerpo("claude-sonnet-5", 1024, HISTORIAL, HERRAMIENTAS)
    expect(cuerpo.system[0]?.text).toBe("system prompt")
    expect(cuerpo.system[0]?.cache_control).toEqual({ type: "ephemeral" })
    expect(cuerpo.tools[0]?.input_schema).not.toHaveProperty("$schema")
  })

  test("sends the key only as a header and parses tool calls and usage", async () => {
    let vistos: { headers: Record<string, string>; body: string } | null = null
    const fetchFalso = (async (_url: string | URL | Request, init?: RequestInit) => {
      vistos = { headers: init?.headers as Record<string, string>, body: String(init?.body) }
      return respuestaJson({
        content: [{ type: "text", text: "Checking." }, { type: "tool_use", id: "tu_1", name: "oc_validar", input: { caso: "sol-002" } }],
        stop_reason: "tool_use",
        usage: { input_tokens: 1200, output_tokens: 80, cache_read_input_tokens: 3000 },
      })
    }) as typeof fetch
    const p = new ProveedorAnthropic({ apiKey: "sk-test-123", modelo: "claude-sonnet-5", timeoutMs: 5000, maxTokensSalida: 1024, fetch: fetchFalso })
    const r = await p.enviar(HISTORIAL, HERRAMIENTAS)
    expect(r.llamadas).toEqual([{ id: "tu_1", nombre: "oc_validar", args: { caso: "sol-002" } }])
    expect(r.uso).toEqual({ entrada: 4200, salida: 80 })
    expect(r.motivoFin).toBe("herramientas")
    const v = vistos as { headers: Record<string, string>; body: string } | null
    expect(v?.headers["x-api-key"]).toBe("sk-test-123")
    expect(v?.body).not.toContain("sk-test-123")
  })

  test("401 becomes an authentication error without leaking the key", async () => {
    const fetchFalso = (async () => respuestaJson({ error: { type: "authentication_error", message: "invalid x-api-key" } }, 401)) as unknown as typeof fetch
    const p = new ProveedorAnthropic({ apiKey: "sk-secret", modelo: "m", timeoutMs: 5000, maxTokensSalida: 256, fetch: fetchFalso })
    const error = await p.enviar(HISTORIAL, HERRAMIENTAS).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ErrorLLM)
    expect((error as ErrorLLM).tipo).toBe("autenticacion")
    expect((error as ErrorLLM).message).not.toContain("sk-secret")
  })

  test("a slow provider becomes a timeout error", async () => {
    const lento = ((_: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolver, rechazar) => {
        init?.signal?.addEventListener("abort", () => rechazar(new DOMException("aborted", "AbortError")))
      })) as typeof fetch
    const p = new ProveedorAnthropic({ apiKey: "k", modelo: "m", timeoutMs: 50, maxTokensSalida: 256, fetch: lento })
    const error = await p.enviar(HISTORIAL, HERRAMIENTAS).catch((e: unknown) => e)
    expect((error as ErrorLLM).tipo).toBe("timeout")
  })

  test("missing key fails at construction with a configuration error", () => {
    expect(() => new ProveedorAnthropic({ apiKey: "", modelo: "m", timeoutMs: 1000, maxTokensSalida: 256 })).toThrow(ErrorLLM)
  })
})
