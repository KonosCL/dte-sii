// Copyright (c) 2026 Devlas SpA — https://devlas.cl
// Licencia MIT. Ver archivo LICENSE para mas detalles.
/**
 * Set Documentos de Exportación
 *
 * Tipos DTE: 110 (Factura de Exportación), 112 (Nota de Crédito de Exportación),
 * 111 (Nota de Débito de Exportación).
 *
 * El SII entrega dos sets de exportación ("SET DOCUMENTOS DE EXPORTACION" y "...(2)"), cada
 * uno con su número de atención; cada uno se envía y se declara por separado. Esta clase
 * ejecuta uno: CertRunner la instancia una vez por set.
 *
 * Lo que el set NO trae y hay que recibir por configuración (no se inventa):
 *
 *  - `config.exportacion.tiposCambio`: pesos por unidad de cada moneda del set, del Banco
 *    Central, del día de emisión. `OtraMoneda` es obligatorio en exportación. Puede ser un
 *    objeto `{ 'DOLAR USA': 945.12 }` o una función `(moneda, caso) => número`. Si el caso
 *    trae su propio `tipoCambio`, manda ese.
 *  - `config.receptorExtranjero`: el receptor del documento. El set no lo define; el RUT es
 *    siempre 55555555-5 (formato DTE: "En doctos. Exportac. 55.555.555-5"). Nacionalidad sale
 *    del país receptor del caso.
 *
 * Opcional, para textos del set que las tablas no resuelven:
 *  - `config.exportacion.codigos`: `{ puerto: { 'TEXTO': 906 }, pais: {...}, ... }` (ver
 *    utils/aduana.js, `resolverCodigo`), y `monedas: { 'TEXTO': 'DOLAR USA' }`.
 *  - `config.exportacion.comisionComo`: 'R' o 'D', cuando la línea de comisiones del set no
 *    dice si es recargo o descuento.
 *
 * Ningún campo de `Aduana` es obligatorio en DTE_v10.xsd: que el documento valide no dice que
 * corresponda al caso. Por eso cada traducción de texto a código lanza si no es inequívoca, y
 * `planificar()` deja ver el documento completo antes de gastar folios.
 *
 * @module dte-sii/cert/SetExportacion
 */

const SetBase = require('./SetBase');
const { resolverCodigo, resolverMoneda, esPuertoChileno } = require('../utils/aduana');
const {
  buildDetalleExportacion,
  buildDscRcgGlobalExportacion,
  calcularTotalesExportacion,
  buildTransporteExportacion,
} = require('../utils/exportacion');
const { buildSetReferencia } = require('../utils/referencia');
const { timestampChile } = require('../utils/fecha-chile');

/** RUT que el SII exige al receptor de todo documento de exportación. */
const RUT_RECEPTOR_EXTRANJERO = '55555555-5';

/** Forma de pago "anticipo": obliga a informar FchCancel. */
const FMA_PAG_EXP_ANTICIPO = 32;

/** Indicadores de servicio con los que CodModVenta, CodClauVenta y TotClauVenta dejan de ser obligatorios. */
const IND_SERVICIO_SIN_CLAUSULA = [3, 4, 5];

/**
 * Documentos de Aduana que un documento de exportación puede referenciar (TpoDocRef, formato
 * DTE). El set los nombra en líneas "REFERENCIA:  DUS".
 */
const REFERENCIAS_EXPORTACION = [
  [/ORDEN\s+DE\s+COMPRA/, 801],
  [/NOTA\s+DE\s+PEDIDO/, 802],
  [/CONTRATO/, 803],
  [/RESOLUCION\s+SNA|SNA/, 812],
  [/\bDUS\b/, 807],
  [/B\/L|CONOCIMIENTO\s+DE\s+EMBARQUE/, 808],
  [/\bAWB\b|AIR\s*WAY\s*BILL/, 809],
  [/\bMIC\b|MANIFIESTO\s+INTERNACIONAL|\bDTA\b/, 810],
  [/CARTA\s+DE\s+PORTE/, 811],
  [/PASAPORTE/, 813],
  [/RESOLUCION/, 804],
];

