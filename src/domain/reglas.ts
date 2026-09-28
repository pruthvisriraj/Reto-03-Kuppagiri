import type { CentroCosto, Maestros, Paquete, Proveedor, Solicitud } from "./esquemas.ts"
import { fechaDe, normalizarEmail, normalizarNit, normalizarNombre } from "./lectura.ts"
import { textoBreve } from "./texto.ts"

export type Bloqueo = { codigo: string; detalle: string; accion_sugerida: string }
export type Confirmacion = { codigo: string; detalle: string; valores?: Record<string, string | number | null> }
export type ResultadoControl = "ok" | "bloqueo" | "confirmacion" | "derivado" | "no_evaluable"
export type Control = { codigo: string; resultado: ResultadoControl; detalle: string }
export type ValorDerivado<T extends string = string> = { valor: T; fuente: string }
export type Unidad = "UN" | "H" | "MES"

/** Every value the payload needs, with its source. */
export type Resueltos = {
  proveedor: { codigo_sap: string; nit: string; nombre: string; fuente: string } | null
  indicador_iva: ValorDerivado | null
  condiciones_pago: ValorDerivado | null
  unidad: ValorDerivado<Unidad>
}

/** HU-2: only the values the agent completed from master data or derived. The agent must report them. */
export type Derivados = Partial<Resueltos>

export type Validacion = {
  apta: boolean
  bloqueos: Bloqueo[]
  confirmaciones: Confirmacion[]
  derivados: Derivados
  retroactiva: boolean
  controles: Control[]
  advertencias: string[]
  resueltos: Resueltos
}

type Aprobador = CentroCosto["aprobadores"][number]

class Registro {
  readonly bloqueos: Bloqueo[] = []
  readonly confirmaciones: Confirmacion[] = []
  readonly controles: Control[] = []
  readonly advertencias: string[] = []

  ok(codigo: string, detalle: string): void {
    this.controles.push({ codigo, resultado: "ok", detalle })
  }
  bloquear(codigo: string, detalle: string, accion_sugerida: string): void {
    this.bloqueos.push({ codigo, detalle, accion_sugerida })
    this.controles.push({ codigo, resultado: "bloqueo", detalle })
  }
  confirmar(codigo: string, detalle: string, valores?: Confirmacion["valores"]): void {
    this.confirmaciones.push(valores ? { codigo, detalle, valores } : { codigo, detalle })
    this.controles.push({ codigo, resultado: "confirmacion", detalle })
  }
  derivar(codigo: string, detalle: string): void {
    this.controles.push({ codigo, resultado: "derivado", detalle })
  }
  noEvaluable(codigo: string, detalle: string): void {
    this.controles.push({ codigo, resultado: "no_evaluable", detalle })
  }
  advertir(texto: string): void {
    this.advertencias.push(texto)
  }
}

export function formatoMonto(valor: number, moneda: string): string {
  return `${moneda} ${valor.toLocaleString("en-US", { maximumFractionDigits: 2 })}`
}

export function validarPaquete(p: Paquete, m: Maestros): Validacion {
  const r = new Registro()
  const s = p.solicitud
  const proveedor = rc1Proveedor(s, m, r)
  nitDeCotizacion(p, proveedor, r)
  const centro = rc4CentroYSubarea(s, m, r)
  const aprobador = rc2Aprobacion(p, centro, m, r)
  rc3Tope(s, centro, aprobador, r)
  rc5Cotizacion(p, r)
  const iva = rc6IndicadorIva(p, proveedor, m, r)
  const condiciones = rc7CondicionesPago(s, proveedor, m, r)
  const retroactiva = rc8Retroactiva(p, r)
  rc9FechaAprobacion(p, r)
  rc10Aritmetica(s, r)
  controlMoneda(s, r)
  controlSegregacion(p, r)
  advertenciasAdicionales(p, r)

  const resueltos: Resueltos = {
    proveedor: proveedor ? { codigo_sap: proveedor.codigo_sap, nit: proveedor.nit, nombre: proveedor.nombre, fuente: "maestro.proveedores" } : null,
    indicador_iva: iva,
    condiciones_pago: condiciones,
    unidad: derivarUnidad(p),
  }
  return {
    apta: r.bloqueos.length === 0,
    bloqueos: r.bloqueos,
    confirmaciones: r.confirmaciones,
    derivados: soloDerivados(resueltos),
    retroactiva,
    controles: ordenarControles(r.controles),
    advertencias: r.advertencias,
    resueltos,
  }
}

