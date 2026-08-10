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
  actualizarVisibilidadBusqueda()
  await Promise.all([cargarSesionesWa(), cargarZonas(), cargarTags(), cargarRapidas(), cargarChats()])
  pintarPlan()
  avisarSeguimientos()
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
  socket.on("chats:sync-progress", p => {
    const b = $("#btn-sync")
    b.textContent = Math.round(p.procesados / (p.total || 1) * 100) + "%"
    b.title = "Sincronizando " + nEsp(p.procesados) + " de " + nEsp(p.total)
  })
  socket.on("chats:synced", r => {
    const b = $("#btn-sync")
    b.textContent = "⟳"; b.title = "Traer los chats desde WhatsApp"; b.disabled = false
    toast("Sincronizados " + nEsp(r.guardados) + " chats" + (r.tramos > 1 ? " en " + r.tramos + " tramos" : ""))
    cargarChats(); cargarZonas()
  })
}

/* ============================================================
   NAVEGACIÓN
   ============================================================ */
const VISTAS = ["chats", "difusiones", "estados", "plantillas", "rapidas", "conexion", "ajustes"]

const TITULOS = {
  chats: "Chats", difusiones: "Difusiones", estados: "Estados",
  plantillas: "Plantillas", rapidas: "Respuestas rápidas",
  conexion: "Conexión", ajustes: "Ajustes"
}

/** Único punto de entrada para cambiar de sección (menú lateral y barra inferior). */
function irAVista(vista) {
  if (!VISTAS.includes(vista)) return

  $$(".nav-item").forEach(i => i.classList.toggle("active", i.dataset.vista === vista))
  $$("#nav-inferior button").forEach(b => b.classList.toggle("activo", b.dataset.vista === vista))
  VISTAS.forEach(v => $("#vista-" + v).classList.toggle("hidden", v !== vista))

  const titulo = $("#titulo-movil")
  if (titulo) titulo.textContent = TITULOS[vista] || "CRM"

  cerrarCajon()
  // Salir de la conversación al cambiar de sección en celular
  if (vista !== "chats") document.body.classList.remove("chat-abierto")

  if (vista === "difusiones") cargarDifusiones()
  if (vista === "plantillas") cargarPlantillas()
  if (vista === "conexion")   cargarSesionesWa()
  if (vista === "estados")    cargarEstados()
  if (vista === "rapidas")    cargarRapidasAdmin()
}

$$(".nav-item").forEach(item =>
  item.addEventListener("click", () => irAVista(item.dataset.vista)))

$$("#nav-inferior button[data-vista]").forEach(b =>
  b.addEventListener("click", () => irAVista(b.dataset.vista)))

/* ---------------- Cajón lateral (celular) ---------------- */
function abrirCajon() {
  $("#rail").classList.add("open")
  $("#rail-fondo").classList.add("visible")
}
function cerrarCajon() {
  $("#rail").classList.remove("open")
  $("#rail-fondo").classList.remove("visible")
}

$("#abrir-menu").addEventListener("click", abrirCajon)
$("#mas-opciones").addEventListener("click", abrirCajon)
$("#rail-fondo").addEventListener("click", cerrarCajon)

// Escape cierra el cajón; y con el chat abierto en celular, vuelve a la lista.
document.addEventListener("keydown", e => {
  if (e.key !== "Escape") return
  if ($("#rail").classList.contains("open")) { cerrarCajon(); return }
  if (esMovil() && document.body.classList.contains("chat-abierto")) volverALaLista()
})

function esMovil() { return window.innerWidth <= 860 }

/* El botón físico "atrás" del celular cierra la conversación en vez de
   sacarte de la aplicación. */
window.addEventListener("popstate", () => {
  if (document.body.classList.contains("chat-abierto")) volverALaLista(false)
})

function volverALaLista(retroceder = true) {
  document.body.classList.remove("chat-abierto")
  if (retroceder && history.state?.chat) history.back()
}

$("#logout").addEventListener("click", cerrarSesion)

/* ============================================================
   RESUMEN / CONTADORES
   ============================================================ */
async function refrescarResumen() {
  try {
    const r = await API.get(u("/chats/resumen"))
    $("#cnt-noleidos").innerHTML = r.no_leidos > 0 ? '<span class="badge">' + r.no_leidos + "</span>" : ""

    // Mismo contador en la burbuja de la barra inferior (celular)
    const punto = $("#punto-chats")
    if (punto) {
      punto.textContent = r.no_leidos > 99 ? "99+" : String(r.no_leidos || "")
      punto.classList.toggle("visible", r.no_leidos > 0)
    }
  } catch (_) {}
}