/** IndServicio de exportación: 3 factura de servicios, 4 servicios de hotelería (formato DTE). */
const IND_SERVICIO_SERVICIOS = 3;
const IND_SERVICIO_HOTELERIA = 4;

/** Tipos de bulto que son contenedores (Aduana): piden IdContainer, Sello y EmisorSello. */
const BULTOS_CONTENEDOR = [73, 74, 75, 76, 78];

class SetExportacion extends SetBase {
  /**
   * @param {Object} deps - Las de SetBase, más:
   * @param {string} [deps.key='exportacion1'] - 'exportacion1' o 'exportacion2'
   */
  constructor(deps) {
    super(deps);

    this.key = deps.key || 'exportacion1';
    this.label = this.key === 'exportacion2'
      ? 'Set Documentos de Exportación (2)'
      : 'Set Documentos de Exportación';
    // Orden de emisión: facturas, notas de crédito y después de débito (una ND suele anular
    // una NC del mismo set).
    this.tiposDte = [110, 112, 111];

    // { casoId: { tipoDte, folio, fecha, items, moneda, dscRcg, receptor, indServicio } }
    this._docRefs = {};
  }

  /** @override */
  _validarCasos(casos) {
    super._validarCasos(casos);
    const lista = casos.casos || [];
    if (!lista.length) throw new Error(`${this.label}: el set no trae casos`);
    const raros = lista.filter((c) => ![110, 111, 112].includes(Number(c.tipoDTE)));
    if (raros.length) {
      throw new Error(`${this.label}: casos con un documento que no es de exportación: ` +
        raros.map((c) => `${c.id} (${c.documento || c.tipoDTE})`).join(', '));
    }
    const r = this.config.receptorExtranjero;
    if (!r?.razon_social) {
      throw new Error(`${this.label}: falta config.receptorExtranjero.razon_social. El set no define ` +
        'receptor; en certificación basta un nombre de fantasía para el cliente extranjero.');
    }
  }

  /** @override Cuenta los casos de cada tipo; un tipo sin casos no pide folios. */
  _calcularCantidadFolios(casos, tipoDte) {
    return (casos.casos || []).filter((c) => Number(c.tipoDTE) === Number(tipoDte)).length;
  }

  /**
   * @override Solo pide CAF de los tipos que el set usa. SetBase pide al menos uno de cada
   * tipo en `tiposDte`, y un folio timbrado sin usar es justo lo que hace que el SII racione
   * el timbraje.
   */
  async ensureCafs(casos) {
    const cafs = {};
    for (const tipoDte of this.tiposDte) {
      const cantidad = this._calcularCantidadFolios(casos, tipoDte);
      if (!cantidad) continue;
      const cafPath = await this.cafManager.ensureCaf({
        tipoDte,
        rutEmisor: this.config.emisor.rut,
        requiredCount: cantidad,
        forceNew: false,
        preferExisting: true,
      });
      if (!cafPath) throw new Error(`No se pudo obtener CAF para tipo ${tipoDte}`);
      cafs[tipoDte] = cafPath;
    }
    return cafs;
  }

  /**
   * Arma los documentos del set sin folios ni firma, para revisarlos contra el set antes de
   * emitir. Lanza con el mismo error que lanzaría la emisión.
   *
   * @param {Object} casos - setExportacion1 / setExportacion2 de SetParser
   * @returns {Array<{ caso: string, tipoDte: number, datos: Object, avisos: string[] }>}
   */
  planificar(casos) {
    this._validarCasos(casos);
    const fecha = this._getFechaEmision();
    const refs = {};
    const plan = [];
    let folioFicticio = 0;
    for (const caso of this._ordenDeEmision(casos.casos)) {
      folioFicticio += 1;
      const { datos, avisos, ref } = this._armar(caso, { folio: folioFicticio, fecha, refs });
      refs[caso.id] = ref;
      plan.push({ caso: caso.id, tipoDte: Number(caso.tipoDTE), datos, avisos });
    }
    return plan;
  }

