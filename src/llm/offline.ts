/**
 * Scripted provider with no network access. It follows the same tool sequence
 * the real model follows and writes answers only from tool results.
 * Uses: automated tests of the agent loop, and a keyless local demo
 * (LLM_PROVIDER=offline). It is a test double, not a production model.
 */
import { z } from "zod"
import type { EspecificacionHerramienta, LlamadaHerramienta, Mensaje, ProveedorLLM, RespuestaLLM } from "./adapter.ts"

const ValidacionSchema = z.object({
  ok: z.literal(true),
  data: z.object({
    apta: z.boolean(),
    retroactiva: z.boolean(),
    bloqueos: z.array(z.object({ codigo: z.string(), detalle: z.string(), accion_sugerida: z.string() })),
    confirmaciones: z.array(z.object({ codigo: z.string(), detalle: z.string() })),
    controles: z.array(z.object({ codigo: z.string(), resultado: z.string(), detalle: z.string() })),
    advertencias: z.array(z.string()),
  }),
})

const PayloadSchema = z.object({
  ok: z.literal(true),
  data: z.object({
    orden: z.object({
      proveedor: z.object({ codigo_sap: z.string(), nombre: z.string() }),
      moneda: z.string(),
      condiciones_pago: z.string(),
      aprobador: z.object({ email: z.string() }),
      posiciones: z.array(
        z.object({ descripcion: z.string(), cantidad: z.number(), unidad: z.string(), precio_unitario: z.number(), centro_costo: z.string(), subarea: z.string(), indicador_iva: z.string() }),
      ),
    }),
  }),
})

const CreacionSchema = z.union([
  z.object({ ok: z.literal(true), data: z.object({ numero_oc: z.string(), idempotente: z.boolean(), retroactiva: z.boolean(), ruta_evidencia: z.string().optional() }) }),
  z.object({ ok: z.literal(false), error: z.string() }),
])

const ErrorSchema = z.object({ ok: z.literal(false), error: z.string() })

