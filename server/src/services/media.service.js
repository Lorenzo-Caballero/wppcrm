// ============================================================
//  Archivos adjuntos
//  Guarda en disco lo que se envía y lo que se recibe, para que el CRM
//  pueda mostrarlo después sin volver a pedírselo a WhatsApp.
//  Cada cliente tiene su carpeta: /app/data/media/<tenant_id>/
// ============================================================
const fs   = require("fs")
const path = require("path")
const crypto = require("crypto")

const env = require("../config/env")
const log = require("../utils/logger")

const EXTENSIONES = {
  "image/jpeg": ".jpg",  "image/png": ".png",   "image/webp": ".webp",
  "image/gif":  ".gif",  "video/mp4": ".mp4",   "video/webm": ".webm",
  "video/quicktime": ".mov",
  "audio/mpeg": ".mp3",  "audio/ogg": ".ogg",   "audio/wav": ".wav",
  "audio/mp4":  ".m4a",  "audio/webm": ".webm",
  "application/pdf": ".pdf",
  "application/msword": ".doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
  "application/vnd.ms-excel": ".xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
  "text/plain": ".txt",  "application/zip": ".zip"
}

/** image | video | audio | documento — define con qué método de wppconnect se manda. */
function clasificar(mime = "") {
  if (mime.startsWith("image/")) return "image"
  if (mime.startsWith("video/")) return "video"
  if (mime.startsWith("audio/")) return "audio"
  return "documento"
}

function carpetaTenant(tenantId) {
  const dir = path.join(env.mediaDir, String(tenantId))
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  return dir
}

/** Nombre seguro: nunca usamos el que mandó el cliente para escribir en disco. */
function nombreEnDisco(mime, nombreOriginal = "") {
  const extOriginal = path.extname(nombreOriginal || "").toLowerCase().slice(0, 8)
  const ext = EXTENSIONES[mime] || (/^\.[a-z0-9]+$/.test(extOriginal) ? extOriginal : ".bin")
  return crypto.randomBytes(16).toString("hex") + ext
}

/**
 * Guarda un buffer y devuelve los datos para la base.
 * @returns { archivo, url, mime, nombre, tipo, tamano }
 */
function guardar(tenantId, buffer, mime, nombreOriginal) {
  const archivo = nombreEnDisco(mime, nombreOriginal)
  fs.writeFileSync(path.join(carpetaTenant(tenantId), archivo), buffer)

  return {
    archivo,
    url:    "/api/media/" + tenantId + "/" + archivo,
    mime:   mime || "application/octet-stream",
    nombre: (nombreOriginal || archivo).slice(0, 200),
    tipo:   clasificar(mime),
    tamano: buffer.length
  }
}

/** Guarda un data URI o base64 pelado (lo que devuelve client.downloadMedia). */
function guardarBase64(tenantId, base64, mimeSugerido, nombreOriginal) {
  let datos = String(base64 || "")
  let mime  = mimeSugerido

  const m = datos.match(/^data:([^;]+);base64,(.*)$/s)
  if (m) { mime = m[1]; datos = m[2] }
  if (!datos) return null

  return guardar(tenantId, Buffer.from(datos, "base64"), mime || "application/octet-stream", nombreOriginal)
}

/** Ruta absoluta validada: impide salir de la carpeta del cliente con "../". */
function rutaSegura(tenantId, archivo) {
  const base    = carpetaTenant(tenantId)
  const destino = path.resolve(base, path.basename(String(archivo || "")))
  if (!destino.startsWith(path.resolve(base))) return null
  return fs.existsSync(destino) ? destino : null
}

function leerBase64(tenantId, archivo) {
  const ruta = rutaSegura(tenantId, archivo)
  if (!ruta) return null
  return fs.readFileSync(ruta).toString("base64")
}

function borrar(tenantId, archivo) {
  const ruta = rutaSegura(tenantId, archivo)
  if (ruta) { try { fs.unlinkSync(ruta) } catch (e) { log.debug("media", e.message) } }
}

module.exports = { guardar, guardarBase64, rutaSegura, leerBase64, borrar, clasificar, EXTENSIONES }
