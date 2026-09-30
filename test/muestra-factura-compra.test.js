'use strict';

/**
 * Muestra impresa de la factura de compra (46) y sus notas: el manual de muestras impresas del
 * SII pide el formato de cambio de sujeto (Valor neto, IVA a retener, subtotal, "Menos: IVA
 * retenido", Total). Antes la muestra mostraba Neto + IVA y un Total igual al neto, sin la fila
 * que explica la diferencia.
 *
 * Los documentos sin retención siguen con las filas de siempre (se comparó aparte que las
 * muestras de los sets básico, guía y exenta salen idénticas byte a byte).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const MuestrasImpresas = require('../cert/MuestrasImpresas');

const m = new MuestrasImpresas({ emisor: { rut: '76543210-3', razonSocial: 'EMPRESA EJEMPLO SPA' } });

test('factura de compra con IVA retenido total: formato de cambio de sujeto', () => {
  const filas = m._filasTotalesNacional({
    tipoDte: 46,
    totales: { MntNeto: 82000, TasaIVA: 19, IVA: 15580, ImptoReten: { TipoImp: 15, TasaImp: 19, MontoImp: 15580 }, MntTotal: 82000 },
    descuentosGlobales: [],
  });
  assert.deepEqual(filas, [
    ['Valor Neto', '$82.000', false],
    ['IVA a retener (19%)', '$15.580', false],
    ['Subtotal', '$97.580', false],
    ['Menos: IVA retenido (19%)', '$15.580', false],
    ['Monto Total', '$82.000', true],
  ]);
});

test('ImptoReten como lista: solo el código 15 es IVA retenido', () => {
  const filas = m._filasTotalesNacional({
    tipoDte: 46,
    totales: { MntNeto: 1000, TasaIVA: 19, IVA: 190, ImptoReten: [{ TipoImp: 15, TasaImp: 19, MontoImp: 190 }], MntTotal: 1000 },
  });
  assert.equal(filas.filter(([l]) => /IVA retenido/.test(l)).length, 1);
});

test('factura sin retención: las filas de siempre', () => {
  const filas = m._filasTotalesNacional({
    tipoDte: 33,
    totales: { MntNeto: 1000, TasaIVA: 19, IVA: 190, MntTotal: 1190 },
    descuentosGlobales: [{ TpoMov: 'D', ValorDR: 10 }],
  });
  assert.deepEqual(filas, [
    ['Descuento Global', '$10', false],
    ['Monto Neto', '$1.000', false],
    ['IVA (19%)', '$190', false],
    ['Monto Total', '$1.190', true],
  ]);
});

test('el alto del cuadro de totales cuenta las filas nuevas', () => {
  const doc = { tipoDte: 46, totales: { MntNeto: 1000, TasaIVA: 19, IVA: 190, ImptoReten: { TipoImp: 15, MontoImp: 190 }, MntTotal: 1000 }, descuentosGlobales: [] };
  const sinRetencion = { tipoDte: 33, totales: { MntNeto: 1000, TasaIVA: 19, IVA: 190, MntTotal: 1190 }, descuentosGlobales: [] };
  assert.ok(m._pdfCalcTotalesHeight(doc) > m._pdfCalcTotalesHeight(sinRetencion));
});
