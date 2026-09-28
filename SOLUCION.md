# SOLUCION: Reto 03, purchase order agent

## 1. Problem in one sentence

The administrative analyst retypes every purchase request into SAP by hand and checks approver authority from memory, so errors surface at month-end close and nobody knows how many purchase orders get created after the invoice arrives.

Who feels it: the analyst (time and rework), accounting (corrections at close), audit and management (no control evidence, no measure of retroactive POs).

## 2. Architecture

```
 Browser (web/)                       Backend (Bun, node:http)                     Files
 ┌───────────────────┐  POST /api/chat ┌──────────────────────────────┐
 │ chat              │ ──────────────> │ app.ts   key, rate limit,    │
 │ tool call list    │ <────────────── │          body and size caps  │
 │ confirmation slip │  reply,         │ agent/ciclo.ts  agent loop   │
 └───────────────────┘  toolCalls,     │   iteration cap, token cap,  │
                        needsConfirm.  │   confirmation guard         │
                                       │ llm/  ProveedorLLM adapter   │──> Anthropic API
                                       │   anthropic.ts | offline.ts  │
                                       │ agent/herramientas.ts        │
                                       │   zod args, oc_<export>      │
                                       └──────────────┬───────────────┘
                                                      │ execute(args, ctx)
                                       ┌──────────────▼───────────────┐
                                       │ tools/oc.ts  five oc_* tools │ ──> fixtures/reto-03/ (read)
                                       │ domain/  parse, RC1-RC10,    │ ──> out/<caso>/ payload,
                                       │   payload, evidence, control │     trazabilidad, evidence
                                       │ sap/mock.ts  SapAdapter      │ ──> out/sap/ordenes.jsonl
                                       └──────────────────────────────┘ ──> out/control.csv, log.jsonl
```

Where each concern lives:

| Concern | Location | Changes when |
|---|---|---|
| Behavior | `agent/prompt.md` | The conversation style or flow changes. |
| Knowledge | `src/knowledge/ordenes-compra.md` | The process or the rules explanation changes. |
| Execution | `src/tools/oc.ts`, `src/domain/` | A rule or a data format changes. |
| Model provider | `src/llm/` | The provider changes. The loop never imports a provider. |

The server never contains business rules. A rule change touches `src/domain/reglas.ts` and its test only.

## 3. Agent loop

`src/agent/ciclo.ts`, function `ejecutarTurno`:

1. The user message joins the session history.
2. Loop while iterations are below `MAX_ITERATIONS` (default 25): send system prompt, history and tool specs to the provider through `enviar(mensajes, herramientas)`. Add token usage to the session. Stop when the session exceeds `MAX_TOKENS_PER_SESSION`.
3. No tool calls in the answer: the text is the reply. Turn ends.
4. Tool calls: validate arguments with zod (`.strict()`, unknown fields rejected), run the tool, record a trace (name, arguments, summary, full result, duration), append the result to the history, loop.
5. At the cap, the reply lists the steps done in the turn and asks the user to continue. The history stays well formed for the next turn.
6. Provider errors (timeout, auth, rate limit, bad response) become one plain sentence in the chat. The session survives.

Human confirmation is enforced by the server, not only by the prompt:

- At the end of each turn the server reads the tool results. A case with `apta: true` and pending `confirmaciones`, or an `oc_crear` answered with `REQUIERE_CONFIRMACION`, is marked pending in the session. The front shows the confirmation slip from this flag, not from the model's wording.
- On the next message the server checks for an explicit confirmation: the Confirm button (`confirm: true`), or a message that opens with an affirmative ("confirm", "confirmo", "sí", "yes", "ok") and contains no negation ("no", "not yet", "después"). Naming cases narrows the confirmation to those cases, and naming only other cases confirms nothing: "ok, now process sol-003" never confirms a pending sol-004. Any other message clears the pending state.
- The confirmation covers one exact order. When a case turns pending, the server stores the SHA-256 fingerprint of the order the tools built from the source files. On confirmation, `oc_crear` rebuilds the order and refuses with `ORDEN_CAMBIADA` if the fingerprint differs, for example after someone edits the quote or the request between review and confirmation. The analyst reviews again. The created order records the fingerprint and the session in `out/<caso>/orden.json`.
- A tool call with `confirmado: true` for a case the user did not confirm in this turn never reaches the tool. The model gets `CONFIRMACION_NO_OTORGADA` and the attempt goes to `out/log.jsonl`. A prompt injection inside a quote or an email cannot skip the human. `tests/ciclo.test.ts` covers this with a provider scripted to try.

