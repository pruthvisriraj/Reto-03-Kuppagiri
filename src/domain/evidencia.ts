import { createHash } from "node:crypto"
import { PDFDocument, StandardFonts, type PDFFont } from "pdf-lib"
import type { AprobacionRaw } from "./esquemas.ts"

/** The exact text the hash covers: headers, a blank line, then the body. */
export function textoEvidencia(raw: AprobacionRaw): string {
  const lineas = [
    `De: ${raw.de}`,
    `Para: ${raw.para ?? ""}`,
    `CC: ${(raw.cc ?? []).join(", ")}`,
    `Fecha: ${raw.fecha}`,
    `Asunto: ${raw.asunto}`,
    "",
    raw.cuerpo,
  ]
  return lineas.join("\n")
}

export function sha256(texto: string): string {
  return createHash("sha256").update(texto, "utf8").digest("hex")
}

export function archivoTxt(texto: string, hash: string): string {
  return `${texto}\n\n---\nSHA-256 (content above this line): ${hash}\n`
}

export async function archivoPdf(texto: string, hash: string, titulo: string, fechaDocumento: Date): Promise<Uint8Array> {
  const pdf = await PDFDocument.create()
  pdf.setTitle(titulo)
  pdf.setProducer("reto-03 purchase order agent")
  pdf.setCreator("reto-03 purchase order agent")
  pdf.setCreationDate(fechaDocumento)
  pdf.setModificationDate(fechaDocumento)

  const fuente = await pdf.embedFont(StandardFonts.Helvetica)
  const negrita = await pdf.embedFont(StandardFonts.HelveticaBold)
  const margen = 56
  const ancho = 595.28 - margen * 2
  let pagina = pdf.addPage([595.28, 841.89])
  let y = 841.89 - margen

  const escribirLinea = (linea: string, f: PDFFont, tam: number) => {
    if (y < margen + tam) {
      pagina = pdf.addPage([595.28, 841.89])
      y = 841.89 - margen
    }
    pagina.drawText(linea, { x: margen, y, size: tam, font: f })
    y -= tam * 1.45
  }

  escribirLinea(sanear(titulo, negrita), negrita, 14)
  y -= 6
  for (const parrafo of texto.split("\n")) {
    for (const linea of envolver(sanear(parrafo, fuente), fuente, 10.5, ancho)) escribirLinea(linea, fuente, 10.5)
  }
  y -= 10
  escribirLinea("SHA-256 of the evidence text:", negrita, 9)
  escribirLinea(hash, fuente, 9)
  return pdf.save({ useObjectStreams: false })
}

/** Replaces characters the standard PDF font cannot encode. */
function sanear(texto: string, fuente: PDFFont): string {
  const soportados = new Set(fuente.getCharacterSet())
  return [...texto].map((ch) => (soportados.has(ch.codePointAt(0) ?? 0) ? ch : "?")).join("")
}

function envolver(texto: string, fuente: PDFFont, tam: number, ancho: number): string[] {
  if (texto === "") return [""]
  const lineas: string[] = []
  let actual = ""
  for (const palabra of texto.split(" ")) {
    const prueba = actual ? `${actual} ${palabra}` : palabra
    if (fuente.widthOfTextAtSize(prueba, tam) <= ancho) actual = prueba
    else {
      if (actual) lineas.push(actual)
      actual = palabra
    }
  }
  lineas.push(actual)
  return lineas
}
