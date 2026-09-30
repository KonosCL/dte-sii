#!/usr/bin/env node
/*
 * panel/server.js — Panel web del certificador SII (fase 1)
 *
 * © 2026 Konos Soluciones y Servicios Ltda. Todos los derechos reservados.
 * CONFIDENCIAL. Uso interno de Konos.
 *
 * Una página web para correr certificar.js sin terminal: se sube o edita el .env de la
 * empresa y cada botón lanza un comando. El log se ve en vivo.
 *
 * El certificado digital vive SOLO en el servidor (CERT_PATH y CERT_PASSWORD en
 * /etc/certificador/panel.env). El .env que sube la persona nunca lleva certificado ni
 * clave: si los trae, se descartan. Ninguna ruta del panel devuelve el certificado.
 *
 * Sin dependencias: solo Node (18 o más nuevo).
 *
 * Variables de entorno:
 *   PANEL_CLAVE        clave de entrada del equipo (obligatoria)
 *   CERT_PATH          ruta absoluta al .pfx (obligatoria)
 *   CERT_PASSWORD      clave del .pfx (obligatoria)
 *   CERTIFICADOR_DIR   carpeta con certificar.js, empresas/ y runs/ (por defecto, la de arriba)
 *   PANEL_HOST         por defecto 127.0.0.1 (Nginx delante, con HTTPS)
 *   PANEL_PUERTO       por defecto 8080
 *   PANEL_COOKIE_SEGURA  1 (por defecto): la cookie solo viaja por HTTPS. 0 para probar en local.
 */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

// ─────────────────────────────────────────────────────────────────
// Configuración
// ─────────────────────────────────────────────────────────────────

const CLAVE = process.env.PANEL_CLAVE || '';
const CERT_PATH = process.env.CERT_PATH || '';
const CERT_PASSWORD = process.env.CERT_PASSWORD ?? '';
const DIR = path.resolve(process.env.CERTIFICADOR_DIR || path.join(__dirname, '..'));
const HOST = process.env.PANEL_HOST || '127.0.0.1';
const PUERTO = parseInt(process.env.PANEL_PUERTO || '8080', 10);
const COOKIE_SEGURA = process.env.PANEL_COOKIE_SEGURA !== '0';

const RUNNER = path.join(DIR, 'certificar.js');
const EMPRESAS = path.join(DIR, 'empresas');
const RUNS = path.join(DIR, 'runs');
const TRABAJOS_DIR = path.join(RUNS, '.panel');
const PUBLICO = path.join(__dirname, 'public');

function abortar(msg) {
  console.error(`panel: ${msg}`);
  process.exit(1);
}
if (CLAVE.length < 10) abortar('PANEL_CLAVE falta o es muy corta (mínimo 10 caracteres).');
if (!path.isAbsolute(CERT_PATH) || !fs.existsSync(CERT_PATH)) abortar(`CERT_PATH debe ser una ruta absoluta a un .pfx que exista (${CERT_PATH || 'vacío'}).`);
if (!fs.existsSync(RUNNER)) abortar(`No está certificar.js en ${DIR}.`);
// El certificado no puede quedar dentro de una carpeta que el panel sirve o escribe.
for (const d of [PUBLICO, EMPRESAS, RUNS]) {
  if (path.resolve(CERT_PATH).startsWith(path.resolve(d) + path.sep)) abortar(`El certificado no puede estar dentro de ${d}.`);
}
fs.mkdirSync(EMPRESAS, { recursive: true });
fs.mkdirSync(TRABAJOS_DIR, { recursive: true });
fs.mkdirSync(path.join(RUNS, '.sesiones'), { recursive: true });

// ─────────────────────────────────────────────────────────────────
// Sesiones: una clave para el equipo, cookie aleatoria, 12 horas
// ─────────────────────────────────────────────────────────────────

const SESIONES = new Map();            // token → vence (ms)
const DURACION_SESION = 12 * 3600 * 1000;
const INTENTOS = new Map();            // ip → { n, desde }
const MAX_INTENTOS = 5;
const VENTANA_INTENTOS = 15 * 60 * 1000;