## 4. Model choice and cost

Provider: Anthropic, called with `fetch` (no SDK). Default model: `claude-sonnet-5`. Low-cost option: `claude-haiku-4-5-20251001`. Switching is one environment variable.

Why Sonnet 5 as default: the model here orchestrates tools and explains results. It never computes a control. The risk sits in tool-calling discipline over several steps and in obeying rules such as "never adjust an amount". Sonnet is the safer choice for the defense. Haiku 4.5 handles this flow at about a third of the price, and I would switch after running an evaluation set (the six fixtures plus injected variants) against both.

Estimate per case, from measured sizes: system prompt 8,029 characters, tool schemas 3,281 characters, tool results for sol-004 about 5,200 characters. At about 4 characters per token, the fixed prefix is about 3,300 tokens. A case takes 5 to 6 model calls and each call resends the growing history.

| Model | Input tokens | Output tokens | Cost per case | With prompt caching |
|---|---|---|---|---|
| Claude Sonnet 5 ($3 / $15 per MTok) | ~30,000 | ~1,500 | ~$0.11 | ~$0.07 |
| Claude Haiku 4.5 ($1 / $5 per MTok) | ~30,000 | ~1,500 | ~$0.04 | ~$0.025 |

The adapter marks the system prompt and the tool list with `cache_control`, so calls 2 to 6 read the prefix from cache. These figures are estimates, not measured against the live API. The UI shows real token use per session, and the first week in production should replace this table with measured numbers. At 300 POs a month, Sonnet costs about $20 to $35.

## 5. Control matrix

All controls are deterministic TypeScript in `src/domain/reglas.ts`, one short function per rule, covered by `tests/reglas.test.ts`. The model never decides a control.

