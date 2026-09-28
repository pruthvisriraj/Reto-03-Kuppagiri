import { z } from "zod"

const Entero = (defecto: number, min: number, max: number) => z.coerce.number().int().min(min).max(max).default(defecto)

const ConfigSchema = z.object({
  LLM_PROVIDER: z.enum(["anthropic", "offline"]).default("anthropic"),
  ANTHROPIC_API_KEY: z.string().default(""),
  LLM_MODEL: z.string().min(1).default("claude-sonnet-5"),
  LLM_TIMEOUT_MS: Entero(45_000, 1_000, 300_000),
  LLM_MAX_OUTPUT_TOKENS: Entero(2_048, 256, 16_000),
  MAX_ITERATIONS: Entero(25, 1, 100),
  MAX_TOKENS_PER_SESSION: Entero(300_000, 1_000, 5_000_000),
  MAX_TOKENS_PER_DAY: Entero(2_000_000, 1_000, 100_000_000),
  PORT: Entero(3000, 1, 65_535),
  ACCESS_KEY: z.string().default(""),
  RATE_LIMIT_PER_MIN: Entero(20, 1, 1_000),
  TRUST_PROXY: z.enum(["true", "false"]).default("false"),
})

export type Config = z.infer<typeof ConfigSchema>

/** Reads configuration from environment variables. Empty strings count as unset. */
export function leerConfig(env: Record<string, string | undefined> = process.env): Config {
  const limpio = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== ""))
  const parsed = ConfigSchema.safeParse(limpio)
  if (!parsed.success) {
    const campos = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")
    throw new Error(`Invalid configuration: ${campos}`)
  }
  return parsed.data
}
