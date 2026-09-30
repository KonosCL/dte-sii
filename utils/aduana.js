// Copyright (c) 2026 Devlas SpA — https://devlas.cl
// Licencia MIT. Ver archivo LICENSE para mas detalles.
/**
 * Traducción de los textos de un set de exportación a los códigos de Aduana y a las glosas de
 * moneda que exige el SII.
 *
 * El set del SII escribe "PUERTO DE EMBARQUE: SAN ANTONIO" o "MONEDA DE LA OPERACION: DOLAR";
 * el documento lleva `CodPtoEmbarque` 906 y `TpoMoneda` "DOLAR USA". Este módulo hace ese paso
 * y, cuando no puede, LANZA con el texto que no reconoció y los candidatos más parecidos. No
 * adivina: un código de Aduana mal puesto pasa el esquema (ningún campo de `Aduana` es
 * obligatorio en DTE_v10.xsd) y el SII lo rechaza recién al comparar el documento contra el
 * caso del set. Por eso la validación de estos campos no puede quedar en manos del XSD.
 *
 * Para un texto que la tabla no resuelve, se pasa un override:
 *   resolverCodigo('puerto', 'PUERTO NUEVO', { overrides: { 'PUERTO NUEVO': 997 } })
 *
 * @module dte-sii/utils/aduana
 */

'use strict';

const TABLAS = require('./aduana-tablas');

/** Nombre legible de cada tabla, para los mensajes de error. */
const NOMBRE_TABLA = {
  formaPago: 'Formas de pago (FmaPagExp)',
  modalidadVenta: 'Modalidades de venta (CodModVenta)',
  clausulaVenta: 'Cláusulas de venta (CodClauVenta)',
  viaTransporte: 'Vías de transporte (CodViaTransp)',
  tipoBulto: 'Tipos de bulto (CodTpoBultos)',
  unidad: 'Unidades de medida',
  pais: 'Países',
  puerto: 'Puertos',
};

/** Cómo llama el set del SII a cada campo: es lo que se muestra en los errores. */
const CAMPO_EN_SET = {
  formaPago: 'FORMA DE PAGO EXPORTACION',
  modalidadVenta: 'MODALIDAD DE VENTA',
  clausulaVenta: 'CLAUSULA DE VENTA DE EXPORTACION',
  viaTransporte: 'VIA DE TRANSPORTE',
  tipoBulto: 'TIPO DE BULTO',
  unidad: 'UNIDAD DE MEDIDA',
  pais: 'PAIS',
  puerto: 'PUERTO',
};

const TABLA_POR_NOMBRE = {
  formaPago: TABLAS.FORMAS_PAGO,
  modalidadVenta: TABLAS.MODALIDADES_VENTA,
  clausulaVenta: TABLAS.CLAUSULAS_VENTA,
  viaTransporte: TABLAS.VIAS_TRANSPORTE,
  tipoBulto: TABLAS.TIPOS_BULTO,
  unidad: TABLAS.UNIDADES,
  pais: TABLAS.PAISES,
  puerto: TABLAS.PUERTOS,
};

/**
 * Otras formas de escribir una glosa. Solo equivalencias sin ambigüedad: donde un texto
 * podría ser dos códigos (por ejemplo "COBRANZA" hasta o más de un año, o "CAJA" de cartón,
 * de madera o sin especificar) no hay alias y se exige override.
 */
const ALIAS = {
  formaPago: {
    ACREDITIVO: 11,
    ANTICIPADO: 32,
    'PAGO ANTICIPADO': 32,
    'SIN PAGO': 21,
  },
  modalidadVenta: {},
  clausulaVenta: {
    'C&F': 2,
    'C Y F': 2,
    CYF: 2,
    'COSTO Y FLETE': 2,
    'EX WORKS': 3,
    EXWORKS: 3,
    'EX FABRICA': 3,
    'SIN CLAUSULA': 6,
    OTRAS: 8,
  },
  viaTransporte: {
    MARITIMA: 1,
    MARITIMO: 1,
    FLUVIAL: 1,
    LACUSTRE: 1,
    AEREA: 4,
    FERROVIARIA: 6,
    FERROCARRIL: 6,
    CARRETERO: 7,
    CARRETERA: 7,
    TERRESTRE: 7,
    CAMION: 7,
    OLEODUCTO: 8,
    GASODUCTO: 8,
    'TENDIDO ELECTRICO': 9,
  },
  tipoBulto: {
    CONTENEDOR: 78,
    'CONTENEDOR 20': 73,
    'CONTENEDOR DE 20': 73,
    'CONTENEDOR 40': 74,
    'CONTENEDOR DE 40': 74,
    PALLET: 80,
    PALET: 80,
    PALETS: 80,
  },
  unidad: {},
  pais: {
    'ESTADOS UNIDOS': 225,
    'ESTADOS UNIDOS DE AMERICA': 225,
    EEUU: 225,
    'EE.UU.': 225,
    'EE UU': 225,
    USA: 225,
    'U.S.A': 225,
    'GRAN BRETANA': 510,
    INGLATERRA: 510,
  },
  puerto: {
    SHANGHAI: 411,
    BUSAN: 422,
    PUSAN: 422,
    'NUEVA YORK': 134,
    'ARTURO MERINO BENITEZ': 992,
    'AEROPUERTO ARTURO MERINO BENITEZ': 992,
  },
};

