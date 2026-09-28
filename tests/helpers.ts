import { cp, mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import type { ToolContext } from "../src/tools/runtime.ts"

export const RAIZ = fileURLToPath(new URL("..", import.meta.url))

/** Isolated copy of fixtures, prompt and knowledge. Each test writes its own out/. */
export async function espacioTemporal(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "reto03-"))
  await cp(resolve(RAIZ, "fixtures"), resolve(dir, "fixtures"), { recursive: true })
  await cp(resolve(RAIZ, "agent"), resolve(dir, "agent"), { recursive: true })
  await mkdir(resolve(dir, "src", "knowledge"), { recursive: true })
  await cp(resolve(RAIZ, "src/knowledge"), resolve(dir, "src/knowledge"), { recursive: true })
  return dir
}

export function contexto(directory: string, sessionId = "test"): ToolContext {
  return { directory, sessionId }
}

export async function escribirCaso(directory: string, caso: string, archivos: Record<string, string>): Promise<void> {
  const carpeta = resolve(directory, "fixtures", "reto-03", "solicitudes", caso)
  await mkdir(carpeta, { recursive: true })
  for (const [nombre, contenido] of Object.entries(archivos)) await writeFile(resolve(carpeta, nombre), contenido)
}

export type Respuesta = { ok: boolean; error?: string; codigo?: string; data?: Record<string, unknown> }
export const leer = (s: string) => JSON.parse(s) as Respuesta