/** Avisa al entrar si hay seguimientos vencidos. */
async function avisarSeguimientos() {
  try {
    const pendientes = await API.get(u("/chats/seguimientos"))
    if (!pendientes.length) return

    toast("⏰ Tenés " + pendientes.length + " seguimiento(s) para hoy", "warn", 7000)
    const nombres = pendientes.slice(0, 8)
      .map(p => "· " + (p.name || p.push_name || p.phone)).join("\n")
    console.info("Seguimientos pendientes:\n" + nombres)
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
let mapaAreas = {}   // "223" -> "Mar del Plata", para traducir códigos en la UI

async function cargarZonas() {
  try {
    const { areas, paises } = await API.get(u("/chats/zonas"))
    mapaAreas = Object.fromEntries(areas.map(a => [a.area_code, a.region]))

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
  actualizarVisibilidadBusqueda()
  clearTimeout(timerBusqueda)
  // Buscar dentro de los mensajes es más caro: damos un poco más de aire.
  timerBusqueda = setTimeout(cargarChats, busquedaTecleada.length >= 3 ? 420 : 280)
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

$$("#filtro-zona, #filtro-orden, #filtro-quien, #filtro-frios, #solo-noleidos, #buscar-en-mensajes")
  .forEach(el => el.addEventListener("change", cargarChats))

// El toggle de búsqueda en mensajes solo tiene sentido si hay algo escrito.
function actualizarVisibilidadBusqueda() {
  $("#fila-en-mensajes").classList.toggle("hidden", busquedaTecleada.trim().length < 3)
}

$("#btn-limpiar").addEventListener("click", () => {
  busquedaTecleada = ""
  $("#buscar").value = ""
  $("#filtro-zona").value = ""
  $("#filtro-quien").value = ""
  $("#filtro-frios").value = ""
  $("#filtro-orden").value = "reciente"
  $("#solo-noleidos").checked = false
  tagActivo = ""
  actualizarVisibilidadBusqueda()
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

async function sincronizarAhora(boton) {
  const sesionWa = sesionesWa[0]
  if (!sesionWa) return toast("Primero conectá WhatsApp", "warn")

  const original = boton.textContent
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
    boton.textContent = original
  }
}

$("#btn-sync").addEventListener("click", e => sincronizarAhora(e.currentTarget))
$("#btn-sync-movil").addEventListener("click", e => sincronizarAhora(e.currentTarget))

/** Lee el estado actual de todos los filtros de la pantalla. */
function filtrosActuales() {
  const zona = $("#filtro-zona").value
  return {
    // A propósito NO se lee $("#buscar").value: el navegador puede escribir
    // ahí lo que quiera (autocompletado). Solo vale lo que se tecleó.
    q:          busquedaTecleada.trim(),
    orden:      $("#filtro-orden").value,
    quien:      $("#filtro-quien").value,
    frios:      $("#filtro-frios").value,
    tag:        tagActivo,
    noleidos:   $("#solo-noleidos").checked ? "1" : "",
    enmensajes: $("#buscar-en-mensajes").checked ? "" : "0",   // "" = por defecto (activado)
    area:       zona.startsWith("area:") ? zona.slice(5) : "",
    pais:       zona.startsWith("pais:") ? zona.slice(5) : ""
  }
}

function hayFiltrosActivos() {
  const f = filtrosActuales()
  return !!(f.q || f.quien || f.frios || f.tag || f.noleidos || f.area || f.pais)
}

const PAGINA_CHATS = 60
let hayMasChats  = false
let cargandoMas  = false
let renderizados = 0

/**
 * @param append true = agrega la página siguiente al final (scroll infinito)
 */
async function cargarChats({ append = false } = {}) {
  limpiarAutocompletado()

  if (append && (cargandoMas || !hayMasChats)) return

  const f = filtrosActuales()
  const params = new URLSearchParams({
    limit:  String(PAGINA_CHATS),
    offset: String(append ? chats.length : 0)
  })
  for (const [k, v] of Object.entries(f)) if (v) params.set(k, v)

  // Solo las cargas nuevas invalidan a las anteriores; las de scroll continúan.
  const mia = append ? cargaSeq : ++cargaSeq
  if (append) { cargandoMas = true; mostrarCargandoMas(true) }

  try {
    const r = await API.get(u("/chats?" + params.toString()))
    // Si mientras esperábamos salió otra consulta, esta respuesta ya no sirve:
    // pintarla haría "parpadear" la lista con datos viejos.
    if (mia !== cargaSeq) return

    const lista   = r.chats || []
    chats         = append ? chats.concat(lista) : lista
    totalFiltrado = r.total || 0
    hayMasChats   = chats.length < totalFiltrado

    pintarChats({ append })
  } catch (e) {
    if (mia === cargaSeq) toast(e.message, "error")
  } finally {
    cargandoMas = false
    mostrarCargandoMas(false)
  }
}

function mostrarCargandoMas(visible) {
  let el = $("#cargando-mas")
  if (!visible) { el?.remove(); return }
  if (el) return
  el = document.createElement("div")
  el.id = "cargando-mas"
  el.className = "tiny dim"
  el.style.cssText = "padding:14px;text-align:center"
  el.textContent = "Cargando más chats…"
  $("#chatlist-body").appendChild(el)
}

function filaChat(c) {
  const nombre = c.display_name
  const activo = chatActivo && chatActivo.id === c.id
  const tags   = (c.tags || []).map(t => '<span class="chip tiny">' + esc(t) + "</span>").join("")

  // "Te escribió hace X" es el dato que más se mira para decidir a quién retomar.
  const ultimaResp = c.last_inbound_at
    ? "responde " + haceCuanto(c.last_inbound_at)
    : "nunca respondió"

  return `<div class="chat-item ${activo ? "active" : ""} ${estaSeleccionado(c.id) ? "sel" : ""}" data-chat="${c.id}">
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
}

function pintarChats({ append = false } = {}) {
  const cont = $("#chatlist-body")
  const filtrando = hayFiltrosActivos()

  $("#chatlist-total").textContent = totalFiltrado
    ? (chats.length < totalFiltrado
        ? nEsp(chats.length) + " de " + nEsp(totalFiltrado)
        : nEsp(totalFiltrado) + " chats")
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
             <button class="btn btn-sm" style="margin-top:14px" data-accion="limpiar">Limpiar filtros</button>
           </div></div>`
      : `<div class="empty" style="padding:50px 24px">
           <div>
             <div class="ico">📭</div>
             <div class="h3">No hay conversaciones</div>
             <div class="muted small" style="margin-top:6px">Conectá WhatsApp y tocá ⟳ para traer tus chats.</div>
           </div></div>`
    renderizados = 0
    return
  }

  if (append && renderizados && renderizados < chats.length) {
    // Solo agregamos lo nuevo: repintar todo perdería la posición del scroll.
    cont.insertAdjacentHTML("beforeend", chats.slice(renderizados).map(filaChat).join(""))
  } else {
    cont.innerHTML = chats.map(filaChat).join("")
    if (!append) cont.scrollTop = 0
  }
  renderizados = chats.length
}

/* ============================================================
   SELECCIÓN MÚLTIPLE
   Click = abrir · Ctrl/⌘+click = alternar · Shift+click = rango
   ============================================================ */
const seleccion = new Set()
let ultimoClickado = null

function estaSeleccionado(id) { return seleccion.has(id) }

function alternarSeleccion(id) {
  if (seleccion.has(id)) seleccion.delete(id)
  else seleccion.add(id)
  refrescarSeleccion()
}

function seleccionarRango(hasta) {
  const desde = ultimoClickado
  if (desde === null) { alternarSeleccion(hasta); return }

  const i1 = chats.findIndex(c => c.id === desde)
  const i2 = chats.findIndex(c => c.id === hasta)
  if (i1 < 0 || i2 < 0) { alternarSeleccion(hasta); return }

  for (let i = Math.min(i1, i2); i <= Math.max(i1, i2); i++) seleccion.add(chats[i].id)
  refrescarSeleccion()
}

function limpiarSeleccion() {
  seleccion.clear()
  ultimoClickado = null
  refrescarSeleccion()
}

/** Pinta el estado de selección sin repintar la lista entera. */
function refrescarSeleccion() {
  const hay = seleccion.size > 0
  $("#barra-seleccion").classList.toggle("hidden", !hay)
  $("#chatlist-body").classList.toggle("seleccionando", hay)
  $("#sel-contador").textContent = seleccion.size + (seleccion.size === 1 ? " seleccionado" : " seleccionados")

  $$("#chatlist-body .chat-item").forEach(el => {
    el.classList.toggle("sel", seleccion.has(Number(el.dataset.chat)))
  })
}

// Delegación: un solo listener para toda la lista, así el scroll infinito
// puede agregar filas sin volver a enganchar eventos (ni duplicarlos).
$("#chatlist-body").addEventListener("click", async e => {
  const limpiar = e.target.closest('[data-accion="limpiar"]')
  if (limpiar) { $("#btn-limpiar").click(); return }

  const pin = e.target.closest("[data-pin]")
  if (pin) {
    e.stopPropagation()
    const id = Number(pin.dataset.pin)
    const actual = chats.find(c => c.id === id)
    try {
      await API.patch(u("/chats/" + id), { pinned: !actual.pinned })
      cargarChats()
    } catch (err) { toast(err.message, "error") }
    return
  }

  const item = e.target.closest("[data-chat]")
  if (!item) return
  const id = Number(item.dataset.chat)

  if (e.shiftKey)               { e.preventDefault(); seleccionarRango(id); return }
  if (e.ctrlKey || e.metaKey)   { e.preventDefault(); alternarSeleccion(id); ultimoClickado = id; return }

  // Con una selección abierta, el click simple sigue seleccionando:
  // así no hay que mantener Ctrl para el tercero, cuarto, etc.
  if (seleccion.size) { alternarSeleccion(id); ultimoClickado = id; return }

  ultimoClickado = id
  abrirChat(id)
})

$("#sel-cancelar").addEventListener("click", limpiarSeleccion)

$("#sel-todos").addEventListener("click", async () => {
  const boton = $("#sel-todos")
  boton.disabled = true
  try {
    const params = new URLSearchParams({ tope: "20000" })
    for (const [k, v] of Object.entries(filtrosActuales())) if (v) params.set(k, v)

    // Los ids salen del servidor: la selección abarca TODO lo filtrado,
    // no solo los chats que se alcanzaron a bajar con el scroll.
    const r = await API.get(u("/chats/ids?" + params.toString()))
    r.ids.forEach(id => seleccion.add(Number(id)))
    refrescarSeleccion()

    if (r.truncado) {
      toast("Seleccionados " + nEsp(r.ids.length) + " de " + nEsp(r.total) +
            " (tope por seguridad). Afiná los filtros para trabajar por tandas.", "warn", 7000)
    } else {
      toast(nEsp(seleccion.size) + " chats seleccionados")
    }
  } catch (e) {
    toast(e.message, "error")
  } finally {
    boton.disabled = false
  }
})

$("#sel-acciones").addEventListener("click", e => {
  const ids = [...seleccion]
  menuFlotante(e.currentTarget, [
    { titulo: ids.length + " chats seleccionados" },
    { icono: "🏷", texto: "Agregar etiqueta",      accion: () => masivoEtiquetar(ids, true) },
    { icono: "🧹", texto: "Quitar etiqueta",       accion: () => masivoEtiquetar(ids, false) },
    { separador: true },
    { icono: "✓✓", texto: "Marcar como leídos",    accion: () => masivo(ids, "leer") },
    { icono: "📌", texto: "Fijar",                 accion: () => masivo(ids, "fijar") },
    { icono: "📥", texto: "Archivar",              accion: () => masivo(ids, "archivar") },
    { icono: "📤", texto: "Desarchivar",           accion: () => masivo(ids, "desarchivar") },
    { separador: true },
    { icono: "🔖", texto: "Cambiar estado",        accion: () => masivoEstado(ids) },
    { icono: "⏰", texto: "Programar seguimiento", accion: () => masivoSeguimiento(ids) },
    { separador: true },
    { icono: "📣", texto: "Difundir a estos",      accion: () => difundirSeleccion(ids) },
    { icono: "⭳",  texto: "Exportar a CSV",        accion: () => exportarCsv(ids) }
  ])
})

async function masivo(ids, accion, valor) {
  try {
    const r = await API.post(u("/chats/masivo"), { ids, accion, valor })
    toast(r.afectados + " chats actualizados")
    limpiarSeleccion()
    cargarChats(); cargarTags(); refrescarResumen()
  } catch (e) { toast(e.message, "error") }
}

async function masivoEtiquetar(ids, agregar) {
  const existentes = await API.get(u("/chats/tags")).catch(() => [])
  const sugeridas = existentes.map(t =>
    `<span class="chip" data-tag="${esc(t.tag)}" style="cursor:pointer">${esc(t.tag)}</span>`).join(" ")

  const { overlay, cerrar } = abrirModal(`
    <div class="modal-head">
      <div class="h2">${agregar ? "Agregar" : "Quitar"} etiqueta</div>
      <button class="btn btn-ghost btn-sm" data-cerrar>✕</button>
    </div>
    <div class="modal-body">
      <div class="muted small">Se aplica a ${ids.length} chats.</div>
      <div class="field">
        <label class="label">Etiqueta</label>
        <input class="input" id="m-tag" maxlength="30" placeholder="cliente frío" autocomplete="off">
      </div>
      ${sugeridas ? '<div class="row wrap" style="gap:6px">' + sugeridas + "</div>" : ""}
    </div>
    <div class="modal-foot">
      <button class="btn" data-cerrar>Cancelar</button>
      <button class="btn btn-primary" id="m-ok">Aplicar</button>
    </div>`)

  const aplicar = valor => {
    if (!String(valor || "").trim()) return
    cerrar()
    masivo(ids, agregar ? "etiquetar" : "desetiquetar", valor.trim())
  }
  overlay.querySelector("#m-ok").addEventListener("click", () => aplicar(overlay.querySelector("#m-tag").value))
  overlay.querySelectorAll("[data-tag]").forEach(el =>
    el.addEventListener("click", () => aplicar(el.dataset.tag)))
}

function masivoEstado(ids) {
  const { overlay, cerrar } = abrirModal(`
    <div class="modal-head"><div class="h2">Cambiar estado</div>
      <button class="btn btn-ghost btn-sm" data-cerrar>✕</button></div>
    <div class="modal-body">
      <div class="muted small">Se aplica a ${ids.length} chats.</div>
      <div class="row" style="gap:8px">
        ${["abierto", "pendiente", "cerrado"].map(s =>
          `<button class="btn grow" data-estado="${s}">${s}</button>`).join("")}
      </div>
    </div>`)
  overlay.querySelectorAll("[data-estado]").forEach(b => b.addEventListener("click", () => {
    cerrar(); masivo(ids, "estado", b.dataset.estado)
  }))
}

function masivoSeguimiento(ids) {
  const opciones = [["Mañana", 1], ["En 3 días", 3], ["En 1 semana", 7], ["En 15 días", 15], ["En 30 días", 30]]
  const { overlay, cerrar } = abrirModal(`
    <div class="modal-head"><div class="h2">Programar seguimiento</div>
      <button class="btn btn-ghost btn-sm" data-cerrar>✕</button></div>
    <div class="modal-body">
      <div class="muted small">Te va a aparecer como pendiente cuando llegue la fecha. Se aplica a ${ids.length} chats.</div>
      <div class="col" style="gap:7px">
        ${opciones.map(([t, d]) => `<button class="btn" data-dias="${d}">${t}</button>`).join("")}
        <button class="btn btn-danger" data-dias="0">Quitar seguimiento</button>
      </div>
    </div>`)

  overlay.querySelectorAll("[data-dias]").forEach(b => b.addEventListener("click", () => {
    const dias = Number(b.dataset.dias)
    cerrar()
    masivo(ids, "seguimiento", dias ? new Date(Date.now() + dias * 86400000).toISOString() : null)
  }))
}

async function difundirSeleccion(ids) {
  try {
    // Difundimos a los JID exactos elegidos, no a un criterio.
    const filas = await API.post(u("/chats/exportar-jids"), { ids }).catch(() => null)
    limpiarSeleccion()
    $$(".nav-item").forEach(i => i.classList.toggle("active", i.dataset.vista === "difusiones"))
    VISTAS.forEach(v => $("#vista-" + v).classList.toggle("hidden", v !== "difusiones"))
    abrirAsistenteDifusion({ jids: filas?.jids || [] })
  } catch (e) { toast(e.message, "error") }
}

async function exportarCsv(ids) {
  try {
    const res = await fetch("/api" + u("/chats/exportar"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(ids?.length ? { ids } : { filtros: filtrosActuales() })
    })
    if (!res.ok) throw new Error("No se pudo exportar")

    const blob = await res.blob()
    const enlace = document.createElement("a")
    enlace.href = URL.createObjectURL(blob)
    enlace.download = "contactos-" + new Date().toISOString().slice(0, 10) + ".csv"
    enlace.click()
    URL.revokeObjectURL(enlace.href)
    toast("CSV descargado")
  } catch (e) { toast(e.message, "error") }
}

$("#btn-exportar").addEventListener("click", () => exportarCsv([...seleccion]))

// Scroll infinito: al acercarse al final, pide el tramo siguiente.
$("#chatlist-body").addEventListener("scroll", e => {
  const el = e.target
  if (el.scrollTop + el.clientHeight >= el.scrollHeight - 320) {
    cargarChats({ append: true })
  }
}, { passive: true })

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

    // En celular la conversación reemplaza a la lista (un panel por vez).
    if (esMovil()) {
      document.body.classList.add("chat-abierto")
      // Entrada en el historial para que el botón "atrás" vuelva a la lista.
      if (!history.state?.chat) history.pushState({ chat: chatId }, "")
    }
  } catch (e) { toast(e.message, "error") }
}

let mensajesCargados = []

function pintarMensajes(mensajes) {
  mensajesCargados = mensajes
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

/** Bloque multimedia de una burbuja (imagen, video, audio o documento). */
function bloqueMedia(m) {
  const esMedia = ["image", "video", "audio", "ptt", "document", "sticker"].includes(m.type)
  if (!esMedia) return ""

  // Todavía no lo bajamos de WhatsApp: se descarga al tocarlo.
  if (!m.media_url) {
    const ICONOS = { image: "📷", video: "🎥", audio: "🎤", ptt: "🎤", document: "📄", sticker: "🩹" }
    return `<button class="doc" data-descargar="${m.id}" style="border:0;width:100%;cursor:pointer">
              <span class="ico">${ICONOS[m.type] || "📎"}</span>
              <span class="grow" style="text-align:left">
                <div style="font-size:12.5px">${esc(m.media_name || "Archivo")}</div>
                <div class="tiny dim">Tocá para descargar</div>
              </span>
            </button>`
  }

  const url = m.media_url
  if (m.type === "image" || m.type === "sticker") {
    return `<div class="media"><img src="${esc(url)}" loading="lazy" data-ver="${esc(url)}" alt=""></div>`
  }
  if (m.type === "video") {
    return `<div class="media"><video src="${esc(url)}" controls preload="metadata"></video></div>`
  }
  if (m.type === "audio" || m.type === "ptt") {
    return `<div class="media"><audio src="${esc(url)}" controls preload="none"></audio></div>`
  }
  return `<a class="doc" href="${esc(url)}?descargar=1&nombre=${encodeURIComponent(m.media_name || "archivo")}" target="_blank" rel="noopener">
            <span class="ico">📄</span>
            <span class="grow">
              <div style="font-size:12.5px">${esc(m.media_name || "Documento")}</div>
              <div class="tiny dim">Descargar</div>
            </span>
          </a>`
}

function burbuja(m) {
  if (m.deleted) {
    return `<div class="bubble ${m.direction === "out" ? "out" : "in"} borrado">
              🚫 Mensaje eliminado
              <div class="stamp">${esc(horaCorta(m.sent_at))}</div>
            </div>`
  }

  const marca = m.direction === "out"
    ? '<span title="' + esc(m.status || "") + '">' +
      (m.status === "read" ? "✓✓" : m.status === "delivered" ? "✓✓" : "✓") + "</span>"
    : ""
  const autor = m.direction === "out" && m.author
    ? '<div class="author">' + esc(m.author) + "</div>" : ""
  const citado = m.quoted_id
    ? '<div class="citado">' + esc(textoDeMensaje(m.quoted_id) || "Mensaje citado") + "</div>" : ""
  const reaccion = m.reaction
    ? '<span class="reaccion">' + esc(m.reaction) + "</span>" : ""
  const estrella = m.starred ? " ⭐" : ""

  return `<div class="bubble ${m.direction === "out" ? "out" : "in"}"
               data-msg="${esc(m.wa_msg_id || "")}" data-id="${m.id}">
    <button class="acciones" data-menu-msg="${m.id}" title="Acciones">⋮</button>
    ${autor}${citado}${bloqueMedia(m)}
    ${m.body ? "<div>" + formatoWhatsapp(m.body) + "</div>" : ""}
    <div class="stamp">${esc(horaCorta(m.sent_at))}${estrella} ${marca}</div>
    ${reaccion}
  </div>`
}

/** Busca el texto de un mensaje ya cargado, para mostrar la cita. */
function textoDeMensaje(waMsgId) {
  const m = mensajesCargados.find(x => x.wa_msg_id === waMsgId)
  return m ? (m.body || "[" + m.type + "]").slice(0, 120) : null
}

$("#volver-lista").addEventListener("click", () => volverALaLista())

/* ---------------- Acciones sobre un mensaje ---------------- */
$("#conv-body").addEventListener("click", async e => {
  // Descargar un archivo recibido que todavía no bajamos
  const desc = e.target.closest("[data-descargar]")
  if (desc) {
    desc.disabled = true
    try {
      const m = await API.post(u("/chats/" + chatActivo.id + "/mensajes/" + desc.dataset.descargar + "/descargar"))
      const i = mensajesCargados.findIndex(x => x.id === m.id)
      if (i >= 0) { mensajesCargados[i] = m; pintarMensajes(mensajesCargados) }
    } catch (err) { toast(err.message, "error"); desc.disabled = false }
    return
  }

  // Abrir imagen en grande
  const img = e.target.closest("[data-ver]")
  if (img) {
    abrirModal(`<div class="modal-body" style="padding:0">
        <img src="${esc(img.dataset.ver)}" style="width:100%;border-radius:var(--r-lg);display:block">
      </div>`, { ancho: "modal-lg" })
    return
  }

  const btn = e.target.closest("[data-menu-msg]")
  if (btn) menuDeMensaje(btn, Number(btn.dataset.menuMsg))
})

function menuDeMensaje(ancla, msgId) {
  const m = mensajesCargados.find(x => x.id === msgId)
  if (!m) return
  const waId = m.wa_msg_id

  const accion = async (accion, extra = {}) => {
    try {
      await API.post(u("/chats/" + chatActivo.id + "/mensajes/accion"), { accion, waMsgId: waId, ...extra })
      abrirChat(chatActivo.id)
    } catch (e) { toast(e.message, "error") }
  }

  const items = [
    { icono: "↩", texto: "Responder", accion: () => activarRespuesta(m) },
    { icono: "😀", texto: "Reaccionar", accion: () => elegirReaccion(waId) },
    { icono: "📋", texto: "Copiar texto", accion: () => {
        navigator.clipboard.writeText(m.body || "").then(() => toast("Copiado"))
      } },
    { icono: "➡", texto: "Reenviar a…", accion: () => elegirDestinoReenvio(waId) },
    { icono: m.starred ? "☆" : "⭐", texto: m.starred ? "Quitar destacado" : "Destacar",
      accion: () => accion("destacar", { valor: !m.starred }) }
  ]

  if (m.direction === "out") {
    items.push({ separador: true })
    items.push({ icono: "✏", texto: "Editar", accion: () => editarMensaje(m) })
  }

  items.push({ separador: true })
  items.push({ icono: "🗑", texto: "Eliminar para todos", peligro: true,
               accion: async () => {
                 if (await confirmar("Eliminar este mensaje para todos?", "Eliminar")) accion("eliminar")
               } })

  if (!waId) return toast("Este mensaje no tiene id de WhatsApp", "warn")
  menuFlotante(ancla, items)
}

function elegirReaccion(waId) {
  const EMOJIS = ["👍", "❤️", "😂", "😮", "😢", "🙏", "🔥", "✅"]
  const { overlay, cerrar } = abrirModal(`
    <div class="modal-head"><div class="h2">Reaccionar</div>
      <button class="btn btn-ghost btn-sm" data-cerrar>✕</button></div>
    <div class="modal-body">
      <div class="row wrap" style="gap:10px;font-size:28px">
        ${EMOJIS.map(e2 => `<button class="btn" data-emoji="${e2}" style="font-size:26px;padding:8px 12px">${e2}</button>`).join("")}
      </div>
      <button class="btn btn-sm" data-emoji="">Quitar reacción</button>
    </div>`)

  overlay.querySelectorAll("[data-emoji]").forEach(b => b.addEventListener("click", async () => {
    cerrar()
    try {
      await API.post(u("/chats/" + chatActivo.id + "/mensajes/accion"),
        { accion: "reaccionar", waMsgId: waId, emoji: b.dataset.emoji })
      abrirChat(chatActivo.id)
    } catch (e) { toast(e.message, "error") }
  }))
}

async function elegirDestinoReenvio(waId) {
  const r = await API.get(u("/chats?limit=60"))
  const { overlay, cerrar } = abrirModal(`
    <div class="modal-head"><div class="h2">Reenviar a</div>
      <button class="btn btn-ghost btn-sm" data-cerrar>✕</button></div>
    <div class="modal-body" style="max-height:60vh;overflow-y:auto;padding:0">
      ${(r.chats || []).map(c => `
        <div class="chat-item" data-destino="${c.id}">
          ${avatarHtml(c.display_name, "avatar-sm")}
          <div class="grow truncate">
            <div class="nm truncate">${esc(c.display_name)}</div>
            <div class="tiny dim">${esc(c.phone_pretty)}</div>
          </div>
        </div>`).join("")}
    </div>`)

  overlay.querySelectorAll("[data-destino]").forEach(el => el.addEventListener("click", async () => {
    cerrar()
    try {
      await API.post(u("/chats/" + chatActivo.id + "/mensajes/accion"),
        { accion: "reenviar", waMsgId: waId, destinoChatId: el.dataset.destino })
      toast("Mensaje reenviado")
    } catch (e) { toast(e.message, "error") }
  }))
}

function editarMensaje(m) {
  const { overlay, cerrar } = abrirModal(`
    <div class="modal-head"><div class="h2">Editar mensaje</div>
      <button class="btn btn-ghost btn-sm" data-cerrar>✕</button></div>
    <div class="modal-body">
      <textarea class="textarea" id="ed-texto">${esc(m.body || "")}</textarea>
      <div class="hint">WhatsApp solo permite editar dentro de los primeros 15 minutos.</div>
    </div>
    <div class="modal-foot">
      <button class="btn" data-cerrar>Cancelar</button>
      <button class="btn btn-primary" id="ed-ok">Guardar</button>
    </div>`)

  overlay.querySelector("#ed-ok").addEventListener("click", async () => {
    try {
      await API.post(u("/chats/" + chatActivo.id + "/mensajes/accion"),
        { accion: "editar", waMsgId: m.wa_msg_id, texto: overlay.querySelector("#ed-texto").value })
      cerrar()
      abrirChat(chatActivo.id)
    } catch (e) { toast(e.message, "error") }
  })
}

/* ---------------- Responder citando ---------------- */
let respondiendoA = null

function activarRespuesta(m) {
  respondiendoA = m
  $("#responder-texto").textContent = (m.body || "[" + m.type + "]").slice(0, 120)
  $("#responder-a").classList.remove("hidden")
  $("#composer").focus()
}

$("#responder-cancelar").addEventListener("click", () => {
  respondiendoA = null
  $("#responder-a").classList.add("hidden")
})

/* ---------------- Enviar ---------------- */
const composer = $("#composer")

composer.addEventListener("input", () => {
  composer.style.height = "auto"
  composer.style.height = Math.min(composer.scrollHeight, 170) + "px"
  filtrarRapidas()
})

composer.addEventListener("keydown", e => {
  const abiertas = !$("#lista-rapidas").classList.contains("hidden")

  // Con la lista de respuestas rápidas abierta, las flechas y el Enter
  // navegan la lista en vez de mover el cursor o enviar.
  if (abiertas) {
    const encontradas = filtrarRapidas() || []
    if (e.key === "ArrowDown") { e.preventDefault(); rapidaMarcada = (rapidaMarcada + 1) % encontradas.length; filtrarRapidas(); return }
    if (e.key === "ArrowUp")   { e.preventDefault(); rapidaMarcada = (rapidaMarcada - 1 + encontradas.length) % encontradas.length; filtrarRapidas(); return }
    if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault()
      if (encontradas[rapidaMarcada]) insertarRapida(encontradas[rapidaMarcada])
      return
    }
    if (e.key === "Escape") { $("#lista-rapidas").classList.add("hidden"); return }
  }

  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); enviarMensaje() }
  if (e.key === "Escape" && respondiendoA) $("#responder-cancelar").click()
})

