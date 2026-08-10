/* ============================================================
   CRM del cliente — chats, difusiones, conexión
   ============================================================ */

let sesion   = null
let socket   = null
let chats    = []
let chatActivo = null
let sesionesWa = []
let plantillas = []
let difusiones = []

// El dueño de la plataforma puede abrir el CRM de un cliente con ?tenantId=
const TENANT_ID = new URLSearchParams(location.search).get("tenantId")

/** Agrega el tenantId a la URL cuando mira un dueño. */
function u(ruta) {
  if (!TENANT_ID) return ruta
  return ruta + (ruta.includes("?") ? "&" : "?") + "tenantId=" + TENANT_ID
}

const ESTADO_WA = {
  connected:    ["dot-on",   "Conectado"],
  connecting:   ["dot-wait", "Conectando…"],
  qr:           ["dot-wait", "Esperando QR"],
  disconnected: ["dot-off",  "Sin conectar"],
  error:        ["dot-err",  "Error de conexión"]
}

/* ============================================================
   ARRANQUE
   ============================================================ */
;(async () => {
  sesion = await cargarSesion()
  if (!sesion) return

  $("#user-name").textContent  = sesion.user.name
  $("#user-email").textContent = sesion.user.email
  $("#tenant-name").textContent = sesion.tenant?.name || (TENANT_ID ? "Cliente #" + TENANT_ID : "Mi CRM")

  conectarSocket()
  await Promise.all([cargarSesionesWa(), cargarZonas(), cargarTags(), cargarChats()])
  pintarPlan()
  refrescarResumen()
  setInterval(refrescarResumen, 60000)
})()

function conectarSocket() {
  if (!window.io) return
  socket = window.io({ path: "/socket.io" })

  socket.on("connect", () => { if (TENANT_ID) socket.emit("watch:tenant", TENANT_ID) })
  socket.on("session:status",  alSesionCambio)
  socket.on("message:new",     alMensajeNuevo)
  socket.on("message:ack",     alAck)
  socket.on("campaign:progress", alProgresoDifusion)
  socket.on("campaign:status",   () => cargarDifusiones())
  socket.on("chats:synced", r => { toast("Sincronizados " + r.guardados + " chats"); cargarChats(); cargarZonas() })
}

/* ============================================================
   NAVEGACIÓN
   ============================================================ */
const VISTAS = ["chats", "difusiones", "plantillas", "conexion", "ajustes"]

$$(".nav-item").forEach(item => {
  item.addEventListener("click", () => {
    $$(".nav-item").forEach(i => i.classList.remove("active"))
    item.classList.add("active")
    const vista = item.dataset.vista
    VISTAS.forEach(v => $("#vista-" + v).classList.toggle("hidden", v !== vista))
    $("#rail").classList.remove("open")

    if (vista === "difusiones") cargarDifusiones()
    if (vista === "plantillas") cargarPlantillas()
    if (vista === "conexion")   cargarSesionesWa()
  })
})

$("#logout").addEventListener("click", cerrarSesion)

/* ============================================================
   RESUMEN / CONTADORES
   ============================================================ */
async function refrescarResumen() {
  try {
    const r = await API.get(u("/chats/resumen"))
    $("#cnt-noleidos").innerHTML = r.no_leidos > 0 ? '<span class="badge">' + r.no_leidos + "</span>" : ""
  } catch (_) {}
}

function pintarPlan() {
  const t = sesion.tenant
  if (!t) return
  $("#info-plan").innerHTML = `
    <div class="spread"><span class="dim small">Plan</span><span class="chip chip-purple">${esc(t.plan)}</span></div>
    <div class="spread"><span class="dim small">Líneas de WhatsApp</span><span class="mono">${t.max_sessions}</span></div>
    <div class="spread"><span class="dim small">Tope diario de difusión</span><span class="mono">${nEsp(t.daily_limit)}</span></div>`
}

/* ============================================================
   ZONAS (códigos de área)
   ============================================================ */
async function cargarZonas() {
  try {
    const { areas, paises } = await API.get(u("/chats/zonas"))
    const sel = $("#filtro-zona")
    const previo = sel.value

    const opcArg = areas.map(a =>
      '<option value="area:' + a.area_code + '">' + esc(a.region) + " (" + a.total + ")</option>").join("")
    const opcPais = paises.filter(p => p.country_code !== "54").map(p =>
      '<option value="pais:' + p.country_code + '">' + esc(p.country || p.country_code) + " (" + p.total + ")</option>").join("")

    sel.innerHTML = '<option value="">Todas las zonas</option>' +
      (opcArg  ? '<optgroup label="Argentina">' + opcArg + "</optgroup>" : "") +
      (opcPais ? '<optgroup label="Otros países">' + opcPais + "</optgroup>" : "")
    sel.value = previo
  } catch (_) {}
}

/* ============================================================
   LISTA DE CHATS
   ============================================================ */
let timerBusqueda = null
let timerRecarga  = null
let cargaSeq      = 0          // descarta respuestas viejas que llegan tarde
let totalFiltrado = 0

// El navegador autocompleta campos de texto sueltos con el email guardado.
// Si eso pasa acá, la búsqueda se ensucia sola y la lista queda vacía sin
// que el usuario haya tocado nada. Limpiamos cualquier valor que no haya
// sido tecleado por una persona.
let busquedaTecleada = ""
$("#buscar").addEventListener("input", e => {
  busquedaTecleada = e.target.value
  clearTimeout(timerBusqueda)
  timerBusqueda = setTimeout(cargarChats, 280)
})

function limpiarAutocompletado() {
  const campo = $("#buscar")
  if (campo && campo.value !== busquedaTecleada) campo.value = busquedaTecleada
}
// El autocompletado puede llegar bastante después del load (incluso al volver
// a la pestaña), así que vigilamos el campo un rato y en cada foco de ventana.
;[0, 100, 300, 600, 1200, 2500, 5000].forEach(ms => setTimeout(limpiarAutocompletado, ms))
window.addEventListener("pageshow", () => setTimeout(limpiarAutocompletado, 100))
window.addEventListener("focus",    () => setTimeout(limpiarAutocompletado, 100))

$$("#filtro-zona, #filtro-orden, #filtro-quien, #filtro-frios, #solo-noleidos")
  .forEach(el => el.addEventListener("change", cargarChats))

