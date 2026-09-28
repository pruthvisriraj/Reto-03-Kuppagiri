import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { ejecutarRegistrada, registroPorDefecto } from "../src/agent/herramientas.ts"
import { huellaDeCaso } from "../src/domain/caso.ts"
import { celdaCsv } from "../src/domain/control.ts"
import { leerAprobacion } from "../src/domain/lectura.ts"
import * as oc from "../src/tools/oc.ts"
import { contexto, escribirCaso, espacioTemporal, leer } from "./helpers.ts"

describe("tool contract", () => {
  test("tools are registered as oc_<export> with a JSON schema", () => {
    const registro = registroPorDefecto()
    expect([...registro.keys()].sort()).toEqual(["oc_construir_payload", "oc_crear", "oc_generar_evidencia", "oc_leer_paquete", "oc_validar"])
    const spec = registro.get("oc_crear")?.spec
    expect(spec?.parametros["type"]).toBe("object")
    expect(spec?.descripcion.length).toBeGreaterThan(20)
  })

  test("execute never throws: a missing directory returns ok false", async () => {
    const salida = await oc.leer_paquete.execute({ caso: "sol-001" }, contexto("/no/such/dir"))
    expect(leer(salida).ok).toBe(false)
  })
})

describe("input safety", () => {
  test("path traversal in caso is rejected by the registry and by the tool itself", async () => {
    const dir = await espacioTemporal()
    const h = registroPorDefecto().get("oc_leer_paquete")
    if (!h) throw new Error("tool missing")
    const viaRegistro = leer(await ejecutarRegistrada(h, { caso: "../maestros" }, contexto(dir)))
    expect(viaRegistro.codigo).toBe("ARGS_INVALIDOS")
    const directo = leer(await oc.leer_paquete.execute({ caso: "../../etc" }, contexto(dir)))
    expect(directo.codigo).toBe("CASO_INVALIDO")
  })

  test("unknown arguments are rejected (strict schema)", async () => {
    const dir = await espacioTemporal()
    const h = registroPorDefecto().get("oc_crear")
    if (!h) throw new Error("tool missing")
    const r = leer(await ejecutarRegistrada(h, { caso: "sol-001", numero_oc: "4500009999" }, contexto(dir)))
    expect(r.codigo).toBe("ARGS_INVALIDOS")
  })

  test("a package edited by the model is ignored and flagged", async () => {
    const dir = await espacioTemporal()
    const original = leer(await oc.leer_paquete.execute({ caso: "sol-003" }, contexto(dir)))
    const alterado = structuredClone(original.data ?? {}) as Record<string, Record<string, unknown>>
    if (alterado["aprobacion"]) alterado["aprobacion"]["de"] = "rtorres@periferia-ficticia.com"
    const r = leer(await oc.validar.execute({ caso: "sol-003", paquete: alterado }, contexto(dir)))
    expect(r.data?.["paquete_del_modelo"]).toBe("difiere")
    expect(r.data?.["apta"]).toBe(false)
  })

  test("control log cells cannot carry spreadsheet formulas", () => {
    expect(celdaCsv("=HYPERLINK(\"http://x\")")).toBe('"\'=HYPERLINK(""http://x"")"')
    expect(celdaCsv("+1")).toBe("'+1")
    expect(celdaCsv("SOL-2026-001")).toBe("SOL-2026-001")
  })

  test("a negated approval does not count as approval", () => {
    const a = leerAprobacion({ de: "x@y.com", fecha: "2026-08-21", asunto: "RE", cuerpo: "No aprobado, falta presupuesto." })
    expect(a.aprobado).toBe(false)
  })
})