function soloDerivados(v: Resueltos): Derivados {
  const d: Derivados = { unidad: v.unidad }
  if (v.proveedor) d.proveedor = v.proveedor
  if (v.indicador_iva && !v.indicador_iva.fuente.startsWith("solicitud")) d.indicador_iva = v.indicador_iva
  if (v.condiciones_pago && !v.condiciones_pago.fuente.startsWith("solicitud")) d.condiciones_pago = v.condiciones_pago
  return d
}

// RC1: supplier exists (by NIT, else by normalized name) and is active.
function rc1Proveedor(s: Solicitud, m: Maestros, r: Registro): Proveedor | null {
  const nit = s.proveedor_nit ? normalizarNit(s.proveedor_nit) : null
  const nombre = normalizarNombre(s.proveedor_nombre)
  const proveedor = nit
    ? m.proveedores.find((x) => normalizarNit(x.nit) === nit)
    : m.proveedores.find((x) => normalizarNombre(x.nombre) === nombre)
  if (!proveedor) {
    r.bloquear(
      "RC1",
      `Supplier ${s.proveedor_nombre} (${nit ? `NIT ${nit}` : "no NIT"}) does not exist in the supplier master.`,
      "Ask master data to register the supplier in SAP first, or ask the requester to choose a registered supplier.",
    )
    return null
  }
  if (!proveedor.activo) {
    r.bloquear(
      "RC1",
      `Supplier ${proveedor.nombre} (SAP ${proveedor.codigo_sap}) exists but is inactive.`,
      "Ask master data whether the supplier can be reactivated, or ask the requester for another supplier.",
    )
    return null
  }
  r.ok("RC1", `Supplier found by ${nit ? "NIT" : "normalized name"}: ${proveedor.nombre}, SAP code ${proveedor.codigo_sap}, active.`)
  if (!nit) r.advertir(`The request has no supplier NIT. Matched by name. NIT ${proveedor.nit} comes from the supplier master.`)
  return proveedor
}

// Extra check on RC1: the quote must come from the same tax id as the master supplier.
function nitDeCotizacion(p: Paquete, proveedor: Proveedor | null, r: Registro): void {
  const nitCot = p.cotizacion?.nit
  if (!proveedor || !nitCot) return
  if (normalizarNit(nitCot) === normalizarNit(proveedor.nit)) {
    if (!p.solicitud.proveedor_nit) r.advertir(`The quote NIT ${nitCot} matches the supplier master, which supports the name match.`)
    return
  }
  r.confirmar("RC1-NIT", `The quote NIT (${nitCot}) differs from the supplier master NIT (${proveedor.nit}).`, {
    nit_cotizacion: nitCot,
    nit_maestro: proveedor.nit,
  })
}

// RC4: cost center exists and the sub-area belongs to it.
function rc4CentroYSubarea(s: Solicitud, m: Maestros, r: Registro): CentroCosto | null {
  const centro = m.centros.find((c) => c.centro_costo === s.centro_costo.trim())
  if (!centro) {
    const validos = m.centros.map((c) => c.centro_costo).join(", ")
    r.bloquear("RC4", `Cost center ${s.centro_costo} does not exist.`, `Ask the requester for a valid cost center (${validos}).`)
    return null
  }
  const subarea = normalizarNombre(s.subarea)
  if (!centro.subareas.some((x) => normalizarNombre(x) === subarea)) {
    r.bloquear(
      "RC4",
      `Sub-area "${s.subarea}" does not belong to ${centro.centro_costo} ${centro.nombre} (valid: ${centro.subareas.join(", ")}).`,
      "Ask the requester to correct the sub-area or the cost center.",
    )
    return centro
  }
  r.ok("RC4", `Sub-area ${s.subarea} belongs to ${centro.centro_costo} ${centro.nombre}.`)
  return centro
}

