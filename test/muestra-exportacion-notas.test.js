'use strict';
// Notas de exportación sin datos de embarque propios: la muestra impresa toma los del
// documento que corrigen (manual de muestras: puertos y bultos obligatorios con transporte).
const assert = require('assert');
const MuestrasImpresas = require('../cert/MuestrasImpresas.js');

const factura = {
  tipoDte: 110, folio: 5, referencias: [{ TpoDocRef: 'SET', FolioRef: '1' }],
  transporte: { Aduana: { CodPtoEmbarque: 902, CodPtoDesemb: 242, TotBultos: 65,
    TipoBultos: { CodTpoBultos: 89 }, CodViaTransp: 6, CodPaisRecep: 218, CodPaisDestin: 218 } },
};
const nc = { tipoDte: 112, folio: 2, transporte: { Aduana: { CodPaisRecep: 218 } },
  referencias: [{ TpoDocRef: 'SET', FolioRef: '1' }, { TpoDocRef: '110', FolioRef: '5' }] };
const nd = { tipoDte: 111, folio: 2, transporte: {},
  referencias: [{ TpoDocRef: 'SET', FolioRef: '1' }, { TpoDocRef: '112', FolioRef: '2' }] };
const ncPropia = { tipoDte: 112, folio: 9, transporte: { Aduana: { CodPtoEmbarque: 903 } },
  referencias: [{ TpoDocRef: '110', FolioRef: '5' }] };

MuestrasImpresas.heredarAduanaEnNotas([factura, nc, nd, ncPropia]);

assert.strictEqual(nc.aduanaReferida.CodPtoEmbarque, 902, 'NC hereda el puerto de embarque de la factura');
assert.strictEqual(nc.aduanaReferida.TotBultos, 65, 'NC hereda el total de bultos');
assert.strictEqual(nd.aduanaReferida.CodPtoDesemb, 242, 'ND sigue la cadena ND → NC → factura');
assert.strictEqual(ncPropia.aduanaReferida, undefined, 'una nota con embarque propio no hereda');
assert.strictEqual(factura.aduanaReferida, undefined, 'la factura no se toca');

const m = new MuestrasImpresas({ emisor: {}, siiOficina: 'X', resolucion: { numero: 0, fecha: '2026-01-01' } });
const filas = m._pdfFilasExportacion({ ...nc, esExportacion: true, totales: { TpoMoneda: 'DOLAR USA' } }).flat();
assert.ok(filas.some(([l, v]) => l === 'Puerto de Embarque' && v), 'la muestra de la NC imprime el puerto de embarque');
assert.ok(filas.some(([l, v]) => l === 'Total de Bultos' && v === '65'), 'la muestra de la NC imprime el total de bultos');
console.log('✓ muestra-exportacion-notas: 7 asserts');
