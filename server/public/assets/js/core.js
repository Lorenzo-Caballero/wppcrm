/* ============================================================
   Núcleo compartido: fetch a la API, notificaciones y helpers de UI.
   ============================================================ */

const API = {
  async req(metodo, url, cuerpo) {
    const opciones = {
      method: metodo,
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin"
    }
    if (cuerpo !== undefined) opciones.body = JSON.stringify(cuerpo)

    const res = await fetch("/api" + url, opciones)

    if (res.status === 401 && !location.pathname.startsWith("/login") && location.pathname !== "/") {
      location.href = "/login"
      throw new Error("Sesión vencida")
    }
    const texto = await res.text()
    const data  = texto ? JSON.parse(texto) : {}
    if (!res.ok) throw new Error(data.error || "Error " + res.status)
    return data
  },
  get:   (u)    => API.req("GET", u),
  post:  (u, b) => API.req("POST", u, b || {}),
  patch: (u, b) => API.req("PATCH", u, b || {}),
  del:   (u)    => API.req("DELETE", u)
}

/* ---------------- Notificaciones ---------------- */
function toast(mensaje, tipo = "ok", ms = 3800) {
  let cont = document.querySelector(".toasts")
  if (!cont) {
    cont = document.createElement("div")
    cont.className = "toasts"
    document.body.appendChild(cont)
  }
  const t = document.createElement("div")
  t.className = "toast " + (tipo === "error" ? "err" : tipo === "warn" ? "warn" : "")
  t.textContent = mensaje
  cont.appendChild(t)
  setTimeout(() => {
    t.style.transition = "opacity .25s, transform .25s"
    t.style.opacity = "0"
    t.style.transform = "translateX(20px)"
    setTimeout(() => t.remove(), 260)
  }, ms)
}

/* ---------------- Iconos ---------------- */
/**
 * Devuelve el markup de un icono del sprite (assets/iconos.svg).
 * @param nombre  sin el prefijo "i-" (ej: "chat", "enviar")
 * @param clase   clases extra (ej: "ico-lg")
 */
function ico(nombre, clase = "") {
  return '<svg class="ico ' + clase + '" aria-hidden="true"><use href="#i-' + nombre + '"></use></svg>'
}

/* ---------------- Helpers de DOM ---------------- */
const $  = (sel, raiz = document) => raiz.querySelector(sel)
const $$ = (sel, raiz = document) => [...raiz.querySelectorAll(sel)]

