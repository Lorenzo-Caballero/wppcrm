// Si ya hay sesión abierta, saltamos directo al panel que corresponde.
(async () => {
  try {
    const { user } = await API.get("/auth/me")
    location.href = user.role === "owner" ? "/admin" : "/app"
  } catch (_) { /* sin sesión: se queda en el login */ }
})()

const form   = $("#form")
const boton  = $("#submit")
const errorEl= $("#error")

form.addEventListener("submit", async e => {
  e.preventDefault()
  errorEl.classList.add("hidden")
  boton.disabled = true
  boton.textContent = "Ingresando..."

  try {
    const r = await API.post("/auth/login", {
      email:    $("#email").value.trim(),
      password: $("#password").value
    })
    location.href = r.redirect || "/app"
  } catch (err) {
    errorEl.textContent = err.message
    errorEl.classList.remove("hidden")
    boton.disabled = false
    boton.textContent = "Ingresar"
  }
})