$("#btn-limpiar").addEventListener("click", () => {
  busquedaTecleada = ""
  $("#buscar").value = ""
  $("#filtro-zona").value = ""
  $("#filtro-quien").value = ""
  $("#filtro-frios").value = ""
  $("#filtro-orden").value = "reciente"
  $("#solo-noleidos").checked = false
  tagActivo = ""
  cargarChats()
  cargarTags()
})

$("#btn-leer-todo").addEventListener("click", async () => {
  try {
    const r = await API.post(u("/chats/leer-todo"))
    toast(r.actualizados ? r.actualizados + " chats marcados como leídos" : "No había nada sin leer")
    cargarChats(); refrescarResumen()
  } catch (e) { toast(e.message, "error") }
})

$("#btn-difundir-filtro").addEventListener("click", () => {
  $$(".nav-item").forEach(i => i.classList.toggle("active", i.dataset.vista === "difusiones"))
  VISTAS.forEach(v => $("#vista-" + v).classList.toggle("hidden", v !== "difusiones"))
  abrirAsistenteDifusion(filtrosActuales())
})

/** Recarga coalescida: varios mensajes seguidos disparan una sola consulta. */
function recargarChatsPronto(ms = 500) {
  clearTimeout(timerRecarga)
  timerRecarga = setTimeout(cargarChats, ms)
}

$("#btn-sync").addEventListener("click", async () => {
  const sesionWa = sesionesWa[0]
  if (!sesionWa) return toast("Primero conectá WhatsApp", "warn")

  const boton = $("#btn-sync")
  boton.disabled = true
  boton.textContent = "…"
  try {
    const r = await API.post(u("/sessions/" + sesionWa.id + "/sync"))
    if (!r.ok) toast(r.mensaje, "warn")
    await Promise.all([cargarChats(), cargarZonas()])
  } catch (e) {
    toast(e.message, "error")
  } finally {
    boton.disabled = false
    boton.textContent = "⟳"
  }
})

/** Lee el estado actual de todos los filtros de la pantalla. */
function filtrosActuales() {
  const zona = $("#filtro-zona").value
  return {
    // A propósito NO se lee $("#buscar").value: el navegador puede escribir
    // ahí lo que quiera (autocompletado). Solo vale lo que se tecleó.
    q:        busquedaTecleada.trim(),
    orden:    $("#filtro-orden").value,
    quien:    $("#filtro-quien").value,
    frios:    $("#filtro-frios").value,
    tag:      tagActivo,
    noleidos: $("#solo-noleidos").checked ? "1" : "",
    area:     zona.startsWith("area:") ? zona.slice(5) : "",
    pais:     zona.startsWith("pais:") ? zona.slice(5) : ""
  }
}

function hayFiltrosActivos() {
  const f = filtrosActuales()
  return !!(f.q || f.quien || f.frios || f.tag || f.noleidos || f.area || f.pais)
}

async function cargarChats() {
  limpiarAutocompletado()

  const f = filtrosActuales()
  const params = new URLSearchParams({ limit: "120" })
  for (const [k, v] of Object.entries(f)) if (v) params.set(k, v)

  const mia = ++cargaSeq
  try {
    const r = await API.get(u("/chats?" + params.toString()))
    // Si mientras esperábamos salió otra consulta, esta respuesta ya no sirve:
    // pintarla haría "parpadear" la lista con datos viejos.
    if (mia !== cargaSeq) return

    chats = r.chats || []
    totalFiltrado = r.total || 0
    pintarChats()
  } catch (e) {
    if (mia === cargaSeq) toast(e.message, "error")
  }
}

function pintarChats() {
  const cont = $("#chatlist-body")
  const filtrando = hayFiltrosActivos()

  $("#chatlist-total").textContent = totalFiltrado
    ? (chats.length < totalFiltrado ? chats.length + " de " + nEsp(totalFiltrado) : nEsp(totalFiltrado) + " chats")
    : ""
  $("#btn-limpiar").classList.toggle("hidden", !filtrando)
  $("#btn-difundir-filtro").classList.toggle("hidden", !filtrando || !chats.length)

  if (!chats.length) {
    // Distinguir "no tenés chats" de "el filtro no encontró nada" evita
    // que parezca que se rompió algo cuando en realidad hay un filtro puesto.
    cont.innerHTML = filtrando
      ? `<div class="empty" style="padding:50px 24px">
           <div>
             <div class="ico">🔍</div>
             <div class="h3">Sin resultados</div>
             <div class="muted small" style="margin-top:6px">Ningún chat coincide con los filtros actuales.</div>
             <button class="btn btn-sm" style="margin-top:14px" onclick="document.getElementById('btn-limpiar').click()">Limpiar filtros</button>
           </div></div>`
      : `<div class="empty" style="padding:50px 24px">
           <div>
             <div class="ico">📭</div>
             <div class="h3">No hay conversaciones</div>
             <div class="muted small" style="margin-top:6px">Conectá WhatsApp y tocá ⟳ para traer tus chats.</div>
           </div></div>`
    return
  }

  cont.innerHTML = chats.map(c => {
    const nombre = c.display_name
    const activo = chatActivo && chatActivo.id === c.id
    const tags   = (c.tags || []).map(t => '<span class="chip tiny">' + esc(t) + "</span>").join("")

    // "Te escribió hace X" es el dato que más se mira para decidir a quién retomar.
    const ultimaResp = c.last_inbound_at
      ? "responde " + haceCuanto(c.last_inbound_at)
      : "nunca respondió"

    return `<div class="chat-item ${activo ? "active" : ""}" data-chat="${c.id}">
      ${avatarHtml(nombre)}
      <div class="grow" style="min-width:0">
        <div class="top">
          <span class="nm truncate">${esc(nombre)}</span>
          <span class="tm">${esc(selloLista(c.last_message_at))}</span>
        </div>
        <div class="pv truncate">
          ${c.last_direction === "out" ? '<span class="dim">vos: </span>' : ""}${esc(c.last_message_text || "—")}
        </div>
        <div class="meta">
          ${c.region ? '<span class="zone-tag">' + esc(c.region) + "</span>" : ""}
          ${tags}
          ${c.status !== "abierto" ? '<span class="chip tiny">' + esc(c.status) + "</span>" : ""}
          <span class="grow"></span>
          <span class="tiny dim">${esc(ultimaResp)}</span>
          <button class="btn-pin" data-pin="${c.id}" title="${c.pinned ? "Desfijar" : "Fijar arriba"}"
                  style="opacity:${c.pinned ? 1 : .3}">📌</button>
          ${c.unread_count > 0 ? '<span class="badge">' + c.unread_count + "</span>" : ""}
        </div>
      </div>
    </div>`
  }).join("")

  cont.querySelectorAll("[data-chat]").forEach(el =>
    el.addEventListener("click", () => abrirChat(Number(el.dataset.chat))))

  cont.querySelectorAll("[data-pin]").forEach(b => b.addEventListener("click", async e => {
    e.stopPropagation()          // sin esto, fijar también abriría el chat
    const id = Number(b.dataset.pin)
    const actual = chats.find(c => c.id === id)
    try {
      await API.patch(u("/chats/" + id), { pinned: !actual.pinned })
      cargarChats()
    } catch (err) { toast(err.message, "error") }
  }))
}