  /** @override */
  async generarDtes(casos, cafs) {
    const { DTE } = require('../index');
    const fecha = this._getFechaEmision();
    const dtes = [];
    this._docRefs = {};

    for (const caso of this._ordenDeEmision(casos.casos)) {
      const tipo = Number(caso.tipoDTE);
      const { caf, folio } = this._tomarFolio(cafs[tipo]);
      const { datos, avisos, ref } = this._armar(caso, { folio, fecha, refs: this._docRefs });
      const dte = new DTE(datos);
      this._timbrarYFirmar(dte, caf);
      this._docRefs[caso.id] = ref;
      dtes.push(dte);
      for (const a of avisos) this.logger.log(` [!] Caso ${caso.id}: ${a}`);
      this.logger.log(` ✓ ${tipo} caso ${caso.id}: folio ${folio} (${datos.Encabezado.Totales.MntTotal} ${datos.Encabezado.Totales.TpoMoneda})`);
    }
    return dtes;
  }

  // ═══════════════════════════════════════════════════════════════
  // Armado de un documento
  // ═══════════════════════════════════════════════════════════════

  /** Facturas primero, luego NC y luego ND, respetando el orden del set dentro de cada tipo. */
  _ordenDeEmision(lista) {
    const orden = { 110: 0, 112: 1, 111: 2 };
    return [...(lista || [])]
      .map((c, i) => ({ c, i }))
      .sort((a, b) => (orden[a.c.tipoDTE] - orden[b.c.tipoDTE]) || (a.i - b.i))
      .map(({ c }) => c);
  }