describe("readable errors for incomplete packages (HU-6)", () => {
  test("unknown case", async () => {
    const dir = await espacioTemporal()
    const r = leer(await oc.leer_paquete.execute({ caso: "sol-999" }, contexto(dir)))
    expect(r.codigo).toBe("CASO_INEXISTENTE")
  })

  test("non-numeric amount names the field and tells what to ask", async () => {
    const dir = await espacioTemporal()
    const base = JSON.parse(await readFile(resolve(dir, "fixtures/reto-03/solicitudes/sol-001/solicitud.json"), "utf8")) as Record<string, unknown>
    const correo = await readFile(resolve(dir, "fixtures/reto-03/solicitudes/sol-001/correo.json"), "utf8")
    await escribirCaso(dir, "sol-901", { "solicitud.json": JSON.stringify({ ...base, valor_total: "once millones" }), "correo.json": correo })
    const r = leer(await oc.leer_paquete.execute({ caso: "sol-901" }, contexto(dir)))
    expect(r.codigo).toBe("DATOS_INVALIDOS")
    expect(r.error).toContain("valor_total")
    expect(r.error).toContain("Ask the requester")
  })

  test("missing approval is listed and blocks through RC2", async () => {
    const dir = await espacioTemporal()
    const origen = resolve(dir, "fixtures/reto-03/solicitudes/sol-001")
    await escribirCaso(dir, "sol-902", {
      "solicitud.json": await readFile(resolve(origen, "solicitud.json"), "utf8"),
      "correo.json": await readFile(resolve(origen, "correo.json"), "utf8"),
      "cotizacion.txt": await readFile(resolve(origen, "cotizacion.txt"), "utf8"),
    })
    const paquete = leer(await oc.leer_paquete.execute({ caso: "sol-902" }, contexto(dir)))
    expect(String(paquete.data?.["faltantes"])).toContain("aprobacion")
    const v = leer(await oc.validar.execute({ caso: "sol-902" }, contexto(dir)))
    expect(v.data?.["apta"]).toBe(false)
  })

  test("malformed JSON is reported, not thrown", async () => {
    const dir = await espacioTemporal()
    await escribirCaso(dir, "sol-903", { "solicitud.json": "{ not json", "correo.json": "{}" })
    const r = leer(await oc.leer_paquete.execute({ caso: "sol-903" }, contexto(dir)))
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/not valid JSON|invalid fields/)
  })
})

