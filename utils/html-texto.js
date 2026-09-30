// Copyright (c) 2026 Devlas SpA — https://devlas.cl
// Licencia MIT. Ver archivo LICENSE para mas detalles.
/**
 * Texto legible de una página HTML del SII, sin markup.
 *
 * Extraído de CafSolicitor.textoVisible (que lo mantiene como alias por
 * compatibilidad) para que otros módulos (SiiCertificacion) lo usen sin
 * depender de una clase que no tiene nada que ver con ellos.
 *
 * Para que un rechazo desconocido no se pierda: sin esto, el motivo real
 * queda solo en el HTML —que en producción no se guarda en disco entre
 * reinicios— y el consumidor ve una etiqueta corta (`ENVIO CON ERRORES O
 * REPAROS`) sin el detalle que el propio SII escribió en la página.
 *
 * @module utils/html-texto
 */
function textoVisible(html, max = 400) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&aacute;/gi, 'a').replace(/&eacute;/gi, 'e')
    .replace(/&iacute;/gi, 'i').replace(/&oacute;/gi, 'o').replace(/&uacute;/gi, 'u')
    .replace(/&ntilde;/gi, 'n').replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

module.exports = { textoVisible };
