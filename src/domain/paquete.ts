import { resolve } from "node:path"
import type { z } from "zod"
import { carpetaCaso, leerJsonOpcional, leerOpcional, rutas } from "./archivos.ts"
import {
  AprobacionRawSchema,
  CentroCostoSchema,
  CondicionPagoSchema,
  CorreoSchema,
  IndicadorIvaSchema,
  MaestrosSchema,
  ProveedorSchema,
  SolicitudSchema,
  type AprobacionRaw,
  type Maestros,
  type Paquete,
} from "./esquemas.ts"
import { leerAprobacion, leerCotizacion, leerFactura } from "./lectura.ts"
import { err, ok, type Result } from "./result.ts"

export type PaqueteLeido = {
  paquete: Paquete
  aprobacionRaw: AprobacionRaw | null
  faltantes: string[]
  avisos: string[]
}

const PEDIR_AL_SOLICITANTE: Record<string, string> = {
  "solicitud.json": "Ask the requester to resend the purchase request spreadsheet.",
  "correo.json": "Ask reception to re-export the request email.",
}

export async function leerPaquete(directory: string, caso: string): Promise<Result<PaqueteLeido>> {
  const carpeta = carpetaCaso(directory, caso)
  if (!carpeta.ok) return carpeta

  const correo = await leerValidado(resolve(carpeta.data, "correo.json"), CorreoSchema)
  if (!correo.ok) return correo
  const solicitud = await leerValidado(resolve(carpeta.data, "solicitud.json"), SolicitudSchema)
  if (!solicitud.ok) return solicitud
  if (correo.data === null && solicitud.data === null) {
    return err(`Case "${caso}" does not exist or has no files.`, "CASO_INEXISTENTE")
  }
  if (correo.data === null || solicitud.data === null) {
    const falta = correo.data === null ? "correo.json" : "solicitud.json"
    return err(`Incomplete package: ${falta} is missing. ${PEDIR_AL_SOLICITANTE[falta]}`, "PAQUETE_INCOMPLETO")
  }

  const faltantes: string[] = []
  const avisos: string[] = []

  const aprobacionRaw = await leerValidado(resolve(carpeta.data, "aprobacion.json"), AprobacionRawSchema)
  if (!aprobacionRaw.ok) return aprobacionRaw
  if (aprobacionRaw.data === null) faltantes.push("aprobacion (leader approval email)")

  const cotizacionTexto = await leerOpcional(resolve(carpeta.data, "cotizacion.txt"))
  if (!cotizacionTexto.ok) return cotizacionTexto
  let cotizacion: Paquete["cotizacion"] = null
  if (cotizacionTexto.data === null) faltantes.push("cotizacion (supplier quote)")
  else {
    const leida = leerCotizacion(cotizacionTexto.data)
    cotizacion = leida.cotizacion
    if (leida.aviso) avisos.push(leida.aviso)
  }

  const facturaTexto = await leerOpcional(resolve(carpeta.data, "factura.txt"))
  if (!facturaTexto.ok) return facturaTexto
  let factura: Paquete["factura"] = null
  if (facturaTexto.data !== null) {
    const leida = leerFactura(facturaTexto.data)
    factura = leida.factura
    if (leida.aviso) avisos.push(leida.aviso)
  }

  const c = correo.data
  return ok({
    paquete: {
      correo: { id: c.id, de: c.de, asunto: c.asunto, fecha: c.fecha },
      solicitud: solicitud.data,
      cotizacion,
      aprobacion: aprobacionRaw.data ? leerAprobacion(aprobacionRaw.data) : null,
      factura,
    },
    aprobacionRaw: aprobacionRaw.data,
    faltantes,
    avisos,
  })
}

export async function leerMaestros(directory: string): Promise<Result<Maestros>> {
  const base = rutas.maestros(directory)
  const [proveedores, centros, iva, condiciones] = await Promise.all([
    leerValidado(resolve(base, "proveedores.json"), ProveedorSchema.array()),
    leerValidado(resolve(base, "centros-costo.json"), CentroCostoSchema.array()),
    leerValidado(resolve(base, "indicadores-iva.json"), IndicadorIvaSchema.array()),
    leerValidado(resolve(base, "condiciones-pago.json"), CondicionPagoSchema.array()),
  ])
  for (const r of [proveedores, centros, iva, condiciones]) if (!r.ok) return r
  const maestros = MaestrosSchema.safeParse({
    proveedores: proveedores.ok ? proveedores.data : null,
    centros: centros.ok ? centros.data : null,
    iva: iva.ok ? iva.data : null,
    condiciones: condiciones.ok ? condiciones.data : null,
  })
  if (!maestros.success) return err("Master data files are missing or malformed in fixtures/reto-03/maestros.", "MAESTROS")
  return ok(maestros.data)
}

async function leerValidado<T>(ruta: string, esquema: z.ZodType<T>): Promise<Result<T | null>> {
  const json = await leerJsonOpcional(ruta)
  if (!json.ok) return json
  if (json.data === null) return ok(null)
  const parsed = esquema.safeParse(json.data)
  if (parsed.success) return ok(parsed.data)
  const archivo = ruta.split(/[\\/]/).pop() ?? ruta
  const campos = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")
  return err(
    `${archivo} has invalid fields (${campos}). Ask the requester to correct these fields and resend.`,
    "DATOS_INVALIDOS",
  )
}