/* ---------------- Etiquetas ---------------- */
let tagActivo = ""

async function cargarTags() {
  try {
    const tags = await API.get(u("/chats/tags"))
    const cont = $("#filtro-tags")
    if (!tags.length) { cont.innerHTML = ""; return }

    cont.innerHTML = tags.map(t =>
      `<span class="chip ${tagActivo === t.tag ? "chip-acc" : ""}" data-ftag="${esc(t.tag)}"
             style="cursor:pointer">${esc(t.tag)} <span class="dim">${t.total}</span></span>`
    ).join("")

    cont.querySelectorAll("[data-ftag]").forEach(el => el.addEventListener("click", () => {
      tagActivo = tagActivo === el.dataset.ftag ? "" : el.dataset.ftag
      cargarTags()
      cargarChats()
    }))
  } catch (_) {}
}

/* ============================================================
   CONVERSACIÓN
   ============================================================ */
async function abrirChat(chatId) {
  try {
    const { chat, mensajes } = await API.get(u("/chats/" + chatId + "/messages?limit=80"))
    chatActivo = chat

    $("#conv-vacio").classList.add("hidden")
    $("#conv-activa").classList.remove("hidden")

    $("#conv-avatar").innerHTML = avatarHtml(chat.display_name)
    $("#conv-nombre").textContent = chat.display_name
    $("#conv-zona").textContent   = chat.zona || ""
    $("#conv-zona").classList.toggle("hidden", !chat.zona)
    $("#conv-estado").value = chat.status
    $("#conv-pin").style.opacity = chat.pinned ? "1" : ".45"

    const ultima = chat.last_inbound_at
      ? "Te escribió " + haceCuanto(chat.last_inbound_at)
      : "Todavía no te escribió"
    const quienHablo = chat.last_direction === "out" ? "última palabra: vos"
                     : chat.last_direction === "in"  ? "última palabra: el cliente"
                     : "sin mensajes"
    $("#conv-sub").textContent = chat.phone_pretty + " · " + ultima + " · " + quienHablo

    pintarTagsConversacion()
    pintarMensajes(mensajes)

    // Marca el ítem activo y limpia su badge sin recargar toda la lista
    $$(".chat-item").forEach(el => el.classList.toggle("active", Number(el.dataset.chat) === chatId))
    const enLista = chats.find(c => c.id === chatId)
    if (enLista) { enLista.unread_count = 0 }
    const badge = document.querySelector('.chat-item[data-chat="' + chatId + '"] .badge')
    if (badge) badge.remove()
    refrescarResumen()

    if (window.innerWidth <= 860) {
      $("#chatlist").classList.add("hide-mobile")
      $("#volver-lista").classList.remove("hidden")
    }
  } catch (e) { toast(e.message, "error") }
}

function pintarMensajes(mensajes) {
  const cont = $("#conv-body")
  let ultimoDia = ""
  const partes = []

  for (const m of mensajes) {
    const dia = new Date(m.sent_at).toDateString()
    if (dia !== ultimoDia) {
      ultimoDia = dia
      partes.push('<div class="chip day-sep">' + esc(fechaLarga(m.sent_at)) + "</div>")
    }
    partes.push(burbuja(m))
  }
  cont.innerHTML = partes.join("")
  cont.scrollTop = cont.scrollHeight
}

function burbuja(m) {
  const marca = m.direction === "out"
    ? '<span title="' + esc(m.status || "") + '">' +
      (m.status === "read" ? "✓✓" : m.status === "delivered" ? "✓✓" : "✓") + "</span>"
    : ""
  const autor = m.direction === "out" && m.author
    ? '<div class="author">' + esc(m.author) + "</div>" : ""

  return '<div class="bubble ' + (m.direction === "out" ? "out" : "in") + '" data-msg="' + (m.wa_msg_id || "") + '">' +
    autor +
    '<div>' + formatoWhatsapp(m.body || "") + "</div>" +
    '<div class="stamp">' + esc(horaCorta(m.sent_at)) + " " + marca + "</div>" +
    "</div>"
}

$("#volver-lista").addEventListener("click", () => {
  $("#chatlist").classList.remove("hide-mobile")
  $("#volver-lista").classList.add("hidden")
})

/* ---------------- Enviar ---------------- */
const composer = $("#composer")

composer.addEventListener("input", () => {
  composer.style.height = "auto"
  composer.style.height = Math.min(composer.scrollHeight, 170) + "px"
})

composer.addEventListener("keydown", e => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); enviarMensaje() }
})
$("#enviar").addEventListener("click", enviarMensaje)

async function enviarMensaje() {
  const texto = composer.value.trim()
  if (!texto || !chatActivo) return

  const boton = $("#enviar")
  boton.disabled = true
  try {
    const m = await API.post(u("/chats/" + chatActivo.id + "/messages"), { texto })
    composer.value = ""
    composer.style.height = "auto"
    if (m) {
      $("#conv-body").insertAdjacentHTML("beforeend", burbuja(m))
      $("#conv-body").scrollTop = $("#conv-body").scrollHeight
    }
    cargarChats()
  } catch (e) {
    toast(e.message, "error")
  } finally {
    boton.disabled = false
    composer.focus()
  }
}

