# Despliegue en el VPS — `wppcrm.llegadasqr.site`

Guía completa, de cero a producción. Todo corre en Docker: no hace falta instalar
Node ni Postgres a mano en el servidor.

---

## 0. Qué vas a levantar

El servidor de WhatsApp **corre dentro del contenedor `app`**, en tu VPS. El
subdominio solo expone un nginx que hace de proxy hacia ese contenedor.

**Antes de nada, mirá si el VPS ya tiene nginx sirviendo otros sitios:**

```bash
ss -tlnp | grep -E ':80 |:443 '
nginx -T 2>/dev/null | grep server_name | sort -u
```

De ahí salen dos caminos. Dos nginx **no pueden** compartir el puerto 80, así que
elegí uno y seguí solo los pasos de esa opción.

### Opción A — VPS limpio (nada escuchando en el 80)

Todo en Docker, incluido el proxy y la renovación del certificado.

```
Internet
   └─ :80 / :443 ──► nginx (contenedor) ──► app:3000 ──► postgres
                        └─ certbot renueva solo cada 12 h
```

### Opción B — el VPS ya tiene nginx con otros sitios *(este es tu caso)*

El nginx del sistema queda como única puerta de entrada y suma un server block
para el CRM, al lado de los que ya tenías. Los contenedores `nginx` y `certbot`
no se usan: quedan detrás del perfil `proxy` y no arrancan.

```
Internet
   └─ :80 / :443 ──► nginx del host ──┬─► n8n.nahuelherrera.com  → localhost:5678
                                      └─► wppcrm.llegadasqr.site → 127.0.0.1:3000 (contenedor app)
```

El contenedor `app` publica el puerto **solo en loopback** (`127.0.0.1:3000`), así
que lo alcanza el nginx del host pero no se expone a internet.

---

## 1. Requisitos del VPS

| Clientes con WhatsApp conectado | RAM mínima | Recomendado |
|---|---|---|
| 1 – 2 | 2 GB | 4 GB |
| 3 – 4 | 4 GB | 6 GB |
| 5 – 10 | 8 GB | 12 GB |

Cada sesión abre su propio Chromium (**400–600 MB**). Es la restricción real del
sistema; ajustá `MAX_ACTIVE_SESSIONS` en el `.env` a lo que aguante tu VPS.

**Agregá swap** (barato y evita que el kernel mate procesos con picos de memoria):

```bash
sudo fallocate -l 4G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

---

## 2. DNS

El dominio `llegadasqr.site` ya está en uso por otro proyecto, así que este CRM
va en un **subdominio propio**. Alcanza con **un solo registro A**:

| Tipo | Nombre | Valor | |
|---|---|---|---|
| A | `wppcrm` | `168.231.98.136` *(IP del VPS)* | ← el único que hay que crear |

**No toques estos registros** — son del otro proyecto y romperlo es instantáneo:

| Tipo | Nombre | Contenido |
|---|---|---|
| ALIAS | `@` | `llegadasqr.site.cdn.hstgr.net` |
| CNAME | `www` | `www.llegadasqr.site.cdn.hstgr.net` |
| A | `ftp` | `147.93.14.168` |

Los dos proyectos conviven sin problema: el subdominio resuelve directo al VPS,
sin pasar por el CDN de Hostinger.

Verificá antes de seguir (tiene que devolver la IP del VPS):

```bash
dig +short wppcrm.llegadasqr.site
# esperado: 168.231.98.136
```

> Dos cosas antes de avanzar:
> - Confirmá que `168.231.98.136` es realmente la IP de tu VPS (`ftp` apunta a
>   otra IP distinta, que es el hosting compartido — no la confundas).
> - No sigas hasta que el DNS resuelva: Let's Encrypt falla si el subdominio
>   todavía no apunta al servidor. El TTL de ese registro es de 4 h, así que si
>   más adelante lo cambiás, la propagación tarda.

> **Si querés otro nombre** (`crm.llegadasqr.site`, `app.llegadasqr.site`…),
> creá el registro A con ese nombre y usalo en `DOMAIN`. El resto de la guía es igual.

---

## 3. Docker en el servidor

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER
newgrp docker            # o cerrá sesión y volvé a entrar
docker compose version   # tiene que responder v2.x
```

---

## 4. Subir el proyecto

