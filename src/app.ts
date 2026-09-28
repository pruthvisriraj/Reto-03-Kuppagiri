import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import { readFile } from "node:fs/promises"
import type { IncomingMessage, ServerResponse } from "node:http"
import { resolve } from "node:path"
import { z } from "zod"
import { ejecutarTurno } from "./agent/ciclo.ts"
import { registroPorDefecto, type Registro } from "./agent/herramientas.ts"
import { cargarSystemPrompt } from "./agent/prompt.ts"
import { AlmacenSesiones, ID_SESION } from "./agent/sesiones.ts"
import type { Config } from "./config.ts"
import { carpetaSalida, dentroDe, ID_SEGURO, rutas } from "./domain/archivos.ts"
import { ErrorLLM, type ProveedorLLM } from "./llm/adapter.ts"

export type OpcionesApp = { config: Config; directory: string; llm: ProveedorLLM | ErrorLLM; herramientas?: Registro }

const LIMITE_CUERPO = 16 * 1024
const COOKIE_SESION = "po_token"
const TOKEN_VALIDO = /^[A-Za-z0-9_-]{43}$/

const ChatSchema = z.object({
  sessionId: z.string().regex(ID_SESION, "sessionId must be 8-64 letters, digits, - or _"),
  message: z.string().trim().min(1, "message is empty").max(4000, "message is longer than 4000 characters"),
  confirm: z.boolean().optional(),
})

const ESTATICOS: Record<string, { archivo: string; tipo: string }> = {
  "/": { archivo: "index.html", tipo: "text/html; charset=utf-8" },
  "/index.html": { archivo: "index.html", tipo: "text/html; charset=utf-8" },
  "/app.js": { archivo: "app.js", tipo: "text/javascript; charset=utf-8" },
  "/styles.css": { archivo: "styles.css", tipo: "text/css; charset=utf-8" },
  "/favicon.svg": { archivo: "favicon.svg", tipo: "image/svg+xml" },
}

const ARCHIVOS_CASO: Record<string, string> = {
  "payload.json": "application/json; charset=utf-8",
  "trazabilidad.json": "application/json; charset=utf-8",
  "orden.json": "application/json; charset=utf-8",
  "aprobacion.txt": "text/plain; charset=utf-8",
  "aprobacion.pdf": "application/pdf",
}

const CABECERAS_SEGURIDAD: Record<string, string> = {
  "content-security-policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
  "cache-control": "no-store",
}

