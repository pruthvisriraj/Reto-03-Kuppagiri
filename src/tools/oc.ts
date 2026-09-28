/**
 * Purchase order tools. Each export becomes the model-facing tool "oc_<export>".
 * The tools re-read the source files on every call: values sent by the model
 * (paquete, derivados, payload) are compared but never trusted.
 */
import { resolve } from "node:path"
import { z } from "zod"
import { carpetaSalida, escribir, ID_SEGURO } from "../domain/archivos.ts"
import { registrarControl, type FilaControl } from "../domain/control.ts"
import { cargarCaso as cargarDesdeDisco, huellaOrden, ordenDesdeCaso, type Caso } from "../domain/caso.ts"
import type { AprobacionRaw, OrdenCompra, Paquete } from "../domain/esquemas.ts"
import { archivoPdf, archivoTxt, sha256, textoEvidencia } from "../domain/evidencia.ts"
import { leerPaquete } from "../domain/paquete.ts"
import { err, ok, type Result } from "../domain/result.ts"
import { jsonCanonico } from "../domain/texto.ts"
import { SapMock } from "../sap/mock.ts"
import { definirHerramienta, ejecutarSeguro, type ToolContext } from "./runtime.ts"

const caso = z
  .string()
  .regex(ID_SEGURO, "use a case folder name such as sol-001")
  .describe("Case folder name under fixtures/reto-03/solicitudes/, for example sol-001")

const objetoOpcional = (descripcion: string) => z.record(z.string(), z.unknown()).optional().describe(descripcion)

type Comparacion = "no_enviado" | "igual" | "difiere"

// ---------------------------------------------------------------------------

export const leer_paquete = definirHerramienta({
  description: "Reads one purchase request case (email, request, quote, approval, optional invoice) and returns the normalized package.",
  args: { caso },
  async execute(args, ctx) {
    return ejecutarSeguro(
      "oc_leer_paquete",
      ctx,
      args.caso,
      async () => {
        const r = await leerPaquete(ctx.directory, args.caso)
        if (!r.ok) return r
        return ok({ ...r.data.paquete, faltantes: r.data.faltantes, avisos: r.data.avisos })
      },
      (d) => `${d.solicitud.solicitud_id} read. Missing: ${d.faltantes.length ? d.faltantes.join(", ") : "none"}.`,
    )
  },
})

export const validar = definirHerramienta({
  description: "Validates a case against the master data and control rules RC1-RC10, returning blocks, confirmations and derived values.",
  args: {
    caso,
    paquete: objetoOpcional("Optional package from oc_leer_paquete. The tool re-reads the source files and ignores edited values."),
  },
  async execute(args, ctx) {
    return ejecutarSeguro(
      "oc_validar",
      ctx,
      args.caso,
      async () => {
        const c = await cargarCaso(ctx, args.caso)
        if (!c.ok) return c
        const v = c.data.validacion
        if (!v.apta) await registrarControl(ctx.directory, filaControl(c.data, "bloqueada", null))
        else if (v.confirmaciones.length > 0) await registrarControl(ctx.directory, filaControl(c.data, "pendiente_confirmacion", null))
        const comparacion = compararPaquete(args.paquete, c.data.leido.paquete)
        const { resueltos: _interno, ...publico } = v
        const advertencias = [...v.advertencias, ...avisoComparacion(comparacion, "package")]
        return ok({ ...publico, advertencias, paquete_del_modelo: comparacion })
      },
      (d) =>
        `apta=${d.apta}; bloqueos=${codigos(d.bloqueos)}; confirmaciones=${codigos(d.confirmaciones)}; retroactiva=${d.retroactiva}`,
    )
  },
})

export const construir_payload = definirHerramienta({
  description: "Builds the SAP purchase order payload for a valid case, with traceability for every field saved to out/<caso>/trazabilidad.json.",
  args: {
    caso,
    paquete: objetoOpcional("Optional package from oc_leer_paquete. Recomputed from source files."),
    derivados: objetoOpcional("Optional derived values from oc_validar. Recomputed from master data."),
  },
  async execute(args, ctx) {
    return ejecutarSeguro(
      "oc_construir_payload",
      ctx,
      args.caso,
      async () => {
        const c = await cargarCaso(ctx, args.caso)
        if (!c.ok) return c
        const salida = carpetaSalida(ctx.directory, args.caso)
        if (!salida.ok) return salida
        const orden = ordenDesdeCaso(c.data)
        if (!orden.ok) return orden
        const rutaPayload = resolve(salida.data, "payload.json")
        const rutaTraza = resolve(salida.data, "trazabilidad.json")
        await escribir(rutaPayload, `${JSON.stringify(orden.data.orden, null, 2)}\n`)
        await escribir(rutaTraza, `${JSON.stringify(orden.data.trazabilidad, null, 2)}\n`)
        return ok({
          orden: orden.data.orden,
          ruta_payload: `out/${args.caso}/payload.json`,
          ruta_trazabilidad: `out/${args.caso}/trazabilidad.json`,
          confirmaciones_pendientes: c.data.validacion.confirmaciones.map((x) => x.codigo),
          retroactiva: c.data.validacion.retroactiva,
          advertencias: c.data.validacion.advertencias,
        })
      },
      (d) => `payload built for ${d.orden.referencia.solicitud_id}; pending confirmations: ${d.confirmaciones_pendientes.join(", ") || "none"}`,
    )
  },
})

