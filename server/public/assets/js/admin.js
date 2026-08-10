/* ============================================================
   Panel del dueño de la plataforma
   ============================================================ */
let sesion = null
let clientes = []

const ETIQUETA_ESTADO = {
  connected:    ["chip-acc",    "Conectado",   "dot-on"],
  connecting:   ["chip-warn",   "Conectando",  "dot-wait"],
  qr:           ["chip-info",   "Esperando QR","dot-wait"],
  disconnected: ["",            "Desconectado","dot-off"],
  error:        ["chip-danger", "Error",       "dot-err"]
}

/* ---------------- Arranque ---------------- */
;(async () => {
  sesion = await cargarSesion()
  if (!sesion) return
  if (sesion.user.role !== "owner") { location.href = "/app"; return }

  $("#owner-name").textContent  = sesion.user.name
  $("#owner-email").textContent = sesion.user.email

  conectarSocket()
  await refrescar()
})()

function conectarSocket() {
  const io_ = window.io && window.io({ path: "/socket.io" })
  if (!io_) return
  io_.on("session:status", () => refrescar())
}

/* ---------------- Navegación ---------------- */
$$(".nav-item").forEach(item => {
  item.addEventListener("click", () => {
    $$(".nav-item").forEach(i => i.classList.remove("active"))
    item.classList.add("active")
    const vista = item.dataset.vista
    ;["clientes", "sesiones", "cuenta"].forEach(v => {
      $("#vista-" + v).classList.toggle("hidden", v !== vista)
    })
    cerrarCajon()
    if (vista === "sesiones") pintarSesiones()
  })
})

/* ---------------- Menú lateral en celular ---------------- */
function abrirCajon() {
  $("#rail").classList.add("open")
  $("#rail-fondo").classList.add("visible")
}
function cerrarCajon() {
  $("#rail").classList.remove("open")
  $("#rail-fondo").classList.remove("visible")
}

$("#abrir-menu").addEventListener("click", abrirCajon)
$("#rail-fondo").addEventListener("click", cerrarCajon)
document.addEventListener("keydown", e => { if (e.key === "Escape") cerrarCajon() })

$("#logout").addEventListener("click", cerrarSesion)

/* ---------------- Datos ---------------- */
async function refrescar() {
  const [stats, lista] = await Promise.all([
    API.get("/admin/stats"),
    API.get("/admin/tenants")
  ])
  clientes = lista
  pintarStats(stats)
  pintarClientes()
  if (!$("#vista-sesiones").classList.contains("hidden")) pintarSesiones()
}

function pintarStats(s) {
  const tarjetas = [
    ["Clientes activos",     s.clientes_activos + " / " + s.clientes],
    ["Líneas conectadas",    s.sesiones_conectadas],
    ["Mensajes (24 h)",      nEsp(s.mensajes_24h)],
    ["Difusiones corriendo", s.difusiones_activas]
  ]
  $("#stats").innerHTML = tarjetas.map(([k, v]) =>
    '<div class="stat"><div class="val">' + esc(v) + '</div><div class="key">' + esc(k) + "</div></div>"
  ).join("")
}