// RC2: approval exists, says "Aprobado", and comes from an approver of the cost center.
function rc2Aprobacion(p: Paquete, centro: CentroCosto | null, m: Maestros, r: Registro): Aprobador | null {
  const a = p.aprobacion
  if (!a) {
    r.bloquear("RC2", "The package has no approval email.", "Ask the requester to forward the leader's approval email.")
    return null
  }
  if (!a.aprobado) {
    r.bloquear("RC2", `The email from ${a.de} does not contain an approval ("Aprobado").`, "Ask the leader to reply with an explicit approval.")
    return null
  }
  if (!centro) {
    r.noEvaluable("RC2", "Cost center not found, so the approver list is unavailable.")
    return null
  }
  const aprobador = centro.aprobadores.find((x) => normalizarEmail(x.email) === normalizarEmail(a.de))
  if (!aprobador) {
    const lista = centro.aprobadores.map((x) => x.email).join(", ")
    r.bloquear(
      "RC2",
      `${a.de} is not an authorized approver for ${centro.centro_costo} ${centro.nombre}. Authorized: ${lista}.`,
      accionAprobadorAjeno(a.de, centro, m, p.solicitud),
    )
    return null
  }
  r.ok("RC2", `Approved by ${aprobador.nombre} (${aprobador.email}), an authorized approver for ${centro.centro_costo}.`)
  return aprobador
}

// RC3: request total within the approver's limit for that cost center.
function rc3Tope(s: Solicitud, centro: CentroCosto | null, aprobador: Aprobador | null, r: Registro): void {
  if (!centro || !aprobador) {
    r.noEvaluable("RC3", "No authorized approver identified, so the approval limit was not checked.")
    return
  }
  if (s.moneda !== "COP") {
    r.confirmar(
      "RC3",
      `Approval limits are in COP and the request is in ${s.moneda}. Check ${formatoMonto(s.valor_total, s.moneda)} against ${aprobador.nombre}'s limit of ${formatoMonto(aprobador.tope, "COP")} at today's exchange rate.`,
      { valor: s.valor_total, moneda: s.moneda, tope_cop: aprobador.tope },
    )
    return
  }
  if (s.valor_total > aprobador.tope) {
    r.bloquear(
      "RC3",
      `${formatoMonto(s.valor_total, s.moneda)} exceeds ${aprobador.nombre}'s approval limit of ${formatoMonto(aprobador.tope, "COP")} for ${centro.centro_costo}.`,
      sugerirAprobador(centro, s),
    )
    return
  }
  r.ok("RC3", `${formatoMonto(s.valor_total, s.moneda)} is within ${aprobador.nombre}'s limit of ${formatoMonto(aprobador.tope, "COP")}.`)
}

/**
 * The sender approves a different cost center. Either the request carries the wrong cost center,
 * or it needs an approver of the stated one. The agent never picks: the requester confirms.
 */