function claveCorrecta(intento) {
  const a = crypto.createHash('sha256').update(String(intento || '')).digest();
  const b = crypto.createHash('sha256').update(CLAVE).digest();
  return crypto.timingSafeEqual(a, b);
}

function ipDe(req) {
  // Detrás de Nginx en el mismo servidor: la IP real viene en X-Real-IP.
  const directa = req.socket.remoteAddress || '';
  const loopback = directa === '127.0.0.1' || directa === '::1' || directa === '::ffff:127.0.0.1';
  return (loopback && req.headers['x-real-ip']) || directa;
}

function bloqueado(ip) {
  const r = INTENTOS.get(ip);
  if (!r) return false;
  if (Date.now() - r.desde > VENTANA_INTENTOS) { INTENTOS.delete(ip); return false; }
  return r.n >= MAX_INTENTOS;
}

function anotarFallo(ip) {
  const r = INTENTOS.get(ip);
  if (!r || Date.now() - r.desde > VENTANA_INTENTOS) INTENTOS.set(ip, { n: 1, desde: Date.now() });
  else r.n += 1;
}

function tokenDe(req) {
  const m = String(req.headers.cookie || '').match(/(?:^|;\s*)panel=([a-f0-9]{64})/);
  return m ? m[1] : null;
}

function autenticado(req) {
  const t = tokenDe(req);
  const vence = t && SESIONES.get(t);
  if (!vence) return false;
  if (vence < Date.now()) { SESIONES.delete(t); return false; }
  return true;
}

function cookie(valor, maxAge) {
  return `panel=${valor}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${COOKIE_SEGURA ? '; Secure' : ''}`;
}

// ─────────────────────────────────────────────────────────────────
// Archivos .env de las empresas
// ─────────────────────────────────────────────────────────────────

// Solo estas variables se guardan. CERT_PATH y CERT_PASSWORD las pone el servidor; las
// que son rutas a archivos (LOGO_PATH, INTERCAMBIO_XML_MANUAL, EXPORTACION_CODIGOS) quedan
// fuera para que un .env subido no pueda apuntar a archivos del servidor.
const PERMITIDAS = new Set([
  'EMISOR_RUT', 'EMISOR_RAZON_SOCIAL', 'EMISOR_GIRO', 'EMISOR_ACTECO', 'EMISOR_DIRECCION',
  'EMISOR_COMUNA', 'EMISOR_CIUDAD', 'FECHA_RESOLUCION_CERT',
  'RECEPTOR_RUT', 'RECEPTOR_RAZON_SOCIAL', 'RECEPTOR_GIRO', 'RECEPTOR_DIRECCION', 'RECEPTOR_COMUNA', 'RECEPTOR_CIUDAD',
  'SETS_ADICIONALES', 'TIPO_CAMBIO', 'COMISION_EXTRANJERO', 'PEDIR_LIBROS', 'INCLUIR_BASICO',
  'RECEPTOR_EXTRANJERO_RAZON_SOCIAL', 'RECEPTOR_EXTRANJERO_GIRO', 'RECEPTOR_EXTRANJERO_DIRECCION', 'RECEPTOR_EXTRANJERO_CIUDAD',
  'REVISAR_MUESTRAS', 'POLL_MAX_INTENTOS', 'POLL_INTERVALO_MS', 'BLOQUEO_ESPERA_MIN',
  'ESPERA_PROCESO_SEG', 'ESPERA_PROCESO_INTENTOS',
]);

const RE_RUT = /^\d{7,8}-[\dkK]$/;

function dv(numero) {
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
  if (!RE_RUT.test(rut || '')) return false;
  const [n, d] = rut.toUpperCase().split('-');
  return dv(n) === d;
}