**Opción A — con git** (recomendada para actualizar después):
Setting up swapspace version 1, size = 4 GiB (4294963200 bytes)
no label, UUID=e3c5f4d7-43ed-446d-857f-cd65fbf93c08



dd4f2ba05ce0235876e989c2c172db2a8ac3c58b53c63cea54cb5c4e730e990bd5f29422fd6b389a691cbd9da71fc5bc


 DATABASE_URL: postgres://wppcrm:5084ed365b8ee6be99e2ffc4d3a19469d6dde373b78cb938@db:5432/wppcrm
```bash
sudo mkdir -p /opt/wppcrm && sudo chown $USER /opt/wppcrm
git clone TU_REPO /opt/wppcrm
cd /opt/wppcrm
```

**Opción B — desde tu Windows con scp:**

```powershell
scp -r C:\Users\Lenovo\Documents\node\wppcrm root@TU.IP:/opt/wppcrm
```

---

## 5. Configurar el `.env`

```bash
cd /opt/wppcrm
cp .env.example .env
nano .env
```

Completá **como mínimo** (ojo: va el subdominio completo, no el dominio raíz):

```ini
DOMAIN=wppcrm.llegadasqr.site
APP_URL=https://wppcrm.llegadasqr.site
POSTGRES_PASSWORD=<solo letras y números — ver aviso de abajo>
JWT_SECRET=<pegá acá el resultado de: openssl rand -hex 48>
COOKIE_SECURE=true
OWNER_EMAIL=lorenzocaballerofernandez@gmail.com
OWNER_PASSWORD=<tu password de dueño>
MAX_ACTIVE_SESSIONS=4
```

Generá los dos valores así (salida alfanumérica, sin sorpresas):

```bash
openssl rand -hex 24    # POSTGRES_PASSWORD
openssl rand -hex 48    # JWT_SECRET
```

> ⚠️ **`POSTGRES_PASSWORD` solo con letras y números.**
> Se inserta dentro de una URL: `postgres://usuario:PASSWORD@db:5432/base`.
> Un `#` la corta en seco (en una URL abre el fragmento), y `@ : / %` también
> la rompen. El `$` ni siquiera llega: se lo come Docker Compose.
> El síntoma es `No se pudo conectar a Postgres` aunque el contenedor `db`
> figure sano. Para verificarlo antes de levantar:
>
> ```bash
> docker compose config | grep DATABASE_URL
> ```
>
> La URL tiene que terminar en `@db:5432/wppcrm`. Si se corta antes, cambiá
> la password. Y si el volumen ya se creó con la anterior, hay que recrearlo:
> `docker compose down -v` (borra la base, inofensivo solo antes del primer cliente).

> `OPENAI_API_KEY` es **opcional**. Sin ella el sistema igual varía cada mensaje
> con spintax + diccionario de sinónimos local, gratis y sin depender de internet.

---

## 6. Arrancar la aplicación

`docker compose up -d` levanta **solo `db` y `app`**. Los contenedores `nginx` y
`certbot` están detrás del perfil `proxy` y no arrancan salvo que los pidas.

```bash
cd /opt/wppcrm
docker compose up -d --build
docker compose logs -f app
```

Esperá a ver:

```
[db] conectado
[migrate] esquema aplicado
[migrate] usuario dueño creado: ...
[http] escuchando en el puerto 3000 (production)
```

Comprobá que responde antes de tocar el proxy:

```bash
curl -I http://127.0.0.1:3000
# HTTP/1.1 200 OK
```

---

## 7. Publicarlo con HTTPS

### Opción A — proxy en Docker *(VPS sin nginx propio)*

```bash
docker compose --profile proxy up -d
```

Probá `http://wppcrm.llegadasqr.site` y después emitís el certificado:

```bash
docker compose run --rm certbot certonly \
  --webroot -w /var/www/certbot \
  -d wppcrm.llegadasqr.site \
  --email lorenzocaballerofernandez@gmail.com \
  --agree-tos --no-eff-email

cp nginx/ssl/default-ssl.conf.template nginx/templates/default.conf.template
docker compose restart nginx
```

### Opción B — nginx del host *(el VPS ya sirve otros sitios)*

Instalá el server block que viene en el repo y pedile el certificado a certbot:

```bash
cp /opt/wppcrm/nginx/host/wppcrm.conf /etc/nginx/sites-available/wppcrm
ln -sf /etc/nginx/sites-available/wppcrm /etc/nginx/sites-enabled/wppcrm

nginx -t && systemctl reload nginx

apt-get install -y certbot python3-certbot-nginx      # si no lo tenías
certbot --nginx -d wppcrm.llegadasqr.site
```

`certbot --nginx` edita el bloque solo: agrega el `listen 443`, el certificado y
la redirección desde HTTP. Los demás sitios del nginx no se tocan.

Verificá: `https://wppcrm.llegadasqr.site` con el candado cerrado.

> **Un solo `-d`, el del subdominio.** No agregues `-d llegadasqr.site` ni
> `-d www.llegadasqr.site`: esos nombres apuntan al CDN de Hostinger, la
> validación de Let's Encrypt va a fallar y te quema intentos del límite
> semanal (5 fallos por hora, 50 certificados por dominio por semana).

> El bloque `location /socket.io/` con las cabeceras `Upgrade`/`Connection` es
> **obligatorio** en cualquiera de las dos opciones. Sin él la app carga, pero el
> QR no se refresca solo y los mensajes entrantes no aparecen hasta recargar.

---

## 8. Primer uso

1. Entrá a `https://wppcrm.llegadasqr.site` con `OWNER_EMAIL` / `OWNER_PASSWORD`.
   Vas a caer en **/admin** (panel del dueño).
2. **＋ Nuevo cliente** → nombre del negocio, email, contraseña, plan y tope diario.
   Se crean de una: el CRM del cliente, su usuario y su línea de WhatsApp.
3. Copiá las credenciales que te muestra y pasáselas al cliente.
4. El cliente entra, va a **Conexión** → **Conectar WhatsApp** → escanea el QR
   desde *WhatsApp → Dispositivos vinculados*.
5. Cuando queda en verde, toca **Sincronizar chats** y ya ve todo en **Chats**.

---

## 9. Operación diaria

```bash
cd /opt/wppcrm

docker compose logs -f app          # ver qué está pasando
docker compose ps                   # estado de los contenedores
docker compose restart app          # reiniciar solo la app
docker stats                        # cuánta RAM come cada sesión
```

**Backup de la base** (poné esto en un cron diario):

```bash
docker compose exec -T db pg_dump -U wppcrm wppcrm | gzip > /opt/backups/wppcrm-$(date +%F).sql.gz
```

**Backup de las sesiones de WhatsApp** (evita tener que re-escanear los QR):

```bash
docker run --rm -v wppcrm_wa_tokens:/data -v /opt/backups:/out alpine \
  tar czf /out/tokens-$(date +%F).tar.gz -C /data .
```

**Actualizar el código:**

```bash
cd /opt/wppcrm
git pull
docker compose up -d --build app
```

Las migraciones se aplican solas al arrancar; los volúmenes de datos y tokens
no se tocan.

---

## 10. Problemas frecuentes

| Síntoma | Causa y solución |
|---|---|
| El QR no aparece nunca | Falta RAM o Chromium no arranca. `docker compose logs app` y revisá `shm_size` (tiene que ser 1gb). |
| `Límite de sesiones simultáneas alcanzado` | Subí `MAX_ACTIVE_SESSIONS` **solo si tenés RAM**; si no, desconectá otra línea. |
| La sesión se cae sola cada tanto | WhatsApp Web cierra sesiones inactivas. El teléfono tiene que tener internet. El sistema reconecta al reiniciar `app`. |
| Certbot falla | El DNS todavía no propagó, o el puerto 80 está cerrado en el firewall del proveedor. |
| El WebSocket no conecta (QR no se actualiza) | Faltó pasar a la plantilla SSL: el bloque `/socket.io/` está solo ahí. |
| Difusión "corriendo" pero no envía | Está fuera de la ventana horaria o llegó al tope diario. La tarjeta lo indica. |
| `password authentication failed` | Cambiaste `POSTGRES_PASSWORD` con el volumen ya creado. O volvés a la anterior o borrás el volumen (`docker compose down -v`, **borra los datos**). |

---

## 11. Seguridad mínima

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
```

- Postgres **no** publica puertos hacia afuera: solo se accede desde la red interna de Docker.
- Cambiá `OWNER_PASSWORD` desde **Mi cuenta** después del primer ingreso.
- Las cookies son `httpOnly` + `secure`; mantené `COOKIE_SECURE=true` en producción.