  /**
   * @private
   * @returns {{ datos: Object, avisos: string[], ref: Object }}
   */
  _armar(caso, { folio, fecha, refs }) {
    const tipo = Number(caso.tipoDTE);
    const avisos = [];
    const codigos = this.config.exportacion?.codigos || {};
    const resolver = (tabla, texto, campo, extra = {}) =>
      resolverCodigo(tabla, texto, { overrides: codigos[tabla], campo: `Caso ${caso.id}, ${campo}`, ...extra });

    for (const linea of caso.noInterpretadas || []) {
      avisos.push(`línea del set que no se interpretó: "${linea}"`);
    }

    const esNota = tipo !== 110;
    const docRef = esNota ? refs[caso.referenciaCaso] : null;
    if (esNota && !docRef) {
      throw new Error(`Caso ${caso.id}: referencia al caso ${caso.referenciaCaso || '(ninguno)'} que no está en el set o no se emitió antes`);
    }

    const moneda = caso.moneda
      ? resolverMoneda(caso.moneda, { overrides: this.config.exportacion?.monedas })
      : docRef?.moneda;
    if (!moneda) throw new Error(`Caso ${caso.id}: el set no indica MONEDA DE LA OPERACION`);
    const tipoCambio = this._tipoCambio(moneda, caso);

    // País receptor y destino: el set los da juntos ("PAIS RECEPTOR Y PAIS DESTINO").
    const pais = caso.paisDestino ? resolver('pais', caso.paisDestino, 'PAIS RECEPTOR Y PAIS DESTINO') : null;

    const items = esNota ? this._itemsDeNota(caso, docRef, avisos) : this._items(caso);
    const detalle = buildDetalleExportacion(items, { moneda });

    const movimientos = [];
    if (caso.descuentoGlobal) {
      movimientos.push({ tipo: 'D', valor: caso.descuentoGlobal, glosa: 'DESCUENTO GLOBAL' });
    }
    if (caso.comisionExtranjero) {
      movimientos.push({ tipo: this._tipoComision(caso), valor: caso.comisionExtranjero, glosa: 'COMISIONES EN EL EXTRANJERO' });
    }
    // "(**) Las cifras de flete y seguro deben indicarse en los campos informativos del
    // encabezado ... y también en el área de recargo como dos líneas distintas de recargos
    // globales" (instrucciones del set de exportación).
    if (!esNota && caso.flete > 0) movimientos.push({ tipo: 'R', valor: caso.flete, enPorcentaje: false, glosa: 'FLETE' });
    if (!esNota && caso.seguro > 0) movimientos.push({ tipo: 'R', valor: caso.seguro, enPorcentaje: false, glosa: 'SEGURO' });
    // Una nota que anula copia también los descuentos/recargos del documento que anula.
    if (esNota && caso.codRef === 1 && !movimientos.length && docRef.movimientos?.length) {
      movimientos.push(...docRef.movimientos);
    }
    const dscRcg = buildDscRcgGlobalExportacion(movimientos);
    const { Totales, OtraMoneda } = calcularTotalesExportacion(detalle, dscRcg, { moneda, tipoCambio });

    // IdDoc. En exportación no va FmaPago sino FmaPagExp (tabla de Aduana).
    const idDoc = { TipoDTE: tipo, Folio: folio, FchEmis: fecha };
    const indServicio = caso.indServicio ?? docRef?.indServicio ?? this._indServicio(caso);
    if (indServicio) idDoc.IndServicio = indServicio;
    if (caso.formaPago) {
      const fp = resolver('formaPago', caso.formaPago, 'FORMA DE PAGO EXPORTACION');
      idDoc.FmaPagExp = fp.codigo;
      // "Campo obligatorio para factura de exportación cuando en Forma de Pago Exportación se
      // indique anticipo" (formato DTE): se cancela a la fecha de emisión.
      if (fp.codigo === FMA_PAG_EXP_ANTICIPO) idDoc.FchCancel = fecha;
    }

    const nacionalidad = pais || (caso.nacionalidad ? resolver('pais', caso.nacionalidad, 'NACIONALIDAD') : null);
    const receptor = this._receptor(nacionalidad, docRef);
    const transporte = this._transporte(caso, { pais, Totales, indServicio, resolver, avisos, esNota });

    const referencias = [buildSetReferencia(caso.id, fecha)];
    for (const texto of caso.referenciasExportacion || []) {
      referencias.push({
        NroLinRef: referencias.length + 1,
        TpoDocRef: this._tpoDocRefExportacion(caso, texto),
        FolioRef: this._folioReferencia(caso, texto),
        FchRef: fecha,
      });
    }
    if (esNota) {
      referencias.push({
        NroLinRef: referencias.length + 1,
        TpoDocRef: docRef.tipoDte,
        FolioRef: docRef.folio,
        FchRef: docRef.fecha,
        ...(caso.codRef ? { CodRef: caso.codRef } : {}),
        ...(caso.razonRef ? { RazonRef: String(caso.razonRef).slice(0, 90) } : {}),
      });
    }

    const datos = {
      Encabezado: {
        IdDoc: idDoc,
        Emisor: this._emisor(),
        Receptor: receptor,
        ...(transporte ? { Transporte: transporte } : {}),
        Totales,
        OtraMoneda,
      },
      Detalle: detalle,
      ...(dscRcg.length ? { DscRcgGlobal: dscRcg } : {}),
      Referencia: referencias,
    };

    const ref = {
      tipoDte: tipo,
      folio,
      fecha,
      moneda,
      items,
      movimientos,
      receptor,
      indServicio,
    };
    return { datos, avisos, ref };
  }

  /** Items del caso en la forma que espera buildDetalleExportacion. */
  _items(caso) {
    const porLinea = new Map((caso.descuentosLinea || []).map((d) => [Number(d.linea), Number(d.pct)]));
    const lineas = caso.items || [];
    for (const n of porLinea.keys()) {
      if (n < 1 || n > lineas.length) throw new Error(`Caso ${caso.id}: DESCUENTO LINEA # ${n}, pero el caso tiene ${lineas.length} línea(s)`);
    }
    return lineas.map((i, idx) => {
      const descuentoPct = porLinea.get(idx + 1) || this._descuentoPct(i.descuento);
      return {
        nombre: i.nombre,
        cantidad: i.cantidad ?? 1,
        precio: i.precio ?? 0,
        ...(i.unidad ? { unidad: i.unidad } : {}),
        ...(descuentoPct ? { descuentoPct } : {}),
        ...(caso.recargoLineaPct ? { recargoPct: Number(caso.recargoLineaPct) } : {}),
      };
    });
  }

