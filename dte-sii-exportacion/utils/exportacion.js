// Copyright (c) 2026 Devlas SpA — https://devlas.cl
// Licencia MIT. Ver archivo LICENSE para mas detalles.
/**
 * Piezas de los documentos de exportación (110, 111, 112) en el orden de DTE_v10.xsd.
 *
 * Lo que cambia respecto de un documento nacional, según el formato DTE del SII y el XSD:
 *
 *  - El documento va dentro de <Exportaciones>, no de <Documento> (lo resuelve DTE.js por tipo).
 *  - Todos los montos van en la moneda de la operación (`Totales/TpoMoneda`) y admiten hasta
 *    4 decimales. `Totales` lleva solo TpoMoneda, MntExe y MntTotal: todo es exento.
 *  - `OtraMoneda` es obligatorio en exportación y va en pesos: TpoMoneda "PESO CL", el tipo de
 *    cambio del Banco Central del día de emisión, y MntExe/MntTotal convertidos.
 *  - `DescuentoMonto` y `RecargoMonto` de una línea son enteros (MntImpType) aunque la línea
 *    tenga decimales: así lo define el XSD de exportación.
 *  - Ningún campo de `Transporte/Aduana` es obligatorio en el XSD. Las reglas de cuáles van
 *    (cláusula, vía, puertos, bultos, país) son del formato del SII y se revisan contra el caso
 *    del set, no contra el esquema: un documento sin ellos valida y aun así es rechazado.
 *
 * @module dte-sii/utils/exportacion
 */

'use strict';

const { sanitizeSiiText, assertLargoMaximo } = require('./sanitize');

/** Glosa de pesos chilenos en TipMonType: la moneda de `OtraMoneda` en exportación. */
const MONEDA_PESOS = 'PESO CL';

/**
 * Redondea un monto según la moneda: pesos a entero, cualquier otra a 4 decimales (el máximo
 * de `fractionDigits` del XSD). El resultado ya no arrastra error de coma flotante, así que
 * el mismo número sale idéntico en el cuerpo del documento y en el `MNT` del timbre.
 *
 * @param {number} valor
 * @param {string} [moneda]
 * @returns {number}
 */
function redondearMonto(valor, moneda) {
  const n = Number(valor);
  if (!Number.isFinite(n)) throw new Error(`Monto inválido: ${valor}`);
  if (moneda === MONEDA_PESOS) return Math.round(n);
  return Number((Math.round((n + Number.EPSILON) * 10000) / 10000).toFixed(4));
}

/** Redondeo a una cantidad fija de decimales, sin error de coma flotante. */
function redondear(valor, decimales) {
  const f = 10 ** decimales;
  return Number((Math.round((Number(valor) + Number.EPSILON) * f) / f).toFixed(decimales));
}

/**
 * Líneas de detalle de un documento de exportación.
 *
 * Cada línea va con IndExe=1: en exportación todo es exento y `MntExe` es la suma de las
 * líneas marcadas así. Orden del XSD: NroLinDet, IndExe, NmbItem, QtyItem, UnmdItem, PrcItem,
 * DescuentoPct, DescuentoMonto, MontoItem.
 *
 * @param {Array<{nombre: string, cantidad?: number, precio?: number, unidad?: string, descuentoPct?: number}>} items
 * @param {Object} opciones
 * @param {string} opciones.moneda - Glosa TipMonType de la operación (ej. "DOLAR USA")
 * @returns {Object[]}
 */
