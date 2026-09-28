import type { Aprobacion, AprobacionRaw, Cotizacion, Factura } from "./esquemas.ts"

// ---------- Normalization ----------

/** Tax id without check digit, dots or spaces: "900.555.111-2" -> "900555111". */
export function normalizarNit(nit: string): string {
  const sinDv = nit.split("-")[0] ?? ""
  return sinDv.replace(/\D/g, "")
}

/** Lowercase, no accents, no punctuation: "TecnoSuministros S.A.S." -> "tecnosuministros sas". */
export function normalizarNombre(nombre: string): string {
  return nombre
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\./g, "")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

/** Emails compared in NFC and lowercase, so "sofía" typed two ways still matches. */
export function normalizarEmail(email: string): string {
  return email.normalize("NFC").trim().toLowerCase()
}

/** Date part of an ISO timestamp in its own offset: "2026-08-21T10:02:00-05:00" -> "2026-08-21". */
export function fechaDe(valor: string): string | null {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(valor.trim())
  return m?.[1] ?? null
}

export function sumarDias(fecha: string, dias: number): string {
  const d = new Date(`${fecha}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + dias)
  return d.toISOString().slice(0, 10)
}

/**
 * Parses amounts written as "11.400.000", "120,000.00", "1.850.000,50" or "95000".
 * Returns null when the text is not a number.
 */
export function parsearMonto(texto: string): number | null {
  const limpio = texto.replace(/[^\d.,]/g, "")
  if (!/\d/.test(limpio)) return null
  const ultimoPunto = limpio.lastIndexOf(".")
  const ultimaComa = limpio.lastIndexOf(",")
  let normal: string
  if (ultimoPunto >= 0 && ultimaComa >= 0) {
    const decimal = ultimoPunto > ultimaComa ? "." : ","
    const miles = decimal === "." ? "," : "."
    normal = limpio.split(miles).join("").replace(decimal, ".")
  } else {
    const separador = ultimoPunto >= 0 ? "." : ultimaComa >= 0 ? "," : ""
    normal = separador && esSeparadorDeMiles(limpio, separador) ? limpio.split(separador).join("") : limpio.replace(",", ".")
  }
  const n = Number(normal)
  return Number.isFinite(n) ? n : null
}

function esSeparadorDeMiles(texto: string, separador: string): boolean {
  const grupos = texto.split(separador)
  return grupos.length > 1 && grupos.slice(1).every((g) => g.length === 3)
}

// ---------- Quote ----------

export function leerCotizacion(texto: string): { cotizacion: Cotizacion | null; aviso: string | null } {
  const total = /^TOTAL[^:\n]*:\s*([A-Z]{3})\s*\$?\s*([\d.,]+)/im.exec(texto)
  const proveedor = /^Proveedor:\s*(.+)$/im.exec(texto)
  if (!total?.[1] || !total[2] || !proveedor?.[1]) {
    return { cotizacion: null, aviso: "The quote has no readable supplier or TOTAL line." }
  }
  const monto = parsearMonto(total[2])
  if (monto === null) return { cotizacion: null, aviso: "The quote TOTAL is not a number." }

  const fecha = /^Fecha:\s*(\d{4}-\d{2}-\d{2})/im.exec(texto)?.[1] ?? null
  const validezDias = /Validez de la oferta:\s*(\d+)\s*d[ií]as/i.exec(texto)?.[1]
  const iva = /IVA\s*(\d+(?:[.,]\d+)?)\s*%/i.exec(texto)?.[1]
  return {
    aviso: null,
    cotizacion: {
      proveedor: proveedor[1].trim(),
      nit: /^NIT:\s*([\d.\- ]+)/im.exec(texto)?.[1]?.trim() ?? null,
      total: monto,
      moneda: total[1].toUpperCase(),
      validez_hasta: fecha && validezDias ? sumarDias(fecha, Number(validezDias)) : null,
      texto,
      referencia: /^COTIZACI[OÓ]N\s+(\S+)/im.exec(texto)?.[1] ?? null,
      fecha,
      iva_tasa: iva ? Number(iva.replace(",", ".")) / 100 : null,
      primer_item: /^\s*1\.\s*([^|\n]+)/m.exec(texto)?.[1]?.trim() ?? null,
    },
  }
}

// ---------- Approval ----------

export function leerAprobacion(raw: AprobacionRaw): Aprobacion {
  const cuerpo = raw.cuerpo
  const negada = /\bno\s+(?:est[aá]\s+|ha\s+sido\s+)?aprobad[oa]\b|\brechazad[oa]\b/i.test(cuerpo)
  return {
    de: raw.de,
    fecha: raw.fecha,
    aprobado: /\baprobad[oa]\b/i.test(cuerpo) && !negada,
    texto: cuerpo,
    monto_mencionado: montoMencionado(cuerpo),
  }
}

/** "Aprobado por 25 millones" -> 25000000. Null when the approval names no amount. */
function montoMencionado(cuerpo: string): number | null {
  const m = /aprobad[oa]\s+por\s+(?:COP\s*|\$\s*)?([\d.,]+)\s*(millones|mill[oó]n)?/i.exec(cuerpo)
  if (!m?.[1]) return null
  const base = parsearMonto(m[1])
  if (base === null) return null
  return m[2] ? base * 1_000_000 : base
}

// ---------- Invoice ----------

export function leerFactura(texto: string): { factura: Factura | null; aviso: string | null } {
  const numero = /FACTURA[^\n]*?No\.?\s*(\S+)/i.exec(texto)?.[1]
  const fecha = /Fecha(?: de emisi[oó]n)?:\s*(\d{4}-\d{2}-\d{2})/i.exec(texto)?.[1]
  const total = /^TOTAL:\s*[A-Z]{3}\s*\$?\s*([\d.,]+)/im.exec(texto)?.[1]
  const monto = total ? parsearMonto(total) : null
  if (!numero || !fecha || monto === null) {
    return { factura: null, aviso: "The invoice is missing a readable number, issue date or total." }
  }
  return { factura: { numero, fecha, total: monto }, aviso: null }
}