function accionAprobadorAjeno(email: string, centro: CentroCosto, m: Maestros, s: Solicitud): string {
  const propio = sugerirAprobador(centro, s)
  const otro = m.centros.find((c) => c.centro_costo !== centro.centro_costo && c.aprobadores.some((x) => normalizarEmail(x.email) === normalizarEmail(email)))
  const suyo = otro?.aprobadores.find((x) => normalizarEmail(x.email) === normalizarEmail(email))
  if (!otro || !suyo) return propio
  const alcanza = suyo.tope >= s.valor_total ? "covers" : "does not cover"
  return (
    `${suyo.nombre} approves ${otro.centro_costo} ${otro.nombre} (sub-areas: ${otro.subareas.join(", ")}; limit ${formatoMonto(suyo.tope, "COP")}, which ${alcanza} this total). ` +
    `Confirm with the requester which cost center bears this cost. If it is ${otro.centro_costo}, the requester corrects the cost center and sub-area and resubmits. ` +
    `If it stays in ${centro.centro_costo}: ${propio}`
  )
}

function sugerirAprobador(centro: CentroCosto, s: Solicitud): string {
  const validos = centro.aprobadores.filter((x) => x.tope >= s.valor_total)
  if (validos.length > 0) {
    const nombres = validos.map((x) => `${x.nombre} (${x.email}, limit ${formatoMonto(x.tope, "COP")})`).join(" or ")
    return `Ask ${nombres} to approve.`
  }
  return `No approver in ${centro.centro_costo} has a limit of ${formatoMonto(s.valor_total, s.moneda)} or more. Escalate to finance management for a limit exception. Do not split the purchase to fit a lower limit.`
}

// RC5: quote total within 2% of the request total. No quote also needs confirmation.
function rc5Cotizacion(p: Paquete, r: Registro): void {
  const s = p.solicitud
  const c = p.cotizacion
  if (!c) {
    r.confirmar("RC5", "The package has no readable supplier quote.", { solicitud: s.valor_total, cotizacion: null })
    return
  }
  if (c.moneda !== s.moneda) {
    r.confirmar("RC5", `The quote is in ${c.moneda} and the request in ${s.moneda}.`, {
      solicitud: formatoMonto(s.valor_total, s.moneda),
      cotizacion: formatoMonto(c.total, c.moneda),
    })
    return
  }
  const ratio = Math.abs(c.total - s.valor_total) / s.valor_total
  const pct = Math.round(ratio * 10000) / 100
  if (ratio > 0.02) {
    r.confirmar(
      "RC5",
      `Quote total ${formatoMonto(c.total, c.moneda)} differs from request total ${formatoMonto(s.valor_total, s.moneda)} by ${pct}% (limit 2%).`,
      { solicitud: s.valor_total, cotizacion: c.total, diferencia_pct: pct },
    )
    return
  }
  r.ok("RC5", `Quote total ${formatoMonto(c.total, c.moneda)} matches the request (difference ${pct}%).`)
}

// RC6: IVA code informed and valid, else derived from the supplier and confirmed.
function rc6IndicadorIva(p: Paquete, proveedor: Proveedor | null, m: Maestros, r: Registro): ValorDerivado | null {
  const s = p.solicitud
  if (s.indicador_iva) {
    const ind = m.iva.find((i) => i.codigo === s.indicador_iva)
    if (!ind) {
      const validos = m.iva.map((i) => i.codigo).join(", ")
      r.bloquear("RC6", `IVA code ${s.indicador_iva} does not exist (valid: ${validos}).`, "Ask the requester to correct the IVA code.")
      return null
    }
    r.ok("RC6", `IVA code ${ind.codigo} (${ind.descripcion}) comes from the request.`)
    compararTasaCotizacion(p, ind.tasa, ind.codigo, r)
    return { valor: ind.codigo, fuente: "solicitud.indicador_iva" }
  }
  if (!proveedor) {
    r.noEvaluable("RC6", "IVA code missing and supplier unknown, so no value was derived.")
    return null
  }
  const codigo = proveedor.indicador_iva_default
  const ind = m.iva.find((i) => i.codigo === codigo)
  const tasaCot = p.cotizacion?.iva_tasa
  const nota =
    tasaCot === null || tasaCot === undefined
      ? ""
      : ` The quote shows IVA ${Math.round(tasaCot * 100)}%, ${ind && ind.tasa === tasaCot ? "consistent with this code" : "which does not match this code"}.`
  r.confirmar("RC6", `The request has no IVA code. Derived ${codigo}${ind ? ` (${ind.descripcion})` : ""} from the supplier master.${nota}`, {
    derivado: codigo,
  })
  return { valor: codigo, fuente: "maestro.proveedores.indicador_iva_default" }
}