/**
 * Mayúsculas, sin tildes (Ñ pasa a N, como en las glosas de Aduana), espacios colapsados y
 * sin puntuación suelta al final.
 * @param {*} texto
 * @returns {string}
 */
function normalizarGlosa(texto) {
  return String(texto ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .replace(/[\s.,;:]+$/, '')
    .trim();
}

/** Distancia de edición, solo para ordenar candidatos en el mensaje de error. */
function distancia(a, b) {
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

function candidatosParecidos(tabla, buscado, max = 5) {
  return Object.entries(tabla)
    .map(([codigo, glosa]) => ({ codigo: Number(codigo), glosa, d: distancia(buscado, glosa) }))
    .sort((x, y) => x.d - y.d)
    .slice(0, max)
    .map(({ codigo, glosa }) => `${codigo} ${glosa}`);
}

/**
 * Busca el código de Aduana de un texto del set.
 *
 * Orden de búsqueda: override del consumidor, código numérico escrito tal cual, glosa exacta,
 * alias, primera palabra igual a una glosa ("FOB (FREE ON BOARD)"), y glosa truncada de Aduana
 * que es prefijo del texto. Si con eso quedan varios candidatos, `preferir` elige entre ellos
 * (sirve para "SAN FRANCISCO", que es a la vez un paso fronterizo chileno y un puerto de
 * Estados Unidos). Si no queda exactamente uno, lanza.
 *
 * @param {'formaPago'|'modalidadVenta'|'clausulaVenta'|'viaTransporte'|'tipoBulto'|'unidad'|'pais'|'puerto'} tabla
 * @param {string|number} texto - Valor tal como viene en el set.
 * @param {Object} [opciones]
 * @param {Object<string, number>} [opciones.overrides] - Texto (se normaliza) → código.
 * @param {(codigo: number) => boolean} [opciones.preferir] - Desempate entre candidatos.
 * @param {string} [opciones.campo] - Nombre del campo en el set, para el mensaje de error.
 * @returns {{ codigo: number, glosa: string, via: string }}
 */
function resolverCodigo(tabla, texto, opciones = {}) {
  const datos = TABLA_POR_NOMBRE[tabla];
  if (!datos) throw new Error(`resolverCodigo: tabla desconocida "${tabla}"`);
  const campo = opciones.campo || CAMPO_EN_SET[tabla];
  const buscado = normalizarGlosa(texto);
  if (!buscado) throw new Error(`${campo}: el set no trae valor`);

  const resultado = (codigo, via) => ({ codigo: Number(codigo), glosa: datos[codigo] ?? buscado, via });

  const overrides = {};
  for (const [k, v] of Object.entries(opciones.overrides || {})) overrides[normalizarGlosa(k)] = v;
  if (overrides[buscado] !== undefined) return resultado(overrides[buscado], 'override');

  if (/^\d+$/.test(buscado) && datos[Number(buscado)] !== undefined) return resultado(Number(buscado), 'codigo');

  const elegir = (codigos, via) => {
    const unicos = [...new Set(codigos.map(Number))];
    if (unicos.length === 1) return resultado(unicos[0], via);
    if (unicos.length > 1 && typeof opciones.preferir === 'function') {
      const preferidos = unicos.filter((c) => opciones.preferir(c));
      if (preferidos.length === 1) return resultado(preferidos[0], via);
    }
    if (unicos.length > 1) {
      throw new Error(
        `${campo}: "${texto}" coincide con más de un código de Aduana ` +
        `(${unicos.map((c) => `${c} ${datos[c]}`).join(' · ')}). ` +
        `Indica cuál con un override para "${buscado}".`
      );
    }
    return null;
  };

  // Las glosas se comparan normalizadas igual que el texto buscado ("U.S.A." → "U.S.A").
  const entradas = Object.entries(datos).map(([c, g]) => [c, normalizarGlosa(g)]);
  const exactos = entradas.filter(([, g]) => g === buscado).map(([c]) => c);
  const porGlosa = elegir(exactos, 'glosa');
  if (porGlosa) return porGlosa;

  const alias = ALIAS[tabla] || {};
  if (alias[buscado] !== undefined) return resultado(alias[buscado], 'alias');

  // "FOB (FREE ON BOARD)", "AEREO - VIA AEREA": la primera palabra ya es una glosa o un alias.
  const primera = buscado.split(/[\s(/-]+/)[0];
  if (primera && primera !== buscado) {
    const porPrimera = elegir(entradas.filter(([, g]) => g === primera).map(([c]) => c), 'glosa');
    if (porPrimera) return porPrimera;
    if (alias[primera] !== undefined) return resultado(alias[primera], 'alias');
  }

  // Aduana corta sus glosas a 30 caracteres: "OTROS PUERTOS DE ESTADOS UNIDO" es prefijo del
  // nombre completo que puede traer el set. Solo glosas largas, para no confundir "LIMA" con
  // "LIMACHE" en la dirección contraria.
  const prefijos = entradas.filter(([, g]) => g.length >= 20 && buscado.startsWith(g)).map(([c]) => c);
  const porPrefijo = elegir(prefijos, 'prefijo');
  if (porPrefijo) return porPrefijo;

  throw new Error(
    `${campo}: no encontré "${texto}" en la tabla de Aduana ${NOMBRE_TABLA[tabla]}. ` +
    `Más parecidos: ${candidatosParecidos(datos, buscado).join(' · ')}. ` +
    `Si es otro, indícalo con un override para "${buscado}".`
  );
}

/**
 * Alias de moneda → glosa de TipMonType. Las claves ya van normalizadas.
 */
const ALIAS_MONEDA = {
  DOLAR: 'DOLAR USA',
  DOLARES: 'DOLAR USA',
  'DOLAR AMERICANO': 'DOLAR USA',
  'DOLAR ESTADOUNIDENSE': 'DOLAR USA',
  'DOLARES AMERICANOS': 'DOLAR USA',
  'DOLARES ESTADOUNIDENSES': 'DOLAR USA',
  'DOLAR ESTADOS UNIDOS': 'DOLAR USA',
  'DOLAR US': 'DOLAR USA',
  USD: 'DOLAR USA',
  'US$': 'DOLAR USA',
  EUR: 'EURO',
  EUROS: 'EURO',
  JPY: 'YEN',
  YENES: 'YEN',
  GBP: 'LIBRA EST',
  'LIBRA ESTERLINA': 'LIBRA EST',
  'LIBRAS ESTERLINAS': 'LIBRA EST',
  CAD: 'DOLAR CAN',
  'DOLAR CANADIENSE': 'DOLAR CAN',
  AUD: 'DOLAR AUST',
  'DOLAR AUSTRALIANO': 'DOLAR AUST',
  NZD: 'DOLAR NZ',
  HKD: 'DOLAR HK',
  SGD: 'DOLAR SIN',
  TWD: 'DOLAR TAI',
  CHF: 'FRANCO SZ',
  'FRANCO SUIZO': 'FRANCO SZ',
  CLP: 'PESO CL',
  'PESO CHILENO': 'PESO CL',
  'PESOS CHILENOS': 'PESO CL',
  MXN: 'PESO MEX',
  'PESO MEXICANO': 'PESO MEX',
  COP: 'PESO COL',
  'PESO COLOMBIANO': 'PESO COL',
  UYU: 'PESO URUG',
  'PESO URUGUAYO': 'PESO URUG',
  PEN: 'NUEVO SOL',
  SOL: 'NUEVO SOL',
  SOLES: 'NUEVO SOL',
  CNY: 'RENMINBI',
  YUAN: 'RENMINBI',
  ZAR: 'RAND',
  AED: 'DIRHAM',
  DKK: 'CORONA DIN',
  NOK: 'CORONA NOR',
  SEK: 'CORONA SC',
  PYG: 'GUARANI',
  BOB: 'BOLIVIANO',
  VES: 'BOLIVAR',
  INR: 'RUPIA',
};

/**
 * Glosa de moneda que acepta el SII en `TpoMoneda` para un texto del set ("DOLAR",
 * "DÓLAR ESTADOUNIDENSE", "USD" → "DOLAR USA"). Lanza si no la reconoce: el XSD solo admite
 * las glosas de `MONEDAS_SII`, y una moneda equivocada cambia todos los montos del documento.
 *
 * @param {string} texto
 * @param {Object} [opciones]
 * @param {Object<string, string>} [opciones.overrides] - Texto (se normaliza) → glosa.
 * @returns {string}
 */
function resolverMoneda(texto, opciones = {}) {
  const buscado = normalizarGlosa(texto);
  if (!buscado) throw new Error('MONEDA DE LA OPERACION: el set no trae valor');
  const overrides = {};
  for (const [k, v] of Object.entries(opciones.overrides || {})) overrides[normalizarGlosa(k)] = v;
  const candidata = overrides[buscado] ?? (TABLAS.MONEDAS_SII.includes(buscado) ? buscado : ALIAS_MONEDA[buscado]);
  if (candidata && TABLAS.MONEDAS_SII.includes(candidata)) return candidata;
  if (candidata) {
    throw new Error(`MONEDA DE LA OPERACION: "${candidata}" no es una glosa que acepte el SII (TipMonType).`);
  }
  const parecidas = TABLAS.MONEDAS_SII
    .map((g) => ({ g, d: distancia(buscado, g) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, 4)
    .map((x) => x.g);
  throw new Error(
    `MONEDA DE LA OPERACION: no reconozco "${texto}". Glosas que acepta el SII más parecidas: ` +
    `${parecidas.join(' · ')}. Si es otra, indícala con un override para "${buscado}".`
  );
}

/** Puertos chilenos: la tabla de Aduana los numera del 900 al 999. */
function esPuertoChileno(codigo) {
  return Number(codigo) >= 900 && Number(codigo) <= 999;
}

module.exports = {
  ...TABLAS,
  normalizarGlosa,
  resolverCodigo,
  resolverMoneda,
  esPuertoChileno,
};