function pintarClientes() {
  const tbody = $("#tabla-clientes")
  if (!clientes.length) {
    tbody.innerHTML = '<tr><td colspan="8" class="muted" style="text-align:center;padding:40px">' +
      'Todavía no hay clientes. Creá el primero con “＋ Nuevo cliente”.</td></tr>'
    return
  }

  tbody.innerHTML = clientes.map(c => {
    const sesiones = c.sesiones || []
    const wa = sesiones.length
      ? sesiones.map(s => {
          const [cls, txt] = ETIQUETA_ESTADO[s.status] || ETIQUETA_ESTADO.disconnected
          return '<span class="chip ' + cls + '">' + esc(txt) + (s.phone ? " · " + esc(s.phone) : "") + "</span>"
        }).join(" ")
      : '<span class="dim small">sin línea</span>'

    return `<tr>
      <td>
        <div class="row">
          ${avatarHtml(c.name, "avatar-sm")}
          <div class="grow">
            <div style="font-weight:600">${esc(c.name)}</div>
            <div class="tiny dim mono">${esc(c.slug)}</div>
          </div>
        </div>
      </td>
      <td><span class="chip chip-purple">${esc(c.plan)}</span></td>
      <td>${wa}</td>
      <td>${nEsp(c.chats)}</td>
      <td>${nEsp(c.difusiones)}</td>
      <td class="mono small">${nEsp(c.daily_limit)}</td>
      <td>${c.status === "active"
            ? '<span class="chip chip-acc">Activo</span>'
            : '<span class="chip chip-danger">Suspendido</span>'}</td>
      <td style="text-align:right;white-space:nowrap">
        <button class="btn btn-sm" data-crm="${c.id}" title="Abrir su CRM">CRM</button>
        <button class="btn btn-sm" data-editar="${c.id}">Editar</button>
        <button class="btn btn-sm ${c.status === "active" ? "btn-danger" : ""}" data-toggle="${c.id}">
          ${c.status === "active" ? "Suspender" : "Activar"}
        </button>
        <button class="btn btn-sm btn-danger" data-borrar="${c.id}" title="Eliminar cliente">${ico("basura", "ico-sm")}</button>
      </td>
    </tr>`
  }).join("")

  tbody.querySelectorAll("[data-crm]").forEach(b =>
    b.addEventListener("click", () => { location.href = "/app?tenantId=" + b.dataset.crm }))
  tbody.querySelectorAll("[data-editar]").forEach(b =>
    b.addEventListener("click", () => modalEditar(Number(b.dataset.editar))))
  tbody.querySelectorAll("[data-toggle]").forEach(b =>
    b.addEventListener("click", () => alternarEstado(Number(b.dataset.toggle))))
  tbody.querySelectorAll("[data-borrar]").forEach(b =>
    b.addEventListener("click", () => borrarCliente(Number(b.dataset.borrar))))
}

function pintarSesiones() {
  const items = []
  for (const c of clientes) {
    for (const s of c.sesiones || []) {
      const [cls, txt, dot] = ETIQUETA_ESTADO[s.status] || ETIQUETA_ESTADO.disconnected
      items.push(`<div class="card col" style="gap:12px">
        <div class="spread">
          <div class="row">
            ${avatarHtml(c.name, "avatar-sm")}
            <div>
              <div style="font-weight:600">${esc(c.name)}</div>
              <div class="tiny dim">${esc(s.label || "Principal")}</div>
            </div>
          </div>
          <span class="dot ${dot}"></span>
        </div>
        <div class="row wrap">
          <span class="chip ${cls}">${esc(txt)}</span>
          ${s.phone ? '<span class="chip mono">+' + esc(s.phone) + "</span>" : ""}
        </div>
        <div class="tiny dim mono">${esc(s.sessionKey || "")}</div>
      </div>`)
    }
  }
  $("#grid-sesiones").innerHTML = items.length
    ? items.join("")
    : '<div class="muted">Ningún cliente tiene líneas creadas todavía.</div>'
}

