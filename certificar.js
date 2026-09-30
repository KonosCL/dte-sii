#!/usr/bin/env node
/*
 * certificar.js — Runner de certificación DTE ante el SII
 *
 * © 2026 Konos Soluciones y Servicios Ltda. Todos los derechos reservados.
 *
 * CONFIDENCIAL. Este archivo es propiedad de Konos Soluciones y Servicios Ltda.
 * Contiene conocimiento operativo desarrollado y verificado contra el SII de Chile.
 * Queda prohibida su copia, distribución, modificación o uso fuera de Konos sin
 * autorización escrita. El acceso a este archivo implica la aceptación de esta
 * condición. La librería @devlas/dte-sii que utiliza tiene su propia licencia (MIT).
 */
//
// Avisos: cada caso de borde termina en un aviso con código estable (catálogo en AVISOS.md).
//   Salida legible por máquina: líneas [AVISO]{json} y una línea final [RESULTADO]{json};
//   copia en runs/<RUT>/avisos.jsonl. Código de salida: 0 ok · 2 esperando al SII · 1 acción requerida · 130 interrumpido.
//
// Uso:
//   node certificar.js <etapa> <archivo.env>
//
//   node certificar.js datos       empresas/kaura.env   → trae del portal SII dirección, comuna y fecha de resolución y los escribe en el .env
//   node certificar.js folios      empresas/kaura.env 33 4 56 4 61 7  → pide folios de a uno cuando el SII raciona, todos en una sesión
//   node certificar.js anular      empresas/kaura.env 61   → anula folios viejos sin usar de un tipo (destraba TIMBRAJE_BLOQUEADO)
//   node certificar.js anular      empresas/kaura.env 61 1-7 → anula un rango exacto (se niega si toca folios de sets vigentes o servibles)
//   node certificar.js emitir      empresas/kaura.env 33 34 52 → emite como relleno los folios sobrantes en disco de esos tipos (paga las "advertencias" del SII)
//   node certificar.js rehacer     empresas/kaura.env basico exenta → desmarca sets rechazados para que "todo" los reenvíe con folios nuevos;
//                                                         si el envío fue rechazado entero, sus folios se anulan solo si el SII bloquea ese tipo
//   node certificar.js consultar   empresas/kaura.env [trackId ...] → estado de cada envío en el SII (sin argumentos: los sets enviados)
//   node certificar.js declarar    empresas/kaura.env   → declara en el portal los sets ya enviados, aunque falte alguno (el SII los revisa mientras tanto)
//   node certificar.js logout      empresas/kaura.env   → cierra la sesión SII guardada (si quedó una abierta)
//   node certificar.js estado      empresas/kaura.env   → dónde va la certificación en el portal
//   node certificar.js descargar   empresas/kaura.env [ver] → baja el set de pruebas SIN enviar nada y muestra qué se va a emitir;
//                                                         con "ver" solo muestra qué sets ofrece el portal. Se niega si la
//                                                         empresa está a mitad de certificación (FORZAR_DESCARGA=1 para forzar)
//   node certificar.js sets        empresas/kaura.env   → Etapa 1: set de pruebas
//   node certificar.js libros      empresas/kaura.env   → Etapa 2: libros
//   node certificar.js simulacion  empresas/kaura.env   → Etapa 3: simulación
//   node certificar.js intercambio empresas/kaura.env   → Etapa 4: intercambio
//   node certificar.js muestras    empresas/kaura.env   → Etapa 5: muestras impresas
//   node certificar.js cierre      empresas/kaura.env   → Etapa 6: declaración de cumplimiento
//   node certificar.js todo        empresas/kaura.env   → todas en orden; se detiene si hay que esperar al SII
//
// En el .env de la empresa, SETS_ADICIONALES dice qué sets pedir al SII además del básico:
// guia, exenta, compra, exportacion (por defecto guia,exenta,compra), o "ninguno" para el
// básico solo. Poner solo lo que el cliente compró; lo que se pide queda exigido en el portal.
// Solo aplica al descargar el set (primera corrida).
//
// Exportación (110, 111, 112): el SII entrega dos sets ("SET DOCUMENTOS DE EXPORTACION" y
// "...(2)"). Tipo de cambio: TIPO_CAMBIO=945.12 (dólar) o TIPO_CAMBIO=DOLAR USA:945,12;EURO:1050,4
// en el .env; si no está, se toma el del día del Banco Central (mindicador.cl). Receptor:
// RECEPTOR_EXTRANJERO_RAZON_SOCIAL / _GIRO / _DIRECCION / _CIUDAD (hay valores por defecto).
// Ronda de documentos nuevos en una empresa ya autorizada: "descargar" archiva el estado anterior;
// PEDIR_LIBROS=0 e INCLUIR_BASICO=0 dejan fuera los libros y el set básico si el portal no los pide.
// CONFIRMAR_SETS_APROBADOS=1 (una corrida): da los sets por aprobados cuando el portal ya los
// muestra aprobados pero su página de avance no trae la fila que el runner lee.
//
// Un servidor sirve para todas las empresas: cada una tiene su archivo en empresas/
// y su directorio de trabajo en runs/<RUT>/. Se pueden correr varias a la vez.
//
// El estado se persiste en runs/<RUT>/estado.json. Si el proceso se cae o el SII
// tarda en aprobar, se relanza el mismo comando y retoma donde quedó.
//
// REGLAS QUE ESTE SCRIPT IMPONE SOBRE LA LIBRERÍA (aprendidas contra el SII real):
//  1. UNA sola sesión SII por proceso, compartida por todos los componentes; el SII
//     admite una sesión autenticada por certificado y no libera el cupo al instante.
//  2. Cierre de sesión por el endpoint real del portal (autTermino.cgi) al terminar
//     cada comando, incluso si falla.
//  3. Tras el login con certificado el SII devuelve una página con redirección por
//     JavaScript; se sigue esa redirección (la librería la tomaba por login fallido).
//  4. Folios SET POR SET: una solicitud exacta; si el SII raciona, de a uno. Nunca se
//     piden folios de otros sets por adelantado. Nunca se usa la "vía normal" de la
//     librería (reobtiene CAF viejos y reusa folios anulados).
//  5. La anulación automática solo toca folios ANTERIORES a cualquiera nuestro en disco
//     (usado o no): un folio recién enviado se ve "sin usar" unos segundos en el SII.
//  6. obtenerSets() REINICIA la postulación en el SII: se llama una sola vez.
//  7. Simulación con 22 documentos y pocas notas (3 NC, 1 ND).
//  8. Muestras impresas: TODOS los PDF del set y la simulación (con cedibles), sin
//     relleno, sin fiarse de aprobaciones de certificaciones anteriores.
//  9. Las tildes y ñ del set NO se tocan: el SII compara los nombres de los productos
//     con el set ("Cajon" en vez de "Cajón" = CONTENIDO NO CORRESPONDE). La librería firma
//     bien con tildes y envía en ISO-8859-1 (verificado con xmlsec1). Ojo: el envio.xml de
//     historicos/ se guarda en UTF-8 aunque se envíe en ISO-8859-1; no sirve para
//     diagnosticar codificación.
// 10. Timbraje (lo que mide el SII, confirmado con las notas de la librería):
//     - FOLIOS_DISP = timbrados - emitidos - anulados. Con folios sin usar el SII advierte,
//       raciona y al final BLOQUEA el tipo; para levantarlo pide "emitir y enviar documentos
//       o anular folios, en cantidad equivalente a los timbrajes en que se le advirtió".
//     - Los folios ANULADOS pesan 6 meses en contra del cupo: anular alivia hoy y puede
//       dejar el tipo sin salida mañana (así quedó la nota de débito de un cliente).
//     - Un folio de un envío que viajó no se reusa (el SII ya lo vio).
//     Por eso: no se pide un tipo mientras el SII no procesa el envío anterior que lo usó
//     (si no, cuenta como "sin usar" y dispara el racionamiento); los folios de un envío
//     rechazado se anulan SOLO si el SII bloquea ese tipo; y tras un bloqueo no se insiste
//     antes de una hora.

'use strict';

process.env.TZ = process.env.TZ || 'America/Santiago';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ─────────────────────────────────────────────────────────────────
// Avisos: salida para personas y para la futura interfaz
// ─────────────────────────────────────────────────────────────────
// Todo caso de borde termina en un aviso con código estable (catálogo en AVISOS.md). Además
// del texto, cada aviso imprime una línea "[AVISO]{json}" y cada comando cierra con
// "[RESULTADO]{json}", para que un servidor o una interfaz gráfica lean el resultado sin
// interpretar el texto. Los avisos quedan también en runs/<RUT>/avisos.jsonl.
//
// Códigos de salida del proceso: 0 = terminó bien · 2 = detenido esperando al SII (relanzar
// más tarde) · 1 = requiere una acción (la indica el aviso).
const avisosEmitidos = [];
let AVISOS_PATH = null;
let RUT_ACTUAL = null;
const COMANDO = process.argv[2] || null;

function emitirAviso(codigo, mensaje, { nivel = 'error', accion = null, datos = null } = {}) {
  const a = { codigo, nivel, mensaje, accion, datos, rut: RUT_ACTUAL, comando: COMANDO, fecha: new Date().toISOString() };
  avisosEmitidos.push(a);
  const icono = nivel === 'error' ? '✗' : nivel === 'advertencia' ? '⚠' : 'ℹ';
  const out = nivel === 'error' ? console.error : console.log;
  out(`\n${icono} [${codigo}] ${mensaje}`);
  if (accion) out(`  → ${String(accion).split('\n').join('\n    ')}`);
  out(`[AVISO]${JSON.stringify(a)}`);
  if (AVISOS_PATH) {
    try {
      fs.mkdirSync(path.dirname(AVISOS_PATH), { recursive: true });
      fs.appendFileSync(AVISOS_PATH, JSON.stringify(a) + '\n');
    } catch (_) {}
  }
  return a;
}

function emitirResultado(estadoFinal, extra = {}) {
  console.log(`[RESULTADO]${JSON.stringify({
    estado: estadoFinal, comando: COMANDO, rut: RUT_ACTUAL,
    avisos: avisosEmitidos.map((a) => a.codigo), ...extra,
  })}`);
}

// Salida temprana (antes de tener runner ni sesión SII abierta).
function salir(codigo, mensaje, opciones = {}) {
  emitirAviso(codigo, mensaje, opciones);
  emitirResultado('error', { codigo });
  process.exit(1);
}
const ETAPAS_VALIDAS = ['datos', 'folios', 'anular', 'emitir', 'rehacer', 'consultar', 'declarar', 'logout', 'estado', 'descargar', 'sets', 'libros', 'simulacion', 'intercambio', 'muestras', 'cierre', 'todo'];
if (!process.argv[2] || !ETAPAS_VALIDAS.includes(process.argv[2])) {
  console.log('Uso: node certificar.js <' + ETAPAS_VALIDAS.join('|') + '> empresas/<empresa>.env');
  console.log('Ej.: node certificar.js estado empresas/kaura.env');
  if (process.argv[2]) salir('COMANDO_INVALIDO', `Comando desconocido: "${process.argv[2]}".`, { accion: 'Comandos válidos: ' + ETAPAS_VALIDAS.join(', ') });
  process.exit(0);
}

const ENV_FILE = path.resolve(__dirname, process.argv[3] || process.env.ENV_FILE || '.env');
if (!process.argv[3] && !process.env.ENV_FILE) {
  salir('ARCHIVO_EMPRESA_NO_INDICADO', 'Falta indicar el archivo de la empresa.', { accion: `Ej.: node certificar.js ${process.argv[2]} empresas/<empresa>.env` });
}
if (!fs.existsSync(ENV_FILE)) {
  salir('ARCHIVO_EMPRESA_NO_EXISTE', `No existe el archivo de empresa: ${ENV_FILE}`, {
    accion: 'Copia empresas/ejemplo.env.example como empresas/<empresa>.env y complétalo.',
  });
}
// Si faltan dependencias (carpeta recién descargada o npm install incompleto), se explica
// qué hacer en vez de mostrar el error crudo de Node.
function requerirModulo(nombre) {
  try {
    return require(nombre);
  } catch (e) {
    if (e.code === 'MODULE_NOT_FOUND') {
      salir('DEPENDENCIAS_FALTANTES', `Faltan dependencias de Node (${nombre}): ${String(e.message).split('\n')[0]}`, {
        accion: 'En esta carpeta corre: npm install\n' +
          'Si npm falla con EACCES: sudo chown -R $(id -u):$(id -g) ~/.npm y de nuevo npm install, sin sudo.',
      });
    }
    throw e;
  }
}

requerirModulo('dotenv').config({ path: ENV_FILE, quiet: true });
const ENV_DIR = path.dirname(ENV_FILE);

const { CertRunner } = requerirModulo('@devlas/dte-sii/cert');
const MuestrasImpresas = requerirModulo('@devlas/dte-sii/cert/MuestrasImpresas');
const { getOficinaForComuna } = requerirModulo('@devlas/dte-sii/cert/comunaOficina');
const SiiPortalAuth = requerirModulo('@devlas/dte-sii/SiiPortalAuth');

// ─────────────────────────────────────────────────────────────────
// Configuración
// ─────────────────────────────────────────────────────────────────

const ES_DATOS = process.argv[2] === 'datos';

function requerir(nombre) {
  const v = process.env[nombre];
  if (!v) {
    if (ES_DATOS && !['EMISOR_RUT', 'CERT_PATH'].includes(nombre)) return '';
    salir('CONFIG_FALTANTE', `Falta la variable ${nombre} en ${path.relative(__dirname, ENV_FILE)}.`, {
      accion: ['EMISOR_RUT', 'CERT_PATH'].includes(nombre)
        ? 'Complétala en el .env.'
        : 'Complétala o corre: node certificar.js datos ' + path.relative(__dirname, ENV_FILE),
      datos: { variable: nombre },
    });
  }
  return v;
}

const RUT = requerir('EMISOR_RUT');
const RUN_DIR = path.resolve(__dirname, 'runs', RUT.replace(/[^0-9kK-]/g, ''));
// La librería guarda CAF, sesiones y páginas de debug en DATADIR (por defecto /tmp).
// Se fija al directorio de la empresa para que nada quede en el temporal del sistema.
process.env.DATADIR = RUN_DIR;
const ESTADO_PATH = path.join(RUN_DIR, 'estado.json');
RUT_ACTUAL = RUT;
AVISOS_PATH = path.join(RUN_DIR, 'avisos.jsonl');

const config = {
  ambiente: 'certificacion',
  certificado: {
    path: path.resolve(ENV_DIR, requerir('CERT_PATH')),
    password: process.env.CERT_PASSWORD ?? '',
  },
  emisor: {
    rut: RUT,
    razon_social: requerir('EMISOR_RAZON_SOCIAL'),
    giro: requerir('EMISOR_GIRO'),
    acteco: requerir('EMISOR_ACTECO'),
    direccion: requerir('EMISOR_DIRECCION'),
    comuna: requerir('EMISOR_COMUNA'),
    ciudad: process.env.EMISOR_CIUDAD || process.env.EMISOR_COMUNA,
    // En certificación NroResol es siempre 0. FchResol la entrega el SII al postular
    // (aparece en "Datos para la construcción de DTE" del ambiente de certificación).
    fch_resol: requerir('FECHA_RESOLUCION_CERT'),
    nro_resol: 0,
  },
  receptor: {
    rut: process.env.RECEPTOR_RUT || '66666666-6',
    razon_social: process.env.RECEPTOR_RAZON_SOCIAL || 'EMPRESA EJEMPLO SPA',
    giro: process.env.RECEPTOR_GIRO || 'COMERCIO',
    direccion: process.env.RECEPTOR_DIRECCION || 'AV EJEMPLO 123',
    comuna: process.env.RECEPTOR_COMUNA || 'SANTIAGO',
    ciudad: process.env.RECEPTOR_CIUDAD || 'SANTIAGO',
  },
  // Exportación: el set no define receptor; el RUT lo fija la librería (55555555-5) y la
  // nacionalidad sale del país del caso.
  receptorExtranjero: {
    razon_social: process.env.RECEPTOR_EXTRANJERO_RAZON_SOCIAL || 'CLIENTE EXTRANJERO',
    giro: process.env.RECEPTOR_EXTRANJERO_GIRO || 'IMPORTADOR',
    direccion: process.env.RECEPTOR_EXTRANJERO_DIRECCION || 'SIN DIRECCION',
    ...(process.env.RECEPTOR_EXTRANJERO_CIUDAD ? { ciudad: process.env.RECEPTOR_EXTRANJERO_CIUDAD } : {}),
  },
  // tiposCambio se completa justo antes de emitir (ver tiposDeCambio); codigos y comisionComo
  // son para textos del set que las tablas de Aduana no resuelven.
  exportacion: {
    tiposCambio: {},
    codigos: leerCodigosExportacion(),
    ...(process.env.COMISION_EXTRANJERO ? { comisionComo: process.env.COMISION_EXTRANJERO.toUpperCase() } : {}),
  },
  debugDir: path.join(RUN_DIR, 'debug'),
  stateDir: path.join(RUN_DIR, 'state'),
  sessionPath: path.join(RUN_DIR, 'session.json'),
};

// Glosas de moneda del set que la librería no reconoce: { "monedas": { "TEXTO": "DOLAR USA" } }.
if (config.exportacion.codigos?.monedas) config.exportacion.monedas = config.exportacion.codigos.monedas;

// EXPORTACION_CODIGOS=codigos-exportacion.json, relativa a la carpeta del .env (como CERT_PATH):
// { "puerto": { "TEXTO DEL SET": 906 }, ... }
function leerCodigosExportacion() {
  const archivo = process.env.EXPORTACION_CODIGOS;
  if (!archivo) return {};
  const ruta = path.resolve(ENV_DIR, archivo);
  try {
    return JSON.parse(fs.readFileSync(ruta, 'utf8'));
  } catch (e) {
    salir('CONFIG_INVALIDA', `No se pudo leer EXPORTACION_CODIGOS (${ruta}): ${e.message}`, {
      accion: 'Debe ser un JSON como { "puerto": { "TEXTO DEL SET": 906 } }.',
    });
  }
}

// La exportación está en el fork KonosCL/dte-sii. Un `npm install` solo se queda con el commit
// anotado en package-lock.json, por eso la instrucción pide el fork explícitamente.
const ACTUALIZAR_LIBRERIA = 'Sube la librería nueva a KonosCL/dte-sii y, en esta carpeta, corre:\n' +
  '  npm install github:KonosCL/dte-sii\n' +
  '(un npm install solo se queda con la versión anotada en package-lock.json).';
function libreriaConExportacion(runner) {
  return typeof runner.ejecutarSetExportacion1 === 'function';
}
function exigirLibreriaConExportacion(runner) {
  if (!libreriaConExportacion(runner)) {
    fallar('La librería instalada no trae los sets de exportación.', 'LIBRERIA_INCOMPATIBLE', { accion: ACTUALIZAR_LIBRERIA });
  }
}

