import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { crearApp, PresupuestoDiario } from "../src/app.ts"
import { leerConfig } from "../src/config.ts"
import { ProveedorOffline } from "../src/llm/offline.ts"
import { espacioTemporal, RAIZ } from "./helpers.ts"
import { cp } from "node:fs/promises"
import { resolve } from "node:path"

let servidor: Server
let base = ""

beforeAll(async () => {
  const dir = await espacioTemporal()
  await cp(resolve(RAIZ, "web"), resolve(dir, "web"), { recursive: true })
  const config = leerConfig({ LLM_PROVIDER: "offline", ACCESS_KEY: "clave-demo", RATE_LIMIT_PER_MIN: "3" })
  const manejar = await crearApp({ config, directory: dir, llm: new ProveedorOffline() })
  servidor = createServer((req, res) => void manejar(req, res))
  await new Promise<void>((r) => servidor.listen(0, r))
  base = `http://127.0.0.1:${(servidor.address() as AddressInfo).port}`
})

afterAll(() => servidor.close())

const chat = (cuerpo: unknown, clave = "clave-demo") =>
  fetch(`${base}/api/chat`, { method: "POST", headers: { "content-type": "application/json", "x-access-key": clave }, body: JSON.stringify(cuerpo) })

describe("HTTP API", () => {
  test("health is public and exposes no secrets", async () => {
    const r = (await (await fetch(`${base}/api/health`)).json()) as Record<string, unknown>
    expect(r["auth"]).toBe(true)
    expect(JSON.stringify(r)).not.toContain("clave-demo")
  })

  test("the chat needs the access key", async () => {
    expect((await chat({ sessionId: "sesion-http-1", message: "Process sol-001" }, "wrong")).status).toBe(401)
  })

  test("chat works with the key and returns tool calls", async () => {
    const r = (await (await chat({ sessionId: "sesion-http-1", message: "Process sol-002" })).json()) as Record<string, unknown>
    expect(Array.isArray(r["toolCalls"])).toBe(true)
    expect(String(r["reply"])).toContain("blocked")
  })

  test("static files come from an allowlist and carry a strict CSP", async () => {
    const pagina = await fetch(`${base}/`)
    expect(pagina.headers.get("content-security-policy")).toContain("default-src 'self'")
    expect((await fetch(`${base}/..%2Fpackage.json`)).status).toBe(404)
  })

  test("rate limit per client", async () => {
    const estados: number[] = []
    for (let i = 0; i < 4; i++) estados.push((await chat({ sessionId: "sesion-http-2", message: "hello" })).status)
    expect(estados).toContain(429)
  })
})

describe("daily token budget", () => {
  test("stops at the ceiling and resets the next day", () => {
    let dia = "2026-10-01"
    const p = new PresupuestoDiario(1000, () => dia)
    expect(p.disponible()).toBe(true)
    p.sumar(1200)
    expect(p.disponible()).toBe(false)
    dia = "2026-10-02"
    expect(p.disponible()).toBe(true)
  })
})
