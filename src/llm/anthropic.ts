import { z } from "zod"
import {
  ErrorLLM,
  type EspecificacionHerramienta,
  type LlamadaHerramienta,
  type Mensaje,
  type ProveedorLLM,
  type RespuestaLLM,
} from "./adapter.ts"

const URL_API = "https://api.anthropic.com/v1/messages"
const VERSION_API = "2023-06-01"

export type OpcionesAnthropic = {
  apiKey: string
  modelo: string
  timeoutMs: number
  maxTokensSalida: number
  fetch?: typeof fetch
}

type BloqueContenido =
  | { type: "text"; text: string; cache_control?: { type: "ephemeral" } }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean }

type MensajeAnthropic = { role: "user" | "assistant"; content: BloqueContenido[] }

const RespuestaSchema = z.object({
  content: z.array(
    z.union([
      z.object({ type: z.literal("text"), text: z.string() }),
      z.object({ type: z.literal("tool_use"), id: z.string(), name: z.string(), input: z.record(z.string(), z.unknown()) }),
      z.object({ type: z.string() }),
    ]),
  ),
  stop_reason: z.string().nullable(),
  usage: z.object({
    input_tokens: z.number(),
    output_tokens: z.number(),
    cache_read_input_tokens: z.number().nullish(),
    cache_creation_input_tokens: z.number().nullish(),
  }),
})

const ErrorApiSchema = z.object({ error: z.object({ type: z.string(), message: z.string() }) })

export class ProveedorAnthropic implements ProveedorLLM {
  readonly nombre = "anthropic"
  readonly modelo: string
  private readonly fetchFn: typeof fetch

  constructor(private readonly opciones: OpcionesAnthropic) {
    if (!opciones.apiKey) throw new ErrorLLM("ANTHROPIC_API_KEY is not set on the server.", "configuracion")
    this.modelo = opciones.modelo
    this.fetchFn = opciones.fetch ?? fetch
  }

  async enviar(mensajes: Mensaje[], herramientas: EspecificacionHerramienta[]): Promise<RespuestaLLM> {
    const cuerpo = construirCuerpo(this.modelo, this.opciones.maxTokensSalida, mensajes, herramientas)
    const control = new AbortController()
    const temporizador = setTimeout(() => control.abort(), this.opciones.timeoutMs)
    let respuesta: Response
    try {
      respuesta = await this.fetchFn(URL_API, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": this.opciones.apiKey, "anthropic-version": VERSION_API },
        body: JSON.stringify(cuerpo),
        signal: control.signal,
      })
    } catch (e) {
      if (control.signal.aborted) {
        throw new ErrorLLM(`The model did not answer within ${Math.round(this.opciones.timeoutMs / 1000)} seconds. Try again.`, "timeout")
      }
      throw new ErrorLLM("Could not reach the model provider. Check the network and try again.", "proveedor")
    } finally {
      clearTimeout(temporizador)
    }
    if (!respuesta.ok) throw await errorDeEstado(respuesta)
    return interpretar(await respuesta.json().catch(() => null))
  }
}

export function construirCuerpo(modelo: string, maxTokens: number, mensajes: Mensaje[], herramientas: EspecificacionHerramienta[]) {
  const system = mensajes.flatMap((m) => (m.rol === "system" ? [m.contenido] : [])).join("\n\n")
  const tools = herramientas.map((h, i) => ({
    name: h.nombre,
    description: h.descripcion,
    input_schema: sinMetaEsquema(h.parametros),
    ...(i === herramientas.length - 1 ? { cache_control: { type: "ephemeral" as const } } : {}),
  }))
  return {
    model: modelo,
    max_tokens: maxTokens,
    system: [{ type: "text" as const, text: system, cache_control: { type: "ephemeral" as const } }],
    tools,
    messages: aMensajesAnthropic(mensajes),
  }
}

/** Maps neutral messages to Anthropic turns and merges consecutive turns of the same role. */
export function aMensajesAnthropic(mensajes: Mensaje[]): MensajeAnthropic[] {
  const salida: MensajeAnthropic[] = []
  for (const m of mensajes) {
    const turno = aTurno(m)
    if (!turno) continue
    const anterior = salida.at(-1)
    if (anterior && anterior.role === turno.role) anterior.content.push(...turno.content)
    else salida.push(turno)
  }
  return salida
}

function aTurno(m: Mensaje): MensajeAnthropic | null {
  switch (m.rol) {
    case "system":
      return null
    case "user":
      return { role: "user", content: [{ type: "text", text: m.contenido || "(empty message)" }] }
    case "assistant": {
      const bloques: BloqueContenido[] = []
      if (m.contenido.trim()) bloques.push({ type: "text", text: m.contenido })
      for (const l of m.llamadas) bloques.push({ type: "tool_use", id: l.id, name: l.nombre, input: l.args })
      if (bloques.length === 0) bloques.push({ type: "text", text: "(no text)" })
      return { role: "assistant", content: bloques }
    }
    case "tool":
      return {
        role: "user",
        content: m.resultados.map((r) => ({ type: "tool_result", tool_use_id: r.idLlamada, content: r.contenido, is_error: r.esError })),
      }
  }
}

function interpretar(json: unknown): RespuestaLLM {
  const parsed = RespuestaSchema.safeParse(json)
  if (!parsed.success) throw new ErrorLLM("The model returned a response in an unexpected format.", "respuesta_invalida")
  const r = parsed.data
  const texto: string[] = []
  const llamadas: LlamadaHerramienta[] = []
  for (const b of r.content) {
    if (b.type === "text" && "text" in b) texto.push(b.text)
    else if (b.type === "tool_use" && "id" in b && "name" in b && "input" in b) llamadas.push({ id: b.id, nombre: b.name, args: b.input })
  }
  const u = r.usage
  return {
    texto: texto.join("\n").trim(),
    llamadas,
    uso: { entrada: u.input_tokens + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0), salida: u.output_tokens },
    motivoFin: r.stop_reason === "tool_use" ? "herramientas" : r.stop_reason === "end_turn" ? "fin" : r.stop_reason === "max_tokens" ? "limite_tokens" : "otro",
  }
}

async function errorDeEstado(r: Response): Promise<ErrorLLM> {
  const detalle = ErrorApiSchema.safeParse(await r.json().catch(() => null))
  const mensaje = detalle.success ? detalle.data.error.message.slice(0, 200) : `HTTP ${r.status}`
  if (r.status === 401 || r.status === 403) return new ErrorLLM("The model provider rejected the API key. Check ANTHROPIC_API_KEY on the server.", "autenticacion")
  if (r.status === 429) return new ErrorLLM("The model provider is rate limiting requests. Wait a minute and try again.", "limite_tasa")
  if (r.status >= 500) return new ErrorLLM("The model provider is unavailable right now. Try again in a moment.", "proveedor")
  return new ErrorLLM(`The model provider rejected the request: ${mensaje}`, "proveedor")
}

function sinMetaEsquema(esquema: Record<string, unknown>): Record<string, unknown> {
  const { $schema: _omitido, ...resto } = esquema
  return { type: "object", ...resto }
}
