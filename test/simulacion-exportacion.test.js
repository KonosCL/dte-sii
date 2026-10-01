'use strict';

/**
 * Simulación de exportación: tres documentos "de la operación real" (factura de servicios, nota
 * de crédito y nota de débito de exportación) en un envío propio, sin la referencia al SET.
 *
 * Por qué existe: la página de simulación del SII exige que el envío "contenga todos los tipos de
 * documentos que está certificando", y la revisión de muestras impresas pide una muestra de
 * simulación de cada tipo. La simulación nacional no trae 110/111/112.
 *
 * Qué fija cada bloque:
 *  - Los casos: tipos y orden de emisión, cadena de referencias, montos y validaciones.
 *  - El documento: ninguna referencia al SET (si la tuviera, el SII lo tomaría como caso del set),
 *    IndServicio 3 en los tres, Aduana solo con el país en la factura y nada de transporte en las
 *    notas (exportación de servicios).
 *  - La firma y el timbre de los tres documentos, y que sus muestras salgan como simulación.
 *  - CertRunner: pide un folio de cada tipo sin reusar la precarga de los sets, y guarda el envío
 *    en debug/simulacion/.
 *
 * Datos sintéticos: RUT, razón social y certificado de prueba generados acá.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const forge = require('node-forge');
const { SignedXml } = require('xml-crypto');
const { DOMParser } = require('@xmldom/xmldom');
const xpath = require('xpath');

const SetExportacion = require('../cert/SetExportacion');
const CertFolioHelper = require('../cert/CertFolioHelper');
const CertRunner = require('../cert/CertRunner');
const MuestrasImpresas = require('../cert/MuestrasImpresas');
const EnviadorSII = require('../EnviadorSII');
const { EnvioDTE, Certificado } = require('../index');

const RUT = '76543210-3';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dte-sim-export-'));
const EMISOR = {
  rut: RUT, razon_social: 'EMPRESA EJEMPLO SPA', giro: 'SERVICIOS DE DISENO', acteco: '731001',
  direccion: 'AV EJEMPLO 123', comuna: 'SANTIAGO', ciudad: 'SANTIAGO',
};
const RECEPTOR_EXTRANJERO = { razon_social: 'CLIENTE EXTRANJERO EJEMPLO', giro: 'IMPORTADOR', direccion: 'CALLE EJEMPLO 100' };
const EXPORTACION = { tiposCambio: { 'DOLAR USA': 945.12 }, folioReferencia: '1' };

function pfxDePrueba() {
  const keys = forge.pki.rsa.generateKeyPair(1024);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date(Date.now() - 86400000);
  cert.validity.notAfter = new Date(Date.now() + 365 * 86400000);
  const attrs = [{ shortName: 'CN', value: 'PERSONA EJEMPLO' }, { type: '2.5.4.5', value: '11111111-1' }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  const p12 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], 'clave', { algorithm: '3des' });
  const file = path.join(TMP, 'prueba.pfx');
  fs.writeFileSync(file, Buffer.from(forge.asn1.toDer(p12).getBytes(), 'binary'));
  return { path: file, password: 'clave' };
}

function cafDePrueba(tipo) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 512,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'der' },
  });
  const jwk = crypto.createPublicKey({ key: publicKey, format: 'der', type: 'spki' }).export({ format: 'jwk' });
  const b64 = (s) => Buffer.from(s, 'base64url').toString('base64');
  const xml =
    `<?xml version="1.0"?><AUTORIZACION><CAF version="1.0"><DA><RE>${RUT}</RE><RS>EMPRESA EJEMPLO SPA</RS>` +
    `<TD>${tipo}</TD><RNG><D>1</D><H>10</H></RNG><FA>2026-09-30</FA><RSAPK><M>${b64(jwk.n)}</M><E>${b64(jwk.e)}</E></RSAPK>` +
    `<IDK>100</IDK></DA><FRMA algoritmo="SHA1withRSA">ZmlybWFkZXBydWViYQ==</FRMA></CAF><RSASK>${privateKey}</RSASK></AUTORIZACION>`;
  const file = path.join(TMP, `caf-${tipo}.xml`);
  fs.writeFileSync(file, xml);
  return file;
}

const CERT = pfxDePrueba();

function crearSet({ sinReferenciaSet = true, exportacion = EXPORTACION } = {}) {
  return new SetExportacion({
    key: 'simulacion-exportacion',
    sinReferenciaSet,
    config: { emisor: EMISOR, certificado: CERT, ambiente: 'certificacion', receptorExtranjero: RECEPTOR_EXTRANJERO, exportacion },
    folioHelper: new CertFolioHelper(),
    cafManager: { ensureCaf: async () => { throw new Error('sin red'); } },
    enviador: { enviar: async () => { throw new Error('sin red'); } },
    logger: { log() {}, error() {} },
  });
}

// ── Casos ─────────────────────────────────────────────────────────────────────

test('casos: factura, nota de crédito que la corrige y nota de débito que anula la nota', () => {
  const s = SetExportacion.casosSimulacion();
  assert.deepEqual(s.casos.map((c) => c.tipoDTE), [110, 112, 111]);
  assert.deepEqual(s.cafRequired, { 110: 1, 112: 1, 111: 1 }, 'un folio de cada tipo');
  const [f, nc, nd] = s.casos;
  assert.equal(nc.referenciaCaso, f.id);
  assert.equal(nc.codRef, 3);
  assert.equal(nd.referenciaCaso, nc.id);
  assert.equal(nd.codRef, 1);
  assert.equal(f.items[0].precio, 1000);
  assert.equal(nc.items[0].precio, 200, 'por defecto la nota corrige el 20%');
  assert.ok(!/^\d{7,8}-[\dK]$/.test(f.id), 'el id del caso no tiene forma de RUT');
});

test('casos: el monto con decimales se respeta y la nota no puede igualar ni superar la factura', () => {
  const s = SetExportacion.casosSimulacion({ monto: 1234.56 });
  assert.equal(s.casos[1].items[0].precio, 246.91);
  assert.throws(() => SetExportacion.casosSimulacion({ monto: 0 }), /monto inválido/);
  assert.throws(() => SetExportacion.casosSimulacion({ monto: 100, montoNotaCredito: 100 }), /menor que el de la factura/);
  assert.throws(() => SetExportacion.casosSimulacion({ monto: 100, montoNotaCredito: -1 }), /positivo/);
});

test('casos: la glosa se pasa a mayúsculas y se corta en el tope de NmbItem (80)', () => {
  const larga = 'servicio '.repeat(15);
  const s = SetExportacion.casosSimulacion({ item: larga });
  assert.equal(s.casos[0].items[0].nombre.length, 80);
  assert.equal(s.casos[0].items[0].nombre, larga.trim().toUpperCase().slice(0, 80));
});

// ── Documento ─────────────────────────────────────────────────────────────────

test('plan: ningún documento referencia al SET; las notas encadenan factura → NC → ND', () => {
  const plan = crearSet().planificar(SetExportacion.casosSimulacion());
  for (const p of plan) {
    assert.ok(!p.datos.Referencia.some((r) => r.TpoDocRef === 'SET'), `${p.tipoDte} sin referencia al SET`);
    assert.equal(p.datos.Referencia[0].NroLinRef, 1, 'las líneas de referencia parten en 1');
    assert.equal(p.datos.Referencia[0].TpoDocRef, 812, 'las tres citan la Resolución SNA');
    assert.equal(p.datos.Encabezado.IdDoc.IndServicio, 3, 'exportación de servicios');
  }
  const [f, nc, nd] = plan.map((p) => p.datos);
  assert.deepEqual(f.Referencia, [{ NroLinRef: 1, TpoDocRef: 812, FolioRef: '1', FchRef: f.Encabezado.IdDoc.FchEmis }]);
  // REF-2-826: las notas de servicios también citan la Resolución SNA.
  assert.deepEqual(nc.Referencia, [
    { NroLinRef: 1, TpoDocRef: 812, FolioRef: '1', FchRef: nc.Encabezado.IdDoc.FchEmis },
    { NroLinRef: 2, TpoDocRef: 110, FolioRef: f.Encabezado.IdDoc.Folio, FchRef: f.Encabezado.IdDoc.FchEmis, CodRef: 3, RazonRef: 'CORRIGE MONTO' },
  ]);
  assert.equal(nd.Referencia[0].TpoDocRef, 812);
  assert.equal(nd.Referencia[1].TpoDocRef, 112);
  assert.equal(nd.Referencia[1].CodRef, 1);
  assert.deepEqual([f, nc, nd].map((d) => d.Encabezado.Totales.MntTotal), [1000, 200, 200]);
  assert.deepEqual([f, nc, nd].map((d) => d.Encabezado.OtraMoneda.MntTotOtrMnda), [945120, 189024, 189024]);
});

test('plan: Aduana de la factura solo con el país; las notas sin transporte; receptor extranjero', () => {
  const plan = crearSet().planificar(SetExportacion.casosSimulacion());
  const [f, nc, nd] = plan.map((p) => p.datos.Encabezado);
  assert.deepEqual(f.Transporte, { Aduana: { CodPaisRecep: 563, CodPaisDestin: 563 } });
  assert.equal(f.IdDoc.FmaPagExp, 11, 'ACRED');
  assert.equal(nc.Transporte, undefined);
  assert.equal(nd.Transporte, undefined);
  for (const e of [f, nc, nd]) {
    assert.equal(e.Receptor.RUTRecep, '55555555-5');
    assert.equal(e.Receptor.Extranjero.Nacionalidad, 563);
  }
});

test('contraste: el mismo caso emitido como set sí lleva la referencia al SET primero', () => {
  const plan = crearSet({ sinReferenciaSet: false }).planificar(SetExportacion.casosSimulacion());
  assert.equal(plan[0].datos.Referencia[0].TpoDocRef, 'SET');
  assert.equal(plan[0].datos.Referencia[1].TpoDocRef, 812);
});

test('sin tipo de cambio de la moneda no se emite', () => {
  assert.throws(() => crearSet({ exportacion: { folioReferencia: '1' } }).planificar(SetExportacion.casosSimulacion()), /tipo de cambio de DOLAR USA/);
});

test('generación: firma y timbre verificados, y las muestras salen como simulación', async () => {
  const set = crearSet();
  const cafs = { 110: cafDePrueba(110), 111: cafDePrueba(111), 112: cafDePrueba(112) };
  const dtes = await set.generarDtes(SetExportacion.casosSimulacion(), cafs);
  assert.deepEqual(dtes.map((d) => d.getTipoDTE()), [110, 112, 111]);

  for (const dte of dtes) {
    const xml = dte.getXML();
    assert.ok(!xml.includes('<TpoDocRef>SET</TpoDocRef>'), `${dte.getId()} sin referencia al SET`);
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    const firma = xpath.select("//*[local-name(.)='Signature']", doc)[0];
    const certB64 = xpath.select("string(.//*[local-name(.)='X509Certificate'])", firma).replace(/\s+/g, '');
    const pem = `-----BEGIN CERTIFICATE-----\n${certB64.match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----\n`;
    const sig = new SignedXml({ publicCert: pem });
    sig.loadSignature(firma);
    assert.ok(sig.checkSignature(xml), `firma XMLDSig de ${dte.getId()}`);
    const dd = xml.match(/<DD>[\s\S]*?<\/DD>/)[0];
    const frmt = xml.match(/<FRMT algoritmo="SHA1withRSA">([^<]+)<\/FRMT>/)[1];
    const [, m, e] = dd.match(/<RSAPK><M>([^<]+)<\/M><E>([^<]+)<\/E><\/RSAPK>/);
    const pub = crypto.createPublicKey({ format: 'jwk', key: { kty: 'RSA', n: Buffer.from(m, 'base64').toString('base64url'), e: Buffer.from(e, 'base64').toString('base64url') } });
    assert.ok(crypto.verify('sha1', Buffer.from(dd, 'latin1'), pub, Buffer.from(frmt, 'base64')), `FRMT de ${dte.getId()}`);
  }

  const cert = new Certificado(fs.readFileSync(CERT.path), CERT.password);
  const envio = new EnvioDTE({ certificado: cert });
  dtes.forEach((d) => envio.agregar(d));
  envio.setCaratula({ RutEmisor: RUT, RutEnvia: '11111111-1', RutReceptor: '60803000-K', FchResol: '2026-09-01', NroResol: 0, SetDTEId: 'DTE_SetDoc' });
  envio.generar();
  const dir = path.join(TMP, 'debug', 'simulacion');
  fs.mkdirSync(dir, { recursive: true });
  const archivo = path.join(dir, 'envio-simulacion-exportacion.xml');
  fs.writeFileSync(archivo, envio.xml);

  assert.ok(MuestrasImpresas.buscarXmls(path.join(TMP, 'debug')).includes(archivo), 'buscarXmls encuentra el envío');
  const muestras = new MuestrasImpresas({ emisor: { rut: RUT, razonSocial: 'EMPRESA EJEMPLO SPA' } });
  const out = path.join(TMP, 'muestras');
  const r = await muestras.generarMuestras({ xmlFiles: [archivo], outDir: out, generarCedible: true });
  assert.deepEqual(r.errores, []);
  assert.equal(r.setSimulacion, 3, 'van como simulación, no como set de pruebas');
  assert.equal(r.setPruebas, 0);
  assert.deepEqual(fs.readdirSync(path.join(out, 'SET-SIMULACION')).sort(),
    ['muestra_110_1.pdf', 'muestra_111_1.pdf', 'muestra_112_1.pdf'], 'exportación no lleva cedible');
});

// ── CertRunner ────────────────────────────────────────────────────────────────

test('CertRunner: un folio de cada tipo, sin la precarga de los sets, y el envío en debug/simulacion', async () => {
  const runner = Object.create(CertRunner.prototype);
  runner.config = { exportacion: { simulacion: { item: 'DISENO WEB', monto: 500 } } };
  const precarga = { 110: '/ruta/caf-110-del-set.xml' };
  runner._cafsPrecargados = precarga;
  const llamadas = [];
  runner._createEnviador = (nombre, opciones) => ({ nombre, opciones });
  runner._ejecutarSet = async (...args) => {
    llamadas.push({ args, precargaDurante: runner._cafsPrecargados });
    return { success: true, trackId: '123' };
  };

  const r = await runner.ejecutarSimulacionExportacion();
  assert.equal(r.trackId, '123');
  assert.equal(llamadas.length, 1);
  const [Clase, estructuraKey, resultadoKey, cafRequired, enviadorNombre, casos, deps] = llamadas[0].args;
  assert.equal(Clase, SetExportacion);
  assert.equal(estructuraKey, null);
  assert.equal(resultadoKey, 'simulacionExportacion');
  assert.deepEqual(cafRequired, { 110: 1, 112: 1, 111: 1 });
  assert.equal(enviadorNombre, null);
  assert.equal(casos.casos[0].items[0].nombre, 'DISENO WEB', 'toma config.exportacion.simulacion');
  assert.equal(casos.casos[0].items[0].precio, 500);
  assert.equal(deps.sinReferenciaSet, true);
  assert.deepEqual(deps.enviador.opciones, { archivo: path.join('simulacion', 'envio-simulacion-exportacion.xml') });
  assert.equal(llamadas[0].precargaDurante, null, 'no reusa los CAF que precargaron los sets');
  assert.equal(runner._cafsPrecargados, precarga, 'la precarga vuelve a quedar como estaba');
});

test('CertRunner: _createEnviador con { archivo } guarda el envío y sus DTE ahí', async () => {
  const runner = Object.create(CertRunner.prototype);
  // `certificado` es un getter de CertRunner (carga el .pfx de la config): acá basta un objeto.
  Object.defineProperty(runner, 'certificado', { value: { rut: '11111111-1' } });
  Object.defineProperty(runner, 'ambiente', { value: 'certificacion', configurable: true });
  runner.debugDir = path.join(TMP, 'debug-enviador');
  const original = EnviadorSII.prototype.enviarDteSoap;
  EnviadorSII.prototype.enviarDteSoap = async () => ({ trackId: '987' });
  try {
    const enviador = runner._createEnviador('simulacion-exportacion', { archivo: path.join('simulacion', 'envio-simulacion-exportacion.xml') });
    const r = await enviador.enviar({ xml: '<EnvioDTE/>', dtes: [{ tipoDte: 110, folio: 7, xml: '<DTE/>' }] });
    assert.equal(r.trackId, '987');
  } finally {
    EnviadorSII.prototype.enviarDteSoap = original;
  }
  assert.equal(fs.readFileSync(path.join(TMP, 'debug-enviador', 'simulacion', 'envio-simulacion-exportacion.xml'), 'utf8'), '<EnvioDTE/>');
  assert.ok(fs.existsSync(path.join(TMP, 'debug-enviador', 'simulacion', 'dtes', 'dte-110-000007.xml')));
  assert.ok(!fs.existsSync(path.join(TMP, 'debug-enviador', 'sets-prueba')), 'no escribe en sets-prueba');
});