export async function crearApp(o: OpcionesApp) {
  const systemPrompt = await cargarSystemPrompt(o.directory)
  const herramientas = o.herramientas ?? registroPorDefecto()
  const sesiones = new AlmacenSesiones()
  const limitador = new LimitadorTasa(o.config.RATE_LIMIT_PER_MIN)
  const presupuesto = new PresupuestoDiario(o.config.MAX_TOKENS_PER_DAY)
  const claveHash = o.config.ACCESS_KEY ? hash(o.config.ACCESS_KEY) : null

  const confiarProxy = o.config.TRUST_PROXY === "true"

  /**
   * Owner of the request: SHA-256 of a random HttpOnly cookie. The first API call issues the cookie.
   * A session id alone is not enough to read or continue a session. Only its owner can.
   */
  const propietario = (req: IncomingMessage, res: ServerResponse): string => {
    let token = leerCookie(req, COOKIE_SESION)
    if (!token || !TOKEN_VALIDO.test(token)) {
      token = randomBytes(32).toString("base64url")
      const atributos = ["Path=/", "HttpOnly", "SameSite=Strict", "Max-Age=86400"]
      if (esHttps(req, confiarProxy)) atributos.push("Secure")
      res.setHeader("set-cookie", `${COOKIE_SESION}=${token}; ${atributos.join("; ")}`)
    }
    return createHash("sha256").update(token, "utf8").digest("hex")
  }

  const autorizado = (req: IncomingMessage) => {
    if (!claveHash) return true
    const enviada = req.headers["x-access-key"]
    return typeof enviada === "string" && timingSafeEqual(hash(enviada), claveHash)
  }

  async function chat(req: IncomingMessage, res: ServerResponse) {
    if (!limitador.permitir(ipCliente(req, confiarProxy))) {
      return json(res, 429, { error: "Too many messages. Wait one minute and try again." })
    }
    // JSON only: a cross-site HTML form cannot send this content type without a CORS preflight, which this server never grants.
    if (!(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
      return json(res, 415, { error: "Send the body as application/json." })
    }
    const cuerpo = await leerCuerpo(req)
    if (cuerpo === null) return json(res, 413, { error: "Request body too large." })
    const entrada = parsearJson(cuerpo)
    if (entrada === null) return json(res, 400, { error: "Body must be JSON with sessionId and message." })
    const parsed = ChatSchema.safeParse(entrada)
    if (!parsed.success) return json(res, 400, { error: parsed.error.issues.map((i) => i.message).join("; ") })
    if (o.llm instanceof ErrorLLM) return json(res, 503, { error: `${o.llm.message} Set LLM_PROVIDER=offline to try the app without a key.` })

    if (!presupuesto.disponible()) {
      return json(res, 429, { error: "This demo used its daily token budget. Try again tomorrow, or run it locally with your own key." })
    }
    const sesion = sesiones.obtenerOCrear(parsed.data.sessionId, propietario(req, res))
    if (!sesion) return json(res, 403, { error: "This session belongs to another browser. Start a new session." })
    if (sesion.ocupada) return json(res, 409, { error: "This session is still working on the previous message." })
    sesion.ocupada = true
    const tokensAntes = sesion.tokens
    try {
      sesion.vista.push({ rol: "user", texto: parsed.data.message, ts: new Date().toISOString() })
      const turno = await ejecutarTurno({
        sesion,
        mensaje: parsed.data.message,
        confirmacionExplicita: parsed.data.confirm === true,
        llm: o.llm,
        herramientas,
        systemPrompt,
        config: { maxIteraciones: o.config.MAX_ITERATIONS, maxTokensSesion: o.config.MAX_TOKENS_PER_SESSION },
        directory: o.directory,
      })
      sesion.vista.push({
        rol: "assistant",
        texto: turno.reply,
        ts: new Date().toISOString(),
        herramientas: turno.toolCalls,
        needsConfirmation: turno.needsConfirmation,
        pendientes: turno.pendientes,
      })
      return json(res, 200, { sessionId: sesion.id, ...turno })
    } finally {
      presupuesto.sumar(sesion.tokens - tokensAntes)
      sesion.ocupada = false
    }
  }

  function historial(req: IncomingMessage, res: ServerResponse, id: string) {
    const sesion = ID_SESION.test(id) ? sesiones.obtener(id, propietario(req, res)) : null
    if (!sesion) return json(res, 200, { id, creada: null, tokens: 0, pendiente: null, historial: [] })
    return json(res, 200, { id: sesion.id, creada: sesion.creada, tokens: sesion.tokens, pendiente: sesion.pendiente, historial: sesion.vista })
  }

  async function archivoCaso(res: ServerResponse, caso: string, archivo: string) {
    const tipo = ARCHIVOS_CASO[archivo]
    const carpeta = ID_SEGURO.test(caso) ? carpetaSalida(o.directory, caso) : null
    if (!tipo || !carpeta?.ok) return json(res, 404, { error: "File not found." })
    return enviarArchivo(res, dentroDe(carpeta.data, archivo), tipo, archivo)
  }

  return async function manejar(req: IncomingMessage, res: ServerResponse): Promise<void> {
    for (const [k, v] of Object.entries(CABECERAS_SEGURIDAD)) res.setHeader(k, v)
    const url = new URL(req.url ?? "/", "http://localhost")
    const ruta = url.pathname
    try {
      if (req.method === "GET" && ESTATICOS[ruta]) {
        const e = ESTATICOS[ruta]
        return enviarArchivo(res, resolve(o.directory, "web", e.archivo), e.tipo, null)
      }
      if (req.method === "GET" && ruta === "/api/health") {
        const llm = o.llm instanceof ErrorLLM ? { provider: "unconfigured", model: "" } : { provider: o.llm.nombre, model: o.llm.modelo }
        return json(res, 200, { ok: true, ...llm, auth: claveHash !== null, maxIterations: o.config.MAX_ITERATIONS, maxTokensPerSession: o.config.MAX_TOKENS_PER_SESSION })
      }
      if (ruta.startsWith("/api/") && !autorizado(req)) return json(res, 401, { error: "Missing or wrong access key." })
      if (req.method === "POST" && ruta === "/api/chat") return await chat(req, res)
      const mSesion = /^\/api\/sessions\/([^/]+)$/.exec(ruta)
      if (req.method === "GET" && mSesion?.[1]) return historial(req, res, mSesion[1])
      const mArchivo = /^\/api\/archivos\/([^/]+)\/([^/]+)$/.exec(ruta)
      if (req.method === "GET" && mArchivo?.[1] && mArchivo[2]) return await archivoCaso(res, mArchivo[1], mArchivo[2])
      if (req.method === "GET" && ruta === "/api/control") {
        return enviarArchivo(res, resolve(rutas.out(o.directory), "control.csv"), "text/csv; charset=utf-8", "control.csv")
      }
      return json(res, 404, { error: "Not found." })
    } catch (e) {
      console.error(`[server] ${req.method} ${ruta} failed: ${e instanceof Error ? e.message : String(e)}`)
      if (!res.headersSent) json(res, 500, { error: "Internal error. The session is still available. Try again." })
    }
  }
}

function json(res: ServerResponse, estado: number, cuerpo: unknown): void {
  res.statusCode = estado
  res.setHeader("content-type", "application/json; charset=utf-8")
  res.end(JSON.stringify(cuerpo))
}

async function enviarArchivo(res: ServerResponse, ruta: string | null, tipo: string, descarga: string | null): Promise<void> {
  if (ruta === null) return json(res, 404, { error: "File not found." })
  let contenido: Buffer
  try {
    contenido = await readFile(ruta)
  } catch {
    return json(res, 404, { error: "File not found. Process the case first." })
  }
  res.statusCode = 200
  res.setHeader("content-type", tipo)
  if (descarga) res.setHeader("content-disposition", `attachment; filename="${descarga}"`)
  res.end(contenido)
}

function leerCuerpo(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolver, rechazar) => {
    const partes: Buffer[] = []
    let total = 0
    let excedido = false
    req.on("data", (trozo: Buffer) => {
      total += trozo.length
      if (total > LIMITE_CUERPO) excedido = true
      else partes.push(trozo)
    })
    req.on("end", () => resolver(excedido ? null : Buffer.concat(partes).toString("utf8")))
    req.on("error", rechazar)
  })
}