$("#conv-estado").addEventListener("change", async e => {
  if (!chatActivo) return
  try {
    await API.patch(u("/chats/" + chatActivo.id), { estado: e.target.value })
    chatActivo.status = e.target.value
    cargarChats()
  } catch (err) { toast(err.message, "error") }
})

$("#conv-pin").addEventListener("click", async () => {
  if (!chatActivo) return
  try {
    const c = await API.patch(u("/chats/" + chatActivo.id), { pinned: !chatActivo.pinned })
    chatActivo.pinned = c.pinned
    $("#conv-pin").style.opacity = c.pinned ? "1" : ".45"
    cargarChats()
  } catch (e) { toast(e.message, "error") }
})

/* ---------------- Etiquetas de la conversación abierta ---------------- */
function pintarTagsConversacion() {
  const cont = $("#conv-tags-lista")
  const tags = chatActivo?.tags || []

  cont.innerHTML = tags.map(t =>
    `<span class="chip chip-purple">${esc(t)} <button data-quitar="${esc(t)}" title="Quitar">✕</button></span>`
  ).join("")

  cont.querySelectorAll("[data-quitar]").forEach(b => b.addEventListener("click", async () => {
    try {
      const c = await API.post(u("/chats/" + chatActivo.id + "/tags"), { quitar: b.dataset.quitar })
      chatActivo.tags = c.tags
      pintarTagsConversacion()
      cargarTags(); cargarChats()
    } catch (e) { toast(e.message, "error") }
  }))
}

$("#conv-tags").addEventListener("click", async () => {
  if (!chatActivo) return
  const existentes = await API.get(u("/chats/tags")).catch(() => [])
  const sugeridas  = existentes
    .filter(t => !(chatActivo.tags || []).includes(t.tag))
    .map(t => `<span class="chip" data-sug="${esc(t.tag)}" style="cursor:pointer">＋ ${esc(t.tag)}</span>`)
    .join("")

  const { overlay, cerrar } = abrirModal(`
    <div class="modal-head">
      <div>
        <div class="h2">Etiquetas</div>
        <div class="tiny dim">${esc(chatActivo.display_name || "")}</div>
      </div>
      <button class="btn btn-ghost btn-sm" data-cerrar>✕</button>
    </div>
    <div class="modal-body">
      <div class="field">
        <label class="label">Nueva etiqueta</label>
        <div class="row">
          <input class="input" id="tg-nueva" maxlength="30" placeholder="presupuesto enviado" autocomplete="off">
          <button class="btn btn-primary" id="tg-add">Agregar</button>
        </div>
        <div class="hint">Sirven para filtrar la lista y para segmentar difusiones.</div>
      </div>
      ${sugeridas ? '<div class="field"><label class="label">Ya usadas</label><div class="row wrap" style="gap:6px">' + sugeridas + "</div></div>" : ""}
    </div>
    <div class="modal-foot"><button class="btn" data-cerrar>Listo</button></div>`)

  const agregar = async valor => {
    const tag = String(valor || "").trim()
    if (!tag) return
    try {
      const c = await API.post(u("/chats/" + chatActivo.id + "/tags"), { agregar: tag })
      chatActivo.tags = c.tags
      pintarTagsConversacion()
      cargarTags(); cargarChats()
      cerrar()
    } catch (e) { toast(e.message, "error") }
  }

  overlay.querySelector("#tg-add").addEventListener("click", () => agregar(overlay.querySelector("#tg-nueva").value))
  overlay.querySelector("#tg-nueva").addEventListener("keydown", e => {
    if (e.key === "Enter") agregar(e.target.value)
  })
  overlay.querySelectorAll("[data-sug]").forEach(el =>
    el.addEventListener("click", () => agregar(el.dataset.sug)))
})

/* ============================================================
   EVENTOS EN VIVO
   ============================================================ */
function alMensajeNuevo(p) {
  if (chatActivo && p.chatId === chatActivo.id) {
    $("#conv-body").insertAdjacentHTML("beforeend", burbuja(p.mensaje))
    $("#conv-body").scrollTop = $("#conv-body").scrollHeight
    API.post(u("/chats/" + chatActivo.id + "/read")).catch(() => {})
  } else if (p.mensaje?.direction === "in") {
    const quien = p.contacto?.name || p.contacto?.push_name || p.contacto?.phone || "Nuevo mensaje"
    toast("💬 " + quien + ": " + (p.mensaje.body || "").slice(0, 60))
  }
  recargarChatsPronto()
  refrescarResumen()
}

function alAck(p) {
  const el = document.querySelector('.bubble[data-msg="' + p.waMsgId + '"] .stamp span')
  if (el) el.textContent = p.status === "sent" ? "✓" : "✓✓"
}

function alSesionCambio(p) {
  const idx = sesionesWa.findIndex(s => s.id === p.sessionId)
  if (idx >= 0) sesionesWa[idx] = { ...sesionesWa[idx], ...p, last_qr: p.qr }
  pintarEstadoRail()
  if (!$("#vista-conexion").classList.contains("hidden")) pintarSesiones()

  if (p.status === "connected") {
    toast("WhatsApp conectado" + (p.phone ? " (+" + p.phone + ")" : ""))
    setTimeout(() => { cargarChats(); cargarZonas() }, 3000)
  }
  if (p.status === "error" && p.error) toast(p.error, "error")
}

function pintarEstadoRail() {
  const principal = sesionesWa[0]
  const [dot, txt] = ESTADO_WA[principal?.status] || ESTADO_WA.disconnected
  $("#wa-dot").className = "dot " + dot
  $("#wa-estado").textContent = txt
}

/* ============================================================
   CONEXIÓN / QR
   ============================================================ */
async function cargarSesionesWa() {
  try {
    sesionesWa = await API.get(u("/sessions"))
    pintarEstadoRail()
    pintarSesiones()
  } catch (_) {}
}

