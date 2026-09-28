# Process knowledge: purchase orders at Periferia IT Group

## The process

1. A requester emails compras@ with three pieces: the request spreadsheet (solicitud), the supplier quote (cotizacion) and the approval email from their leader (aprobacion).
2. The analyst checks the package against the master data and creates the PO in SAP.
3. The approval email becomes PDF evidence attached to the PO.
4. Accounting and audit read `out/control.csv`, one row per PO attempt.

A known deviation: many POs get created after the invoice arrives, skipping the quote step. These are retroactive POs. Management wants to measure them, so the agent flags them and never hides them.

## Actors

- Requester: sends the package. Does not use the agent.
- Leader (approver): replies "Aprobado". Does not use the agent.
- Analyst: talks to the agent and confirms exceptions.
- Accounting and audit: consume the control log.

## Control rules

| Code | Rule | Effect |
|---|---|---|
| RC1 | Supplier exists in the supplier master (by NIT, else by normalized name) and is active. | Block |
| RC2 | Approval exists, contains "Aprobado", and comes from an approver listed for the cost center. | Block |
| RC3 | Request total is within the approver's limit for that cost center. | Block |
| RC4 | Sub-area belongs to the cost center. | Block |
| RC5 | Quote total within 2% of the request total. Over 2%, or no quote: confirmation with both values. | Confirmation |
| RC6 | IVA code missing: derived from the supplier default and confirmed. | Confirmation + derived |
| RC7 | Payment terms missing: derived from the supplier default. Information only. | Derived |
| RC8 | Invoice dated before the request: retroactive PO, confirmed and flagged in the control log. | Confirmation |
| RC9 | Approval date on or after the request date. | Confirmation |
| RC10 | Quantity x unit price equals the total within one currency unit. | Block |

Additional checks the tools apply:

- RC1-NIT: the quote NIT must match the supplier master NIT. Otherwise confirmation. A different NIT on the quote is a fraud signal.
- MONEDA: POs accept COP or USD only.
- SOD: the requester cannot approve their own purchase.
- RC3 with USD: approval limits are in COP, so a USD request needs confirmation at the current exchange rate.

## What to ask the requester for each block

- RC1 unknown supplier: register the supplier in SAP through master data, or pick a registered supplier.
- RC1 inactive supplier: master data decides on reactivation.
- RC2 wrong approver: approval from an approver of the same cost center with enough limit. When the sender approves a different cost center, the request may carry the wrong cost center. The requester confirms which one bears the cost and resubmits. The agent never changes the cost center.
- RC3 over limit: approval from a higher approver of the same cost center. If none exists, escalate to finance management. Never split the purchase.
- RC4 wrong sub-area: correct the sub-area or the cost center.
- RC10 arithmetic: correct quantity, unit price or total.
- Missing files: resend the missing attachment.

## SAP payload notes

- Company code (sociedad) and purchasing organization are both "1000".
- Item text (descripcion) holds 40 characters, the SAP short text limit. The full text stays in `trazabilidad.json`, and a real integration sends it as item long text.
- Units: UN (units), H (hours), MES (months). Hours apply when the request says "N horas" with N equal to the quantity, or the quote item is priced per hour.
- IVA codes: C0 excluded, C1 19%, C2 5%.
- Payment terms: Z000 immediate, Z015, Z030, Z060 days from invoice date.
- Prices in the fixtures include IVA, as the quotes state. The real SAP adapter must send the net price or use gross pricing, so IVA is not applied twice.
- Every payload value is traceable to a source: solicitud, cotizacion, maestro.<name> or derivado.

## Idempotency

A second `oc_crear` for the same solicitud_id returns the existing PO number and never creates a second order. The control log records the retry as "existente".

## Control log

`out/control.csv` columns: solicitud_id, resultado (creada, existente, bloqueada, pendiente_confirmacion), numero_oc, retroactiva, bloqueos, confirmaciones, ts.

Every attempt adds a row. `oc_validar` records blocked and pending cases, so a case that stops at validation still counts. `oc_crear` records created, existing, and any refused creation.
