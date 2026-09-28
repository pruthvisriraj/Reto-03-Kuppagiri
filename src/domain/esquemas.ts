import { z } from "zod"

export const FechaISO = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD")

// ---------- Fixture files (7.1) ----------

export const CorreoSchema = z.object({
  id: z.string().min(1),
  de: z.string().min(1),
  asunto: z.string(),
  fecha: z.string().min(10),
  cuerpo: z.string(),
  adjuntos: z.array(z.string()),
})

export const SolicitudSchema = z.object({
  solicitud_id: z.string().min(1),
  solicitante: z.string().min(1),
  proveedor_nombre: z.string().min(1),
  proveedor_nit: z.string().min(1).optional(),
  descripcion: z.string().min(1),
  centro_costo: z.string().min(1),
  subarea: z.string().min(1),
  cantidad: z.number().positive(),
  valor_unitario: z.number().nonnegative(),
  valor_total: z.number().positive(),
  moneda: z.string().min(3),
  indicador_iva: z.string().min(1).optional(),
  condiciones_pago: z.string().min(1).optional(),
  fecha_solicitud: FechaISO,
})
export type Solicitud = z.infer<typeof SolicitudSchema>

export const AprobacionRawSchema = z.object({
  de: z.string().min(1),
  para: z.string().optional(),
  cc: z.array(z.string()).optional(),
  fecha: z.string().min(10),
  asunto: z.string(),
  cuerpo: z.string(),
})
export type AprobacionRaw = z.infer<typeof AprobacionRawSchema>

// ---------- Masters ----------

export const ProveedorSchema = z.object({
  codigo_sap: z.string(),
  nit: z.string(),
  nombre: z.string(),
  condiciones_pago_default: z.string(),
  indicador_iva_default: z.string(),
  activo: z.boolean(),
})
export type Proveedor = z.infer<typeof ProveedorSchema>

export const CentroCostoSchema = z.object({
  centro_costo: z.string(),
  nombre: z.string(),
  subareas: z.array(z.string()),
  aprobadores: z.array(z.object({ email: z.string(), nombre: z.string(), tope: z.number() })),
})
export type CentroCosto = z.infer<typeof CentroCostoSchema>

export const IndicadorIvaSchema = z.object({ codigo: z.string(), descripcion: z.string(), tasa: z.number() })
export const CondicionPagoSchema = z.object({ codigo: z.string(), descripcion: z.string(), dias: z.number() })

export const MaestrosSchema = z.object({
  proveedores: z.array(ProveedorSchema),
  centros: z.array(CentroCostoSchema),
  iva: z.array(IndicadorIvaSchema),
  condiciones: z.array(CondicionPagoSchema),
})
export type Maestros = z.infer<typeof MaestrosSchema>

// ---------- Normalized package (7.2) ----------

export type Cotizacion = {
  proveedor: string
  nit: string | null
  total: number
  moneda: string
  validez_hasta: string | null
  texto: string
  referencia: string | null
  fecha: string | null
  iva_tasa: number | null
  primer_item: string | null
}

export type Aprobacion = {
  de: string
  fecha: string
  aprobado: boolean
  texto: string
  monto_mencionado: number | null
}

export type Factura = { numero: string; fecha: string; total: number }

export type Paquete = {
  correo: { id: string; de: string; asunto: string; fecha: string }
  solicitud: Solicitud
  cotizacion: Cotizacion | null
  aprobacion: Aprobacion | null
  factura: Factura | null
}

// ---------- Purchase order payload (7.4) ----------

export const OrdenCompraSchema = z.object({
  referencia: z.object({
    solicitud_id: z.string().min(1),
    correo_id: z.string().min(1),
    cotizacion_ref: z.string().nullable(),
  }),
  sociedad: z.literal("1000"),
  organizacion_compras: z.literal("1000"),
  proveedor: z.object({ codigo_sap: z.string().min(1), nit: z.string().min(1), nombre: z.string().min(1) }),
  moneda: z.enum(["COP", "USD"]),
  condiciones_pago: z.string().min(1),
  aprobador: z.object({
    email: z.string().min(3),
    fecha_aprobacion: z.string().min(10),
    evidencia_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  posiciones: z
    .array(
      z.object({
        numero: z.number().int().positive(),
        descripcion: z.string().min(1).max(40),
        cantidad: z.number().positive(),
        unidad: z.enum(["UN", "H", "MES"]),
        precio_unitario: z.number().nonnegative(),
        centro_costo: z.string().min(1),
        subarea: z.string().min(1),
        indicador_iva: z.string().min(1),
      }),
    )
    .min(1),
  excepciones: z.array(
    z.object({ codigo: z.string(), detalle: z.string(), confirmado_por: z.string().nullable() }),
  ),
})
export type OrdenCompra = z.infer<typeof OrdenCompraSchema>
