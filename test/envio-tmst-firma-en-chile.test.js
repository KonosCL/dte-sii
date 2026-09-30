'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { timestampChile } = require('../utils/fecha-chile');
const { EnvioBOLETA, EnvioDTE } = require('../Envio');

// `new Date().toISOString()` siempre devuelve UTC, aunque el proceso tenga TZ=America/Santiago — a
// diferencia de getDate()/getMonth(), .toISOString() no consulta esa variable. Chile SÍ tiene cambio
// de hora estacional (UTC-3 en verano, UTC-4 en invierno, según la base IANA vigente — por eso se usa
// Intl.DateTimeFormat y no un offset fijo), así que un TmstFirmaEnv armado con .toISOString() queda
// varias horas adelantado y el SII lo rechaza con "Error en Carátula" (caso real: 100% de las
// facturas de un consumidor rechazadas, ver CLAUDE.md "Bug conocido"). Estos tests fijan un instante
// conocido para no depender del reloj real ni de en qué mes corra la suite.

test('timestampChile: un instante UTC en invierno de Chile (UTC-4) queda 4 horas atrás', () => {
  const d = new Date('2026-06-15T12:00:00.000Z');
  assert.equal(timestampChile(d), '2026-06-15T08:00:00');
});

test('timestampChile: un instante UTC en verano de Chile (UTC-3) queda 3 horas atrás', () => {
  const d = new Date('2026-01-15T12:00:00.000Z');
  assert.equal(timestampChile(d), '2026-01-15T09:00:00');
});

test('timestampChile: cruza la medianoche de Chile (UTC ya es el día siguiente)', () => {
  // 2026-06-16T02:00:00Z = 2026-06-15T22:00:00 hora Chile (invierno, UTC-4) — si se usara UTC crudo,
  // la fecha quedaría un día adelantada (el mismo bug que fechaHoyChile() ya evita para FchEmis).
  const d = new Date('2026-06-16T02:00:00.000Z');
  assert.equal(timestampChile(d), '2026-06-15T22:00:00');
});

function certificadoFalso() {
  return { rut: '76543210-K' };
}

test('EnvioBOLETA.setCaratula: sin TmstFirmaEnv explícito, usa hora de Chile (no UTC)', () => {
  const envio = new EnvioBOLETA({ certificado: certificadoFalso() });
  envio.dtes = [{ datos: { Encabezado: { IdDoc: { TipoDTE: 39 } } } }]; // para _getSubTotDTE
  envio.setCaratula({ RutEmisor: '76543210-K', RutEnvia: '76543210-K', FchResol: '22-08-2014', NroResol: 80 });
  // El timestamp generado nunca debe terminar en "Z" ni traer milisegundos (formato TmstFirmaEnv del SII),
  // y debe coincidir con lo que devuelve nuestra propia utilidad para "ahora" (con margen de un segundo).
  assert.doesNotMatch(envio.caratula.TmstFirmaEnv, /Z|\./);
  const esperadoAprox = timestampChile();
  assert.equal(envio.caratula.TmstFirmaEnv.slice(0, 16), esperadoAprox.slice(0, 16)); // mismo minuto
});

test('EnvioDTE.setCaratula: respeta un TmstFirmaEnv explícito (antes lo ignoraba siempre)', () => {
  const envio = new EnvioDTE({ certificado: certificadoFalso() });
  envio.dtes = [{ datos: { Encabezado: { IdDoc: { TipoDTE: 33 } } } }];
  envio.setCaratula({
    RutEmisor: '76543210-K', RutEnvia: '76543210-K', RutReceptor: '11111111-1',
    FchResol: '2014-08-22', NroResol: 80, TmstFirmaEnv: '2026-01-01T00:00:00',
  });
  assert.equal(envio.caratula.TmstFirmaEnv, '2026-01-01T00:00:00');
});

test('EnvioDTE.setCaratula: sin TmstFirmaEnv explícito, genera hora de Chile (no UTC)', () => {
  const envio = new EnvioDTE({ certificado: certificadoFalso() });
  envio.dtes = [{ datos: { Encabezado: { IdDoc: { TipoDTE: 33 } } } }];
  envio.setCaratula({ RutEmisor: '76543210-K', RutEnvia: '76543210-K', RutReceptor: '11111111-1', FchResol: '2014-08-22', NroResol: 80 });
  assert.doesNotMatch(envio.caratula.TmstFirmaEnv, /Z|\./);
  assert.equal(envio.caratula.TmstFirmaEnv.slice(0, 16), timestampChile().slice(0, 16));
});