function compararTasaCotizacion(p: Paquete, tasa: number, codigo: string, r: Registro): void {
  const tasaCot = p.cotizacion?.iva_tasa
  if (tasaCot === null || tasaCot === undefined || tasaCot === tasa) return
  r.advertir(`The request uses IVA code ${codigo} (${Math.round(tasa * 100)}%) and the quote shows IVA ${Math.round(tasaCot * 100)}%.`)
}

// RC7: payment terms informed and valid, else derived from the supplier (information only).
function rc7CondicionesPago(s: Solicitud, proveedor: Proveedor | null, m: Maestros, r: Registro): ValorDerivado | null {
  if (s.condiciones_pago) {
    const cond = m.condiciones.find((c) => c.codigo === s.condiciones_pago)
    if (!cond) {
      const validos = m.condiciones.map((c) => c.codigo).join(", ")
      r.bloquear("RC7", `Payment terms ${s.condiciones_pago} do not exist (valid: ${validos}).`, "Ask the requester to correct the payment terms.")
      return null
    }
    r.ok("RC7", `Payment terms ${cond.codigo} (${cond.descripcion}) come from the request.`)
    return { valor: cond.codigo, fuente: "solicitud.condiciones_pago" }
  }
  if (!proveedor) {
    r.noEvaluable("RC7", "Payment terms missing and supplier unknown, so no value was derived.")
    return null
  }
  const codigo = proveedor.condiciones_pago_default
  const cond = m.condiciones.find((c) => c.codigo === codigo)
  r.derivar("RC7", `The request has no payment terms. Derived ${codigo}${cond ? ` (${cond.descripcion})` : ""} from the supplier master.`)
  return { valor: codigo, fuente: "maestro.proveedores.condiciones_pago_default" }
}

// RC8: an invoice dated before the request makes the PO retroactive.
function rc8Retroactiva(p: Paquete, r: Registro): boolean {
  const f = p.factura
  const s = p.solicitud
  if (!f) {
    r.ok("RC8", "No invoice in the package. The PO precedes billing.")
    return false
  }
  if (f.fecha < s.fecha_solicitud) {
    const aprobada = p.aprobacion ? fechaDe(p.aprobacion.fecha) : null
    const despues = aprobada && aprobada > f.fecha ? ` The approval (${aprobada}) also came after the invoice, so the spend was committed before anyone approved it.` : ""
    r.confirmar(
      "RC8",
      `Invoice ${f.numero} is dated ${f.fecha}, before the request date ${s.fecha_solicitud}. This PO is retroactive and will be flagged in the control log.${despues}`,
      { fecha_factura: f.fecha, fecha_solicitud: s.fecha_solicitud, factura: f.numero },
    )
    return true
  }
  r.ok("RC8", `Invoice ${f.numero} (${f.fecha}) is not earlier than the request.`)
  return false
}

// RC9: approval date on or after the request date.
function rc9FechaAprobacion(p: Paquete, r: Registro): void {
  const a = p.aprobacion
  if (!a) {
    r.noEvaluable("RC9", "No approval email, so the approval date was not checked.")
    return
  }
  const fecha = fechaDe(a.fecha)
  const s = p.solicitud
  if (!fecha) {
    r.confirmar("RC9", `The approval date "${a.fecha}" is not readable.`, { fecha_aprobacion: a.fecha })
    return
  }
  if (fecha < s.fecha_solicitud) {
    r.confirmar("RC9", `Approval date ${fecha} is before the request date ${s.fecha_solicitud}.`, {
      fecha_aprobacion: fecha,
      fecha_solicitud: s.fecha_solicitud,
    })
    return
  }
  r.ok("RC9", `Approval date ${fecha} is on or after the request date ${s.fecha_solicitud}.`)
}