// Sets de pruebas que corre el runner: nombre, clave de la estructura y método de la librería.
const SETS = [
  ['basico', 'setBasico', 'ejecutarSetBasico'],
  ['guia', 'setGuiaDespacho', 'ejecutarSetGuia'],
  ['exenta', 'setFacturaExenta', 'ejecutarSetExenta'],
  ['compra', 'setFacturaCompra', 'ejecutarSetCompra'],
  ['exportacion1', 'setExportacion1', 'ejecutarSetExportacion1'],
  ['exportacion2', 'setExportacion2', 'ejecutarSetExportacion2'],
];
const NOMBRES_SETS = SETS.map(([n]) => n);
const ESTRUCTURA_DE = Object.fromEntries(SETS.map(([n, e]) => [n, e]));

// SETS_ADICIONALES → conjunto de sets pedidos además del básico. Sin la variable o vacía: guía,
// exenta y compra (lo que ya hacía "todo"). "ninguno" (o solo una coma): solo el básico.
function setsAdicionales() {
  const crudo = process.env.SETS_ADICIONALES;
  if (crudo === undefined || !String(crudo).trim()) return new Set(['guia', 'exenta', 'compra']);
  const valores = String(crudo).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .split(/[\s,;]+/).filter(Boolean);
  if (valores.includes('ninguno')) return new Set();
  return new Set(valores.map((v) => (v === 'export' ? 'exportacion' : v)));
}

// Sets que esta empresa ejecuta: el básico, más los adicionales (exportación son dos).
function setsContratados() {
  const out = new Set(['basico']);
  for (const s of setsAdicionales()) {
    if (s === 'exportacion') { out.add('exportacion1'); out.add('exportacion2'); } else out.add(s);
  }
  return out;
}

// Polling: cuánto esperar al SII antes de rendirse en esta corrida
const POLL = {
  maxIntentos: parseInt(process.env.POLL_MAX_INTENTOS || '30', 10),
  intervalo: parseInt(process.env.POLL_INTERVALO_MS || '60000', 10),
};

// ─────────────────────────────────────────────────────────────────
// Validación previa: errores de configuración antes de tocar el SII
// ─────────────────────────────────────────────────────────────────

function dvRut(numero) {
  let suma = 0;
  let mult = 2;
  for (let i = numero.length - 1; i >= 0; i--) {
    suma += Number(numero[i]) * mult;
    mult = mult === 7 ? 2 : mult + 1;
  }
  const r = 11 - (suma % 11);
  return r === 11 ? '0' : r === 10 ? 'K' : String(r);
}

function rutValido(rut) {
  const m = String(rut || '').toUpperCase().match(/^(\d{7,8})-([\dK])$/);
  return !!m && dvRut(m[1]) === m[2];
}

// Largos máximos del esquema DTE del SII para los datos que salen del .env.
const LARGOS_SII = [
  ['EMISOR_RAZON_SOCIAL', 'razon_social', 'emisor', 100],
  ['EMISOR_GIRO', 'giro', 'emisor', 80],
  ['EMISOR_DIRECCION', 'direccion', 'emisor', 70],
  ['EMISOR_COMUNA', 'comuna', 'emisor', 20],
  ['EMISOR_CIUDAD', 'ciudad', 'emisor', 20],
  ['RECEPTOR_RAZON_SOCIAL', 'razon_social', 'receptor', 100],
  ['RECEPTOR_GIRO', 'giro', 'receptor', 40],
  ['RECEPTOR_DIRECCION', 'direccion', 'receptor', 70],
  ['RECEPTOR_COMUNA', 'comuna', 'receptor', 20],
];

let CERT_INFO = null; // { rut, nombre, vence } del certificado cargado

function validarConfig() {
  const env = path.relative(__dirname, ENV_FILE);

  if (!rutValido(RUT)) {
    fallar(`EMISOR_RUT "${RUT}" no es un RUT válido.`, 'RUT_INVALIDO', {
      accion: `Escríbelo sin puntos, con guion y dígito verificador correcto (ej. 76177917-6) en ${env}.`,
    });
  }
  if (config.receptor.rut && !rutValido(config.receptor.rut)) {
    fallar(`RECEPTOR_RUT "${config.receptor.rut}" no es un RUT válido.`, 'RUT_RECEPTOR_INVALIDO', {
      accion: 'Usa 66666666-6 o un RUT real válido.',
    });
  }

  // Certificado: existe, abre con la clave, vigente.
  if (!fs.existsSync(config.certificado.path)) {
    fallar(`No se encuentra el certificado: ${config.certificado.path}`, 'CERT_NO_ENCONTRADO', {
      accion: `Deja el .pfx en empresas/ y revisa CERT_PATH en ${env} (la ruta es relativa al .env).`,
    });
  }
  try {
    const { Certificado } = requerirModulo('@devlas/dte-sii');
    const cert = new Certificado(fs.readFileSync(config.certificado.path), config.certificado.password);
    const vence = cert.cert?.validity?.notAfter ? new Date(cert.cert.validity.notAfter) : null;
    CERT_INFO = { rut: cert.rut, nombre: cert.nombre, vence: vence ? vence.toISOString().slice(0, 10) : null };
  } catch (e) {
    const m = String(e.message || e);
    if (/contrase|password|mac verify|pkcs12/i.test(m)) {
      fallar('La clave del certificado no corresponde.', 'CERT_CLAVE_INCORRECTA', { accion: `Revisa CERT_PASSWORD en ${env}.` });
    }
    if (/expirad|expired/i.test(m)) {
      fallar(`El certificado está vencido (${m}).`, 'CERT_VENCIDO', { accion: 'Renueva el certificado digital y reemplaza el .pfx.' });
    }
    fallar(`No se pudo leer el certificado: ${m}`, 'CERT_INVALIDO', { accion: 'Verifica que el archivo sea un .pfx/.p12 válido.' });
  }
  if (CERT_INFO.vence) {
    const dias = Math.floor((Date.parse(CERT_INFO.vence) - Date.now()) / 86400000);
    if (dias <= 15) {
      emitirAviso('CERT_POR_VENCER', `El certificado vence en ${dias} día(s) (${CERT_INFO.vence}).`, {
        nivel: 'advertencia', accion: 'Renuévalo antes de que termine la certificación: el SII revisa las muestras hasta 7 días hábiles.',
      });
    }
  }
  log(`Certificado: ${CERT_INFO.nombre || '(sin nombre)'} · RUT ${CERT_INFO.rut || '?'} · vence ${CERT_INFO.vence || '?'}`);

  if (ES_DATOS) return;

  const fecha = config.emisor.fch_resol;
  const f = /^(\d{4})-(\d{2})-(\d{2})$/.exec(fecha || '');
  const fechaMs = f ? Date.UTC(+f[1], +f[2] - 1, +f[3]) : NaN;
  if (!f || Number.isNaN(fechaMs) || new Date(fechaMs).getUTCDate() !== +f[3]) {
    fallar(`FECHA_RESOLUCION_CERT "${fecha}" no es una fecha válida.`, 'FECHA_RESOLUCION_INVALIDA', {
      accion: `Formato AAAA-MM-DD, normalmente el día de la postulación. O corre: node certificar.js datos ${env}`,
    });
  }
  const hoy = new Date().toLocaleDateString('sv-SE', { timeZone: process.env.TZ });
  if (fecha > hoy) {
    fallar(`FECHA_RESOLUCION_CERT ${fecha} está en el futuro.`, 'FECHA_RESOLUCION_INVALIDA', {
      accion: 'Usa la fecha de la postulación (la muestra el portal en Actualizar datos empresa).',
    });
  }
  if ((Date.now() - fechaMs) / 86400000 > 180) {
    emitirAviso('FECHA_RESOLUCION_ANTIGUA', `La fecha de resolución ${fecha} tiene más de 6 meses.`, {
      nivel: 'advertencia',
      accion: 'El SII elimina del ambiente de certificación a quien no tiene actividad en 6 meses. Si el portal no muestra la postulación, hay que postular de nuevo.',
    });
  }

  if (!/^\d{6}$/.test(String(config.emisor.acteco))) {
    fallar(`EMISOR_ACTECO "${config.emisor.acteco}" no es un código de actividad (6 dígitos).`, 'ACTECO_INVALIDO', {
      accion: 'Usa un código de actividad vigente y afecto a IVA de la empresa (ficha tributaria del SII).',
    });
  }

  const crudoSets = String(process.env.SETS_ADICIONALES ?? '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .split(/[\s,;]+/).filter(Boolean);
  const invalidos = crudoSets.filter((x) => !['guia', 'exenta', 'compra', 'exportacion', 'export', 'ninguno'].includes(x));
  if (invalidos.length) {
    fallar(`SETS_ADICIONALES tiene valores desconocidos: ${invalidos.join(', ')}.`, 'SETS_ADICIONALES_INVALIDO', {
      accion: 'Valores posibles: guia, exenta, compra, exportacion (separados por coma), o "ninguno" para el básico solo.',
    });
  }
  if (crudoSets.includes('ninguno') && crudoSets.length > 1) {
    fallar('SETS_ADICIONALES mezcla "ninguno" con otros sets.', 'SETS_ADICIONALES_INVALIDO', {
      accion: 'Usa "ninguno" solo (básico) o la lista de sets adicionales, no ambas cosas.',
    });
  }
  if (process.env.TIPO_CAMBIO) {
    try { leerTipoCambioEnv(); } catch (e) {
      fallar(`TIPO_CAMBIO no se entiende: ${e.message}`, 'TIPO_CAMBIO_INVALIDO', {
        accion: 'Ejemplos: TIPO_CAMBIO=945.12 (dólar) · TIPO_CAMBIO=DOLAR USA:945,12;EURO:1050,4',
      });
    }
  }
  if (process.env.INCLUIR_BASICO === '0' && process.env.PEDIR_LIBROS !== '0') {
    fallar('INCLUIR_BASICO=0 sin PEDIR_LIBROS=0: el libro de ventas del SII se arma con el set básico.', 'CONFIG_INVALIDA', {
      accion: 'Si el portal no pide el básico, tampoco pide libros: agrega PEDIR_LIBROS=0.',
    });
  }
  if (process.env.COMISION_EXTRANJERO && !['R', 'D'].includes(process.env.COMISION_EXTRANJERO.toUpperCase())) {
    fallar('COMISION_EXTRANJERO debe ser R (recargo) o D (descuento).', 'CONFIG_INVALIDA');
  }

  for (const [variable, campo, grupo, max] of LARGOS_SII) {
    const v = config[grupo][campo];
    if (typeof v === 'string' && v.length > max) {
      emitirAviso('DATO_MUY_LARGO', `${variable} tiene ${v.length} caracteres; el SII acepta hasta ${max}.`, {
        nivel: 'advertencia', accion: `Acórtalo en ${env}; si no, el SII puede rechazar el documento.`, datos: { variable, largo: v.length, max },
      });
    }
  }
}

// ─────────────────────────────────────────────────────────────────
// Bloqueos: una corrida por empresa y una sesión SII por certificado
// ─────────────────────────────────────────────────────────────────
// El SII admite una sola sesión por certificado; dos corridas con el mismo certificado (aunque
// sean empresas distintas) se cierran la sesión una a otra. En un servidor esto pasa seguido.

const BLOQUEOS_DIR = path.resolve(__dirname, 'runs', '.bloqueos');
const bloqueosTomados = [];

function procesoVivo(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function tomarBloqueo(clave, codigo, descripcion) {
  fs.mkdirSync(BLOQUEOS_DIR, { recursive: true });
  const archivo = path.join(BLOQUEOS_DIR, `${clave}.lock`);
  if (fs.existsSync(archivo)) {
    let otro = null;
    try { otro = JSON.parse(fs.readFileSync(archivo, 'utf8')); } catch (_) {}
    if (otro?.pid && otro.pid !== process.pid && procesoVivo(otro.pid)) {
      fallar(`${descripcion} ya está en uso por otra corrida (comando "${otro.comando}", empresa ${otro.rut}, desde ${otro.desde}).`, codigo, {
        accion: 'Espera a que termine esa corrida. Si no hay ninguna corriendo, borra ' + path.relative(__dirname, archivo),
        datos: otro,
      });
    }
  }
  fs.writeFileSync(archivo, JSON.stringify({ pid: process.pid, comando: COMANDO, rut: RUT, desde: new Date().toISOString() }));
  bloqueosTomados.push(archivo);
}

function liberarBloqueos() {
  for (const archivo of bloqueosTomados) {
    try {
      const b = JSON.parse(fs.readFileSync(archivo, 'utf8'));
      if (b.pid === process.pid) fs.unlinkSync(archivo);
    } catch (_) {}
  }
}
process.on('exit', liberarBloqueos);
// Detención (Ctrl+C o el botón Detener del panel). Dos reglas:
//  - Durante un envío al SII (folios en vuelo) no se corta: se termina el envío y se guarda su
//    TrackID y sus folios usados. Cortar ahí dejaba folios vistos por el SII sin registrar, y la
//    corrida siguiente los reusaba (rechazo del envío completo).
//  - Antes de salir se cierra la sesión SII: si no, el certificado queda con una sesión abierta
//    ~30 minutos y la corrida siguiente choca con "máximo de sesiones".
let RUNNER_ACTUAL = null;
let SECCION_CRITICA = 0;
let DETENER_PEDIDO = null;

async function salirInterrumpido() {
  try {
    if (RUNNER_ACTUAL) await Promise.race([cerrarSesiones(RUNNER_ACTUAL), new Promise((r) => setTimeout(r, 8000))]);
  } catch (_) {}
  emitirResultado('interrumpido');
  process.exit(130);
}

// Corre fn sin que una detención la corte a la mitad.
async function sinInterrumpir(fn) {
  SECCION_CRITICA++;
  try {
    return await fn();
  } finally {
    SECCION_CRITICA--;
    if (DETENER_PEDIDO && SECCION_CRITICA === 0) await salirInterrumpido();
  }
}

for (const senal of ['SIGINT', 'SIGTERM']) {
  process.on(senal, () => {
    if (DETENER_PEDIDO) return;
    DETENER_PEDIDO = senal;
    emitirAviso('INTERRUMPIDO', `Corrida interrumpida (${senal}).`, {
      nivel: 'advertencia', accion: 'Relanza el mismo comando: retoma donde quedó.',
    });
    if (SECCION_CRITICA > 0) {
      log('Hay un envío al SII en curso: se termina y se registra antes de salir.');
      return;
    }
    salirInterrumpido();
  });
}

function tomarBloqueos() {
  tomarBloqueo(`rut-${RUT}`, 'PROCESO_EN_CURSO', `La empresa ${RUT}`);
  const hash = crypto.createHash('sha1').update(fs.readFileSync(config.certificado.path)).digest('hex').slice(0, 12);
  tomarBloqueo(`cert-${hash}`, 'CERTIFICADO_EN_USO', `El certificado ${path.basename(config.certificado.path)}`);
}

// ─────────────────────────────────────────────────────────────────
// Estado persistido
// ─────────────────────────────────────────────────────────────────

function cargarEstado() {
  if (!fs.existsSync(ESTADO_PATH)) {
    return { etapas: {}, estructuras: null, resultados: {}, log: [] };
  }
  try {
    return JSON.parse(fs.readFileSync(ESTADO_PATH, 'utf8'));
  } catch (e) {
    fallar(`El archivo de estado ${path.relative(__dirname, ESTADO_PATH)} está dañado (${e.message}).`, 'ESTADO_CORRUPTO', {
      accion: 'Restaura el respaldo más reciente (estado.json.bak*) de esa carpeta. No borres runs/<RUT>/: tiene los folios usados.',
    });
  }
}

function guardarEstado(estado) {
  fs.mkdirSync(RUN_DIR, { recursive: true });
  fs.writeFileSync(ESTADO_PATH, JSON.stringify(estado, null, 2));
}

function marcar(estado, etapa, datos = {}) {
  estado.etapas[etapa] = { ok: true, fecha: new Date().toISOString(), ...datos };
  estado.log.push({ fecha: new Date().toISOString(), etapa, ...datos });
  guardarEstado(estado);
}

function hecha(estado, etapa) {
  return estado.etapas[etapa]?.ok === true;
}

function log(msg) {
  console.log(`[${new Date().toLocaleTimeString('es-CL')}] ${msg}`);
}

// Fecha y hora de Chile (AAAA-MM-DD y AAAA-MM-DDTHH:MM:SS). toISOString() es UTC y de noche
// ya marca el día siguiente.
function fechaChile() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Santiago' });
}
function horaChile() {
  return new Date().toLocaleString('sv-SE', { timeZone: 'America/Santiago', hour12: false }).replace(' ', 'T');
}

// ─────────────────────────────────────────────────────────────────
// Tipo de cambio (exportación)
// ─────────────────────────────────────────────────────────────────
// OtraMoneda es obligatorio en exportación, con el tipo de cambio del Banco Central del día de
// emisión. Orden: TIPO_CAMBIO del .env, el del mismo día guardado en estado.json, y si no,
// mindicador.cl (publica el dólar observado y el euro del Banco Central).

// "945.12", "945,12" y "1.050,37" (con punto y coma, el último separador es el decimal). Un
// punto seguido de exactamente tres dígitos es de miles, como se escribe en Chile: "1.050" = 1050.
function numeroEnv(texto) {
  let t = String(texto).trim();
  const coma = t.lastIndexOf(',');
  const punto = t.lastIndexOf('.');
  if (coma > -1 && punto > -1) t = coma > punto ? t.replace(/\./g, '').replace(',', '.') : t.replace(/,/g, '');
  else if (coma > -1) t = t.replace(',', '.');
  else if (/^\d{1,3}(\.\d{3})+$/.test(t)) t = t.replace(/\./g, '');
  const n = Number(t);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`"${texto}" no es un número positivo`);
  return n;
}

// "945.12" → { 'DOLAR USA': 945.12 }; "DOLAR USA:945,12;EURO:1050,4" → las dos.
function leerTipoCambioEnv() {
  const crudo = String(process.env.TIPO_CAMBIO || '').trim();
  if (!crudo) return {};
  if (!/[A-Za-z]/.test(crudo)) return { 'DOLAR USA': numeroEnv(crudo) };
  const out = {};
  for (const par of crudo.split(';').map((x) => x.trim()).filter(Boolean)) {
    const m = par.match(/^(.+?)\s*[:=]\s*([\d.,]+)$/);
    if (!m) throw new Error(`"${par}" (formato: MONEDA:valor)`);
    out[m[1].trim().toUpperCase()] = numeroEnv(m[2]);
  }
  return out;
}

