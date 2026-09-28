/**
 * Provider-neutral message and tool types. The agent loop only knows these
 * types, so switching provider means adding one file under src/llm/.
 */

export type LlamadaHerramienta = { id: string; nombre: string; args: Record<string, unknown> }
export type ResultadoHerramienta = { idLlamada: string; nombre: string; contenido: string; esError: boolean }

export type Mensaje =
  | { rol: "system"; contenido: string }
  | { rol: "user"; contenido: string }
  | { rol: "assistant"; contenido: string; llamadas: LlamadaHerramienta[] }
  | { rol: "tool"; resultados: ResultadoHerramienta[] }

/** Tool as the model sees it: name, one-sentence description, JSON Schema of the arguments. */
export type EspecificacionHerramienta = { nombre: string; descripcion: string; parametros: Record<string, unknown> }

export type RespuestaLLM = {
  texto: string
  llamadas: LlamadaHerramienta[]
  uso: { entrada: number; salida: number }
  motivoFin: "fin" | "herramientas" | "limite_tokens" | "otro"
}

export interface ProveedorLLM {
  readonly nombre: string
  readonly modelo: string
  enviar(mensajes: Mensaje[], herramientas: EspecificacionHerramienta[]): Promise<RespuestaLLM>
}

export type TipoErrorLLM = "configuracion" | "autenticacion" | "limite_tasa" | "timeout" | "proveedor" | "respuesta_invalida"

/** Errors carry a message safe to show in the chat. They never include keys or raw provider bodies. */
export class ErrorLLM extends Error {
  constructor(
    message: string,
    readonly tipo: TipoErrorLLM,
  ) {
    super(message)
    this.name = "ErrorLLM"
  }
}
