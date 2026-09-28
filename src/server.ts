import { createServer } from "node:http"
import { fileURLToPath } from "node:url"
import { crearApp } from "./app.ts"
import { leerConfig } from "./config.ts"
import { ErrorLLM } from "./llm/adapter.ts"
import { crearProveedor } from "./llm/fabrica.ts"

const directory = fileURLToPath(new URL("..", import.meta.url))
const config = leerConfig()
const llm = crearProveedor(config)
const manejar = await crearApp({ config, directory, llm })

createServer((req, res) => void manejar(req, res)).listen(config.PORT, () => {
  const proveedor = llm instanceof ErrorLLM ? `not configured (${llm.message})` : `${llm.nombre} / ${llm.modelo}`
  console.log(`Purchase order agent on http://localhost:${config.PORT}`)
  console.log(`LLM provider: ${proveedor}`)
  console.log(`Access key: ${config.ACCESS_KEY ? "required" : "not required"}`)
})