export const generar_evidencia = definirHerramienta({
  description: "Writes the leader's approval email as evidence to out/<caso>/aprobacion.txt and aprobacion.pdf and returns its SHA-256.",
  args: { caso },
  async execute(args, ctx) {
    return ejecutarSeguro(
      "oc_generar_evidencia",
      ctx,
      args.caso,
      async () => {
        const leido = await leerPaquete(ctx.directory, args.caso)
        if (!leido.ok) return leido
        if (!leido.data.aprobacionRaw) {
          return err("The package has no approval email, so there is no evidence to generate. Ask the requester to forward it.", "SIN_APROBACION")
        }
        return escribirEvidencia(ctx, args.caso, leido.data.aprobacionRaw, leido.data.paquete)
      },
      (d) => `evidence ${d.ruta} sha256=${d.sha256.slice(0, 12)}...`,
    )
  },
})

export const crear = definirHerramienta({
  description: "Creates the purchase order in SAP (simulated) when the case is valid; needs confirmado=true only after the user explicitly confirmed pending exceptions.",
  args: {
    caso,
    payload: objetoOpcional("Optional payload from oc_construir_payload. The tool rebuilds it from source files."),
    confirmado: z
      .boolean()
      .optional()
      .describe("true only when the user's latest message explicitly confirmed the pending exceptions for this case"),
  },
  async execute(args, ctx) {
    return ejecutarSeguro(
      "oc_crear",
      ctx,
      args.caso,
      () => crearOrden(ctx, args.caso, args.payload, args.confirmado === true),
      (d) => `${d.idempotente ? "existing" : "created"} PO ${d.numero_oc}; retroactiva=${d.retroactiva}`,
    )
  },
})

// ---------------------------------------------------------------------------

function cargarCaso(ctx: ToolContext, id: string): Promise<Result<Caso>> {
  return cargarDesdeDisco(ctx.directory, id)
}

function filaControl(c: Caso, resultado: FilaControl["resultado"], numero_oc: string | null): FilaControl {
  const v = c.validacion
  return {
    solicitud_id: c.leido.paquete.solicitud.solicitud_id,
    resultado,
    numero_oc,
    retroactiva: v.retroactiva,
    bloqueos: v.bloqueos.map((b) => b.codigo),
    confirmaciones: v.confirmaciones.map((x) => x.codigo),
  }
}