function pintarSesiones() {
  const cont = $("#lista-sesiones")
  if (!cont) return

  if (!sesionesWa.length) {
    cont.innerHTML = '<div class="card muted">No tenés líneas configuradas. Pedile una al administrador.</div>'
    return
  }

  cont.innerHTML = sesionesWa.map(s => {
    const [dot, txt] = ESTADO_WA[s.status] || ESTADO_WA.disconnected
    const conectado  = s.status === "connected"
    const mostrarQr  = s.status === "qr" && s.last_qr

    return `<div class="card col" style="gap:16px">
      <div class="spread">
        <div class="row">
          <span class="dot ${dot}"></span>
          <div>
            <div style="font-weight:650">${esc(s.label || "Principal")}</div>
            <div class="tiny dim">${esc(txt)}${s.phone ? " · +" + esc(s.phone) : ""}</div>
          </div>
        </div>
        <div class="row" style="gap:8px">
          ${conectado
            ? `<button class="btn btn-sm" data-sync="${s.id}">Sincronizar chats</button>
               <button class="btn btn-sm btn-danger" data-logout="${s.id}">Desvincular</button>`
            : `<button class="btn btn-primary btn-sm" data-connect="${s.id}">
                 ${s.status === "connecting" || s.status === "qr" ? "Reintentar" : "Conectar WhatsApp"}
               </button>`}
        </div>
      </div>

      ${mostrarQr ? `
        <div class="col" style="gap:12px;align-items:center">
          <div class="qr-box"><img src="${esc(s.last_qr)}" alt="Código QR"></div>
          <div class="small muted" style="text-align:center;max-width:380px">
            Abrí <b>WhatsApp</b> en tu teléfono → <b>Dispositivos vinculados</b> →
            <b>Vincular un dispositivo</b> y escaneá este código.
          </div>
        </div>` : ""}

      ${s.status === "connecting" ? `
        <div class="col" style="gap:12px;align-items:center">
          <div class="qr-skeleton">Generando código QR…</div>
          <div class="small muted">Puede tardar hasta un minuto la primera vez.</div>
        </div>` : ""}

      ${s.last_error ? '<div class="small" style="color:#fda4af">' + esc(s.last_error) + "</div>" : ""}
    </div>`
  }).join("")

  cont.querySelectorAll("[data-connect]").forEach(b => b.addEventListener("click", async () => {
    b.disabled = true; b.textContent = "Iniciando…"
    try {
      const r = await API.post(u("/sessions/" + b.dataset.connect + "/connect"))
      toast(r.mensaje || "Iniciando…")
      setTimeout(cargarSesionesWa, 2500)
    } catch (e) { toast(e.message, "error"); b.disabled = false; b.textContent = "Conectar WhatsApp" }
  }))

  cont.querySelectorAll("[data-logout]").forEach(b => b.addEventListener("click", async () => {
    if (!await confirmar("Vas a desvincular esta línea. Para volver a usarla habrá que escanear el QR de nuevo.", "Desvincular")) return
    try { await API.post(u("/sessions/" + b.dataset.logout + "/logout")); toast("Línea desvinculada"); cargarSesionesWa() }
    catch (e) { toast(e.message, "error") }
  }))

  cont.querySelectorAll("[data-sync]").forEach(b => b.addEventListener("click", async () => {
    b.disabled = true; b.textContent = "Sincronizando…"
    try {
      const r = await API.post(u("/sessions/" + b.dataset.sync + "/sync"))
      toast(r.ok ? "Sincronizados " + r.guardados + " chats" : r.mensaje, r.ok ? "ok" : "warn")
      cargarChats(); cargarZonas()
    } catch (e) { toast(e.message, "error") }
    finally { b.disabled = false; b.textContent = "Sincronizar chats" }
  }))
}

/* ============================================================
   DIFUSIONES
   ============================================================ */
const ESTADO_CAMPANIA = {
  draft:     ["chip",        "Borrador"],
  running:   ["chip-acc",    "Enviando"],
  paused:    ["chip-warn",   "En pausa"],
  done:      ["chip-info",   "Finalizada"],
  cancelled: ["chip-danger", "Cancelada"],
  error:     ["chip-danger", "Error"]
}

async function cargarDifusiones() {
  try {
    difusiones = await API.get(u("/campaigns"))
    pintarDifusiones()
  } catch (e) { toast(e.message, "error") }
}

function pintarDifusiones() {
  const cont = $("#lista-difusiones")
  if (!difusiones.length) {
    cont.innerHTML = `<div class="card center col" style="padding:50px;text-align:center">
      <div class="ico" style="font-size:40px;opacity:.35">📣</div>
      <div class="h3">Todavía no creaste ninguna difusión</div>
      <div class="muted small">Armá tu primer envío masivo con “＋ Nueva difusión”.</div>
    </div>`
    return
  }

  cont.innerHTML = difusiones.map(c => {
    const [cls, txt] = ESTADO_CAMPANIA[c.status] || ESTADO_CAMPANIA.draft
    const procesados = c.sent + c.failed
    const pct = c.total ? Math.round(procesados / c.total * 100) : 0

    return `<div class="card col" style="gap:13px" data-campania="${c.id}">
      <div class="spread">
        <div class="grow">
          <div class="row" style="gap:9px">
            <span style="font-weight:650">${esc(c.name)}</span>
            <span class="chip ${cls}">${esc(txt)}</span>
          </div>
          <div class="tiny dim" style="margin-top:3px">
            Creada ${esc(haceCuanto(c.created_at))}${c.session_label ? " · " + esc(c.session_label) : ""}
          </div>
        </div>
        <div class="row" style="gap:7px">
          ${["draft", "paused"].includes(c.status) ? `<button class="btn btn-primary btn-sm" data-start="${c.id}">▶ ${c.status === "paused" ? "Reanudar" : "Iniciar"}</button>` : ""}
          ${c.status === "running" ? `<button class="btn btn-sm" data-pause="${c.id}">⏸ Pausar</button>` : ""}
          ${["running", "paused", "draft"].includes(c.status) ? `<button class="btn btn-sm btn-danger" data-cancel="${c.id}">Cancelar</button>` : ""}
          <button class="btn btn-sm" data-ver="${c.id}">Detalle</button>
        </div>
      </div>

      <div class="bar"><i style="width:${pct}%"></i></div>
      <div class="row wrap" style="gap:8px">
        <span class="chip chip-acc">✓ ${nEsp(c.sent)} enviados</span>
        ${c.failed ? '<span class="chip chip-danger">✕ ' + nEsp(c.failed) + " fallidos</span>" : ""}
        <span class="chip">${nEsp(c.total - procesados)} pendientes</span>
        <span class="chip">Total ${nEsp(c.total)}</span>
        <span class="grow"></span>
        <span class="tiny dim" data-espera="${c.id}"></span>
      </div>
    </div>`
  }).join("")

  cont.querySelectorAll("[data-start]").forEach(b => b.addEventListener("click", () => accionDifusion(b.dataset.start, "start")))
  cont.querySelectorAll("[data-pause]").forEach(b => b.addEventListener("click", () => accionDifusion(b.dataset.pause, "pause")))
  cont.querySelectorAll("[data-cancel]").forEach(b => b.addEventListener("click", async () => {
    if (await confirmar("Cancelar esta difusión? Los pendientes no se van a enviar.", "Cancelar difusión")) {
      accionDifusion(b.dataset.cancel, "cancel")
    }
  }))
  cont.querySelectorAll("[data-ver]").forEach(b => b.addEventListener("click", () => modalDetalle(Number(b.dataset.ver))))
}