// Pegar una imagen desde el portapapeles la manda como archivo.
composer.addEventListener("paste", e => {
  const archivos = [...(e.clipboardData?.files || [])]
  if (archivos.length && chatActivo) { e.preventDefault(); confirmarEnvioArchivos(archivos) }
})
$("#enviar").addEventListener("click", enviarMensaje)

async function enviarMensaje() {
  const texto = composer.value.trim()
  if (!texto || !chatActivo) return

  const boton = $("#enviar")
  boton.disabled = true
  try {
    let m
    if (respondiendoA?.wa_msg_id) {
      m = await API.post(u("/chats/" + chatActivo.id + "/mensajes/accion"),
        { accion: "responder", waMsgId: respondiendoA.wa_msg_id, texto })
      respondiendoA = null
      $("#responder-a").classList.add("hidden")
    } else {
      m = await API.post(u("/chats/" + chatActivo.id + "/messages"), { texto })
    }

    composer.value = ""
    composer.style.height = "auto"
    if (m) {
      mensajesCargados.push(m)
      $("#conv-body").insertAdjacentHTML("beforeend", burbuja(m))
      $("#conv-body").scrollTop = $("#conv-body").scrollHeight
    }
    recargarChatsPronto(300)
  } catch (e) {
    toast(e.message, "error")
  } finally {
    boton.disabled = false
    composer.focus()
  }
}

