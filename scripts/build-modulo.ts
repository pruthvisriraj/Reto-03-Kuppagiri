/**
 * Generates modulo/ from the same sources the web app uses, so the module never diverges:
 *   modulo/agent.md                        <- agent/prompt.md + frontmatter
 *   modulo/skill/ordenes-compra/SKILL.md   <- src/knowledge/ordenes-compra.md + frontmatter
 *   modulo/tools/oc.ts                     <- re-exports src/tools/oc.ts (written once, never copied)
 *
 *   bun scripts/build-modulo.ts           write the files
 *   bun scripts/build-modulo.ts --check   exit 1 if modulo/ is out of date
 */
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const raiz = fileURLToPath(new URL("..", import.meta.url))

const FRONTMATTER_AGENTE = `---
description: Prepares, validates and creates SAP purchase orders from a request package (request, quote, leader approval), asking the analyst to confirm every exception.
mode: primary
permission:
  edit: deny
  bash: deny
  webfetch: deny
---
`

const FRONTMATTER_SKILL = `---
name: ordenes-compra
description: Purchase order process at Periferia IT Group. Control rules RC1-RC10, what to ask the requester for each block, SAP payload notes, idempotency and the control log. Use when preparing or reviewing a purchase order.
---
`

const TOOLS_OC = `// Same tools the web app uses. Re-exported, not copied, so both surfaces stay identical.
export * from "../../src/tools/oc.ts"
`

export async function generarModulo(): Promise<Record<string, string>> {
  const prompt = await readFile(resolve(raiz, "agent/prompt.md"), "utf8")
  const conocimiento = await readFile(resolve(raiz, "src/knowledge/ordenes-compra.md"), "utf8")
  return {
    "modulo/agent.md": `${FRONTMATTER_AGENTE}\n${prompt.trim()}\n`,
    "modulo/skill/ordenes-compra/SKILL.md": `${FRONTMATTER_SKILL}\n${conocimiento.trim()}\n`,
    "modulo/tools/oc.ts": TOOLS_OC,
  }
}

export async function archivosDesactualizados(): Promise<string[]> {
  const esperados = await generarModulo()
  const distintos: string[] = []
  for (const [ruta, contenido] of Object.entries(esperados)) {
    const actual = await readFile(resolve(raiz, ruta), "utf8").catch(() => null)
    if (actual !== contenido) distintos.push(ruta)
  }
  return distintos
}

if (import.meta.main) {
  if (process.argv.includes("--check")) {
    const distintos = await archivosDesactualizados()
    if (distintos.length > 0) {
      console.error(`modulo/ is out of date: ${distintos.join(", ")}. Run: bun run build:modulo`)
      process.exit(1)
    }
    console.log("modulo/ matches its sources.")
  } else {
    for (const [ruta, contenido] of Object.entries(await generarModulo())) {
      await mkdir(dirname(resolve(raiz, ruta)), { recursive: true })
      await writeFile(resolve(raiz, ruta), contenido)
      console.log(`wrote ${ruta}`)
    }
  }
}
