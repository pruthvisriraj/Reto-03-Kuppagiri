import { ErrorLLM, type LlamadaHerramienta, type Mensaje, type ProveedorLLM, type ResultadoHerramienta } from "../llm/adapter.ts"
import { huellaDeCaso } from "../domain/caso.ts"
import { registrarLog, type ToolContext } from "../tools/runtime.ts"
import { ejecutarRegistrada, type Registro } from "./herramientas.ts"
import type { Sesion, TrazaHerramienta } from "./sesiones.ts"

export type ConfigCiclo = { maxIteraciones: number; maxTokensSesion: number }

export type EntradaTurno = {
  sesion: Sesion
  mensaje: string
  /** true when the user pressed the Confirm button in the UI. */
  confirmacionExplicita: boolean
  llm: ProveedorLLM
  herramientas: Registro
  systemPrompt: string
  config: ConfigCiclo
  directory: string
}

export type ResultadoTurno = {
  reply: string
  toolCalls: TrazaHerramienta[]
  needsConfirmation: boolean
  pendientes: string[]
  iteraciones: number
  tokensSesion: number
}

/** The message must open with an affirmative: "confirm", "yes, create it", "sí, confirmo", "ok". */
const AFIRMA =
  /^\s*(?:i\s+|yo\s+)?(?:yes|yeah|yep|s[ií]|conf[ií]rm\p{L}*|ok(?:ay)?|proceed|procede|adelante|go ahead|do it|dale|hazlo|de acuerdo|approved?|aprobado)(?![\p{L}\d])/iu
