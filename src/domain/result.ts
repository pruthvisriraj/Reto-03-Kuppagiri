export type Ok<T> = { ok: true; data: T }
export type Err = { ok: false; error: string; codigo?: string; data?: unknown }
export type Result<T> = Ok<T> | Err

export const ok = <T>(data: T): Ok<T> => ({ ok: true, data })

export const err = (error: string, codigo?: string, data?: unknown): Err => {
  const e: Err = { ok: false, error }
  if (codigo !== undefined) e.codigo = codigo
  if (data !== undefined) e.data = data
  return e
}

export function mensajeDeError(e: unknown): string {
  if (e instanceof Error) return e.message
  return String(e)
}