async function crearOrden(ctx: ToolContext, id: string, payloadModelo: Record<string, unknown> | undefined, confirmado: boolean) {
  const c = await cargarCaso(ctx, id)
  if (!c.ok) return c
  const { validacion: v, leido } = c.data
  const s = leido.paquete.solicitud
  const sap = new SapMock(ctx.directory)
  const fila = (resultado: FilaControl["resultado"], numero_oc: string | null) => filaControl(c.data, resultado, numero_oc)

  const existente = await sap.buscarOrdenPorReferencia(s.solicitud_id)
  if (existente) {
    await registrarControl(ctx.directory, fila("existente", existente.numero_oc))
    const fecha = (await sap.fechaDeOrden(existente.numero_oc)) ?? ""
    return ok({ numero_oc: existente.numero_oc, fecha, idempotente: true, retroactiva: v.retroactiva, payload_del_modelo: "no_enviado" as Comparacion })
  }
  if (!v.apta) {
    await registrarControl(ctx.directory, fila("bloqueada", null))
    return err(`PO not created. Blocking controls: ${v.bloqueos.map((b) => `${b.codigo} ${b.detalle}`).join(" | ")}`, "BLOQUEADA", {
      bloqueos: v.bloqueos,
    })
  }
  if (v.confirmaciones.length > 0 && !confirmado) {
    await registrarControl(ctx.directory, fila("pendiente_confirmacion", null))
    return err(
      `Explicit user confirmation required before creating the PO: ${v.confirmaciones.map((x) => `${x.codigo} ${x.detalle}`).join(" | ")}`,
      "REQUIERE_CONFIRMACION",
      { confirmaciones: v.confirmaciones, retroactiva: v.retroactiva },
    )
  }

  const construida = ordenDesdeCaso(c.data)
  if (!construida.ok) return construida
  const huella = huellaOrden(construida.data.orden)
  const consentimiento = ctx.consentimientos?.get(id)
  if (v.confirmaciones.length > 0 && ctx.consentimientos && consentimiento !== huella) {
    // Server path: the confirmation covers one exact order. Any change in the sources since the review voids it.
    await registrarControl(ctx.directory, fila("pendiente_confirmacion", null))
    return err(
      "PO not created: the order changed after the analyst reviewed it, so the confirmation no longer applies. Review the case again.",
      consentimiento === undefined ? "CONFIRMACION_NO_OTORGADA" : "ORDEN_CAMBIADA",
      { huella_confirmada: consentimiento ?? null, huella_actual: huella, confirmaciones: v.confirmaciones },
    )
  }
  const comparacion = compararPayload(payloadModelo, construida.data.orden)
  if (!leido.aprobacionRaw) return err("The approval email is missing.", "SIN_APROBACION")
  const evidencia = await escribirEvidencia(ctx, id, leido.aprobacionRaw, leido.paquete)
  if (!evidencia.ok) return evidencia

  // The supplier could have been blocked in SAP after validation. Check again right before creating.
  const enSap = await sap.consultarProveedor(construida.data.orden.proveedor.nit)
  if (!enSap?.activo) {
    await registrarControl(ctx.directory, fila("bloqueada", null))
    return err("PO not created: SAP reports the supplier as missing or inactive at creation time.", "PROVEEDOR_SAP")
  }

  const orden: OrdenCompra = {
    ...construida.data.orden,
    excepciones: construida.data.orden.excepciones.map((e) => ({ ...e, confirmado_por: `analista (sesion ${ctx.sessionId})` })),
  }
  const creada = await sap.crearOrden(orden)
  const salida = carpetaSalida(ctx.directory, id)
  const registroConsentimiento = v.confirmaciones.length > 0 ? { sesion: ctx.sessionId, huella, ts: new Date().toISOString() } : null
  if (salida.ok) {
    await escribir(resolve(salida.data, "orden.json"), `${JSON.stringify({ ...creada, huella, consentimiento: registroConsentimiento, orden }, null, 2)}\n`)
  }
  await registrarControl(ctx.directory, fila("creada", creada.numero_oc))
  return ok({
    numero_oc: creada.numero_oc,
    fecha: creada.fecha,
    idempotente: false,
    retroactiva: v.retroactiva,
    excepciones_confirmadas: orden.excepciones.map((e) => e.codigo),
    ruta_evidencia: evidencia.data.ruta_pdf,
    huella,
    payload_del_modelo: comparacion,
  })
}

async function escribirEvidencia(ctx: ToolContext, id: string, raw: AprobacionRaw, p: Paquete) {
  const salida = carpetaSalida(ctx.directory, id)
  if (!salida.ok) return salida
  const texto = textoEvidencia(raw)
  const hash = sha256(texto)
  const fecha = new Date(raw.fecha)
  const pdf = await archivoPdf(texto, hash, `Approval evidence ${p.solicitud.solicitud_id}`, Number.isNaN(fecha.getTime()) ? new Date(0) : fecha)
  await escribir(resolve(salida.data, "aprobacion.txt"), archivoTxt(texto, hash))
  await escribir(resolve(salida.data, "aprobacion.pdf"), pdf)
  return ok({ ruta: `out/${id}/aprobacion.txt`, ruta_pdf: `out/${id}/aprobacion.pdf`, sha256: hash })
}

function compararPaquete(delModelo: Record<string, unknown> | undefined, fuente: Paquete): Comparacion {
  if (!delModelo) return "no_enviado"
  const claves = ["correo", "solicitud", "cotizacion", "aprobacion", "factura"] as const
  const recorte = (o: Record<string, unknown>) => Object.fromEntries(claves.map((k) => [k, o[k] ?? null]))
  return jsonCanonico(recorte(delModelo)) === jsonCanonico(recorte(fuente)) ? "igual" : "difiere"
}

function compararPayload(delModelo: Record<string, unknown> | undefined, fuente: OrdenCompra): Comparacion {
  if (!delModelo) return "no_enviado"
  const sinConfirmador = (o: Record<string, unknown>) => ({ ...o, excepciones: null })
  return jsonCanonico(sinConfirmador(delModelo)) === jsonCanonico(sinConfirmador(fuente)) ? "igual" : "difiere"
}

function avisoComparacion(c: Comparacion, que: string): string[] {
  return c === "difiere" ? [`The ${que} sent by the model differs from the source files. The tool used the source files only.`] : []
}

function codigos(lista: { codigo: string }[]): string {
  return lista.length ? lista.map((x) => x.codigo).join(",") : "none"
}
