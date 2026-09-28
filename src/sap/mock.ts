import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { agregarLinea, leerJsonOpcional, rutas } from "../domain/archivos.ts"
import { ProveedorSchema } from "../domain/esquemas.ts"
import { normalizarNit } from "../domain/lectura.ts"
import type { OrdenCompra, SapAdapter } from "./adapter.ts"

const PRIMER_NUMERO = 4500000001

type LineaOrden = { numero_oc: string; fecha: string; orden: OrdenCompra }

/**
 * File-backed SAP simulator. Orders go to out/sap/ordenes.jsonl.
 * A per-file lock serializes writes, so two concurrent requests for the
 * same solicitud_id still produce a single order.
 */
export class SapMock implements SapAdapter {
  private readonly archivo: string

  constructor(private readonly directory: string) {
    this.archivo = resolve(rutas.out(directory), "sap", "ordenes.jsonl")
  }

  async consultarProveedor(nit: string): Promise<{ codigo_sap: string; activo: boolean } | null> {
    const json = await leerJsonOpcional(resolve(rutas.maestros(this.directory), "proveedores.json"))
    if (!json.ok || json.data === null) return null
    const lista = ProveedorSchema.array().safeParse(json.data)
    if (!lista.success) return null
    const p = lista.data.find((x) => normalizarNit(x.nit) === normalizarNit(nit))
    return p ? { codigo_sap: p.codigo_sap, activo: p.activo } : null
  }

  async buscarOrdenPorReferencia(solicitud_id: string): Promise<{ numero_oc: string } | null> {
    const linea = (await this.leer()).find((l) => l.orden.referencia.solicitud_id === solicitud_id)
    return linea ? { numero_oc: linea.numero_oc } : null
  }

  /** Idempotent by solicitud_id: a second call returns the existing order. */
  async crearOrden(orden: OrdenCompra): Promise<{ numero_oc: string; fecha: string }> {
    return conCandado(this.archivo, async () => {
      const lineas = await this.leer()
      const previa = lineas.find((l) => l.orden.referencia.solicitud_id === orden.referencia.solicitud_id)
      if (previa) return { numero_oc: previa.numero_oc, fecha: previa.fecha }
      const numero_oc = String(PRIMER_NUMERO + lineas.length)
      const fecha = new Date().toISOString()
      await agregarLinea(this.archivo, JSON.stringify({ numero_oc, fecha, orden } satisfies LineaOrden))
      return { numero_oc, fecha }
    })
  }

  async fechaDeOrden(numero_oc: string): Promise<string | null> {
    return (await this.leer()).find((l) => l.numero_oc === numero_oc)?.fecha ?? null
  }

  private async leer(): Promise<LineaOrden[]> {
    let texto: string
    try {
      texto = await readFile(this.archivo, "utf8")
    } catch {
      return []
    }
    return texto
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l) as LineaOrden)
  }
}

const candados = new Map<string, Promise<unknown>>()

async function conCandado<T>(clave: string, fn: () => Promise<T>): Promise<T> {
  const previo = candados.get(clave) ?? Promise.resolve()
  const actual = previo.then(fn, fn)
  candados.set(clave, actual.catch(() => undefined))
  return actual
}