function buildDetalleExportacion(items, { moneda } = {}) {
  if (!moneda) throw new Error('buildDetalleExportacion: falta la moneda de la operación');
  if (!Array.isArray(items) || !items.length) throw new Error('buildDetalleExportacion: el documento no tiene líneas');
  if (items.length > 60) throw new Error(`buildDetalleExportacion: ${items.length} líneas; el SII admite hasta 60`);

  return items.map((item, idx) => {
    const nombre = sanitizeSiiText(item.nombre);
    assertLargoMaximo(nombre, 80, 'NmbItem');
    const cantidad = Number(item.cantidad ?? 1);
    const precio = item.precio === undefined || item.precio === null ? null : Number(item.precio);
    if (!Number.isFinite(cantidad) || cantidad <= 0) throw new Error(`Línea ${idx + 1} (${nombre}): cantidad inválida (${item.cantidad})`);
    if (precio !== null && (!Number.isFinite(precio) || precio < 0)) throw new Error(`Línea ${idx + 1} (${nombre}): precio inválido (${item.precio})`);

    const det = { NroLinDet: idx + 1, IndExe: 1, NmbItem: nombre };
    if (precio === null || precio === 0) {
      // Línea sin valor (corrige texto): el XSD no exige cantidad ni precio, solo MontoItem.
      det.MontoItem = 0;
      return det;
    }

    det.QtyItem = redondear(cantidad, 6);
    if (item.unidad) {
      const unidad = String(item.unidad).trim().toUpperCase();
      assertLargoMaximo(unidad, 4, 'UnmdItem');
      det.UnmdItem = unidad;
    }
    det.PrcItem = redondear(precio, 6);

    let monto = redondearMonto(cantidad * precio, moneda);
    const pct = Number(item.descuentoPct || 0);
    if (pct > 0) {
      // DescuentoMonto es entero en el XSD de exportación (MntImpType).
      const descuento = Math.round(monto * pct / 100);
      det.DescuentoPct = redondear(pct, 2);
      if (descuento > 0) det.DescuentoMonto = descuento;
      monto = redondearMonto(monto - descuento, moneda);
    }
    det.MontoItem = monto;
    return det;
  });
}

/**
 * Descuentos o recargos globales de exportación. Siempre con IndExeDR=1: afectan al monto
 * exento, que en exportación es todo el documento.
 *
 * @param {Array<{tipo: 'D'|'R', valor: number, enPorcentaje?: boolean, glosa?: string}>} movimientos
 * @returns {Object[]}
 */
function buildDscRcgGlobalExportacion(movimientos = []) {
  return movimientos.map((m, idx) => {
    if (m.tipo !== 'D' && m.tipo !== 'R') throw new Error(`Descuento/recargo global ${idx + 1}: tipo "${m.tipo}" (debe ser D o R)`);
    const valor = redondear(m.valor, 2);
    if (!(valor > 0)) throw new Error(`Descuento/recargo global ${idx + 1}: valor inválido (${m.valor})`);
    const glosa = m.glosa ? sanitizeSiiText(m.glosa) : null;
    if (glosa) assertLargoMaximo(glosa, 45, 'GlosaDR');
    return {
      NroLinDR: idx + 1,
      TpoMov: m.tipo,
      ...(glosa ? { GlosaDR: glosa } : {}),
      TpoValor: m.enPorcentaje === false ? '$' : '%',
      ValorDR: valor,
      IndExeDR: 1,
    };
  });
}

/**
 * Totales en la moneda de la operación y su equivalente en pesos.
 *
 * MntExe = suma de las líneas - descuentos globales + recargos globales; MntTotal = MntExe
 * (en exportación no hay neto ni IVA). OtraMoneda lleva los mismos montos multiplicados por
 * el tipo de cambio, redondeados a 4 decimales como admite el XSD.
 *
 * @param {Object[]} detalle - Salida de buildDetalleExportacion
 * @param {Object[]} [dscRcg] - Salida de buildDscRcgGlobalExportacion
 * @param {Object} opciones
 * @param {string} opciones.moneda - Glosa TipMonType de la operación
 * @param {number} opciones.tipoCambio - Pesos por unidad de la moneda (Banco Central, día de emisión)
 * @returns {{ Totales: Object, OtraMoneda: Object }}
 */
function calcularTotalesExportacion(detalle, dscRcg = [], { moneda, tipoCambio } = {}) {
  if (!moneda) throw new Error('calcularTotalesExportacion: falta la moneda de la operación');
  const tc = Number(tipoCambio);
  if (!Number.isFinite(tc) || tc <= 0) {
    throw new Error(
      `calcularTotalesExportacion: falta el tipo de cambio de ${moneda} a pesos. El SII exige ` +
      'OtraMoneda en exportación, con el tipo de cambio del Banco Central del día de emisión.'
    );
  }
  if (tc > 999999.9999) throw new Error(`Tipo de cambio fuera de rango para el SII: ${tipoCambio}`);

  const suma = (detalle || []).reduce((acc, d) => acc + Number(d.MontoItem || 0), 0);
  let exento = redondearMonto(suma, moneda);
  for (const dr of dscRcg || []) {
    const valor = dr.TpoValor === '%' ? redondearMonto(exento * dr.ValorDR / 100, moneda) : Number(dr.ValorDR);
    exento = redondearMonto(dr.TpoMov === 'D' ? exento - valor : exento + valor, moneda);
  }
  if (exento < 0) throw new Error(`calcularTotalesExportacion: el total quedó negativo (${exento})`);

  const tipoCambioSii = redondear(tc, 4);
  const enPesos = redondear(exento * tipoCambioSii, 4);
  return {
    Totales: { TpoMoneda: moneda, MntExe: exento, MntTotal: exento },
    OtraMoneda: {
      TpoMoneda: MONEDA_PESOS,
      TpoCambio: tipoCambioSii,
      MntExeOtrMnda: enPesos,
      MntTotOtrMnda: enPesos,
    },
  };
}

