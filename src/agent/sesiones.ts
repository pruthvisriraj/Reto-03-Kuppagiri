import type { Mensaje } from "../llm/adapter.ts"

export const ID_SESION = /^[A-Za-z0-9_-]{8,64}$/

export type TrazaHerramienta = {
  nombre: string
  args: Record<string, unknown>
  ok: boolean
  resumen: string
  resultado: unknown
  duracionMs: number
  bloqueadaPorGuardia: boolean
}

export type EntradaVista = {
  rol: "user" | "assistant"
  texto: string
  ts: string
  herramientas?: TrazaHerramienta[]
  needsConfirmation?: boolean
  pendientes?: string[]
}

export type Pendiente = { caso: string; huella: string | null }

export type Sesion = {
  id: string
  /** SHA-256 of the browser's session cookie. Only the owner reads or continues the session. */
  propietario: string
  creada: string
  ultimoUso: number
  mensajes: Mensaje[]
  vista: EntradaVista[]
  tokens: number
  /** Cases waiting for the user's explicit confirmation, each with the fingerprint of the order shown. */
  pendiente: { casos: Pendiente[] } | null
  ocupada: boolean
}

/** Sessions live in memory. The oldest idle session is evicted past the limit. */
export class AlmacenSesiones {
  private readonly sesiones = new Map<string, Sesion>()

  constructor(private readonly maximo = 200) {}

  /** Returns the session only to its owner. A stranger gets the same answer as for a missing session. */
  obtener(id: string, propietario: string): Sesion | null {
    const s = this.sesiones.get(id)
    return s && s.propietario === propietario ? s : null
  }

  /** Continues the owner's session or creates a new one. Returns null when another owner holds the id. */
  obtenerOCrear(id: string, propietario: string): Sesion | null {
    const existente = this.sesiones.get(id)
    if (existente) {
      if (existente.propietario !== propietario) return null
      existente.ultimoUso = Date.now()
      return existente
    }
    this.desalojar()
    const nueva: Sesion = {
      id,
      propietario,
      creada: new Date().toISOString(),
      ultimoUso: Date.now(),
      mensajes: [],
      vista: [],
      tokens: 0,
      pendiente: null,
      ocupada: false,
    }
    this.sesiones.set(id, nueva)
    return nueva
  }

  private desalojar(): void {
    if (this.sesiones.size < this.maximo) return
    const libres = [...this.sesiones.values()].filter((s) => !s.ocupada).sort((a, b) => a.ultimoUso - b.ultimoUso)
    const victima = libres[0]
    if (victima) this.sesiones.delete(victima.id)
  }
}