function esc(texto) {
  return String(texto ?? "").replace(/[&<>"']/g, c => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ))
}

/** Convierte el formato de WhatsApp (*negrita*, _cursiva_) a HTML seguro. */
function formatoWhatsapp(texto) {
  return esc(texto)
    .replace(/\*([^*\n]+)\*/g, "<b>$1</b>")
    .replace(/_([^_\n]+)_/g, "<i>$1</i>")
    .replace(/~([^~\n]+)~/g, "<s>$1</s>")
    .replace(/```([^`]+)```/g, "<code>$1</code>")
}

function iniciales(nombre) {
  const limpio = String(nombre || "?").trim().replace(/[^\p{L}\p{N}\s]/gu, "")
  const partes = limpio.split(/\s+/).filter(Boolean)
  if (!partes.length) return "#"
  if (partes.length === 1) return partes[0].slice(0, 2).toUpperCase()
  return (partes[0][0] + partes[1][0]).toUpperCase()
}

/** Color estable por nombre, para que cada contacto tenga siempre el mismo avatar. */
function colorAvatar(semilla) {
  const PARES = [
    ["#34d399", "#0ea5e9"], ["#a78bfa", "#6366f1"], ["#fbbf24", "#f97316"],
    ["#f472b6", "#ec4899"], ["#38bdf8", "#2563eb"], ["#4ade80", "#16a34a"],
    ["#fb7185", "#e11d48"], ["#2dd4bf", "#0d9488"]
  ]
  let h = 0
  for (const ch of String(semilla || "")) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  const [a, b] = PARES[h % PARES.length]
  return "linear-gradient(135deg," + a + "," + b + ")"
}

function avatarHtml(nombre, clase = "") {
  return '<div class="avatar ' + clase + '" style="background:' + colorAvatar(nombre) + '">' +
         esc(iniciales(nombre)) + "</div>"
}

/* ---------------- Fechas ---------------- */
function horaCorta(iso) {
  if (!iso) return ""
  return new Date(iso).toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit", hour12: false })
}

function fechaLarga(iso) {
  if (!iso) return ""
  return new Date(iso).toLocaleDateString("es-AR", { weekday: "long", day: "numeric", month: "long" })
}

/** "hace 5 min", "ayer", "12/08" */
function haceCuanto(iso) {
  if (!iso) return ""
  const d    = new Date(iso)
  const segs = (Date.now() - d.getTime()) / 1000
  if (segs < 60)     return "recién"
  if (segs < 3600)   return "hace " + Math.floor(segs / 60) + " min"
  if (segs < 86400)  return "hace " + Math.floor(segs / 3600) + " h"
  if (segs < 172800) return "ayer"
  if (segs < 604800) return "hace " + Math.floor(segs / 86400) + " días"
  return d.toLocaleDateString("es-AR", { day: "2-digit", month: "2-digit" })
}

/** Etiqueta compacta para la lista de chats. */
function selloLista(iso) {
  if (!iso) return ""
  const d = new Date(iso)
  const hoy = new Date()
  const mismoDia = d.toDateString() === hoy.toDateString()
  if (mismoDia) return horaCorta(iso)

  const ayer = new Date(hoy.getTime() - 86400000)
  if (d.toDateString() === ayer.toDateString()) return "ayer"
  return d.toLocaleDateString("es-AR", { day: "2-digit", month: "2-digit" })
}

function nEsp(n) {
  return new Intl.NumberFormat("es-AR").format(n || 0)
}

function msALegible(ms) {
  const s = Math.round(ms / 1000)
  if (s < 60) return s + " seg"
  const m = Math.round(s / 60)
  if (m < 60) return m + " min"
  return (m / 60).toFixed(1) + " h"
}

/* ---------------- Modales ---------------- */
function abrirModal(html, { ancho = "" } = {}) {
  const overlay = document.createElement("div")
  overlay.className = "overlay"
  overlay.innerHTML = '<div class="modal ' + ancho + '">' + html + "</div>"
  document.body.appendChild(overlay)

  const cerrar = () => overlay.remove()
  overlay.addEventListener("mousedown", e => { if (e.target === overlay) cerrar() })
  document.addEventListener("keydown", function esc2(e) {
    if (e.key === "Escape") { cerrar(); document.removeEventListener("keydown", esc2) }
  })
  overlay.querySelectorAll("[data-cerrar]").forEach(b => b.addEventListener("click", cerrar))
  return { overlay, cerrar }
}

function confirmar(mensaje, textoBoton = "Confirmar") {
  return new Promise(resolve => {
    const { overlay, cerrar } = abrirModal(`
      <div class="modal-head"><div class="h2">Confirmar</div></div>
      <div class="modal-body"><div class="muted">${esc(mensaje)}</div></div>
      <div class="modal-foot">
        <button class="btn" data-cerrar>Cancelar</button>
        <button class="btn btn-danger" id="ok">${esc(textoBoton)}</button>
      </div>`)

    // Cualquier forma de cerrar (botón, click afuera, Escape) resuelve en false:
    // si no, el código que espera este await se quedaría colgado para siempre.
    const observador = new MutationObserver(() => {
      if (!document.body.contains(overlay)) { observador.disconnect(); resolve(false) }
    })
    observador.observe(document.body, { childList: true })

    overlay.querySelector("#ok").addEventListener("click", () => {
      observador.disconnect()
      cerrar()
      resolve(true)
    })
  })
}

/* ---------------- Menú contextual ---------------- */
/**
 * Menú flotante anclado a un elemento o a un punto {x, y}.
 * items: [{icono, texto, accion, peligro}] · {separador:true} · {titulo:"..."}
 */
function menuFlotante(anclaOPunto, items) {
  document.querySelector(".menu-flotante")?.remove()

  const menu = document.createElement("div")
  menu.className = "menu-flotante"
  menu.innerHTML = items.map((it, i) => {
    if (it.separador) return "<hr>"
    if (it.titulo)    return '<div class="titulo">' + esc(it.titulo) + "</div>"
    // `icono` es el nombre de un símbolo del sprite, no un emoji.
    return `<button data-i="${i}" class="${it.peligro ? "peligro" : ""}">
              ${it.icono ? ico(it.icono) : '<span style="width:18px"></span>'}
              <span>${esc(it.texto)}</span>
            </button>`
  }).join("")
  document.body.appendChild(menu)

  // Posicionamiento: se corrige para que nunca quede fuera de la ventana.
  const r = anclaOPunto instanceof Element
    ? anclaOPunto.getBoundingClientRect()
    : { left: anclaOPunto.x, right: anclaOPunto.x, top: anclaOPunto.y, bottom: anclaOPunto.y }

  const caja = menu.getBoundingClientRect()
  let x = Math.min(r.left, window.innerWidth  - caja.width  - 10)
  let y = r.bottom + 6
  if (y + caja.height > window.innerHeight - 10) y = Math.max(10, r.top - caja.height - 6)
  menu.style.left = Math.max(10, x) + "px"
  menu.style.top  = y + "px"

  const cerrar = () => {
    menu.remove()
    document.removeEventListener("mousedown", alClickAfuera, true)
    document.removeEventListener("keydown", alEscape, true)
  }
  const alClickAfuera = ev => { if (!menu.contains(ev.target)) cerrar() }
  const alEscape = ev => { if (ev.key === "Escape") cerrar() }

  // El listener se agrega en el próximo tick: si no, el mismo click que
  // abrió el menú lo cerraría de inmediato.
  setTimeout(() => {
    document.addEventListener("mousedown", alClickAfuera, true)
    document.addEventListener("keydown", alEscape, true)
  }, 0)

  menu.querySelectorAll("[data-i]").forEach(b => b.addEventListener("click", () => {
    const item = items[Number(b.dataset.i)]
    cerrar()
    item.accion?.()
  }))

  return cerrar
}

/* ---------------- Sesión ---------------- */
async function cargarSesion() {
  try {
    return await API.get("/auth/me")
  } catch {
    location.href = "/login"
    return null
  }
}

async function cerrarSesion() {
  try { await API.post("/auth/logout") } catch (_) {}
  location.href = "/login"
}
