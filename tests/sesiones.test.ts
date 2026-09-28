import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { cp } from "node:fs/promises"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { resolve } from "node:path"
import { crearApp } from "../src/app.ts"
import { leerConfig } from "../src/config.ts"
import { ProveedorOffline } from "../src/llm/offline.ts"
import { espacioTemporal, RAIZ } from "./helpers.ts"

let servidor: Server
let base = ""

beforeAll(async () => {
  const dir = await espacioTemporal()
  await cp(resolve(RAIZ, "web"), resolve(dir, "web"), { recursive: true })
  const manejar = await crearApp({ config: leerConfig({ LLM_PROVIDER: "offline", RATE_LIMIT_PER_MIN: "100" }), directory: dir, llm: new ProveedorOffline() })
  servidor = createServer((req, res) => void manejar(req, res))
  await new Promise<void>((r) => servidor.listen(0, r))
  base = `http://127.0.0.1:${(servidor.address() as AddressInfo).port}`
})

afterAll(() => servidor.close())

const chat = (cuerpo: unknown, cookie?: string) =>
  fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(cuerpo),
  })

const cookieDe = (r: Response) => (r.headers.get("set-cookie") ?? "").split(";")[0] ?? ""

describe("sessions bound to a browser cookie", () => {
  test("the first call issues an HttpOnly, SameSite=Strict cookie", async () => {
    const r = await chat({ sessionId: "sesion-cookie-1", message: "Process sol-002" })
    const cabecera = r.headers.get("set-cookie") ?? ""
    expect(r.status).toBe(200)
    expect(cabecera).toStartWith("po_token=")
    expect(cabecera).toContain("HttpOnly")
    expect(cabecera).toContain("SameSite=Strict")
  })

  test("only the owner continues or reads a session", async () => {
    const primera = await chat({ sessionId: "sesion-cookie-2", message: "Process sol-002" })
    const cookie = cookieDe(primera)
    expect((await chat({ sessionId: "sesion-cookie-2", message: "Process sol-003" }, cookie)).status).toBe(200)
    expect((await chat({ sessionId: "sesion-cookie-2", message: "Process sol-001" })).status).toBe(403)
    expect((await chat({ sessionId: "sesion-cookie-2", message: "Process sol-001" }, "po_token=" + "x".repeat(43))).status).toBe(403)

    const ajeno = (await (await fetch(`${base}/api/sessions/sesion-cookie-2`)).json()) as { historial: unknown[] }
    expect(ajeno.historial).toEqual([])
    const propio = (await (await fetch(`${base}/api/sessions/sesion-cookie-2`, { headers: { cookie } })).json()) as { historial: unknown[] }
    expect(propio.historial.length).toBe(4)
  })

  test("the chat accepts JSON only", async () => {
    const r = await fetch(`${base}/api/chat`, { method: "POST", headers: { "content-type": "text/plain" }, body: "sessionId=x&message=hi" })
    expect(r.status).toBe(415)
  })
})
