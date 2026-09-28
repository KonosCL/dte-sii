// Copyright (c) 2026 Devlas SpA — https://devlas.cl
// Licencia MIT. Ver archivo LICENSE para mas detalles.
/**
 * Fecha y hora en zona horaria de Chile, sin depender del TZ del proceso Node.
 *
 * `new Date().toISOString()` SIEMPRE devuelve UTC, sin importar el timezone del proceso — a
 * diferencia de `getDate()/getMonth()/getFullYear()` (que sí dependen de TZ y se arreglan seteando
 * `TZ=America/Santiago` en el entorno), `.toISOString()` nunca consulta esa variable. Chile va en
 * UTC-3 (sin horario de verano), así que un `TmstFirmaEnv` armado con `.toISOString()` queda
 * declarando que el documento se firmó ~3 horas en el futuro, y el SII lo rechaza con
 * "Error en Carátula" (confirmado con documentos reales: ver CLAUDE.md, "Bug conocido").
 *
 * @module dte-sii/utils/fecha-chile
 */

const TZ = 'America/Santiago'

const FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
  hour12: false,
})

/**
 * Fecha y hora actual en Chile, formato `YYYY-MM-DDTHH:MM:SS` (el que espera `TmstFirmaEnv` y
 * campos equivalentes del SII — sin milisegundos ni offset de zona).
 *
 * @param {Date} [d] - Instante a convertir (default: ahora).
 * @returns {string}
 */
function timestampChile(d) {
  const partes = FORMATTER.formatToParts(d || new Date())
  const get = (tipo) => partes.find((p) => p.type === tipo).value
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}`
}

module.exports = { timestampChile }
