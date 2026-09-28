"use strict"

const CASES = [
  ["sol-001", "Antivirus license renewal"],
  ["sol-002", "Test automation licenses"],
  ["sol-003", "Furniture for the new office"],
  ["sol-004", "Cloud architecture hours"],
  ["sol-005", "Stationery and toner"],
  ["sol-006", "Headsets for the support desk"],
]

const $ = (id) => document.getElementById(id)
const state = {
  sessionId: sessionStorage.getItem("po-session") || newId(),
  accessKey: sessionStorage.getItem("po-key") || "",
  busy: false,
  needsKey: false,
}
sessionStorage.setItem("po-session", state.sessionId)

function newId() {
  return (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2)).replace(/[^A-Za-z0-9-]/g, "")
}

// ---------- API ----------

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) }
  if (state.accessKey) headers["x-access-key"] = state.accessKey
  const response = await fetch(path, { ...options, headers })
  if (response.status === 401) {
    showKeyForm()
    throw new Error("This link needs an access key. Enter it in the left panel.")
  }
  return response
}

async function readJson(response) {
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(body.error || `Request failed with status ${response.status}.`)
  return body
}

// ---------- Rendering helpers ----------

function el(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;")
}

function inline(escaped) {
  return escaped.replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
}

/** Minimal Markdown. Everything is escaped first, so model text never becomes live HTML. */
function markdown(text) {
  const lines = String(text).replace(/\r/g, "").split("\n")
  let html = ""
  let i = 0
  const isTableStart = (k) => /^\s*\|/.test(lines[k] || "") && /^\s*\|?\s*:?-{2,}/.test(lines[k + 1] || "")
  const cells = (line) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => inline(escapeHtml(c.trim())))
  while (i < lines.length) {
    const line = lines[i]
    if (isTableStart(i)) {
      const head = cells(line)
      i += 2
      let body = ""
      while (i < lines.length && /^\s*\|/.test(lines[i])) {
        body += `<tr>${cells(lines[i]).map((c) => `<td>${c}</td>`).join("")}</tr>`
        i++
      }
      html += `<div class="table-scroll"><table><thead><tr>${head.map((c) => `<th>${c}</th>`).join("")}</tr></thead><tbody>${body}</tbody></table></div>`
    } else if (/^#{1,6}\s/.test(line)) {
      html += `<h4>${inline(escapeHtml(line.replace(/^#{1,6}\s/, "")))}</h4>`
      i++
    } else if (/^\s*[-*]\s+/.test(line)) {
      let items = ""
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) items += `<li>${inline(escapeHtml(lines[i++].replace(/^\s*[-*]\s+/, "")))}</li>`
      html += `<ul>${items}</ul>`
    } else if (/^\s*\d+\.\s+/.test(line)) {
      let items = ""
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) items += `<li>${inline(escapeHtml(lines[i++].replace(/^\s*\d+\.\s+/, "")))}</li>`
      html += `<ol>${items}</ol>`
    } else if (line.trim() === "") {
      i++
    } else {
      const para = []
      while (i < lines.length && lines[i].trim() !== "" && !isTableStart(i) && !/^(#{1,6}\s|\s*[-*]\s+|\s*\d+\.\s+)/.test(lines[i])) {
        para.push(inline(escapeHtml(lines[i++])))
      }
      html += `<p>${para.join("<br>")}</p>`
    }
  }
  return html
}

function scrollDown() {
  const c = $("conversation")
  c.scrollTop = c.scrollHeight
}

function clearEmpty() {
  const empty = $("empty")
  if (empty) empty.remove()
}

// ---------- Turns ----------

function renderUser(text) {
  clearEmpty()
  const wrap = el("div", "turn turn-user-wrap")
  wrap.append(el("div", "turn-user", text))
  $("conversation").append(wrap)
  scrollDown()
}

function renderNotice(text) {
  clearEmpty()
  const notice = el("div", "notice", text)
  notice.setAttribute("role", "alert")
  $("conversation").append(notice)
  scrollDown()
}