async function accionDifusion(id, accion) {
  try {
    const r = await API.post(u("/campaigns/" + id + "/" + accion))
    toast(r.mensaje || "Listo")
    cargarDifusiones()
  } catch (e) { toast(e.message, "error") }
}

function alProgresoDifusion(p) {
  const tarjeta = document.querySelector('[data-campania="' + p.id + '"]')
  if (!tarjeta) return
  const procesados = p.sent + p.failed
  const pct = p.total ? Math.round(procesados / p.total * 100) : 0
  tarjeta.querySelector(".bar > i").style.width = pct + "%"
  const chips = tarjeta.querySelectorAll(".chip")
  if (chips[1]) chips[1].textContent = "✓ " + nEsp(p.sent) + " enviados"
  const espera = tarjeta.querySelector("[data-espera]")
  if (espera && p.ultimo) espera.textContent = "último: " + p.ultimo
}

async function modalDetalle(id) {
  try {
    const c = await API.get(u("/campaigns/" + id))
    const filas = c.targets.map(t => `<tr>
      <td class="mono small">${esc(t.jid.replace("@c.us", ""))}</td>
      <td>${esc(t.name || "—")}</td>
      <td>${t.status === "sent" ? '<span class="chip chip-acc">enviado</span>'
            : t.status === "failed" ? '<span class="chip chip-danger">falló</span>'
            : '<span class="chip">pendiente</span>'}</td>
      <td class="tiny dim">${esc(t.sent_at ? haceCuanto(t.sent_at) : (t.error || ""))}</td>
    </tr>`).join("")

    abrirModal(`
      <div class="modal-head">
        <div>
          <div class="h2">${esc(c.name)}</div>
          <div class="tiny dim">${nEsp(c.sent)} enviados · ${nEsp(c.failed)} fallidos · ${nEsp(c.total)} total</div>
        </div>
        <button class="btn btn-ghost btn-sm" data-cerrar>✕</button>
      </div>
      <div class="modal-body">
        <div class="field">
          <div class="label">Mensaje base</div>
          <div class="variant">${esc(c.base_message)}</div>
        </div>
        <div class="field">
          <div class="label">Destinatarios</div>
          <div class="table-wrap" style="max-height:340px;overflow-y:auto">
            <table class="table">
              <thead><tr><th>Número</th><th>Nombre</th><th>Estado</th><th>Cuándo</th></tr></thead>
              <tbody>${filas || '<tr><td colspan="4" class="muted">Sin destinatarios</td></tr>'}</tbody>
            </table>
          </div>
        </div>
      </div>
      <div class="modal-foot"><button class="btn" data-cerrar>Cerrar</button></div>`,
      { ancho: "modal-lg" })
  } catch (e) { toast(e.message, "error") }
}

/* ---------------- Asistente de nueva difusión ---------------- */
// Ojo: sin la arrow, el listener pasaría el MouseEvent como prefill.
$("#btn-nueva-difusion").addEventListener("click", () => abrirAsistenteDifusion())

/**
 * @param prefill filtros heredados del listado de chats (botón "Difundir a estos")
 */