/* ---------------- Alta de cliente ---------------- */
$("#btn-nuevo").addEventListener("click", () => {
  const { overlay, cerrar } = abrirModal(`
    <div class="modal-head">
      <div>
        <div class="h2">Nuevo cliente</div>
        <div class="tiny dim">Se crea su CRM, su usuario y su línea de WhatsApp</div>
      </div>
      <button class="btn btn-ghost btn-sm" data-cerrar>${ico("cerrar")}</button>
    </div>
    <div class="modal-body">
      <div class="field">
        <label class="label">Nombre del negocio</label>
        <input class="input" id="f-nombre" placeholder="Fauno Tattoo" autofocus>
      </div>
      <div class="grid-2">
        <div class="field">
          <label class="label">Email de acceso</label>
          <input class="input" id="f-email" type="email" placeholder="cliente@email.com">
        </div>
        <div class="field">
          <label class="label">Contraseña inicial</label>
          <input class="input" id="f-pass" type="text" value="${passwordSugerida()}">
        </div>
      </div>
      <div class="grid-3">
        <div class="field">
          <label class="label">Plan</label>
          <select class="select" id="f-plan">
            <option value="basico">Básico</option>
            <option value="pro">Pro</option>
            <option value="premium">Premium</option>
          </select>
        </div>
        <div class="field">
          <label class="label">Líneas WhatsApp</label>
          <input class="input" id="f-sesiones" type="number" min="1" max="10" value="1">
        </div>
        <div class="field">
          <label class="label">Tope diario</label>
          <input class="input" id="f-tope" type="number" min="20" max="5000" value="300">
        </div>
      </div>
      <div class="hint">
        El tope diario limita cuántos mensajes de difusión puede enviar por día.
        Arrancá bajo (200–300) en líneas nuevas: es la principal defensa contra el baneo.
      </div>
      <div id="f-error" class="small hidden" style="color:#fda4af"></div>
    </div>
    <div class="modal-foot">
      <button class="btn" data-cerrar>Cancelar</button>
      <button class="btn btn-primary" id="f-guardar">Crear cliente</button>
    </div>`)

  const guardar = overlay.querySelector("#f-guardar")
  guardar.addEventListener("click", async () => {
    const err = overlay.querySelector("#f-error")
    err.classList.add("hidden")
    guardar.disabled = true
    guardar.textContent = "Creando…"

    // Guardamos la contraseña antes de cerrar el modal: después el input ya no existe.
    const passwordElegida = overlay.querySelector("#f-pass").value

    try {
      const r = await API.post("/admin/tenants", {
        nombre:      overlay.querySelector("#f-nombre").value.trim(),
        email:       overlay.querySelector("#f-email").value.trim(),
        password:    passwordElegida,
        plan:        overlay.querySelector("#f-plan").value,
        maxSessions: overlay.querySelector("#f-sesiones").value,
        dailyLimit:  overlay.querySelector("#f-tope").value
      })
      cerrar()
      toast("Cliente “" + r.tenant.name + "” creado")
      await refrescar()
      modalCredenciales(r, passwordElegida)
    } catch (e) {
      err.textContent = e.message
      err.classList.remove("hidden")
      guardar.disabled = false
      guardar.textContent = "Crear cliente"
    }
  })
})

function passwordSugerida() {
  const abc = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789"
  let s = ""
  for (let i = 0; i < 12; i++) s += abc[Math.floor(Math.random() * abc.length)]
  return s
}

function modalCredenciales(r, password) {
  abrirModal(`
    <div class="modal-head">
      <div class="h2">Datos de acceso</div>
      <button class="btn btn-ghost btn-sm" data-cerrar>${ico("cerrar")}</button>
    </div>
    <div class="modal-body">
      <div class="muted small">Pasale estos datos al cliente. La contraseña no se vuelve a mostrar.</div>
      <div class="panel" style="padding:14px">
        <div class="col" style="gap:8px">
          <div class="spread"><span class="dim small">URL</span><span class="mono">${esc(location.origin)}/login</span></div>
          <div class="spread"><span class="dim small">Email</span><span class="mono">${esc(r.user.email)}</span></div>
          <div class="spread"><span class="dim small">Contraseña</span><span class="mono">${esc(password)}</span></div>
        </div>
      </div>
      <div class="hint">Al entrar, el cliente va a “Conexión” y escanea el QR con su WhatsApp.</div>
    </div>
    <div class="modal-foot"><button class="btn btn-primary" data-cerrar>Listo</button></div>`)
}

