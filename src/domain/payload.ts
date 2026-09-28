import { OrdenCompraSchema, type OrdenCompra, type Paquete } from "./esquemas.ts"
import { fechaDe } from "./lectura.ts"
import { err, ok, type Result } from "./result.ts"
import type { Validacion } from "./reglas.ts"
import { textoBreve } from "./texto.ts"

export type Trazabilidad = Record<string, { valor: string | number | null; fuente: string }>

export function construirOrden(
  p: Paquete,
  v: Validacion,
  evidenciaSha: string,
): Result<{ orden: OrdenCompra; trazabilidad: Trazabilidad }> {
  const s = p.solicitud
  const { proveedor, indicador_iva, condiciones_pago, unidad } = v.resueltos
  if (!v.apta) return err("The package has blocking controls, so no payload was built.", "BLOQUEADA", { bloqueos: v.bloqueos })
  if (!proveedor || !indicador_iva || !condiciones_pago || !p.aprobacion) {
    return err("Supplier, IVA code, payment terms or approval are missing.", "DATOS_INSUFICIENTES")
  }

  const descripcion = textoBreve(s.descripcion)
  const candidata = {
    referencia: { solicitud_id: s.solicitud_id, correo_id: p.correo.id, cotizacion_ref: p.cotizacion?.referencia ?? null },
    sociedad: "1000",
    organizacion_compras: "1000",
    proveedor: { codigo_sap: proveedor.codigo_sap, nit: proveedor.nit, nombre: proveedor.nombre },
    moneda: s.moneda,
    condiciones_pago: condiciones_pago.valor,
    aprobador: { email: p.aprobacion.de, fecha_aprobacion: fechaDe(p.aprobacion.fecha) ?? p.aprobacion.fecha, evidencia_sha256: evidenciaSha },
    posiciones: [
      {
        numero: 10,
        descripcion,
        cantidad: s.cantidad,
        unidad: unidad.valor,
        precio_unitario: s.valor_unitario,
        centro_costo: s.centro_costo,
        subarea: s.subarea,
        indicador_iva: indicador_iva.valor,
      },
    ],
    excepciones: v.confirmaciones.map((c) => ({ codigo: c.codigo, detalle: c.detalle, confirmado_por: null })),
  }

  const parsed = OrdenCompraSchema.safeParse(candidata)
  if (!parsed.success) {
    const campos = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")
    return err(`The payload does not match the SAP schema (${campos}).`, "PAYLOAD_INVALIDO")
  }

  const trazabilidad: Trazabilidad = {
    "referencia.solicitud_id": { valor: s.solicitud_id, fuente: "solicitud.solicitud_id" },
    "referencia.correo_id": { valor: p.correo.id, fuente: "correo.id" },
    "referencia.cotizacion_ref": { valor: p.cotizacion?.referencia ?? null, fuente: "cotizacion" },
    sociedad: { valor: "1000", fuente: "derivado (fixed company code)" },
    organizacion_compras: { valor: "1000", fuente: "derivado (fixed purchasing org)" },
    "proveedor.codigo_sap": { valor: proveedor.codigo_sap, fuente: proveedor.fuente },
    "proveedor.nit": { valor: proveedor.nit, fuente: proveedor.fuente },
    "proveedor.nombre": { valor: proveedor.nombre, fuente: proveedor.fuente },
    moneda: { valor: s.moneda, fuente: "solicitud.moneda" },
    condiciones_pago: { valor: condiciones_pago.valor, fuente: condiciones_pago.fuente },
    "aprobador.email": { valor: p.aprobacion.de, fuente: "aprobacion.de" },
    "aprobador.fecha_aprobacion": { valor: parsed.data.aprobador.fecha_aprobacion, fuente: "aprobacion.fecha" },
    "aprobador.evidencia_sha256": { valor: evidenciaSha, fuente: "derivado (sha256 of the approval evidence text)" },
    "posiciones[0].descripcion": { valor: descripcion, fuente: "solicitud.descripcion (SAP short text, 40 chars)" },
    "posiciones[0].descripcion_completa": { valor: s.descripcion, fuente: "solicitud.descripcion" },
    "posiciones[0].cantidad": { valor: s.cantidad, fuente: "solicitud.cantidad" },
    "posiciones[0].unidad": { valor: unidad.valor, fuente: unidad.fuente },
    "posiciones[0].precio_unitario": { valor: s.valor_unitario, fuente: "solicitud.valor_unitario" },
    "posiciones[0].centro_costo": { valor: s.centro_costo, fuente: "solicitud.centro_costo" },
    "posiciones[0].subarea": { valor: s.subarea, fuente: "solicitud.subarea" },
    "posiciones[0].indicador_iva": { valor: indicador_iva.valor, fuente: indicador_iva.fuente },
  }
  return ok({ orden: parsed.data, trazabilidad })
}