function renderAgent(turn) {
  clearEmpty()
  const node = el("section", "turn turn-agent")
  node.setAttribute("aria-label", "Agent answer")
  const calls = turn.toolCalls || turn.herramientas || []
  if (calls.length) node.append(renderSteps(calls))
  const answer = el("div", "answer")
  answer.innerHTML = markdown(turn.reply ?? turn.texto ?? "")
  node.append(answer)
  const outcomes = renderOutcomes(calls)
  if (outcomes) node.append(outcomes)
  const pending = turn.pendientes || []
  if (turn.needsConfirmation && pending.length) node.append(renderHoldSlip(pending))
  $("conversation").append(node)
  scrollDown()
}

function renderSteps(calls) {
  const box = el("div", "steps")
  box.append(el("p", "steps-title", `${calls.length} tool ${calls.length === 1 ? "call" : "calls"}`))
  for (const call of calls) {
    const details = el("details", `step${call.bloqueadaPorGuardia ? " guard" : call.ok ? "" : " error"}`)
    const summary = el("summary")
    summary.append(
      el("span", "step-dot"),
      el("span", "step-name", `${call.nombre}(${compactArgs(call.args)})`),
      el("span", "step-summary", call.bloqueadaPorGuardia ? `Blocked by the server: ${call.resumen}` : call.resumen),
      el("span", "step-time", `${call.duracionMs} ms`),
    )
    details.append(summary)
    details.append(el("p", "step-label", "Arguments"), el("pre", "", JSON.stringify(call.args, null, 2)))
    details.append(el("p", "step-label", "Result"), el("pre", "", JSON.stringify(call.resultado, null, 2)))
    box.append(details)
  }
  return box
}

/** Short arguments for the step row, e.g. caso: "sol-004", confirmado: true. Objects collapse to {…}. */
function compactArgs(args) {
  return Object.entries(args || {})
    .map(([k, v]) => `${k}: ${v !== null && typeof v === "object" ? "{…}" : JSON.stringify(v)}`)
    .join(", ")
}

function renderOutcomes(calls) {
  const box = el("div", "")
  const downloads = el("div", "downloads")
  for (const call of calls) {
    const caso = call.args && call.args.caso
    const data = call.resultado && call.resultado.data
    if (!call.ok || !data || typeof caso !== "string") continue
    if (call.nombre === "oc_crear" && data.numero_oc) {
      box.append(el("span", "po-stamp", `PO ${data.numero_oc}${data.idempotente ? " (existing)" : ""}`))
    }
    if (call.nombre === "oc_generar_evidencia") downloads.append(downloadButton(`Approval PDF, ${caso}`, `/api/archivos/${caso}/aprobacion.pdf`, `${caso}-aprobacion.pdf`))
    if (call.nombre === "oc_construir_payload") {
      downloads.append(downloadButton(`Payload, ${caso}`, `/api/archivos/${caso}/payload.json`, `${caso}-payload.json`))
      downloads.append(downloadButton(`Traceability, ${caso}`, `/api/archivos/${caso}/trazabilidad.json`, `${caso}-trazabilidad.json`))
    }
  }
  if (downloads.childElementCount) box.append(downloads)
  return box.childElementCount ? box : null
}

function downloadButton(label, path, filename) {
  const button = el("button", "secondary", label)
  button.type = "button"
  button.addEventListener("click", () => download(path, filename))
  return button
}

async function download(path, filename) {
  try {
    const response = await api(path)
    if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || "Download failed.")
    const url = URL.createObjectURL(await response.blob())
    const a = document.createElement("a")
    a.href = url
    a.download = filename
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  } catch (error) {
    renderNotice(error.message)
  }
}

function renderHoldSlip(pending) {
  const slip = el("div", "hold-slip")
  slip.setAttribute("role", "group")
  slip.setAttribute("aria-label", "Waiting for your confirmation")
  slip.append(el("h3", "", "Waiting for your confirmation"))
  slip.append(el("p", "", `Review the exceptions above for ${pending.join(", ")}. Nothing goes to SAP until you confirm.`))
  const actions = el("div", "hold-actions")
  const confirm = el("button", "primary", "Confirm and create PO")
  const later = el("button", "secondary", "Not yet")
  confirm.type = "button"
  later.type = "button"
  confirm.addEventListener("click", () => {
    resolveSlips()
    send(`Confirm. Create the PO for ${pending.join(", ")}.`, true)
  })
  later.addEventListener("click", () => {
    resolveSlips()
    $("message").focus()
  })
  actions.append(confirm, later)
  slip.append(actions)
  return slip
}