/** Orden de los hijos de <Aduana> en DTE_v10.xsd (rama Exportaciones). */
const ORDEN_ADUANA = [
  'CodModVenta', 'CodClauVenta', 'TotClauVenta', 'CodViaTransp', 'NombreTransp', 'RUTCiaTransp',
  'NomCiaTransp', 'IdAdicTransp', 'Booking', 'Operador', 'CodPtoEmbarque', 'IdAdicPtoEmb',
  'CodPtoDesemb', 'IdAdicPtoDesemb', 'Tara', 'CodUnidMedTara', 'PesoBruto', 'CodUnidPesoBruto',
  'PesoNeto', 'CodUnidPesoNeto', 'TotItems', 'TotBultos', 'TipoBultos', 'MntFlete', 'MntSeguro',
  'CodPaisRecep', 'CodPaisDestin',
];

/** Orden de los hijos de <Transporte>. */
const ORDEN_TRANSPORTE = ['Patente', 'RUTTrans', 'Chofer', 'DirDest', 'CmnaDest', 'CiudadDest', 'Aduana'];

/** Orden de los hijos de <TipoBultos>. */
const ORDEN_TIPO_BULTOS = ['CodTpoBultos', 'CantBultos', 'Marcas', 'IdContainer', 'Sello', 'EmisorSello'];

function ordenar(obj, orden, nombre) {
  const desconocidos = Object.keys(obj).filter((k) => !orden.includes(k));
  if (desconocidos.length) throw new Error(`${nombre}: campos que el XSD no admite: ${desconocidos.join(', ')}`);
  const out = {};
  for (const k of orden) {
    if (obj[k] !== undefined && obj[k] !== null && obj[k] !== '') out[k] = obj[k];
  }
  return out;
}

/**
 * <Transporte> de un documento de exportación, con <Aduana> y <TipoBultos> en el orden del XSD.
 * Lanza si trae un campo que el esquema no conoce (un nombre mal escrito se perdería en
 * silencio). Devuelve null si no queda nada que informar.
 *
 * @param {Object} [transporte] - Patente, RUTTrans, DirDest, ... y `Aduana`
 * @returns {Object|null}
 */
function buildTransporteExportacion(transporte = {}) {
  const { Aduana, ...resto } = transporte || {};
  let aduana = null;
  if (Aduana) {
    const { TipoBultos, ...camposAduana } = Aduana;
    const bultos = (Array.isArray(TipoBultos) ? TipoBultos : TipoBultos ? [TipoBultos] : [])
      .map((b, i) => ordenar(b, ORDEN_TIPO_BULTOS, `TipoBultos ${i + 1}`))
      .filter((b) => Object.keys(b).length);
    if (bultos.length > 10) throw new Error(`TipoBultos: ${bultos.length} tipos; el SII admite hasta 10`);
    aduana = ordenar({ ...camposAduana, ...(bultos.length ? { TipoBultos: bultos } : {}) }, ORDEN_ADUANA, 'Aduana');
    for (const campo of ['TotClauVenta']) {
      if (aduana[campo] !== undefined) aduana[campo] = redondear(aduana[campo], 2);
    }
    for (const campo of ['MntFlete', 'MntSeguro']) {
      if (aduana[campo] !== undefined) aduana[campo] = redondear(aduana[campo], 4);
    }
    if (!Object.keys(aduana).length) aduana = null;
  }
  const out = ordenar({ ...resto, ...(aduana ? { Aduana: aduana } : {}) }, ORDEN_TRANSPORTE, 'Transporte');
  return Object.keys(out).length ? out : null;
}

module.exports = {
  MONEDA_PESOS,
  redondearMonto,
  buildDetalleExportacion,
  buildDscRcgGlobalExportacion,
  calcularTotalesExportacion,
  buildTransporteExportacion,
};
