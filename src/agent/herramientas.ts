import { z } from "zod"
import type { EspecificacionHerramienta } from "../llm/adapter.ts"
import * as oc from "../tools/oc.ts"
import { registrarLog, type ToolContext, type ToolDef } from "../tools/runtime.ts"

export type HerramientaRegistrada = {
  nombre: string
  def: ToolDef
  esquema: z.ZodObject<z.ZodRawShape>
  spec: EspecificacionHerramienta
}

export type Registro = Map<string, HerramientaRegistrada>

/** Builds the tool registry. The model-facing name is "<file>_<export>" (PRD 6.2). */
export function registrarHerramientas(modulos: Record<string, Record<string, ToolDef>>): Registro {
  const registro: Registro = new Map()
  for (const [archivo, exportaciones] of Object.entries(modulos)) {
    for (const [exportacion, def] of Object.entries(exportaciones)) {
      const nombre = `${archivo}_${exportacion}`
      const esquema = z.object(def.args).strict()
      const parametros = z.toJSONSchema(esquema) as Record<string, unknown>
      registro.set(nombre, { nombre, def, esquema, spec: { nombre, descripcion: def.description, parametros } })
    }
  }
  return registro
}

export const registroPorDefecto = (): Registro => registrarHerramientas({ oc })

/** Validates arguments with zod before running. A validation error goes back to the model, not to the user. */
export async function ejecutarRegistrada(
  h: HerramientaRegistrada,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<string> {
  const parsed = h.esquema.safeParse(args)
  if (!parsed.success) {
    const detalle = parsed.error.issues.map((i) => `${i.path.join(".") || "(args)"}: ${i.message}`).join("; ")
    const caso = typeof args["caso"] === "string" ? args["caso"].slice(0, 64) : null
    await registrarLog(ctx, { herramienta: h.nombre, caso, ok: false, resumen: `invalid arguments: ${detalle}` })
    return JSON.stringify({ ok: false, error: `Invalid arguments for ${h.nombre}: ${detalle}`, codigo: "ARGS_INVALIDOS" })
  }
  return h.def.execute(parsed.data, ctx)
}