  /**
   * IndServicio cuando el set no lo dice: líneas con "VALOR LINEA" son servicios (3); con
   * NACIONALIDAD del cliente y sin país de destino, servicios de hotelería (4).
   */
  _indServicio(caso) {
    if (caso.nacionalidad && !caso.paisDestino) return IND_SERVICIO_HOTELERIA;
    if (caso.itemsValorLinea) return IND_SERVICIO_SERVICIOS;
    return undefined;
  }

  _tpoDocRefExportacion(caso, texto) {
    const t = String(texto).toUpperCase();
    const hit = REFERENCIAS_EXPORTACION.find(([re]) => re.test(t));
    if (!hit) {
      throw new Error(`Caso ${caso.id}: REFERENCIA "${texto}" no corresponde a un documento de Aduana conocido ` +
        '(DUS, AWB, B/L, MIC, CARTA DE PORTE, RESOLUCION SNA, PASAPORTE, CONTRATO, ORDEN DE COMPRA, NOTA DE PEDIDO)');
    }
    return hit[1];
  }

  /**
   * El set nombra el documento de Aduana pero no su número. Se recibe por configuración
   * (config.exportacion.folioReferencia: valor fijo o función (caso, texto) => folio).
   */
  _folioReferencia(caso, texto) {
    const f = this.config.exportacion?.folioReferencia;
    const v = typeof f === 'function' ? f(caso, texto) : f;
    if (v === undefined || v === null || v === '') {
      throw new Error(`Caso ${caso.id}: el set referencia "${texto}" sin número; indícalo en config.exportacion.folioReferencia`);
    }
    return String(v);
  }

  _descuentoPct(texto) {
    const m = String(texto || '').match(/(\d+(?:[.,]\d+)?)\s*%/);
    return m ? Number(m[1].replace(',', '.')) : 0;
  }

  /**
   * Items de una NC/ND según el código de referencia, con el mismo criterio que SetExenta:
   *  1 (anula): todas las líneas del documento referenciado.
   *  2 (corrige texto): una línea sin valor con la razón.
   *  3 (corrige montos / devolución): las líneas del caso; cantidad o precio que falten se
   *    toman de la línea del mismo nombre en el documento referenciado.
   */
  _itemsDeNota(caso, docRef, avisos) {
    if (caso.codRef === 1) return docRef.items.map((i) => ({ ...i }));
    if (caso.codRef === 2) {
      return [{ nombre: caso.razonRef || 'CORRIGE TEXTO', cantidad: 1, precio: 0 }];
    }
    const propios = caso.items || [];
    if (!propios.length) {
      avisos.push('la nota no trae líneas en el set; se copian las del documento referenciado');
      return docRef.items.map((i) => ({ ...i }));
    }
    // "MODIFICA MONTO": el set da el precio nuevo y la cantidad es la del documento original
    // (mismo criterio que SetExenta). Devolución: el set da la cantidad devuelta y el precio
    // es el original.
    const modificaMonto = /MODIFICA\s+MONTO|CORRIGE\s+MONTO/i.test(String(caso.razonRef || ''));
    return propios.map((i) => {
      const nombre = String(i.nombre || '').toUpperCase().trim();
      const original = docRef.items.find((o) => String(o.nombre || '').toUpperCase().trim() === nombre);
      const cantidad = modificaMonto ? (original?.cantidad ?? i.cantidad ?? 1) : (i.cantidad ?? original?.cantidad ?? 1);
      const precio = i.precio ?? original?.precio;
      if (precio === undefined) {
        throw new Error(`Caso ${caso.id}: la línea "${i.nombre}" no trae precio y no está en el documento referenciado`);
      }
      if (!original) avisos.push(`la línea "${i.nombre}" no está en el documento referenciado`);
      return {
        nombre: i.nombre,
        cantidad,
        precio,
        ...((i.unidad || original?.unidad) ? { unidad: i.unidad || original.unidad } : {}),
      };
    });
  }

