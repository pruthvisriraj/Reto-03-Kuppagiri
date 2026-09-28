import { readFile } from "node:fs/promises"
import { resolve } from "node:path"

export const RUTA_PROMPT = "agent/prompt.md"
export const RUTA_CONOCIMIENTO = "src/knowledge/ordenes-compra.md"

/** System prompt = behavior (agent/prompt.md) + process knowledge (src/knowledge/). */
export async function cargarSystemPrompt(directory: string): Promise<string> {
  const [comportamiento, conocimiento] = await Promise.all([
    readFile(resolve(directory, RUTA_PROMPT), "utf8"),
    readFile(resolve(directory, RUTA_CONOCIMIENTO), "utf8"),
  ])
  return `${comportamiento.trim()}\n\n---\n\n${conocimiento.trim()}\n`
}
