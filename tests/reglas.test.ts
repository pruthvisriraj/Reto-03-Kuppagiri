import { describe, expect, test } from "bun:test"
import { resolve } from "node:path"
import { leerMaestros, leerPaquete } from "../src/domain/paquete.ts"
import { normalizarNit, normalizarNombre, parsearMonto } from "../src/domain/lectura.ts"
import { validarPaquete, type Validacion } from "../src/domain/reglas.ts"
import { textoBreve } from "../src/domain/texto.ts"
import type { Paquete } from "../src/domain/esquemas.ts"
import { RAIZ } from "./helpers.ts"

async function validar(caso: string, cambio?: (p: Paquete) => void): Promise<Validacion> {
  const leido = await leerPaquete(RAIZ, caso)
  const maestros = await leerMaestros(RAIZ)
  if (!leido.ok || !maestros.ok) throw new Error("fixtures unreadable")
  const paquete = structuredClone(leido.data.paquete)
  cambio?.(paquete)
  return validarPaquete(paquete, maestros.data)
}

const codigos = (l: { codigo: string }[]) => l.map((x) => x.codigo)

describe("expected outcome per fixture case (PRD 7.5)", () => {
  test("sol-001 is clean: no blocks, no confirmations, IVA and terms not reported as derived", async () => {
    const v = await validar("sol-001")
    expect(v.apta).toBe(true)
    expect(v.bloqueos).toEqual([])
    expect(v.confirmaciones).toEqual([])
    expect(v.derivados.indicador_iva).toBeUndefined()
    expect(v.derivados.condiciones_pago).toBeUndefined()
  })

  test("sol-002 blocks on RC1: supplier not in master", async () => {
    const v = await validar("sol-002")
    expect(v.apta).toBe(false)
    expect(codigos(v.bloqueos)).toEqual(["RC1"])
  })

  test("sol-003 blocks on RC2 and never suggests splitting the purchase", async () => {
    const v = await validar("sol-003")
    expect(codigos(v.bloqueos)).toEqual(["RC2"])
    const accion = v.bloqueos[0]?.accion_sugerida ?? ""
    expect(accion).toContain("Do not split")
    expect(accion).toContain("CC-3030")
    expect(accion).toContain("Confirm with the requester which cost center")
  })

  test("sol-004 asks confirmation on RC5 with both values and flags the approved amount", async () => {
    const v = await validar("sol-004")
    expect(v.apta).toBe(true)
    expect(codigos(v.confirmaciones)).toEqual(["RC5"])
    expect(v.confirmaciones[0]?.valores).toEqual({ solicitud: 25_000_000, cotizacion: 26_500_000, diferencia_pct: 6 })
    expect(v.advertencias.join(" ")).toContain("COP 25,000,000")
    expect(v.derivados.unidad?.valor).toBe("H")
  })

  test("sol-005 is a retroactive PO confirmed through RC8", async () => {
    const v = await validar("sol-005")
    expect(v.retroactiva).toBe(true)
    expect(codigos(v.confirmaciones)).toEqual(["RC8"])
    expect(v.confirmaciones[0]?.detalle).toContain("approval (2026-08-28) also came after the invoice")
  })

  test("sol-006 matches the supplier by name, derives C1 (confirm) and Z030 (information)", async () => {
    const v = await validar("sol-006")
    expect(v.apta).toBe(true)
    expect(v.derivados.proveedor?.codigo_sap).toBe("100234")
    expect(v.derivados.indicador_iva).toEqual({ valor: "C1", fuente: "maestro.proveedores.indicador_iva_default" })
    expect(v.derivados.condiciones_pago?.valor).toBe("Z030")
    expect(codigos(v.confirmaciones)).toEqual(["RC6"])
    expect(v.controles.find((c) => c.codigo === "RC7")?.resultado).toBe("derivado")
  })
})