  /** 'R' o 'D' para la línea "COMISIONES EN EL EXTRANJERO" del set. */
  _tipoComision(caso) {
    const texto = String(caso.comisionTexto || '').toUpperCase();
    if (/RECARGO/.test(texto)) return 'R';
    if (/DESCUENTO/.test(texto)) return 'D';
    const conf = this.config.exportacion?.comisionComo;
    if (conf === 'R' || conf === 'D') return conf;
    throw new Error(`Caso ${caso.id}: la línea de comisiones del set no dice si es recargo o descuento ` +
      `("${caso.comisionTexto || caso.comisionExtranjero + '%'}"). Indícalo con config.exportacion.comisionComo = 'R' o 'D'.`);
  }

  /** Tipo de cambio a pesos para la moneda del caso: el del caso, o el de la configuración. */
  _tipoCambio(moneda, caso) {
    if (caso.tipoCambio) return Number(caso.tipoCambio);
    const fuente = this.config.exportacion?.tiposCambio;
    const valor = typeof fuente === 'function' ? fuente(moneda, caso) : fuente?.[moneda];
    const n = Number(valor);
    if (!Number.isFinite(n) || n <= 0) {
      throw new Error(`Caso ${caso.id}: falta el tipo de cambio de ${moneda} a pesos (config.exportacion.tiposCambio). ` +
        'El SII exige OtraMoneda en exportación con el tipo de cambio del Banco Central del día de emisión.');
    }
    return n;
  }

  _emisor() {
    const e = this.config.emisor;
    return {
      RUTEmisor: e.rut,
      RznSoc: e.razon_social,
      GiroEmis: e.giro,
      Acteco: e.acteco,
      DirOrigen: e.direccion,
      CmnaOrigen: e.comuna,
      CiudadOrigen: e.ciudad || e.comuna,
    };
  }

  /**
   * Receptor extranjero. Sin CmnaRecep: la comuna es chilena y el receptor no lo es (el XSD de
   * exportación la deja opcional). Una nota repite el receptor del documento que corrige.
   */
  _receptor(pais, docRef) {
    if (docRef?.receptor) return docRef.receptor;
    const r = this.config.receptorExtranjero;
    const nacionalidad = pais?.codigo ?? r.nacionalidad;
    return {
      RUTRecep: RUT_RECEPTOR_EXTRANJERO,
      RznSocRecep: r.razon_social,
      ...((r.numId || nacionalidad) ? {
        Extranjero: {
          ...(r.numId ? { NumId: r.numId } : {}),
          ...(nacionalidad ? { Nacionalidad: nacionalidad } : {}),
        },
      } : {}),
      ...(r.giro ? { GiroRecep: String(r.giro).slice(0, 40) } : {}),
      ...(r.direccion ? { DirRecep: r.direccion } : {}),
      ...(r.ciudad ? { CiudadRecep: r.ciudad } : {}),
    };
  }

