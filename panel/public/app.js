'use strict';
const $ = (id) => document.getElementById(id);
const estado = { empresas: [], rut: null, enCurso: null, fuente: null, trabajo: null };

const PLANTILLA = `# Empresa a certificar. El certificado lo pone el servidor.
EMISOR_RUT=
EMISOR_RAZON_SOCIAL=
EMISOR_GIRO=
EMISOR_ACTECO=
EMISOR_DIRECCION=
EMISOR_COMUNA=
EMISOR_CIUDAD=
# Fecha de la postulación (AAAA-MM-DD). "Traer datos del SII" la completa.
FECHA_RESOLUCION_CERT=
# Sets además del básico: guia, exenta, compra, exportacion (separados por coma) o ninguno
SETS_ADICIONALES=guia,exenta,compra
# Exportación: tipo de cambio de hoy (si falta, se toma del Banco Central)
# TIPO_CAMBIO=DOLAR USA:945,12
`;

const ETAPAS = [
  ['sets_aprobados', 'Sets'], ['libros_aprobados', 'Libros'], ['simulacion_aprobada', 'Simulación'],
  ['intercambio', 'Intercambio'], ['muestras', 'Muestras'], ['cierre', 'Cierre'],
];
const SIGNIFICADO = { 0: ['ok', 'Terminó bien'], 2: ['warn', 'Esperando al SII: relanza más tarde'], 1: ['bad', 'Requiere una acción (mira el aviso)'], 130: ['warn', 'Interrumpido'] };

async function api(ruta, opciones = {}) {
  const r = await fetch(ruta, {
    ...opciones,
    headers: { 'Content-Type': 'application/json', 'X-Panel': '1', ...(opciones.headers || {}) },
    credentials: 'same-origin',
  });
  let cuerpo = {};
  try { cuerpo = await r.json(); } catch (_) {}
  if (r.status === 401 && ruta !== '/api/login') { mostrarLogin(); throw new Error(cuerpo.error || 'Sesión vencida'); }
  if (!r.ok) { const e = new Error(cuerpo.error || `Error ${r.status}`); e.cuerpo = cuerpo; throw e; }
  return cuerpo;
}

function mostrarLogin() { $('app').hidden = true; $('salir').hidden = true; $('login').hidden = false; $('pw').focus(); }
function mostrarApp() { $('login').hidden = true; $('app').hidden = false; $('salir').hidden = false; }

$('login').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  $('loginErr').textContent = '';
  try {
    await api('/api/login', { method: 'POST', body: JSON.stringify({ clave: $('pw').value }) });
    $('pw').value = '';
    mostrarApp();
    await cargarEmpresas();
  } catch (e) { $('loginErr').textContent = e.message; }
});
$('salir').addEventListener('click', async () => { try { await api('/api/logout', { method: 'POST' }); } catch (_) {} mostrarLogin(); });

function el(tag, props = {}, ...hijos) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v);
  }
  for (const h of hijos) if (h !== null && h !== undefined) n.append(h);
  return n;
}

async function cargarEmpresas() {
  const { empresas, enCurso } = await api('/api/empresas');
  estado.empresas = empresas;
  estado.enCurso = enCurso;
  const lista = $('lista');
  lista.replaceChildren();
  for (const e of empresas) {
    const pill = enCurso?.rut === e.rut ? el('span', { class: 'pill run' }, 'corriendo')
      : e.etapas.includes('cierre') ? el('span', { class: 'pill ok' }, 'certificada')
      : e.ultimo?.codigo === 2 ? el('span', { class: 'pill warn' }, 'esperando SII')
      : e.ultimo?.codigo === 1 ? el('span', { class: 'pill bad' }, 'revisar') : null;
    lista.append(el('button', {
      class: `btn co${estado.rut === e.rut ? ' sel' : ''}`, type: 'button', onclick: () => elegir(e.rut),
    }, el('strong', {}, e.razonSocial || e.rut), el('span', {}, e.rut), pill));
  }
  if (!empresas.length) lista.append(el('p', { class: 'muted' }, 'Todavía no hay empresas.'));
  if (estado.rut) pintarFicha();
  if (enCurso && !estado.fuente) seguir(enCurso);
}

function empresaActual() { return estado.empresas.find((e) => e.rut === estado.rut); }

