/** SAP short text: max 40 characters, cut at a word boundary when possible. */
export function textoBreve(texto: string, max = 40): string {
  const limpio = texto.replace(/\s+/g, " ").trim()
  if (limpio.length <= max) return limpio
  const ventana = limpio.slice(0, max + 1)
  const espacio = ventana.lastIndexOf(" ")
  const corte = espacio >= max / 2 ? ventana.slice(0, espacio) : limpio.slice(0, max)
  return quitarConectoresFinales(corte.replace(/[\s,;:.\-]+$/, ""))
}

const CONECTORES = new Set(["de", "del", "la", "el", "los", "las", "para", "con", "y", "en", "a", "por"])

/** "Bolsa de 100 horas de arquitectura de" -> "Bolsa de 100 horas de arquitectura". */
function quitarConectoresFinales(texto: string): string {
  const palabras = texto.split(" ")
  while (palabras.length > 1 && CONECTORES.has((palabras.at(-1) ?? "").toLowerCase())) palabras.pop()
  return palabras.join(" ").replace(/[\s,;:.\-]+$/, "")
}

/** JSON with sorted keys, so two objects with the same content produce the same string. */
export function jsonCanonico(valor: unknown): string {
  return JSON.stringify(ordenar(valor))
}

function ordenar(valor: unknown): unknown {
  if (Array.isArray(valor)) return valor.map(ordenar)
  if (valor !== null && typeof valor === "object") {
    const entradas = Object.entries(valor as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
    return Object.fromEntries(entradas.map(([k, v]) => [k, ordenar(v)]))
  }
  return valor
}
