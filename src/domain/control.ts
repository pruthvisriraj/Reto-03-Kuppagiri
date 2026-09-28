import { resolve } from "node:path"
import { agregarLinea, leerOpcional, rutas } from "./archivos.ts"

export type ResultadoIntento = "creada" | "existente" | "bloqueada" | "pendiente_confirmacion"

export type FilaControl = {
  solicitud_id: string
  resultado: ResultadoIntento
  numero_oc: string | null
  retroactiva: boolean
  bloqueos: string[]
  confirmaciones: string[]
}

const ENCABEZADO = "solicitud_id,resultado,numero_oc,retroactiva,bloqueos,confirmaciones,ts"

/** Appends one row to out/control.csv for every PO attempt (created, existing, blocked or pending). */
export async function registrarControl(directory: string, fila: FilaControl): Promise<void> {
  const ruta = resolve(rutas.out(directory), "control.csv")
  const actual = await leerOpcional(ruta)
  if (actual.ok && actual.data === null) await agregarLinea(ruta, ENCABEZADO)
  const celdas = [
    fila.solicitud_id,
    fila.resultado,
    fila.numero_oc ?? "",
    String(fila.retroactiva),
    fila.bloqueos.join(";"),
    fila.confirmaciones.join(";"),
    new Date().toISOString(),
  ]
  await agregarLinea(ruta, celdas.map(celdaCsv).join(","))
}

/** Quotes CSV cells and neutralizes spreadsheet formulas (CSV injection). */
export function celdaCsv(valor: string): string {
  const seguro = /^[=+\-@\t\r]/.test(valor) ? `'${valor}` : valor
  return /[",\n\r]/.test(seguro) ? `"${seguro.replace(/"/g, '""')}"` : seguro
}