// RC10: quantity x unit price equals the total, within one currency unit.
function rc10Aritmetica(s: Solicitud, r: Registro): void {
  const calculado = s.cantidad * s.valor_unitario
  if (Math.abs(calculado - s.valor_total) > 1) {
    r.bloquear(
      "RC10",
      `${s.cantidad} x ${formatoMonto(s.valor_unitario, s.moneda)} = ${formatoMonto(calculado, s.moneda)}, but the request total is ${formatoMonto(s.valor_total, s.moneda)}.`,
      "Ask the requester to correct the quantity, unit price or total.",
    )
    return
  }
  r.ok("RC10", `${s.cantidad} x ${formatoMonto(s.valor_unitario, s.moneda)} = ${formatoMonto(s.valor_total, s.moneda)}.`)
}

// Extra: the SAP payload only accepts COP or USD.
function controlMoneda(s: Solicitud, r: Registro): void {
  if (s.moneda === "COP" || s.moneda === "USD") return
  r.bloquear("MONEDA", `Currency ${s.moneda} is not supported for POs (COP or USD).`, "Ask the requester to confirm the currency.")
}

// Extra: segregation of duties. Nobody approves a purchase they requested.
function controlSegregacion(p: Paquete, r: Registro): void {
  const a = p.aprobacion
  if (!a || normalizarEmail(a.de) !== normalizarEmail(p.correo.de)) return
  r.bloquear("SOD", `${a.de} both requested and approved this purchase.`, "Ask another authorized approver of the cost center to approve.")
}

function advertenciasAdicionales(p: Paquete, r: Registro): void {
  const { solicitud: s, cotizacion: c, aprobacion: a } = p
  if (a?.monto_mencionado && c && c.total > a.monto_mencionado) {
    r.advertir(
      `The approval text names ${formatoMonto(a.monto_mencionado, s.moneda)}. The quote total of ${formatoMonto(c.total, c.moneda)} exceeds this approved amount. The PO keeps the request amount.`,
    )
  }
  if (c?.validez_hasta && c.validez_hasta < s.fecha_solicitud) {
    r.advertir(`The quote expired on ${c.validez_hasta}, before the request date ${s.fecha_solicitud}.`)
  }
  if (s.descripcion.length > 40) {
    r.advertir(
      `The description has ${s.descripcion.length} characters. SAP short text keeps 40: "${textoBreve(s.descripcion)}". The full text stays in trazabilidad.json.`,
    )
  }
}

/** Unit of measure: hours or months when the quantity matches "N horas" or "N meses", else units. */
export function derivarUnidad(p: Paquete): ValorDerivado<Unidad> {
  const s = p.solicitud
  const item = p.cotizacion?.primer_item ?? ""
  if (/^horas?\b/i.test(item) || coincideCantidad(s, /(\d+)\s+horas?\b/i)) {
    return { valor: "H", fuente: "derivado (description or quote item in hours)" }
  }
  if (/^(mes|mensualidad)\b/i.test(item) || coincideCantidad(s, /(\d+)\s+mes(?:es)?\b/i)) {
    return { valor: "MES", fuente: "derivado (description or quote item in months)" }
  }
  return { valor: "UN", fuente: "derivado (default unit)" }
}

function coincideCantidad(s: Solicitud, patron: RegExp): boolean {
  const n = patron.exec(s.descripcion)?.[1]
  return n !== undefined && Number(n) === s.cantidad
}

function ordenarControles(controles: Control[]): Control[] {
  const clave = (c: Control) => {
    const n = /^RC(\d+)/.exec(c.codigo)?.[1]
    return n ? Number(n) : 100
  }
  return [...controles].sort((a, b) => clave(a) - clave(b))
}
