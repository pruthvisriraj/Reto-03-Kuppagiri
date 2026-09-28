import type { OrdenCompra } from "../domain/esquemas.ts"

export type { OrdenCompra }

/** Contract required by the PRD (section 7.4). The mock and a future real adapter both implement it. */
export interface SapAdapter {
  consultarProveedor(nit: string): Promise<{ codigo_sap: string; activo: boolean } | null>
  crearOrden(orden: OrdenCompra): Promise<{ numero_oc: string; fecha: string }>
  buscarOrdenPorReferencia(solicitud_id: string): Promise<{ numero_oc: string } | null>
}