`derivados` holds only the values the agent completed: the SAP supplier code, the unit, and IVA code or payment terms when the request left them out (sol-006). Values the request already carried (sol-001's C1 and Z030) do not appear there, so the agent never reports them as derived.

Every case that stops at validation still reaches the control log: `oc_validar` writes a `bloqueada` or `pendiente_confirmacion` row, and `oc_crear` writes `creada`, `existente` or a refused attempt. Audit sees every processed case, including the ones the agent never tried to create.

| Rule | Implementation | Fixture that triggers it |
|---|---|---|
| RC1 | Match by NIT without check digit or dots. Without NIT, exact match on the normalized name (no accents, no punctuation). Inactive supplier blocks. Extra: quote NIT different from the master NIT asks confirmation (fraud signal). | sol-002 blocks. sol-006 matches by name. |
| RC2 | Approval present, contains "Aprobado" and no negation ("no aprobado", "rechazado"). Sender compared in NFC lowercase against the approvers of the cost center. When the sender approves another cost center, the suggested action says so and asks the requester to confirm which cost center bears the cost. | sol-003 blocks. |
| RC3 | Total against the limit of that approver in that cost center. The suggested action names approvers with enough limit. When none exists: escalate, never split the purchase. USD requests ask confirmation, since limits are in COP. | sol-003 action: escalate. |
| RC4 | Cost center exists and the sub-area belongs to it. | Tests only. |
| RC5 | The exact ratio `abs(quote - request) / request` above 0.02, or no quote, asks confirmation with both values and the percentage. The percentage is rounded only for display. | sol-004, 6%. |
| RC6 | Missing IVA code: derived from the supplier and confirmed. The detail says whether the quote's IVA rate matches. | sol-006, C1. |
| RC7 | Missing payment terms: derived from the supplier, shown as information. | sol-006, Z030. |
| RC8 | Invoice date before request date: retroactive, confirmation, `retroactiva=true` in the control log. The detail also says when the approval came after the invoice. | sol-005. |
| RC9 | Approval date (calendar date in its own offset) before request date asks confirmation. | Tests only. |
| RC10 | Quantity times unit price against total, tolerance 1. | Tests only. |
| SOD (extra) | Requester and approver are the same person: block. | Tests only. |

The hardest one was RC5, because of what it hides. sol-004's quote is 6% above the request, and the approval email says "Aprobado por 25 millones". A literal RC5 asks "confirm the difference?" and a helpful model then creates the PO at the quote amount, above what the leader approved. My implementation keeps the request amount in the payload, asks confirmation for the difference, and raises a warning that the approval text names 25,000,000. If the analyst wants the quote amount, the request needs correction and a new approval. RC2 with RC3 came second, and sol-003 hides a second trap. The sender, Felipe Vargas, is not an approver of CC-2020, and the one CC-2020 approver's limit (30M) is below the 74M total, so "ask Rocío" is the wrong answer. His email says the furniture is for the preventa team, and he approves CC-3030 Comercial (sub-areas Preventa and Marketing) up to 80M. The request may carry the wrong cost center. The suggested action lays out both paths: if the cost belongs to CC-3030, the requester corrects and resubmits, and if it stays in CC-2020, escalate to finance. The agent never moves the cost itself, because moving a cost to a center where someone can sign is also a way around the control.

## 6. Real SAP adapter design

The mock implements the PRD interface `SapAdapter` (`consultarProveedor`, `crearOrden`, `buscarOrdenPorReferencia`). A real adapter is one new class behind the same interface.

**Integration choice.** Connectivity is unconfirmed, so the decision depends on one question to Periferia's SAP team: S/4HANA or ECC?

- S/4HANA: OData V2 `API_PURCHASEORDER_PROCESS_SRV`, a released API. Standard REST over HTTPS, a deep insert creates header, items and account assignment in one atomic call, and SAP Cloud Connector publishes it without opening the ERP to the internet. First choice.
- ECC: `BAPI_PO_CREATE1` over RFC, wrapped by a small service (SAP JCo or NCo) or an Integration Suite iFlow, followed by `BAPI_TRANSACTION_COMMIT`.
- SAP Integration Suite only if Periferia already licenses BTP. It adds monitoring and retries but also cost and a second team to coordinate.
- File upload (mass load) is the Plan B below.

**Mapping of the 7.4 payload to `A_PurchaseOrder` (deep insert).**

| Payload | SAP field | Note |
|---|---|---|
| `sociedad` | `CompanyCode` | |
| `organizacion_compras` | `PurchasingOrganization` | Also `PurchasingGroup` from configuration. |
| (fixed) | `PurchaseOrderType` = `NB` | Standard PO. |
| `proveedor.codigo_sap` | `Supplier` | |
| `moneda` | `DocumentCurrency` | |
| `condiciones_pago` | `PaymentTerms` | |
| `referencia.solicitud_id` | `CorrespncInternalReference` | Idempotency key, see below. |
| `referencia.cotizacion_ref` | `CorrespncExternalReference` | Supplier quote number. |
| `posiciones[].numero` | `PurchaseOrderItem` | 10, 20, ... |
| `posiciones[].descripcion` | `PurchaseOrderItemText` | 40 characters. Full text as item long text. |
| `posiciones[].cantidad`, `unidad` | `OrderQuantity`, `PurchaseOrderQuantityUnit` | Map UN, H, MES to the internal SAP units through a table. |
| `posiciones[].precio_unitario` | `NetPriceAmount` | Send the net price: quote prices include IVA, and the tax code adds IVA again. `precio / (1 + tasa)`, or gross pricing if Periferia configures it. |
| `posiciones[].indicador_iva` | `TaxCode` | Assumes C0, C1, C2 are the SAP tax codes. |
| `posiciones[].centro_costo` | `_PurOrdAccountAssignment.CostCenter` with `AccountAssignmentCategory` = `K` | SAP cost centers are 10-character keys. Map "CC-1010" through configuration. `GLAccount` and `MaterialGroup` from configuration by category. |
| `posiciones[].subarea` | No standard field | Profit center or a custom field through key-user extensibility. Controlling decides. |
| `aprobador` and `excepciones` | Header note, and `aprobacion.pdf` attached through the attachment service (`API_CV_ATTACHMENT_SRV`, object `BUS2012`) | |

**Authentication and credentials.** A technical user with least privilege: create POs of type NB in company 1000, no change, no delete. OAuth 2.0 client credentials through BTP, or an X.509 client certificate through Cloud Connector. Secrets live in a vault (Azure Key Vault or AWS Secrets Manager) and reach the adapter process as environment variables at runtime. The model, the prompt, the tools' results and the logs never see them. SAP change documents record the technical user plus the analyst id sent in the header note.

**Idempotency and partial errors.**

1. Before creating: `GET A_PurchaseOrder?$filter=CorrespncInternalReference eq '<solicitud_id>'`. Found: return that number.
2. A local record with a unique key on `solicitud_id` and state `en_proceso` stops two workers from racing.
3. Timeout after the POST: the outcome is unknown. Never retry blind. Query by reference first, retry only if nothing exists.
4. The deep insert is atomic: SAP creates the whole PO or returns an error. SAP messages (class and number) become a readable sentence for the analyst, and the case stays pending.
5. PO created but attachment upload failed: this is the real partial error. The control log records `creada_sin_evidencia`, a retry job uploads the PDF, and the agent never creates a second PO to "fix" it.

**Plan B without a connection.** The agent still removes most of the work: reading, validation, approver authority, evidence PDF and the control log run the same. Two outputs replace `crearOrden`: a paste-ready view in ME21N field order, and a mass-upload file (CSV in the layout of the SAP migration template or a small Z program) that the analyst loads once a day. `SapAdapter.crearOrden` writes the file row and returns a provisional number. The analyst records the real PO number afterwards. Same interface, no change in the agent.

## 7. Process reading: retroactive POs

What I would tell management, in half a page:

A retroactive PO means the company committed the spend before anyone checked budget, approver authority or quotes. The PO then documents a decision already taken. In the fixtures, 1 of 6 requests (sol-005) is retroactive. Six cases prove nothing statistically, and the point is different: until now nobody measured this. The agent now writes every attempt to `out/control.csv` with `retroactiva=true|false`, so the first month gives a real rate by cost center, requester and supplier.

sol-005 shows two more signals. First, the timeline: invoice on 2026-08-10, request on 2026-08-27, approval on 2026-08-28. The approval came 18 days after the supplier billed, and the approver writes that the invoice already arrived and asks for the PO so the invoice can be filed. The approval ratified a done deal. Second, every request email in the fixtures opens with "Hola Camila", so Camila is the purchasing analyst. In sol-005 the requester is Camila Ortiz, cost sub-area Compras. The analyst requested the purchase and would also create its PO. That is a segregation-of-duties gap, independent of the retroactive date.

Proposed process change, in order:

1. Measure for one month with the control log. No new rules yet.
2. "No PO, no pay": accounts payable returns invoices without a PO number, with published exceptions (utilities, emergencies).
3. Framework agreements or blanket POs for recurring low-value suppliers such as stationery. This removes the main reason people buy first and ask later.
4. A retroactive PO needs a written justification and a second approval from finance. The agent already asks confirmation, and finance approval would come on top.
5. Compras staff cannot be requester and PO creator for the same purchase. The agent blocks self-approval today, and with SSO it can block this case too.

## 8. Decisions and trade-offs

1. **Controls in code, not in the prompt.** Every rule is a TypeScript function with tests. Discarded: letting the model validate from the knowledge file. That fails the determinism requirement, cannot be tested, and puts amounts in the hands of a text generator.
2. **Tools re-read the source files.** `oc_validar`, `oc_construir_payload` and `oc_crear` accept `paquete`, `derivados` and `payload` as in the PRD contract, but as optional arguments. The tools rebuild everything from the case files and only report whether the model's copy differed (`paquete_del_modelo: "difiere"`). Discarded: trusting the objects the model passes along. A model or an injected document could change an amount between validation and creation, and echoing large objects costs tokens. This is a deliberate deviation from the contract table.
3. **Confirmation enforced by the server.** Discarded: a prompt rule alone. Prompt rules fail under prompt injection. The server guard costs a little flexibility: a user cannot confirm an exception in the same message that starts the case, even if they know it in advance.
4. **Regex parsers for the quote, approval and invoice.** Deterministic and tested. Discarded: model extraction, which is flexible but not reproducible. The cost: a new quote layout breaks parsing, and the tool then reports the quote as unreadable (RC5 asks confirmation) instead of guessing. Production needs an extraction step with validation for real PDFs.
5. **No `oc_leer_excel` (P1 optional).** The npm `xlsx` package (SheetJS 0.18.5) has known vulnerabilities, CVE-2023-30533 (prototype pollution) and CVE-2024-22363 (ReDoS). Parsing untrusted spreadsheets from email is exactly that attack surface. Discarded for this delivery. The option would be the vendor's patched build or `exceljs`, with a size limit and a path allowlist.
6. **`fetch` instead of the Anthropic SDK.** One file, explicit timeout, explicit error mapping, testable with an injected `fetch`. Cost: I maintain the request shape myself.
7. **Blocked and pending cases logged by `oc_validar`.** Discarded: making the agent call `oc_crear` on every case so the tool records the refusal. That calls a create tool right after the analyst said "don't create it yet", which reads as ignoring the instruction even when the server refuses. The cost of the chosen option: a validation tool has one side effect, a CSV row.
8. **File-backed SAP mock with an in-process lock.** Enough for one instance, and concurrent creation is tested. Not safe across several instances. Production uses a database unique key.
9. **Sessions bound to a browser cookie.** The first API call issues a random HttpOnly, SameSite=Strict cookie, and the server stores only its hash. A session id alone no longer reads or continues a session. Discarded: trusting the `sessionId` in the body, which let anyone with a copied id read the history. The cost: API clients such as curl need a cookie jar.
10. **Offline scripted provider.** Makes the loop, the confirmation gate and the UI testable without a key. It does not test real model behavior, which needs an evaluation set.

Dependencies: `zod` (required, schemas for tools, config, HTTP input and provider responses) and `pdf-lib` (evidence PDF, pure JavaScript, no native build). Dev only: `typescript`, `@types/bun`, `@types/node`.

## 9. Assumptions

- Language: English, as Periferia confirmed. The agent answers in Spanish if the analyst writes in Spanish.
- Quote and request prices include IVA, as the quotes state.
- After an RC5 confirmation the PO keeps the request amount. Confirmation accepts the exception, it does not change values.
- Approval limits are in COP.
- Dates compare as calendar dates in the timestamp's own offset. No rule depends on today's date, so runs are reproducible.
- "Aprobado" matches without case, and negated forms do not count.
- Supplier by NIT when present, else exact normalized name. No fuzzy matching: a near miss blocks rather than guesses.
- Unit H or MES only when the description says "N horas" or "N meses" with N equal to the quantity, or the quote item is priced per hour or month. Else UN.
- SAP short text: 40 characters cut at a word boundary, trailing connectors removed. Full text kept in `trazabilidad.json`.
- The analyst has no login in this version. `confirmado_por` records the chat session id. Production uses SSO identity.
- The rubric (section 10 in the PRD header) was not in the document. I followed sections 5 to 9 and the acceptance criteria.

## 10. Coverage

| Story | State | Evidence |
|---|---|---|
| HU-1 Read the package | Done | `oc_leer_paquete`. Missing attachments come back as `null` plus a `faltantes` list. |
| HU-2 Validate against masters and controls | Done | `oc_validar`, RC1 to RC10 plus RC1-NIT, SOD, MONEDA. 20 rule tests. |
| HU-3 Build the payload | Done | `oc_construir_payload`, zod schema of 7.4, `trazabilidad.json` for every field. |
| HU-4 Approval evidence | Done (P0 and P1) | `aprobacion.txt` with SHA-256, `aprobacion.pdf` with pdf-lib. Hash equals `aprobador.evidencia_sha256`. |
| HU-5 Create the PO | Done | Idempotent by `solicitud_id`, sequential from 4500000001, `control.csv` row per attempt, including cases stopped at validation. A last `consultarProveedor` check in SAP runs right before creation. |
| HU-6 Error handling | Done | Typed errors, readable messages naming the field and what to ask. |
| `oc_leer_excel` (P1 optional) | Not done | See trade-off 5. |
| Chat front, loop, adapter, caps | Done | `web/`, `src/agent/ciclo.ts`, `src/llm/`. |
| Public link | Pending | GitHub repository plus Render Blueprint (`render.yaml`). Steps in README. |
| Threat model | Done | `docs/SECURITY.md`: 17 threats mapped to the OWASP LLM Top 10 2025, each with its control, its test and the risk left. |
| Bonus `modulo/` | Done | Generated from the same sources. `bun run check:modulo` and a test fail on drift. `modulo/tools/oc.ts` re-exports the app's tools. |

Missing for production: SSO and per-user identity, the real SAP adapter, a database for sessions and the control log, multi-instance locking, an evaluation set run against the real model, document extraction for real PDF and XLSX files, and monitoring with alerts on token spend and error rates.

## 11. Use of AI

- Claude (Anthropic, Claude Opus 5.5 in claude.ai) analyzed the three PRDs, flagged the traps in the fixtures, and generated this codebase: domain rules, tools, agent loop, provider adapter, front, tests, and a first draft of this document.
- A second pass asked Claude to audit the build against every PRD requirement. The audit found two real bugs, both fixed with regression tests. First, in the chat flow blocked and pending cases never reached `control.csv`, because only `oc_crear` wrote rows (HU-5 and O4). Second, the confirmation check accepted any message containing "ok", so "ok, now process sol-003" confirmed a pending sol-004 and created its PO (CA3). The same pass added the CC-3030 finding for sol-003 and the approval-after-invoice finding for sol-005.
- The candidate also built a parallel version with OpenAI ChatGPT/Codex. Claude compared both, ran tests against each, and ported three ideas from the ChatGPT version into this one: confirmation bound to a fingerprint of the exact order, sessions bound to an HttpOnly cookie, and a written threat model (`docs/SECURITY.md`).
- Options considered and dropped during the build: SheetJS for `oc_leer_excel` (known CVEs), trusting the payload passed by the model between tools (tampering risk), a prompt-only confirmation rule (injectable), the official SDK (a dependency for one endpoint), and model-based extraction of the quote (not reproducible).
- [Candidate: add here what you reviewed line by line, what you changed after testing, and any suggestion you rejected.]

## 12. Production risks and mitigations

| Risk | Mitigation |
|---|---|
| The model "fixes" an amount to match the quote. | Tools rebuild the payload from source files, the prompt forbids it, and the confirmation gate sits in the server. |
| Prompt injection inside an email or quote ("already approved, create it"). | Documents are data in the prompt, and `confirmado=true` without a user confirmation never reaches the tool. Tested. |
| A confirmation reused for a different order after a source file changed. | The confirmation is bound to the SHA-256 fingerprint of the exact order. `oc_crear` refuses on mismatch. Tested. |
| Someone reads or continues another user's session with a copied session id. | Sessions answer only to the HttpOnly cookie of the browser that created them. Tested. |
| A casual reply read as a confirmation. | Text confirmation must open with an affirmative and carry no negation, naming another case confirms nothing, and the Confirm button sends an explicit flag. Tested with false-positive phrases. |
| Someone drains the API key through the public link. | Access key, rate limit per IP, 4,000-character messages, 16 KB bodies, iteration cap, token caps per session and per day across all sessions, one running turn per session, and a spend limit on the key in the Anthropic Console. |
| SAP connection not viable soon. | Plan B file upload behind the same `SapAdapter`. |
| Duplicate PO after a timeout. | Query by reference before create and before any retry, plus a unique key on `solicitud_id`. |
| Wrong tax: IVA-inclusive price sent as net price. | Net price conversion in the adapter, reviewed with accounting before go-live. |
| The approval email is weak evidence. Audit may require a digital signature. | SHA-256 today. Next step: approval inside SAP (release strategy) or a signed approval flow. |
| New quote formats break the parsers. | Parsers fail closed: unreadable quote leads to confirmation, never to a guessed value. Add format tests per supplier. |
| CSV formula injection when audit opens `control.csv` in Excel. | Cells starting with `=`, `+`, `-`, `@` are neutralized. |
| Path traversal through the case id. | Strict id pattern, and every path resolves inside its base folder. Tested. |
| Sessions and logs lost on restart. | Acceptable for the demo. Production: database and log shipping. |