function parsearJson(texto: string): unknown {
  try {
    return JSON.parse(texto) as unknown
  } catch {
    return null
  }
}

function hash(valor: string): Buffer {
  return createHash("sha256").update(valor, "utf8").digest()
}

function leerCookie(req: IncomingMessage, nombre: string): string | null {
  for (const parte of (req.headers.cookie ?? "").split(";")) {
    const [clave, ...valor] = parte.trim().split("=")
    if (clave === nombre) return valor.join("=")
  }
  return null
}

function esHttps(req: IncomingMessage, confiarProxy: boolean): boolean {
  if ("encrypted" in req.socket && req.socket.encrypted === true) return true
  return confiarProxy && req.headers["x-forwarded-proto"] === "https"
}

function ipCliente(req: IncomingMessage, confiarProxy: boolean): string {
  const reenviada = req.headers["x-forwarded-for"]
  if (confiarProxy && typeof reenviada === "string") return reenviada.split(",")[0]?.trim() || "desconocida"
  return req.socket.remoteAddress ?? "desconocida"
}

/**
 * Global token budget per UTC day. New sessions reset the per-session cap,
 * so a public link also needs a ceiling across all sessions.
 */
export class PresupuestoDiario {
  private dia = ""
  private usados = 0

  constructor(
    private readonly maximo: number,
    private readonly hoy: () => string = () => new Date().toISOString().slice(0, 10),
  ) {}

  disponible(): boolean {
    this.renovar()
    return this.usados < this.maximo
  }

  sumar(tokens: number): void {
    this.renovar()
    this.usados += Math.max(0, tokens)
  }

  private renovar(): void {
    const dia = this.hoy()
    if (dia !== this.dia) {
      this.dia = dia
      this.usados = 0
    }
  }
}

/** Fixed one-minute window per client IP. Enough to stop one visitor from draining the API key. */
class LimitadorTasa {
  private readonly ventanas = new Map<string, { inicio: number; cuenta: number }>()

  constructor(private readonly porMinuto: number) {}

  permitir(ip: string): boolean {
    const ahora = Date.now()
    const v = this.ventanas.get(ip)
    if (!v || ahora - v.inicio >= 60_000) {
      if (this.ventanas.size > 10_000) this.ventanas.clear()
      this.ventanas.set(ip, { inicio: ahora, cuenta: 1 })
      return true
    }
    v.cuenta += 1
    return v.cuenta <= this.porMinuto
  }
}