async function abrirAsistenteDifusion(prefill = {}) {
  const [zonas, defaults, tpls] = await Promise.all([
    API.get(u("/chats/zonas")),
    API.get(u("/campaigns/defaults")),
    API.get(u("/campaigns/templates/list"))
  ])

  const opcionesZona = zonas.areas.map(a =>
    `<label class="chip" style="cursor:pointer">
       <input type="checkbox" value="${a.area_code}" class="zona-check"
              ${prefill.area === a.area_code ? "checked" : ""} style="margin-right:5px">
       ${esc(a.region)} (${a.total})
     </label>`).join("")

  const opcionesTpl = tpls.map(t => '<option value="' + t.id + '">' + esc(t.name) + "</option>").join("")

  const { overlay, cerrar } = abrirModal(`
    <div class="modal-head">
      <div>
        <div class="h2">Nueva difusión</div>
        <div class="tiny dim">Cada contacto recibe una versión distinta del mensaje</div>
      </div>
      <button class="btn btn-ghost btn-sm" data-cerrar>✕</button>
    </div>
    <div class="modal-body">

      <div class="field">
        <label class="label">Nombre interno</label>
        <input class="input" id="d-nombre" placeholder="Agenda de agosto">
      </div>

      <div class="field">
        <div class="spread">
          <label class="label">Mensaje base</label>
          ${opcionesTpl ? '<select class="select" id="d-tpl" style="width:auto;font-size:12px;padding:4px 26px 4px 8px"><option value="">Usar plantilla…</option>' + opcionesTpl + "</select>" : ""}
        </div>
        <textarea class="textarea" id="d-mensaje" placeholder="{Hola|Buenas|Qué tal} {{nombre}}!&#10;&#10;Ya está abierta la agenda…"></textarea>
        <div class="hint">
          <b>Variantes:</b> <code>{Hola|Buenas|Qué tal}</code> elige una al azar en cada envío.<br>
          <b>Variables:</b> <code>{{nombre}}</code> <code>{{saludo}}</code> <code>{{ciudad}}</code>
          <code>{{provincia}}</code> <code>{{cierre}}</code>
        </div>
      </div>

      <div class="field">
        <div class="spread">
          <label class="label">Vista previa</label>
          <button class="btn btn-sm" id="d-preview">Generar 3 variantes</button>
        </div>
        <div id="d-variantes" class="col" style="gap:8px"></div>
      </div>

      <hr style="border:0;border-top:1px solid var(--line)">

      <div class="field">
        <label class="label">A quién le llega</label>
        <div class="row wrap" style="gap:7px" id="d-zonas">${opcionesZona || '<span class="dim small">Sincronizá tus chats para ver las zonas</span>'}</div>
        <div class="hint">Sin seleccionar ninguna zona, se envía a todos tus contactos.</div>
      </div>

      <div class="grid-2">
        <div class="field">
          <label class="label">Quién habló último</label>
          <select class="select" id="d-quien">
            <option value="">Cualquiera</option>
            <option value="cliente"${prefill.quien === "cliente" ? " selected" : ""}>Habló el cliente</option>
            <option value="yo"${prefill.quien === "yo" ? " selected" : ""}>Hablé yo (sin respuesta)</option>
            <option value="ninguno"${prefill.quien === "ninguno" ? " selected" : ""}>Sin mensajes</option>
          </select>
        </div>
        <div class="field">
          <label class="label">Solo contactos fríos (días sin respuesta)</label>
          <input class="input" id="d-frios" type="number" min="0" value="${prefill.frios || 0}">
          <div class="hint">0 = sin filtro de tiempo. Sirve para reactivar clientes dormidos.</div>
        </div>
      </div>

      ${prefill.tag ? `<div class="field">
        <label class="label">Etiqueta</label>
        <div class="row"><span class="chip chip-purple">${esc(prefill.tag)}</span>
        <span class="tiny dim">solo se envía a los chats con esta etiqueta</span></div>
      </div>` : ""}

      <div class="grid-2">
        <label class="switch"><input type="checkbox" id="d-solo-respondieron"><span class="track"></span>
          <span class="small">Solo a quienes ya me escribieron</span></label>
        <label class="switch"><input type="checkbox" id="d-excluir-recientes" checked><span class="track"></span>
          <span class="small">Excluir contactados hace poco</span></label>
      </div>

      <div class="grid-3">
        <div class="field">
          <label class="label">Máximo de contactos</label>
          <input class="input" id="d-limite" type="number" min="1" value="500">
        </div>
        <div class="field">
          <label class="label">No repetir antes de (días)</label>
          <input class="input" id="d-cooldown" type="number" min="0" value="${defaults.cooldownDias}">
        </div>
        <div class="field">
          <label class="label">Variación de sinónimos</label>
          <select class="select" id="d-sinonimos">
            <option value="0">Sin cambios</option>
            <option value="0.2">Suave</option>
            <option value="0.35" selected>Media (recomendada)</option>
            <option value="0.6">Alta</option>
          </select>
        </div>
      </div>

      <div class="panel col" style="padding:14px;gap:13px">
        <div class="h3">Ritmo de envío <span class="tiny dim">— así se evita el baneo</span></div>
        <div class="grid-2">
          <div class="field">
            <label class="label">Espera entre mensajes (segundos)</label>
            <div class="row">
              <input class="input" id="d-delay-min" type="number" min="5" value="${defaults.delayMinMs / 1000}">
              <span class="dim">a</span>
              <input class="input" id="d-delay-max" type="number" min="10" value="${defaults.delayMaxMs / 1000}">
            </div>
          </div>
          <div class="field">
            <label class="label">Pausa entre bloques (minutos)</label>
            <div class="row">
              <input class="input" id="d-bloque-min" type="number" min="1" value="${defaults.bloqueDelayMinMs / 60000}">
              <span class="dim">a</span>
              <input class="input" id="d-bloque-max" type="number" min="1" value="${defaults.bloqueDelayMaxMs / 60000}">
            </div>
          </div>
        </div>
        <div class="grid-3">
          <div class="field">
            <label class="label">Mensajes por bloque</label>
            <input class="input" id="d-bloque" type="number" min="5" value="${defaults.bloqueTamano}">
          </div>
          <div class="field">
            <label class="label">Enviar desde</label>
            <input class="input" id="d-hora-inicio" type="time" value="${defaults.ventana.inicio}">
          </div>
          <div class="field">
            <label class="label">Hasta</label>
            <input class="input" id="d-hora-fin" type="time" value="${defaults.ventana.fin}">
          </div>
        </div>
        <label class="switch"><input type="checkbox" id="d-ia"><span class="track"></span>
          <span class="small">Reescribir cada mensaje con IA (requiere OpenAI configurado)</span></label>
      </div>

      <div class="panel row" style="padding:13px;gap:12px">
        <div class="grow">
          <div class="small" id="d-audiencia">Calculá a cuántos contactos les va a llegar.</div>
          <div class="tiny dim" id="d-duracion"></div>
        </div>
        <button class="btn btn-sm" id="d-calcular">Calcular</button>
      </div>

      <div id="d-error" class="small hidden" style="color:#fda4af"></div>
    </div>

    <div class="modal-foot">
      <button class="btn" data-cerrar>Cancelar</button>
      <button class="btn" id="d-guardar">Guardar borrador</button>
      <button class="btn btn-primary" id="d-lanzar">Crear e iniciar</button>
    </div>`, { ancho: "modal-lg" })

  const q = sel => overlay.querySelector(sel)

  q("#d-tpl")?.addEventListener("change", e => {
    const t = tpls.find(x => String(x.id) === e.target.value)
    if (t) q("#d-mensaje").value = t.body
  })

  q("#d-preview").addEventListener("click", async () => {
    const mensaje = q("#d-mensaje").value.trim()
    if (!mensaje) return toast("Escribí el mensaje primero", "warn")
    try {
      const r = await API.post(u("/campaigns/preview"), { mensaje, cantidad: 3 })
      q("#d-variantes").innerHTML = r.variantes.map(v => '<div class="variant">' + esc(v) + "</div>").join("")
    } catch (e) { toast(e.message, "error") }
  })

  function armarPayload() {
    const areas = [...overlay.querySelectorAll(".zona-check:checked")].map(c => c.value)
    return {
      nombre:  q("#d-nombre").value.trim(),
      mensaje: q("#d-mensaje").value.trim(),
      filtros: {
        areas,
        quien:            q("#d-quien").value,
        friosDias:        parseInt(q("#d-frios").value, 10) || 0,
        tag:              prefill.tag || "",
        soloConRespuesta: q("#d-solo-respondieron").checked,
        excluirRecientes: q("#d-excluir-recientes").checked,
        limite: parseInt(q("#d-limite").value, 10) || 500
      },
      settings: {
        delayMinMs:       (parseInt(q("#d-delay-min").value, 10)  || 20)  * 1000,
        delayMaxMs:       (parseInt(q("#d-delay-max").value, 10)  || 300) * 1000,
        bloqueTamano:      parseInt(q("#d-bloque").value, 10)      || 25,
        bloqueDelayMinMs: (parseInt(q("#d-bloque-min").value, 10) || 2)   * 60000,
        bloqueDelayMaxMs: (parseInt(q("#d-bloque-max").value, 10) || 5)   * 60000,
        ventana: { inicio: q("#d-hora-inicio").value, fin: q("#d-hora-fin").value, dias: [0,1,2,3,4,5,6] },
        sinonimos:    parseFloat(q("#d-sinonimos").value),
        usarIA:       q("#d-ia").checked,
        cooldownDias: parseInt(q("#d-cooldown").value, 10) || 0
      }
    }
  }

  q("#d-calcular").addEventListener("click", async () => {
    const p = armarPayload()
    try {
      const r = await API.post(u("/campaigns/audience"), { filtros: p.filtros, settings: p.settings })
      const detalle = r.porZona.slice(0, 5).map(z => z.zona + " (" + z.total + ")").join(" · ")
      q("#d-audiencia").innerHTML = "<b>" + nEsp(r.total) + "</b> contactos" + (detalle ? ' <span class="dim">— ' + esc(detalle) + "</span>" : "")

      const promedio = (p.settings.delayMinMs + p.settings.delayMaxMs) / 2
      const bloques  = Math.floor(r.total / p.settings.bloqueTamano)
      const total    = r.total * promedio + bloques * (p.settings.bloqueDelayMinMs + p.settings.bloqueDelayMaxMs) / 2
      q("#d-duracion").textContent = "Tiempo estimado de envío: ~" + msALegible(total) +
        " (solo dentro de la ventana horaria)"
    } catch (e) { toast(e.message, "error") }
  })

  async function crear(iniciar) {
    const err = q("#d-error")
    err.classList.add("hidden")
    const payload = { ...armarPayload(), iniciar, sessionId: sesionesWa[0]?.id }

    if (!payload.nombre)  { err.textContent = "Ponele un nombre a la difusión"; err.classList.remove("hidden"); return }
    if (!payload.mensaje) { err.textContent = "El mensaje no puede estar vacío";  err.classList.remove("hidden"); return }

    try {
      const c = await API.post(u("/campaigns"), payload)
      cerrar()
      toast(c.avisoInicio ? "Difusión creada. " + c.avisoInicio : (iniciar ? "Difusión iniciada" : "Borrador guardado"),
            c.avisoInicio ? "warn" : "ok")
      cargarDifusiones()
    } catch (e) {
      err.textContent = e.message
      err.classList.remove("hidden")
    }
  }

  q("#d-guardar").addEventListener("click", () => crear(false))
  q("#d-lanzar").addEventListener("click",  () => crear(true))
}