// Texto de un .env → { variables, descartadas }, con las mismas reglas que dotenv (que es quien
// lo lee en el runner): comillas simples, dobles o invertidas envuelven el valor; sin comillas,
// un " #" empieza un comentario.
function leerEnv(texto) {
  const variables = {};
  const descartadas = [];
  for (const cruda of String(texto || '').split(/\r?\n/)) {
    const linea = cruda.trim();
    if (!linea || linea.startsWith('#')) continue;
    const m = linea.match(/^(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (!m) { descartadas.push(linea.slice(0, 40)); continue; }
    let valor = m[2].trim();
    const comillas = valor.match(/^(['"`])(.*)\1(\s+#.*)?$/);
    if (comillas) valor = comillas[2];
    else valor = valor.replace(/\s+#.*$/, '').trim();
    if (!PERMITIDAS.has(m[1])) { descartadas.push(m[1]); continue; }
    if (/[\r\n\0]/.test(valor) || valor.length > 200) { descartadas.push(m[1]); continue; }
    variables[m[1]] = valor;
  }
  return { variables, descartadas };
}

// Valor → texto que dotenv devuelve igual. Sin escapes: dotenv no los deshace dentro de
// comillas simples ni invertidas, así que se elige la comilla que el valor no usa.
function valorEnv(v) {
  if (!/[\s#"'`]/.test(v)) return v;
  if (!v.includes('"')) return `"${v}"`;
  if (!v.includes("'")) return `'${v}'`;
  if (!v.includes('`')) return `\`${v}\``;
  return `"${v.replace(/"/g, '')}"`;
}

function escribirEnv(variables) {
  const lineas = ['# Generado por el panel. El certificado lo pone el servidor: no va aquí.'];
  for (const [k, v] of Object.entries(variables)) lineas.push(`${k}=${valorEnv(v)}`);
  return lineas.join('\n') + '\n';
}

function archivoEmpresa(rut) {
  if (!rutValido(rut)) return null;
  return path.join(EMPRESAS, `${rut.toUpperCase()}.env`);
}

function resumenEmpresa(rut) {
  const archivo = archivoEmpresa(rut);
  const { variables } = leerEnv(fs.readFileSync(archivo, 'utf8'));
  let estado = null;
  try { estado = JSON.parse(fs.readFileSync(path.join(RUNS, rut.toUpperCase(), 'estado.json'), 'utf8')); } catch (_) {}
  const etapas = estado ? Object.keys(estado.etapas || {}).filter((k) => estado.etapas[k]?.ok) : [];
  return {
    rut: rut.toUpperCase(),
    razonSocial: variables.EMISOR_RAZON_SOCIAL || '',
    sets: variables.SETS_ADICIONALES ?? '(guia, exenta, compra)',
    etapas,
    ultimo: ultimoTrabajoDe(rut.toUpperCase()),
  };
}

// ─────────────────────────────────────────────────────────────────
// Trabajos: un comando de certificar.js a la vez
// ─────────────────────────────────────────────────────────────────
// Todas las empresas usan el mismo certificado y el SII admite una sesión por certificado:
// dos corridas a la vez se cerrarían la sesión una a otra (el runner igual lo bloquea).

const COMANDOS = {
  estado: { args: 0 },
  datos: { args: 0 },
  descargar: { args: 1, validos: ['ver'] },
  todo: { args: 0 },
  sets: { args: 0 },
  libros: { args: 0 },
  simulacion: { args: 0 },
  intercambio: { args: 0 },
  muestras: { args: 0 },
  cierre: { args: 0 },
  consultar: { args: 10, patron: /^\d{5,12}$/ },
  declarar: { args: 0 },
  logout: { args: 0 },
  rehacer: { args: 7, validos: ['basico', 'guia', 'exenta', 'compra', 'exportacion', 'exportacion1', 'exportacion2', 'muestras'] },
  folios: { args: 12, patron: /^\d{1,3}$/ },
  anular: { args: 2, patron: /^\d{1,3}(-\d{1,6})?$|^\d{1,6}-\d{1,6}$/ },
  emitir: { args: 8, patron: /^\d{2,3}$|^ref=\d{1,9}$/ },
};

// Opciones de una sola corrida (variables que el runner lee del entorno).
const OPCIONES = {
  forzarDescarga: 'FORZAR_DESCARGA',
  reiniciarSet: 'REINICIAR_SET',
  revisarMuestras: 'REVISAR_MUESTRAS',
  confirmarSetsAprobados: 'CONFIRMAR_SETS_APROBADOS',
};

const TRABAJOS = [];                // más recientes al final; se guardan los últimos 100
let enCurso = null;

function ultimoTrabajoDe(rut) {
  for (let i = TRABAJOS.length - 1; i >= 0; i--) {
    const t = TRABAJOS[i];
    if (t.rut === rut && t.fin) return { comando: t.comando, fin: t.fin, codigo: t.codigo, resultado: t.resultado?.estado || null };
  }
  return null;
}

function publico(t) {
  const { proceso, lineas, clientes, ...resto } = t;
  return resto;
}

function guardarIndice() {
  const indice = TRABAJOS.slice(-100).map(publico);
  fs.writeFileSync(path.join(TRABAJOS_DIR, 'trabajos.json'), JSON.stringify(indice, null, 2));
}

function cargarIndice() {
  try {
    const lista = JSON.parse(fs.readFileSync(path.join(TRABAJOS_DIR, 'trabajos.json'), 'utf8'));
    for (const t of lista) {
      // Un trabajo que quedó "en curso" al reiniciar el panel murió con él.
      if (!t.fin) { t.fin = new Date().toISOString(); t.codigo = null; t.interrumpido = true; }
      TRABAJOS.push({ ...t, lineas: null, clientes: new Set() });
    }
  } catch (_) {}
}

function emitir(t, evento) {
  const data = `data: ${JSON.stringify(evento)}\n\n`;
  for (const res of t.clientes) res.write(data);
}

function iniciarTrabajo(rut, comando, args, opciones) {
  const id = `${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${crypto.randomBytes(3).toString('hex')}`;
  const envRel = path.relative(DIR, archivoEmpresa(rut));
  const entorno = {
    PATH: process.env.PATH,
    HOME: process.env.HOME || DIR,
    LANG: process.env.LANG || 'C.UTF-8',
    TZ: 'America/Santiago',
    // Caché de sesión SII en disco persistente: sin ella, cada reinicio del servidor obliga a
    // un login nuevo y el SII limita las sesiones por certificado.
    DATADIR: path.join(RUNS, '.sesiones'),
    CERT_PATH,
    CERT_PASSWORD,
  };
  for (const [clave, variable] of Object.entries(OPCIONES)) if (opciones?.[clave]) entorno[variable] = '1';

  const logPath = path.join(TRABAJOS_DIR, `${id}.log`);
  const salida = fs.createWriteStream(logPath);
  const t = {
    id, rut, comando, args, opciones: Object.keys(OPCIONES).filter((k) => opciones?.[k]),
    inicio: new Date().toISOString(), fin: null, codigo: null, resultado: null, avisos: [],
    lineas: [], clientes: new Set(), proceso: null,
  };
  const proceso = spawn(process.execPath, [RUNNER, comando, envRel, ...args], { cwd: DIR, env: entorno });
  t.proceso = proceso;
  enCurso = t;
  TRABAJOS.push(t);
  if (TRABAJOS.length > 200) TRABAJOS.splice(0, TRABAJOS.length - 200);
  guardarIndice();

  let resto = '';
  const alLeer = (chunk) => {
    resto += chunk.toString('utf8');
    const partes = resto.split(/\r?\n/);
    resto = partes.pop();
    for (const linea of partes) procesarLinea(t, linea, salida);
  };
  proceso.stdout.on('data', alLeer);
  proceso.stderr.on('data', alLeer);
  proceso.on('close', (codigo, senal) => {
    if (resto) procesarLinea(t, resto, salida);
    t.fin = new Date().toISOString();
    t.codigo = codigo ?? (senal ? 130 : null);
    salida.end();
    emitir(t, { tipo: 'fin', codigo: t.codigo, resultado: t.resultado });
    for (const res of t.clientes) res.end();
    t.clientes.clear();
    t.proceso = null;
    t.lineas = null;          // queda en el archivo .log
    if (enCurso === t) enCurso = null;
    guardarIndice();
  });
  return t;
}

function procesarLinea(t, linea, salida) {
  salida.write(linea + '\n');
  let evento = { tipo: 'linea', texto: linea };
  if (linea.startsWith('[AVISO]')) {
    try {
      const a = JSON.parse(linea.slice(7));
      t.avisos.push(a.codigo);
      evento = { tipo: 'aviso', aviso: a };
    } catch (_) {}
  } else if (linea.startsWith('[RESULTADO]')) {
    try {
      t.resultado = JSON.parse(linea.slice(11));
      evento = { tipo: 'resultado', resultado: t.resultado };
    } catch (_) {}
  }
  if (t.lineas) {
    t.lineas.push(evento);
    if (t.lineas.length > 5000) t.lineas.shift();
  }
  emitir(t, evento);
}

// ─────────────────────────────────────────────────────────────────
// HTTP
// ─────────────────────────────────────────────────────────────────

function responder(res, status, cuerpo, extra = {}) {
  const json = typeof cuerpo === 'string' ? cuerpo : JSON.stringify(cuerpo);
  res.writeHead(status, {
    'Content-Type': typeof cuerpo === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extra,
  });
  res.end(json);
}

function leerCuerpo(req, max = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let datos = '';
    req.on('data', (c) => {
      datos += c;
      if (datos.length > max) { reject(new Error('cuerpo demasiado grande')); req.destroy(); }
    });
    req.on('end', () => {
      try { resolve(datos ? JSON.parse(datos) : {}); } catch (e) { reject(new Error('JSON inválido')); }
    });
    req.on('error', reject);
  });
}

const SEGURIDAD = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'",
};

// Archivos que se pueden bajar de runs/<RUT>/. Nada fuera de esta lista.
const DESCARGABLES = {
  'estado.json': (rut) => path.join(RUNS, rut, 'estado.json'),
  'avisos.jsonl': (rut) => path.join(RUNS, rut, 'avisos.jsonl'),
  'set-texto.txt': (rut) => path.join(RUNS, rut, 'debug', 'set-texto.txt'),
  'estructuras.json': (rut) => path.join(RUNS, rut, 'debug', 'estructuras.json'),
  'avance.html': (rut) => path.join(RUNS, rut, 'debug', 'avance.html'),
};

async function manejar(req, res) {
  const url = new URL(req.url, 'http://panel');
  const ruta = url.pathname;
  const metodo = req.method;
  for (const [k, v] of Object.entries(SEGURIDAD)) res.setHeader(k, v);

  // Página y su script (los dos únicos archivos que se sirven de public/)
  if (metodo === 'GET' && (ruta === '/' || ruta === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return fs.createReadStream(path.join(PUBLICO, 'index.html')).pipe(res);
  }
  if (metodo === 'GET' && ruta === '/app.js') {
    res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
    return fs.createReadStream(path.join(PUBLICO, 'app.js')).pipe(res);
  }

  if (!ruta.startsWith('/api/')) return responder(res, 404, { error: 'no existe' });

  // Todo POST/PUT exige este encabezado: un formulario de otro sitio no puede ponerlo.
  if (metodo !== 'GET' && req.headers['x-panel'] !== '1') return responder(res, 403, { error: 'petición rechazada' });

  if (metodo === 'POST' && ruta === '/api/login') {
    const ip = ipDe(req);
    if (bloqueado(ip)) return responder(res, 429, { error: 'Demasiados intentos. Espera 15 minutos.' });
    const { clave } = await leerCuerpo(req);
    if (!claveCorrecta(clave)) {
      anotarFallo(ip);
      return responder(res, 401, { error: 'Clave incorrecta.' });
    }
    INTENTOS.delete(ip);
    const token = crypto.randomBytes(32).toString('hex');
    SESIONES.set(token, Date.now() + DURACION_SESION);
    return responder(res, 200, { ok: true }, { 'Set-Cookie': cookie(token, DURACION_SESION / 1000) });
  }

  if (!autenticado(req)) return responder(res, 401, { error: 'Sesión vencida. Entra de nuevo.' });

  if (metodo === 'POST' && ruta === '/api/logout') {
    SESIONES.delete(tokenDe(req));
    return responder(res, 200, { ok: true }, { 'Set-Cookie': cookie('', 0) });
  }

  if (metodo === 'GET' && ruta === '/api/sesion') {
    return responder(res, 200, { ok: true, enCurso: enCurso ? publico(enCurso) : null });
  }

  if (metodo === 'GET' && ruta === '/api/empresas') {
    const lista = fs.readdirSync(EMPRESAS)
      .map((f) => f.match(/^(\d{7,8}-[\dK])\.env$/i)?.[1])
      .filter(Boolean)
      .map((rut) => { try { return resumenEmpresa(rut); } catch (_) { return null; } })
      .filter(Boolean)
      .sort((a, b) => a.razonSocial.localeCompare(b.razonSocial));
    return responder(res, 200, { empresas: lista, enCurso: enCurso ? publico(enCurso) : null });
  }

  // Crear o reemplazar el .env de una empresa. El RUT sale de EMISOR_RUT.
  if (metodo === 'POST' && ruta === '/api/empresas') {
    const { texto } = await leerCuerpo(req);
    const { variables, descartadas } = leerEnv(texto);
    const rut = String(variables.EMISOR_RUT || '').toUpperCase();
    if (!rutValido(rut)) return responder(res, 400, { error: `EMISOR_RUT "${variables.EMISOR_RUT || ''}" no es un RUT válido (sin puntos, con guion).` });
    variables.EMISOR_RUT = rut;
    if (enCurso?.rut === rut) return responder(res, 409, { error: 'Esa empresa tiene una corrida en curso: espera a que termine para cambiar su .env.' });
    fs.writeFileSync(archivoEmpresa(rut), escribirEnv(variables), { mode: 0o640 });
    return responder(res, 200, { ok: true, rut, descartadas });
  }

  let m = ruta.match(/^\/api\/empresas\/(\d{7,8}-[\dkK])\/(env|comandos|archivos\/([a-z.-]+)|muestras\.tar\.gz)$/);
  if (m) {
    const rut = m[1].toUpperCase();
    const archivo = archivoEmpresa(rut);
    if (!archivo || !fs.existsSync(archivo)) return responder(res, 404, { error: 'No existe esa empresa.' });

    if (metodo === 'GET' && m[2] === 'env') {
      return responder(res, 200, { texto: fs.readFileSync(archivo, 'utf8') });
    }

    if (metodo === 'POST' && m[2] === 'comandos') {
      const { comando, args = [], opciones = {} } = await leerCuerpo(req);
      const def = Object.hasOwn(COMANDOS, comando) ? COMANDOS[comando] : null;
      if (!def) return responder(res, 400, { error: `Comando no permitido: ${comando}` });
      if (!Array.isArray(args) || args.length > def.args) return responder(res, 400, { error: 'Argumentos no válidos.' });
      for (const a of args) {
        const ok = typeof a === 'string' && (def.validos ? def.validos.includes(a) : def.patron?.test(a));
        if (!ok) return responder(res, 400, { error: `Argumento no válido: ${String(a).slice(0, 30)}` });
      }
      if (enCurso) {
        return responder(res, 409, {
          error: `Hay una corrida en curso (${enCurso.comando}, ${enCurso.rut}). El certificado admite una sesión a la vez: espera a que termine.`,
          enCurso: publico(enCurso),
        });
      }
      const t = iniciarTrabajo(rut, comando, args, opciones);
      return responder(res, 200, { ok: true, trabajo: publico(t) });
    }

    if (metodo === 'GET' && m[3]) {
      const ruta2 = DESCARGABLES[m[3]]?.(rut);
      if (!ruta2 || !fs.existsSync(ruta2)) return responder(res, 404, { error: 'Todavía no existe ese archivo.' });
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${rut}-${m[3]}"`,
        'Cache-Control': 'no-store',
      });
      return fs.createReadStream(ruta2).pipe(res);
    }

    if (metodo === 'GET' && m[2] === 'muestras.tar.gz') {
      const dir = path.join(RUNS, rut, 'muestras');
      if (!fs.existsSync(dir)) return responder(res, 404, { error: 'Todavía no hay muestras generadas.' });
      res.writeHead(200, {
        'Content-Type': 'application/gzip',
        'Content-Disposition': `attachment; filename="${rut}-muestras.tar.gz"`,
        'Cache-Control': 'no-store',
      });
      const tar = spawn('tar', ['-czf', '-', '-C', path.join(RUNS, rut), 'muestras'], { env: { PATH: process.env.PATH } });
      tar.stdout.pipe(res);
      tar.on('error', () => res.end());
      return undefined;
    }
  }

  if (metodo === 'GET' && ruta === '/api/trabajos') {
    const rut = url.searchParams.get('rut');
    const lista = TRABAJOS.filter((t) => !rut || t.rut === rut).slice(-30).reverse().map(publico);
    return responder(res, 200, { trabajos: lista });
  }

  m = ruta.match(/^\/api\/trabajos\/([0-9]{14}-[a-f0-9]{6})\/(eventos|detener|log)$/);
  if (m) {
    const t = TRABAJOS.find((x) => x.id === m[1]);
    if (!t) return responder(res, 404, { error: 'No existe ese trabajo.' });

    if (metodo === 'GET' && m[2] === 'eventos') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      if (t.lineas) {
        for (const e of t.lineas) res.write(`data: ${JSON.stringify(e)}\n\n`);
      } else {
        // Trabajo terminado: se repite su log desde el archivo.
        try {
          for (const linea of fs.readFileSync(path.join(TRABAJOS_DIR, `${t.id}.log`), 'utf8').split('\n')) {
            if (linea) res.write(`data: ${JSON.stringify({ tipo: 'linea', texto: linea })}\n\n`);
          }
        } catch (_) {}
      }
      if (t.fin) {
        res.write(`data: ${JSON.stringify({ tipo: 'fin', codigo: t.codigo, resultado: t.resultado })}\n\n`);
        return res.end();
      }
      t.clientes.add(res);
      const latido = setInterval(() => res.write(': ok\n\n'), 20000);
      req.on('close', () => { clearInterval(latido); t.clientes.delete(res); });
      return undefined;
    }

    if (metodo === 'GET' && m[2] === 'log') {
      const f = path.join(TRABAJOS_DIR, `${t.id}.log`);
      if (!fs.existsSync(f)) return responder(res, 404, { error: 'Sin log.' });
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Disposition': `attachment; filename="${t.rut}-${t.comando}-${t.id}.log"` });
      return fs.createReadStream(f).pipe(res);
    }

    if (metodo === 'POST' && m[2] === 'detener') {
      if (!t.proceso) return responder(res, 409, { error: 'Ese trabajo ya terminó.' });
      // SIGTERM: el runner termina el envío al SII que tenga en curso, cierra la sesión y sale.
      t.proceso.kill('SIGTERM');
      return responder(res, 200, { ok: true });
    }
  }

  return responder(res, 404, { error: 'no existe' });
}

cargarIndice();

const servidor = http.createServer((req, res) => {
  manejar(req, res).catch((e) => {
    if (!res.headersSent) responder(res, 500, { error: e.message });
    else res.end();
  });
});
servidor.requestTimeout = 0;     // los eventos de un trabajo largo quedan abiertos
servidor.listen(PUERTO, HOST, () => {
  console.log(`Panel del certificador en http://${HOST}:${PUERTO} · carpeta ${DIR}`);
});

// Al apagar el servicio: se detiene la corrida en curso y se espera a que termine su envío y
// cierre su sesión SII (hasta 50 s; systemd espera 60).
for (const senal of ['SIGINT', 'SIGTERM']) {
  process.on(senal, () => {
    const p = enCurso?.proceso;
    if (!p) process.exit(0);
    p.once('close', () => process.exit(0));
    p.kill('SIGTERM');
    setTimeout(() => process.exit(0), 50000);
  });
}