function consultarMindicador(serie) {
  const https = require('https');
  return new Promise((resolve) => {
    const req = https.get(`https://mindicador.cl/api/${serie}`, { timeout: 15000 }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          const u = (j.serie || [])[0];
          resolve(u && u.valor > 0 ? { valor: Number(u.valor), fecha: String(u.fecha || '').slice(0, 10) } : null);
        } catch (_) { resolve(null); }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

// Monedas (glosa del SII) de los sets de exportación contratados.
function monedasDeExportacion(estructuras) {
  const { resolverMonedaSii } = requerirModulo('@devlas/dte-sii');
  const monedas = new Set();
  for (const clave of ['setExportacion1', 'setExportacion2']) {
    for (const c of estructuras?.[clave]?.casos || []) {
      if (!c.moneda) continue;
      try {
        monedas.add(resolverMonedaSii(c.moneda, { overrides: config.exportacion.monedas }));
      } catch (e) {
        fallar(`Caso ${c.id}: ${e.message}`, 'MONEDA_DESCONOCIDA', {
          accion: 'Indica la glosa del SII en un archivo EXPORTACION_CODIGOS con { "monedas": { "TEXTO DEL SET": "DOLAR USA" } }.',
        });
      }
    }
  }
  return [...monedas];
}

async function tiposDeCambio(estado, monedas) {
  const hoy = fechaChile();
  const env = leerTipoCambioEnv();
  const guardado = estado.tiposCambio?.fecha === hoy ? (estado.tiposCambio.valores || {}) : {};
  const out = {};
  for (const m of monedas) {
    if (env[m]) {
      out[m] = env[m];
      log(`Tipo de cambio ${m}: ${env[m]} (TIPO_CAMBIO del .env: tiene que ser el de hoy, ${hoy})`);
      if (['DOLAR USA', 'EURO'].includes(m) && env[m] < 100) {
        fallar(`TIPO_CAMBIO de ${m} = ${env[m]} parece mal escrito (son pesos por unidad).`, 'TIPO_CAMBIO_INVALIDO', {
          accion: 'Ejemplo: TIPO_CAMBIO=DOLAR USA:945,12 (coma o punto para los decimales, sin separador de miles).',
        });
      }
      continue;
    }
    if (guardado[m]) { out[m] = guardado[m]; log(`Tipo de cambio ${m}: ${guardado[m]} (el de hoy, ya guardado)`); continue; }
    const serie = { 'DOLAR USA': 'dolar', EURO: 'euro' }[m];
    const v = serie ? await consultarMindicador(serie) : null;
    if (!v) {
      fallar(`Falta el tipo de cambio de ${m} a pesos para OtraMoneda.`, 'TIPO_CAMBIO_FALTANTE', {
        accion: `Agrega en ${path.relative(__dirname, ENV_FILE)}: TIPO_CAMBIO=${m}:<pesos por unidad, Banco Central de hoy>` +
          (serie ? '\n(no se pudo consultar mindicador.cl desde este equipo)' : ''),
        datos: { moneda: m },
      });
    }
    out[m] = v.valor;
    log(`Tipo de cambio ${m}: ${v.valor} (Banco Central ${v.fecha}, vía mindicador.cl)`);
  }
  estado.tiposCambio = { fecha: hoy, valores: { ...guardado, ...out } };
  guardarEstado(estado);
  return out;
}

// Lanza en vez de process.exit(): así el bloque finally de main() alcanza a cerrar la sesión SII.
// codigo: estable, para la interfaz (AVISOS.md) · accion: qué hacer · esperando: true cuando
// basta con esperar al SII y relanzar (sale con código 2, no es un error).
class FalloControlado extends Error {
  constructor(msg, codigo = 'ERROR', { accion = null, datos = null, esperando = false } = {}) {
    super(msg);
    this.codigo = codigo;
    this.accion = accion;
    this.datos = datos;
    this.esperando = esperando;
  }
}
function fallar(msg, codigo = 'ERROR', opciones = {}) {
  throw new FalloControlado(msg, codigo, opciones);
}

// ─────────────────────────────────────────────────────────────────
// Runner con estado rehidratado
// ─────────────────────────────────────────────────────────────────

// El SII, tras el login con certificado, devuelve una página titulada "Autenticación"
// que solo fija la cookie NETSCAPE_LIVEWIRE.locexp por JavaScript y redirige con
// location.replace() al destino. La librería no ejecuta JS: la toma como página de
// login y devuelve SESSION_EXPIRED. Este parche hace lo que haría el navegador:
// fija la cookie y vuelve a pedir el destino.
function parcharSesion(session) {
  if (!session || session.__parchada || typeof session.ensureSession !== 'function') return;
  const original = session.ensureSession.bind(session);
  session.ensureSession = async (targetPath) => {
    let r = await original(targetPath);
    for (let i = 0; i < 2; i++) {
      const body = r?.body || '';
      const m = body.match(/location\.replace\('([^']+)'\)/);
      if (!m || !/Autenticaci/.test(body)) break;
      const exp = encodeURIComponent(new Date(Date.now() + 7200000).toUTCString());
      session.cookieJar = session._mergeCookies(session.cookieJar, [`NETSCAPE_LIVEWIRE.locexp=${exp}`]);
      const next = await session.request(m[1], { method: 'GET' });
      r = (await session.followRedirects(next)).response;
    }
    return r;
  };
  session.__parchada = true;
}

// El SII limita las sesiones abiertas por certificado y NO libera el cupo hasta que
// caducan (~30 min). La librería reutiliza una sesión guardada en un registro global,
// y cuando esa sesión ya venció el SII cuenta cada reintento como una sesión nueva,
// llegando al tope. Este parche cierra la sesión (logout en el SII) INMEDIATAMENTE
// después de cada solicitud de folios, para que nunca queden dos abiertas a la vez.
// Cuando el SII responde "ha superado el máximo de sesiones", ofrece un formulario para
// cerrar las anteriores (es lo que hace el botón Aceptar del navegador). La librería tiene
// esa lógica en _tryForceCloseSessions pero no la usa en el flujo de folios. Este helper
// la dispara: pide una página protegida, y si sale el aviso, envía el formulario de cierre.
async function forzarCierreSesiones(session) {
  if (!session) return false;
  try {
    const host = session.baseHost || 'maullin.sii.cl';
    const r = await session.request(`https://${host}/cvc_cgi/dte/of_solicita_folios`, { method: 'GET' });
    const body = (await session.followRedirects(r)).response?.body || r.body || '';
    if (body.includes('superado el m') && typeof session._tryForceCloseSessions === 'function') {
      return await session._tryForceCloseSessions(body);
    }
  } catch (_) {}
  return false;
}

function parcharCierrePorSolicitud(cafSolicitor) {
  if (!cafSolicitor || cafSolicitor.__cierrePorSolicitud || typeof cafSolicitor.solicitar !== 'function') return;
  const original = cafSolicitor.solicitar.bind(cafSolicitor);
  cafSolicitor.solicitar = async (args) => {
    try {
      return await original(args);
    } finally {
      // Sondeos de tope no dejan sesión que valga la pena cerrar; el resto sí.
      if (!args?.soloConsultarTope) {
        try { await cafSolicitor.session?.logout?.(); } catch (_) {}
      }
    }
  };
  cafSolicitor.__cierrePorSolicitud = true;
}

// Cierra en el SII todas las sesiones que abrió esta corrida. El portal limita las
// sesiones abiertas por certificado y no las libera hasta que caducan (~30 min), así
// que cada comando debe cerrar la suya al terminar.
async function cerrarSesiones(runner) {
  const vistas = new Set();
  const candidatos = [
    runner?._folioService?.cafSolicitor?.session,
    runner?._folioService?.session,
    runner?._siiCert?.session,
    runner?._setsProvider?.session,
    runner?._setsProvider?.siiCert?.session,
  ];
  let n = 0;
  for (const s of candidatos) {
    if (!s || vistas.has(s) || typeof s.logout !== 'function') continue;
    vistas.add(s);
    // "Cerrar Sesión" real del portal SII (el mismo del botón del sitio). Se llama ANTES del
    // logout de la librería, que borra las cookies; sin cookies el SII no sabe qué cerrar.
    // Documentado por el SII en "Recomendaciones de uso – Integración de Proveedores de Software".
    if (s.cookieJar && typeof s.request === 'function') {
      for (const url of [
        'https://zeusr.sii.cl/cgi_AUT2000/autTermino.cgi',
        'https://herculesr.sii.cl/cgi_AUT2000/autTermino.cgi',
        'https://maullin.sii.cl/cgi_AUT2000/autTermino.cgi',
      ]) {
        try { await s.request(url, { method: 'GET' }); } catch (_) {}
      }
    }
    try { await s.logout(); n++; } catch (_) {}
  }
  try { fs.unlinkSync(config.sessionPath); } catch (_) {}
  if (n) log(`Sesión SII cerrada (${n}).`);
}

// El SII permite UNA sola sesión autenticada por certificado. La librería crea un objeto
// de sesión distinto por componente (pedir folios, anular, portal de certificación, sets),
// y cada uno hace su propio login: la segunda sesión es rechazada con "demasiadas
// sesiones". Aquí se hace que todos compartan el mismo objeto de sesión, así solo hay un
// login por proceso.
function unificarSesion(runner) {
  const fsvc = runner.folioService;                 // getter: crea FolioService + CafSolicitor
  const s = fsvc?.cafSolicitor?.session;
  if (!s) return;
  parcharSesion(s);
  fsvc.session = s;                                 // anular / consultar folios
  try { runner.siiCert.session = s; } catch (_) {}  // declarar avance, ver avance, muestras
  try {
    const sp = runner.setsProvider;                 // descarga del set
    const sc = sp?._getSiiCert ? sp._getSiiCert() : sp?._siiCert;
    if (sc) sc.session = s;
  } catch (_) {}
}

function crearRunner(estado) {
  const runner = new CertRunner(config);
  if (estado.estructuras) runner.setEstructuras(estado.estructuras);
  // Resultados de sets desmarcados (rechazados y por reenviar) no se entregan a la librería:
  // si no, la declaración usaría el TrackID viejo del envío rechazado.
  const resultados = {};
  for (const [k, v] of Object.entries(estado.resultados || {})) {
    if (NOMBRES_SETS.includes(k) && !hecha(estado, `set_${k}`)) continue;
    resultados[k] = v;
  }
  if (Object.keys(resultados).length) runner.setResultados(resultados);
  try { unificarSesion(runner); } catch (e) { log('Aviso: no se pudo unificar la sesión SII (' + e.message + ')'); }
  // Toda petición de folios de la librería (sets, simulación, lo que sea) pasa por el camino
  // seguro: servibles en disco + de a uno con anulación protegida. Nunca reobtención de CAF
  // viejos ni anulación de folios propios.
  runner.solicitarCafs = async (cafRequired) => {
    const need = {};
    for (const [t, c] of Object.entries(cafRequired || {})) need[t] = Number(c);
    await asegurarFolios(runner, estado, need);
    return runner._cafsPrecargados;
  };
  return runner;
}

// ─────────────────────────────────────────────────────────────────
// Etapas
// ─────────────────────────────────────────────────────────────────

async function etapaDatos() {
  log('Entrando al portal de certificación del SII con el certificado...');
  let emisor;
  try {
    ({ emisor } = await SiiPortalAuth.obtenerEmisor({
      pfxBuffer: fs.readFileSync(config.certificado.path),
      pfxPassword: config.certificado.password,
      rutEmpresa: RUT,
      onAviso: (m) => log(m),
    }));
  } catch (e) {
    if (/no se encontraron datos de resoluci/i.test(String(e.message))) {
      fallar('El SII no entregó la fecha de resolución de certificación en Actualización de datos (ad_empresa2).', 'SIN_DATOS_RESOLUCION', {
        accion: 'No basta para concluir que no hay postulación. Revisa con: node certificar.js estado ' + path.relative(__dirname, ENV_FILE) + '\n' +
          'Si hay postulación, pon a mano FECHA_RESOLUCION_CERT (día de la postulación) y completa los datos del emisor en el .env.',
      });
    }
    throw e;
  }

  console.log('\nDatos que el SII tiene para esta empresa en el ambiente de certificación:\n');
  const filas = [
    ['EMISOR_RAZON_SOCIAL', emisor.razon_social],
    ['EMISOR_GIRO', emisor.giro],
    ['EMISOR_ACTECO', emisor.acteco],
    ['EMISOR_DIRECCION', emisor.direccion],
    ['EMISOR_COMUNA', emisor.comuna],
    ['EMISOR_CIUDAD', emisor.ciudad],
    ['FECHA_RESOLUCION_CERT', emisor.fch_resol],
    ['(NroResol)', String(emisor.nro_resol)],
  ];
  for (const [k, v] of filas) console.log(`  ${k.padEnd(24)} ${v || '(vacío)'}`);

  // Lo que ya está escrito en el .env no se toca: avisar si difiere de lo del SII.
  for (const [k, v] of filas) {
    if (k.startsWith('(') || !v) continue;
    const actual = (process.env[k] || '').trim();
    if (actual && actual.toUpperCase() !== String(v).trim().toUpperCase()) {
      emitirAviso(k === 'FECHA_RESOLUCION_CERT' ? 'FECHA_RESOLUCION_DISTINTA' : 'DATO_DISTINTO_SII',
        `${k} en el .env ("${actual}") no coincide con el SII ("${v}").`, {
          nivel: 'advertencia',
          accion: k === 'FECHA_RESOLUCION_CERT'
            ? 'Usa la del SII: con otra fecha el SII rechaza los envíos.'
            : 'Usa el dato del SII: con él se revisan las muestras impresas.',
          datos: { variable: k, env: actual, sii: v },
        });
    }
  }

  // Escribir en el .env los campos que estén vacíos
  let env = fs.readFileSync(ENV_FILE, 'utf8');
  let cambios = 0;
  for (const [k, v] of filas) {
    if (k.startsWith('(') || !v) continue;
    const re = new RegExp(`^${k}=\\s*$`, 'm');
    if (re.test(env)) {
      env = env.replace(re, `${k}=${v}`);
      cambios++;
    }
  }
  if (cambios) {
    fs.writeFileSync(ENV_FILE, env);
    console.log(`\n${cambios} campo(s) vacío(s) completado(s) en ${path.relative(__dirname, ENV_FILE)}.`);
  }
  console.log('\nRevisa que coincidan con lo que quieres usar y luego: node certificar.js estado ' + path.relative(__dirname, ENV_FILE));
  return true;
}

// Pide folios de a UNO para un tipo de DTE. Sirve cuando el SII raciona por historial
// (MAX_AUTOR=1): el sondeo de la librería con cantidad=1 no ve el tope y el pedido
// completo aborta. Los CAF quedan en disco y la etapa "sets" los reutiliza.
// Pide folios de a UNO, en una sola sesión SII, con anulación protegida si el SII bloquea.
// pedidos: [[tipo, cantidad], ...]. Devuelve true si consiguió todo.
// ── Folios de envíos rechazados (regla 10) ──────────────────────────────────────────

// Busca el envio.xml que la librería guarda por TrackID en runs/<RUT>/historicos/.
function buscarEnvioXml(trackId) {
  const pila = [path.join(RUN_DIR, 'historicos')];
  while (pila.length) {
    const dir = pila.pop();
    let entradas;
    try { entradas = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { continue; }
    for (const e of entradas) {
      if (!e.isDirectory()) continue;
      const p = path.join(dir, e.name);
      if (e.name === String(trackId) || (/^\d+$/.test(e.name) && Number(e.name) === Number(trackId))) {
        const f = path.join(p, 'envio.xml');
        if (fs.existsSync(f)) return f;
      }
      pila.push(p);
    }
  }
  return null;
}

// { tipo: [folios] } de un envío, leídos del XML enviado (IdDoc: TipoDTE seguido de Folio).
function foliosDeEnvio(trackId) {
  const f = buscarEnvioXml(trackId);
  if (!f) return null;
  const xml = fs.readFileSync(f, 'latin1');
  const out = {};
  const re = /<TipoDTE>(\d+)<\/TipoDTE>\s*<Folio>(\d+)<\/Folio>/g;
  let m;
  while ((m = re.exec(xml))) (out[m[1]] = out[m[1]] || []).push(Number(m[2]));
  return out;
}

// [3,1,2,7] → [[1,3],[7,7]]
function rangos(folios) {
  const u = [...new Set(folios.map(Number))].sort((a, b) => a - b);
  const out = [];
  for (const f of u) {
    const ult = out[out.length - 1];
    if (ult && f === ult[1] + 1) ult[1] = f; else out.push([f, f]);
  }
  return out;
}

function textoRangos(folios) {
  return rangos(folios).map(([d, h]) => (d === h ? `${d}` : `${d}-${h}`)).join(', ');
}

// Folios que NO se pueden anular: los de envíos vigentes (sets y simulación marcados) y los
// servibles en disco que el runner todavía va a usar.
function foliosProtegidos(runner, estado, tipo) {
  const set = new Set();
  for (const e of Object.values(estado.etapas || {})) {
    if (!e?.ok || !e.trackId) continue;
    const f = foliosDeEnvio(e.trackId);
    for (const n of (f && f[String(tipo)]) || []) set.add(n);
  }
  try {
    for (const s of cafsServibles(runner, tipo)) for (let n = s.d; n <= s.h; n++) set.add(n);
  } catch (_) {}
  return set;
}

// Guarda en estado.foliosMuertos los folios de un envío que el SII rechazó.
function registrarFoliosMuertos(estado, trackId, nombre) {
  const f = foliosDeEnvio(trackId);
  if (!f || !Object.keys(f).length) {
    log(`Set ${nombre}: no encontré el XML del envío ${trackId}; sus folios no se anularán solos. ` +
        `Si el SII bloquea el timbraje, usa: node certificar.js anular ${path.relative(__dirname, ENV_FILE)} <tipo> <desde-hasta>`);
    return;
  }
  estado.foliosMuertos = estado.foliosMuertos || {};
  const partes = [];
  for (const [tipo, lista] of Object.entries(f)) {
    estado.foliosMuertos[tipo] = [...new Set([...(estado.foliosMuertos[tipo] || []), ...lista])].sort((a, b) => a - b);
    partes.push(`${tipo}: ${textoRangos(lista)}`);
  }
  log(`Set ${nombre}: folios del envío rechazado ${trackId} quedan para anular → ${partes.join(' · ')}`);
}

// Anula en el SII los folios muertos de un tipo. Devuelve cuántos anuló.
async function anularMuertos(runner, estado, tipo) {
  const muertos = (estado?.foliosMuertos || {})[String(tipo)] || [];
  if (!muertos.length) return 0;
  const protegidos = foliosProtegidos(runner, estado, tipo);
  const aAnular = muertos.filter((n) => !protegidos.has(n));
  let total = 0;
  for (const [d, h] of rangos(aAnular)) {
    log(`Tipo ${tipo}: anulando folios ${d}-${h} (de envíos rechazados por el SII)...`);
    try {
      const a = await runner.folioService.anularFolios({
        tipoDte: Number(tipo), motivo: 'Folios de envio rechazado en certificacion', folioDesde: d, folioHasta: h,
      });
      total += a.totalAnulados ?? 0;
      log(`Tipo ${tipo}: ${a.totalAnulados ?? 0} anulado(s), ${a.totalRechazados ?? 0} rechazado(s) (ya anulados o ya usados).`);
    } catch (e) {
      log(`Tipo ${tipo}: no se pudo anular ${d}-${h} (${e.message}). Se reintenta en la próxima corrida.`);
      return total;
    }
  }
  delete estado.foliosMuertos[String(tipo)];
  guardarEstado(estado);
  return total;
}

// Último código de error del SII al pedir folios, para explicar bien por qué se detuvo.
let ultimoErrorFolio = null;
let ultimoErrorFolioTexto = '';
let esperaHasta = null;
const ESPERA_BLOQUEO_MIN = parseInt(process.env.BLOQUEO_ESPERA_MIN || '60', 10);
const hora = (d) => d.toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit' });

// Traduce el último rechazo del SII al pedir folios en un aviso con código y acción.
function fallarPorFolios(tipoPendiente) {
  const env = path.relative(__dirname, ENV_FILE);
  const detalle = ultimoErrorFolioTexto ? ` Detalle del SII: ${ultimoErrorFolioTexto}` : '';
  const datos = { tipo: tipoPendiente || null, errorSii: ultimoErrorFolio, detalle: ultimoErrorFolioTexto || null };
  switch (ultimoErrorFolio) {
    case 'ESPERA_BLOQUEO':
      fallar(`Folios tipo ${esperaHasta.tipo} en espera tras un bloqueo del SII: relanza después de las ${hora(esperaHasta.hasta)}.`, 'FOLIOS_EN_ESPERA', {
        esperando: true, datos: { ...datos, tipo: esperaHasta.tipo, hasta: esperaHasta.hasta.toISOString() },
        accion: `Mientras tanto puedes declarar los sets ya enviados: node certificar.js declarar ${env}\n` +
          `Para pedir igual (no recomendado): FORZAR_FOLIOS=1 node certificar.js todo ${env}`,
      });
      break;
    case 'TIMBRAJE_BLOQUEADO':
      fallar('El SII bloquea el timbraje: cuenta demasiados folios "sin usar".', 'TIMBRAJE_BLOQUEADO', {
        esperando: true, datos,
        accion: 'Si se acaban de enviar sets, sus folios cuentan como sin usar hasta que el SII los procesa: relanza en 1 hora.\n' +
          'Si sigue bloqueado sin folios pendientes, hay que pedir al SII que habilite el timbraje (petición administrativa).\n' +
          `Anular folios viejos (node certificar.js anular ${env} <tipo> <desde-hasta>) pesa 6 meses en contra del cupo.`,
      });
      break;
    case 'MAX_AUTOR_INSUFICIENTE':
    case 'MAX_AUTOR_EXCEEDED':
    case 'TOPE_SII_INSUFICIENTE':
      fallar('El SII raciona los folios de este tipo y no alcanza para el set.', 'FOLIOS_RACIONADOS', {
        esperando: true, datos, accion: 'Relanza en 1 hora; el runner pide de a uno y guarda lo que consigue.' + detalle,
      });
      break;
    case 'VERIFICACION_ACTIVIDADES_PENDIENTE':
      fallar('La empresa no tiene la Verificación de Actividades para este tipo de documento.', 'VERIFICACION_ACTIVIDADES_PENDIENTE', {
        datos, accion: 'El cliente debe solicitarla en https://www4.sii.cl/verificacionactividadesinternetui/ y esperar que salga positiva.',
      });
      break;
    case 'EMPRESA_NO_AUTORIZADA':
    case 'NO_AUTORIZADO_INGRESAR_OPCION':
      fallar('El SII no permite pedir folios para esta empresa en el ambiente de certificación.', 'FOLIOS_NO_AUTORIZADOS', {
        datos, accion: `Suele ser falta de postulación o de permisos. Revisa con: node certificar.js estado ${env}` + detalle,
      });
      break;
    case 'USUARIO_SIN_PERMISO':
      fallar(`El usuario del certificado (${CERT_INFO?.rut || '?'}) no tiene permiso para pedir folios.`, 'USUARIO_SIN_PERMISO_FOLIOS', {
        datos, accion: 'El administrador de la empresa debe marcar "Solicitar Folios" y "Anular Folios" en Mantención de usuarios (ambiente de certificación).',
      });
      break;
    case 'REQUIERE_TRAMITE_PRESENCIAL':
      fallar('El SII exige un trámite presencial antes de autorizar folios.', 'REQUIERE_TRAMITE_PRESENCIAL', {
        datos, accion: 'El cliente debe acudir al SII o hacer la petición administrativa que indique el detalle.' + detalle,
      });
      break;
    case 'WAAP_BLOCKED':
      fallar('El firewall del SII bloqueó la solicitud.', 'SII_BLOQUEO_FIREWALL', {
        esperando: true, datos, accion: 'Espera 30 minutos y relanza. Si persiste, prueba desde otra red.',
      });
      break;
    case 'SESSION_EXPIRED':
      fallar('La sesión del SII expiró durante la solicitud de folios.', 'SESION_EXPIRADA', {
        esperando: true, datos, accion: 'Relanza el mismo comando.',
      });
      break;
    default:
      fallar('El SII no entregó los folios.' + detalle, 'FOLIOS_NO_ENTREGADOS', {
        esperando: true, datos, accion: 'Espera a que caduquen las sesiones del SII (~30 min) y relanza el mismo comando.',
      });
  }
}

async function conseguirFolios(runner, pedidos, estado) {
  const fs_ = runner.folioService;
  if (!fs_.cafSolicitor) fallar('No se pudo iniciar la solicitud de folios (falta certificado).', 'CERT_NO_CARGADO');
  ultimoErrorFolio = null;
  let todoOk = true;
  // Primero los tipos escasos (notas de débito y crédito): si el SII los niega, se corta
  // antes de pedir facturas que quedarían sin usar y agravarían el racionamiento.
  const prioridad = (t) => ({ 56: 0, 61: 1 })[Number(t)] ?? 2;
  pedidos = [...pedidos].sort((a, b) => prioridad(a[0]) - prioridad(b[0]));
  for (const [tipo, cantidad] of pedidos) {
    if (cantidad <= 0) continue;
    // Freno: si el SII bloqueó este tipo hace poco, no se vuelve a pedir. Cada solicitud
    // bloqueada queda registrada en el SII ("en sus solicitudes previas se le informó") e
    // insistir alarga el bloqueo. FORZAR_FOLIOS=1 salta el freno.
    const b = estado?.bloqueos?.[String(tipo)];
    if (b && !process.env.FORZAR_FOLIOS) {
      const hasta = new Date(Date.parse(b) + ESPERA_BLOQUEO_MIN * 60000);
      if (Date.now() < hasta.getTime()) {
        ultimoErrorFolio = 'ESPERA_BLOQUEO';
        esperaHasta = { tipo, hasta };
        log(`Tipo ${tipo}: el SII lo bloqueó a las ${hora(new Date(b))}; no se vuelve a pedir antes de las ${hora(hasta)}`);
        todoOk = false;
        break;
      }
    }
    let ok = 0;
    let anuladoYa = false;
    // RUT limpio: una sola solicitud con la cantidad exacta suele bastar.
    if (cantidad > 1) {
      log(`Tipo ${tipo}: pidiendo ${cantidad} folio(s) en una solicitud...`);
      const r0 = await fs_.cafSolicitor.solicitar({ tipoDte: tipo, cantidad, minCantidad: cantidad });
      if (r0.success) {
        log(`Tipo ${tipo}: ${cantidad} folio(s) OK → ${path.relative(__dirname, r0.cafPath)}`);
        continue;
      }
      log(`Tipo ${tipo}: el SII raciona (${r0.errorCode || 'sin código'}); se pide de a uno.`);
    }
    for (let i = 1; i <= cantidad; i++) {
      let r = await fs_.cafSolicitor.solicitar({ tipoDte: tipo, cantidad: 1, minCantidad: 1 });
      if (!r.success && /TIMBRAJE_BLOQUEADO|MAX_AUTOR_INSUFICIENTE/.test(r.errorCode || '') && !anuladoYa) {
        anuladoYa = true;
        // Último recurso (regla 10): anular pesa 6 meses en contra del cupo.
        log(`Tipo ${tipo}: timbraje bloqueado; anulando folios de envíos rechazados y folios viejos sin usar, y reintentando...`);
        if (estado) await anularMuertos(runner, estado, tipo);
        try {
          const minMio = menorFolioEnDisco(runner, tipo);
          const filtro = minMio ? { folioDesde: 1, folioHasta: minMio - 1 } : {};
          if (minMio) log(`Tipo ${tipo}: se protegen los folios desde ${minMio} (nuestros, usados o no); se anulan solo anteriores.`);
          const a = await fs_.anularFolios({ tipoDte: tipo, motivo: 'Folios de certificación no utilizados', ...filtro });
          log(`Tipo ${tipo}: ${a.totalAnulados ?? 0} anulado(s), ${a.totalRechazados ?? 0} rechazado(s).`);
        } catch (e) { log(`Tipo ${tipo}: no se pudo anular (${e.message})`); }
        r = await fs_.cafSolicitor.solicitar({ tipoDte: tipo, cantidad: 1, minCantidad: 1 });
      }
      if (!r.success) {
        ultimoErrorFolio = r.errorCode || null;
        ultimoErrorFolioTexto = r.error || '';
        log(`Folio ${i}/${cantidad}: el SII no lo entregó (${r.errorCode || 'sin código'}: ${r.error || ''})`);
        break;
      }
      ok++;
      log(`Folio ${i}/${cantidad}: OK → ${path.relative(__dirname, r.cafPath)}`);
    }
    log(`Tipo ${tipo}: ${ok} de ${cantidad} conseguidos.`);
    if (estado) {
      estado.bloqueos = estado.bloqueos || {};
      if (ok === cantidad) delete estado.bloqueos[String(tipo)];
      else if (/TIMBRAJE_BLOQUEADO/.test(ultimoErrorFolio || '')) estado.bloqueos[String(tipo)] = new Date().toISOString();
      guardarEstado(estado);
    }
    if (ok !== cantidad) { todoOk = false; break; }
  }
  return todoOk;
}

async function etapaFolios(runner, estado) {
  const args = process.argv.slice(4).map((x) => parseInt(x, 10));
  if (args.length < 2 || args.length % 2 !== 0 || args.some((n) => !n)) {
    fallar('Uso: node certificar.js folios <empresa.env> <tipo> <cantidad> [<tipo> <cantidad> ...]   ej: 33 4 56 4 61 7', 'USO_INVALIDO');
  }
  const pedidos = [];
  for (let i = 0; i < args.length; i += 2) pedidos.push([args[i], args[i + 1]]);
  const ok = await conseguirFolios(runner, pedidos, estado);
  if (ok) log('Listo. Ahora: node certificar.js todo ' + path.relative(__dirname, ENV_FILE));
  else fallarPorFolios();
  return ok;
}

// Anula en el SII los folios viejos sin utilizar de un tipo de DTE. Se usa cuando el
// SII bloquea el timbraje (TIMBRAJE_BLOQUEADO) por folios acumulados de pruebas previas.
async function etapaAnular(runner, estado) {
  const tipo = parseInt(process.argv[4], 10);
  if (!tipo) fallar('Uso: node certificar.js anular <empresa.env> <tipoDte> [desde-hasta]   ej: 61   |   61 1-7', 'USO_INVALIDO');
  const fs_ = runner.folioService;
  if (!fs_.cafSolicitor) fallar('No se pudo iniciar la solicitud de folios (falta certificado).', 'CERT_NO_CARGADO');

  // Rango exacto: para folios de envíos rechazados o de pruebas anteriores. Nunca toca
  // folios de sets vigentes ni los servibles en disco.
  const rangoArg = process.argv[5];
  if (rangoArg) {
    const m = rangoArg.match(/^(\d+)(?:-(\d+))?$/);
    if (!m) fallar('Rango inválido. Ej.: 1-7  o  5', 'USO_INVALIDO');
    const d = parseInt(m[1], 10);
    const h = parseInt(m[2] || m[1], 10);
    if (h < d) fallar('Rango inválido: el final es menor que el inicio.', 'USO_INVALIDO');
    const protegidos = foliosProtegidos(runner, estado, tipo);
    const choque = [];
    for (let n = d; n <= h; n++) if (protegidos.has(n)) choque.push(n);
    if (choque.length) {
      fallar(`No se anula: los folios ${textoRangos(choque)} del tipo ${tipo} están en un set enviado vigente o sin usar en disco.\n` +
             `Si ese set fue rechazado por el SII, primero: node certificar.js rehacer ${path.relative(__dirname, ENV_FILE)} <set>`,
             'ANULACION_PROTEGIDA', { datos: { tipo, folios: choque } });
    }
    log(`Tipo ${tipo}: anulando folios ${d}-${h} en el SII (esto puede tardar)...`);
    log('Ojo: los folios anulados pesan 6 meses en contra del cupo de timbraje de este tipo.');
    const r = await fs_.anularFolios({ tipoDte: tipo, motivo: 'Folios de certificacion no utilizados', folioDesde: d, folioHasta: h });
    log(`Tipo ${tipo}: ${r.totalAnulados ?? 0} folio(s) anulado(s), ${r.totalRechazados ?? 0} rechazado(s) (ya anulados o ya usados).`);
    const pend = estado.foliosMuertos?.[String(tipo)];
    if (pend) {
      const resto = pend.filter((n) => n < d || n > h);
      if (resto.length) estado.foliosMuertos[String(tipo)] = resto; else delete estado.foliosMuertos[String(tipo)];
      guardarEstado(estado);
    }
    log(`Ahora: node certificar.js todo ${path.relative(__dirname, ENV_FILE)}`);
    return true;
  }

  // Sin rango: primero los folios registrados de envíos rechazados, luego los anteriores a los nuestros.
  await anularMuertos(runner, estado, tipo);

  const minMio = menorFolioEnDisco(runner, tipo);
  const filtro = minMio ? { folioDesde: 1, folioHasta: minMio - 1 } : {};
  if (minMio) log(`Tipo ${tipo}: se protegen los folios desde ${minMio} (nuestros, usados o no); se anulan solo anteriores.`);
  log(`Tipo ${tipo}: consultando y anulando folios sin utilizar en el SII (esto puede tardar)...`);
  const r = await fs_.anularFolios({ tipoDte: tipo, motivo: 'Folios de certificación no utilizados', ...filtro });
  log(`Tipo ${tipo}: ${r.totalAnulados ?? 0} folio(s) anulado(s), ${r.totalRechazados ?? 0} rechazado(s) (ya anulados o ya usados).`);
  log(`Ahora reintenta: node certificar.js folios ${path.relative(__dirname, ENV_FILE)} ${tipo} <cantidad>`);
  return true;
}

// Desmarca un set (basico|guia|exenta|compra) rechazado por el SII para que "todo" lo
// genere y envíe de nuevo con folios nuevos. No toca el SII.
async function etapaRehacer(runner, estado) {
  const validos = [...NOMBRES_SETS, 'muestras'];
  const nombres = process.argv.slice(4).map((x) => x.toLowerCase())
    .flatMap((n) => (n === 'exportacion' ? ['exportacion1', 'exportacion2'] : [n]));
  if (!nombres.length || nombres.some((n) => !validos.includes(n))) {
    fallar(`Uso: node certificar.js rehacer <empresa.env> <${validos.join('|')}> [...]   ej: basico exenta`, 'USO_INVALIDO');
  }
  for (const nombre of nombres) {
    if (nombre === 'muestras') {
      delete estado.etapas.muestras;
      delete estado.etapas.muestras_pdf;
      delete estado.etapas.cierre;
      log('Muestras desmarcadas.');
      continue;
    }
    const trackId = estado.etapas[`set_${nombre}`]?.trackId;
    if (trackId) {
      const st = await estadoEnvio(runner, trackId);
      if (st && !st.final) {
        log(`Set ${nombre}: el SII todavía procesa el envío ${trackId} (${st.estado}); no se desmarca. Reintenta en unos minutos.`);
        continue;
      }
      if (st?.aceptadoTodo) {
        // Documentos aceptados (el set pudo rechazarse por contenido): los folios están usados.
        log(`Set ${nombre}: el envío ${trackId} fue aceptado por el SII; sus folios quedan usados, no hay nada que anular.`);
      } else {
        if (!st) log(`Set ${nombre}: el SII no respondió el estado de ${trackId}; se anotan sus folios por si fue rechazado.`);
        // Regla 10: se anulan solo si el SII llega a bloquear ese tipo.
        registrarFoliosMuertos(estado, trackId, nombre);
      }
    }
    delete estado.etapas[`set_${nombre}`];
    delete estado.etapas.sets_declarados;
    delete estado.etapas.sets_aprobados;
    delete estado.resultados[nombre];
    log(`Set ${nombre} desmarcado.`);
  }
  guardarEstado(estado);
  log(`Ahora: node certificar.js todo ${path.relative(__dirname, ENV_FILE)}`);
  return true;
}

// Emite documentos de RELLENO al ambiente de certificación con los folios servibles que
// quedaron en disco (sobrantes). Sirve cuando el SII bloquea el timbraje por "folios sin
// usar": cada documento emitido paga una advertencia. Solo tipos sin referencia obligatoria
// (33, 34, 52, 46). Los folios usados quedan marcados como consumidos.
async function etapaEmitir(runner) {
  // Uso: emitir <env> 33 34 52 [ref=64]   → ref: folio de una FACTURA (33) ya aceptada hoy,
  // necesario para emitir relleno de 61/56 (llevan referencia obligatoria).
  const args = process.argv.slice(4);
  const refArg = args.find((a) => a.startsWith('ref='));
  const refFolio = refArg ? parseInt(refArg.split('=')[1], 10) : null;
  const tipos = args.filter((a) => !a.startsWith('ref=')).map((x) => parseInt(x, 10)).filter(Boolean);
  if (!tipos.length) fallar('Uso: node certificar.js emitir <empresa.env> <tipo> [<tipo> ...] [ref=<folioFactura>]   ej: 33 34 52  |  61 56 ref=64', 'USO_INVALIDO');
  const permitidos = new Set([33, 34, 52, 46, 61, 56]);
  const lib = require('@devlas/dte-sii');
  const { DTE, CAF, Certificado, buildDetalle, calcularTotalesDesdeItems } = lib;
  const cert = new Certificado(fs.readFileSync(config.certificado.path), config.certificado.password);
  const fecha = fechaChile();
  const emisor = {
    RUTEmisor: config.emisor.rut, RznSoc: config.emisor.razon_social, GiroEmis: config.emisor.giro,
    Acteco: config.emisor.acteco, DirOrigen: config.emisor.direccion, CmnaOrigen: config.emisor.comuna,
    CiudadOrigen: config.emisor.ciudad || config.emisor.comuna,
  };
  const receptor = {
    RUTRecep: config.receptor.rut, RznSocRecep: config.receptor.razon_social, GiroRecep: config.receptor.giro,
    DirRecep: config.receptor.direccion, CmnaRecep: config.receptor.comuna, CiudadRecep: config.receptor.ciudad || config.receptor.comuna,
  };

  const dtes = [];
  const cafsUsados = {};
  for (const tipo of tipos) {
    if (!permitidos.has(tipo)) { log(`Tipo ${tipo}: no se emite relleno de este tipo (requiere referencias).`); continue; }
    const serv = cafsServibles(runner, tipo);
    if (!serv.length) { log(`Tipo ${tipo}: sin folios sobrantes en disco.`); continue; }
    for (const s of serv) {
      const cafXml = fs.readFileSync(s.ruta, 'utf8');
      const caf = new CAF(cafXml);
      for (let folio = s.d; folio <= s.h; folio++) {
        const esExento = tipo === 34;
        const items = [{ nombre: 'Servicio de prueba certificacion', cantidad: 1, precio: 1000, ...(esExento ? { exento: true } : {}) }];
        const detalle = buildDetalle(items, esExento ? { soloExento: true } : {});
        const { totales } = calcularTotalesDesdeItems(items, esExento ? { soloExento: true } : {});
        const idDoc = { TipoDTE: tipo, Folio: folio, FchEmis: fecha };
        if (tipo === 52) { idDoc.IndTraslado = 1; idDoc.TipoDespacho = 1; }
        if (tipo === 33 || tipo === 34) idDoc.TpoTranVenta = 1;
        const datos = { Encabezado: { IdDoc: idDoc, Emisor: emisor, Receptor: receptor, Totales: totales }, Detalle: detalle };
        if (tipo === 61 || tipo === 56) {
          if (!refFolio) fallar(`Tipo ${tipo} requiere referencia: agrega ref=<folio de factura 33 aceptada>`, 'USO_INVALIDO');
          datos.Referencia = [{ NroLinRef: 1, TpoDocRef: 33, FolioRef: refFolio, FchRef: fecha, CodRef: 3, RazonRef: 'CORRIGE MONTO' }];
        }
        const dte = new DTE(datos);
        dte.generarXML().timbrar(caf, horaChile());
        dte.firmar(cert);
        dtes.push(dte);
        log(`Tipo ${tipo}: folio ${folio} preparado como relleno.`);
      }
      (cafsUsados[tipo] = cafsUsados[tipo] || []).push(s.ruta);
    }
  }
  if (!dtes.length) fallar('No hay folios sobrantes en disco para emitir relleno.', 'SIN_FOLIOS_PARA_RELLENO');

  const { EnvioDTE } = lib;
  const envio = new EnvioDTE({ certificado: cert });
  for (const d of dtes) envio.agregar(d);
  envio.setCaratula({
    RutEmisor: config.emisor.rut, RutEnvia: cert.rut || config.emisor.rut, RutReceptor: '60803000-K',
    FchResol: config.emisor.fch_resol, NroResol: config.emisor.nro_resol,
    TmstFirmaEnv: horaChile(), SetDTEId: 'DTE_SetDoc',
  });
  envio.generar();

  // Marcar los CAF como consumidos ANTES de enviar: si el envío viaja, el SII ya vio los folios.
  try { runner._marcarCafsConsumidos(cafsUsados); } catch (_) {}

  log(`Enviando ${dtes.length} documento(s) de relleno al SII...`);
  const enviador = runner._createEnviador('relleno');
  const r = await sinInterrumpir(() => enviador.enviar(envio));
  if (!r?.success && !r?.trackId) fallar(`Envío de relleno falló: ${r?.error || JSON.stringify(r)}`, 'ENVIO_FALLIDO', { accion: 'Reintenta en unos minutos; si persiste, revisa el detalle.' });
  log(`Relleno enviado. TrackID ${r.trackId}. Ahora el SII debería permitir timbrar de nuevo.`);
  return true;
}

// EnviadorSII de la librería, instanciado igual que lo hace CertRunner. Se reusa en la
// corrida (el token SOAP queda en caché dentro del objeto).
let _enviadorConsulta = null;
function crearEnviador(runner) {
  if (_enviadorConsulta) return _enviadorConsulta;
  const lib = requerirModulo('@devlas/dte-sii');
  let EnviadorSII = lib.EnviadorSII;
  if (!EnviadorSII) { const m = requerirModulo('@devlas/dte-sii/EnviadorSII'); EnviadorSII = m.EnviadorSII || m; }
  const cert = runner.certificado || new lib.Certificado(fs.readFileSync(config.certificado.path), config.certificado.password);
  _enviadorConsulta = new EnviadorSII(cert, runner.ambiente || config.ambiente);
  return _enviadorConsulta;
}

// Estado de un envío: { final, aceptadoTodo, rechazado, estado, glosa } o null si el SII no respondió.
async function estadoEnvio(runner, trackId) {
  const env = crearEnviador(runner);
  const metodo = typeof env.consultarEstadoSoap === 'function' ? 'consultarEstadoSoap' : 'consultarEstado';
  let r;
  try { r = await env[metodo](String(trackId), config.emisor.rut); } catch (_) { return null; }
  if (!r?.ok) return null;
  const rech = [...String(r.xmlRaw || '').matchAll(/<RECHAZADOS>(\d+)<\/RECHAZADOS>/g)].reduce((n, m) => n + Number(m[1]), 0);
  return {
    final: !r.esIntermedio,
    rechazado: !!r.esRechazado,
    aceptadoTodo: !!r.esExitoso && rech === 0,
    estado: r.estado,
    glosa: r.glosa,
  };
}

// Estado de cada envío en el SII (QueryEstUp), sin declarar nada en el portal. Sirve para
// saber si un set fue aceptado o rechazado antes de anular folios o rehacerlo.
// Sin argumentos consulta los TrackID de los sets y la simulación marcados en estado.json.
async function etapaConsultar(runner, estado) {
  let ids = process.argv.slice(4);
  const nombres = {};
  if (!ids.length) {
    for (const [etapa, e] of Object.entries(estado.etapas || {})) {
      if (e?.ok && e.trackId) { ids.push(String(e.trackId)); nombres[String(e.trackId)] = etapa; }
    }
  }
  if (!ids.length) fallar('No hay envíos registrados. Uso: node certificar.js consultar <empresa.env> <trackId> [...]', 'SIN_ENVIOS');

  const enviador = crearEnviador(runner);
  const metodo = typeof enviador.consultarEstadoSoap === 'function' ? 'consultarEstadoSoap' : 'consultarEstado';
  if (typeof enviador[metodo] !== 'function') fallar('Esta versión de la librería no trae consultarEstadoSoap ni consultarEstado en EnviadorSII.', 'LIBRERIA_INCOMPATIBLE', { accion: ACTUALIZAR_LIBRERIA });

  for (const id of ids) {
    console.log(`\n── TrackID ${id}${nombres[id] ? ` (${nombres[id]})` : ''} ──`);
    try {
      const r = await enviador[metodo](id, config.emisor.rut);
      const est = r?.estado ?? r?.status ?? r?.codigo;
      const glosa = r?.glosa ?? r?.mensaje ?? r?.descripcion ?? '';
      if (est !== undefined) console.log(`   estado: ${est}${glosa ? ` — ${glosa}` : ''}`);
      console.log('   ' + JSON.stringify(r, null, 2).split('\n').join('\n   '));
    } catch (e) {
      console.log(`   no se pudo consultar: ${e.message}`);
    }
  }
  console.log('\nEPR = procesado (mira aceptados/rechazados/reparos); RFR/RCT/RSC = rechazado entero.');
  return true;
}

// Declara en el portal los sets que ya se enviaron, aunque falte alguno. El SII empieza a
// revisarlos mientras el resto espera (por ejemplo, folios bloqueados). No marca la etapa:
// "todo" vuelve a declarar cuando estén los cuatro.
async function etapaDeclarar(runner, estado) {
  const enviados = NOMBRES_SETS.filter((n) => hecha(estado, `set_${n}`));
  if (!enviados.length) fallar('No hay sets enviados para declarar.', 'SIN_SETS_ENVIADOS', { accion: 'Primero: node certificar.js todo ' + path.relative(__dirname, ENV_FILE) });
  const faltan = NOMBRES_SETS
    .filter((n) => !hecha(estado, `set_${n}`) && estado.estructuras?.[ESTRUCTURA_DE[n]]);
  log(`Declarando en el portal: ${enviados.join(', ')}${faltan.length ? ` (quedan pendientes: ${faltan.join(', ')})` : ''}...`);
  const r = await runner.declararAvance(undefined, undefined, { ignorarVacio: true });
  if (!r.success) fallarDeclaracion(r.error || r.mensaje || '');
  log(`Declaración aceptada. Revisa el avance en un rato con: node certificar.js estado ${path.relative(__dirname, ENV_FILE)}`);
  return true;
}

// ─────────────────────────────────────────────────────────────────
// Estado de la postulación en el portal (verificación previa)
// ─────────────────────────────────────────────────────────────────

function textoVisible(html) {
  const ent = { aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú', ntilde: 'ñ', Aacute: 'Á', Eacute: 'É',
    Iacute: 'Í', Oacute: 'Ó', Uacute: 'Ú', Ntilde: 'Ñ', nbsp: ' ', amp: '&', quot: '"', lt: '<', gt: '>' };
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(\w+);/g, (m, n) => ent[n] ?? m)
    .replace(/\s+/g, ' ')
    .trim();
}

// Clasifica la página "Ver avance de la postulación":
//   EN_PROCESO      hay postulación abierta; etapa = paso actual (SET DE PRUEBAS, SIMULACION...)
//   AUTORIZADA      la empresa ya está autorizada como emisor: no hay proceso abierto
//   SIN_ACCESO      el usuario del certificado no puede ver esta empresa
//   SIN_POSTULACION la página de avance no muestra postulación ni autorización
//   INESPERADA      el SII devolvió otra página (mantenimiento, login, error): no se concluye nada
//   SIN_RESPUESTA   el SII no respondió
function clasificarAvance(avance) {
  if (!avance?.success) return { tipo: 'SIN_RESPUESTA', texto: String(avance?.error || '') };
  const texto = textoVisible(avance.rawHtml);
  const cuerpo = texto.replace(/^.*?paso en que se encuentre\.?/i, '').trim().slice(0, 400);
  if (/autorizad[oa] para operar como emisor/i.test(texto)) return { tipo: 'AUTORIZADA', texto: cuerpo };
  if (/no est[aá] autorizad[oa] para ingresar|NO ESTA AUTORIZADO/i.test(texto)) return { tipo: 'SIN_ACCESO', texto: cuerpo };
  if (avance.etapaActual) return { tipo: 'EN_PROCESO', etapa: avance.etapaActual, texto: cuerpo };
  // Solo se concluye "sin postulación" si de verdad es la página de avance.
  if (/VER AVANCE DE LA POSTULACI/i.test(texto)) return { tipo: 'SIN_POSTULACION', texto: cuerpo };
  return { tipo: 'INESPERADA', texto: texto.slice(0, 300) };
}

const AVISO_PORTAL = {
  // "Autorizada para operar como emisor" sin postulación ni resolución de certificación: emite con el
  // sistema gratuito del SII, no con software propio. Para Odoo tiene que postular: es no postulación.
  AUTORIZADA: ['SIN_POSTULACION', 'La empresa no ha postulado a certificación: el SII la muestra como emisor, pero sin resolución de certificación (usa el sistema gratuito del SII).',
    'El representante legal debe postular (Menú postulantes → Postulación, con su certificado digital) y autorizar al\n' +
    'usuario del certificado. Después actualiza FECHA_RESOLUCION_CERT con la fecha de la postulación.'],
  SIN_POSTULACION: ['SIN_POSTULACION', 'La empresa no tiene una postulación abierta en el ambiente de certificación.',
    'El representante legal debe postular (Menú postulantes → Postulación, con su certificado digital) y autorizar al\n' +
    'usuario del certificado. Después actualiza FECHA_RESOLUCION_CERT con la fecha de la postulación.'],
  SIN_ACCESO: ['USUARIO_SIN_ACCESO', 'El usuario del certificado no tiene acceso a esta empresa en el ambiente de certificación.',
    'El administrador de la empresa debe agregarlo en Ambiente de Certificación y Prueba → Actualización de datos empresa\n' +
    'autorizada → Mantención de usuarios, con permisos para solicitar y anular folios, firmar, enviar y consultar.'],
};

// Rango de avance: para no reenviar etapas ya superadas si runs/<RUT>/ quedó atrás.
function rangoPortal(etapa) {
  const e = String(etapa || '').toUpperCase();
  if (/SET DE PRUEBA/.test(e)) return 1;
  if (/SIMULACI/.test(e)) return 2;
  if (/INTERCAMBIO/.test(e)) return 3;
  if (/IMPRES|MUESTRA/.test(e)) return 4;
  if (/DECLARACI|CUMPLIMIENTO/.test(e)) return 5;
  return 0;
}
// ¿El set descargado trae libros? Con PEDIR_LIBROS=0 no.
function setTraeLibros(estado) {
  const E = estado.estructuras || {};
  return ['libroVentas', 'libroCompras', 'libroGuias', 'libroComprasExentos'].some((k) => E[k]);
}

// Ronda con solo sets de exportación (empresa que ya certificó lo nacional): no lleva libros,
// simulación ni intercambio propios. Si el portal los pide igual, se ve en "estado".
function rondaSoloExportacion(estado) {
  const E = estado.estructuras || {};
  return !!(E.setExportacion1 || E.setExportacion2) &&
    !['setBasico', 'setGuiaDespacho', 'setFacturaExenta', 'setFacturaCompra'].some((k) => E[k]);
}

function rangoLocal(estado) {
  if (hecha(estado, 'muestras')) return 5;
  if (hecha(estado, 'intercambio')) return 4;
  if (rondaSoloExportacion(estado) && hecha(estado, 'sets_aprobados')) return 4;
  if (hecha(estado, 'simulacion_aprobada')) return 3;
  if (hecha(estado, 'libros_aprobados')) return 2;
  // Sin libros en el set, aprobar los sets deja lista la simulación.
  if (!setTraeLibros(estado) && hecha(estado, 'sets_aprobados')) return 2;
  return 1;
}

function fallarRespuestaInesperada(c) {
  fallar(`El SII devolvió una página inesperada al consultar el avance: "${c.texto.slice(0, 160)}"`, 'SII_RESPUESTA_INESPERADA', {
    esperando: true, datos: { texto: c.texto },
    accion: `Suele ser mantención o una sesión rechazada. Reintenta en unos minutos; el HTML queda en runs/${RUT}/debug/avance.html.`,
  });
}

// Sets/libros que el portal ya muestra con avance (enviados, en revisión, conformes o rechazados).
function setsConAvancePortal(avance) {
  return Object.entries(avance?.estados || {})
    // ANULADO tampoco es avance: es lo que queda de un set que se reemplazó con uno nuevo.
    .filter(([, e]) => e?.estado && !/POR REALIZAR|NO ENVIAD|SIN ENVI|PENDIENTE DE ENV|ANULAD/i.test(e.estado))
    .map(([clave, e]) => ({ clave, nombre: e.nombre, estado: e.estado }));
}
function localSinSets(estado) {
  return !estado.estructuras && !NOMBRES_SETS.some((n) => hecha(estado, `set_${n}`));
}
const ACCION_SETS_AJENOS = 'Estos envíos no salieron de esta carpeta. Pueden venir de una certificación anterior de la empresa\n' +
  '(el SII conserva esos resultados al volver a postular), de otro equipo o de otro software.\n' +
  '- Si vienen de otro equipo con este runner: trae su carpeta runs/<RUT>/ y relanza.\n' +
  '- Si vienen de una certificación anterior (nadie los envió en esta postulación): descarga un set nuevo con\n' +
  '    REINICIAR_SET=1 node certificar.js todo ' + (typeof ENV_FILE === 'string' ? path.relative(__dirname, ENV_FILE) : '<empresa.env>') + '\n' +
  '  Eso reemplaza los resultados anteriores.';

const COMANDOS_CON_PORTAL = new Set(['sets', 'libros', 'simulacion', 'intercambio', 'muestras', 'cierre', 'todo', 'declarar']);

// Antes de cualquier etapa: confirma que hay una postulación abierta a la que este
// certificado tiene acceso, y que el estado local no está atrasado respecto del portal.
async function verificarPortal(runner, estado, comando) {
  const avance = await runner.consultarAvance();
  const c = clasificarAvance(avance);
  const env = path.relative(__dirname, ENV_FILE);
  if (c.tipo === 'SIN_RESPUESTA') {
    fallar(`El SII no respondió al consultar el avance: ${c.texto}`, 'SII_NO_DISPONIBLE', { esperando: true, accion: 'Reintenta en unos minutos.' });
  }
  if (c.tipo === 'INESPERADA') fallarRespuestaInesperada(c);
  if (c.tipo === 'AUTORIZADA' && estado.ronda?.autorizadaAlDescargar) {
    // Ronda de documentos nuevos (p. ej. exportación) sobre una empresa ya autorizada: el
    // portal la sigue mostrando autorizada, así que no hay paso de avance contra qué comparar.
    log('Portal SII: la empresa ya está autorizada; se sigue con los documentos nuevos de esta ronda.');
    return 'ok';
  }
  if (c.tipo === 'AUTORIZADA') {
    if (comando === 'cierre' || (comando === 'todo' && hecha(estado, 'muestras'))) {
      if (!hecha(estado, 'cierre')) marcar(estado, 'cierre', { porPortal: true });
      emitirAviso('CERTIFICACION_COMPLETA', 'El SII ya registra a la empresa como emisor electrónico.', { nivel: 'info' });
      return 'completa';
    }
    const [codigo, mensaje, accion] = AVISO_PORTAL.AUTORIZADA;
    fallar(mensaje, codigo, { accion, datos: { portal: c.texto } });
  }
  if (c.tipo === 'SIN_ACCESO' || c.tipo === 'SIN_POSTULACION') {
    const [codigo, mensaje, accion] = AVISO_PORTAL[c.tipo];
    fallar(mensaje, codigo, { accion, datos: { portal: c.texto, certificado: CERT_INFO?.rut || null } });
  }
  log(`Portal SII: paso ${c.etapa}.`);
  if (hecha(estado, 'cierre')) {
    // Versiones anteriores marcaban el cierre apenas el SII aceptaba la declaración. Si el portal
    // sigue en proceso, la certificación no terminó: se vuelve a esperar la aprobación.
    delete estado.etapas.cierre;
    if (!hecha(estado, 'cierre_declarado')) marcar(estado, 'cierre_declarado', { corregido: true });
    else guardarEstado(estado);
  }
  const ajenos = setsConAvancePortal(avance);
  const reiniciar = process.env.REINICIAR_SET === '1';
  if (ajenos.length && localSinSets(estado) && reiniciar && ['sets', 'todo'].includes(comando)) {
    emitirAviso('SET_REINICIADO', `Se descarga un set nuevo aunque el portal muestra ${ajenos.length} set(s)/libro(s) con avance (REINICIAR_SET=1).`, {
      nivel: 'advertencia', datos: { etapaPortal: c.etapa, setsAnteriores: ajenos },
      accion: 'Esos resultados quedan reemplazados por los de este set. Úsalo solo si vienen de una certificación anterior.',
    });
  } else if (ajenos.length && localSinSets(estado) && ['sets', 'libros', 'todo', 'declarar'].includes(comando)) {
    fallar(`El portal ya tiene ${ajenos.length} set(s)/libro(s) con avance, pero esta carpeta no envió ninguno.`, 'SETS_ENVIADOS_POR_OTRO', {
      accion: ACCION_SETS_AJENOS, datos: { etapaPortal: c.etapa, sets: ajenos },
    });
  }
  const rp = rangoPortal(c.etapa);
  if (rp && !estado.estructuras && rp > 1 && ['sets', 'todo'].includes(comando)) {
    fallar(`El portal está en el paso ${c.etapa}, pero no hay estado local (runs/${RUT}/estado.json).`, 'ESTADO_LOCAL_PERDIDO', {
      accion: 'No corras sets: descargar el set de nuevo reinicia la postulación en el SII. Recupera la carpeta runs/<RUT>/ del equipo donde se empezó.',
      datos: { etapaPortal: c.etapa },
    });
  }
  if (rp && rp > rangoLocal(estado) && COMANDOS_CON_PORTAL.has(comando) && comando !== 'declarar') {
    fallar(`El portal va en el paso ${c.etapa}, más adelante que el estado local.`, 'ESTADO_LOCAL_ATRASADO', {
      accion: 'Seguir reenviaría etapas ya aprobadas y gastaría folios. Recupera runs/<RUT>/ del equipo donde se avanzó,\n' +
        `o revisa con: node certificar.js estado ${env}`,
      datos: { etapaPortal: c.etapa, rangoPortal: rp, rangoLocal: rangoLocal(estado) },
    });
  }
  return 'ok';
}

async function etapaEstado(runner, estado) {
  const avance = await runner.consultarAvance();
  const c = clasificarAvance(avance);
  try {
    fs.mkdirSync(config.debugDir, { recursive: true });
    fs.writeFileSync(path.join(config.debugDir, 'avance.html'), avance?.rawHtml || '');
  } catch (_) {}
  const env = path.relative(__dirname, ENV_FILE);

  console.log('\nEstado en el portal del SII:');
  if (c.tipo === 'SIN_RESPUESTA') {
    fallar(`El SII no respondió al consultar el avance: ${c.texto}`, 'SII_NO_DISPONIBLE', { esperando: true, accion: 'Reintenta en unos minutos.' });
  }
  if (c.tipo === 'INESPERADA') fallarRespuestaInesperada(c);
  const sets = {};
  if (c.tipo === 'EN_PROCESO') {
    console.log(`  Paso actual: ${c.etapa}`);
    for (const [clave, e] of Object.entries(avance.estados || {})) {
      console.log(`  ${(e.nombre + ' ').padEnd(36, '.')} ${e.estado}`);
      sets[clave] = e.estado;
      if (e.datoInconsistente) {
        emitirAviso('SET_CONTENIDO_NO_CORRESPONDE', `${e.nombre}: ${e.estado}.`, {
          nivel: 'advertencia', datos: { set: clave, estado: e.estado },
          accion: 'El SII compara cada documento con el caso del set. Revisa el correo de resultados del SII (qué caso y qué\n' +
            `línea), corrige y reenvía ese set: node certificar.js rehacer ${env} <set>`,
        });
      } else if (e.esRechazado) {
        emitirAviso('SET_RECHAZADO', `${e.nombre}: ${e.estado}.`, {
          nivel: 'advertencia', datos: { set: clave, estado: e.estado },
          accion: `Mira el motivo con: node certificar.js consultar ${env}\nLuego reenvía: node certificar.js rehacer ${env} <set>`,
        });
      }
    }
  } else {
    console.log(`  ${c.texto || '(sin texto)'}`);
    const [codigo, mensaje, accion] = AVISO_PORTAL[c.tipo];
    if (c.tipo === 'AUTORIZADA' && hecha(estado, 'muestras')) {
      emitirAviso('CERTIFICACION_COMPLETA', 'El SII ya registra a la empresa como emisor electrónico.', { nivel: 'info' });
    } else {
      emitirAviso(codigo, mensaje, { nivel: c.tipo === 'SIN_ACCESO' ? 'error' : 'advertencia', accion, datos: { portal: c.texto } });
    }
  }
  if (c.tipo === 'EN_PROCESO') {
    const ajenos = setsConAvancePortal(avance);
    if (ajenos.length && localSinSets(estado)) {
      emitirAviso('SETS_ENVIADOS_POR_OTRO', `El portal ya tiene ${ajenos.length} set(s)/libro(s) con avance, pero esta carpeta no envió ninguno.`, {
        nivel: 'advertencia', accion: ACCION_SETS_AJENOS, datos: { etapaPortal: c.etapa, sets: ajenos },
      });
    }
  }
  const etapasLocales = Object.keys(estado.etapas || {}).filter((k) => estado.etapas[k]?.ok);
  console.log(`\nEstado local (runs/${RUT}/): ${etapasLocales.length ? etapasLocales.join(', ') : 'sin avances'}`);
  console.log(`HTML del portal guardado en ${path.relative(__dirname, path.join(config.debugDir, 'avance.html'))}`);
  return { resultado: { portal: c.tipo, etapaPortal: c.etapa || null, sets, etapasLocales } };
}

// Arma runner._cafsPrecargados desde los CAF que ya están en disco, sin tocar el SII.
// Con esto los sets usan esos folios directo y el runner no timbra ni anula por su cuenta.
// Requiere que antes se hayan conseguido los folios con: node certificar.js folios ...
// Devuelve los CAF en disco de un tipo que siguen siendo servibles: no consumidos en un
// envío y no anulados en el SII. Fuente de verdad: registros del runner y de FolioService.
function cafsServibles(runner, tipo) {
  const fs_ = runner.folioService;
  const rutas = (fs_.listarCafs ? fs_.listarCafs(Number(tipo)) : []).map((x) => x.filePath || x);
  let anulados = new Set();
  try { anulados = fs_._cargarAnulados(Number(tipo)); } catch (_) {}
  let maxConsumido = 0;
  try {
    const reg = runner._cargarFoliosUsados()[String(tipo)] || [];
    for (const [, hh] of reg) if (hh > maxConsumido) maxConsumido = hh;
  } catch (_) {}
  const vistos = new Set();
  const out = [];
  for (const r of rutas) {
    if (fs.existsSync(`${r}.usado`)) continue;
    let d, h;
    try {
      const xml = fs.readFileSync(r, 'utf8');
      d = parseInt((xml.match(/<D>(\d+)<\/D>/) || [])[1], 10);
      h = parseInt((xml.match(/<H>(\d+)<\/H>/) || [])[1], 10);
    } catch (_) { continue; }
    if (!d || !h) continue;
    if (typeof runner._rangoYaConsumido === 'function' && runner._rangoYaConsumido(Number(tipo), d, h)) continue;
    if (anulados.has(`${d}-${h}`)) continue;
    // Los folios nuevos siempre son mayores que los ya emitidos. Un CAF con folios más bajos
    // que el último consumido es viejo (reobtenido o remanente) y no se confía en él.
    if (h <= maxConsumido) continue;
    const clave = `${d}-${h}`;
    if (vistos.has(clave)) continue;
    vistos.add(clave);
    out.push({ ruta: r, d, h });
  }
  return out;
}

// Folios que necesita cada set (cafRequired del set si viene, o el estándar de la librería).
function necesidadDelSet(runner, clave) {
  const E = runner._estructuras || {};
  const S = E[clave];
  if (!S) return null;
  // Un tipo con 0 no se pide: un folio timbrado sin usar es lo que dispara el racionamiento.
  const sinCeros = (plan) => Object.fromEntries(Object.entries(plan).filter(([, n]) => Number(n) > 0));
  if (S.cafRequired) return sinCeros({ ...S.cafRequired });
  if (/^setExportacion/.test(clave)) {
    const plan = {};
    for (const c of S.casos || []) plan[c.tipoDTE] = (plan[c.tipoDTE] || 0) + 1;
    return plan;
  }
  return {
    setBasico: { 33: 4, 56: 1, 61: 3 },
    setGuiaDespacho: { 52: S.casos?.length || 3 },
    setFacturaExenta: { 34: 3, 56: 1, 61: 4 },
    setFacturaCompra: { 46: 1, 56: 1, 61: 1 },
  }[clave] || {};
}

// Menor folio de CUALQUIER CAF nuestro en disco para un tipo, usado o no. Un folio recién
// enviado puede verse "sin usar" en el SII durante unos segundos; anularlo invalida el envío.
function menorFolioEnDisco(runner, tipo) {
  const fs_ = runner.folioService;
  const rutas = (fs_.listarCafs ? fs_.listarCafs(Number(tipo)) : []).map((x) => x.filePath || x);
  let min = null;
  for (const r of rutas) {
    try {
      const d = parseInt((fs.readFileSync(r, 'utf8').match(/<D>(\d+)<\/D>/) || [])[1], 10);
      if (d && (min === null || d < min)) min = d;
    } catch (_) {}
  }
  return min;
}

function precargarDesdeDisco(runner, estado, needExplicita) {
  const fs_ = runner.folioService;
  let need = needExplicita;
  if (!need) {
    // Sin necesidad explícita: total de la corrida, sumando los sets presentes.
    need = {};
    const add = (obj) => { for (const [k, v] of Object.entries(obj || {})) need[k] = (need[k] || 0) + Number(v); };
    for (const c of SETS.map(([, e]) => e)) add(necesidadDelSet(runner, c));
  }

  const mapa = {};
  const faltan = [];   // [tipo, cantidadFaltante]
  let algunoEnDisco = false;
  for (const [tipo, cantidad] of Object.entries(need)) {
    const serv = cafsServibles(runner, tipo);
    const usables = serv.map((s) => s.ruta);
    const disponibles = serv.reduce((n, s) => n + (s.h - s.d + 1), 0);
    if (disponibles > 0) algunoEnDisco = true;
    if (disponibles < cantidad) { faltan.push([Number(tipo), cantidad - disponibles]); continue; }
    mapa[tipo] = usables.length > 1 ? usables : usables[0];
  }
  return { mapa, faltan, algunoEnDisco, need };
}

// Deja runner._cafsPrecargados listo para los sets, eligiendo la vía según el caso:
//   1) todo en disco → se usa sin tocar el SII;
//   2) nada en disco → vía normal de la librería (RUT limpio: pide todo junto);
//   3) falta algo o la vía normal falla por racionamiento → de a uno, con anulación protegida.
async function asegurarFolios(runner, estado, needExplicita) {
  let r = precargarDesdeDisco(runner, estado, needExplicita);
  if (!r.faltan.length) {
    runner._cafsPrecargados = r.mapa;
    log('Folios: todos en disco, sin tocar el SII (tipos ' + Object.keys(r.mapa).join(', ') + ').');
    return;
  }
  log(r.algunoEnDisco
    ? 'Folios: hay parte en disco; se pide al SII solo lo que falta.'
    : 'Folios: no hay nada en disco; se pide al SII lo que necesita este set.');
  if (r.faltan.length) {
    const ok = await conseguirFolios(runner, r.faltan, estado);
    if (!ok) fallarPorFolios();
    r = precargarDesdeDisco(runner, estado, needExplicita);
    if (r.faltan.length) fallar('Siguen faltando folios: ' + r.faltan.map(([t, c]) => `${t} (${c})`).join(', '), 'FOLIOS_INCOMPLETOS', { esperando: true, accion: 'Relanza el mismo comando.' });
  }
  runner._cafsPrecargados = r.mapa;
  log('Folios listos (tipos ' + Object.keys(r.mapa).join(', ') + ').');
}

// Regla 10: antes de pedir folios de un tipo, espera a que el SII procese los envíos de esta
// corrida que usaron ese tipo. Mientras no los procesa, esos folios cuentan como "sin usar"
// (FOLIOS_DISP) y el pedido cae en racionamiento, advertencias y bloqueo. Así se bloqueó
// la nota de débito de Norma: se pidió la de la exenta con la del básico recién enviada.
async function esperarProcesados(runner, pendientes, tiposNecesarios) {
  const tipos = new Set(tiposNecesarios.map(String));
  const intervaloMs = parseInt(process.env.ESPERA_PROCESO_SEG || '20', 10) * 1000;
  const maxIntentos = parseInt(process.env.ESPERA_PROCESO_INTENTOS || '30', 10);   // ~10 min
  for (const p of [...pendientes]) {
    if (!p.tipos.some((t) => tipos.has(String(t)))) continue;
    for (let i = 1; i <= maxIntentos; i++) {
      const st = await estadoEnvio(runner, p.trackId);
      if (st?.final) {
        log(`Envío ${p.trackId}: procesado por el SII (${st.estado}${st.glosa ? ` — ${st.glosa}` : ''}).`);
        pendientes.splice(pendientes.indexOf(p), 1);
        break;
      }
      if (i === 1) log(`Esperando que el SII procese el envío ${p.trackId} antes de pedir folios de los mismos tipos...`);
      if (i === maxIntentos) {
        log(`Envío ${p.trackId}: el SII no terminó de procesarlo; se sigue igual.`);
        break;
      }
      await new Promise((res) => setTimeout(res, intervaloMs));
    }
  }
}

// Traduce el rechazo de la declaración a los comandos que hay que correr.
function guiaDeclaracionFallida(msg) {
  const env = path.relative(__dirname, ENV_FILE);
  const mapa = [[/SET BASICO/i, 'basico'], [/GUIA/i, 'guia'], [/EXENTA/i, 'exenta'], [/COMPRA/i, 'compra'], [/EXPORTACI/i, 'exportacion']];
  const sets = mapa.filter(([re]) => re.test(msg)).map(([, n]) => n);
  const lista = sets.length ? sets.join(' ') : '<set>';
  return `Declaración falló: ${msg}\n\n` +
    'Qué hacer, según el diagnóstico de arriba:\n' +
    '  • Si dice "SII no disponible (HTTP 503)" o todavía no hay estado: espera unos minutos y relanza\n' +
    `    "node certificar.js todo ${env}". Vuelve a declarar sin reenviar nada.\n` +
    '  • Si dice RFR, RCT, RSC u otro rechazo: corrige la causa y reenvía esos sets con folios nuevos:\n' +
    `      node certificar.js rehacer ${env} ${lista}\n` +
    `      node certificar.js todo ${env}\n` +
    '    Los folios del envío rechazado se anulan solo si el SII llega a bloquear ese tipo.';
}

function fallarDeclaracion(msg) {
  const temporal = /503|no disponible|ECONNRESET|ETIMEDOUT|sin estado/i.test(msg);
  fallar(guiaDeclaracionFallida(msg), temporal ? 'SII_NO_DISPONIBLE' : 'DECLARACION_RECHAZADA', {
    esperando: temporal, datos: { etapa: 'sets', detalle: msg },
  });
}

// Página de generación de sets del portal (pe_generar): qué sets opcionales ofrece y cuáles
// ya se obtuvieron. Solo abre la página y confirma la empresa: no genera ningún set.
async function paginaGeneracionSets(runner) {
  const pagina = await runner.siiCert.generarSetPruebas({ descargar: false });
  if (!pagina?.success) {
    fallar(`No se pudo abrir la página de generación de sets: ${pagina?.error || 'sin respuesta'}`, 'SII_NO_DISPONIBLE', {
      esperando: true, accion: 'Reintenta en unos minutos.',
    });
  }
  if (pagina.noInscrito) {
    fallar('El SII dice que la empresa no está inscrita para generar sets de prueba.', 'SIN_POSTULACION', {
      accion: AVISO_PORTAL.SIN_POSTULACION[2],
    });
  }
  return pagina;
}

// Descarga el set de pruebas (REINICIA la postulación: regla 6) y lo deja en estado.json.
async function descargarSetDePruebas(runner, estado, pagina = null) {
  // La librería pide por defecto guía, exenta Y factura de compra (SET72), aunque la
  // empresa no los haya postulado. SETS_ADICIONALES del .env define cuáles pedir.
  const adicionales = setsAdicionales();
  // Libros de ventas y compras. PEDIR_LIBROS=0 los deja fuera (ronda de documentos nuevos
  // sobre una empresa que ya certificó sus libros).
  const conLibros = process.env.PEDIR_LIBROS !== '0';
  const setsOpcionales = conLibros ? { SET07: 'S', SET08: 'S', SET15: 'S' } : {};
  if (adicionales.has('guia')) { setsOpcionales.SET03 = 'S'; if (conLibros) setsOpcionales.SET09 = 'S'; }
  if (adicionales.has('exenta')) setsOpcionales.SET06 = 'S';
  if (adicionales.has('compra')) setsOpcionales.SET72 = 'S';
  if (adicionales.has('exportacion')) {
    exigirLibreriaConExportacion(runner);
    // Los códigos de los sets de exportación se leen de la página: son casillas con nombre.
    const p = pagina || await paginaGeneracionSets(runner);
    const expo = (p.setsOpcionales || []).filter((x) => /EXPORTACI/i.test(x.nombre));
    if (!expo.length) {
      fallar('El portal no ofrece el set de exportación para esta empresa.', 'SET_EXPORTACION_NO_DISPONIBLE', {
        datos: { disponibles: p.setsOpcionales || [] },
        accion: 'La postulación debe incluir los documentos de exportación (110, 111, 112).\n' +
          `Sets que ofrece el portal: ${(p.setsOpcionales || []).map((x) => `${x.id} ${x.nombre}`).join(' · ') || 'ninguno'}`,
      });
    }
    for (const x of expo) setsOpcionales[x.id] = 'S';
    log(`Sets de exportación del portal: ${expo.map((x) => `${x.id} ${x.nombre}`).join(' · ')}`);
  }
  // INCLUIR_BASICO=0 no pide el set básico (la librería lo marca siempre). Solo para una ronda
  // de documentos nuevos en una empresa autorizada, y si "descargar ver" muestra que el portal
  // no lo exige: sin verificar todavía contra el SII.
  const incluirBasico = process.env.INCLUIR_BASICO !== '0';
  log(`Descargando set de pruebas del portal SII (${incluirBasico ? 'básico + ' : 'SIN básico + '}${[...adicionales].join(', ') || 'nada más'}${conLibros ? ', libros' : ', sin libros'})...`);
  const r = await runner.obtenerSets({ setsOpcionales, incluirBasico });
  if (!r.success) fallar(`No se pudo descargar el set de pruebas: ${r.error}`, 'SET_NO_DESCARGADO', { accion: 'Revisa que la postulación esté activa (node certificar.js estado) y reintenta.' });
  estado.estructuras = r.estructuras;
  guardarEstado(estado);
  log(`Set obtenido: ${Object.keys(r.estructuras).filter((k) => r.estructuras[k]).join(', ')}`);
  if (adicionales.has('exportacion') && !r.estructuras.setExportacion1 && !r.estructuras.setExportacion2) {
    emitirAviso('SET_EXPORTACION_NO_LEIDO', 'Se pidió exportación pero el set descargado no trae casos de exportación que el parser reconozca.', {
      nivel: 'advertencia', datos: { debug: path.relative(__dirname, path.join(config.debugDir, 'set-texto.txt')) },
      accion: `Manda ${path.relative(__dirname, path.join(config.debugDir, 'set-texto.txt'))} para revisar el formato.`,
    });
  }
  return r.estructuras;
}

async function etapaSets(runner, estado) {
  // 1. Set de pruebas (solo una vez)
  if (!estado.estructuras) {
    await descargarSetDePruebas(runner, estado);
    if (process.env.REINICIAR_SET === '1') {
      // Con resultados anteriores en el portal, confirmar que el set nuevo los limpió: si no,
      // la espera de aprobación leería los "REVISADO CONFORME" viejos y avanzaría en falso.
      const quedan = setsConAvancePortal(await runner.consultarAvance());
      if (quedan.length) {
        fallar(`Se descargó el set nuevo, pero el portal sigue mostrando ${quedan.length} resultado(s) anteriores.`, 'SET_REINICIO_NO_APLICADO', {
          datos: { sets: quedan },
          accion: 'No sigas: el runner confundiría esos resultados con los del set nuevo. Revisa "Ver avance" en el SII;\n' +
            'cuando los estados queden vacíos, relanza sin REINICIAR_SET. El set ya quedó guardado en runs/<RUT>/.',
        });
      }
      marcar(estado, 'set_reiniciado', { anteriores: 'limpiados' });
    }
  } else {
    log('Set de pruebas ya descargado, reutilizando.');
  }

  // 2 y 3. Los cuatro sets, en orden. Los folios se consiguen SET POR SET, justo antes de
  // enviarlo: el SII raciona los folios sin usar, así que pedir los de todos los sets por
  // adelantado se bloquea en RUTs con historial. Usar y volver a pedir es lo que el SII espera.
  const sets = SETS.map(([nombre, clave, metodo]) => [`set_${nombre}`, clave, metodo, nombre]);

  let enviadosAhora = 0;
  const enviosPendientes = [];   // { trackId, tipos } enviados en esta corrida y aún sin procesar
  const contratados = setsContratados();
  const tieneCasos = (e) => e && Object.values(e).some((v) => Array.isArray(v) ? v.length : v && typeof v === 'object');
  // Se pidió exportación y el parser no encontró sus casos: no se gastan folios en el resto
  // hasta resolverlo (la certificación no podría cerrar).
  if (contratados.has('exportacion1') && !estado.estructuras.setExportacion1 && !estado.estructuras.setExportacion2) {
    fallar('Se pidió exportación, pero el set guardado no trae casos de exportación que el parser reconozca.', 'SET_EXPORTACION_NO_LEIDO', {
      accion: `Manda ${path.relative(__dirname, path.join(config.debugDir, 'set-texto.txt'))} para ajustar el parser.\n` +
        'No descargues el set otra vez: reinicia la postulación.',
    });
  }
  // Exportación: el tipo de cambio del día para cada moneda del set, antes del primer envío.
  const exportacionPendiente = sets.some(([etapa, clave, , nombre]) =>
    /^exportacion/.test(nombre) && contratados.has(nombre) && tieneCasos(estado.estructuras[clave]) && !hecha(estado, etapa));
  if (exportacionPendiente) {
    config.exportacion.tiposCambio = await tiposDeCambio(estado, monedasDeExportacion(estado.estructuras));
  }
  for (const [etapa, clave, metodo, nombre] of sets) {
    if (!tieneCasos(estado.estructuras[clave]) || !contratados.has(nombre)) {
      log(`Set ${nombre}: no viene en la postulación${contratados.has(nombre) ? '' : ' (no está en SETS_ADICIONALES)'}, se omite.`);
      continue;
    }
    if (hecha(estado, etapa)) {
      log(`Set ${nombre}: ya enviado (TrackID ${estado.etapas[etapa].trackId}).`);
      continue;
    }
    const need = necesidadDelSet(runner, clave);
    log(`Set ${nombre}: necesita folios ${JSON.stringify(need)}`);
    await esperarProcesados(runner, enviosPendientes, Object.keys(need));
    await asegurarFolios(runner, estado, need);
    log(`Enviando set ${nombre}...`);
    const r = await sinInterrumpir(async () => {
      const envio = await runner[metodo]();
      if (envio.success) {
        estado.resultados[nombre] = envio;
        marcar(estado, etapa, { trackId: envio.trackId });
      }
      return envio;
    });
    if (!r.success) fallar(`Set ${nombre}: no se pudo generar o enviar: ${r.error}`, 'SET_NO_ENVIADO', { datos: { set: nombre }, accion: 'Si es un error de conexión, relanza. Si no, revisa el detalle.' });
    enviadosAhora++;
    enviosPendientes.push({ trackId: r.trackId, tipos: Object.keys(foliosDeEnvio(r.trackId) || need) });
    log(`Set ${nombre} enviado. TrackID ${r.trackId}`);
  }

  // Si se envió algún set después de una declaración anterior, hay que declarar de nuevo.
  if (enviadosAhora && hecha(estado, 'sets_declarados')) {
    delete estado.etapas.sets_declarados;
    delete estado.etapas.sets_aprobados;
    guardarEstado(estado);
  }

  // 4. Declarar avance
  if (!hecha(estado, 'sets_declarados')) {
    log('Declarando avance de sets en el portal...');
    const r = await runner.declararAvance(undefined, undefined, { ignorarVacio: true });
    if (!r.success) fallarDeclaracion(r.error || r.mensaje || '');
    marcar(estado, 'sets_declarados');
  }

  // 5. Esperar aprobación
  if (!hecha(estado, 'sets_aprobados')) {
    log(`Esperando aprobación del SII (hasta ${POLL.maxIntentos} intentos cada ${POLL.intervalo / 1000}s)...`);
    const r = process.env.CONFIRMAR_SETS_APROBADOS === '1'
      ? { success: true, manual: true }
      : await runner.esperarAprobacion(undefined, POLL);
    if (r.manual) log('Sets dados por aprobados a mano (CONFIRMAR_SETS_APROBADOS=1).');
    if (!r.success) {
      if (r.sinEstado?.length) {
        emitirAviso('SET_SIN_ESTADO_EN_PORTAL', `La página de avance del SII no muestra el estado de: ${r.sinEstado.join(', ')}.`, {
          nivel: 'advertencia', datos: { sets: r.sinEstado },
          accion: `Revisa el avance en el portal (node certificar.js estado ${path.relative(__dirname, ENV_FILE)}; queda en debug/avance.html).\n` +
            'Si el SII ya los aprobó, relanza una vez con CONFIRMAR_SETS_APROBADOS=1.',
        });
        AVISO_ESPERA_EMITIDO = true;
      }
      log('El SII aún no aprueba los sets. Relanza "node certificar.js sets" más tarde.');
      return false;
    }
    marcar(estado, 'sets_aprobados', r.manual ? { manual: true } : {});
  }

  log('✓ Etapa SETS completa.');
  return true;
}

// ─────────────────────────────────────────────────────────────────
// descargar: bajar el set sin enviar nada
// ─────────────────────────────────────────────────────────────────
// Sirve para (1) ver qué trae el set antes de gastar folios, sobre todo en exportación, donde
// cada texto del set se traduce a un código de Aduana; y (2) empezar una ronda de documentos
// nuevos en una empresa ya autorizada. Descargar un set REINICIA la postulación (regla 6), así
// que se niega si el portal muestra la empresa a mitad de certificación.

// Guarda el estado de la certificación anterior y deja uno limpio para la ronda nueva. Los
// folios muertos se conservan: siguen pesando en el SII.
function archivarRonda(estado, motivo) {
  const hayAlgo = estado.estructuras || Object.keys(estado.etapas || {}).length;
  if (!hayAlgo) return null;
  const sello = horaChile().replace(/[-:T]/g, '').slice(0, 14);
  const archivo = `${ESTADO_PATH}.ronda-${sello}`;
  fs.copyFileSync(ESTADO_PATH, archivo);
  estado.etapas = {};
  estado.estructuras = null;
  estado.resultados = {};
  estado.log = [{ fecha: new Date().toISOString(), etapa: 'ronda_nueva', motivo, anterior: path.basename(archivo) }];
  guardarEstado(estado);
  log(`Estado anterior guardado en ${path.relative(__dirname, archivo)}.`);
  return archivo;
}

// Revisión de lo que se va a emitir en exportación, sin folios ni firma: códigos de Aduana,
// montos, y las líneas del set que nada interpretó.
function revisarExportacion(estructuras, tiposCambio) {
  const { SetExportacion, CertFolioHelper } = requerirModulo('@devlas/dte-sii/cert');
  const problemas = [];
  for (const [nombre, clave] of [['exportacion1', 'setExportacion1'], ['exportacion2', 'setExportacion2']]) {
    const casos = estructuras?.[clave];
    if (!casos) continue;
    console.log(`\n${nombre === 'exportacion1' ? 'SET DOCUMENTOS DE EXPORTACION' : 'SET DOCUMENTOS DE EXPORTACION(2)'} · atención ${casos.numeroAtencion} · ${casos.casos.length} casos`);
    const set = new SetExportacion({
      key: nombre,
      config: { ...config, exportacion: { ...config.exportacion, tiposCambio: tiposCambio || (() => 1) } },
      cafManager: { ensureCaf: async () => null },
      folioHelper: new CertFolioHelper({ ambiente: 'certificacion' }),
      enviador: { enviar: async () => ({ success: false }) },
      logger: { log() {}, error() {} },
    });
    let plan;
    try {
      plan = set.planificar(casos);
    } catch (e) {
      problemas.push(e.message);
      console.log(`  ✗ ${e.message}`);
      continue;
    }
    for (const p of plan) {
      const e = p.datos.Encabezado;
      const a = e.Transporte?.Aduana || {};
      const partes = [
        `${p.tipoDte} caso ${p.caso}`,
        `${e.Totales.MntTotal} ${e.Totales.TpoMoneda}`,
        a.CodClauVenta ? `cláusula ${a.CodClauVenta}` : null,
        a.CodViaTransp ? `vía ${a.CodViaTransp}` : null,
        a.CodPtoEmbarque ? `embarque ${a.CodPtoEmbarque}` : null,
        a.CodPtoDesemb ? `desembarque ${a.CodPtoDesemb}` : null,
        a.CodPaisRecep ? `país ${a.CodPaisRecep}` : null,
        a.TotBultos ? `bultos ${a.TotBultos}` : null,
        e.IdDoc.FmaPagExp ? `pago ${e.IdDoc.FmaPagExp}` : null,
      ].filter(Boolean);
      console.log(`  • ${partes.join(' · ')}`);
      for (const d of p.datos.Detalle) console.log(`      ${d.NmbItem}: ${d.QtyItem ?? ''} × ${d.PrcItem ?? ''} = ${d.MontoItem}`);
      for (const av of p.avisos) console.log(`      ⚠ ${av}`);
    }
  }
  return problemas;
}

async function etapaDescargar(runner, estado) {
  const soloVer = String(process.argv[4] || '').toLowerCase() === 'ver';
  const env = path.relative(__dirname, ENV_FILE);

  // 1. Dónde está la postulación.
  const avance = await runner.consultarAvance();
  const c = clasificarAvance(avance);
  if (c.tipo === 'SIN_RESPUESTA') fallar(`El SII no respondió al consultar el avance: ${c.texto}`, 'SII_NO_DISPONIBLE', { esperando: true, accion: 'Reintenta en unos minutos.' });
  if (c.tipo === 'INESPERADA') fallarRespuestaInesperada(c);
  if (c.tipo === 'SIN_ACCESO') {
    const [codigo, mensaje, accion] = AVISO_PORTAL.SIN_ACCESO;
    fallar(mensaje, codigo, { accion, datos: { portal: c.texto } });
  }
  log(`Portal SII: ${c.tipo === 'EN_PROCESO' ? `paso ${c.etapa}` : c.tipo === 'AUTORIZADA' ? 'empresa autorizada como emisor' : c.tipo}.`);

  // 2. Qué ofrece la página de generación (no genera nada).
  const pagina = await paginaGeneracionSets(runner);
  console.log('\nSets que ofrece el portal:');
  for (const x of pagina.setsOpcionales || []) console.log(`  ${x.id}  ${x.nombre}`);
  if ((pagina.estadoSets || []).length) {
    console.log('Sets obtenidos antes:');
    for (const x of pagina.estadoSets) console.log(`  ${x.nombre}: ${x.estado}`);
  }
  const conExportacion = libreriaConExportacion(runner);
  console.log(`\nLibrería instalada: ${conExportacion ? 'con exportación' : 'SIN exportación (npm install github:KonosCL/dte-sii)'}.`);
  const resultadoPagina = {
    portal: c.tipo, etapaPortal: c.etapa || null,
    setsDisponibles: (pagina.setsOpcionales || []).map((x) => `${x.id} ${x.nombre}`),
    libreriaConExportacion: conExportacion,
  };
  if (soloVer) return { resultado: resultadoPagina };
  // Antes de archivar la ronda: sin esto, una librería vieja dejaba el estado reiniciado y el
  // set sin bajar.
  if (setsAdicionales().has('exportacion')) exigirLibreriaConExportacion(runner);

  // 3. Descargar reinicia la postulación: no a mitad de camino, salvo que se pida.
  // Tres señales de que hay una certificación en marcha: el paso del portal, sets con avance en
  // el portal, y sets enviados desde esta carpeta en la ronda actual sin cierre (el portal los
  // muestra POR REALIZAR hasta que se declaran, y a una empresa autorizada no le muestra pasos).
  const conAvance = setsConAvancePortal(avance);
  const pasoDesconocido = c.tipo === 'EN_PROCESO' && rangoPortal(c.etapa) === 0;
  const enviadosLocal = NOMBRES_SETS.filter((n) => hecha(estado, `set_${n}`));
  const rondaAbierta = !hecha(estado, 'cierre') && (enviadosLocal.length > 0 || hecha(estado, 'sets_declarados'));
  const aMitad = (c.tipo === 'EN_PROCESO' && (rangoPortal(c.etapa) > 1 || conAvance.length > 0)) || pasoDesconocido || rondaAbierta;
  if (aMitad && process.env.FORZAR_DESCARGA !== '1') {
    const motivos = [
      c.tipo === 'EN_PROCESO' ? `paso ${c.etapa || '?'}${pasoDesconocido ? ' (no reconocido)' : ''}` : null,
      conAvance.length ? `${conAvance.length} set(s) con avance en el portal` : null,
      rondaAbierta ? `sets enviados desde aquí sin cierre: ${enviadosLocal.join(', ') || 'declarados'}` : null,
    ].filter(Boolean).join(' · ');
    fallar(`La empresa está a mitad de certificación (${motivos}). ` +
      'Bajar un set nuevo reinicia la postulación y se pierde lo avanzado.', 'DESCARGA_REINICIA_POSTULACION', {
      datos: { etapaPortal: c.etapa, sets: conAvance, enviadosLocal },
      accion: 'Espera a que termine esta certificación. Si de verdad quieres empezar de cero:\n' +
        `  FORZAR_DESCARGA=1 node certificar.js descargar ${env}`,
    });
  }
  if (c.tipo === 'SIN_POSTULACION') {
    const [codigo, mensaje, accion] = AVISO_PORTAL.SIN_POSTULACION;
    fallar(mensaje, codigo, { accion, datos: { portal: c.texto } });
  }

  // 4. Ronda nueva: el estado de la certificación anterior queda archivado.
  const motivo = c.tipo === 'AUTORIZADA' ? 'documentos nuevos sobre empresa autorizada' : aMitad ? 'forzado' : 'descarga';
  archivarRonda(estado, motivo);
  estado.ronda = { inicio: new Date().toISOString(), autorizadaAlDescargar: c.tipo === 'AUTORIZADA', sets: [...setsContratados()] };
  guardarEstado(estado);

  // 5. Descarga.
  const estructuras = await descargarSetDePruebas(runner, estado, pagina);
  marcar(estado, 'set_descargado', { sets: Object.keys(estructuras).filter((k) => estructuras[k]) });

  // 6. Qué se va a emitir.
  console.log('\nSet descargado (nada se envió al SII):');
  for (const [nombre, clave] of SETS) {
    const e = estructuras[clave];
    if (!e) continue;
    const plan = necesidadDelSet(runner, clave) || {};
    console.log(`  ${nombre.padEnd(13)} atención ${e.numeroAtencion || '?'} · folios ${Object.entries(plan).map(([t, n]) => `${t}×${n}`).join(' ') || '—'}`);
  }
  let problemas = [];
  if (estructuras.setExportacion1 || estructuras.setExportacion2) {
    let tc = null;
    try {
      tc = await tiposDeCambio(estado, monedasDeExportacion(estructuras));
    } catch (e) {
      emitirAviso('TIPO_CAMBIO_PENDIENTE', `Sin tipo de cambio todavía (${e.message}); la revisión usa 1 y hay que darlo antes de "todo".`, { nivel: 'advertencia' });
    }
    problemas = revisarExportacion(estructuras, tc);
    if (problemas.length) {
      emitirAviso('EXPORTACION_CON_PROBLEMAS', `El set de exportación tiene ${problemas.length} dato(s) que no se pudieron traducir.`, {
        nivel: 'advertencia', datos: { problemas },
        accion: 'Resuélvelos antes de "todo" (EXPORTACION_CODIGOS en el .env) o manda el set para ajustar la librería:\n' +
          `  ${path.relative(__dirname, path.join(config.debugDir, 'set-texto.txt'))}`,
      });
    }
  }
  console.log(`\nTexto del set: ${path.relative(__dirname, path.join(config.debugDir, 'set-texto.txt'))}`);
  console.log(`Siguiente paso: node certificar.js todo ${env}`);
  return { resultado: { ...resultadoPagina, descargado: true, problemasExportacion: problemas } };
}

async function etapaLibros(runner, estado) {
  if (!hecha(estado, 'sets_aprobados')) fallar('Primero deben aprobarse los sets.', 'ETAPA_PREVIA_PENDIENTE', { accion: 'node certificar.js todo ' + path.relative(__dirname, ENV_FILE) });

  if (!hecha(estado, 'libros_enviados')) {
    log('Enviando libros de compras, ventas y guías...');
    const r = await runner.ejecutarFase4Libros({ setsResultados: estado.resultados });
    if (!r.success) fallar(`Libros: no se pudieron enviar: ${r.error || JSON.stringify(r)}`, 'LIBROS_NO_ENVIADOS', { accion: 'Si es un error de conexión, relanza. Si no, revisa el detalle.' });
    marcar(estado, 'libros_enviados', { libros: r.libros || r });
  }

  if (!hecha(estado, 'libros_aprobados')) {
    log('Esperando aprobación de libros y avanzando...');
    const r = await runner.esperarLibrosYAvanzar(POLL);
    if (!r.success) {
      log(`Libros aún no aprobados: ${r.mensaje || r.error}. Relanza más tarde.`);
      return false;
    }
    marcar(estado, 'libros_aprobados');
  }

  log('✓ Etapa LIBROS completa.');
  return true;
}

// Plan de simulación: el SII pide 20 o más documentos representativos que incluyan todos
// los tipos en certificación. La librería copia los casos del set (22 docs con 7 NC y 4 ND),
// lo que exige muchos folios de notas que un RUT racionado no consigue juntos. Aquí se
// duplican facturas y exentas (mismos datos, ids distintos) y se deja 1 NC por set y 1 ND:
// 8 facturas + 6 exentas + 3 guías + 1 compra + 3 NC + 1 ND = 22 documentos.
function armarEstructurasSimulacion(E) {
  const clon = (c, suf) => ({ ...c, id: `${c.id}${suf}` });
  const S = JSON.parse(JSON.stringify(E || {}));
  if (S.setBasico) {
    const f = S.setBasico.casosFactura || [];
    S.setBasico.casosFactura = [...f, ...f.map((c) => clon(c, '-B'))];
    S.setBasico.casosNC = (S.setBasico.casosNC || []).slice(0, 1);
    const nc = S.setBasico.casosNC[0];
    S.setBasico.casosND = (S.setBasico.casosND || []).filter((d) => nc && d.referenciaCaso === nc.id).slice(0, 1);
  }
  if (S.setFacturaExenta) {
    const f = S.setFacturaExenta.casosFactura || [];
    S.setFacturaExenta.casosFactura = [...f, ...f.map((c) => clon(c, '-B'))];
    S.setFacturaExenta.casosNC = (S.setFacturaExenta.casosNC || []).slice(0, 1);
    S.setFacturaExenta.casosND = [];
  }
  if (S.setFacturaCompra) {
    delete S.setFacturaCompra.casoND;
  }
  return S;
}

async function etapaSimulacion(runner, estado) {
  const librosListos = hecha(estado, 'libros_aprobados') || (!setTraeLibros(estado) && hecha(estado, 'sets_aprobados'));
  if (!librosListos) fallar('Primero deben aprobarse los libros.', 'ETAPA_PREVIA_PENDIENTE', { accion: 'node certificar.js todo ' + path.relative(__dirname, ENV_FILE) });

  if (!hecha(estado, 'simulacion_enviada')) {
    log('Generando y enviando set de simulación...');
    const estructurasSim = armarEstructurasSimulacion(estado.estructuras);
    const r = await sinInterrumpir(async () => {
      const envio = await runner.ejecutarSimulacion({ estructuras: estructurasSim });
      if (envio.success) marcar(estado, 'simulacion_enviada', { trackId: envio.trackId });
      return envio;
    });
    if (!r.success) fallar(`Simulación: no se pudo generar o enviar: ${r.error}`, 'SIMULACION_NO_ENVIADA', { accion: 'Si es un error de conexión, relanza. Si no, revisa el detalle.' });
  }

  if (!hecha(estado, 'simulacion_declarada')) {
    log('Declarando simulación...');
    const r = await runner.declararSimulacion();
    if (!r.success) fallar(`Declaración de simulación rechazada: ${r.error || r.mensaje}`, 'DECLARACION_RECHAZADA', { datos: { etapa: 'simulacion' }, accion: 'Revisa el correo de resultados del SII y el estado: node certificar.js estado ' + path.relative(__dirname, ENV_FILE) });
    marcar(estado, 'simulacion_declarada');
  }

  if (!hecha(estado, 'simulacion_aprobada')) {
    log('Esperando aprobación de la simulación...');
    const r = await runner.esperarSimulacionAprobada(POLL);
    if (!r.success) {
      log('Simulación aún no aprobada. Relanza más tarde.');
      return false;
    }
    marcar(estado, 'simulacion_aprobada');
  }

  log('✓ Etapa SIMULACIÓN completa.');
  return true;
}

async function etapaIntercambio(runner, estado) {
  if (!hecha(estado, 'simulacion_aprobada')) fallar('Primero debe aprobarse la simulación.', 'ETAPA_PREVIA_PENDIENTE', { accion: 'node certificar.js todo ' + path.relative(__dirname, ENV_FILE) });

  if (!hecha(estado, 'intercambio')) {
    log('Ejecutando intercambio (descarga set de pfeInternet, sube 3 respuestas)...');
    const r = await runner.ejecutarFase7Intercambio({
      inputPath: process.env.INTERCAMBIO_XML_MANUAL || undefined,
    });
    if (!r.success) fallar(`Intercambio: no se pudo completar: ${r.error}`, 'INTERCAMBIO_FALLIDO', { accion: 'Si no se descargó el set de intercambio, bájalo de www4.sii.cl/pfeInternet y apunta INTERCAMBIO_XML_MANUAL en el .env.' });
    marcar(estado, 'intercambio', { uploaded: r.uploaded });
  }

  log('✓ Etapa INTERCAMBIO completa.');
  return true;
}

// Elige hasta 20 PDF: por cada carpeta (SET-PRUEBAS, SET-SIMULACION) y por cada tipo de
// documento, el de folio más bajo (los del set; los de relleno son posteriores) y su
// cedible si existe. Copia la selección a <pdfDir>/SELECCION.
function seleccionarMuestras(pdfDir) {
  const out = path.join(pdfDir, 'SELECCION');
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  const elegidos = [];
  for (const carpeta of ['SET-PRUEBAS', 'SET-SIMULACION']) {
    const dir = path.join(pdfDir, carpeta);
    if (!fs.existsSync(dir)) continue;
    const porTipo = {};
    for (const f of fs.readdirSync(dir)) {
      const m = f.match(/^muestra_(\d+)_(\d+)(_cedible)?\.pdf$/);
      if (!m || m[3]) continue;
      const tipo = m[1], folio = parseInt(m[2], 10);
      if (!porTipo[tipo] || folio < porTipo[tipo].folio) porTipo[tipo] = { folio, file: f };
    }
    for (const [tipo, { folio, file }] of Object.entries(porTipo)) {
      elegidos.push(path.join(dir, file));
      const ced = path.join(dir, `muestra_${tipo}_${folio}_cedible.pdf`);
      if (fs.existsSync(ced)) elegidos.push(ced);
    }
  }
  for (const p of elegidos.slice(0, 20)) {
    fs.copyFileSync(p, path.join(out, path.basename(path.dirname(p)) + '_' + path.basename(p)));
  }
  return elegidos.slice(0, 20);
}

async function etapaMuestras(runner, estado) {
  const listoParaMuestras = hecha(estado, 'intercambio') || (rondaSoloExportacion(estado) && hecha(estado, 'sets_aprobados'));
  if (!listoParaMuestras) fallar('Primero debe completarse el intercambio.', 'ETAPA_PREVIA_PENDIENTE', { accion: 'node certificar.js todo ' + path.relative(__dirname, ENV_FILE) });

  const pdfDir = path.join(RUN_DIR, 'muestras');

  // El portal de muestras puede mostrar un APROBADO de una certificación ANTERIOR del mismo
  // RUT. Eso no vale para la postulación actual: si el portal de avance dice DOCUMENTOS
  // IMPRESOS, hay que generar y subir muestras nuevas. Solo se omite si este mismo proceso
  // ya las subió (estado.json).

  if (!hecha(estado, 'muestras_pdf')) {
    log('Generando PDFs de muestras impresas...');
    // Solo los envíos de los sets y de la simulación. Los envíos de relleno (emitir) no son
    // parte del set: una muestra de ellos hace que el portal rechace la revisión completa.
    // Y solo los de ESTA ronda: un envío de un set que se reemplazó (anulado en el portal)
    // sigue en debug/, y su muestra hace que el SII rechace la revisión.
    const vigente = (f) => {
      const b = path.basename(f).toLowerCase();
      const m = b.match(/^envio-set-([a-z0-9]+)\.xml$/);
      if (m) return hecha(estado, `set_${m[1]}`);
      if (/simulacion/.test(b)) return hecha(estado, 'simulacion_enviada');
      return true;
    };
    const todos = MuestrasImpresas.buscarXmls(config.debugDir).filter((f) => !/relleno/i.test(path.basename(f)));
    const fuera = todos.filter((f) => !vigente(f));
    if (fuera.length) log(`Muestras: se dejan fuera envíos que no son de esta ronda: ${fuera.map((f) => path.basename(f)).join(', ')}`);
    const xmlFiles = todos.filter(vigente);
    if (!xmlFiles.length) fallar(`No se encontraron XML de envío en ${config.debugDir}`, 'SIN_XML_PARA_MUESTRAS', { accion: 'Las muestras salen de los envíos de sets y simulación de esta carpeta runs/. Si se borró, hay que reenviar.' });
    fs.rmSync(pdfDir, { recursive: true, force: true });

    const generador = new MuestrasImpresas({
      emisor: config.emisor,
      siiOficina: getOficinaForComuna(config.emisor.comuna) || 'S.I.I. - SANTIAGO CENTRO',
      resolucion: `Res. Ex. SII N° 0 del ${config.emisor.fch_resol.slice(0, 4)}`,
      logoPath: process.env.LOGO_PATH || undefined,
      debugDir: config.debugDir,
    });
    const r = await generador.generarMuestras({ xmlFiles, outDir: pdfDir, generarCedible: true });
    marcar(estado, 'muestras_pdf', { generados: r.generados || r.archivos?.length });
    log(`PDFs generados en ${path.relative(__dirname, pdfDir)}`);
    // Un solo comando: se suben de inmediato. REVISAR_MUESTRAS=1 detiene aquí para revisarlas a mano.
    if (process.env.REVISAR_MUESTRAS === '1') {
      emitirAviso('REVISAR_MUESTRAS', `PDFs de muestras generados en ${path.relative(__dirname, pdfDir)}: revísalos antes de subirlos.`, {
        nivel: 'info', datos: { carpeta: path.relative(__dirname, pdfDir), generados: r.generados || r.archivos?.length || null },
        accion: 'Abre algunos PDF y revisa razón social, RUT, giro, dirección, comuna y timbre. Si están bien, relanza sin REVISAR_MUESTRAS:\n' +
          `node certificar.js todo ${path.relative(__dirname, ENV_FILE)}`,
      });
      AVISO_ESPERA_EMITIDO = true;
      return false;
    }
  }

  if (!hecha(estado, 'muestras')) {
    // El portal actual (pdfdteInternet) exige TODOS los PDF de los DTE del set de pruebas
    // y de la simulación, con sus cedibles. Si falta alguno, rechaza la revisión completa.
    // (El "máximo 20" del manual antiguo ya no aplica.)
    fs.rmSync(path.join(pdfDir, 'SELECCION'), { recursive: true, force: true });
    log('Subiendo TODAS las muestras al portal (set de pruebas + simulación, con cedibles)...');
    const r = await runner.ejecutarFase8Muestras({ pdfDir });
    if (!r.success) fallar(`Muestras: no se pudieron subir: ${r.error}`, 'MUESTRAS_NO_SUBIDAS', { accion: 'Relanza el comando; si persiste, revisa el detalle.' });
    marcar(estado, 'muestras');
  }

  log('✓ Muestras enviadas. El SII las revisa a mano (1 a 7 días).');
  return true;
}

async function etapaCierre(runner, estado) {
  if (!hecha(estado, 'muestras')) fallar('Primero deben subirse las muestras impresas.', 'ETAPA_PREVIA_PENDIENTE', { accion: 'node certificar.js todo ' + path.relative(__dirname, ENV_FILE) });

  const env = path.relative(__dirname, ENV_FILE);
  const pendiente = (detalle) => {
    emitirAviso('CIERRE_PENDIENTE_SII', 'Declaración de cumplimiento hecha; falta que el SII apruebe las muestras impresas.', {
      nivel: 'info', datos: { portal: detalle || null },
      accion: `El SII las revisa a mano (1 a 7 días). Relanza cada día: node certificar.js todo ${env}\n` +
        'Termina cuando el portal diga que la empresa está autorizada como emisor.',
    });
    AVISO_ESPERA_EMITIDO = true;
    return false;
  };

  if (!hecha(estado, 'cierre_declarado')) {
    log('Intentando avanzar paso y declarar cumplimiento...');
    const r = await runner.declararCumplimientoFinal();
    if (r.bloqueado) {
      emitirAviso('MUESTRAS_EN_REVISION', `El SII aún no permite declarar cumplimiento: ${r.mensaje}`, {
        nivel: 'info', accion: `Las muestras siguen en revisión (1 a 7 días). Relanza cada día: node certificar.js todo ${env}`,
      });
      AVISO_ESPERA_EMITIDO = true;
      return false;
    }
    if (!r.success) fallar(`Declaración de cumplimiento rechazada: ${r.mensaje || r.error}`, 'CIERRE_RECHAZADO', { accion: 'El SII exige que la declaración de cumplimiento la haga el representante legal: Menú postulantes → Declaración de cumplimiento de requisitos, con su certificado.' });
    marcar(estado, 'cierre_declarado');
  }

  // La declaración aceptada no basta: se confirma en el portal antes de dar por terminada la certificación.
  const c = clasificarAvance(await runner.consultarAvance());
  if (c.tipo === 'AUTORIZADA' && estado.ronda?.autorizadaAlDescargar) {
    // La empresa ya figuraba autorizada antes de esta ronda: el portal no distingue si los
    // documentos nuevos quedaron habilitados.
    marcar(estado, 'cierre', { ronda: 'documentos nuevos' });
    emitirAviso('CIERRE_POR_CONFIRMAR', 'Declaración de cumplimiento hecha para los documentos nuevos.', {
      nivel: 'info', accion: 'Confirma en el portal del SII (Ver avance / Actualizar datos empresa) que los documentos nuevos figuran autorizados.',
    });
    return true;
  }
  if (c.tipo !== 'AUTORIZADA') return pendiente(c.etapa || c.texto?.slice(0, 200));
  marcar(estado, 'cierre');
  emitirAviso('CERTIFICACION_COMPLETA', 'El SII registra a la empresa como emisor electrónico autorizado.', { nivel: 'info', datos: { portal: c.texto } });
  log('✓ CERTIFICACIÓN COMPLETA. La empresa queda registrada como emisor electrónico.');
  return true;
}

// ─────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────

const ETAPAS = {
  datos: etapaDatos,
  folios: etapaFolios,
  anular: etapaAnular,
  emitir: etapaEmitir,
  rehacer: etapaRehacer,
  consultar: etapaConsultar,
  declarar: etapaDeclarar,
  estado: etapaEstado,
  descargar: etapaDescargar,
  sets: etapaSets,
  libros: etapaLibros,
  simulacion: etapaSimulacion,
  intercambio: etapaIntercambio,
  muestras: etapaMuestras,
  cierre: etapaCierre,
};

let AVISO_ESPERA_EMITIDO = false;   // la etapa ya explicó por qué se detiene

const ORDEN = ['sets', 'libros', 'simulacion', 'intercambio', 'muestras', 'cierre'];

// Error inesperado → aviso con código. Los que no se reconocen quedan con traza en runs/<RUT>/errores/.
function avisoDesdeError(err) {
  if (err instanceof FalloControlado) {
    return { codigo: err.codigo, mensaje: err.message, accion: err.accion, datos: err.datos, esperando: err.esperando };
  }
  const m = String(err?.message || err);
  const reglas = [
    [/contrase[ñn]a del certificado|invalid password|mac verify/i, 'CERT_CLAVE_INCORRECTA', 'La clave del certificado no corresponde.', 'Revisa CERT_PASSWORD en el .env.', false],
    [/certificado expirado|certificate.*expired/i, 'CERT_VENCIDO', 'El certificado está vencido.', 'Renueva el certificado digital y reemplaza el .pfx.', false],
    [/PFX no encontrado/i, 'CERT_NO_ENCONTRADO', 'No se encuentra el certificado.', 'Revisa CERT_PATH en el .env.', false],
    [/superado el m[aá]ximo|demasiadas sesiones|m[aá]ximo de sesiones/i, 'SESIONES_MAXIMAS', 'El SII tiene demasiadas sesiones abiertas con este certificado.', 'Espera 30 minutos (el SII las libera solo) o corre: node certificar.js logout <empresa.env>', true],
    [/autenticaci[oó]n fallida|no se recibieron cookies/i, 'AUTENTICACION_SII_FALLIDA', 'El SII no aceptó el inicio de sesión con el certificado.', 'Reintenta en unos minutos. Si persiste, prueba entrar a sii.cl con ese certificado desde el navegador: puede estar revocado o no registrado.', true],
    [/no se encontraron datos de resoluci/i, 'SIN_DATOS_RESOLUCION', 'El SII no entregó la fecha de resolución de certificación.', 'Revisa con: node certificar.js estado <empresa.env>. Si hay postulación, pon FECHA_RESOLUCION_CERT a mano.', false],
    [/SESSION_EXPIRED|sesi[oó]n (ha )?expirad/i, 'SESION_EXPIRADA', 'La sesión del SII expiró.', 'Relanza el mismo comando.', true],
    [/ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|socket hang up|Service Unavailable|\b50[234]\b/i, 'SII_NO_DISPONIBLE', 'No se pudo conectar con el SII, o respondió con un error temporal.', 'Reintenta en unos minutos.', true],
    [/ENOSPC/i, 'DISCO_LLENO', 'No queda espacio en disco.', 'Libera espacio y relanza.', false],
  ];
  for (const [re, codigo, mensaje, accion, esperando] of reglas) {
    if (re.test(m)) return { codigo, mensaje: `${mensaje} (${m.split('\n')[0]})`, accion, datos: null, esperando };
  }
  let traza = null;
  try {
    const dir = path.join(RUN_DIR, 'errores');
    fs.mkdirSync(dir, { recursive: true });
    traza = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}.log`);
    fs.writeFileSync(traza, `${COMANDO} ${path.relative(__dirname, ENV_FILE)}\n${err?.stack || m}\n`);
  } catch (_) {}
  return {
    codigo: 'ERROR_INESPERADO', mensaje: m.split('\n')[0], esperando: false,
    accion: traza ? `Guarda ${path.relative(__dirname, traza)} y escálalo. No borres runs/${RUT}/.` : 'Escálalo con la salida completa.',
    datos: { traza: traza ? path.relative(__dirname, traza) : null },
  };
}

async function main() {
  const etapa = COMANDO;
  console.log(`\nCertificación DTE — ${config.emisor.razon_social || RUT} (${RUT})`);
  console.log(`Config: ${path.relative(__dirname, ENV_FILE)} · Trabajo: ${path.relative(__dirname, RUN_DIR)}\n`);

  validarConfig();
  tomarBloqueos();

  if (etapa === 'datos') {
    await etapaDatos();
    return { estado: 'ok' };
  }

  const estado = cargarEstado();
  const runner = crearRunner(estado);
  RUNNER_ACTUAL = runner;

  if (etapa === 'logout') {
    // Fuerza la carga de la sesión guardada y la cierra.
    try { runner.folioService; } catch (_) {}
    await cerrarSesiones(runner);
    return { estado: 'ok' };
  }

  const esperandoEn = (nombre) => {
    if (AVISO_ESPERA_EMITIDO) return { estado: 'esperando', etapa: nombre };
    emitirAviso('ESPERANDO_SII', `Detenido en "${nombre}": el SII aún no termina de revisar.`, {
      nivel: 'info', accion: `Relanza más tarde: node certificar.js ${etapa} ${path.relative(__dirname, ENV_FILE)}`, datos: { etapa: nombre },
    });
    return { estado: 'esperando', etapa: nombre };
  };

  try {
    if (COMANDOS_CON_PORTAL.has(etapa)) {
      const pf = await verificarPortal(runner, estado, etapa);
      if (pf === 'completa') return { estado: 'ok', certificacion: 'completa' };
    }
    if (etapa === 'todo') {
      for (const nombre of ORDEN) {
        if (['simulacion', 'intercambio'].includes(nombre) && rondaSoloExportacion(estado)) {
          log(`Etapa ${nombre}: no aplica a una ronda solo de exportación, se omite.`);
          continue;
        }
        if (nombre === 'libros' && !setTraeLibros(estado)) {
          log('Etapa libros: el set no trae libros (PEDIR_LIBROS=0), se omite.');
          continue;
        }
        if (hecha(estado, nombre === 'sets' ? 'sets_aprobados' : nombre === 'libros' ? 'libros_aprobados' : nombre === 'simulacion' ? 'simulacion_aprobada' : nombre)) {
          log(`Etapa ${nombre}: ya completa.`);
          continue;
        }
        const ok = await ETAPAS[nombre](runner, estado);
        if (!ok) return esperandoEn(nombre);
      }
      return { estado: 'ok', certificacion: hecha(estado, 'cierre') ? 'completa' : 'en_curso' };
    }
    const r = await ETAPAS[etapa](runner, estado);
    if (r === false) return esperandoEn(etapa);
    return { estado: 'ok', ...(r && typeof r === 'object' && r.resultado ? r.resultado : {}) };
  } finally {
    await cerrarSesiones(runner);
  }
}

main()
  .then(({ estado: final, ...extra }) => {
    emitirResultado(final, extra);
    process.exit(final === 'esperando' ? 2 : 0);
  })
  .catch((err) => {
    const a = avisoDesdeError(err);
    emitirAviso(a.codigo, a.mensaje, { nivel: a.esperando ? 'advertencia' : 'error', accion: a.accion, datos: a.datos });
    emitirResultado(a.esperando ? 'esperando' : 'error', { codigo: a.codigo });
    process.exit(a.esperando ? 2 : 1);
  });
