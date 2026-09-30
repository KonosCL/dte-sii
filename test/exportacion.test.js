'use strict';

/**
 * Documentos de exportación (110, 111, 112) de punta a punta, sin red ni SII: texto de un set
 * → SetParser → SetExportacion → DTE timbrado y firmado → sobre → muestra impresa.
 *
 * Qué fija cada bloque:
 *  - El parser: la cláusula y el país salían mal ("EXPORTACION: FOB", "PAIS DESTINO: X"), los
 *    precios perdían los decimales, y un set sin "(1)" en el nombre se descartaba entero.
 *  - El documento: va dentro de <Exportaciones> (DTE_v10.xsd), con el receptor extranjero,
 *    Aduana en el orden del esquema, Totales en la moneda del set y OtraMoneda en pesos.
 *  - Las firmas: el XMLDSig del documento se verifica con xml-crypto (otra implementación) y el
 *    FRMT del timbre con la llave pública del CAF, y MNT del timbre es igual a MntTotal.
 *  - Lo que no se inventa: sin tipo de cambio lanza; un texto que la tabla de Aduana no
 *    resuelve o que resuelve a dos códigos lanza.
 *
 * El set es sintético (los números de atención tienen 6 dígitos a propósito, para que no
 * parezcan RUT). La validación contra el XSD del SII se hizo aparte con xmllint (no está en
 * el repo): ver el PR.
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

const SetParser = require('../cert/SetParser');
const SetExportacion = require('../cert/SetExportacion');
const CertFolioHelper = require('../cert/CertFolioHelper');
const MuestrasImpresas = require('../cert/MuestrasImpresas');
const SiiCertificacion = require('../SiiCertificacion');
const { DTE, EnvioDTE, Certificado } = require('../index');
const { resolverCodigo, resolverMoneda } = require('../utils/aduana');

const RUT = '76543210-3';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dte-export-'));

const SET = [
  'SET DOCUMENTOS DE EXPORTACION - NUMERO DE ATENCION: 990001',
  '',
  'CASO 990001-1',
  '==============',
  'DOCUMENTO\tFACTURA DE EXPORTACION ELECTRONICA',
  '',
  'ITEM\tCANTIDAD\tUNIDAD MEDIDA\tPRECIO UNITARIO',
  'CHATARRA DE ALUMINIO\t195\tKN\t12.35',
  'PLANCHAS DE COBRE\t40\tKN\t8,5',
  '',
  'MONEDA DE LA OPERACION: DOLAR USA',
  'FORMA DE PAGO EXPORTACION: COB1',
  'MODALIDAD DE VENTA: A FIRME',
  'CLAUSULA DE VENTA DE EXPORTACION: FOB',
  'TOTAL CLAUSULA DE VENTA: 2748.25',
  'VIA DE TRANSPORTE: MARITIMA, FLUVIAL Y LACUSTRE',
  'PUERTO DE EMBARQUE: SAN ANTONIO',
  'PUERTO DE DESEMBARQUE: BUENOS AIRES',
  'TIPO DE BULTO: CONTENEDOR REFRIGERADO',
  'TOTAL BULTOS: 1',
  'PAIS RECEPTOR Y PAIS DESTINO: ARGENTINA',
  '',
  'CASO 990001-2',
  '==============',
  'DOCUMENTO\tFACTURA DE EXPORTACION ELECTRONICA',
  '',
  'ITEM\tCANTIDAD\tUNIDAD MEDIDA\tPRECIO UNITARIO',
  'CAJAS DE UVA DE MESA\t500\tU\t14',
  '',
  'MONEDA DE LA OPERACION: DOLAR USA',
  'FORMA DE PAGO EXPORTACION: ANTICIPO',
  'MODALIDAD DE VENTA: BAJO CONDICION',
  'CLAUSULA DE VENTA DE EXPORTACION: CIF',
  'TOTAL CLAUSULA DE VENTA: 7700',
  'VIA DE TRANSPORTE: AEREO',
  'PUERTO DE EMBARQUE: AEROP.A.M.BENITEZ',
  'PUERTO DE DESEMBARQUE: MIAMI',
  'TIPO DE BULTO: PALLETS',
  'TOTAL BULTOS: 20',
  'FLETE (**): 180.5',
  'SEGURO (**): 19.5',
  'COMISIONES EN EL EXTRANJERO (RECARGOS DEL 10% SOBRE EL TOTAL)',
  'PAIS RECEPTOR Y PAIS DESTINO: ESTADOS UNIDOS',
  '',
  'CASO 990001-3',
  '==============',
  'DOCUMENTO\tNOTA DE CREDITO DE EXPORTACION ELECTRONICA',
  'REFERENCIA: FACTURA DE EXPORTACION ELECTRONICA CORRESPONDIENTE A CASO 990001-1',
  'RAZON REFERENCIA\tDEVOLUCION DE MERCADERIAS',
  '',
  'ITEM\tCANTIDAD',
  'CHATARRA DE ALUMINIO\t15',
  '',
  'CASO 990001-4',
  '==============',
  'DOCUMENTO\tNOTA DE DEBITO DE EXPORTACION ELECTRONICA',
  'REFERENCIA: NOTA DE CREDITO DE EXPORTACION ELECTRONICA CORRESPONDIENTE A CASO 990001-3',
  'RAZON REFERENCIA\tANULA NOTA DE CREDITO DE EXPORTACION ELECTRONICA',
  '',
  'SET DOCUMENTOS DE EXPORTACION(2) - NUMERO DE ATENCION: 990002',
  '',
  'CASO 990002-1',
  '==============',
  'DOCUMENTO\tFACTURA DE EXPORTACION ELECTRONICA',
  '',
  'ITEM\tCANTIDAD\tUNIDAD MEDIDA\tPRECIO UNITARIO',
  'VINO TINTO RESERVA\t1200\tU\t6,75',
  '',
  'MONEDA DE LA OPERACION: EURO',
  'FORMA DE PAGO EXPORTACION: ACRED',
  'CLAUSULA DE VENTA DE EXPORTACION: FOB',
  'TOTAL CLAUSULA DE VENTA: 8100',
  'VIA DE TRANSPORTE: MARITIMA, FLUVIAL Y LACUSTRE',
  'PUERTO DE EMBARQUE: VALPARAISO',
  'PUERTO DE DESEMBARQUE: ROTTERDAM',
  'TIPO DE BULTO: CAJA DE CARTON',
  'TOTAL BULTOS: 100',
  'PAIS RECEPTOR Y PAIS DESTINO: HOLANDA',
  'LINEA QUE NINGUN PATRON CONOCE',
].join('\n');

const TIPOS_CAMBIO = { 'DOLAR USA': 945.12, EURO: 1050.37 };
const EMISOR = {
  rut: RUT, razon_social: 'EMPRESA EJEMPLO SPA', giro: 'EXPORTACION DE PRODUCTOS', acteco: '469000',
  direccion: 'AV EJEMPLO 123', comuna: 'SANTIAGO', ciudad: 'SANTIAGO',
};
const RECEPTOR_EXTRANJERO = { razon_social: 'CLIENTE EXTRANJERO EJEMPLO', giro: 'IMPORTADOR', direccion: 'CALLE EJEMPLO 100', ciudad: 'CIUDAD EXTRANJERA' };

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

// CAF con llave RSA real: el timbre se firma con ella y la prueba lo verifica con la pública.
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

function crearSet(key, certificado, exportacion = { tiposCambio: TIPOS_CAMBIO }) {
  return new SetExportacion({
    key,
    config: { emisor: EMISOR, certificado, ambiente: 'certificacion', receptorExtranjero: RECEPTOR_EXTRANJERO, exportacion },
    folioHelper: new CertFolioHelper(),
    cafManager: { ensureCaf: async () => { throw new Error('sin red'); } },
    enviador: { enviar: async () => { throw new Error('sin red'); } },
    logger: { log() {}, error() {} },
  });
}

const estructuras = SetParser.generarEstructurasParaScripts(SetParser.extraerCasosDelSet(SET));
const CERT = pfxDePrueba();

// ── Parser ────────────────────────────────────────────────────────────────────

test('parser: los dos sets de exportación, aunque el primero no diga "(1)"', () => {
  assert.equal(estructuras.setExportacion1?.numeroAtencion, '990001');
  assert.equal(estructuras.setExportacion2?.numeroAtencion, '990002');
  assert.deepEqual(estructuras.setExportacion1.cafRequired, { 110: 2, 111: 1, 112: 1 });
  // Un tipo sin casos no pide folios: 0 en el plan se timbraba igual.
  assert.deepEqual(estructuras.setExportacion2.cafRequired, { 110: 1 });
});

test('parser: cláusula y país completos, precios con decimales (punto o coma)', () => {
  const [c1, c2] = estructuras.setExportacion1.casos;
  assert.equal(c1.clausulaVenta, 'FOB');
  assert.equal(c1.paisDestino, 'ARGENTINA');
  assert.deepEqual(c1.items.map((i) => i.precio), [12.35, 8.5]);
  assert.equal(c1.totalClausula, 2748.25);
  assert.equal(c2.flete, 180.5);
  assert.equal(c2.comisionExtranjero, 10);
  assert.match(c2.comisionTexto, /RECARGO/);
  assert.equal(estructuras.setExportacion2.casos[0].items[0].precio, 6.75);
});

test('parser: notas con su caso referenciado y código de referencia', () => {
  const [, , nc, nd] = estructuras.setExportacion1.casos;
  assert.equal(nc.tipoDTE, 112);
  assert.equal(nc.referenciaCaso, '990001-1');
  assert.equal(nc.codRef, 3);
  assert.equal(nd.tipoDTE, 111);
  assert.equal(nd.referenciaCaso, '990001-3');
  assert.equal(nd.codRef, 1);
});

test('parser: una línea que ningún patrón reconoce queda anotada, no se pierde', () => {
  assert.deepEqual(estructuras.setExportacion2.casos[0].noInterpretadas, ['LINEA QUE NINGUN PATRON CONOCE']);
  assert.deepEqual(estructuras.setExportacion1.casos[0].noInterpretadas, []);
});

// ── Documento ─────────────────────────────────────────────────────────────────

test('plan: totales en la moneda del set, OtraMoneda en pesos y Aduana con los códigos', () => {
  const plan = crearSet('exportacion1', CERT).planificar(estructuras.setExportacion1);
  const f1 = plan[0].datos.Encabezado;
  assert.deepEqual(f1.Totales, { TpoMoneda: 'DOLAR USA', MntExe: 2748.25, MntTotal: 2748.25 });
  assert.deepEqual(f1.OtraMoneda, { TpoMoneda: 'PESO CL', TpoCambio: 945.12, MntExeOtrMnda: 2597426.04, MntTotOtrMnda: 2597426.04 });
  assert.equal(f1.Receptor.RUTRecep, '55555555-5');
  assert.equal(f1.Receptor.Extranjero.Nacionalidad, 224);
  assert.equal(f1.Receptor.CmnaRecep, undefined);
  assert.deepEqual(f1.Transporte.Aduana, {
    CodModVenta: 1, CodClauVenta: 5, TotClauVenta: 2748.25, CodViaTransp: 1, CodPtoEmbarque: 906, CodPtoDesemb: 262,
    TotBultos: 1, TipoBultos: [{ CodTpoBultos: 75, CantBultos: 1 }], CodPaisRecep: 224, CodPaisDestin: 224,
  });
  assert.deepEqual(Object.keys(f1.Transporte.Aduana), [
    'CodModVenta', 'CodClauVenta', 'TotClauVenta', 'CodViaTransp', 'CodPtoEmbarque', 'CodPtoDesemb',
    'TotBultos', 'TipoBultos', 'CodPaisRecep', 'CodPaisDestin',
  ], 'orden del XSD');
  assert.equal(f1.IdDoc.FmaPagExp, 1);
  assert.ok(plan[0].avisos.some((a) => /contenedor/i.test(a)), 'avisa que el set no trae número de contenedor');

  // Anticipo obliga FchCancel; la comisión va como recargo global exento.
  const f2 = plan[1];
  assert.equal(f2.datos.Encabezado.IdDoc.FmaPagExp, 32);
  assert.equal(f2.datos.Encabezado.IdDoc.FchCancel, f2.datos.Encabezado.IdDoc.FchEmis);
  // Flete y seguro van también como recargos globales en $ ("(**)" del set) y suman al total.
  assert.deepEqual(f2.datos.DscRcgGlobal, [
    { NroLinDR: 1, TpoMov: 'R', GlosaDR: 'COMISIONES EN EL EXTRANJERO', TpoValor: '%', ValorDR: 10, IndExeDR: 1 },
    { NroLinDR: 2, TpoMov: 'R', GlosaDR: 'FLETE', TpoValor: '$', ValorDR: 180.5, IndExeDR: 1 },
    { NroLinDR: 3, TpoMov: 'R', GlosaDR: 'SEGURO', TpoValor: '$', ValorDR: 19.5, IndExeDR: 1 },
  ]);
  assert.equal(f2.datos.Encabezado.Totales.MntTotal, 7900);
  assert.equal(f2.datos.Encabezado.Transporte.Aduana.MntFlete, 180.5);
  assert.equal(f2.datos.Encabezado.Transporte.Aduana.CodPtoEmbarque, 992);
  assert.equal(f2.datos.Encabezado.Transporte.Aduana.CodPaisRecep, 225);
});

test('plan: la NC por devolución toma el precio de la factura y la ND que anula copia la NC', () => {
  const plan = crearSet('exportacion1', CERT).planificar(estructuras.setExportacion1);
  const nc = plan.find((p) => p.tipoDte === 112).datos;
  const nd = plan.find((p) => p.tipoDte === 111).datos;
  assert.deepEqual(nc.Detalle.map((d) => [d.NmbItem, d.QtyItem, d.PrcItem, d.MontoItem]), [['CHATARRA DE ALUMINIO', 15, 12.35, 185.25]]);
  assert.equal(nc.Encabezado.Totales.MntTotal, 185.25);
  assert.deepEqual(nc.Referencia[1], { NroLinRef: 2, TpoDocRef: 110, FolioRef: 1, FchRef: nc.Encabezado.IdDoc.FchEmis, CodRef: 3, RazonRef: 'DEVOLUCION DE MERCADERIAS' });
  assert.equal(nc.Encabezado.Transporte, undefined, 'la nota no inventa datos de transporte');
  assert.deepEqual(nd.Detalle, nc.Detalle);
  assert.equal(nd.Referencia[1].TpoDocRef, 112);
  assert.equal(nd.Referencia[1].CodRef, 1);
});

test('sin tipo de cambio no se emite: el SII exige OtraMoneda y no se inventa uno', () => {
  const set = crearSet('exportacion1', CERT, {});
  assert.throws(() => set.planificar(estructuras.setExportacion1), /tipo de cambio de DOLAR USA/);
});

test('un caso con tipo de cambio propio manda sobre la configuración', () => {
  const copia = JSON.parse(JSON.stringify(estructuras.setExportacion2));
  copia.casos[0].tipoCambio = 1000;
  const plan = crearSet('exportacion2', CERT).planificar(copia);
  assert.equal(plan[0].datos.Encabezado.OtraMoneda.TpoCambio, 1000);
  assert.equal(plan[0].datos.Encabezado.OtraMoneda.MntTotOtrMnda, 8100000);
});

test('generación: <Exportaciones>, firma del documento, timbre y MNT verificados', async () => {
  const set = crearSet('exportacion1', CERT);
  const cafs = { 110: cafDePrueba(110), 111: cafDePrueba(111), 112: cafDePrueba(112) };
  const dtes = await set.generarDtes(estructuras.setExportacion1, cafs);
  assert.deepEqual(dtes.map((d) => d.getTipoDTE()), [110, 110, 112, 111]);

  for (const dte of dtes) {
    const xml = dte.getXML();
    assert.match(xml, /<DTE [^>]*><Exportaciones ID="DTE_T11\dF\d+">/);
    assert.ok(!xml.includes('<Documento'), 'un documento de exportación no lleva <Documento>');

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
    const mnt = dd.match(/<MNT>([^<]+)<\/MNT>/)[1];
    const total = xml.match(/<Totales>[\s\S]*?<MntTotal>([^<]+)<\/MntTotal>/)[1];
    assert.equal(mnt, total, 'MNT del timbre = MntTotal');
  }

  // Sobre y muestra impresa del set completo.
  const cert = new Certificado(fs.readFileSync(CERT.path), CERT.password);
  const envio = new EnvioDTE({ certificado: cert });
  dtes.forEach((d) => envio.agregar(d));
  envio.setCaratula({ RutEmisor: RUT, RutEnvia: '11111111-1', RutReceptor: '60803000-K', FchResol: '2026-09-01', NroResol: 0, SetDTEId: 'DTE_SetDoc' });
  envio.generar();
  const muestras = new MuestrasImpresas({ emisor: { rut: RUT, razonSocial: 'EMPRESA EJEMPLO SPA' } });
  const docs = muestras.parseEnvioDTE(envio.xml);
  assert.equal(docs.length, 4);
  assert.ok(docs.every((d) => d.esExportacion && d.otraMoneda?.TpoMoneda === 'PESO CL'));
  assert.equal(docs[0].transporte.Aduana.CodPtoEmbarque, 906);
  for (const d of docs) {
    const pdf = await muestras.generarPDFBuffer(d, {});
    assert.equal(pdf.subarray(0, 4).toString(), '%PDF');
  }
});

test('un documento nacional sigue yendo en <Documento>', () => {
  const dte = new DTE({
    Encabezado: {
      IdDoc: { TipoDTE: 33, Folio: 1, FchEmis: '2026-09-30' },
      Emisor: { RUTEmisor: RUT, RznSoc: 'EMPRESA EJEMPLO SPA', GiroEmis: 'COMERCIO', DirOrigen: 'AV EJEMPLO 123', CmnaOrigen: 'SANTIAGO' },
      Receptor: { RUTRecep: '77111222-3', RznSocRecep: 'CLIENTE EJEMPLO SPA', DirRecep: 'CALLE 1', CmnaRecep: 'SANTIAGO' },
      Totales: { MntNeto: 100, TasaIVA: 19, IVA: 19, MntTotal: 119 },
    },
    Detalle: [{ NroLinDet: 1, NmbItem: 'PRODUCTO', QtyItem: 1, PrcItem: 100, MontoItem: 100 }],
  });
  dte.generarXML();
  assert.equal(dte.elementoDocumento, 'Documento');
  assert.ok(dte.documento.Documento);
});

// ── Tablas de Aduana ──────────────────────────────────────────────────────────

test('aduana: glosas, alias y códigos escritos tal cual', () => {
  assert.equal(resolverCodigo('clausulaVenta', 'FOB (FREE ON BOARD)').codigo, 5);
  assert.equal(resolverCodigo('clausulaVenta', 'C&F').codigo, 2);
  assert.equal(resolverCodigo('viaTransporte', 'Aéreo').codigo, 4);
  assert.equal(resolverCodigo('pais', 'España').codigo, 517);
  assert.equal(resolverCodigo('pais', 'U.S.A.').codigo, 225);
  assert.equal(resolverCodigo('puerto', '906').codigo, 906);
  assert.equal(resolverMoneda('Dólar estadounidense'), 'DOLAR USA');
});

test('aduana: un texto que calza con dos códigos lanza, salvo que se diga cuál preferir', () => {
  // SAN FRANCISCO es un paso fronterizo chileno (964) y un puerto de Estados Unidos (173).
  assert.throws(() => resolverCodigo('puerto', 'SAN FRANCISCO'), /más de un código/);
  assert.equal(resolverCodigo('puerto', 'SAN FRANCISCO', { preferir: (c) => c >= 900 }).codigo, 964);
});

test('aduana: un texto desconocido lanza con candidatos y se resuelve con override', () => {
  assert.throws(() => resolverCodigo('tipoBulto', 'CAJAS', { campo: 'TIPO DE BULTO' }), /TIPO DE BULTO: no encontré "CAJAS"/);
  assert.equal(resolverCodigo('tipoBulto', 'cajas', { overrides: { CAJAS: 22 } }).codigo, 22);
  assert.throws(() => resolverMoneda('PESO ARGENTINO'), /no reconozco/);
});

// ── Portal ────────────────────────────────────────────────────────────────────

test('waitForApproval: un set pedido que la página no muestra no se da por aprobado', async () => {
  const falso = { verAvanceParsed: async () => ({ success: true, estados: {} }) };
  const r = await SiiCertificacion.prototype.waitForApproval.call(falso, ['setExportacion1'], { maxIntentos: 1, intervalo: 0 });
  assert.notEqual(r.success, true);
  assert.deepEqual(r.sinEstado, ['setExportacion1'], 'dice qué set nunca apareció en la página');
});

test('_cafsDelPlan no exige CAF para un tipo con 0 casos', () => {
  const { CertRunner } = require('../cert');
  const falso = { _cafsPrecargados: { 110: 'caf-110.xml' } };
  const cafs = CertRunner.prototype._cafsDelPlan.call(falso, { 110: 2, 111: 0, 112: 0 }, 'SetExportacion');
  assert.deepEqual(cafs, { 110: 'caf-110.xml' });
  assert.throws(() => CertRunner.prototype._cafsDelPlan.call(falso, { 110: 1, 112: 1 }, 'SetExportacion'), /tipo 112/);
});

test('los dos sets de exportación se leen por separado en la página de avance', () => {
  const html =
    '<tr><td>SET DOCUMENTOS DE EXPORTACION</td><td><b>REVISADO CONFORME</b></td></tr>' +
    '<tr><td>SET DOCUMENTOS DE EXPORTACION (2)</td><td><b>EN REVISION</b></td></tr>';
  const { setExportacion1, setExportacion2 } = SiiCertificacion.ESTADO_PATTERNS;
  assert.equal(html.match(setExportacion1.regex)[1], 'REVISADO CONFORME');
  assert.equal(html.match(setExportacion2.regex)[1], 'EN REVISION');
});

test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));


// ── Formato real del SII (set de 2026, números de atención cambiados) ────────────
// Sets 1 y 2 tal como los entrega el portal: "REFERENCIA:" con documentos de Aduana, ítems
// "VALOR LINEA" (servicios), NACIONALIDAD (hotelería), unidades de tara y peso, recargo y
// descuento por línea, y las instrucciones al contribuyente al final.
const SET_REAL = [
  "SET BASICO DOCUMENTOS DE EXPORTACION (1) - NUMERO DE ATENCION: 990087",
  "CASO 990087-1",
  "==============",
  "DOCUMENTO\tFACTURA DE EXPORTACION ELECTRONICA",
  "ITEM                            CANTIDAD\tUNIDAD MEDIDA\tPRECIO UNITARIO",
  "CHATARRA DE ALUMINIO                202\t\tU\t\t    110",
  "REFERENCIA:                                  MIC (MANIFIESTO INTERNACIONAL)",
  "MONEDA DE LA OPERACION:                      DOLAR USA",
  "FORMA DE PAGO EXPORTACION:                   ACRED",
  "MODALIDAD DE VENTA:                          A FIRME",
  "CLAUSULA DE VENTA DE EXPORTACION:            FOB",
  "TOTAL CLAUSULA DE VENTA:                      609.91",
  "VIA DE TRANSPORTE:                           AEREO",
  "PUERTO DE EMBARQUE:                          ANTOFAGASTA",
  "PUERTO DE DESEMBARQUE:                       BREMEN",
  "UNIDAD DE MEDIDA DE TARA:                    U",
  "UNIDAD PESO BRUTO:                           U",
  "UNIDAD PESO NETO:                            U",
  "TIPO DE BULTO:                               CONTENEDOR REFRIGERADO",
  "TOTAL BULTOS:                                     20",
  "FLETE (**):                                    62.00",
  "SEGURO (**):                                    6.30",
  "PAIS RECEPTOR Y PAIS DESTINO:                ALEMANIA",
  "CASO 990087-2",
  "==============",
  "DOCUMENTO\t\tNOTA DE CREDITO DE EXPORTACION ELECTRONICA",
  "REFERENCIA\t\tFACTURA DE EXPORTACION ELECTRONICA CORRESPONDIENTE A CASO 990087-1",
  "RAZON REFERENCIA\tDEVOLUCION DE MERCADERIA",
  "ITEM                            CANTIDAD\t",
  "CHATARRA DE ALUMINIO                 67\t",
  "EL PRECIO UNITARIO DEL ITEM DEBE SER EL MISMO DE LA FACTURA",
  "CASO 990087-3",
  "==============",
  "DOCUMENTO\t\tNOTA DE DEBITO DE EXPORTACION ELECTRONICA",
  "REFERENCIA\t\tNOTA DE CREDITO CORRESPONDIENTE A CASO 990087-2",
  "RAZON REFERENCIA\tANULA NOTA DE CREDITO",
  "-----------------------------------------------------------------------------------",
  "(**) VER INSTRUCCIONES AL CONTRIBUYENTE EN SET BASICO FACTURA DE EXPORTACION (2).",
  "--------------------------------------------------------------------------------",
  "SET BASICO DOCUMENTOS DE EXPORTACION (2) - NUMERO DE ATENCION: 990088",
  "CASO 990088-1",
  "==============",
  "DOCUMENTO\tFACTURA DE EXPORTACION ELECTRONICA",
  "ITEM                                    VALOR LINEA",
  "ASESORIAS Y PROYECTOS PROFESIONALES          71",
  "REFERENCIA:\t\t\t\t\tRESOLUCION SNA",
  "MONEDA DE LA OPERACION:\t\t\t\tLIBRA EST",
  "FORMA DE PAGO EXPORTACION:\t\t\tSIN PAGO",
  "CLAUSULA DE VENTA DE EXPORTACION:\t\tS/CL",
  "VIA DE TRANSPORTE:\t\t\t\tMARITIMA, FLUVIAL Y LACUSTRE",
  "PUERTO DE EMBARQUE:\t\t\t\tPUNTA ARENAS",
  "PUERTO DE DESEMBARQUE:\t\t\t\tYOKOHAMA",
  "PAIS RECEPTOR Y PAIS DESTINO:\t\t\tJAPON",
  "%10 RECARGO EN LA LINEA DE ITEM POR COMISIONES EN EL EXTERIOR",
  "CASO 990088-2",
  "==============",
  "DOCUMENTO\tFACTURA DE EXPORTACION ELECTRONICA",
  "ITEM                                                    CANTIDAD\tUNIDAD MEDIDA\tPRECIO UNITARIO",
  "CAJAS CIRUELAS TIERNIZADAS SIN CAROZO CALIBRE 60/70         808\t\tKN\t    171",
  "CAJAS DE PASAS DE UVA FLAME MORENA SIN SEMILLA MEDIANAS     220\t\tKN\t    112",
  "REFERENCIA:\t\t\t\t\tDUS",
  "REFERENCIA:\t\t\t\t\tAWB",
  "MONEDA DE LA OPERACION:\t\t\t\tLIBRA EST",
  "FORMA DE PAGO EXPORTACION:\t\t\tSIN PAGO",
  "MODALIDAD DE VENTA:\t\t\t\tEN CONSIGNACION CON UN MINIMO A FIRME",
  "CLAUSULA DE VENTA DE EXPORTACION:\t\tS/CL",
  "TOTAL CLAUSULA DE VENTA:\t\t\t4245.30",
  "VIA DE TRANSPORTE:\t\t\t\tMARITIMA, FLUVIAL Y LACUSTRE",
  "PUERTO DE EMBARQUE:\t\t\t\tPUNTA ARENAS",
  "PUERTO DE DESEMBARQUE:\t\t\t\tYOKOHAMA",
  "UNIDAD DE MEDIDA DE TARA:\t\t\tPAR",
  "UNIDAD PESO BRUTO:\t\t\t\tLT",
  "UNIDAD PESO NETO:\t\t\t\tLT",
  "TIPO DE BULTO:\t\t\t\t\tROLLOS",
  "TOTAL BULTOS:\t\t\t\t\t     81",
  "FLETE (**):\t\t\t\t\t3003.76",
  "SEGURO (**):\t\t\t\t\t2125.31",
  "PAIS RECEPTOR Y PAIS DESTINO:\t\t\tJAPON",
  "COMISIONES EN EL EXTRANJERO (RECARGOS GLOBALES):  11% DEL TOTAL DE LA CLAUSULA",
  "DESCUENTO LINEA # 1:   5%",
  "CASO 990088-3",
  "==============",
  "DOCUMENTO\tFACTURA DE EXPORTACION ELECTRONICA",
  "ITEM                            VALOR LINEA",
  "ALOJAMIENTO HABITACIONES            212",
  "MONEDA DE LA OPERACION:\t\tDOLAR USA",
  "NACIONALIDAD:\t\t\tJAPON",
  "-----------------------------------------------------------------------------------",
  "INSTRUCCIONES AL CONTRIBUYENTE:",
  "1.- SE SUPONDRA QUE TODOS LOS DOCUMENTOS DE EXPORTACION SE GENERAN EN EL MISMO",
  "PERIODO TRIBUTARIO.",
  "2.- AGREGUE LA INFORMACION OBLIGATORIA DEL DTE: ASIGNE UN FOLIO AUTORIZADO, Y",
  "AGREGUE OTROS DATOS QUE UD. ESTIME ADECUADOS SEAN NECESARIOS.",
  "3.- CALCULE LOS VALORES CORRESPONDIENTES DEL ENCABEZADO.",
  "4.- DEBE ENVIAR EN ENVIOS SEPARADOS EL SET BASICO DOCUMENTOS DE EXPORTACION (1) Y",
  "EL SET BASICO DOCUMENTOS DE EXPORTACION (2).",
  "(**) LAS CIFRAS DE FLETE Y SEGURO DEBEN INDICARSE EN LOS CAMPOS INFORMATIVOS",
  "DEL ENCABEZADO DEFINIDOS PARA ESTOS MONTOS, Y TAMBIEN EN EL AREA DE RECARGO",
  "COMO DOS LINEAS DISTINTAS DE RECARGOS GLOBALES",
  "--------------------------------------------------------------------------------",
].join("\n");
const estReal = SetParser.generarEstructurasParaScripts(SetParser.extraerCasosDelSet(SET_REAL));
const EXPO_REAL = { tiposCambio: { "DOLAR USA": 945.12, "LIBRA EST": 1250.5 }, folioReferencia: "1" };

test("formato real: parser sin líneas perdidas, VALOR LINEA, referencias, unidades y nacionalidad", () => {
  const [a1, a2] = [estReal.setExportacion1.casos, estReal.setExportacion2.casos];
  for (const c of [...a1, ...a2]) assert.deepEqual(c.noInterpretadas, [], `caso ${c.id}`);
  assert.deepEqual(a1[0].referenciasExportacion, ["MIC (MANIFIESTO INTERNACIONAL)"]);
  assert.equal(a1[0].unidadTara, "U");
  assert.equal(a1[1].referenciaCaso, "990087-1", "la NC sigue apuntando a su caso");
  assert.deepEqual(a2[0].items, [{ nombre: "ASESORIAS Y PROYECTOS PROFESIONALES", cantidad: 1, precio: 71, unidad: undefined }]);
  assert.equal(a2[0].recargoLineaPct, 10);
  assert.deepEqual(a2[1].referenciasExportacion, ["DUS", "AWB"]);
  assert.deepEqual(a2[1].descuentosLinea, [{ linea: 1, pct: 5 }]);
  assert.equal(a2[2].nacionalidad, "JAPON");
});

test("formato real: flete y seguro como recargos, servicios e IndServicio, líneas con % y referencias de Aduana", () => {
  const p1 = crearSet("exportacion1", CERT, EXPO_REAL).planificar(estReal.setExportacion1);
  const f = p1[0].datos;
  assert.deepEqual(f.DscRcgGlobal.map((d) => [d.GlosaDR, d.TpoValor, d.ValorDR]), [["FLETE", "$", 62], ["SEGURO", "$", 6.3]]);
  assert.equal(f.Encabezado.Totales.MntTotal, 22288.3, "22220 + 62 + 6.30");
  assert.equal(f.Encabezado.Transporte.Aduana.TotClauVenta, 609.91, "el total cláusula del set, aunque no calce");
  assert.deepEqual([f.Encabezado.Transporte.Aduana.CodUnidMedTara, f.Encabezado.Transporte.Aduana.CodUnidPesoBruto], [10, 10]);
  assert.deepEqual(f.Referencia.slice(1).map((r) => [r.TpoDocRef, r.FolioRef]), [[810, "1"]]);
  assert.equal(p1[1].datos.Encabezado.Totales.MntTotal, 7370, "la NC por devolución no repite flete ni seguro");

  const p2 = crearSet("exportacion2", CERT, EXPO_REAL).planificar(estReal.setExportacion2);
  const [s1, s2, s3] = p2.map((p) => p.datos);
  assert.equal(s1.Encabezado.IdDoc.IndServicio, 3);
  assert.equal(s1.Encabezado.Transporte.Aduana.CodModVenta, undefined, "servicios: sin modalidad inventada");
  assert.deepEqual(s1.Detalle[0], { NroLinDet: 1, IndExe: 1, NmbItem: "ASESORIAS Y PROYECTOS PROFESIONALES", QtyItem: 1, PrcItem: 71, RecargoPct: 10, RecargoMonto: 7, MontoItem: 78 });
  assert.equal(s1.Referencia[1].TpoDocRef, 812);
  assert.equal(s2.Detalle[0].DescuentoPct, 5);
  assert.equal(s2.Detalle[1].DescuentoPct, undefined, "el descuento es solo de la línea 1");
  assert.deepEqual(s2.Referencia.slice(1).map((r) => r.TpoDocRef), [807, 809]);
  assert.deepEqual(s2.DscRcgGlobal.map((d) => d.GlosaDR), ["COMISIONES EN EL EXTRANJERO", "FLETE", "SEGURO"]);
  assert.equal(s3.Encabezado.IdDoc.IndServicio, 4, "alojamiento con nacionalidad: hotelería");
  assert.equal(s3.Encabezado.Receptor.Extranjero.Nacionalidad, 331);
  assert.equal(s3.Encabezado.Transporte, undefined);

  assert.throws(() => crearSet("exportacion2", CERT, { tiposCambio: EXPO_REAL.tiposCambio }).planificar(estReal.setExportacion2),
    /folioReferencia/, "el número del documento de Aduana no se inventa");
});