function pintarFicha() {
  const e = empresaActual();
  $('vacio').hidden = !!e;
  for (const id of ['ficha', 'trabajo', 'registro']) $(id).hidden = !e;
  if (!e) return;
  $('coNombre').textContent = e.razonSocial || '(sin razón social)';
  $('coRut').textContent = `RUT ${e.rut} · sets adicionales: ${e.sets || 'ninguno'}`;
  $('coEstado').replaceChildren();
  if (e.ultimo) {
    const [clase, texto] = SIGNIFICADO[e.ultimo.codigo] || ['warn', 'Terminó'];
    $('coEstado').append(el('span', { class: `pill ${clase}` }, `Último: ${e.ultimo.comando} · ${texto}`));
  }
  $('steps').replaceChildren(...ETAPAS.map(([k, n]) => el('span', { class: `step${e.etapas.includes(k) ? ' done' : ''}` }, n)));
  const dls = $('descargas');
  dls.replaceChildren();
  for (const [archivo, texto] of [['set-texto.txt', 'Texto del set de pruebas'], ['estructuras.json', 'Set interpretado'], ['estado.json', 'Estado de la certificación'], ['avisos.jsonl', 'Avisos'], ['avance.html', 'Página de avance del SII']]) {
    dls.append(el('a', { href: `/api/empresas/${e.rut}/archivos/${archivo}` }, texto));
  }
  dls.append(el('a', { href: `/api/empresas/${e.rut}/muestras.tar.gz` }, 'Muestras impresas (PDF)'));
  actualizarBotones();
  cargarHistorial();
}

function actualizarBotones() {
  const ocupado = !!estado.enCurso;
  for (const b of document.querySelectorAll('[data-cmd], #rehacer')) b.disabled = ocupado;
  $('guardar').disabled = ocupado && estado.enCurso?.rut === estado.rut;
}

async function elegir(rut) {
  estado.rut = rut;
  await cargarEmpresas();
  const { texto } = await api(`/api/empresas/${rut}/env`);
  $('envTexto').value = texto;
  $('envMsg').textContent = '';
  if (!estado.enCurso || estado.enCurso.rut !== rut) limpiarLog('Registro');
}

$('nueva').addEventListener('click', () => {
  estado.rut = null;
  pintarFicha();
  $('vacio').hidden = true;
  $('trabajo').hidden = false;
  mostrarTab('datos');
  $('envTexto').value = PLANTILLA;
  $('envMsg').textContent = 'Completa los datos y guarda.';
});
$('plantilla').addEventListener('click', () => { $('envTexto').value = PLANTILLA; });

function mostrarTab(nombre) {
  for (const b of document.querySelectorAll('[data-tab]')) b.setAttribute('aria-pressed', String(b.dataset.tab === nombre));
  for (const t of ['acciones', 'datos', 'archivos']) $(`t-${t}`).hidden = t !== nombre;
}
for (const b of document.querySelectorAll('[data-tab]')) b.addEventListener('click', () => mostrarTab(b.dataset.tab));

// Cargar un .env desde archivo o arrastrándolo.
$('archivoEnv').addEventListener('change', async (ev) => {
  const f = ev.target.files[0];
  if (f) $('envTexto').value = await f.text();
});
$('envTexto').addEventListener('dragover', (ev) => ev.preventDefault());
$('envTexto').addEventListener('drop', async (ev) => {
  ev.preventDefault();
  const f = ev.dataTransfer.files[0];
  if (f) $('envTexto').value = await f.text();
});

$('guardar').addEventListener('click', async () => {
  $('envMsg').textContent = '';
  try {
    const r = await api('/api/empresas', { method: 'POST', body: JSON.stringify({ texto: $('envTexto').value }) });
    $('envMsg').textContent = r.descartadas.length
      ? `Guardado. No se guardó: ${r.descartadas.join(', ')}.`
      : 'Guardado.';
    estado.rut = r.rut;
    await elegir(r.rut);
    mostrarTab('datos');
  } catch (e) { $('envMsg').textContent = e.message; }
});

async function correr(comando, args = []) {
  const opciones = {
    revisarMuestras: $('optRevisar').checked,
    forzarDescarga: $('optForzar').checked,
    reiniciarSet: $('optReiniciar').checked,
    confirmarSetsAprobados: $('optAprobados').checked,
  };
  if (opciones.forzarDescarga && !confirm('Forzar la descarga reinicia la postulación en el SII y se pierde lo aprobado. ¿Seguir?')) return;
  if (opciones.reiniciarSet && !confirm('Se bajará un set nuevo aunque el portal muestre avances anteriores. ¿Seguir?')) return;
  if (opciones.confirmarSetsAprobados && !confirm('¿El portal del SII ya muestra los sets como aprobados (REVISADO CONFORME)? Si no, la certificación avanzaría en falso.')) return;
  try {
    const { trabajo } = await api(`/api/empresas/${estado.rut}/comandos`, { method: 'POST', body: JSON.stringify({ comando, args, opciones }) });
    $('optForzar').checked = false;
    $('optReiniciar').checked = false;
    $('optAprobados').checked = false;
    estado.enCurso = trabajo;
    actualizarBotones();
    seguir(trabajo);
  } catch (e) {
    alert(e.message);
  }
}
for (const b of document.querySelectorAll('[data-cmd]')) {
  b.addEventListener('click', () => correr(b.dataset.cmd, b.dataset.args ? [b.dataset.args] : []));
}
$('rehacer').addEventListener('click', () => {
  const s = $('rehacerSet').value;
  if (confirm(`¿Desmarcar "${s}" para reenviarlo con folios nuevos en la próxima certificación?`)) correr('rehacer', [s]);
});

