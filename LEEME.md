# Exportación (110, 111, 112) + panel Ubuntu — entrega del 30-09-2026

Tres piezas:

| Carpeta | Qué es | Dónde va |
|---|---|---|
| `dte-sii-exportacion/` | Cambios a la librería (fork KonosCL/dte-sii) | El repo de GitHub, y después se instala en la carpeta del certificador (paso 1) |
| `certificar.js` | El runner con exportación y el comando `descargar` | Reemplaza el `certificar.js` actual |
| `panel/` | El proyecto del panel web para el servidor Ubuntu | `/opt/certificador/panel` (ver `panel/README.md`) |

`evidencia/` trae un set de exportación inventado, los sobres firmados que salieron de él y cuatro
muestras impresas en PDF, con la validación: esquema del SII, firmas y timbres, todo verificado.

## 1. Subir la librería

En GitHub, en KonosCL/dte-sii, subir los archivos de `dte-sii-exportacion/` respetando las carpetas
(`cert/`, `utils/`, `test/`, `scripts/` y los de la raíz). Son 15 modificados y 5 nuevos. Si lo haces
con git en vez de la web: `git apply exportacion.patch` sobre master.

Después, en la carpeta del certificador:

```
npm install github:KonosCL/dte-sii
```

Un `npm install` solo no alcanza: se queda con la versión anotada en `package-lock.json`. El paso
b dice si quedó bien instalada.

## 2. Probar con Konos, en este orden

**a. Dónde está Konos en el portal**

```
node certificar.js estado empresas/konos.env
```

- Si dice que la empresa **está autorizada**: se puede seguir.
- Si todavía está **a mitad** (por ejemplo, muestras en revisión): no sigas. Bajar un set nuevo
  reinicia la postulación y se pierde lo aprobado. Si igual lo corres, `descargar` se niega.

**b. Qué sets ofrece el portal (no descarga nada)**

```
node certificar.js descargar empresas/konos.env ver
```

