import type { Config } from "../config.ts"
import { ErrorLLM, type ProveedorLLM } from "./adapter.ts"
import { ProveedorAnthropic } from "./anthropic.ts"
import { ProveedorOffline } from "./offline.ts"

/** The only place that knows which providers exist. The agent loop receives a ProveedorLLM. */
export function crearProveedor(config: Config): ProveedorLLM | ErrorLLM {
  if (config.LLM_PROVIDER === "offline") return new ProveedorOffline()
  try {
    return new ProveedorAnthropic({
      apiKey: config.ANTHROPIC_API_KEY,
      modelo: config.LLM_MODEL,
      timeoutMs: config.LLM_TIMEOUT_MS,
      maxTokensSalida: config.LLM_MAX_OUTPUT_TOKENS,
    })
  } catch (e) {
    if (e instanceof ErrorLLM) return e
    return new ErrorLLM("The model provider could not start.", "configuracion")
  }
}