/* ============================================================
   PLANTILLAS
   ============================================================ */
async function cargarPlantillas() {
  try {
    plantillas = await API.get(u("/campaigns/templates/list"))
    $("#lista-plantillas").innerHTML = plantillas.length
      ? plantillas.map(t => `<div class="card col" style="gap:10px">
          <div class="spread">
            <div style="font-weight:640">${esc(t.name)}</div>
            <button class="btn btn-sm btn-danger" data-del-tpl="${t.id}">🗑</button>
          </div>
          <div class="variant">${esc(t.body)}</div>
        </div>`).join("")
      : '<div class="card muted">Todavía no tenés plantillas guardadas.</div>'

    $$("[data-del-tpl]").forEach(b => b.addEventListener("click", async () => {
      if (!await confirmar("Eliminar esta plantilla?", "Eliminar")) return
      await API.del(u("/campaigns/templates/" + b.dataset.delTpl))
      cargarPlantillas()
    }))
  } catch (e) { toast(e.message, "error") }
}

$("#btn-nueva-plantilla").addEventListener("click", () => {
  const { overlay, cerrar } = abrirModal(`
    <div class="modal-head">
      <div class="h2">Nueva plantilla</div>
      <button class="btn btn-ghost btn-sm" data-cerrar>✕</button>
    </div>
    <div class="modal-body">
      <div class="field">
        <label class="label">Nombre</label>
        <input class="input" id="t-nombre" placeholder="Promo de temporada">
      </div>
      <div class="field">
        <label class="label">Mensaje</label>
        <textarea class="textarea" id="t-body" placeholder="{Hola|Buenas} {{nombre}}! …"></textarea>
        <div class="hint">Usá <code>{opcion a|opcion b}</code> para variantes y <code>{{nombre}}</code> para personalizar.</div>
      </div>
    </div>
    <div class="modal-foot">
      <button class="btn" data-cerrar>Cancelar</button>
      <button class="btn btn-primary" id="t-guardar">Guardar</button>
    </div>`)

  overlay.querySelector("#t-guardar").addEventListener("click", async () => {
    try {
      await API.post(u("/campaigns/templates"), {
        name: overlay.querySelector("#t-nombre").value.trim() || "Sin nombre",
        body: overlay.querySelector("#t-body").value
      })
      cerrar()
      toast("Plantilla guardada")
      cargarPlantillas()
    } catch (e) { toast(e.message, "error") }
  })
})

/* ============================================================
   AJUSTES
   ============================================================ */
$("#btn-pw").addEventListener("click", async () => {
  try {
    await API.post("/auth/password", { actual: $("#pw-actual").value, nueva: $("#pw-nueva").value })
    $("#pw-actual").value = ""; $("#pw-nueva").value = ""
    toast("Contraseña actualizada")
  } catch (e) { toast(e.message, "error") }
})
