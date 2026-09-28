import { resolve } from "node:path"
import type { z } from "zod"
import { agregarLinea, rutas } from "../domain/archivos.ts"
import { err, mensajeDeError, type Result } from "../domain/result.ts"

export type ToolContext = {
  directory: string
  sessionId: string
  /**
   * Set by the web server only: cases the analyst confirmed in this turn, each bound to the
   * fingerprint of the exact order shown at review time. Hosts without it (demo.ts, other
   * agent platforms) rely on confirmado=true and must run their own confirmation gate.
   */
  consentimientos?: ReadonlyMap<string, string>
}

/**
 * Tool contract from the PRD (6.2): a one-sentence description, zod argument
 * shapes, and an execute function returning serialized { ok, data } or
 * { ok: false, error }. Execute never throws.
 */
export interface ToolDef<A extends z.ZodRawShape = z.ZodRawShape> {
  description: string
  args: A
  execute(args: z.output<z.ZodObject<A>>, ctx: ToolContext): Promise<string>
}

export function definirHerramienta<A extends z.ZodRawShape>(def: ToolDef<A>): ToolDef<A> {
  return def
}

/** Runs a tool body, converts any exception into { ok: false }, and writes out/log.jsonl. */
export async function ejecutarSeguro<T>(
  herramienta: string,
  ctx: ToolContext,
  caso: string | null,
  cuerpo: () => Promise<Result<T>>,
  resumir: (data: T) => string,
): Promise<string> {
  let resultado: Result<T>
  try {
    resultado = await cuerpo()
  } catch (e) {
    const mensaje = mensajeDeError(e).split(ctx.directory).join(".")
    resultado = err(`Unexpected error in ${herramienta}: ${mensaje}`, "ERROR_INTERNO")
  }
  const resumen = resultado.ok ? resumirSeguro(resumir, resultado.data) : resultado.error
  await registrarLog(ctx, { herramienta, caso, ok: resultado.ok, resumen })
  return JSON.stringify(resultado)
}

export type EntradaLog = { herramienta: string; caso: string | null; ok: boolean; resumen: string }

export async function registrarLog(ctx: ToolContext, entrada: EntradaLog): Promise<void> {
  const linea = { ts: new Date().toISOString(), sesion: ctx.sessionId, ...entrada }
  try {
    await agregarLinea(resolve(rutas.out(ctx.directory), "log.jsonl"), JSON.stringify(linea))
  } catch {
    // Logging must never break a tool call.
  }
}

function resumirSeguro<T>(resumir: (data: T) => string, data: T): string {
  try {
    return resumir(data)
  } catch {
    return "ok"
  }
}