const NIEGA = /\b(no|not|don't|dont|cancel\w*|wait|stop|espera|todav[ií]a|a[uú]n\s+no|later|despu[eé]s)\b/i
const MENCION_DE_CASO = /\b[a-z]+-\d{2,}\b/gi
const MAX_CONTENIDO_HERRAMIENTA = 20_000

/** A message counts as confirmation only when it affirms and does not negate. */
export function esConfirmacion(texto: string): boolean {
  return AFIRMA.test(texto) && !NIEGA.test(texto)
}

export async function ejecutarTurno(e: EntradaTurno): Promise<ResultadoTurno> {
  const { sesion, config } = e
  const previos = sesion.pendiente?.casos ?? []
  const elegidos = casosConfirmados(previos.map((p) => p.caso), e.mensaje, e.confirmacionExplicita)
  // Each confirmed case carries the fingerprint of the order the analyst reviewed.
  const confirmados = new Map(previos.filter((p) => elegidos.includes(p.caso) && p.huella !== null).map((p) => [p.caso, p.huella as string]))
  sesion.pendiente = null
  sesion.mensajes.push({ rol: "user", contenido: conNotaDeConfirmacion(e.mensaje, new Set(confirmados.keys())) })

  const ctx: ToolContext = { directory: e.directory, sessionId: sesion.id, consentimientos: confirmados }
  const trazas: TrazaHerramienta[] = []
  const specs = [...e.herramientas.values()].map((h) => h.spec)
  let reply: string | null = null
  let iteraciones = 0

  while (iteraciones < config.maxIteraciones) {
    if (sesion.tokens >= config.maxTokensSesion) {
      reply = `This session reached its token budget (${config.maxTokensSesion.toLocaleString("en-US")} tokens). Start a new session to continue.`
      break
    }
    iteraciones += 1
    const respuesta = await llamarModelo(e.llm, [{ rol: "system", contenido: e.systemPrompt }, ...sesion.mensajes], specs)
    if (respuesta instanceof ErrorLLM) {
      reply = `I could not get an answer from the model: ${respuesta.message}${resumenParcial(trazas)}`
      break
    }
    sesion.tokens += respuesta.uso.entrada + respuesta.uso.salida
    sesion.mensajes.push({ rol: "assistant", contenido: respuesta.texto, llamadas: respuesta.llamadas })
    if (respuesta.llamadas.length === 0) {
      reply = respuesta.texto || "(The model returned an empty answer.)"
      return cerrarTurno(sesion, reply, trazas, iteraciones, false, e.directory)
    }
    const resultados: ResultadoHerramienta[] = []
    for (const llamada of respuesta.llamadas) {
      const traza = await ejecutarLlamada(llamada, e.herramientas, ctx, confirmados)
      trazas.push(traza.traza)
      resultados.push(traza.resultado)
    }
    sesion.mensajes.push({ rol: "tool", resultados })
  }

  reply ??= `I reached the limit of ${config.maxIteraciones} steps for this turn.${resumenParcial(trazas)}${pasosFaltantes(trazas)} Ask me to continue to finish the remaining steps.`
  return cerrarTurno(sesion, reply, trazas, iteraciones, true, e.directory)
}

/**
 * Cases the user confirms with this message. Only cases the server marked as
 * pending can be confirmed. Naming cases narrows the confirmation to them.
 */
export function casosConfirmados(pendientes: string[], mensaje: string, botonConfirmar: boolean): string[] {
  if (pendientes.length === 0 || !(botonConfirmar || esConfirmacion(mensaje))) return []
  const mencionados = [...mensaje.matchAll(MENCION_DE_CASO)].map((m) => m[0].toLowerCase())
  if (mencionados.length === 0) return pendientes
  // Naming cases narrows the confirmation. Naming only other cases confirms nothing.
  return pendientes.filter((c) => mencionados.includes(c.toLowerCase()))
}

function conNotaDeConfirmacion(mensaje: string, confirmados: Set<string>): string {
  if (confirmados.size === 0) return mensaje
  return `${mensaje}\n\n[Server note: the user explicitly confirmed the pending exceptions for: ${[...confirmados].join(", ")}.]`
}

async function llamarModelo(llm: ProveedorLLM, mensajes: Mensaje[], specs: Parameters<ProveedorLLM["enviar"]>[1]) {
  try {
    return await llm.enviar(mensajes, specs)
  } catch (error) {
    return error instanceof ErrorLLM ? error : new ErrorLLM("Unexpected error while calling the model.", "proveedor")
  }
}

/**
 * Runs one tool call. Server-side guard (CA3): a call with confirmado=true only
 * runs when the user confirmed that case in the message of this turn. A prompt
 * injection inside a document cannot make the model skip the human.
 */
async function ejecutarLlamada(llamada: LlamadaHerramienta, registro: Registro, ctx: ToolContext, confirmados: ReadonlyMap<string, string>) {
  const inicio = Date.now()
  const caso = typeof llamada.args["caso"] === "string" ? llamada.args["caso"] : null
  const herramienta = registro.get(llamada.nombre)
  let contenido: string
  let bloqueada = false
  if (!herramienta) {
    contenido = JSON.stringify({ ok: false, error: `Unknown tool ${llamada.nombre}.`, codigo: "HERRAMIENTA_DESCONOCIDA" })
    await registrarLog(ctx, { herramienta: llamada.nombre, caso, ok: false, resumen: "unknown tool" })
  } else if (llamada.args["confirmado"] === true && (caso === null || !confirmados.has(caso))) {
    bloqueada = true
    contenido = JSON.stringify({
      ok: false,
      codigo: "CONFIRMACION_NO_OTORGADA",
      error: `The user has not confirmed ${caso ?? "this case"} in the latest message. Do not retry. End the turn with an explicit confirmation question.`,
    })
    await registrarLog(ctx, { herramienta: llamada.nombre, caso, ok: false, resumen: "confirmado=true rejected by server guard" })
  } else {
    contenido = await ejecutarRegistrada(herramienta, llamada.args, ctx)
  }
  const parseado = parsear(contenido)
  const ok = esObjeto(parseado) && parseado["ok"] === true
  return {
    traza: {
      nombre: llamada.nombre,
      args: llamada.args,
      ok,
      resumen: resumir(parseado),
      resultado: parseado,
      duracionMs: Date.now() - inicio,
      bloqueadaPorGuardia: bloqueada,
    } satisfies TrazaHerramienta,
    resultado: {
      idLlamada: llamada.id,
      nombre: llamada.nombre,
      contenido: contenido.length > MAX_CONTENIDO_HERRAMIENTA ? `${contenido.slice(0, MAX_CONTENIDO_HERRAMIENTA)}...(truncated)` : contenido,
      esError: !ok,
    } satisfies ResultadoHerramienta,
  }
}

async function cerrarTurno(
  sesion: Sesion,
  reply: string,
  trazas: TrazaHerramienta[],
  iteraciones: number,
  cerrarHistorial: boolean,
  directory: string,
): Promise<ResultadoTurno> {
  if (cerrarHistorial) sesion.mensajes.push({ rol: "assistant", contenido: reply, llamadas: [] })
  const pendientes = casosPendientes(trazas)
  // Fingerprint the order each pending case produces now, which is the order the analyst just reviewed.
  const casos = await Promise.all(pendientes.map(async (caso) => ({ caso, huella: await huellaDeCaso(directory, caso) })))
  sesion.pendiente = casos.length > 0 ? { casos } : null
  return { reply, toolCalls: trazas, needsConfirmation: pendientes.length > 0, pendientes, iteraciones, tokensSesion: sesion.tokens }
}

/** Confirmation state comes from tool results, not from the model's wording. */
export function casosPendientes(trazas: TrazaHerramienta[]): string[] {
  const pendientes = new Set<string>()
  for (const t of trazas) {
    const caso = t.args["caso"]
    if (typeof caso !== "string" || !esObjeto(t.resultado)) continue
    const r = t.resultado
    const data = esObjeto(r["data"]) ? r["data"] : {}
    if (t.nombre === "oc_validar" && t.ok && data["apta"] === true && Array.isArray(data["confirmaciones"]) && data["confirmaciones"].length > 0) {
      pendientes.add(caso)
    }
    const codigo = r["codigo"]
    if (t.nombre === "oc_crear" && !t.ok && (codigo === "REQUIERE_CONFIRMACION" || codigo === "ORDEN_CAMBIADA")) pendientes.add(caso)
    if (t.nombre === "oc_crear" && t.ok) pendientes.delete(caso)
  }
  return [...pendientes]
}

function resumenParcial(trazas: TrazaHerramienta[]): string {
  if (trazas.length === 0) return ""
  const pasos = trazas.map((t) => `${t.nombre} (${t.ok ? "ok" : "error"})`).join(", ")
  return ` Steps completed in this turn: ${pasos}.`
}

const FLUJO = ["oc_leer_paquete", "oc_validar", "oc_construir_payload", "oc_generar_evidencia", "oc_crear"]

/** CA1: at the cap, list per case the standard steps still missing. Blocked cases need nothing more. */
export function pasosFaltantes(trazas: TrazaHerramienta[]): string {
  const hechos = new Map<string, Set<string>>()
  const bloqueados = new Set<string>()
  for (const t of trazas) {
    const caso = t.args["caso"]
    if (typeof caso !== "string") continue
    if (t.ok) hechos.set(caso, (hechos.get(caso) ?? new Set()).add(t.nombre))
    else hechos.set(caso, hechos.get(caso) ?? new Set())
    const data = esObjeto(t.resultado) && esObjeto(t.resultado["data"]) ? t.resultado["data"] : null
    if (t.nombre === "oc_validar" && data?.["apta"] === false) bloqueados.add(caso)
  }
  const partes: string[] = []
  for (const [caso, hecho] of hechos) {
    if (bloqueados.has(caso)) continue
    const faltan = FLUJO.filter((paso) => !hecho.has(paso))
    if (faltan.length > 0) partes.push(`${caso}: ${faltan.join(", ")}`)
  }
  return partes.length > 0 ? ` Still missing: ${partes.join(" | ")}.` : ""
}

function resumir(r: unknown): string {
  if (!esObjeto(r)) return "unreadable result"
  if (r["ok"] !== true) return typeof r["error"] === "string" ? r["error"] : "error"
  const d = esObjeto(r["data"]) ? r["data"] : {}
  const partes: string[] = []
  if (typeof d["numero_oc"] === "string") partes.push(`PO ${d["numero_oc"]}${d["idempotente"] === true ? " (existing)" : ""}`)
  if (typeof d["apta"] === "boolean") partes.push(d["apta"] ? "valid" : "blocked")
  for (const clave of ["bloqueos", "confirmaciones"] as const) {
    const lista = d[clave]
    if (Array.isArray(lista) && lista.length > 0) partes.push(`${clave}: ${lista.map((x) => (esObjeto(x) ? String(x["codigo"]) : "?")).join(", ")}`)
  }
  if (d["retroactiva"] === true) partes.push("retroactive")
  if (typeof d["sha256"] === "string") partes.push(`sha256 ${d["sha256"].slice(0, 12)}...`)
  if (typeof d["ruta_payload"] === "string") partes.push(d["ruta_payload"])
  if (esObjeto(d["solicitud"]) && typeof d["solicitud"]["solicitud_id"] === "string") partes.push(`package ${d["solicitud"]["solicitud_id"]}`)
  if (Array.isArray(d["faltantes"]) && d["faltantes"].length > 0) partes.push(`missing: ${d["faltantes"].join(", ")}`)
  return partes.join("; ") || "ok"
}

function parsear(texto: string): unknown {
  try {
    return JSON.parse(texto) as unknown
  } catch {
    return null
  }
}

function esObjeto(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}