/* ============================================================
   ADJUNTOS
   ============================================================ */
$("#btn-adjuntar").addEventListener("click", () => $("#file-input").click())

$("#file-input").addEventListener("change", e => {
  const archivos = [...e.target.files]
  e.target.value = ""                    // permite volver a elegir el mismo archivo
  if (archivos.length) confirmarEnvioArchivos(archivos)
})

// Arrastrar y soltar sobre la conversación
const conv = $("#conv")
let contadorArrastre = 0   // dragenter/dragleave se disparan también en los hijos

conv.addEventListener("dragenter", e => {
  if (!chatActivo || !e.dataTransfer?.types?.includes("Files")) return
  e.preventDefault(); contadorArrastre++
  $("#drop-zona").classList.remove("hidden")
})
conv.addEventListener("dragover", e => { if (chatActivo) e.preventDefault() })
conv.addEventListener("dragleave", () => {
  if (--contadorArrastre <= 0) { contadorArrastre = 0; $("#drop-zona").classList.add("hidden") }
})
conv.addEventListener("drop", e => {
  if (!chatActivo) return
  e.preventDefault()
  contadorArrastre = 0
  $("#drop-zona").classList.add("hidden")
  const archivos = [...(e.dataTransfer?.files || [])]
  if (archivos.length) confirmarEnvioArchivos(archivos)
})