/* ---------------- Edición ---------------- */
function modalEditar(id) {
  const c = clientes.find(x => x.id === id)
  if (!c) return

  const { overlay, cerrar } = abrirModal(`
    <div class="modal-head">
      <div class="h2">${esc(c.name)}</div>
      <button class="btn btn-ghost btn-sm" data-cerrar>${ico("cerrar")}</button>
    </div>
    <div class="modal-body">
      <div class="field">
        <label class="label">Nombre</label>
        <input class="input" id="e-nombre" value="${esc(c.name)}">
      </div>
      <div class="grid-3">
        <div class="field">
          <label class="label">Plan</label>
          <select class="select" id="e-plan">
            ${["basico", "pro", "premium"].map(p =>
              '<option value="' + p + '"' + (c.plan === p ? " selected" : "") + ">" + p + "</option>").join("")}
          </select>
        </div>
        <div class="field">
          <label class="label">Líneas</label>
          <input class="input" id="e-sesiones" type="number" min="1" max="10" value="${c.max_sessions}">
        </div>
        <div class="field">
          <label class="label">Tope diario</label>
          <input class="input" id="e-tope" type="number" min="20" max="5000" value="${c.daily_limit}">
        </div>
      </div>
      <hr style="border:0;border-top:1px solid var(--line)">
      <div class="h3">Usuarios</div>
      <div id="e-usuarios" class="col" style="gap:8px"><div class="dim small">Cargando…</div></div>
      <button class="btn btn-sm" id="e-nuevo-user">＋ Agregar usuario</button>
    </div>
    <div class="modal-foot">
      <button class="btn" data-cerrar>Cancelar</button>
      <button class="btn btn-primary" id="e-guardar">Guardar</button>
    </div>`, { ancho: "modal-lg" })

  cargarUsuarios()

  async function cargarUsuarios() {
    const users = await API.get("/admin/tenants/" + id + "/users")
    overlay.querySelector("#e-usuarios").innerHTML = users.map(u => `
      <div class="panel row" style="padding:10px 12px;gap:10px">
        ${avatarHtml(u.name, "avatar-sm")}
        <div class="grow truncate">
          <div class="small" style="font-weight:600">${esc(u.name)}</div>
          <div class="tiny dim">${esc(u.email)} · ${esc(u.role)}</div>
        </div>
        <button class="btn btn-sm" data-pw="${u.id}">Contraseña</button>
      </div>`).join("") || '<div class="dim small">Sin usuarios</div>'

    overlay.querySelectorAll("[data-pw]").forEach(b => b.addEventListener("click", async () => {
      const nueva = prompt("Nueva contraseña (mínimo 8 caracteres):", passwordSugerida())
      if (!nueva) return
      try {
        await API.post("/admin/users/" + b.dataset.pw + "/password", { password: nueva })
        toast("Contraseña actualizada")
      } catch (e) { toast(e.message, "error") }
    }))
  }

  overlay.querySelector("#e-nuevo-user").addEventListener("click", async () => {
    const email = prompt("Email del nuevo usuario:")
    if (!email) return
    const pass = prompt("Contraseña (mínimo 8 caracteres):", passwordSugerida())
    if (!pass) return
    try {
      await API.post("/admin/tenants/" + id + "/users", { email, password: pass, nombre: email.split("@")[0], role: "agent" })
      toast("Usuario creado")
      cargarUsuarios()
    } catch (e) { toast(e.message, "error") }
  })

  overlay.querySelector("#e-guardar").addEventListener("click", async () => {
    try {
      await API.patch("/admin/tenants/" + id, {
        nombre:      overlay.querySelector("#e-nombre").value.trim(),
        plan:        overlay.querySelector("#e-plan").value,
        maxSessions: overlay.querySelector("#e-sesiones").value,
        dailyLimit:  overlay.querySelector("#e-tope").value
      })
      cerrar()
      toast("Cliente actualizado")
      refrescar()
    } catch (e) { toast(e.message, "error") }
  })
}

async function alternarEstado(id) {
  const c = clientes.find(x => x.id === id)
  const nuevo = c.status === "active" ? "suspended" : "active"
  if (nuevo === "suspended" && !await confirmar("Suspender a “" + c.name + "”? No van a poder entrar al CRM.", "Suspender")) return
  try {
    await API.patch("/admin/tenants/" + id, { status: nuevo })
    toast(nuevo === "active" ? "Cliente activado" : "Cliente suspendido")
    refrescar()
  } catch (e) { toast(e.message, "error") }
}

async function borrarCliente(id) {
  const c = clientes.find(x => x.id === id)
  const ok = await confirmar(
    "Eliminar “" + c.name + "” borra su CRM completo: chats, mensajes, contactos y difusiones. Esto no se puede deshacer.",
    "Eliminar definitivamente"
  )
  if (!ok) return
  try {
    await API.del("/admin/tenants/" + id)
    toast("Cliente eliminado")
    refrescar()
  } catch (e) { toast(e.message, "error") }
}

/* ---------------- Cuenta ---------------- */
$("#btn-pw").addEventListener("click", async () => {
  try {
    await API.post("/auth/password", { actual: $("#pw-actual").value, nueva: $("#pw-nueva").value })
    $("#pw-actual").value = ""; $("#pw-nueva").value = ""
    toast("Contraseña actualizada")
  } catch (e) { toast(e.message, "error") }
})
