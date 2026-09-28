import type { Maestros, OrdenCompra } from "./esquemas.ts"
import { sha256, textoEvidencia } from "./evidencia.ts"
import { leerMaestros, leerPaquete, type PaqueteLeido } from "./paquete.ts"
import { construirOrden } from "./payload.ts"
import { validarPaquete, type Validacion } from "./reglas.ts"
import { ok, type Result } from "./result.ts"
import { jsonCanonico } from "./texto.ts"

export type Caso = { leido: PaqueteLeido; maestros: Maestros; validacion: Validacion }

/** Reads a case and the master data from disk and validates it. Always from source, never from the model. */
export async function cargarCaso(directory: string, id: string): Promise<Result<Caso>> {
  const leido = await leerPaquete(directory, id)
  if (!leido.ok) return leido
  const maestros = await leerMaestros(directory)
  if (!maestros.ok) return maestros
  return ok({ leido: leido.data, maestros: maestros.data, validacion: validarPaquete(leido.data.paquete, maestros.data) })
}

export function ordenDesdeCaso(c: Caso) {
  const raw = c.leido.aprobacionRaw
  const hash = raw ? sha256(textoEvidencia(raw)) : "0".repeat(64)
  return construirOrden(c.leido.paquete, c.validacion, hash)
}

/**
 * Fingerprint of an order: SHA-256 of its canonical JSON, with confirmado_por
 * cleared so the value is the same before and after confirmation.
 * The analyst's confirmation is bound to this value, not only to the case id.
 */
export function huellaOrden(orden: OrdenCompra): string {
  const sinConfirmador = { ...orden, excepciones: orden.excepciones.map((e) => ({ ...e, confirmado_por: null })) }
  return sha256(jsonCanonico(sinConfirmador))
}

/** Fingerprint of the order a case produces right now, or null when the case is blocked or unreadable. */
export async function huellaDeCaso(directory: string, id: string): Promise<string | null> {
  const c = await cargarCaso(directory, id)
  if (!c.ok || !c.data.validacion.apta) return null
  const orden = ordenDesdeCaso(c.data)
  return orden.ok ? huellaOrden(orden.data.orden) : null
}