function limpiarLog(titulo) {
  if (estado.fuente) { estado.fuente.close(); estado.fuente = null; }
  $('log').replaceChildren();
  $('logTitulo').textContent = titulo;
  $('logEstado').replaceChildren();
  $('detener').hidden = true;
  $('logDescargar').hidden = true;
}

function agregarLinea(nodo) {
  const log = $('log');
  const abajo = log.scrollTop + log.clientHeight >= log.scrollHeight - 30;
  log.append(nodo);
  if (abajo) log.scrollTop = log.scrollHeight;
}

function seguir(t) {
  limpiarLog(`${t.comando}${t.args?.length ? ' ' + t.args.join(' ') : ''} · ${t.rut}`);
  estado.trabajo = t;
  $('logEstado').append(el('span', { class: 'pill run' }, t.fin ? 'terminado' : 'corriendo'));
  $('detener').hidden = !!t.fin;
  $('logDescargar').href = `/api/trabajos/${t.id}/log`;
  $('logDescargar').hidden = false;
  const fuente = new EventSource(`/api/trabajos/${t.id}/eventos`);
  estado.fuente = fuente;
  fuente.onmessage = (m) => {
    const e = JSON.parse(m.data);
    if (e.tipo === 'linea') {
      if (/^\[(AVISO|RESULTADO)\]/.test(e.texto)) return;
      agregarLinea(el('div', { class: /^\s*\[|^─|^═/.test(e.texto) ? 'dim' : '' }, e.texto || ' '));
    } else if (e.tipo === 'aviso') {
      const a = e.aviso;
      agregarLinea(el('div', { class: `aviso ${a.nivel}` }, el('b', {}, `[${a.codigo}] `), a.mensaje, a.accion ? el('div', {}, `→ ${a.accion}`) : null));
    } else if (e.tipo === 'fin') {
      const [clase, texto] = SIGNIFICADO[e.codigo] || ['bad', `Salió con código ${e.codigo}`];
      agregarLinea(el('div', { class: 'fin' }, `■ ${texto}`));
      $('logEstado').replaceChildren(el('span', { class: `pill ${clase}` }, texto));
      $('detener').hidden = true;
      fuente.close();
      estado.fuente = null;
      estado.enCurso = null;
      cargarEmpresas();
    }
  };
  fuente.onerror = () => { /* el navegador reintenta solo */ };
}

$('detener').addEventListener('click', async () => {
  if (!estado.trabajo || !confirm('¿Detener la corrida? Si hay un envío al SII en curso, primero se termina y se registra. Después se puede relanzar y sigue donde quedó.')) return;
  try { await api(`/api/trabajos/${estado.trabajo.id}/detener`, { method: 'POST' }); } catch (e) { alert(e.message); }
});

async function cargarHistorial() {
  if (!estado.rut) return;
  const { trabajos } = await api(`/api/trabajos?rut=${encodeURIComponent(estado.rut)}`);
  const h = $('historial');
  h.replaceChildren();
  if (trabajos.length) h.append(el('div', { class: 'muted' }, 'Corridas anteriores'));
  for (const t of trabajos.slice(0, 10)) {
    const [clase, texto] = t.fin ? (SIGNIFICADO[t.codigo] || ['bad', `código ${t.codigo}`]) : ['run', 'corriendo'];
    h.append(el('button', { class: 'btn small', type: 'button', onclick: () => seguir(t) },
      el('span', {}, `${new Date(t.inicio).toLocaleString('es-CL')} · ${t.comando}${t.args?.length ? ' ' + t.args.join(' ') : ''}`),
      el('span', { class: `pill ${clase}` }, texto)));
  }
}

(async () => {
  try {
    const s = await api('/api/sesion');
    mostrarApp();
    estado.enCurso = s.enCurso;
    await cargarEmpresas();
  } catch (_) { mostrarLogin(); }
})();