  /**
   * <Transporte><Aduana> desde los campos del caso. Una nota solo lo lleva si el caso trae
   * datos de transporte propios.
   */
  _transporte(caso, { pais, Totales, indServicio, resolver, avisos, esNota }) {
    const a = {};
    const conClausula = !IND_SERVICIO_SIN_CLAUSULA.includes(Number(indServicio));

    if (caso.modalidadVenta) {
      a.CodModVenta = resolver('modalidadVenta', caso.modalidadVenta, 'MODALIDAD DE VENTA').codigo;
    } else if (!esNota && conClausula) {
      // El formato la exige en factura de exportación (salvo servicios) y el set puede no
      // traerla. "A firme" es la venta simple, sin condiciones.
      a.CodModVenta = 1;
      avisos.push('el set no trae MODALIDAD DE VENTA; se informa 1 (A FIRME)');
    }
    if (caso.clausulaVenta) {
      a.CodClauVenta = resolver('clausulaVenta', caso.clausulaVenta, 'CLAUSULA DE VENTA').codigo;
    }
    if (caso.totalClausula) {
      // El valor del set manda aunque no calce con el total del documento.
      a.TotClauVenta = caso.totalClausula;
    } else if (a.CodClauVenta && conClausula) {
      a.TotClauVenta = Totales.MntTotal;
      avisos.push(`el set no trae TOTAL CLAUSULA DE VENTA; se informa el total del documento (${Totales.MntTotal})`);
    }
    if (caso.viaTransporte) {
      a.CodViaTransp = resolver('viaTransporte', caso.viaTransporte, 'VIA DE TRANSPORTE').codigo;
    }
    if (caso.puertoEmbarque) {
      a.CodPtoEmbarque = resolver('puerto', caso.puertoEmbarque, 'PUERTO DE EMBARQUE', { preferir: esPuertoChileno }).codigo;
    }
    if (caso.puertoDesembarque) {
      a.CodPtoDesemb = resolver('puerto', caso.puertoDesembarque, 'PUERTO DE DESEMBARQUE', {
        preferir: (c) => !esPuertoChileno(c),
      }).codigo;
    }
    if (caso.unidadTara) a.CodUnidMedTara = resolver('unidad', caso.unidadTara, 'UNIDAD DE MEDIDA DE TARA').codigo;
    if (caso.unidadPesoBruto) a.CodUnidPesoBruto = resolver('unidad', caso.unidadPesoBruto, 'UNIDAD PESO BRUTO').codigo;
    if (caso.unidadPesoNeto) a.CodUnidPesoNeto = resolver('unidad', caso.unidadPesoNeto, 'UNIDAD PESO NETO').codigo;
    if (caso.totalBultos) a.TotBultos = caso.totalBultos;
    if (caso.tipoBulto) {
      const bulto = resolver('tipoBulto', caso.tipoBulto, 'TIPO DE BULTO');
      a.TipoBultos = [{ CodTpoBultos: bulto.codigo, ...(caso.totalBultos ? { CantBultos: caso.totalBultos } : {}) }];
      if (BULTOS_CONTENEDOR.includes(bulto.codigo)) {
        const cont = this.config.exportacion?.contenedor;
        if (cont?.id) {
          Object.assign(a.TipoBultos[0], {
            IdContainer: cont.id,
            ...(cont.sello ? { Sello: cont.sello } : {}),
            ...(cont.emisorSello ? { EmisorSello: cont.emisorSello } : {}),
          });
        } else {
          avisos.push(`bulto ${bulto.glosa}: el set no trae número de contenedor ni sello (IdContainer, Sello)`);
        }
      }
    }
    if (caso.flete > 0) a.MntFlete = caso.flete;
    if (caso.seguro > 0) a.MntSeguro = caso.seguro;
    if (pais && (!esNota || Object.keys(a).length)) {
      a.CodPaisRecep = pais.codigo;
      a.CodPaisDestin = pais.codigo;
    }

    if (!Object.keys(a).length) return null;
    return buildTransporteExportacion({ Aduana: a });
  }

  /** Fecha de emisión en Chile, igual para todo el set (una nota no puede quedar antes que su factura). */
  _getFechaEmision() {
    if (!this._fechaEmision) this._fechaEmision = timestampChile().slice(0, 10);
    return this._fechaEmision;
  }

  _timbrarYFirmar(dte, caf) {
    const { Certificado } = require('../index');
    const fs = require('fs');
    const cert = new Certificado(fs.readFileSync(this.config.certificado.path), this.config.certificado.password);
    dte.generarXML().timbrar(caf, timestampChile());
    dte.firmar(cert);
  }
}

SetExportacion.RUT_RECEPTOR_EXTRANJERO = RUT_RECEPTOR_EXTRANJERO;

module.exports = SetExportacion;
