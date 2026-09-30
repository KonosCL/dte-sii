'use strict';

/**
 * Largo de línea del XML.
 *
 * El SII rechaza con RSC ("CHR-00002: Line too long (4090)") todo XML con una línea de más de
 * ~4090 caracteres. El DTE se armaba sin ningún salto de línea, así que una boleta de 6 o 7
 * líneas de detalle ya lo superaba (el SII permite hasta 60). Verificado en maullin: 10 líneas
 * RSC, 5 aceptada; con un salto entre detalles, 7, 10, 40 líneas de boleta y 12 de factura
 * aceptadas.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { DOMParser } = require('@xmldom/xmldom');
const DTE = require('../DTE');

const LIMITE = 4090;
const EMISOR = { RUTEmisor: '76543210-K', RznSoc: 'EMPRESA EJEMPLO SPA', GiroEmis: 'Comercio', DirOrigen: 'Calle Falsa 123', CmnaOrigen: 'Santiago' };
const RECEPTOR = { RUTRecep: '77111222-3', RznSocRecep: 'CLIENTE EJEMPLO SPA', GiroRecep: 'Comercio', DirRecep: 'Calle 1', CmnaRecep: 'Santiago' };
// Un timbre de largo realista (el real trae el CAF y una firma en base64).
const TED = `<TED version="1.0"><DD>${'x'.repeat(900)}</DD><FRMT algoritmo="SHA1withRSA">${'y'.repeat(120)}</FRMT></TED>`;

function armar(tipo, nLineas, extra = {}) {
  const items = Array.from({ length: nLineas }, (_, i) => ({
    NmbItem: `Producto de nombre largo numero ${i + 1} (con detalle adicional del producto)`,
    QtyItem: 1,
    PrcItem: 1000 + i,
  }));
  const dte = new DTE({ tipo, folio: 1, fechaEmision: '2026-09-26', emisor: EMISOR, receptor: tipo === 39 ? undefined : RECEPTOR, items, precioConIva: true, ...extra });
  dte.generarXML();
  dte.tedXml = TED;
  dte.tmstFirma = '2026-09-26T12:00:00';
  return dte;
}
const lineas = (xml) => xml.split('\n');
const masLarga = (xml) => Math.max(...lineas(xml).map((l) => l.length));

test('una boleta de 60 líneas de detalle no tiene ninguna línea sobre el límite del SII', () => {
  const xml = armar(39, 60)._buildXmlSinFirma();
  assert.ok(xml.replace(/\n/g, '').length > LIMITE * 3, 'el documento completo sí es mucho más largo que el límite');
  assert.ok(masLarga(xml) < LIMITE, `línea más larga: ${masLarga(xml)}`);
});

test('el largo de una línea no crece con la cantidad de detalles', () => {
  const largo = (n) => masLarga(armar(39, n)._buildXmlSinFirma());
  assert.ok(Math.abs(largo(60) - largo(7)) < 200, `${largo(7)} vs ${largo(60)}`);
});

test('factura con 60 detalles y varias referencias', () => {
  const referencias = Array.from({ length: 10 }, (_, i) => ({ NroLinRef: i + 1, TpoDocRef: 801, FolioRef: String(1000 + i), FchRef: '2026-09-01', RazonRef: 'Orden de compra con un texto de razón' }));
  const xml = armar(33, 60, { referencias })._buildXmlSinFirma();
  assert.ok(masLarga(xml) < LIMITE, `línea más larga: ${masLarga(xml)}`);
});

test('cada detalle queda en su propia línea y el timbre también', () => {
  const xml = armar(39, 8)._buildXmlSinFirma();
  const conDetalle = lineas(xml).filter((l) => l.includes('<Detalle>'));
  assert.equal(conDetalle.length, 8);
  for (const l of conDetalle) assert.equal((l.match(/<Detalle>/g) || []).length, 1);
  assert.ok(lineas(xml).some((l) => l.startsWith('<TED')), 'el timbre empieza su propia línea');
});

test('los saltos quedan dentro del <Documento> y el digest los cubre (C14N)', () => {
  const dte = armar(39, 3);
  const doc = new DOMParser().parseFromString(dte._buildXmlSinFirma(), 'application/xml');
  const c14n = dte._c14nDocumento(doc);
  assert.match(c14n, /<\/Detalle>\n<Detalle>/);
});

test('el XML sigue siendo válido y conserva todos los detalles', () => {
  const xml = armar(39, 25)._buildXmlSinFirma();
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  assert.equal(doc.getElementsByTagName('Detalle').length, 25);
  assert.equal(doc.getElementsByTagName('TED').length, 1);
  assert.equal(doc.getElementsByTagName('Encabezado').length, 1);
});

test('un documento chico no cambia de contenido, solo gana saltos entre secciones', () => {
  const xml = armar(39, 1)._buildXmlSinFirma();
  assert.equal(xml.replace(/\n/g, ''), armar(39, 1)._buildXmlSinFirma().replace(/\n/g, ''));
  assert.ok(xml.includes('</Encabezado>\n<Detalle>'));
});
