/**
 * Runs every case in fixtures/reto-03/solicitudes/ by calling the tools directly.
 * No model and no API key. Output is deterministic apart from timestamps.
 *
 *   bun install && bun run demo.ts
 */
import { readdir, readFile, rm } from "node:fs/promises"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import * as oc from "./src/tools/oc.ts"
import type { ToolContext } from "./src/tools/runtime.ts"

type Respuesta = { ok: boolean; error?: string; codigo?: string; data?: Record<string, unknown> }
type Item = { codigo: string; detalle: string; accion_sugerida?: string }

const directory = fileURLToPath(new URL(".", import.meta.url))
const ctx: ToolContext = { directory, sessionId: "demo" }

async function llamar(nombre: keyof typeof oc, caso: string, extra: Record<string, unknown> = {}): Promise<Respuesta> {
  const herramienta = oc[nombre]
  const salida = await herramienta.execute({ caso, ...extra } as never, ctx)
  return JSON.parse(salida) as Respuesta
}

function lista(valor: unknown): Item[] {
  return Array.isArray(valor) ? (valor as Item[]) : []
}

async function procesar(caso: string): Promise<void> {
  console.log(`\n${caso}`)
  const lectura = await llamar("leer_paquete", caso)
  if (!lectura.ok) return console.log(`  error: ${lectura.error}`)
  const v = await llamar("validar", caso)
  if (!v.ok || !v.data) return console.log(`  error: ${v.error}`)
  const bloqueos = lista(v.data["bloqueos"])
  const confirmaciones = lista(v.data["confirmaciones"])
  console.log(`  apta: ${String(v.data["apta"])}   retroactiva: ${String(v.data["retroactiva"])}`)
  console.log(`  bloqueos: ${bloqueos.length ? "" : "none"}`)
  for (const b of bloqueos) console.log(`    ${b.codigo}: ${b.detalle}\n      next step: ${b.accion_sugerida}`)
  console.log(`  confirmaciones: ${confirmaciones.length ? "" : "none"}`)
  for (const c of confirmaciones) console.log(`    ${c.codigo}: ${c.detalle}`)
  if (v.data["apta"] !== true) return console.log("  PO: not created, blocked by the controls above")
  await llamar("construir_payload", caso)
  await llamar("generar_evidencia", caso)
  if (confirmaciones.length > 0) return console.log("  PO: not created, waiting for explicit user confirmation")
  const creada = await llamar("crear", caso)
  console.log(creada.ok ? `  PO: ${String(creada.data?.["numero_oc"])}` : `  PO: not created (${creada.codigo}): ${creada.error}`)
}

async function confirmarYCrear(caso: string, confirmado: boolean): Promise<void> {
  const r = await llamar("crear", caso, confirmado ? { confirmado: true } : {})
  if (!r.ok || !r.data) return console.log(`  ${caso}: not created: ${r.error}`)
  const etiqueta = r.data["idempotente"] === true ? "existing PO returned (idempotent)" : "PO created"
  console.log(`  ${caso}: ${etiqueta} ${String(r.data["numero_oc"])}   retroactiva: ${String(r.data["retroactiva"])}`)
}

await rm(resolve(directory, "out"), { recursive: true, force: true })
const casos = (await readdir(resolve(directory, "fixtures", "reto-03", "solicitudes"))).filter((c) => /^sol-\d+$/.test(c)).sort()

console.log("First pass: every case, no confirmation given")
for (const caso of casos) await procesar(caso)

console.log("\nIdempotency: sol-001 again")
await confirmarYCrear("sol-001", false)

console.log("\nGate check: sol-004 without confirmation, then the analyst confirms sol-004 (RC5) and sol-005 (RC8, retroactive)")
const sinConfirmar = await llamar("crear", "sol-004")
console.log(`  sol-004 without confirmado: ${sinConfirmar.codigo ?? "created"}`)
await confirmarYCrear("sol-004", true)
await confirmarYCrear("sol-005", true)

console.log("\nsol-006 stays pending: its IVA code (RC6) was never confirmed")

console.log("\nout/control.csv")
const control = await readFile(resolve(directory, "out", "control.csv"), "utf8")
for (const linea of control.trim().split("\n")) console.log(`  ${linea.split(",").slice(0, 6).join(",")}`)
