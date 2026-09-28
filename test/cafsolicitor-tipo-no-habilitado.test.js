'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { CafSolicitor } = require('../index.js');

// Estructura sintética del <SELECT name=COD_DOCTO> de of_solicita_folios_dcto.
// El patrón real ("SIN DOCUMENTOS", value="-1") se verificó 2026-09-28 contra un
// caso de producción (RUT 76579006-9, tipo 39), sin copiar HTML literal — ver
// CLAUDE.md: este repo es público, los fixtures son inventados.
function paginaSelectorTipos(opciones) {
  const options = opciones
    .map(({ value, texto }) => `<option value="${value}">${texto}</option>`)
    .join('\n');
  return `
    <html><body>
      <form action="/cvc_cgi/dte/of_confirma_folio" method="post">
        <SELECT name = COD_DOCTO onChange="changeRegregion('/cvc_cgi/dte/');" >
          ${options}
        </SELECT>
      </form>
    </body></html>
  `;
}

test('_selectOfreceTipo: false cuando el único option es SIN DOCUMENTOS (nada habilitado)', () => {
  const html = paginaSelectorTipos([{ value: '-1', texto: 'SIN DOCUMENTOS' }]);
  assert.equal(CafSolicitor._selectOfreceTipo(html, 39), false);
  assert.equal(CafSolicitor._selectOfreceTipo(html, 33), false);
});

test('_selectOfreceTipo: true cuando el tipo pedido está entre las opciones', () => {
  const html = paginaSelectorTipos([
    { value: '39', texto: 'BOLETA ELECTRONICA' },
    { value: '33', texto: 'FACTURA ELECTRONICA' },
  ]);
  assert.equal(CafSolicitor._selectOfreceTipo(html, 39), true);
  assert.equal(CafSolicitor._selectOfreceTipo(html, 33), true);
});

test('_selectOfreceTipo: false cuando hay opciones pero no la del tipo pedido', () => {
  const html = paginaSelectorTipos([{ value: '33', texto: 'FACTURA ELECTRONICA' }]);
  assert.equal(CafSolicitor._selectOfreceTipo(html, 39), false);
});

test('_selectOfreceTipo: true (no bloquea) si no hay ningún <select> COD_DOCTO que inspeccionar', () => {
  const html = '<html><body>Página sin selector de tipo de documento.</body></html>';
  assert.equal(CafSolicitor._selectOfreceTipo(html, 39), true);
});
