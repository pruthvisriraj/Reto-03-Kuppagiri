import { expect, test } from "bun:test"
import * as desdeModulo from "../modulo/tools/oc.ts"
import { archivosDesactualizados } from "../scripts/build-modulo.ts"
import * as desdeApp from "../src/tools/oc.ts"

test("modulo/ matches agent/prompt.md and src/knowledge (run bun run build:modulo if this fails)", async () => {
  expect(await archivosDesactualizados()).toEqual([])
})

test("modulo/tools/oc.ts exposes the same tool objects the app uses", () => {
  expect(desdeModulo.crear).toBe(desdeApp.crear)
  expect(Object.keys(desdeModulo).sort()).toEqual(Object.keys(desdeApp).sort())
})