describe("PO creation", () => {
  test("idempotent: the same case twice returns the same PO number", async () => {
    const dir = await espacioTemporal()
    const ctx = contexto(dir)
    const primera = leer(await oc.crear.execute({ caso: "sol-001" }, ctx))
    const segunda = leer(await oc.crear.execute({ caso: "sol-001" }, ctx))
    expect(primera.data?.["numero_oc"]).toBe("4500000001")
    expect(segunda.data?.["numero_oc"]).toBe("4500000001")
    expect(segunda.data?.["idempotente"]).toBe(true)
    const lineas = (await readFile(resolve(dir, "out/sap/ordenes.jsonl"), "utf8")).trim().split("\n")
    expect(lineas).toHaveLength(1)
  })

  test("concurrent creation of the same case produces one order", async () => {
    const dir = await espacioTemporal()
    const ctx = contexto(dir)
    const [a, b] = await Promise.all([oc.crear.execute({ caso: "sol-001" }, ctx), oc.crear.execute({ caso: "sol-001" }, ctx)])
    expect(leer(a).data?.["numero_oc"]).toBe(leer(b).data?.["numero_oc"])
    const lineas = (await readFile(resolve(dir, "out/sap/ordenes.jsonl"), "utf8")).trim().split("\n")
    expect(lineas).toHaveLength(1)
  })

  test("exceptions need confirmado=true; blocked cases never reach SAP", async () => {
    const dir = await espacioTemporal()
    const ctx = contexto(dir)
    expect(leer(await oc.crear.execute({ caso: "sol-004" }, ctx)).codigo).toBe("REQUIERE_CONFIRMACION")
    expect(leer(await oc.crear.execute({ caso: "sol-002", confirmado: true }, ctx)).codigo).toBe("BLOQUEADA")
    const creada = leer(await oc.crear.execute({ caso: "sol-004", confirmado: true }, contexto(dir, "s-123")))
    expect(creada.data?.["numero_oc"]).toBe("4500000001")
    const orden = JSON.parse(await readFile(resolve(dir, "out/sol-004/orden.json"), "utf8")) as { orden: { excepciones: { confirmado_por: string }[] } }
    expect(orden.orden.excepciones[0]?.confirmado_por).toContain("s-123")
  })

  test("on the server path, confirmado=true needs the fingerprint of the exact order", async () => {
    const dir = await espacioTemporal()
    const sinConsentimiento = { ...contexto(dir), consentimientos: new Map<string, string>() }
    expect(leer(await oc.crear.execute({ caso: "sol-004", confirmado: true }, sinConsentimiento)).codigo).toBe("CONFIRMACION_NO_OTORGADA")
    const otraHuella = { ...contexto(dir), consentimientos: new Map([["sol-004", "0".repeat(64)]]) }
    expect(leer(await oc.crear.execute({ caso: "sol-004", confirmado: true }, otraHuella)).codigo).toBe("ORDEN_CAMBIADA")
    const huella = await huellaDeCaso(dir, "sol-004")
    const correcta = { ...contexto(dir), consentimientos: new Map([["sol-004", huella ?? ""]]) }
    const creada = leer(await oc.crear.execute({ caso: "sol-004", confirmado: true }, correcta))
    expect(creada.data?.["numero_oc"]).toBe("4500000001")
    expect(creada.data?.["huella"]).toBe(huella)
  })

  test("control log gets one row per attempt and flags retroactive POs", async () => {
    const dir = await espacioTemporal()
    const ctx = contexto(dir)
    await oc.crear.execute({ caso: "sol-005" }, ctx)
    await oc.crear.execute({ caso: "sol-005", confirmado: true }, ctx)
    await oc.crear.execute({ caso: "sol-002" }, ctx)
    const filas = (await readFile(resolve(dir, "out/control.csv"), "utf8")).trim().split("\n")
    expect(filas[0]).toBe("solicitud_id,resultado,numero_oc,retroactiva,bloqueos,confirmaciones,ts")
    expect(filas[1]).toStartWith("SOL-2026-005,pendiente_confirmacion,,true")
    expect(filas[2]).toStartWith("SOL-2026-005,creada,4500000001,true")
    expect(filas[3]).toStartWith("SOL-2026-002,bloqueada,,false,RC1")
  })

  test("validation records blocked and pending cases in control.csv, clean cases wait for creation", async () => {
    const dir = await espacioTemporal()
    const ctx = contexto(dir)
    for (const caso of ["sol-001", "sol-002", "sol-004"]) await oc.validar.execute({ caso }, ctx)
    const filas = (await readFile(resolve(dir, "out/control.csv"), "utf8")).trim().split("\n").slice(1)
    expect(filas).toHaveLength(2)
    expect(filas[0]).toStartWith("SOL-2026-002,bloqueada,,false,RC1")
    expect(filas[1]).toStartWith("SOL-2026-004,pendiente_confirmacion,,false,,RC5")
  })

  test("invalid arguments are logged too (CA4)", async () => {
    const dir = await espacioTemporal()
    const h = registroPorDefecto().get("oc_validar")
    if (!h) throw new Error("tool missing")
    await ejecutarRegistrada(h, { caso: "../x" }, contexto(dir))
    const log = await readFile(resolve(dir, "out/log.jsonl"), "utf8")
    expect(log).toContain("invalid arguments")
  })

  test("evidence hash matches the payload and the PDF is a real PDF", async () => {
    const dir = await espacioTemporal()
    const ctx = contexto(dir)
    const evidencia = leer(await oc.generar_evidencia.execute({ caso: "sol-001" }, ctx))
    const payload = leer(await oc.construir_payload.execute({ caso: "sol-001" }, ctx))
    const orden = payload.data?.["orden"] as { aprobador: { evidencia_sha256: string }; posiciones: { descripcion: string }[] }
    expect(orden.aprobador.evidencia_sha256).toBe(String(evidencia.data?.["sha256"]))
    expect(orden.posiciones[0]?.descripcion.length).toBeLessThanOrEqual(40)
    const pdf = await readFile(resolve(dir, "out/sol-001/aprobacion.pdf"))
    expect(pdf.subarray(0, 4).toString()).toBe("%PDF")
    const traza = JSON.parse(await readFile(resolve(dir, "out/sol-001/trazabilidad.json"), "utf8")) as Record<string, { fuente: string }>
    expect(traza["proveedor.codigo_sap"]?.fuente).toBe("maestro.proveedores")
  })

  test("every tool call is logged to out/log.jsonl", async () => {
    const dir = await espacioTemporal()
    await oc.validar.execute({ caso: "sol-002" }, contexto(dir, "sess-log"))
    const linea = JSON.parse((await readFile(resolve(dir, "out/log.jsonl"), "utf8")).trim()) as Record<string, unknown>
    expect(linea["herramienta"]).toBe("oc_validar")
    expect(linea["sesion"]).toBe("sess-log")
    expect(linea["ok"]).toBe(true)
  })
})