Mándame esa salida. Dice si aparece "SET DOCUMENTOS DE EXPORTACION", si el portal pide también el
set básico y los libros, y si la librería instalada trae exportación ("Librería instalada: con
exportación"). Con eso decidimos dos variables del .env:

- `INCLUIR_BASICO=0` si el portal no exige el básico (la librería lo pedía siempre). Sin básico no
  hay libro de ventas, así que va junto con `PEDIR_LIBROS=0` (el runner lo exige).
- `PEDIR_LIBROS=0` si no exige libros.

**c. Bajar el set de exportación sin enviar nada**

En `empresas/konos.env`:

```
SETS_ADICIONALES=exportacion
```

```
node certificar.js descargar empresas/konos.env
```

Muestra cada caso como se va a emitir (montos, cláusula, puertos, país, bultos) y avisa lo que no
pudo traducir. El estado anterior de Konos queda guardado como `runs/<RUT>/estado.json.ronda-...`.
Mándame `runs/<RUT>/debug/set-texto.txt`: es el primer set de exportación real que vemos y con él
ajusto lo que falte.

**d. Certificar**

```
node certificar.js todo empresas/konos.env
```

Pide los folios 110/111/112, emite y envía los dos sets, declara y espera la aprobación. En una ronda
solo de exportación se saltan libros, simulación e intercambio, y sigue con las muestras impresas y la
declaración de cumplimiento.

Si el SII ya aprobó los sets pero el runner no encuentra su fila en la página de avance (puede pasar
con una empresa ya autorizada), avisa `SET_SIN_ESTADO_EN_PORTAL`. Revisas el portal y, si dice
aprobado, relanzas una vez con `CONFIRMAR_SETS_APROBADOS=1`.

## 3. Variables nuevas del .env

| Variable | Para qué |
|---|---|
| `SETS_ADICIONALES` | Ahora acepta `exportacion` y `ninguno` (antes había que poner una coma). Vacío sigue siendo guía, exenta y compra |
| `TIPO_CAMBIO` | `945,12` (dólar) o `DOLAR USA:945,12;EURO:1050,4`. Si falta, se toma el del día del Banco Central (mindicador.cl) |
| `RECEPTOR_EXTRANJERO_RAZON_SOCIAL`, `_GIRO`, `_DIRECCION`, `_CIUDAD` | Cliente extranjero de los documentos. Tienen valor por defecto |
| `COMISION_EXTRANJERO` | `R` o `D`, solo si el set trae comisiones sin decir si es recargo o descuento |
| `EXPORTACION_CODIGOS` | Ruta a un JSON (relativa a la carpeta del .env, como `CERT_PATH`) con códigos de Aduana para textos del set que las tablas no reconozcan |
| `INCLUIR_BASICO`, `PEDIR_LIBROS` | `0` para dejarlos fuera en una ronda de documentos nuevos |

De una sola corrida: `FORZAR_DESCARGA=1` para bajar el set aunque la empresa esté a mitad, y
`CONFIRMAR_SETS_APROBADOS=1` (ver 2d). Las dos están en el panel como casillas con confirmación.

## 4. Avisos nuevos

`DESCARGA_REINICIA_POSTULACION`, `SET_EXPORTACION_NO_DISPONIBLE`, `SET_EXPORTACION_NO_LEIDO`,
`EXPORTACION_CON_PROBLEMAS`, `SET_SIN_ESTADO_EN_PORTAL`, `TIPO_CAMBIO_FALTANTE`, `TIPO_CAMBIO_INVALIDO`,
`TIPO_CAMBIO_PENDIENTE`, `MONEDA_DESCONOCIDA`, `CONFIG_INVALIDA`, `CIERRE_POR_CONFIRMAR`. Conviene
sumarlos a `AVISOS.md`.

## 5. Arreglos que venían pendientes (sirven para la segunda ronda de WHOOO)

- Las muestras impresas solo toman los envíos de la ronda actual. Antes entraban los PDF de un set
  anulado, como pasó con la exenta de WHOOO.
- Un set ANULADO en el portal ya no cuenta como avance (era el `SET_REINICIO_NO_APLICADO` de WHOOO).
- `emitir` usa la fecha y la hora de Chile, no UTC.
- Detener una corrida (Ctrl+C o el botón del panel) ya no corta un envío al SII a la mitad: se
  termina, se guardan el TrackID y los folios usados, y se cierra la sesión SII antes de salir.
  Antes salía de inmediato: la sesión quedaba abierta ~30 minutos y un envío cortado podía dejar
  folios sin registrar.

## Algo que encontré y no cambié

El runner nunca reutiliza folios que quedaron en disco. Una función de la librería
(`_rangoYaConsumido`) pasó a ser asíncrona y `cafsServibles` la usa como si no lo fuera, así que
todo CAF en disco se da por consumido y siempre se piden folios nuevos al SII. Es la opción segura
(nunca repite un folio), pero pide más de lo necesario y eso acerca el racionamiento. Arreglarlo
cambia cómo se eligen los folios: prefiero verlo contigo antes de tocarlo.

## 6. Lo que todavía no está probado contra el SII

Todo lo de arriba está probado sin conexión con un set inventado. Una revisión aparte del código
encontró problemas en el runner, el panel y la librería; están corregidos, salvo uno: el panel
todavía no deja usar `EXPORTACION_CODIGOS` (es una ruta a un archivo). Si hace falta, el JSON y la
variable se dejan a mano en el servidor.

Contra el SII real falta:

- El formato exacto del set de exportación: la cláusula, el país, los decimales, si las comisiones
  son recargo o descuento, qué significa el "(**)" de flete y seguro. El comando `descargar`
  existe para verlo antes de gastar folios.
- Qué pide el portal a una empresa ya autorizada que agrega exportación: si exige básico, libros o
  simulación de nuevo. La simulación con documentos de exportación no está hecha: se ve si el portal
  la pide.
- Contenedores: el set no trae número de contenedor ni sello, y el SII podría pedirlos.