const NOTA_SERVIDOR = /\[Server note: the user explicitly confirmed the pending exceptions for: ([^\]]+?)\.\]/
const CONFIRMA = /\b(confirm|confirmed|confirmo|yes|s[ií]|proceed|procede|go ahead|approve)\b/i
const NO_CREAR = /\b(don't|do not|not)\b.*\b(create|crear)\b|\bno la crees\b|\buntil i confirm\b/i

export class ProveedorOffline implements ProveedorLLM {
  readonly nombre = "offline"
  readonly modelo = "scripted-v1"
  private contador = 0

  async enviar(mensajes: Mensaje[], _herramientas: EspecificacionHerramienta[]): Promise<RespuestaLLM> {
    const iUsuario = mensajes.findLastIndex((m) => m.rol === "user")
    const usuario = mensajes[iUsuario]
    const textoCompleto = usuario?.rol === "user" ? usuario.contenido : ""
    const nota = NOTA_SERVIDOR.exec(textoCompleto)
    const textoUsuario = textoCompleto.replace(NOTA_SERVIDOR, "").trim()
    const turno = resultadosDelTurno(mensajes.slice(iUsuario + 1))

    if (nota?.[1]) return this.pasoConfirmacion(nota[1].split(/,\s*/), turno)
    const casos = casosDelTexto(textoUsuario)
    if (casos.length > 0) return this.pasoVarios(casos, turno, NO_CREAR.test(textoUsuario))
    if (CONFIRMA.test(textoUsuario)) {
      // The user says "confirm" but the server saw nothing pending. Try anyway: the server guard must reject it.
      const previo = ultimoCaso(mensajes.slice(0, iUsuario))
      if (previo) return this.pasoConfirmacion([previo], turno)
    }
    return this.texto("Tell me which case to process, for example sol-001.")
  }

  private pasoConfirmacion(casos: string[], turno: Map<string, unknown>): RespuestaLLM {
    const siguiente = casos.find((c) => !turno.has(clave("oc_crear", c)))
    if (siguiente) return this.llamar("oc_crear", { caso: siguiente, confirmado: true })
    return this.texto(casos.map((c) => textoCreacion(c, turno.get(clave("oc_crear", c)))).join("\n\n"))
  }

  /** Advances every case one step per model call, as a model with parallel tool calls would. */
  private pasoVarios(casos: string[], turno: Map<string, unknown>, noCrear: boolean): RespuestaLLM {
    const llamadas: LlamadaHerramienta[] = []
    const textos: string[] = []
    for (const caso of casos) {
      const paso = this.pasoProceso(caso, turno, noCrear)
      if (paso.llamadas.length > 0) llamadas.push(...paso.llamadas)
      else textos.push(paso.texto)
    }
    if (llamadas.length > 0) return { texto: "", llamadas, uso: { entrada: 0, salida: 0 }, motivoFin: "herramientas" }
    return this.texto(textos.join("\n\n"))
  }

  private pasoProceso(caso: string, turno: Map<string, unknown>, noCrear: boolean): RespuestaLLM {
    const r = (nombre: string) => turno.get(clave(nombre, caso))
    const hecho = (nombre: string) => turno.has(clave(nombre, caso))
    if (!hecho("oc_leer_paquete")) return this.llamar("oc_leer_paquete", { caso })
    const lectura = ErrorSchema.safeParse(r("oc_leer_paquete"))
    if (lectura.success) return this.texto(`I could not read ${caso}: ${lectura.data.error}`)
    if (!hecho("oc_validar")) return this.llamar("oc_validar", { caso })
    const v = ValidacionSchema.safeParse(r("oc_validar"))
    if (!v.success) return this.texto(`Validation of ${caso} failed. See the tool result above.`)
    if (!v.data.data.apta) return this.texto(textoBloqueo(caso, v.data.data))
    if (!hecho("oc_construir_payload")) return this.llamar("oc_construir_payload", { caso })
    if (!hecho("oc_generar_evidencia")) return this.llamar("oc_generar_evidencia", { caso })
    const pendiente = v.data.data.confirmaciones.length > 0
    if (!pendiente && !noCrear && !hecho("oc_crear")) return this.llamar("oc_crear", { caso })
    return this.texto(textoResumen(caso, v.data.data, r("oc_construir_payload"), r("oc_crear"), hecho("oc_crear")))
  }

  private llamar(nombre: string, args: Record<string, unknown>): RespuestaLLM {
    this.contador += 1
    const llamada: LlamadaHerramienta = { id: `offline-${this.contador}`, nombre, args }
    return { texto: "", llamadas: [llamada], uso: { entrada: 0, salida: 0 }, motivoFin: "herramientas" }
  }

  private texto(texto: string): RespuestaLLM {
    return { texto, llamadas: [], uso: { entrada: 0, salida: 0 }, motivoFin: "fin" }
  }
}

/** "sol-001", "sol-001 and sol-004", or a range "sol-001 to sol-006". */
function casosDelTexto(texto: string): string[] {
  const rango = /sol-(\d{3})\s*(?:to|a|hasta|-)\s*sol-(\d{3})/i.exec(texto)
  if (rango?.[1] && rango[2]) {
    const desde = Number(rango[1])
    const hasta = Number(rango[2])
    if (hasta >= desde && hasta - desde < 50) {
      return Array.from({ length: hasta - desde + 1 }, (_, i) => `sol-${String(desde + i).padStart(3, "0")}`)
    }
  }
  return [...new Set([...texto.matchAll(/sol-\d{3}/gi)].map((m) => m[0].toLowerCase()))]
}

const clave = (nombre: string, caso: string) => `${nombre}|${caso}`

/** Tool results of the current turn, keyed by tool name and case. */
function resultadosDelTurno(mensajes: Mensaje[]): Map<string, unknown> {
  const casoPorLlamada = new Map<string, string>()
  const mapa = new Map<string, unknown>()
  for (const m of mensajes) {
    if (m.rol === "assistant") {
      for (const l of m.llamadas) if (typeof l.args["caso"] === "string") casoPorLlamada.set(l.id, l.args["caso"])
    }
    if (m.rol !== "tool") continue
    for (const r of m.resultados) mapa.set(clave(r.nombre, casoPorLlamada.get(r.idLlamada) ?? ""), parsear(r.contenido))
  }
  return mapa
}

function ultimoCaso(mensajes: Mensaje[]): string | null {
  for (let i = mensajes.length - 1; i >= 0; i--) {
    const m = mensajes[i]
    if (m?.rol !== "assistant") continue
    const caso = m.llamadas.map((l) => l.args["caso"]).find((c): c is string => typeof c === "string")
    if (caso) return caso
  }
  return null
}

function parsear(texto: string): unknown {
  try {
    return JSON.parse(texto) as unknown
  } catch {
    return null
  }
}

type DatosValidacion = z.infer<typeof ValidacionSchema>["data"]

function textoBloqueo(caso: string, v: DatosValidacion): string {
  const filas = v.bloqueos.map((b) => `| ${b.codigo} | ${b.detalle} | ${b.accion_sugerida} |`).join("\n")
  return [
    `**${caso}: PO blocked.** The purchase order was not created.`,
    "",
    "| Control | Reason | Suggested action |",
    "|---|---|---|",
    filas,
    "",
    "Nothing was written to SAP. Send the suggested action to the requester.",
  ].join("\n")
}

function textoResumen(caso: string, v: DatosValidacion, construccion: unknown, creacion: unknown, creado: boolean): string {
  const payload = PayloadSchema.safeParse(construccion)
  const partes: string[] = [`**${caso}: validation complete.**`, ""]
  if (payload.success) partes.push(tablaPayload(payload.data.data.orden), "")
  partes.push(`Controls passed: ${v.controles.filter((c) => c.resultado === "ok").map((c) => c.codigo).join(", ")}.`)
  for (const c of v.controles.filter((x) => x.resultado === "derivado")) partes.push(`Derived ${c.codigo}: ${c.detalle}`)
  for (const a of v.advertencias) partes.push(`Note: ${a}`)
  if (creado) {
    partes.push("", textoCreacion(caso, creacion))
    return partes.join("\n")
  }
  if (v.confirmaciones.length > 0) {
    partes.push("", "Needs your confirmation:")
    for (const c of v.confirmaciones) partes.push(`- ${c.codigo}: ${c.detalle}`)
    partes.push("", `Do you confirm creating the PO for ${caso} with these exceptions? Reply "confirm" or press Confirm.`)
    return partes.join("\n")
  }
  partes.push("", `The PO is ready. Tell me to create it for ${caso} when you want.`)
  return partes.join("\n")
}

function tablaPayload(o: z.infer<typeof PayloadSchema>["data"]["orden"]): string {
  const p = o.posiciones[0]
  const filas: [string, string][] = [
    ["Supplier", `${o.proveedor.nombre} (SAP ${o.proveedor.codigo_sap})`],
    ["Item", p ? `${p.descripcion}` : "-"],
    ["Quantity", p ? `${p.cantidad} ${p.unidad}` : "-"],
    ["Unit price", p ? `${o.moneda} ${p.precio_unitario.toLocaleString("en-US")}` : "-"],
    ["Cost center", p ? `${p.centro_costo} / ${p.subarea}` : "-"],
    ["IVA code", p?.indicador_iva ?? "-"],
    ["Payment terms", o.condiciones_pago],
    ["Approver", o.aprobador.email],
  ]
  return ["| Field | Value |", "|---|---|", ...filas.map(([k, v]) => `| ${k} | ${v} |`)].join("\n")
}

function textoCreacion(caso: string, resultado: unknown): string {
  const r = CreacionSchema.safeParse(resultado)
  if (!r.success) return `I could not read the result of oc_crear for ${caso}.`
  if (!r.data.ok) return `The PO for ${caso} was not created: ${r.data.error}`
  const d = r.data.data
  const base = d.idempotente
    ? `PO **${d.numero_oc}** already existed for ${caso}. No second order was created.`
    : `PO **${d.numero_oc}** created in SAP (simulated) for ${caso}.`
  const retro = d.retroactiva ? " Flagged as retroactive in out/control.csv." : ""
  const evidencia = d.ruta_evidencia ? ` Approval evidence: ${d.ruta_evidencia}.` : ""
  return `${base}${retro}${evidencia}`
}
