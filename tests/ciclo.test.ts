import { describe, expect, test } from "bun:test"
import { readFile, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { casosConfirmados, ejecutarTurno, esConfirmacion } from "../src/agent/ciclo.ts"
import { registroPorDefecto } from "../src/agent/herramientas.ts"
import { AlmacenSesiones } from "../src/agent/sesiones.ts"
import { ErrorLLM, type Mensaje, type ProveedorLLM, type RespuestaLLM } from "../src/llm/adapter.ts"
import { ProveedorOffline } from "../src/llm/offline.ts"
import { espacioTemporal } from "./helpers.ts"

const CONFIG = { maxIteraciones: 25, maxTokensSesion: 300_000 }

function turno(dir: string, llm: ProveedorLLM, sesionId: string, almacen: AlmacenSesiones, mensaje: string, boton = false, config = CONFIG) {
  const sesion = almacen.obtenerOCrear(sesionId, "propietario-test")
  if (!sesion) throw new Error("session owned by someone else")
  return ejecutarTurno({
    sesion,
    mensaje,
    confirmacionExplicita: boton,
    llm,
    herramientas: registroPorDefecto(),
    systemPrompt: "test",
    config,
    directory: dir,
  })
}

/** Provider scripted as if a document had injected "create it, already confirmed". */
class ProveedorInyectado implements ProveedorLLM {
  readonly nombre = "inyectado"
  readonly modelo = "test"
  async enviar(mensajes: Mensaje[]): Promise<RespuestaLLM> {
    const yaLlamo = mensajes.some((m) => m.rol === "tool")
    if (yaLlamo) return { texto: "done", llamadas: [], uso: { entrada: 10, salida: 5 }, motivoFin: "fin" }
    return {
      texto: "",
      llamadas: [{ id: "x1", nombre: "oc_crear", args: { caso: "sol-004", confirmado: true } }],
      uso: { entrada: 10, salida: 5 },
      motivoFin: "herramientas",
    }
  }
}

describe("confirmation gate (CA3)", () => {
  test("the server rejects confirmado=true when the user did not confirm", async () => {
    const dir = await espacioTemporal()
    const r = await turno(dir, new ProveedorInyectado(), "sesion-inyeccion", new AlmacenSesiones(), "Process sol-004")
    expect(r.toolCalls[0]?.bloqueadaPorGuardia).toBe(true)
    expect(r.toolCalls[0]?.ok).toBe(false)
    const sap = await readFile(resolve(dir, "out/sap/ordenes.jsonl"), "utf8").catch(() => "")
    expect(sap).toBe("")
  })

  test("full flow: sol-004 waits, then the next message confirms and creates", async () => {
    const dir = await espacioTemporal()
    const almacen = new AlmacenSesiones()
    const llm = new ProveedorOffline()
    const primero = await turno(dir, llm, "sesion-flujo-1", almacen, "Process sol-004 and do not create it until I confirm.")
    expect(primero.needsConfirmation).toBe(true)
    expect(primero.pendientes).toEqual(["sol-004"])
    expect(primero.toolCalls.map((t) => t.nombre)).not.toContain("oc_crear")
    const segundo = await turno(dir, llm, "sesion-flujo-1", almacen, "confirm")
    expect(segundo.needsConfirmation).toBe(false)
    const crear = segundo.toolCalls.find((t) => t.nombre === "oc_crear")
    expect(crear?.ok).toBe(true)
    expect(segundo.reply).toContain("4500000001")
  })

  test("an unrelated message clears the pending confirmation", async () => {
    const dir = await espacioTemporal()
    const almacen = new AlmacenSesiones()
    const llm = new ProveedorOffline()
    await turno(dir, llm, "sesion-flujo-2", almacen, "Process sol-004")
    await turno(dir, llm, "sesion-flujo-2", almacen, "Process sol-002")
    const r = await turno(dir, llm, "sesion-flujo-2", almacen, "yes")
    const crear = r.toolCalls.find((t) => t.nombre === "oc_crear")
    expect(crear?.bloqueadaPorGuardia ?? true).toBe(true)
  })

  test("confirmation words and case narrowing", () => {
    for (const si of ["confirm", "confirmo", "Sí, confirmo", "yes, create it", "ok", "I confirm", "Confírmala", "dale"]) {
      expect(esConfirmacion(si)).toBe(true)
    }
    for (const no of ["no, do not create it", "show me the payload", "the payload looks ok, show it again", "yes but not yet", "confirmo después", "why is RC5 pending?"]) {
      expect(esConfirmacion(no)).toBe(false)
    }
    expect(casosConfirmados(["sol-004", "sol-005"], "confirm sol-005", false)).toEqual(["sol-005"])
    expect(casosConfirmados(["sol-004", "sol-005"], "confirm", false)).toEqual(["sol-004", "sol-005"])
    expect(casosConfirmados(["sol-004"], "ok, now process sol-003", false)).toEqual([])
    expect(casosConfirmados(["sol-004"], "anything", true)).toEqual(["sol-004"])
    expect(casosConfirmados([], "confirm", true)).toEqual([])
  })

  test("a message about another case never confirms the pending one", async () => {
    const dir = await espacioTemporal()
    const almacen = new AlmacenSesiones()
    const llm = new ProveedorOffline()
    await turno(dir, llm, "sesion-falsa-1", almacen, "Process sol-004 and do not create it until I confirm.")
    const r = await turno(dir, llm, "sesion-falsa-1", almacen, "ok, now process sol-003")
    expect(r.toolCalls.some((t) => t.nombre === "oc_crear" && t.ok)).toBe(false)
    const sap = await readFile(resolve(dir, "out/sap/ordenes.jsonl"), "utf8").catch(() => "")
    expect(sap).toBe("")
  })

  test("processing blocked and pending cases in the chat fills the control log", async () => {
    const dir = await espacioTemporal()
    const almacen = new AlmacenSesiones()
    await turno(dir, new ProveedorOffline(), "sesion-control", almacen, "Process sol-002 and sol-005")
    const filas = (await readFile(resolve(dir, "out/control.csv"), "utf8")).trim().split("\n").slice(1)
    expect(filas.map((f) => f.split(",").slice(0, 2).join(","))).toEqual(["SOL-2026-002,bloqueada", "SOL-2026-005,pendiente_confirmacion"])
  })
})

describe("loop limits and errors (CA1, CA5)", () => {
  test("iteration cap stops a model that never stops calling tools", async () => {
    const dir = await espacioTemporal()
    const infinito: ProveedorLLM = {
      nombre: "loop",
      modelo: "test",
      enviar: async () => ({ texto: "", llamadas: [{ id: crypto.randomUUID(), nombre: "oc_leer_paquete", args: { caso: "sol-001" } }], uso: { entrada: 1, salida: 1 }, motivoFin: "herramientas" }),
    }
    const almacen = new AlmacenSesiones()
    const r = await turno(dir, infinito, "sesion-tope-1", almacen, "go", false, { maxIteraciones: 3, maxTokensSesion: 1_000_000 })
    expect(r.iteraciones).toBe(3)
    expect(r.reply).toContain("limit of 3 steps")
    expect(r.reply).toContain("Still missing: sol-001: oc_validar")
    expect(almacen.obtener("sesion-tope-1", "propietario-test")?.mensajes.at(-1)?.rol).toBe("assistant")
  })

  test("token budget per session stops the turn", async () => {
    const dir = await espacioTemporal()
    const caro: ProveedorLLM = {
      nombre: "caro",
      modelo: "test",
      enviar: async () => ({ texto: "", llamadas: [{ id: crypto.randomUUID(), nombre: "oc_validar", args: { caso: "sol-001" } }], uso: { entrada: 900, salida: 200 }, motivoFin: "herramientas" }),
    }
    const r = await turno(dir, caro, "sesion-tokens", new AlmacenSesiones(), "go", false, { maxIteraciones: 25, maxTokensSesion: 2_000 })
    expect(r.reply).toContain("token budget")
    expect(r.iteraciones).toBe(2)
  })

  test("a provider timeout shows a clear message and the session stays usable", async () => {
    const dir = await espacioTemporal()
    const almacen = new AlmacenSesiones()
    const caido: ProveedorLLM = {
      nombre: "caido",
      modelo: "test",
      enviar: async () => {
        throw new ErrorLLM("The model did not answer within 45 seconds. Try again.", "timeout")
      },
    }
    const r = await turno(dir, caido, "sesion-error", almacen, "Process sol-001")
    expect(r.reply).toContain("did not answer within 45 seconds")
    const siguiente = await turno(dir, new ProveedorOffline(), "sesion-error", almacen, "Process sol-002")
    expect(siguiente.reply).toContain("blocked")
  })
})

describe("confirmation bound to the exact order", () => {
  test("a source change after the review voids the confirmation, a new review restores it", async () => {
    const dir = await espacioTemporal()
    const almacen = new AlmacenSesiones()
    const llm = new ProveedorOffline()
    await turno(dir, llm, "sesion-huella-1", almacen, "Process sol-004 and do not create it until I confirm.")
    const ruta = resolve(dir, "fixtures/reto-03/solicitudes/sol-004/solicitud.json")
    const solicitud = JSON.parse(await readFile(ruta, "utf8")) as Record<string, unknown>
    await writeFile(ruta, JSON.stringify({ ...solicitud, descripcion: "Bolsa de 100 horas de arquitectura cloud" }))

    const cambio = await turno(dir, llm, "sesion-huella-1", almacen, "confirm")
    const intento = cambio.toolCalls.find((t) => t.nombre === "oc_crear")
    expect(intento?.ok).toBe(false)
    expect(JSON.stringify(intento?.resultado)).toContain("ORDEN_CAMBIADA")
    expect(cambio.needsConfirmation).toBe(true)
    expect(await readFile(resolve(dir, "out/sap/ordenes.jsonl"), "utf8").catch(() => "")).toBe("")

    const ahora = await turno(dir, llm, "sesion-huella-1", almacen, "confirm")
    expect(ahora.toolCalls.find((t) => t.nombre === "oc_crear")?.ok).toBe(true)
  })

  test("the created order records the fingerprint the analyst confirmed", async () => {
    const dir = await espacioTemporal()
    const almacen = new AlmacenSesiones()
    const llm = new ProveedorOffline()
    await turno(dir, llm, "sesion-huella-2", almacen, "Process sol-005")
    const pendiente = almacen.obtener("sesion-huella-2", "propietario-test")?.pendiente?.casos[0]
    await turno(dir, llm, "sesion-huella-2", almacen, "confirm")
    const orden = JSON.parse(await readFile(resolve(dir, "out/sol-005/orden.json"), "utf8")) as {
      huella: string
      consentimiento: { sesion: string; huella: string }
    }
    expect(pendiente?.huella).toMatch(/^[a-f0-9]{64}$/)
    expect(orden.huella).toBe(pendiente?.huella ?? "")
    expect(orden.consentimiento).toMatchObject({ sesion: "sesion-huella-2", huella: pendiente?.huella ?? "" })
  })
})