function confirmarEnvioArchivos(archivos) {
  const primero = archivos[0]
  const esImagen = primero.type.startsWith("image/")
  const esAudio  = primero.type.startsWith("audio/")

  const { overlay, cerrar } = abrirModal(`
    <div class="modal-head">
      <div>
        <div class="h2">Enviar ${archivos.length > 1 ? archivos.length + " archivos" : "archivo"}</div>
        <div class="tiny dim truncate">${esc(archivos.map(a => a.name).join(", "))}</div>
      </div>
      <button class="btn btn-ghost btn-sm" data-cerrar>✕</button>
    </div>
    <div class="modal-body">
      <div id="ad-preview"></div>
      <div class="field">
        <label class="label">Mensaje (opcional)</label>
        <input class="input" id="ad-caption" placeholder="Texto que acompaña al archivo" autocomplete="off">
      </div>
      ${esAudio ? `<label class="switch"><input type="checkbox" id="ad-ptt" checked><span class="track"></span>
        <span class="small">Enviar como nota de voz</span></label>` : ""}
      <div class="tiny dim">Tamaño total: ${(archivos.reduce((s, a) => s + a.size, 0) / 1048576).toFixed(1)} MB (máx. 64 MB por archivo)</div>
      <div class="bar hidden" id="ad-bar"><i style="width:0%"></i></div>
    </div>
    <div class="modal-foot">
      <button class="btn" data-cerrar>Cancelar</button>
      <button class="btn btn-primary" id="ad-enviar">Enviar</button>
    </div>`)

  if (esImagen) {
    const url = URL.createObjectURL(primero)
    overlay.querySelector("#ad-preview").innerHTML =
      `<img src="${url}" style="max-width:100%;max-height:240px;border-radius:var(--r);display:block;margin:0 auto">`
  }

  overlay.querySelector("#ad-enviar").addEventListener("click", async () => {
    const boton  = overlay.querySelector("#ad-enviar")
    const barra  = overlay.querySelector("#ad-bar")
    const caption= overlay.querySelector("#ad-caption").value
    const ptt    = overlay.querySelector("#ad-ptt")?.checked

    boton.disabled = true
    barra.classList.remove("hidden")

    let enviados = 0
    for (const archivo of archivos) {
      try {
        await subirArchivo(archivo, caption, ptt)
        enviados++
      } catch (e) {
        toast("Falló " + archivo.name + ": " + e.message, "error")
      }
      barra.querySelector("i").style.width = Math.round(enviados / archivos.length * 100) + "%"
    }

    cerrar()
    if (enviados) {
      toast(enviados + (enviados === 1 ? " archivo enviado" : " archivos enviados"))
      abrirChat(chatActivo.id)
    }
  })
}

