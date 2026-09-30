# Panel del certificador SII — fase 1

Una página web para certificar empresas sin terminal y sin Windows ni Mac: se sube el `.env`
de la empresa y cada botón corre un comando de `certificar.js`. El log se ve en vivo y queda
guardado.

**El certificado vive solo en el servidor.** Está en `/etc/certificador/`, lo lee el servicio y
se entrega a cada corrida por variable de entorno. El `.env` que sube una persona no lleva
certificado ni clave: si los trae, el panel los descarta. Ninguna ruta del panel devuelve el
`.pfx`, y el servicio no arranca si el certificado quedó dentro de una carpeta que el panel sirve.

Sin dependencias nuevas: el panel es Node puro (`server.js`, `public/`).

## Qué hace cada botón

| Botón | Comando |
|---|---|
| Certificar | `todo`: todas las etapas, sigue donde quedó; se detiene si hay que esperar al SII |
| Ver estado | `estado`: dónde va la postulación en el portal |
| Traer datos del SII | `datos`: dirección, comuna y fecha de resolución, escritos en el `.env` |
| Ver sets del portal | `descargar ver`: qué sets ofrece el SII, sin descargar nada |
| Bajar set sin enviar | `descargar`: baja el set y muestra qué se va a emitir; se niega a mitad de certificación |
| Revisar envíos | `consultar`: aceptados o rechazados por el SII |
| Declarar sets | `declarar` |
| Cerrar sesión SII | `logout` |
| Rehacer | `rehacer <set>`: desmarca un set rechazado para reenviarlo |

Opciones de una sola corrida: detener antes de subir muestras (`REVISAR_MUESTRAS=1`), forzar la
descarga del set (`FORZAR_DESCARGA=1`, reinicia la postulación, pide confirmación), set nuevo
con avances anteriores en el portal (`REINICIAR_SET=1`) y dar los sets por aprobados cuando el
portal ya los muestra aprobados pero el runner no encuentra su fila (`CONFIRMAR_SETS_APROBADOS=1`).

"Detener" no corta un envío al SII a la mitad: el runner lo termina, registra el TrackID y los
folios usados, cierra la sesión SII y sale. Se relanza y sigue donde quedó.

Corre **un comando a la vez**: todas las empresas usan el mismo certificado y el SII admite una
sesión por certificado. Si hay una corrida en curso, el panel lo dice y no lanza otra.

Colores del resultado: verde terminó bien · amarillo esperando al SII (relanzar más tarde) ·
rojo requiere una acción (el aviso dice cuál).

## Instalación en Ubuntu (22.04 o 24.04)

Todo como root o con `sudo`.

### 1. Node 20 y usuario del servicio

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs nginx git
useradd --system --create-home --home-dir /opt/certificador --shell /usr/sbin/nologin certificador
```

### 2. El certificador

`/opt/certificador` es la misma carpeta que hoy se usa en el equipo: `certificar.js`,
`package.json`, `node_modules/` (con `@devlas/dte-sii` del fork de Konos), `empresas/` y `runs/`.

```bash
cd /opt/certificador
# copiar aquí certificar.js, package.json y package-lock.json
npm install --omit=dev github:KonosCL/dte-sii   # la librería del fork, con exportación
mkdir -p empresas runs
# copiar la carpeta panel/ de este paquete a /opt/certificador/panel
chown -R certificador:certificador /opt/certificador
```

Si ya hay certificaciones en curso en otro equipo, copiar también su `runs/<RUT>/`: ahí están el
set descargado y los folios usados. Sin eso, el runner se niega a seguir (no hay que descargar el
set de nuevo: reinicia la postulación).

### 3. Certificado y claves (solo en el servidor)

```bash
mkdir -p /etc/certificador
cp nelson.pfx /etc/certificador/certificado.pfx
cp panel/panel.env.example /etc/certificador/panel.env
nano /etc/certificador/panel.env          # PANEL_CLAVE, CERT_PASSWORD
chown root:certificador /etc/certificador /etc/certificador/certificado.pfx
chmod 750 /etc/certificador
chmod 640 /etc/certificador/certificado.pfx
chown root:root /etc/certificador/panel.env
chmod 600 /etc/certificador/panel.env      # lo lee systemd, no el usuario del servicio
```

`PANEL_CLAVE` es la clave de entrada del equipo (mínimo 10 caracteres). Cambiarla = editar el
archivo y `systemctl restart certificador-panel`.

### 4. Servicio

```bash
cp /opt/certificador/panel/certificador-panel.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now certificador-panel
systemctl status certificador-panel        # debe decir "Panel del certificador en http://127.0.0.1:8080"
```

El servicio fija `TZ=America/Santiago` (las fechas que se declaran al SII son de Chile) y se
reinicia solo si se cae. Los logs: `journalctl -u certificador-panel -f`.

### 5. HTTPS con Nginx

El panel escucha solo en `127.0.0.1:8080`; Nginx lo publica con HTTPS.

```bash
cp /opt/certificador/panel/nginx-certificador.conf /etc/nginx/sites-available/certificador
nano /etc/nginx/sites-available/certificador     # cambiar certificador.konos.cl por el dominio real
ln -s /etc/nginx/sites-available/certificador /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
apt-get install -y certbot python3-certbot-nginx
certbot --nginx -d certificador.konos.cl
ufw allow OpenSSH && ufw allow 'Nginx Full' && ufw enable
```

La cookie de sesión va marcada `Secure`: sin HTTPS el login no funciona (a propósito). Para
probar en local sin HTTPS: `PANEL_COOKIE_SEGURA=0`.

## Qué respaldar

- `/opt/certificador/runs/` — el estado de cada certificación, los folios usados y los envíos.
  **Perderlo obliga a empezar de nuevo.** Respaldo diario recomendado.
- `/opt/certificador/empresas/` — los `.env` de las empresas (sin certificado).
- `/etc/certificador/` — el certificado y las claves. Respaldar cifrado, aparte.

## Actualizar

```bash
cd /opt/certificador
# reemplazar certificar.js si hay versión nueva
npm install --omit=dev github:KonosCL/dte-sii   # la última versión del fork
systemctl restart certificador-panel        # espera a que no haya corridas en curso
```

Un `npm install` solo no actualiza la librería: se queda con la versión anotada en
`package-lock.json`. "Ver sets del portal" dice si la librería instalada trae exportación.

## Seguridad de la fase 1 (y lo que falta)

- Una clave para todo el equipo, comparada en tiempo constante; 5 intentos fallidos bloquean la
  IP 15 minutos. Sesión de 12 horas en cookie `HttpOnly`, `SameSite=Strict`, `Secure`.
- Toda acción exige un encabezado propio del panel: un formulario de otro sitio no puede
  dispararla.
- Solo se aceptan comandos y argumentos de una lista cerrada; nunca pasan por una shell.
- Del `.env` subido se guardan solo variables conocidas; las que son rutas a archivos
  (`CERT_PATH`, `LOGO_PATH`, `INTERCAMBIO_XML_MANUAL`, `EXPORTACION_CODIGOS`) se descartan.
- Pendiente para la fase 2: usuarios con nombre y registro de quién corrió qué, relanzado
  automático de las etapas que esperan al SII, y certificados de clientes cifrados en disco.
