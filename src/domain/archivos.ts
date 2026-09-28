import { mkdir, readFile, writeFile, appendFile } from "node:fs/promises"
import { dirname, isAbsolute, relative, resolve, sep } from "node:path"
import { err, ok, mensajeDeError, type Result } from "./result.ts"

/** Case ids and file names accepted from the model or the HTTP API. */
export const ID_SEGURO = /^[a-z0-9][a-z0-9-]{0,63}$/

export const rutas = {
  fixtures: (dir: string) => resolve(dir, "fixtures", "reto-03"),
  solicitudes: (dir: string) => resolve(dir, "fixtures", "reto-03", "solicitudes"),
  maestros: (dir: string) => resolve(dir, "fixtures", "reto-03", "maestros"),
  out: (dir: string) => resolve(dir, "out"),
}

/**
 * Resolves `partes` under `base` and returns null when the result escapes `base`.
 * Every path built from model or user input goes through here.
 */
export function dentroDe(base: string, ...partes: string[]): string | null {
  const raiz = resolve(base)
  const destino = resolve(raiz, ...partes)
  const rel = relative(raiz, destino)
  if (rel === "") return destino
  if (isAbsolute(rel) || rel.split(sep)[0] === "..") return null
  return destino
}

export function carpetaCaso(directory: string, caso: string): Result<string> {
  if (!ID_SEGURO.test(caso)) return err(`Invalid case id "${caso}". Use a folder name such as sol-001.`, "CASO_INVALIDO")
  const ruta = dentroDe(rutas.solicitudes(directory), caso)
  if (ruta === null) return err(`Case id "${caso}" points outside the fixtures folder.`, "CASO_INVALIDO")
  return ok(ruta)
}

export function carpetaSalida(directory: string, caso: string): Result<string> {
  if (!ID_SEGURO.test(caso)) return err(`Invalid case id "${caso}".`, "CASO_INVALIDO")
  const ruta = dentroDe(rutas.out(directory), caso)
  if (ruta === null) return err(`Case id "${caso}" points outside the out folder.`, "CASO_INVALIDO")
  return ok(ruta)
}

/** Reads a UTF-8 file. Returns ok(null) when the file does not exist. */
export async function leerOpcional(ruta: string): Promise<Result<string | null>> {
  try {
    return ok(await readFile(ruta, "utf8"))
  } catch (e) {
    if (esNoExiste(e)) return ok(null)
    return err(`Could not read ${nombreCorto(ruta)}: ${mensajeDeError(e)}`, "LECTURA")
  }
}

export async function leerJsonOpcional(ruta: string): Promise<Result<unknown | null>> {
  const texto = await leerOpcional(ruta)
  if (!texto.ok) return texto
  if (texto.data === null) return ok(null)
  try {
    return ok(JSON.parse(texto.data) as unknown)
  } catch {
    return err(`${nombreCorto(ruta)} is not valid JSON.`, "JSON_MALFORMADO")
  }
}

export async function escribir(ruta: string, contenido: string | Uint8Array): Promise<void> {
  await mkdir(dirname(ruta), { recursive: true })
  await writeFile(ruta, contenido)
}

export async function agregarLinea(ruta: string, linea: string): Promise<void> {
  await mkdir(dirname(ruta), { recursive: true })
  await appendFile(ruta, linea.endsWith("\n") ? linea : `${linea}\n`, "utf8")
}

function esNoExiste(e: unknown): boolean {
  return typeof e === "object" && e !== null && "code" in e && (e as { code: unknown }).code === "ENOENT"
}

function nombreCorto(ruta: string): string {
  const partes = ruta.split(sep)
  return partes.slice(-2).join("/")
}