function subirArchivo(archivo, caption, notaDeVoz) {
  const datos = new FormData()
  datos.append("archivo", archivo)
  datos.append("caption", caption || "")
  if (notaDeVoz) datos.append("notaDeVoz", "true")
  if (respondiendoA?.wa_msg_id) datos.append("quotedId", respondiendoA.wa_msg_id)

  // FormData no se manda por API.req: fetch tiene que poner el boundary solo.
  return fetch("/api" + u("/chats/" + chatActivo.id + "/archivo"), {
    method: "POST", body: datos, credentials: "same-origin"
  }).then(async res => {
    const j = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(j.error || "Error " + res.status)
    return j
  })
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
   ACCIONES DEL CHAT (se replican en el WhatsApp real)
   ============================================================ */
$("#conv-menu").addEventListener("click", e => {
  if (!chatActivo) return

  const accion = async (accion, extra = {}) => {
    try {
      await API.post(u("/chats/" + chatActivo.id + "/accion"), { accion, ...extra })
      toast("Listo")
      cargarChats()
    } catch (err) { toast(err.message, "error") }
  }

  menuFlotante(e.currentTarget, [
    { titulo: "En WhatsApp" },
    { icono: "📥", texto: chatActivo.archived ? "Desarchivar" : "Archivar",
      accion: () => accion(chatActivo.archived ? "desarchivar" : "archivar") },
    { icono: "🔕", texto: "Silenciar 8 horas",  accion: () => accion("silenciar", { horas: 8 }) },
    { icono: "🔕", texto: "Silenciar 1 semana", accion: () => accion("silenciar", { horas: 168 }) },
    { icono: "🔵", texto: "Marcar como no leído", accion: () => accion("no-leido") },
    { separador: true },
    { titulo: "CRM" },
    { icono: "🗒", texto: "Notas internas",       accion: () => abrirNotas() },
    { icono: "⏰", texto: "Programar seguimiento", accion: () => abrirSeguimiento() },
    { icono: "👤", texto: "Info del contacto",     accion: () => verInfoContacto() },
    { separador: true },
    { icono: "🧹", texto: "Vaciar conversación", peligro: true, accion: async () => {
        if (await confirmar("Se borran todos los mensajes de este chat, también en tu WhatsApp. Los destacados se conservan.", "Vaciar"))
          accion("vaciar")
      } },
    { icono: "⛔", texto: "Bloquear contacto", peligro: true, accion: async () => {
        if (await confirmar("Bloquear a este contacto en WhatsApp?", "Bloquear")) accion("bloquear")
      } },
    { icono: "🗑", texto: "Eliminar chat", peligro: true, accion: async () => {
        if (await confirmar("Se elimina la conversación del CRM y de tu WhatsApp. No se puede deshacer.", "Eliminar")) {
          await accion("eliminar")
          chatActivo = null
          $("#conv-activa").classList.add("hidden")
          $("#conv-vacio").classList.remove("hidden")
        }
      } }
  ])
})

async function verInfoContacto() {
  const { overlay } = abrirModal(`
    <div class="modal-head"><div class="h2">${esc(chatActivo.display_name)}</div>
      <button class="btn btn-ghost btn-sm" data-cerrar>✕</button></div>
    <div class="modal-body" id="info-cuerpo"><div class="muted">Consultando a WhatsApp…</div></div>`)

  try {
    const info = await API.get(u("/chats/" + chatActivo.id + "/info"))
    overlay.querySelector("#info-cuerpo").innerHTML = `
      ${info.foto ? `<img src="${esc(info.foto)}" style="width:110px;height:110px;border-radius:50%;margin:0 auto;display:block">` : ""}
      <div class="col" style="gap:9px;margin-top:14px">
        <div class="spread"><span class="dim small">Teléfono</span><span class="mono">${esc(chatActivo.phone_pretty)}</span></div>
        <div class="spread"><span class="dim small">Zona</span><span>${esc(chatActivo.zona || "—")}</span></div>
        <div class="spread"><span class="dim small">En línea</span><span>${info.enLinea ? "sí" : "no"}</span></div>
        <div class="spread"><span class="dim small">Última vez</span><span>${info.ultimaVez ? esc(haceCuanto(info.ultimaVez)) : "oculta"}</span></div>
        <div class="spread"><span class="dim small">Te escribió</span><span>${chatActivo.last_inbound_at ? esc(haceCuanto(chatActivo.last_inbound_at)) : "nunca"}</span></div>
      </div>
      <div class="hint" style="margin-top:12px">La foto y la última conexión dependen de la privacidad del contacto.</div>`
  } catch (e) {
    overlay.querySelector("#info-cuerpo").innerHTML = '<div style="color:#fda4af">' + esc(e.message) + "</div>"
  }
}

/* ---------------- Notas internas ---------------- */
$("#conv-notas").addEventListener("click", () => abrirNotas())

function abrirNotas() {
  if (!chatActivo) return
  const { overlay, cerrar } = abrirModal(`
    <div class="modal-head">
      <div><div class="h2">Notas internas</div>
        <div class="tiny dim">${esc(chatActivo.display_name)} · no las ve el cliente</div></div>
      <button class="btn btn-ghost btn-sm" data-cerrar>✕</button>
    </div>
    <div class="modal-body">
      <textarea class="textarea" id="nt-texto" style="min-height:200px"
        placeholder="Qué pidió, qué se le cotizó, cuándo volver a contactarlo…">${esc(chatActivo.notes || "")}</textarea>
    </div>
    <div class="modal-foot">
      <button class="btn" data-cerrar>Cancelar</button>
      <button class="btn btn-primary" id="nt-ok">Guardar</button>
    </div>`)

  overlay.querySelector("#nt-ok").addEventListener("click", async () => {
    try {
      const c = await API.post(u("/chats/" + chatActivo.id + "/notas"),
        { notas: overlay.querySelector("#nt-texto").value })
      chatActivo.notes = c.notes
      cerrar()
      toast("Notas guardadas")
    } catch (e) { toast(e.message, "error") }
  })
}

function abrirSeguimiento() {
  if (!chatActivo) return
  const opciones = [["Mañana", 1], ["En 3 días", 3], ["En 1 semana", 7], ["En 15 días", 15], ["En 30 días", 30]]
  const { overlay, cerrar } = abrirModal(`
    <div class="modal-head"><div class="h2">Programar seguimiento</div>
      <button class="btn btn-ghost btn-sm" data-cerrar>✕</button></div>
    <div class="modal-body">
      ${chatActivo.follow_up_at
        ? '<div class="chip chip-warn">Ya tiene uno para el ' + esc(new Date(chatActivo.follow_up_at).toLocaleDateString("es-AR")) + "</div>"
        : ""}
      <div class="col" style="gap:7px">
        ${opciones.map(([t, d]) => `<button class="btn" data-dias="${d}">${t}</button>`).join("")}
        <button class="btn btn-danger" data-dias="0">Quitar seguimiento</button>
      </div>
    </div>`)

  overlay.querySelectorAll("[data-dias]").forEach(b => b.addEventListener("click", async () => {
    const dias = Number(b.dataset.dias)
    try {
      const c = await API.post(u("/chats/" + chatActivo.id + "/seguimiento"),
        { cuando: dias ? new Date(Date.now() + dias * 86400000).toISOString() : null })
      chatActivo.follow_up_at = c.follow_up_at
      cerrar()
      toast(dias ? "Seguimiento programado" : "Seguimiento quitado")
    } catch (e) { toast(e.message, "error") }
  }))
}

/* ============================================================
   RESPUESTAS RÁPIDAS (se insertan escribiendo /atajo)
   ============================================================ */
let rapidas = []
let rapidaMarcada = 0

async function cargarRapidas() {
  try { rapidas = await API.get(u("/chats/respuestas-rapidas")) } catch (_) { rapidas = [] }
}

function filtrarRapidas() {
  const texto = composer.value
  const m = texto.match(/(?:^|\s)\/([\w-]*)$/)   // solo mientras se está tipeando el atajo
  if (!m) { $("#lista-rapidas").classList.add("hidden"); return null }

  const busq = m[1].toLowerCase()
  const encontradas = rapidas.filter(r => r.shortcut.toLowerCase().startsWith(busq)).slice(0, 6)
  if (!encontradas.length) { $("#lista-rapidas").classList.add("hidden"); return null }

  rapidaMarcada = Math.min(rapidaMarcada, encontradas.length - 1)
  $("#lista-rapidas").innerHTML = encontradas.map((r, i) =>
    `<div class="item ${i === rapidaMarcada ? "activo" : ""}" data-rapida="${r.id}">
       <div class="atajo">/${esc(r.shortcut)}</div>
       <div class="cuerpo">${esc(r.body)}</div>
     </div>`).join("")
  $("#lista-rapidas").classList.remove("hidden")
  return encontradas
}

function insertarRapida(r) {
  composer.value = composer.value.replace(/(?:^|\s)\/[\w-]*$/, match => (match.startsWith(" ") ? " " : "") + r.body)
  $("#lista-rapidas").classList.add("hidden")
  composer.focus()
  composer.dispatchEvent(new Event("input"))
}

$("#lista-rapidas").addEventListener("click", e => {
  const el = e.target.closest("[data-rapida]")
  if (!el) return
  const r = rapidas.find(x => x.id === Number(el.dataset.rapida))
  if (r) insertarRapida(r)
})

/* ---------------- Administración de respuestas rápidas ---------------- */
async function cargarRapidasAdmin() {
  await cargarRapidas()
  $("#lista-rapidas-admin").innerHTML = rapidas.length
    ? rapidas.map(r => `<div class="card col" style="gap:9px">
        <div class="spread">
          <span class="atajo" style="color:var(--acc);font-weight:650">/${esc(r.shortcut)}</span>
          <button class="btn btn-sm btn-danger" data-del-rapida="${r.id}">🗑</button>
        </div>
        <div class="variant">${esc(r.body)}</div>
      </div>`).join("")
    : '<div class="card muted">Todavía no tenés respuestas rápidas. Creá una y usala escribiendo <code>/atajo</code> en cualquier chat.</div>'

  $$("[data-del-rapida]").forEach(b => b.addEventListener("click", async () => {
    if (!await confirmar("Eliminar esta respuesta rápida?", "Eliminar")) return
    await API.del(u("/chats/respuestas-rapidas/" + b.dataset.delRapida))
    cargarRapidasAdmin()
  }))
}

$("#btn-nueva-rapida").addEventListener("click", () => {
  const { overlay, cerrar } = abrirModal(`
    <div class="modal-head"><div class="h2">Nueva respuesta rápida</div>
      <button class="btn btn-ghost btn-sm" data-cerrar>✕</button></div>
    <div class="modal-body">
      <div class="field">
        <label class="label">Atajo</label>
        <div class="row"><span class="dim">/</span><input class="input" id="rp-atajo" maxlength="30" placeholder="precios" autocomplete="off"></div>
        <div class="hint">En el chat escribís <code>/precios</code> y se reemplaza por el texto.</div>
      </div>
      <div class="field">
        <label class="label">Texto</label>
        <textarea class="textarea" id="rp-body" placeholder="Nuestros precios arrancan en…"></textarea>
      </div>
    </div>
    <div class="modal-foot">
      <button class="btn" data-cerrar>Cancelar</button>
      <button class="btn btn-primary" id="rp-ok">Guardar</button>
    </div>`)

  overlay.querySelector("#rp-ok").addEventListener("click", async () => {
    try {
      await API.post(u("/chats/respuestas-rapidas"), {
        shortcut: overlay.querySelector("#rp-atajo").value,
        body:     overlay.querySelector("#rp-body").value
      })
      cerrar()
      toast("Respuesta rápida guardada")
      cargarRapidasAdmin()
    } catch (e) { toast(e.message, "error") }
  })
})

/* ============================================================
   ESTADOS (historias)
   ============================================================ */
const COLORES_ESTADO = ["#0f5c45", "#075e54", "#1f2937", "#7c3aed", "#dc2626",
                        "#ea580c", "#0284c7", "#be185d", "#4d7c0f", "#0f172a"]
let colorEstado = COLORES_ESTADO[0]

function pintarColoresEstado() {
  $("#est-colores").innerHTML = COLORES_ESTADO.map(c =>
    `<div class="color-chip ${c === colorEstado ? "activo" : ""}" data-color="${c}" style="background:${c}"></div>`
  ).join("")
  $$("#est-colores [data-color]").forEach(el => el.addEventListener("click", () => {
    colorEstado = el.dataset.color
    pintarColoresEstado()
  }))
}

$$("[data-tipo-estado]").forEach(b => b.addEventListener("click", () => {
  const tipo = b.dataset.tipoEstado
  $$("[data-tipo-estado]").forEach(x => x.classList.toggle("btn-primary", x === b))
  $("#estado-texto").classList.toggle("hidden", tipo !== "texto")
  $("#estado-media").classList.toggle("hidden", tipo !== "media")
}))

$("#est-archivo").addEventListener("change", e => {
  const f = e.target.files[0]
  if (!f) { $("#est-preview").innerHTML = ""; return }
  const url = URL.createObjectURL(f)
  $("#est-preview").innerHTML = f.type.startsWith("video/")
    ? `<video src="${url}" controls style="max-width:100%;border-radius:var(--r)"></video>`
    : `<img src="${url}" style="max-width:100%;border-radius:var(--r)">`
})

$("#est-publicar").addEventListener("click", async () => {
  const boton = $("#est-publicar")
  const esTexto = !$("#estado-texto").classList.contains("hidden")
  boton.disabled = true
  boton.textContent = "Publicando…"

  try {
    if (esTexto) {
      const texto = $("#est-texto").value.trim()
      if (!texto) throw new Error("Escribí algo primero")
      await API.post(u("/status/texto"), { texto, color: colorEstado, fuente: $("#est-fuente").value })
      $("#est-texto").value = ""
    } else {
      const archivo = $("#est-archivo").files[0]
      if (!archivo) throw new Error("Elegí una imagen o un video")

      const datos = new FormData()
      datos.append("archivo", archivo)
      datos.append("caption", $("#est-caption").value || "")
      const res = await fetch("/api" + u("/status/media"),
        { method: "POST", body: datos, credentials: "same-origin" })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(j.error || "Error " + res.status)

      $("#est-archivo").value = ""
      $("#est-caption").value = ""
      $("#est-preview").innerHTML = ""
    }
    toast("Estado publicado 📸")
    cargarEstados()
  } catch (e) {
    toast(e.message, "error")
  } finally {
    boton.disabled = false
    boton.textContent = "Publicar estado"
  }
})

async function cargarEstados() {
  pintarColoresEstado()
  try {
    const lista = await API.get(u("/status"))
    $("#est-historial").innerHTML = lista.length
      ? lista.map(s => {
          if (s.tipo === "texto") {
            const op = s.opciones || {}
            return `<div class="estado-preview" style="background:${esc(op.backgroundColor || "#0f5c45")};font-size:15px">
                      ${esc(s.contenido || "")}
                    </div>
                    <div class="tiny dim" style="margin:-4px 0 6px">${esc(haceCuanto(s.created_at))}</div>`
          }
          return `<div class="col" style="gap:4px">
                    ${s.media_url && s.tipo === "imagen"
                      ? `<img src="${esc(s.media_url)}" style="width:100%;border-radius:var(--r)">`
                      : `<video src="${esc(s.media_url || "")}" controls style="width:100%;border-radius:var(--r)"></video>`}
                    ${s.contenido ? '<div class="small">' + esc(s.contenido) + "</div>" : ""}
                    <div class="tiny dim">${esc(haceCuanto(s.created_at))}</div>
                  </div>`
        }).join("")
      : '<div class="muted small">Todavía no publicaste ningún estado desde el CRM.</div>'
  } catch (e) { toast(e.message, "error") }
}

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

  // Espejo en la cabecera de celular
  const dotMovil = $("#wa-dot-movil")
  if (dotMovil) {
    dotMovil.className = "dot " + dot
    $("#wa-estado-movil").textContent = txt
  }
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
    const ok = await confirmar(
      "Al desvincular esta línea se borran del CRM todos sus chats, mensajes y contactos. " +
      "Las difusiones en curso se cancelan. Esto no se puede deshacer.\n\n" +
      "Para volver a usarla vas a tener que escanear el QR otra vez.",
      "Desvincular y borrar"
    )
    if (!ok) return

    try {
      const r = await API.post(u("/sessions/" + b.dataset.logout + "/logout"))
      const n = r.borrados
      toast(n ? "Línea desvinculada · " + nEsp(n.chats) + " chats borrados" : "Línea desvinculada")

      // La vista de chats quedó apuntando a datos que ya no existen.
      chatActivo = null
      limpiarSeleccion()
      $("#conv-activa").classList.add("hidden")
      $("#conv-vacio").classList.remove("hidden")

      cargarSesionesWa(); cargarChats(); cargarZonas(); cargarTags(); refrescarResumen()
    } catch (e) { toast(e.message, "error") }
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

/** Traduce los filtros guardados de una campaña a chips legibles. */
function chipsDeZonas(filtros = {}) {
  const chips = []
  for (const p of filtros.provincias || []) chips.push('<span class="chip chip-info">🗺 ' + esc(p) + "</span>")
  for (const a of filtros.areas || [])      chips.push('<span class="chip chip-info">📍 ' + esc(mapaAreas[a] || "área " + a) + "</span>")
  for (const p of filtros.paises || [])     chips.push('<span class="chip chip-info">🌎 +' + esc(p) + "</span>")

  if (!chips.length) chips.push('<span class="chip">🌐 Todas las zonas</span>')
  if (filtros.friosDias > 0) chips.push('<span class="chip chip-warn">❄ callados +' + filtros.friosDias + "d</span>")
  if (filtros.tag)           chips.push('<span class="chip chip-purple">🏷 ' + esc(filtros.tag) + "</span>")
  return chips.join(" ")
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
          <div class="row wrap" style="gap:5px;margin-top:7px">${chipsDeZonas(c.filters || {})}</div>
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

  // ---- Árbol geográfico: provincia > ciudad, más un grupo de otros países ----
  const porProvincia = new Map()
  for (const a of zonas.areas) {
    const prov = a.province || "Sin provincia"
    if (!porProvincia.has(prov)) porProvincia.set(prov, [])
    porProvincia.get(prov).push(a)
  }
  const totalProv = Object.fromEntries((zonas.provincias || []).map(p => [p.province, p.total]))

  const gruposArg = [...porProvincia.entries()]
    .sort((a, b) => (totalProv[b[0]] || 0) - (totalProv[a[0]] || 0))
    .map(([prov, ciudades]) => `
      <div class="zona-grupo" data-buscar="${esc(prov.toLowerCase())}">
        <label class="zona-prov">
          <input type="checkbox" class="prov-check" value="${esc(prov)}">
          <span class="grow"><b>${esc(prov)}</b> <span class="dim tiny">provincia completa</span></span>
          <span class="chip tiny">${nEsp(totalProv[prov] || 0)}</span>
        </label>
        <div class="zona-ciudades">
          ${ciudades.sort((x, y) => y.total - x.total).map(a => `
            <label class="zona-ciudad" data-buscar="${esc((a.region + " " + prov).toLowerCase())}">
              <input type="checkbox" class="zona-check" value="${a.area_code}" data-prov="${esc(prov)}"
                     ${prefill.area === a.area_code ? "checked" : ""}>
              <span class="grow">${esc(a.region)} <span class="dim tiny">+54 ${a.area_code}</span></span>
              <span class="chip tiny">${nEsp(a.total)}</span>
            </label>`).join("")}
        </div>
      </div>`).join("")

  const otrosPaises = (zonas.paises || []).filter(p => p.country_code !== "54")
  const grupoPaises = otrosPaises.length ? `
    <div class="zona-grupo" data-buscar="internacional otros paises">
      <label class="zona-prov"><span class="grow"><b>Otros países</b></span></label>
      <div class="zona-ciudades">
        ${otrosPaises.map(p => `
          <label class="zona-ciudad" data-buscar="${esc((p.country || p.country_code).toLowerCase())}">
            <input type="checkbox" class="pais-check" value="${esc(p.country_code)}">
            <span class="grow">${esc(p.country || p.country_code)} <span class="dim tiny">+${esc(p.country_code)}</span></span>
            <span class="chip tiny">${nEsp(p.total)}</span>
          </label>`).join("")}
      </div>
    </div>` : ""

  const opcionesZona = (gruposArg + grupoPaises) ||
    '<div class="muted small" style="padding:14px">Sincronizá tus chats para ver las zonas disponibles.</div>'

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
        <div class="spread">
          <label class="label">Zonas geográficas</label>
          <span class="tiny dim" id="d-zonas-resumen">todas</span>
        </div>
        <input class="input" id="d-buscar-zona" placeholder="Buscar ciudad o provincia…"
               autocomplete="off" style="margin-bottom:8px">
        <div class="zona-lista" id="d-zonas">${opcionesZona}</div>
        <div class="hint">
          Sin seleccionar nada, se envía a todos. Marcar una <b>provincia completa</b>
          incluye sus ciudades y también los contactos nuevos que aparezcan ahí después.
          Las zonas se suman entre sí: podés combinar Mar del Plata + Rosario + toda Córdoba.
        </div>
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

  /* ---------- Selector de zonas ---------- */
  // Marcar una provincia cubre a sus ciudades: las deshabilitamos para que no
  // parezca que hay que tildarlas una por una.
  function sincronizarProvincias() {
    overlay.querySelectorAll(".prov-check").forEach(prov => {
      overlay.querySelectorAll(`.zona-check[data-prov="${CSS.escape(prov.value)}"]`).forEach(ciudad => {
        ciudad.disabled = prov.checked
        ciudad.closest(".zona-ciudad").style.opacity = prov.checked ? .45 : 1
      })
    })
  }

  function resumenZonas() {
    const p = armarPayload().filtros
    const partes = []
    if (p.provincias.length) partes.push(p.provincias.length + " provincia(s)")
    if (p.areas.length)      partes.push(p.areas.length + " ciudad(es)")
    if (p.paises.length)     partes.push(p.paises.length + " país(es)")
    q("#d-zonas-resumen").textContent = partes.length ? partes.join(" · ") : "todas"
  }

  let timerZonas = null
  q("#d-zonas").addEventListener("change", () => {
    sincronizarProvincias()
    resumenZonas()
    // Recalcular solo cuando deja de tocar, para no consultar en cada click.
    clearTimeout(timerZonas)
    timerZonas = setTimeout(() => q("#d-calcular").click(), 500)
  })

  q("#d-buscar-zona").addEventListener("input", e => {
    const texto = e.target.value.trim().toLowerCase()
    overlay.querySelectorAll(".zona-grupo").forEach(grupo => {
      let visiblesEnGrupo = 0
      grupo.querySelectorAll(".zona-ciudad").forEach(ciudad => {
        const coincide = !texto || ciudad.dataset.buscar.includes(texto)
        ciudad.style.display = coincide ? "" : "none"
        if (coincide) visiblesEnGrupo++
      })
      // El grupo se muestra si coincide su nombre o si le quedó alguna ciudad.
      const coincideGrupo = !texto || grupo.dataset.buscar.includes(texto)
      grupo.style.display = (coincideGrupo || visiblesEnGrupo) ? "" : "none"
      if (coincideGrupo && !texto) grupo.querySelectorAll(".zona-ciudad").forEach(c => c.style.display = "")
    })
  })

  sincronizarProvincias()
  resumenZonas()

  q("#d-preview").addEventListener("click", async () => {
    const mensaje = q("#d-mensaje").value.trim()
    if (!mensaje) return toast("Escribí el mensaje primero", "warn")
    try {
      const r = await API.post(u("/campaigns/preview"), { mensaje, cantidad: 3 })
      q("#d-variantes").innerHTML = r.variantes.map(v => '<div class="variant">' + esc(v) + "</div>").join("")
    } catch (e) { toast(e.message, "error") }
  })

  function armarPayload() {
    // Selección manual desde la lista: manda a esos contactos y a nadie más.
    if (prefill.jids?.length) {
      return {
        nombre:  q("#d-nombre").value.trim(),
        mensaje: q("#d-mensaje").value.trim(),
        filtros: { jids: prefill.jids },
        settings: leerSettings()
      }
    }

    // Las ciudades de una provincia ya marcada se ignoran: la provincia las cubre.
    const provincias = [...overlay.querySelectorAll(".prov-check:checked")].map(c => c.value)
    const areas = [...overlay.querySelectorAll(".zona-check:checked")]
      .filter(c => !provincias.includes(c.dataset.prov))
      .map(c => c.value)
    const paises = [...overlay.querySelectorAll(".pais-check:checked")].map(c => c.value)

    return {
      nombre:  q("#d-nombre").value.trim(),
      mensaje: q("#d-mensaje").value.trim(),
      filtros: {
        areas, provincias, paises,
        quien:            q("#d-quien").value,
        friosDias:        parseInt(q("#d-frios").value, 10) || 0,
        tag:              prefill.tag || "",
        soloConRespuesta: q("#d-solo-respondieron").checked,
        excluirRecientes: q("#d-excluir-recientes").checked,
        limite: parseInt(q("#d-limite").value, 10) || 500
      },
      settings: leerSettings()
    }
  }

  /** Ritmo de envío: lo comparten la difusión por filtros y la de selección manual. */
  function leerSettings() {
    return {
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