describe("rules on modified packages", () => {
  test("RC10 blocks when quantity x unit price does not match the total", async () => {
    const v = await validar("sol-001", (p) => (p.solicitud.valor_total = 11_400_002))
    expect(codigos(v.bloqueos)).toContain("RC10")
  })

  test("RC3 blocks over the approver limit and points to a higher approver", async () => {
    const v = await validar("sol-001", (p) => {
      p.solicitud.cantidad = 600
      p.solicitud.valor_total = 57_000_000
    })
    expect(codigos(v.bloqueos)).toContain("RC3")
    expect(v.bloqueos.find((b) => b.codigo === "RC3")?.accion_sugerida).toContain("dgarcia")
  })

  test("RC4 blocks a sub-area from another cost center", async () => {
    const v = await validar("sol-001", (p) => (p.solicitud.subarea = "Compras"))
    expect(codigos(v.bloqueos)).toContain("RC4")
  })

  test("RC2 blocks an email without an approval, including a negated one", async () => {
    const v = await validar("sol-001", (p) => {
      if (p.aprobacion) p.aprobacion.aprobado = false
    })
    expect(codigos(v.bloqueos)).toContain("RC2")
  })

  test("RC9 asks confirmation when approval predates the request", async () => {
    const v = await validar("sol-001", (p) => {
      if (p.aprobacion) p.aprobacion.fecha = "2026-08-01T09:00:00-05:00"
    })
    expect(codigos(v.confirmaciones)).toContain("RC9")
  })

  test("RC5 uses the exact ratio: 2.004% asks confirmation, 2% does not", async () => {
    const encima = await validar("sol-004", (p) => {
      if (p.cotizacion) p.cotizacion.total = 25_501_000
    })
    expect(codigos(encima.confirmaciones)).toContain("RC5")
    const limite = await validar("sol-004", (p) => {
      if (p.cotizacion) p.cotizacion.total = 25_500_000
    })
    expect(codigos(limite.confirmaciones)).not.toContain("RC5")
  })

  test("RC5 asks confirmation when there is no quote", async () => {
    const v = await validar("sol-001", (p) => (p.cotizacion = null))
    expect(codigos(v.confirmaciones)).toContain("RC5")
  })

  test("a quote with a different NIT needs confirmation", async () => {
    const v = await validar("sol-001", (p) => {
      if (p.cotizacion) p.cotizacion.nit = "901.000.000-1"
    })
    expect(codigos(v.confirmaciones)).toContain("RC1-NIT")
  })

  test("segregation of duties: requester cannot approve", async () => {
    const v = await validar("sol-001", (p) => {
      if (p.aprobacion) p.aprobacion.de = p.correo.de
    })
    expect(codigos(v.bloqueos)).toContain("SOD")
  })

  test("USD requests ask confirmation against COP limits", async () => {
    const v = await validar("sol-001", (p) => (p.solicitud.moneda = "USD"))
    expect(codigos(v.confirmaciones)).toContain("RC3")
  })
})

describe("parsing helpers", () => {
  test("amounts in Colombian and US formats", () => {
    expect(parsearMonto("COP 11.400.000")).toBe(11_400_000)
    expect(parsearMonto("USD 120,000.00")).toBe(120_000)
    expect(parsearMonto("1.850.000,50")).toBe(1_850_000.5)
    expect(parsearMonto("95000")).toBe(95_000)
    expect(parsearMonto("n/a")).toBeNull()
  })

  test("NIT and names normalize", () => {
    expect(normalizarNit("900.555.111-2")).toBe("900555111")
    expect(normalizarNombre("TecnoSuministros S.A.S.")).toBe("tecnosuministros sas")
    expect(normalizarNombre("Papelería Central Ltda.")).toBe("papeleria central ltda")
  })

  test("SAP short text never exceeds 40 characters", () => {
    for (const t of ["Bolsa de 100 horas de arquitectura de nube para migración", "x".repeat(90), "corto"]) {
      expect(textoBreve(t).length).toBeLessThanOrEqual(40)
    }
    expect(textoBreve("Bolsa de 100 horas de arquitectura de nube para migración")).toBe("Bolsa de 100 horas de arquitectura")
  })

  test("fixture files resolve from the repo root", () => {
    expect(resolve(RAIZ, "fixtures/reto-03/maestros/proveedores.json")).toContain("maestros")
  })
})