function resolveSlips() {
  for (const slip of document.querySelectorAll(".hold-slip:not(.resolved)")) {
    slip.classList.add("resolved")
    for (const b of slip.querySelectorAll("button")) b.disabled = true
  }
}

function showWorking() {
  const node = el("div", "working")
  node.id = "working"
  const dots = el("span", "working-dots")
  dots.append(el("span"), el("span"), el("span"))
  node.append(dots, el("span", "", "Working on it. Tool calls appear when the turn ends."))
  $("conversation").append(node)
  scrollDown()
}

function hideWorking() {
  const node = $("working")
  if (node) node.remove()
}

// ---------- Actions ----------

async function send(message, confirm = false) {
  if (state.busy || !message.trim()) return
  state.busy = true
  $("send").disabled = true
  resolveSlips()
  renderUser(message)
  showWorking()
  try {
    const response = await api("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: state.sessionId, message, confirm }),
    })
    if (response.status === 403) {
      // The session id belongs to another browser cookie. Start a fresh session for this browser.
      state.sessionId = newId()
      sessionStorage.setItem("po-session", state.sessionId)
      throw new Error("That session belongs to another browser, so a new session started. Send your message again.")
    }
    const turn = await readJson(response)
    hideWorking()
    renderAgent(turn)
    $("tokens").textContent = Number(turn.tokensSesion || 0).toLocaleString("en-US")
  } catch (error) {
    hideWorking()
    renderNotice(error.message || "Something went wrong. Try again.")
  } finally {
    state.busy = false
    $("send").disabled = false
  }
}

async function restoreSession() {
  try {
    const response = await api(`/api/sessions/${state.sessionId}`)
    if (response.status === 404) return
    const session = await readJson(response)
    for (const entry of session.historial) {
      if (entry.rol === "user") renderUser(entry.texto)
      else renderAgent({ reply: entry.texto, toolCalls: entry.herramientas, needsConfirmation: entry.needsConfirmation, pendientes: entry.pendientes })
    }
    const slips = document.querySelectorAll(".hold-slip")
    slips.forEach((slip, index) => {
      if (index < slips.length - 1 || !session.pendiente) slip.classList.add("resolved")
    })
    $("tokens").textContent = Number(session.tokens || 0).toLocaleString("en-US")
  } catch {
    // A fresh session starts empty.
  }
}

function showKeyForm() {
  state.needsKey = true
  $("key-form").hidden = false
}

async function init() {
  const list = $("cases")
  for (const [id, subject] of CASES) {
    const item = el("li")
    const button = el("button")
    button.type = "button"
    button.append(el("span", "case-id", id), el("span", "case-subject", subject))
    button.addEventListener("click", () => {
      $("message").value = `Process ${id}. Show me the PO as it would look in SAP and which controls passed and which did not.`
      $("message").focus()
    })
    item.append(button)
    list.append(item)
  }

  $("process-all").addEventListener("click", () => send("Process all six cases (sol-001 to sol-006). Give me one table with the outcome of each case."))
  $("composer").addEventListener("submit", (event) => {
    event.preventDefault()
    const text = $("message").value
    $("message").value = ""
    send(text)
  })
  $("message").addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault()
      $("composer").requestSubmit()
    }
  })
  $("new-session").addEventListener("click", () => {
    state.sessionId = newId()
    sessionStorage.setItem("po-session", state.sessionId)
    location.reload()
  })
  $("download-control").addEventListener("click", () => download("/api/control", "control.csv"))
  $("key-form").addEventListener("submit", (event) => {
    event.preventDefault()
    state.accessKey = $("access-key").value
    sessionStorage.setItem("po-key", state.accessKey)
    $("key-form").hidden = true
    restoreSession()
  })

  try {
    const health = await readJson(await fetch("/api/health"))
    $("model").textContent = health.provider === "unconfigured" ? "Not configured" : `${health.provider} / ${health.model}`
    if (health.auth && !state.accessKey) showKeyForm()
    else await restoreSession()
  } catch {
    $("model").textContent = "Server unreachable"
  }
}

init()
