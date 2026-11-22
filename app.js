/* Boutique de Lentes Yael — PWA (vanilla JS, sin frameworks)
   Backend: Google Apps Script (web app) según API_CONTRACT.md.
   La URL y el token NO van en el código: se piden en la pantalla de
   configuración y se guardan en localStorage. Modo demo = datos en
   memoria, nada se guarda. */
'use strict';

/* ---------- Configuración ---------- */
const LS_URL = 'bly_sol_api_url';
const LS_TOKEN = 'bly_sol_api_token';
const LS_DEMO = 'bly_sol_demo';
const NEGOCIO = {
  nombre: 'Boutique de Lentes Yael',
  sucursal: 'El Sol',
  direccion: 'Calle 15, 61. El Sol, Nezahualcóyotl, Estado de México 57200',
  telefonos: '5567513976'
};
const GARANTIAS = { adaptacion: '30 días de adaptación', armazon: '6 meses armazón', tratamiento: '6 meses tratamiento' };
const PROXIMA_VISITA_MESES = 10;
/* ---------- Fase 5: Laboratorio Óptico Luna (SOLO órdenes de trabajo) ----------
   Yael es el operador principal para venta al cliente; Luna es el
   operador de proceso, la entidad que elabora los lentes. Por eso SOLO
   en las órdenes de trabajo sale Luna; todo lo demás (comprobante,
   ticket, historia clínica, app) sigue con Yael / OPTICST NEXUS.
   La dirección y los teléfonos son los de la sucursal (NEGOCIO).
   El logo es `logo-luna-fuerte.png` (v2.3: alfa dilatado 1px +
   colores ×0.68 para que el trazo fino se lea a 84px y como marca de
   agua; la versión normal `logo-luna.png` se perdía al achicar).
   Se referencia con onerror (si no existe, se oculta la imagen y
   queda solo el nombre en texto, sin imagen rota). */
const LABORATORIO = {
  nombre: 'Laboratorio Óptico Luna',
  direccion: NEGOCIO.direccion,
  telefonos: NEGOCIO.telefonos,
  logo: 'logo-luna-fuerte.png'
};
const LS_ORDENES_SEL = 'bly_sol_ordenes_sel'; // selección de trabajos para armar hojas de órdenes
const ETIQUETAS_POR_HOJA = 9;             // rejilla 3×3 en carta
const SIN_PROVEEDOR = 'Sin proveedor';    // grupo aparte, nunca se descarta en silencio

const state = {
  demo: false,
  url: '',
  token: '',
  catalogs: null,
  wizard: { step: 1, cliente: null, historia: null, tipoVenta: 'lentes_completos', conArmazonLC: false, llevaLC: false },
  currentVentaId: null,
  currentDoc: null,       // {kind, venta}
  currentClienteId: null,
  abonoVentaId: null,     // venta elegida en la vista rápida de abono
  abonoSaldo: 0,
  pendientesSel: new Set(),
  ordenesTrabajos: [],       // trabajos cargados en la vista de órdenes (En proceso + Pendientes)
  ordenesSel: new Set(),     // ventaIds seleccionados para armar hojas (persiste en localStorage)
  materialesCache: null,
  corteCache: null
};

/* ---------- Utilidades ---------- */
const $ = (sel, root) => (root || document).querySelector(sel);
const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
const money = n => '$' + (Number(n) || 0).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const hoyISO = () => new Date().toISOString().slice(0, 10);
const fechaMX = d => {
  if (!d) return '—';
  const dt = new Date(d.length === 10 ? d + 'T12:00:00' : d);
  return isNaN(dt) ? String(d) : dt.toLocaleDateString('es-MX');
};
function edadDesde(fechaNac) {
  if (!fechaNac) return '';
  const n = new Date(fechaNac + 'T12:00:00'), h = new Date();
  let e = h.getFullYear() - n.getFullYear();
  if (h.getMonth() < n.getMonth() || (h.getMonth() === n.getMonth() && h.getDate() < n.getDate())) e--;
  return e;
}
function showError(msg, el) {
  const target = el || $('#globalError');
  if (!target) return;
  target.textContent = msg;
  target.hidden = false;
  setTimeout(() => { target.hidden = true; }, 12000);
}
function showOk(msg, el) {
  if (!el) return;
  el.textContent = msg;
  el.hidden = false;
  setTimeout(() => { el.hidden = true; }, 8000);
}
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
/* Formato de graduación (v2.3.3): Esf, Cil y Add SIEMPRE con 2
   decimales y signo (+2.50, -2.00, -0.75, 0.00) — así se escribe la
   graduación y la lensometría, y así aparece en la historia clínica,
   la orden de trabajo y la lista de materiales. El Eje NO lleva
   decimales (es un entero 0-180) y se muestra tal cual, sin formatear.
   Valores vacíos → '—'. Idempotente: '-2.00' o '+2.50' quedan igual. */
function fmtGrad(v) {
  if (v === null || v === undefined || String(v).trim() === '') return '—';
  const n = Number(v);
  if (isNaN(n)) return String(v);
  if (n === 0) return '0.00';
  return (n > 0 ? '+' : '') + n.toFixed(2);
}

/* ---------- Rangos de graduación (según contrato; se usan solo si el backend no devuelve listas) ---------- */
function rangoEsfera() { const v = []; for (let x = -20; x <= 10.0001; x += 0.5) v.push(x.toFixed(2)); return v; }
function rangoCilindro() { const v = []; for (let x = 0; x >= -10.0001; x -= 0.5) v.push(x.toFixed(2)); return v; }
function rangoEje() { const v = []; for (let x = 0; x <= 180; x += 5) v.push(String(x)); return v; }
function rangoAdd() { const v = []; for (let x = 1; x <= 3.0001; x += 0.5) v.push('+' + x.toFixed(2)); return v; }
const SNELLEN = ['cuenta dedos', '20/400', '20/200', '20/100', '20/70', '20/50', '20/40', '20/30', '20/25', '20/20', '20/15', '20/13', '20/10'];
const FALLBACK_LISTAS = {
  Esfera: rangoEsfera(), Cilindro: rangoCilindro(), Eje: rangoEje(), Add: rangoAdd(),
  'Agudeza visual': SNELLEN,
  Material_Lente: ['Cristal', 'CR39', 'Poli', '1.67', '1.74'],
  Diseno_Lente: ['Monofocal', 'Bifocal', 'Progresivo', 'Lente de contacto'],
  Tipo_LC: ['Esférico', 'Tórico', 'Cosmético'],
  Tratamiento: ['AR', 'Foto AR', 'Blue', 'Blue Foto', 'Polar', 'W', 'Foto', 'Filtro color'],
  Filtro_Tono: ['1', '2', '3'],
  Material_Armazon: ['Metálico', 'Plástico', 'TR-90', 'Ultem', 'Aluminio', 'Titanio'],
  Diseno_Armazon: ['completo', 'ranurado', '3 piezas (tornillo)', '3 piezas (grapa)'],
  Motivo: ['Primera vez', 'Dolor de cabeza', 'Visión borrosa', 'Actualización de graduación', 'Lentes rotos'],
  Metodo_Pago: ['Efectivo', 'Transferencia', 'Tarjeta de débito', 'Tarjeta de crédito', 'Programas sociales'],
  Proveedor: ['Mia', 'H2O', 'Lensbest', 'INFONDI']
};
const MARCAS_LC_PRESTIGIO = ['Alcon', 'Johnson & Johnson', 'CooperVision', 'Bausch & Lomb'];
const MARCAS_LC_COSMETICO = ['Lunare', 'FreshLook'];

/* ---------- Catálogos demo (valores del contrato; en producción los devuelve getCatalogos) ---------- */
function demoCatalogs() {
  const preciosLentes = [
    ['Ar 1era', 25], ['Ar 2da', 52], ['Ar 3era', 70], ['Ar foto 1era', 55], ['Ar foto 2da', 75],
    ['Ar foto 3era', 110], ['Blue 1era', 65], ['Blue 2da', 90], ['Blue 3era', 130], ['Blue foto 1era', 130],
    ['Blue foto 2da', 170], ['Blue foto 3era', 210], ['Bifocal Ar', 44], ['Bifocal Ar foto', 120],
    ['Bifocal blue', 90], ['bifocal blue foto', 140], ['progresivo Ar', 80], ['Progresivo Ar foto', 120],
    ['Progresivo Blue', 140], ['progresivo blue foto', 240], ['1.67 blue', 200], ['1.67 doble asférica', 230],
    ['1.67 blue foto', 350], ['fotocromático de color', 85], ['poli Ar', 130], ['Poli Ar foto', 230],
    ['poli blue', 200], ['poli blue foto', 290], ['poli prog foto b', 300]
  ].map(([c, p]) => ({ concepto: c, precioEstimado: p }));
  const costosProduccion = [
    ['Bisel completo', 30], ['Bisel ranurado', 50], ['Bisel completo Poli', 80], ['Ranurado poli', 80],
    ['Bisel 3 pz tornillo', 80], ['Bisel 3 pz grapa', 100], ['Rebisel completo', 25], ['Rebisel ranurado', 35],
    ['Ranura', 10], ['Perforación', 15], ['Pulido de acetato', 45], ['Pulido metálico', 50],
    ['Cambio nylon', 35], ['Bisel de personaje', 150]
  ].map(([s, p]) => ({ servicio: s, precio: p }));
  const preciosLC = [
    { tipo: 'Esférico', marca: 'Alcon', precioSugerido: 300, precioReal: '', reemplazo: 'mensual' },
    { tipo: 'Esférico', marca: 'Johnson & Johnson', precioSugerido: 300, precioReal: '', reemplazo: 'mensual' },
    { tipo: 'Esférico', marca: 'CooperVision', precioSugerido: 300, precioReal: '', reemplazo: 'mensual' },
    { tipo: 'Esférico', marca: 'Bausch & Lomb', precioSugerido: 300, precioReal: '', reemplazo: 'mensual' },
    { tipo: 'Tórico', marca: 'Alcon', precioSugerido: 500, precioReal: '', reemplazo: 'mensual' },
    { tipo: 'Tórico', marca: 'Johnson & Johnson', precioSugerido: 500, precioReal: '', reemplazo: 'mensual' },
    { tipo: 'Tórico', marca: 'CooperVision', precioSugerido: 500, precioReal: '', reemplazo: 'mensual' },
    { tipo: 'Tórico', marca: 'Bausch & Lomb', precioSugerido: 500, precioReal: '', reemplazo: 'mensual' },
    { tipo: 'Cosmético', marca: 'Lunare', precioSugerido: 200, precioReal: '', reemplazo: 'mensual' },
    { tipo: 'Cosmético', marca: 'FreshLook', precioSugerido: 200, precioReal: '', reemplazo: 'mensual' }
  ];
  return {
    config: { Nombre: NEGOCIO.nombre, Sucursal: NEGOCIO.sucursal, Direccion: NEGOCIO.direccion, Telefonos: NEGOCIO.telefonos },
    armazones: [],
    preciosLentes, costosProduccion,
    conceptos: [
      { concepto: 'Rebisel completo', tipo: 'Rebisel', costoVenta: '', costoProduccion: 25 },
      { concepto: 'Rebisel ranurado', tipo: 'Rebisel', costoVenta: '', costoProduccion: 35 },
      { concepto: 'Kit de limpieza', tipo: 'Accesorio', costoVenta: '', costoAdquisicion: '' },
      { concepto: 'Cadena', tipo: 'Accesorio', costoVenta: '', costoAdquisicion: '' },
      { concepto: 'Estuche duro', tipo: 'Accesorio', costoVenta: '', costoAdquisicion: '' },
      { concepto: 'Estuche', tipo: 'Accesorio', costoVenta: '', costoAdquisicion: '' },
      { concepto: 'Microfibra', tipo: 'Accesorio', costoVenta: '', costoAdquisicion: '' }
    ],
    preciosLC,
    listas: FALLBACK_LISTAS
  };
}

/* ---------- Datos demo en memoria (nada se guarda) ---------- */
const demo = {
  clientes: [
    { id: 'CLI-0001', nombre: 'María González Pérez', fechaNac: '1990-05-12', edad: 36, telefono: '5512345678', ocupacion: 'Maestra', sexo: 'Femenino', proximaVisita: '' }
  ],
  historias: [
    { id: 'HC-0001', clienteId: 'CLI-0001', fecha: hoyISO(), usaLentes: 'sí', gradEsfOD: '-2.50', gradCilOD: '-0.50', gradEjeOD: '90', gradEsfOI: '-2.25', gradCilOI: '-0.50', gradEjeOI: '85', gradAdd: '', dnp: '62', diagnostico: 'Miopía y astigmatismo', recomendacion: 'Monofocal, Blue, Poli' }
  ],
  ventas: [
    { id: 'VTA-0001', folio: 'VTA-0001', clienteId: 'CLI-0001', clienteNombre: 'María González Pérez', telefono: '5512345678', fecha: hoyISO(), tipoVenta: 'lentes_completos', armazonMaterial: 'Metálico', armazonDiseno: 'completo', armazonModelo: 'Agatha', armazonMarca: '', armazonColor: 'Negro mate', armazonPrecioDef: 499, lenteMaterial: 'Poli', lenteDiseno: 'Monofocal', lenteTratamiento: 'Blue', lenteProveedor: 'Mia', lentePrecioDef: 200, precioDefTotal: 699, totalManual: 699, descuento: 0, costoFinalInversion: 200, costoProduccion: 30, estucheMicrofibra: 'sí', aCuenta: 200, saldo: 499, estado: 'Pendiente de entrega', graduacion: { esfOD: '-2.50', cilOD: '-0.50', ejeOD: '90', esfOI: '-2.25', cilOI: '-0.50', ejeOI: '85', add: '', dnp: '62' }, pagos: [{ fecha: hoyISO(), monto: 200, metodo: 'Efectivo', concepto: 'anticipo' }] }
  ],
  trabajos: [
    { ventaId: 'VTA-0001', clienteId: 'CLI-0001', clienteNombre: 'María González Pérez', estado: 'Pendiente de entrega', fechaEntrega: '' }
  ],
  gastos: [],
  fondo: { saldo: 30, movimientos: [{ fecha: hoyISO(), tipo: 'entrada', concepto: 'Costo de producción VTA-0001', monto: 30, saldo: 30 }] },
  cortes: [],
  correcciones: [],
  nextCliente: 2, nextVenta: 2
};

/* ---------- Llamadas al backend ---------- */
async function api(action, params) {
  params = params || {};
  if (state.demo) return demoApi(action, params);
  if (!state.url || !state.token) throw new Error('Falta configurar la URL del web app y el token.');
  let res;
  try {
    res = await fetch(state.url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(Object.assign({ token: state.token, action }, params))
    });
  } catch (e) {
    throw new Error('No se pudo conectar con el backend: ' + e.message);
  }
  let json;
  try { json = await res.json(); } catch (e) { throw new Error('El backend no devolvió JSON válido.'); }
  if (!json.ok) throw new Error(json.error || 'Error del backend');
  return json.data;
}

function demoApi(action, p) {
  switch (action) {
    case 'ping': return Promise.resolve({ version: '2.0.0-demo' });
    case 'getCatalogos': return Promise.resolve(demoCatalogs());
    case 'buscarCliente': {
      const q = (p.q || '').toLowerCase();
      return Promise.resolve(demo.clientes.filter(c => c.nombre.toLowerCase().includes(q)));
    }
    case 'getCliente': {
      const c = demo.clientes.find(x => x.id === p.id);
      if (!c) throw new Error('Cliente no encontrado (demo).');
      return Promise.resolve({ cliente: c, historias: demo.historias.filter(h => h.clienteId === p.id), ventas: demo.ventas.filter(v => v.clienteId === p.id) });
    }
    case 'crearCliente': {
      const id = 'CLI-' + String(demo.nextCliente++).padStart(4, '0');
      const c = { id, nombre: p.nombre, fechaNac: p.fechaNac, edad: edadDesde(p.fechaNac), telefono: p.telefono || '', ocupacion: p.ocupacion || '', sexo: p.sexo || '' };
      demo.clientes.push(c);
      return Promise.resolve({ id });
    }
    case 'guardarHistoria': {
      const id = 'HC-' + String(demo.historias.length + 1).padStart(4, '0');
      demo.historias.push(Object.assign({ id, fecha: hoyISO() }, p));
      return Promise.resolve({ id });
    }
    case 'crearVenta': {
      const folio = 'VTA-' + String(demo.nextVenta).padStart(4, '0');
      const id = folio;
      demo.nextVenta++;
      const total = Number(p.totalManual || 0);
      const aCuenta = p.anticipo ? Number(p.anticipo.monto || 0) : 0;
      const v = Object.assign({}, p, {
        id, folio, fecha: hoyISO(), aCuenta, saldo: total - aCuenta,
        estado: 'En proceso', pagos: p.anticipo ? [{ fecha: hoyISO(), monto: aCuenta, metodo: p.anticipo.metodo, concepto: p.anticipo.concepto }] : []
      });
      demo.ventas.push(v);
      demo.trabajos.push({ ventaId: id, clienteId: p.clienteId, clienteNombre: v.clienteNombre || '', estado: 'En proceso', fechaEntrega: '' });
      if (p.costoProduccion) {
        const m = Number(p.costoProduccion) || 0;
        demo.fondo.saldo += m;
        demo.fondo.movimientos.push({ fecha: hoyISO(), tipo: 'entrada', concepto: 'Costo de producción ' + folio, monto: m, saldo: demo.fondo.saldo });
      }
      return Promise.resolve({ ventaId: id, folio, trabajoId: id });
    }
    case 'registrarAbono': {
      const v = demo.ventas.find(x => x.id === p.ventaId);
      if (!v) throw new Error('Venta no encontrada (demo).');
      if (!(p.monto > 0) || p.monto > v.saldo) throw new Error('Monto inválido: debe ser mayor a 0 y no mayor al saldo.');
      v.aCuenta += Number(p.monto); v.saldo -= Number(p.monto);
      v.pagos.push({ fecha: hoyISO(), monto: Number(p.monto), metodo: p.metodo, concepto: p.concepto });
      if (v.saldo === 0) v.estado = 'liquidado';
      return Promise.resolve({ saldo: v.saldo });
    }
    case 'getPendientes': return Promise.resolve(demo.trabajos.filter(t => t.estado === 'Pendiente de entrega').map(t => Object.assign({}, t, { venta: demo.ventas.find(v => v.id === t.ventaId) })));
    case 'getEnProceso': return Promise.resolve(demo.trabajos.filter(t => t.estado === 'En proceso').map(t => Object.assign({}, t, { venta: demo.ventas.find(v => v.id === t.ventaId) })));
    case 'cambiarEstadoTrabajo': {
      const t = demo.trabajos.find(x => x.ventaId === p.ventaId);
      if (t) t.estado = p.estado;
      const v = demo.ventas.find(x => x.id === p.ventaId);
      if (v) v.estado = p.estado;
      return Promise.resolve({ ok: true });
    }
    case 'marcarEntregados': {
      (p.ventaIds || []).forEach(id => {
        const t = demo.trabajos.find(x => x.ventaId === id);
        if (t) { t.estado = 'Entregado'; t.fechaEntregado = hoyISO(); }
        const v = demo.ventas.find(x => x.id === id);
        if (v) v.estado = 'Entregado';
      });
      return Promise.resolve({ ok: true });
    }
    case 'getResumen': {
      const porMetodo = {};
      demo.ventas.forEach(v => (v.pagos || []).forEach(pg => { porMetodo[pg.metodo] = (porMetodo[pg.metodo] || 0) + Number(pg.monto); }));
      const cobrado = Object.values(porMetodo).reduce((a, b) => a + b, 0);
      const gastos = demo.gastos.reduce((a, g) => a + Number(g.monto), 0);
      return Promise.resolve({ ventas: demo.ventas.length, cobrado, porMetodo, gastos, fondo: demo.fondo.saldo, periodo: p.periodo });
    }
    case 'registrarGasto': {
      const g = { id: 'GAS-' + (demo.gastos.length + 1), fecha: p.fecha, concepto: p.concepto, monto: Number(p.monto), metodo: p.metodo, comprobante: p.comprobante || '' };
      demo.gastos.push(g);
      return Promise.resolve({ id: g.id });
    }
    case 'getGastos': return Promise.resolve(demo.gastos);
    case 'getFondo': return Promise.resolve(demo.fondo);
    case 'registrarSalidaFondo': {
      if (Number(p.monto) > demo.fondo.saldo) throw new Error('Saldo insuficiente en el fondo.');
      demo.fondo.saldo -= Number(p.monto);
      demo.fondo.movimientos.push({ fecha: hoyISO(), tipo: 'salida', concepto: p.concepto, monto: Number(p.monto), saldo: demo.fondo.saldo });
      return Promise.resolve({ saldo: demo.fondo.saldo });
    }
    case 'getCorteCaja': {
      const porMetodo = { efectivo: 0, tarjeta: 0, transferencia: 0, programasSociales: 0 };
      demo.ventas.forEach(v => (v.pagos || []).forEach(pg => {
        if (pg.fecha !== p.fecha) return;
        const m = String(pg.metodo).toLowerCase();
        if (m.includes('efectivo')) porMetodo.efectivo += Number(pg.monto);
        else if (m.includes('tarjeta')) porMetodo.tarjeta += Number(pg.monto);
        else if (m.includes('transferencia')) porMetodo.transferencia += Number(pg.monto);
        else if (m.includes('programa')) porMetodo.programasSociales += Number(pg.monto);
      }));
      const gastosDia = demo.gastos.filter(g => g.fecha === p.fecha).reduce((a, g) => a + Number(g.monto), 0);
      const totalCaja = porMetodo.efectivo - gastosDia;
      return Promise.resolve({ esperado: porMetodo, gastosDia, totalCaja });
    }
    case 'guardarCorteCaja': {
      demo.cortes.push({ fecha: p.fecha, contado: p.contado, diferencia: p.diferencia });
      return Promise.resolve({ id: 'CORTE-' + demo.cortes.length });
    }
    case 'corregir': {
      demo.correcciones.push({ ventaId: p.ventaId, campo: p.campo, valorAnterior: p.valorAnterior, valorNuevo: p.valorNuevo, justificacion: p.justificacion, fecha: hoyISO() });
      const v = demo.ventas.find(x => x.id === p.ventaId);
      if (v && p.campo === 'precio') v.totalManual = Number(p.valorNuevo) || v.totalManual;
      return Promise.resolve({ ok: true });
    }
    case 'getListaMateriales': {
      const abiertas = demo.ventas.filter(v => v.estado !== 'Entregado');
      return Promise.resolve({
        micas: abiertas.filter(v => v.tipoVenta !== 'accesorio').map(v => ({ folio: v.folio, cliente: v.clienteNombre, graduacion: v.graduacion, material: v.lenteMaterial || v.lcTipo || '', diseno: v.lenteDiseno || '', tratamiento: v.lenteTratamiento || '', proveedor: v.lenteProveedor || '' })),
        armazones: abiertas.filter(v => v.armazonModelo || v.armazonMaterial).map(v => ({ folio: v.folio, cliente: v.clienteNombre, material: v.armazonMaterial, diseno: v.armazonDiseno, modelo: v.armazonModelo, marca: v.armazonMarca, color: v.armazonColor }))
      });
    }
    case 'getLibroVisitas': {
      const c = demo.clientes.find(x => x.id === p.clienteId);
      return Promise.resolve({ cliente: c, historias: demo.historias.filter(h => h.clienteId === p.clienteId), ventas: demo.ventas.filter(v => v.clienteId === p.clienteId) });
    }
    case 'getVenta': {
      const v = demo.ventas.find(x => x.id === p.ventaId);
      if (!v) throw new Error('Venta no encontrada (demo).');
      const c = demo.clientes.find(x => x.id === v.clienteId);
      const h = demo.historias.filter(x => x.clienteId === v.clienteId).slice(-1)[0] || null;
      return Promise.resolve({ venta: v, cliente: c, historia: h, pagos: v.pagos || [] });
    }
    case 'getVentas': {
      // Igual que el backend (normalizar en Code.gs): sin acentos ni mayúsculas.
      const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      const q = norm(p.q || '');
      const lista = demo.ventas.slice().sort((a, b) =>
        String(b.fecha || '').localeCompare(String(a.fecha || '')) ||
        String(b.folio || '').localeCompare(String(a.folio || '')));
      const filtradas = q ? lista.filter(v =>
        norm(v.folio).includes(q) || norm(v.clienteNombre).includes(q)) : lista;
      return Promise.resolve(filtradas.slice(0, 50));
    }
    default: return Promise.reject(new Error('Acción no soportada en demo: ' + action));
  }
}

/* ---------- Catálogos: listas para los desplegables ---------- */
function lista(nombre) {
  const l = state.catalogs && state.catalogs.listas;
  if (l) {
    if (Array.isArray(l[nombre])) return l[nombre];
    if (Array.isArray(l)) { // formato [{Lista, Valor}] del Sheet
      return l.filter(r => r.Lista === nombre || r.lista === nombre).map(r => r.Valor || r.valor);
    }
  }
  return FALLBACK_LISTAS[nombre] || [];
}
function fillSelect(el, values, placeholder, fmtEtiqueta) {
  if (!el) return;
  const cur = el.value;
  el.innerHTML = '';
  if (placeholder) { const o = document.createElement('option'); o.value = ''; o.textContent = placeholder; el.appendChild(o); }
  (values || []).forEach(v => {
    const o = document.createElement('option');
    // fmtEtiqueta formatea solo la etiqueta que se ve (el valor que se
    // guarda queda tal cual): así los dropdowns de graduación muestran
    // -2.00 / +2.50 aunque el Sheet devuelva el número -2 o 2.5.
    o.value = String(v); o.textContent = fmtEtiqueta ? fmtEtiqueta(v) : String(v);
    el.appendChild(o);
  });
  if (cur && Array.from(el.options).some(o => o.value === cur)) el.value = cur;
}
function fillRxSelects() {
  const esf = lista('Esfera'), cil = lista('Cilindro'), eje = lista('Eje'), add = lista('Add');
  $$('.lens-esf-od, .lens-esf-oi').forEach(s => fillSelect(s, esf, 'Esf', fmtGrad));
  $$('.lens-cil-od, .lens-cil-oi').forEach(s => fillSelect(s, cil, 'Cil', fmtGrad));
  $$('.lens-eje-od, .lens-eje-oi').forEach(s => fillSelect(s, eje, 'Eje'));
  ['#gradEsfOd', '#gradEsfOi'].forEach(s => fillSelect($(s), esf, 'Esf', fmtGrad));
  ['#gradCilOd', '#gradCilOi'].forEach(s => fillSelect($(s), cil, 'Cil', fmtGrad));
  ['#gradEjeOd', '#gradEjeOi'].forEach(s => fillSelect($(s), eje, 'Eje'));
  fillSelect($('#lensAdd'), add, 'Add', fmtGrad);
  fillSelect($('#gradAdd'), add, 'Add', fmtGrad);
}
function fillCatalogSelects() {
  fillSelect($('#armMaterial'), lista('Material_Armazon'), '—');
  fillSelect($('#armDiseno'), lista('Diseno_Armazon'), '—');
  fillSelect($('#lenteMaterial'), lista('Material_Lente'), '—');
  fillSelect($('#lenteDiseno'), lista('Diseno_Lente'), '—');
  fillSelect($('#lenteTratamiento'), lista('Tratamiento'), '—');
  fillSelect($('#lenteProveedor'), lista('Proveedor'), '—');
  fillSelect($('#hcMotivo'), lista('Motivo'), '—');
  fillSelect($('#lensDiseno'), lista('Diseno_Lente'), '—');
  fillSelect($('#pMetodo'), lista('Metodo_Pago'), '—');
  fillSelect($('#gastoMetodo'), lista('Metodo_Pago'), '—');
  fillSelect($('#abonoMetodo'), lista('Metodo_Pago'), '—');
  fillSelect($('#abMetodo'), lista('Metodo_Pago'), '—');
  const costos = (state.catalogs && state.catalogs.costosProduccion) || [];
  fillSelect($('#pCostoProd'), costos.map(c => (c.servicio || c.Servicio) + ' — $' + (c.precio || c.Precio)), '—');
  const precios = (state.catalogs && state.catalogs.preciosLentes) || [];
  fillSelect($('#lenteConcepto'), precios.map(c => (c.concepto || c.Concepto) + ' — $' + (c.precioEstimado || c.Precio_Estimado || '')), '—');
  fillSelect($('#lcMarca'), MARCAS_LC_PRESTIGIO, '—');
  // Agudeza visual: 6 selects (sin/con × OD/OI/AO)
  const av = $('#avGrid');
  if (av && !av.children.length) {
    [['Sin Rx · O.D.', 'avSinOd'], ['Sin Rx · O.I.', 'avSinOi'], ['Sin Rx · A/O', 'avSinAo'],
     ['Con Rx · O.D.', 'avConOd'], ['Con Rx · O.I.', 'avConOi'], ['Con Rx · A/O', 'avConAo']].forEach(([label, id]) => {
      const lab = document.createElement('label');
      lab.textContent = label;
      const sel = document.createElement('select');
      sel.id = id;
      lab.appendChild(sel);
      av.appendChild(lab);
      fillSelect(sel, lista('Agudeza visual'), '—');
    });
  }
}
async function loadCatalogs() {
  try {
    state.catalogs = await api('getCatalogos');
  } catch (e) {
    showError('No se pudieron cargar los catálogos: ' + e.message + ' Se usan las listas del contrato como respaldo.');
    state.catalogs = demoCatalogs();
  }
  fillRxSelects();
  fillCatalogSelects();
}

/* ---------- Navegación ---------- */
const VIEWS = ['setup', 'home', 'nueva-venta', 'buscar-cliente', 'libro-visitas', 'pendientes', 'en-proceso', 'ventas', 'resumen', 'lista-materiales', 'catalogos', 'venta', 'doc', 'abono', 'ordenes'];
function show(view) {
  VIEWS.forEach(v => { const el = $('#view-' + v); if (el) el.hidden = (v !== view); });
  window.scrollTo(0, 0);
  actualizarNav(view);
  // v2.1 punto 8: en configuración, "Volver al panel" solo si la app
  // ya está configurada (si nunca se configuró no hay panel al que volver).
  if (view === 'setup') {
    const bs = $('#btnSetupBack');
    if (bs) bs.hidden = !(state.url || state.token || state.demo);
  }
  if (view === 'pendientes') cargarPendientes();
  if (view === 'en-proceso') cargarEnProceso();
  if (view === 'ordenes') cargarOrdenes();
  if (view === 'ventas') cargarVentas();
  if (view === 'resumen') { $('#gastoFecha').value = hoyISO(); $('#corteFecha').value = hoyISO(); cargarResumen(); cargarFondo(); }
  if (view === 'lista-materiales') cargarMateriales();
  if (view === 'catalogos') cargarCatalogosView();
}
function goHome() { show('home'); }

/* ---------- Menú inferior: estado activo + ocultar en configuración ---------- */
function actualizarNav(view) {
  const nav = $('#bottomNav');
  if (!nav) return;
  nav.hidden = (view === 'setup');
  // El ítem activo es el que tiene data-nav igual a la vista actual;
  // las vistas sin ítem propio (buscar-cliente, libro-visitas, abono,
  // venta, doc, catálogos, ordenes) dejan el menú sin activo.
  $$('.nav-item, .nav-fab', nav).forEach(b => b.classList.toggle('active', b.dataset.nav === view));
}

/* ---------- Asistente de nueva venta ---------- */
function setStep(n) {
  state.wizard.step = n;
  $$('#wizardSteps li').forEach(li => {
    const s = Number(li.dataset.step);
    li.classList.toggle('active', s === n);
    li.classList.toggle('done', s < n);
  });
  $$('[data-step-panel]').forEach(p => { p.hidden = Number(p.dataset.stepPanel) !== n; });
  $('#btnWizardBack').disabled = (n === 1);
  $('#btnWizardNext').textContent = (n === 6) ? 'Terminar' : 'Siguiente →';
  if (n === 5) actualizarPrecios();
  if (n === 6) renderConfirmacion();
}
function wizardNext() {
  const n = state.wizard.step;
  if (n === 1 && !state.wizard.cliente) { showError('Elige o crea un cliente para continuar.', $('#wizardError')); return; }
  if (n === 2) { if (!guardarHistoriaLocal()) return; }
  if (n === 3) { aplicarTipoVenta(); }
  if (n === 6) { goHome(); return; }
  $('#wizardError').hidden = true;
  setStep(n + 1);
}
function wizardBack() { if (state.wizard.step > 1) setStep(state.wizard.step - 1); }

function seleccionarCliente(c) {
  state.wizard.cliente = c;
  const p = $('#nvClienteSel');
  p.textContent = 'Cliente seleccionado: ' + c.nombre + ' (' + c.id + ')' + (c.edad ? ' · ' + c.edad + ' años' : '');
  p.hidden = false;
}
async function buscarClienteNv() {
  const q = $('#nvBuscar').value.trim();
  if (!q) return;
  try {
    const res = await buscarClienteAPI(q);
    const box = $('#nvResultados');
    box.innerHTML = res.length ? '' : '<p class="hint">Sin resultados. Crea el cliente nuevo abajo.</p>';
    res.forEach(c => {
      const d = document.createElement('div');
      d.className = 'list-item';
      d.innerHTML = '<strong>' + esc(c.nombre) + '</strong><small>' + esc(c.id || '') + ' · ' + esc(c.telefono || '') + '</small>';
      const b = document.createElement('button');
      b.className = 'btn btn-secondary'; b.type = 'button'; b.textContent = 'Usar este cliente';
      b.onclick = () => seleccionarCliente(c);
      d.appendChild(b);
      box.appendChild(d);
    });
  } catch (e) { showError('Error al buscar: ' + e.message, $('#wizardError')); }
}
async function crearClienteNv() {
  const nombre = $('#nvNombre').value.trim();
  const fechaNac = $('#nvFechaNac').value;
  if (!nombre || !fechaNac) { showError('Nombre y fecha de nacimiento son obligatorios.', $('#wizardError')); return; }
  try {
    const r = await api('crearCliente', { nombre, fechaNac, telefono: $('#nvTelefono').value.trim(), ocupacion: $('#nvOcupacion').value.trim(), sexo: $('#nvSexo').value });
    seleccionarCliente({ id: r.id, nombre, fechaNac, edad: edadDesde(fechaNac), telefono: $('#nvTelefono').value.trim(), ocupacion: $('#nvOcupacion').value.trim(), sexo: $('#nvSexo').value });
    showOk('Cliente creado: ' + r.id, $('#nvClienteSel'));
  } catch (e) { showError('No se pudo crear el cliente: ' + e.message, $('#wizardError')); }
}
function guardarHistoriaLocal() {
  const h = {
    usaLentes: $('#hcUsaLentes').value,
    lensEsfOD: $('.lens-esf-od').value, lensCilOD: $('.lens-cil-od').value, lensEjeOD: $('.lens-eje-od').value,
    lensEsfOI: $('.lens-esf-oi').value, lensCilOI: $('.lens-cil-oi').value, lensEjeOI: $('.lens-eje-oi').value,
    lensTratamientos: $('#lensTrat').value.trim(), lensDiseno: $('#lensDiseno').value, lensAdd: $('#lensAdd').value, lensDnp: $('#lensDnp').value,
    motivo: $('#hcMotivo').value,
    antTipo: $('#antTipo').value, antDiabetes: $('#antDiabetes').checked, antHipertension: $('#antHipertension').checked, antMigrana: $('#antMigrana').checked,
    avSinOD: $('#avSinOd') && $('#avSinOd').value, avSinOI: $('#avSinOi') && $('#avSinOi').value, avSinAO: $('#avSinAo') && $('#avSinAo').value,
    avConOD: $('#avConOd') && $('#avConOd').value, avConOI: $('#avConOi') && $('#avConOi').value, avConAO: $('#avConAo') && $('#avConAo').value,
    gradEsfOD: $('#gradEsfOd').value, gradCilOD: $('#gradCilOd').value, gradEjeOD: $('#gradEjeOd').value,
    gradEsfOI: $('#gradEsfOi').value, gradCilOI: $('#gradCilOi').value, gradEjeOI: $('#gradEjeOi').value,
    gradAdd: $('#gradAdd').value, dnp: $('#gradDnp').value,
    diagnostico: $('#hcDiagnostico').value.trim(), indicaciones: $('#hcIndicaciones').value.trim(), recomendacion: $('#hcRecomendacion').value.trim()
  };
  if (!h.gradEsfOD && !h.gradEsfOI && !h.motivo) {
    showError('Captura al menos la graduación del examen o el motivo de consulta.', $('#wizardError'));
    return false;
  }
  state.wizard.historia = h;
  $('#lenteDnpEcho').textContent = h.dnp ? h.dnp + ' mm' : '—';
  return true;
}
function aplicarTipoVenta() {
  const tipo = (document.querySelector('input[name="tipoVenta"]:checked') || {}).value || 'lentes_completos';
  // El interruptor de LC solo "nace" con su valor por defecto cuando
  // cambia el tipo de venta; si aplicarTipoVenta se vuelve a llamar con
  // el mismo tipo (p. ej. al pulsar "Siguiente" en el paso 3), se
  // conserva lo que Alfredo ya eligió en el interruptor.
  const cambioTipo = tipo !== state.wizard.tipoVenta;
  state.wizard.tipoVenta = tipo;
  state.wizard.conArmazonLC = $('#lcConArmazon').checked;
  if (cambioTipo) {
    // Lente de contacto nace activado; en lentes completos nace apagado
    // (promoción: Alfredo lo enciende si vende LC con el armazón);
    // en rebisel / accesorio queda apagado y oculto.
    state.wizard.llevaLC = (tipo === 'lente_contacto');
    const sw = $('#lcSwitch');
    if (sw) sw.checked = state.wizard.llevaLC;
  }
  const llevaLC = !!state.wizard.llevaLC;
  $('#lcSwitchWrap').hidden = !(tipo === 'lentes_completos' || tipo === 'lente_contacto');
  $('#fsArmazon').hidden = !(tipo === 'lentes_completos' || tipo === 'rebisel' || (tipo === 'lente_contacto' && state.wizard.conArmazonLC));
  $('#lcConArmazonWrap').hidden = (tipo !== 'lente_contacto');
  $('#fsRebisel').hidden = (tipo !== 'rebisel');
  $('#fsAccesorio').hidden = (tipo !== 'accesorio');
  $('#fsLC').hidden = !llevaLC;
  const llevaLente = (tipo === 'lentes_completos' || tipo === 'rebisel');
  $('#fsLente').hidden = !llevaLente;
  $('#lenteSkipMsg').hidden = llevaLente;
  if (tipo === 'lente_contacto') actualizarMarcasLC();
}
/* Interruptor "Lente de contacto" (paso 3, Fase 4): controla todo lo
   de LC — solo con el interruptor activado aparecen los campos de LC y
   solo entonces sus datos van en el payload y en los documentos. */
function aplicarInterruptorLC() {
  state.wizard.llevaLC = $('#lcSwitch').checked;
  $('#fsLC').hidden = !state.wizard.llevaLC;
  if (state.wizard.llevaLC) actualizarMarcasLC();
}
function actualizarMarcasLC() {
  const tipo = $('#lcTipo').value;
  const marcas = tipo === 'Cosmético' ? MARCAS_LC_COSMETICO : MARCAS_LC_PRESTIGIO;
  fillSelect($('#lcMarca'), marcas, '—');
  // Precio sugerido de la lista de LC (precio real si existe, si no el sugerido)
  const pl = (state.catalogs && state.catalogs.preciosLC) || [];
  const fila = pl.find(r => (r.tipo || r.Tipo) === tipo && marcas.includes(r.marca || r.Marca));
  if (fila) {
    const real = fila.precioReal || fila.Precio_Real;
    const sug = fila.precioSugerido || fila.Precio_Sugerido;
    $('#lcPrecio').value = real !== '' && real != null ? real : (sug || '');
  }
}
function precioDefinidoTotal() {
  const tipo = state.wizard.tipoVenta;
  let arm = 0, len = 0, lc = 0;
  if (tipo === 'lentes_completos' || tipo === 'rebisel' || (tipo === 'lente_contacto' && state.wizard.conArmazonLC)) arm = Number($('#armPrecio').value || 0);
  if (tipo === 'lentes_completos' || tipo === 'rebisel') len = Number($('#lentePrecio').value || 0);
  // Lente de contacto: en venta de LC su precio va en `len` (es el
  // "lente / LC" del paso 5); en lentes completos con el interruptor
  // activado se suma aparte al total definido.
  if (tipo === 'lente_contacto') len = Number($('#lcPrecio').value || 0);
  else if (state.wizard.llevaLC) lc = Number($('#lcPrecio').value || 0);
  if (tipo === 'rebisel') { arm = Number($('#rebiselPrecio').value || 0); len = 0; }
  if (tipo === 'accesorio') { arm = Number($('#accPrecio').value || 0); len = 0; }
  return { arm, len, lc, total: arm + len + lc };
}
function actualizarPrecios() {
  const d = precioDefinidoTotal();
  $('#pArmazon').value = d.arm.toFixed(2);
  $('#pLente').value = d.len.toFixed(2);
  $('#pTotalDef').value = d.total.toFixed(2);
  const manual = Number($('#pTotalManual').value || 0);
  $('#pDescuento').value = (d.total - manual).toFixed(2);
  const aCuenta = Number($('#pACuenta').value || 0);
  $('#pSaldo').textContent = money(manual - aCuenta);
}
function renderConfirmacion() {
  const c = state.wizard.cliente, h = state.wizard.historia, tipo = state.wizard.tipoVenta;
  const d = precioDefinidoTotal();
  const manual = Number($('#pTotalManual').value || 0);
  const tipoTxt = { lentes_completos: 'Lentes completos (armazón + lente)', rebisel: 'Rebisel', accesorio: 'Accesorio', lente_contacto: 'Lente de contacto' }[tipo];
  // Fase 4: si la venta lleva lente y la graduación está vacía (el
  // wizard permite avanzar solo con el motivo de consulta), avisar
  // aquí en vez de descubrirlo después en la orden de trabajo.
  const llevaLente = tipo !== 'accesorio';
  const avisoGrad = (llevaLente && historiaSinGraduacion(h))
    ? '<p class="error"><strong>⚠ Esta venta lleva lente pero la graduación está vacía.</strong> La orden de trabajo saldrá con el aviso "Graduación no registrada". Si ya tienes la graduación, vuelve al paso 2 y captúrala en la historia clínica.</p>' : '';
  $('#confirmResumen').innerHTML = avisoGrad +
    '<table><tr><th>Cliente</th><td>' + esc(c ? c.nombre : '—') + '</td></tr>' +
    '<tr><th>Tipo de venta</th><td>' + esc(tipoTxt) + '</td></tr>' +
    (state.wizard.llevaLC ? '<tr><th>Lente de contacto</th><td>' + esc($('#lcTipo').value) + ' · ' + esc($('#lcMarca').value || '') + ' (caja de 6) · ' + money($('#lcPrecio').value || 0) + '</td></tr>' : '') +
    '<tr><th>Graduación OD</th><td>Esf ' + esc(fmtGrad(h.gradEsfOD)) + ' · Cil ' + esc(fmtGrad(h.gradCilOD)) + ' · Eje ' + esc(h.gradEjeOD || '—') + '</td></tr>' +
    '<tr><th>Graduación OI</th><td>Esf ' + esc(fmtGrad(h.gradEsfOI)) + ' · Cil ' + esc(fmtGrad(h.gradCilOI)) + ' · Eje ' + esc(h.gradEjeOI || '—') + '</td></tr>' +
    '<tr><th>Add / DNP</th><td>' + esc(fmtGrad(h.gradAdd)) + ' / ' + esc(h.dnp || '—') + '</td></tr>' +
    '<tr><th>Precio definido</th><td>' + money(d.total) + '</td></tr>' +
    '<tr><th>Total manual</th><td>' + money(manual) + '</td></tr>' +
    '<tr><th>Descuento</th><td>' + money(d.total - manual) + '</td></tr>' +
    '<tr><th>A cuenta</th><td>' + money($('#pACuenta').value || 0) + ' (' + esc($('#pMetodo').value || '') + ' · ' + esc($('#pConcepto').value || '') + ')</td></tr>' +
    '<tr><th>Saldo</th><td>' + money(manual - Number($('#pACuenta').value || 0)) + '</td></tr></table>';
}
function costoProduccionSeleccionado() {
  const sel = $('#pCostoProd');
  if (!sel || !sel.value) return 0;
  const m = sel.value.match(/\$([\d.]+)/);
  return m ? Number(m[1]) : 0;
}
async function guardarVenta() {
  const c = state.wizard.cliente, h = state.wizard.historia;
  if (!c || !h) { showError('Falta cliente o historia clínica.', $('#wizardError')); return; }
  const tipo = state.wizard.tipoVenta;
  const d = precioDefinidoTotal();
  const totalManual = Number($('#pTotalManual').value || 0);
  if (!(totalManual > 0)) { showError('Captura el total manual de la venta.', $('#wizardError')); return; }
  const aCuenta = Number($('#pACuenta').value || 0);
  // Fase 4: los datos de LC solo van en el payload si el interruptor
  // está activado. Antes se mandaba siempre lcTipo ('Esférico' por
  // defecto) y por eso ventas sin LC quedaban guardadas con LC_Tipo
  // 'Esférico' y LC_Precio_Def 0 (VTA-0001).
  const llevaLC = !!state.wizard.llevaLC;
  const payload = {
    clienteId: c.id, clienteNombre: c.nombre, telefono: c.telefono || '',
    tipoVenta: tipo,
    armazonMaterial: $('#armMaterial').value, armazonDiseno: $('#armDiseno').value,
    armazonModelo: $('#armModelo').value.trim(), armazonMarca: $('#armMarca').value.trim(),
    armazonColor: $('#armColor').value.trim(), armazonPrecioDef: d.arm,
    lenteMaterial: $('#lenteMaterial').value, lenteDiseno: $('#lenteDiseno').value,
    lenteTratamiento: $('#lenteTratamiento').value + ($('#filtroTonoWrap').hidden ? '' : ' filtro tono ' + $('#filtroTono').value),
    lenteProveedor: $('#lenteProveedor').value, lentePrecioDef: d.len,
    lcTipo: llevaLC ? $('#lcTipo').value : '', lcMarca: llevaLC ? $('#lcMarca').value : '',
    lcCurvaBase: llevaLC ? $('#lcCurvaBase').value.trim() : '',
    lcDiametro: llevaLC ? $('#lcDiametro').value.trim() : '',
    lcPrecioDef: llevaLC ? Number($('#lcPrecio').value || 0) : '',
    rebiselConcepto: $('#rebiselConcepto').value, accesorioDesc: $('#accDesc').value,
    precioDefTotal: d.total, totalManual, descuento: d.total - totalManual,
    costoFinalInversion: Number($('#pCostoInversion').value || 0),
    costoProduccion: costoProduccionSeleccionado(),
    estucheMicrofibra: tipo === 'lentes_completos' ? 'sí' : 'no',
    graduacion: { esfOD: h.gradEsfOD, cilOD: h.gradCilOD, ejeOD: h.gradEjeOD, esfOI: h.gradEsfOI, cilOI: h.gradCilOI, ejeOI: h.gradEjeOI, add: h.gradAdd, dnp: h.dnp }
  };
  if (aCuenta > 0) payload.anticipo = { monto: aCuenta, metodo: $('#pMetodo').value, concepto: $('#pLiquidar').checked ? 'liquidación' : $('#pConcepto').value };
  try {
    // La historia clínica se guarda primero (una sola vez) y luego la venta.
    await api('guardarHistoria', Object.assign({ clienteId: c.id }, h));
    const r = await api('crearVenta', payload);
    state.currentVentaId = r.ventaId;
    const ok = $('#ventaGuardada');
    ok.textContent = 'Venta guardada: folio ' + r.folio + ' · ' + (aCuenta >= totalManual ? 'Liquidada' : 'Saldo ' + money(totalManual - aCuenta)) + '. Próxima visita en 10 meses.';
    ok.hidden = false;
    $('#docsAfterSave').hidden = false;
    $('#btnGuardarVenta').disabled = true;
  } catch (e) {
    showError('No se pudo guardar la venta: ' + e.message, $('#wizardError'));
  }
}

/* ---------- Buscar cliente / Libro de visitas ---------- */
function clienteItemHTML(c) {
  return '<strong>' + esc(c.nombre) + '</strong><small>' + esc(c.id || '') + ' · ' + esc(c.telefono || '') + (c.edad ? ' · ' + c.edad + ' años' : '') + '</small>';
}
/* Búsqueda de clientes con respaldo local (v2.3.2): el backend
   `buscarCliente` tenía un bug — filtraba por `c.Nombre` pero paraJson
   entrega la clave en minúscula (`nombre`), así que siempre devolvía
   vacío y Buscar cliente / Libro de visitas decían "Sin resultados".
   La corrección del backend (Code.gs) requiere redesplegar; mientras
   tanto, si la búsqueda no trae nada se piden los primeros 50 clientes
   y se filtran aquí mismo, así la búsqueda funciona solo con subir la
   PWA a GitHub. */
const normTxt = s => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
async function buscarClienteAPI(q) {
  q = (q || '').trim();
  let res = await api('buscarCliente', { q });
  if ((!res || !res.length) && q) {
    const todos = await api('buscarCliente', { q: '' });
    const nq = normTxt(q);
    res = (todos || []).filter(c => normTxt(c.nombre).includes(nq));
  }
  return res || [];
}
async function buscarClientes(q, boxEl, onPick) {
  if (!q) return;
  try {
    const res = await buscarClienteAPI(q);
    boxEl.innerHTML = res.length ? '' : '<p class="hint">Sin resultados.</p>';
    res.forEach(c => {
      const d = document.createElement('div');
      d.className = 'list-item';
      d.innerHTML = clienteItemHTML(c);
      const b = document.createElement('button');
      b.className = 'btn btn-secondary'; b.type = 'button'; b.textContent = 'Ver ficha';
      b.onclick = () => onPick(c);
      d.appendChild(b);
      boxEl.appendChild(d);
    });
  } catch (e) { showError('Error al buscar: ' + e.message); }
}
/* ---------- Qué compró / cuánto pagó / cómo lo pagó (Fase 2) ----------
   Se usa en la vista Ventas, en la ficha del cliente y en el Libro de
   visitas. Los métodos de pago salen del arreglo `pagos` de la venta
   (lo traen getVentas y getCliente); si la venta no trae `pagos`, la
   línea "Cómo:" simplemente no se muestra (nunca se inventa). */
const TIPOS_VENTA = { lentes_completos: 'Lentes completos', rebisel: 'Rebisel', accesorio: 'Accesorio', lente_contacto: 'Lente de contacto' };
function tipoVentaTexto(t) { return TIPOS_VENTA[t] || t || ''; }
function queComproHTML(v) {
  const partes = [];
  const arm = [v.armazonModelo, v.armazonMarca, v.armazonMaterial, v.armazonDiseno].filter(Boolean).join(' · ');
  if (arm) partes.push('Armazón: ' + arm + (v.armazonColor ? ' · color ' + v.armazonColor : ''));
  const len = [v.lenteMaterial, v.lenteDiseno, v.lenteTratamiento].filter(Boolean).join(' · ');
  if (len) partes.push('Lente: ' + len + (v.lenteProveedor ? ' · Prov. ' + v.lenteProveedor : ''));
  if (llevaLC(v)) partes.push('LC: ' + [v.lcTipo, v.lcMarca].filter(Boolean).join(' · ') + ' (caja de 6)');
  if (v.tipoVenta === 'rebisel' && v.rebiselConcepto) partes.push('Rebisel: ' + v.rebiselConcepto);
  if (v.tipoVenta === 'accesorio' && v.accesorioDesc) partes.push('Accesorio: ' + v.accesorioDesc);
  if (!partes.length) return '';
  return '<small><strong>Compró:</strong> ' + esc(partes.join(' · ')) + '</small>';
}
function metodosDePago(v) {
  const vistos = [];
  (v.pagos || []).forEach(p => {
    const m = p.metodo || '';
    if (m && vistos.indexOf(m) === -1) vistos.push(m);
  });
  return vistos;
}
function metodosChipsHTML(v) {
  const metodos = metodosDePago(v);
  if (!metodos.length) return '';
  return '<small><strong>Cómo:</strong> ' + metodos.map(m => '<span class="chip chip-metodo">' + esc(m) + '</span>').join(' ') + '</small>';
}
function estadoChipHTML(estado) {
  const e = String(estado || '');
  if (!e) return '';
  const cerrado = /liquid|entreg/i.test(e);
  return '<span class="chip ' + (cerrado ? 'chip-estado-ok' : 'chip-estado-pend') + '">' + esc(e) + '</span>';
}
function pagoLineaHTML(p) {
  return '<p><small>' + fechaMX(p.fecha) + ' · ' + money(p.monto) + ' · ' + esc(p.concepto || '') + '</small>' +
    (p.metodo ? ' <span class="chip chip-metodo">' + esc(p.metodo) + '</span>' : '') + '</p>';
}
function ventaResumenHTML(v) {
  return '<div class="list-item venta-card">' +
    '<div class="row venta-head"><strong>' + esc(v.folio || v.id) + '</strong>' +
    (v.clienteNombre ? '<span>' + esc(v.clienteNombre) + '</span>' : '') +
    '<span>' + fechaMX(v.fecha) + '</span>' + estadoChipHTML(v.estado) + '</div>' +
    '<div class="venta-lineas">' + (queComproHTML(v) || '<small>' + esc(tipoVentaTexto(v.tipoVenta)) + '</small>') + '</div>' +
    '<div class="venta-lineas"><small><strong>Pagó:</strong> ' + money(v.aCuenta) + ' de ' + money(v.totalManual) + ' · <strong>Saldo:</strong> ' + money(v.saldo) + '</small>' +
    metodosChipsHTML(v) + '</div>' +
    '<div class="row"><button class="btn btn-secondary" type="button" data-open-venta="' + esc(v.id) + '">Ver ficha</button>' +
    '<button class="btn btn-secondary" type="button" data-doc-venta="' + esc(v.id) + '" data-doc="ticket">Ticket</button>' +
    '<button class="btn btn-secondary" type="button" data-doc-venta="' + esc(v.id) + '" data-doc="comprobante">Comprobante</button></div></div>';
}
async function mostrarFichaCliente(c) {
  try {
    const d = await api('getCliente', { id: c.id });
    state.currentClienteId = c.id;
    const box = $('#bcFicha');
    const prox = d.cliente.proximaVisita ? '<p><strong>Próxima visita:</strong> ' + fechaMX(d.cliente.proximaVisita) + '</p>' : '';
    box.innerHTML = '<div class="card"><h3>' + esc(d.cliente.nombre) + '</h3>' +
      '<p>' + esc(d.cliente.id || '') + ' · ' + esc(d.cliente.telefono || '') + ' · ' + esc(d.cliente.ocupacion || '') + ' · ' + esc(d.cliente.sexo || '') + '</p>' + prox +
      '<h4>Historias clínicas (' + d.historias.length + ')</h4>' +
      (d.historias.map(h => '<p><small>' + fechaMX(h.fecha) + ' — Grad. OD Esf ' + esc(fmtGrad(h.gradEsfOD || h.grad_esf_od)) + ' / OI Esf ' + esc(fmtGrad(h.gradEsfOI || h.grad_esf_oi)) + ' — ' + esc(h.diagnostico || h.Diagnostico || '') + '</small></p>').join('') || '<p class="hint">Sin historias registradas.</p>') +
      '<h4>Ventas (' + d.ventas.length + ')</h4><div class="list">' + (d.ventas.map(ventaResumenHTML).join('') || '<p class="hint">Sin ventas.</p>') + '</div></div>';
    wireVentaButtons(box);
  } catch (e) { showError('No se pudo cargar la ficha: ' + e.message); }
}
async function mostrarExpediente(c) {
  try {
    const d = await api('getLibroVisitas', { clienteId: c.id });
    const box = $('#lvExpediente');
    box.innerHTML = '<div class="card"><h3>Expediente · ' + esc(d.cliente.nombre) + '</h3>' +
      '<p>' + esc(d.cliente.id || '') + ' · Nac. ' + fechaMX(d.cliente.fechaNac) + ' (' + esc(String(d.cliente.edad || '')) + ' años) · ' + esc(d.cliente.telefono || '') + '</p>' +
      '<h4>Visitas e historial de graduación</h4>' +
      (d.historias.map(h => '<div class="list-item"><strong>' + fechaMX(h.fecha) + '</strong><small>Graduación OD: Esf ' + esc(fmtGrad(h.gradEsfOD)) + ' Cil ' + esc(fmtGrad(h.gradCilOD)) + ' Eje ' + esc(h.gradEjeOD || '—') + ' · OI: Esf ' + esc(fmtGrad(h.gradEsfOI)) + ' Cil ' + esc(fmtGrad(h.gradCilOI)) + ' Eje ' + esc(h.gradEjeOI || '—') + ' · Add ' + esc(fmtGrad(h.gradAdd)) + ' · DNP ' + esc(h.dnp || '—') + '</small><small>Diagnóstico: ' + esc(h.diagnostico || '') + ' · Recomendación: ' + esc(h.recomendacion || '') + '</small><div class="row"><button class="btn btn-secondary" type="button" data-doc-historia="' + esc(h.id || '') + '">Ver historia clínica</button></div></div>').join('') || '<p class="hint">Sin visitas registradas.</p>') +
      '<h4>Ventas</h4><div class="list">' + (d.ventas.map(ventaResumenHTML).join('') || '<p class="hint">Sin ventas.</p>') + '</div></div>';
    wireVentaButtons(box);
    $$('[data-doc-historia]', box).forEach(b => b.onclick = () => abrirDoc('historia', null, { historiaId: b.dataset.docHistoria, clienteId: c.id }));
  } catch (e) { showError('No se pudo cargar el expediente: ' + e.message); }
}
function wireVentaButtons(root) {
  $$('[data-open-venta]', root).forEach(b => b.onclick = () => abrirFichaVenta(b.dataset.openVenta));
  $$('[data-doc-venta]', root).forEach(b => b.onclick = () => abrirDoc(b.dataset.doc, b.dataset.docVenta));
}

/* ---------- Pendientes / En proceso ---------- */
async function cargarPendientes() {
  const box = $('#pendList');
  box.innerHTML = '<p class="hint">Cargando…</p>';
  try {
    const items = await api('getPendientes');
    state.pendientesSel = new Set();
    if (!items.length) { box.innerHTML = '<p class="hint">No hay trabajos pendientes de entrega.</p>'; return; }
    box.innerHTML = '';
    items.forEach(t => {
      const v = t.venta || {};
      const d = document.createElement('div');
      d.className = 'list-item';
      const tel = String(v.telefono || t.telefono || '').replace(/\D/g, '');
      d.innerHTML = '<label class="check"><input type="checkbox" data-pend="' + esc(t.ventaId) + '"> <strong>' + esc(v.folio || t.ventaId) + '</strong> · ' + esc(v.clienteNombre || t.clienteNombre || '') + '</label>' +
        '<div class="venta-lineas">' + (queComproHTML(v) || '<small>' + esc(tipoVentaTexto(v.tipoVenta)) + '</small>') + '</div>' +
        '<div class="venta-lineas"><small>Total ' + money(v.totalManual) + ' · Pagado ' + money(v.aCuenta) + ' · Saldo ' + money(v.saldo) + '</small>' + metodosChipsHTML(v) + '</div>' +
        '<div class="venta-lineas"><small>Estado: ' + esc(v.estado || t.estado || '') + '</small></div>' +
        '<div class="row">' +
        (tel ? '<a class="btn btn-secondary" href="https://wa.me/52' + tel + '?text=' + encodeURIComponent('Hola, le avisamos de Boutique de Lentes Yael (' + NEGOCIO.sucursal + ') que su trabajo ' + (v.folio || '') + ' ya está listo para recoger. ¡Gracias por su preferencia!') + '" target="_blank" rel="noopener">Avisar por WhatsApp</a>' : '<span class="hint">Sin teléfono para avisar.</span>') +
        '<button class="btn btn-secondary" type="button" data-open-venta="' + esc(t.ventaId) + '">Ver ficha</button></div>';
      box.appendChild(d);
    });
    $$('[data-pend]', box).forEach(cb => cb.onchange = () => { cb.checked ? state.pendientesSel.add(cb.dataset.pend) : state.pendientesSel.delete(cb.dataset.pend); });
    wireVentaButtons(box);
  } catch (e) { box.innerHTML = ''; showError('No se pudieron cargar los pendientes: ' + e.message); }
}
async function marcarEntregados() {
  if (!state.pendientesSel.size) { showError('Selecciona al menos un trabajo con el check.'); return; }
  try {
    await api('marcarEntregados', { ventaIds: Array.from(state.pendientesSel) });
    showOk('Trabajos marcados como entregados.', $('#pendMsg'));
    cargarPendientes();
  } catch (e) { showError('No se pudo marcar entregados: ' + e.message); }
}
async function cargarEnProceso() {
  const box = $('#procList');
  box.innerHTML = '<p class="hint">Cargando…</p>';
  try {
    const items = await api('getEnProceso');
    if (!items.length) { box.innerHTML = '<p class="hint">No hay trabajos en proceso.</p>'; return; }
    box.innerHTML = '';
    items.forEach(t => {
      const v = t.venta || {};
      const d = document.createElement('div');
      d.className = 'list-item';
      d.innerHTML = '<strong>' + esc(v.folio || t.ventaId) + '</strong> · ' + esc(v.clienteNombre || t.clienteNombre || '') +
        '<div class="venta-lineas">' + (queComproHTML(v) || '<small>' + esc(tipoVentaTexto(v.tipoVenta)) + '</small>') + '</div>' +
        '<div class="venta-lineas"><small>Total ' + money(v.totalManual) + ' · Pagado ' + money(v.aCuenta) + ' · Saldo ' + money(v.saldo) + '</small>' + metodosChipsHTML(v) + '</div>' +
        '<div class="row"><button class="btn btn-primary" type="button" data-a-listo="' + esc(t.ventaId) + '">Pasar a pendiente de entrega</button>' +
        '<button class="btn btn-secondary" type="button" data-open-venta="' + esc(t.ventaId) + '">Ver ficha</button></div>';
      box.appendChild(d);
    });
    $$('[data-a-listo]', box).forEach(b => b.onclick = async () => {
      try { await api('cambiarEstadoTrabajo', { ventaId: b.dataset.aListo, estado: 'Pendiente de entrega' }); cargarEnProceso(); }
      catch (e) { showError('No se pudo cambiar el estado: ' + e.message); }
    });
    wireVentaButtons(box);
  } catch (e) { box.innerHTML = ''; showError('No se pudieron cargar los trabajos en proceso: ' + e.message); }
}

/* ---------- Órdenes de trabajo (Fase 5): acumular etiquetas por proveedor ----------
   Vista "Órdenes de trabajo": Alfredo selecciona trabajos de En proceso
   y Pendientes con checkboxes para armar la hoja. La selección persiste
   en localStorage (LS_ORDENES_SEL) mientras arma la hoja y se limpia
   con el botón "Limpiar selección". Cada trabajo seleccionado aparece
   UNA vez. Los trabajos se agrupan por proveedor de cristales
   (lenteProveedor: Mia, H2O, Lensbest, INFONDI); sin proveedor van en
   su propio grupo "Sin proveedor", nunca se descartan. Cada grupo
   muestra su contador y un botón "Ver / imprimir hoja" por hoja (hasta
   9 etiquetas, 3×3, formato carta; si un proveedor tiene más de 9, se
   parte en hojas adicionales de 9: "Hoja 1 de 2", etc.). La hoja acepta
   de 1 a 9 etiquetas: se puede imprimir aunque no sean 9.
   La graduación de cada trabajo se trae con getVenta al armar la hoja
   (la respuesta trae `historia` con la graduación: la misma fuente que
   usa graduacionDe en Fase 4). Sin Code.gs nuevo: getEnProceso y
   getPendientes ya devuelven la venta anidada con lenteProveedor. */
function guardarOrdenesSel() {
  try { localStorage.setItem(LS_ORDENES_SEL, JSON.stringify(Array.from(state.ordenesSel))); }
  catch (e) { /* localStorage no disponible: la selección vive solo en memoria */ }
}
function actualizarOrdenesContador() {
  const el = $('#ordenesSelCount');
  if (el) el.textContent = String(state.ordenesSel.size);
  const msg = $('#ordenesMsg');
  if (msg) msg.textContent = state.ordenesSel.size
    ? state.ordenesSel.size + ' trabajo' + (state.ordenesSel.size === 1 ? '' : 's') + ' seleccionado' + (state.ordenesSel.size === 1 ? '' : 's') + '. Cada uno aparece una sola vez en su hoja por proveedor.'
    : 'Selecciona trabajos con el check; cada trabajo aparece una sola vez en la hoja.';
}
function actualizarOrdenesGrupos() {
  const box = $('#ordenesGrupos');
  if (!box) return;
  const trabajos = (state.ordenesTrabajos || []).filter(t => state.ordenesSel.has(t.ventaId));
  // Trabajos seleccionados que ya no están en En proceso ni en
  // Pendientes (se entregaron o cambiaron de estado): no aparecen en
  // las hojas y se avisa, no se pierden en silencio.
  const cargados = new Set((state.ordenesTrabajos || []).map(t => t.ventaId));
  const huerfanos = Array.from(state.ordenesSel).filter(id => !cargados.has(id));
  if (!trabajos.length) {
    box.innerHTML = '<p class="hint">Aún no hay trabajos seleccionados.</p>' +
      (huerfanos.length ? '<p class="hint">⚠ ' + huerfanos.length + ' trabajo' + (huerfanos.length === 1 ? '' : 's') + ' seleccionado' + (huerfanos.length === 1 ? '' : 's') + ' ya no ' + (huerfanos.length === 1 ? 'está' : 'están') + ' en proceso ni pendiente (se entregó o cambió de estado).</p>' : '');
    return;
  }
  const grupos = agruparOrdenesPorProveedor(trabajos);
  box.innerHTML = '';
  if (huerfanos.length) {
    const p = document.createElement('p');
    p.className = 'hint';
    p.textContent = '⚠ ' + huerfanos.length + ' trabajo' + (huerfanos.length === 1 ? '' : 's') + ' seleccionado' + (huerfanos.length === 1 ? '' : 's') + ' ya no ' + (huerfanos.length === 1 ? 'está' : 'están') + ' en proceso ni pendiente y no aparece en las hojas.';
    box.appendChild(p);
  }
  grupos.forEach(g => {
    const hojas = partirEnHojas(g.trabajos, ETIQUETAS_POR_HOJA);
    const d = document.createElement('div');
    d.className = 'list-item orden-grupo' + (g.proveedor === SIN_PROVEEDOR ? ' orden-grupo-sin-prov' : '');
    d.innerHTML = '<strong>' + esc(g.proveedor) + '</strong> <span class="chip">' + g.trabajos.length + ' trabajo' + (g.trabajos.length === 1 ? '' : 's') + '</span> <span class="chip">' + hojas.length + ' hoja' + (hojas.length === 1 ? '' : 's') + ' de hasta 9</span>' +
      (g.proveedor === SIN_PROVEEDOR ? '<small><strong>⚠ Estos trabajos no tienen proveedor registrado:</strong> no se descartan, van en su propia hoja para que los revises.</small>' : '') +
      '<div class="row orden-grupo-btns"></div>';
    const btns = d.querySelector('.orden-grupo-btns');
    hojas.forEach((hoja, i) => {
      const b = document.createElement('button');
      b.className = 'btn btn-secondary'; b.type = 'button';
      b.textContent = 'Ver / imprimir hoja' + (hojas.length > 1 ? ' ' + (i + 1) + ' de ' + hojas.length : '') + ' (' + hoja.length + ' etiqueta' + (hoja.length === 1 ? '' : 's') + ')';
      b.onclick = () => abrirHojaOrdenes(g.proveedor, hoja, i + 1, hojas.length);
      btns.appendChild(b);
    });
    box.appendChild(d);
  });
}
async function cargarOrdenes() {
  const box = $('#ordenesList');
  const gruposBox = $('#ordenesGrupos');
  box.innerHTML = '<p class="hint">Cargando…</p>';
  gruposBox.innerHTML = '';
  try {
    const [enProceso, pendientes] = await Promise.all([api('getEnProceso'), api('getPendientes')]);
    const trabajos = (enProceso || []).concat(pendientes || []);
    const vistos = new Set();
    state.ordenesTrabajos = trabajos.filter(t => {
      if (vistos.has(t.ventaId)) return false;
      vistos.add(t.ventaId);
      return true;
    });
    if (!state.ordenesTrabajos.length) {
      box.innerHTML = '<p class="hint">No hay trabajos en proceso ni pendientes.</p>';
      actualizarOrdenesGrupos();
      actualizarOrdenesContador();
      return;
    }
    box.innerHTML = '';
    state.ordenesTrabajos.forEach(t => {
      const v = t.venta || {};
      const d = document.createElement('div');
      d.className = 'list-item';
      const prov = (v.lenteProveedor && String(v.lenteProveedor).trim()) || SIN_PROVEEDOR;
      const sel = state.ordenesSel.has(t.ventaId);
      d.innerHTML = '<label class="check"><input type="checkbox" data-orden="' + esc(t.ventaId) + '"' + (sel ? ' checked' : '') + '> <strong>' + esc(v.folio || t.ventaId) + '</strong> · ' + esc(v.clienteNombre || t.clienteNombre || '') + '</label>' +
        '<div class="venta-lineas">' + (queComproHTML(v) || '<small>' + esc(tipoVentaTexto(v.tipoVenta)) + '</small>') + '</div>' +
        '<div class="venta-lineas"><small>Proveedor: <strong>' + esc(prov) + '</strong> · Estado: ' + esc(v.estado || t.estado || '') + ' · ' + fechaMX(v.fecha) + '</small></div>';
      box.appendChild(d);
    });
    $$('[data-orden]', box).forEach(cb => cb.onchange = () => {
      cb.checked ? state.ordenesSel.add(cb.dataset.orden) : state.ordenesSel.delete(cb.dataset.orden);
      guardarOrdenesSel();
      actualizarOrdenesGrupos();
      actualizarOrdenesContador();
    });
    actualizarOrdenesGrupos();
    actualizarOrdenesContador();
  } catch (e) { box.innerHTML = ''; showError('No se pudieron cargar los trabajos: ' + e.message); }
}
function limpiarOrdenesSel() {
  state.ordenesSel.clear();
  guardarOrdenesSel();
  cargarOrdenes();
}
/* Arma la hoja de UN proveedor (1 a 9 etiquetas): trae la graduación
   de cada trabajo con getVenta (respuesta trae `historia`) y abre el
   documento en la vista de documento, formato carta. Muestra
   "Cargando etiquetas…" mientras se arman. El botón "Compartir
   imagen" NO se habilita para órdenes en esta fase (fuera de alcance),
   pero el documento usa la estructura .doc estándar. */
async function abrirHojaOrdenes(proveedor, trabajosHoja, hojaNum, totalHojas) {
  const area = $('#docArea');
  area.innerHTML = '<p class="hint">Cargando etiquetas…</p>';
  show('doc');
  try {
    const datos = [];
    for (const t of trabajosHoja) {
      datos.push(await api('getVenta', { ventaId: t.ventaId }));
    }
    area.innerHTML = docOrdenHojaHTML(datos, proveedor, hojaNum, totalHojas);
    state.currentDoc = { kind: 'orden', venta: null, cliente: null, volverA: 'ordenes' };
    aplicarTamanoPagina('orden'); // @page letter, ya puesto en Fase 3
    $('#btnDocCompartir').hidden = true;
  } catch (e) {
    area.innerHTML = '';
    show('ordenes');
    showError('No se pudo armar la hoja: ' + e.message);
  }
}

/* ---------- Ventas (Fase 2): últimas 50, con buscador por folio o cliente ---------- */
async function cargarVentas() {
  const q = ($('#ventasBuscar') && $('#ventasBuscar').value.trim()) || '';
  const box = $('#ventasList');
  const count = $('#ventasCount');
  box.innerHTML = '<p class="hint">Cargando…</p>';
  try {
    const ventas = await api('getVentas', q ? { q } : {});
    if (!ventas.length) {
      box.innerHTML = '<p class="hint">' + (q ? 'Sin ventas para "' + esc(q) + '". Prueba con otro folio o nombre.' : 'Aún no hay ventas registradas.') + '</p>';
      if (count) count.textContent = '';
      return;
    }
    box.innerHTML = '';
    ventas.forEach(v => {
      const wrap = document.createElement('div');
      wrap.innerHTML = ventaResumenHTML(v);
      box.appendChild(wrap.firstChild);
    });
    wireVentaButtons(box);
    if (count) count.textContent = 'Mostrando ' + ventas.length + ' venta' + (ventas.length === 1 ? '' : 's') + (q ? ' para "' + q + '"' : ' (últimas 50)') + '.';
  } catch (e) {
    box.innerHTML = '';
    showError('No se pudieron cargar las ventas: ' + e.message, $('#ventasError'));
  }
}

/* ---------- Resumen, gastos, fondo, corte de caja ---------- */
async function cargarResumen() {
  const box = $('#resumenData');
  const periodo = $('#resPeriodo').value;
  box.innerHTML = '<p class="hint">Cargando…</p>';
  try {
    const r = await api('getResumen', { periodo });
    const porMetodo = r.porMetodo || {};
    const vTot = (r.ventas && typeof r.ventas === 'object') ? r.ventas : { cantidad: r.ventas || 0, total: 0 };
    box.innerHTML = '<table><tr><th>Ventas (' + esc(periodo) + ')</th><td>' + esc(String(vTot.cantidad)) + ' · ' + money(vTot.total) + '</td></tr>' +
      '<tr><th>Cobrado</th><td>' + money(r.cobrado) + '</td></tr>' +
      Object.keys(porMetodo).map(m => '<tr><th>' + esc(m) + '</th><td>' + money(porMetodo[m]) + '</td></tr>').join('') +
      '<tr><th>Gastos</th><td>' + money(r.gastos) + '</td></tr>' +
      '<tr><th>Fondo de producción</th><td>' + money(r.fondo) + '</td></tr></table>';
    cargarGastos(r.desde, r.hasta);
  } catch (e) { box.innerHTML = ''; showError('No se pudo cargar el resumen: ' + e.message); }
}
/* Lista de gastos del mismo periodo del resumen. Usa getGastos (ya existe
   en el backend y en el contrato); el filtro por fecha se aplica también
   en el cliente porque el modo demo devuelve todos los gastos. */
async function cargarGastos(desde, hasta) {
  const box = $('#gastosData');
  if (!box) return;
  box.innerHTML = '<p class="hint">Cargando…</p>';
  try {
    const lista = await api('getGastos', { desde, hasta });
    const gastos = (lista || [])
      .filter(g => (!desde || String(g.fecha || '') >= desde) && (!hasta || String(g.fecha || '') <= hasta))
      .slice()
      .sort((a, b) => String(b.fecha || '').localeCompare(String(a.fecha || '')));
    if (!gastos.length) { box.innerHTML = '<p class="hint">Sin gastos en este periodo.</p>'; return; }
    const total = gastos.reduce((s, g) => s + (Number(g.monto) || 0), 0);
    box.innerHTML = '<table><tr><th>Fecha</th><th>Concepto</th><th>Método</th><th>Monto</th></tr>' +
      gastos.map(g => '<tr><td>' + fechaMX(g.fecha) + '</td><td>' + esc(g.concepto || '') + '</td><td>' + esc(g.metodo || '') + '</td><td>' + money(g.monto) + '</td></tr>').join('') +
      '<tr><td colspan="3"><strong>Total de gastos</strong></td><td><strong>' + money(total) + '</strong></td></tr></table>';
  } catch (e) { box.innerHTML = ''; showError('No se pudieron cargar los gastos: ' + e.message); }
}
async function cargarFondo() {
  const box = $('#fondoData');
  try {
    const f = await api('getFondo');
    box.innerHTML = '<p>Saldo del fondo: <strong>' + money(f.saldo) + '</strong></p>' +
      ((f.movimientos || []).slice(-5).reverse().map(m => '<p><small>' + fechaMX(m.fecha) + ' · ' + esc(m.tipo || '') + ' · ' + esc(m.concepto || '') + ' · ' + money(m.monto) + '</small></p>').join('') || '<p class="hint">Sin movimientos.</p>');
  } catch (e) { box.innerHTML = ''; showError('No se pudo cargar el fondo: ' + e.message); }
}
async function registrarGasto() {
  const fecha = $('#gastoFecha').value || hoyISO();
  const concepto = $('#gastoConcepto').value.trim();
  const monto = Number($('#gastoMonto').value || 0);
  if (!concepto || !(monto > 0)) { showError('Concepto y monto mayor a 0 son obligatorios.'); return; }
  try {
    await api('registrarGasto', { fecha, concepto, monto, metodo: $('#gastoMetodo').value, comprobante: $('#gastoComprobante').value.trim() });
    showOk('Gasto registrado.', $('#gastoMsg'));
    $('#gastoConcepto').value = ''; $('#gastoMonto').value = ''; $('#gastoComprobante').value = '';
    cargarResumen(); cargarFondo();
  } catch (e) { showError('No se pudo registrar el gasto: ' + e.message); }
}
async function registrarSalidaFondo() {
  const concepto = $('#fondoConcepto').value.trim();
  const monto = Number($('#fondoMonto').value || 0);
  if (!concepto || !(monto > 0)) { showError('Concepto y monto mayor a 0 son obligatorios.'); return; }
  try {
    const r = await api('registrarSalidaFondo', { concepto, monto });
    showOk('Salida registrada. Nuevo saldo del fondo: ' + money(r.saldo), $('#fondoMsg'));
    $('#fondoMsg').classList.remove('error'); $('#fondoMsg').classList.add('success');
    $('#fondoConcepto').value = ''; $('#fondoMonto').value = '';
    cargarFondo();
  } catch (e) { showError('No se pudo registrar la salida: ' + e.message, $('#fondoMsg')); }
}
async function cargarCorte() {
  const fecha = $('#corteFecha').value || hoyISO();
  try {
    const c = await api('getCorteCaja', { fecha });
    state.corteCache = c;
    const e = c.esperado || {};
    $('#corteData').innerHTML = '<table>' +
      '<tr><th>Efectivo esperado</th><td>' + money(e.efectivo) + '</td></tr>' +
      '<tr><th>Tarjeta</th><td>' + money(e.tarjeta) + '</td></tr>' +
      '<tr><th>Transferencia</th><td>' + money(e.transferencia) + '</td></tr>' +
      '<tr><th>Programas sociales</th><td>' + money(e.programasSociales) + '</td></tr>' +
      '<tr><th>Gastos del día</th><td>' + money(c.gastosDia) + '</td></tr>' +
      '<tr class="total-row"><th>Total en caja</th><td>' + money(c.totalCaja) + '</td></tr></table>';
    actualizarDiferencia();
  } catch (e2) { showError('No se pudo calcular el corte: ' + e2.message); }
}
function actualizarDiferencia() {
  if (!state.corteCache) return;
  const contado = Number($('#corteContado').value || 0);
  $('#corteDiferencia').textContent = money(contado - Number(state.corteCache.totalCaja || 0));
}
async function guardarCorte() {
  const fecha = $('#corteFecha').value || hoyISO();
  if (!state.corteCache) { showError('Primero calcula el corte del día.'); return; }
  const contado = Number($('#corteContado').value || 0);
  const diferencia = contado - Number(state.corteCache.totalCaja || 0);
  try {
    await api('guardarCorteCaja', { fecha, contado, diferencia });
    showOk('Corte de caja guardado. Diferencia: ' + money(diferencia), $('#corteMsg'));
  } catch (e) { showError('No se pudo guardar el corte: ' + e.message); }
}

/* ---------- Lista de materiales / Catálogos ---------- */
async function cargarMateriales() {
  const box = $('#matData');
  box.innerHTML = '<p class="hint">Cargando…</p>';
  try {
    const d = await api('getListaMateriales');
    state.materialesCache = d;
    box.innerHTML = '<h3>Micas pendientes</h3>' +
      ((d.micas || []).map(m => '<p><small><strong>' + esc(m.folio || '') + '</strong> · ' + esc(m.cliente || '') + ' · ' + esc(m.material || '') + ' ' + esc(m.diseno || '') + ' ' + esc(m.tratamiento || '') + ' · Prov. ' + esc(m.proveedor || '') + ' · Grad. OD Esf ' + esc(fmtGrad(m.graduacion && m.graduacion.esfOD)) + ' / OI Esf ' + esc(fmtGrad(m.graduacion && m.graduacion.esfOI)) + '</small></p>').join('') || '<p class="hint">Sin micas pendientes.</p>') +
      '<h3>Armazones pendientes (otra hoja)</h3>' +
      ((d.armazones || []).map(a => '<p><small><strong>' + esc(a.folio || '') + '</strong> · ' + esc(a.cliente || '') + ' · ' + esc(a.material || '') + ' ' + esc(a.diseno || '') + ' · ' + esc(a.modelo || '') + ' ' + esc(a.marca || '') + ' · Color ' + esc(a.color || '') + '</small></p>').join('') || '<p class="hint">Sin armazones pendientes.</p>');
  } catch (e) { box.innerHTML = ''; showError('No se pudo cargar la lista de materiales: ' + e.message); }
}
async function cargarCatalogosView() {
  const box = $('#catData');
  box.innerHTML = '<p class="hint">Cargando…</p>';
  try {
    const c = state.catalogs || await api('getCatalogos');
    state.catalogs = c;
    const sec = (titulo, filas) => '<h3>' + titulo + '</h3>' + (filas.length ? '<table>' + filas.map(f => '<tr><td>' + f.map(esc).join('</td><td>') + '</td></tr>').join('') + '</table>' : '<p class="hint">Vacío — se llena en el Google Sheet.</p>');
    box.innerHTML =
      sec('Catálogo de armazones (modelo, marca, material, diseño, precio definido)', (c.armazones || []).map(a => [a.modelo || a.Modelo || '', a.marca || a.Marca || '', a.material || a.Material || '', a.diseno || a.Diseno || '', a.precioDef || a.Precio_Def || ''])) +
      sec('Precios de lentes (micas, estimados)', (c.preciosLentes || []).map(p => [p.concepto || p.Concepto || '', money(p.precioEstimado || p.Precio_Estimado || 0)])) +
      sec('Costos de producción (servicios de laboratorio)', (c.costosProduccion || []).map(p => [p.servicio || p.Servicio || '', money(p.precio || p.Precio || 0)])) +
      sec('Conceptos: rebisel y accesorios', (c.conceptos || []).map(p => [p.concepto || p.Concepto || '', p.tipo || p.Tipo || '', 'Venta: ' + (p.costoVenta || p.Costo_Venta || '—'), 'Producción/adquisición: ' + (p.costoProduccion || p.Costo_Produccion || p.costoAdquisicion || p.Costo_Adquisicion || '—')])) +
      sec('Precios de lentes de contacto (por marca; precio real editable en el Sheet)', (c.preciosLC || []).map(p => [p.tipo || p.Tipo || '', p.marca || p.Marca || '', 'Sugerido: ' + money(p.precioSugerido || p.Precio_Sugerido || 0), 'Real: ' + (p.precioReal || p.Precio_Real || '—'), 'BC ' + (p.curvaBase || p.Curva_Base || '—') + ' · Ø ' + (p.diametro || p.Diametro || '—')]));
  } catch (e) { box.innerHTML = ''; showError('No se pudieron cargar los catálogos: ' + e.message); }
}

/* ---------- Ficha de venta: abonos y correcciones ---------- */
async function abrirFichaVenta(ventaId) {
  state.currentVentaId = ventaId;
  try {
    const d = await api('getVenta', { ventaId });
    const v = d.venta, c = d.cliente || {};
    v.pagos = d.pagos || v.pagos || [];
    state.currentVenta = v;
    state.currentHistoria = d.historia || null;
    $('#ventaFicha').innerHTML = '<div class="card"><h3>' + esc(v.folio || v.id) + ' · ' + esc(c.nombre || v.clienteNombre || '') + '</h3>' +
      '<p>' + fechaMX(v.fecha) + ' · ' + esc(tipoVentaTexto(v.tipoVenta)) + ' · ' + estadoChipHTML(v.estado) + '</p>' +
      '<h4>Qué se compró</h4><div class="venta-lineas">' + (queComproHTML(v) || '<p class="hint">Sin detalle registrado.</p>') + '</div>' +
      '<table><tr><th>Total</th><td>' + money(v.totalManual) + '</td></tr>' +
      '<tr><th>A cuenta</th><td>' + money(v.aCuenta) + '</td></tr>' +
      '<tr class="total-row"><th>Saldo</th><td>' + money(v.saldo) + '</td></tr></table>' +
      '<h4>Pagos</h4>' + (v.pagos.map(pagoLineaHTML).join('') || '<p class="hint">Sin pagos registrados.</p>') +
      (metodosChipsHTML(v) ? '<p>' + metodosChipsHTML(v) + '</p>' : '') +
      '<p><small>Graduación (solo informativa): OD Esf ' + esc(fmtGrad(v.graduacion && v.graduacion.esfOD)) + ' · OI Esf ' + esc(fmtGrad(v.graduacion && v.graduacion.esfOI)) + '</small></p></div>';
    show('venta');
  } catch (e) { showError('No se pudo abrir la ficha: ' + e.message); }
}
async function registrarAbono() {
  const monto = Number($('#abonoMonto').value || 0);
  if (!(monto > 0) || !state.currentVentaId) { showError('Captura un monto mayor a 0 y abre primero la ficha de la venta.'); return; }
  try {
    const r = await api('registrarAbono', { ventaId: state.currentVentaId, monto, metodo: $('#abonoMetodo').value, concepto: $('#abonoConcepto').value });
    showOk('Abono registrado. Nuevo saldo: ' + money(r.saldo), $('#abonoMsg'));
    $('#abonoMonto').value = '';
    abrirFichaVenta(state.currentVentaId);
  } catch (e) { showError('No se pudo registrar el abono: ' + e.message); }
}
/* ---------- Registrar abono (vista rápida, desde el dashboard) ----------
   Reutiliza las acciones del backend ya existentes: buscarCliente,
   getCliente, getVenta y registrarAbono. Sin cambios al contrato API.
   Funciona en modo demo (el folio de la venta demo es su ID: VTA-0001). */
async function mostrarAbonoVenta(ventaId) {
  try {
    const d = await api('getVenta', { ventaId });
    const v = d.venta, c = d.cliente || {};
    v.pagos = d.pagos || v.pagos || [];
    state.abonoVentaId = v.id || ventaId;
    state.abonoSaldo = Number(v.saldo || 0);
    const liquidada = state.abonoSaldo <= 0;
    $('#abVentaCard').innerHTML = '<h3>' + esc(v.folio || v.id) + ' · ' + esc(c.nombre || v.clienteNombre || '') + '</h3>' +
      '<p>' + fechaMX(v.fecha) + ' · ' + esc(tipoVentaTexto(v.tipoVenta)) + ' · ' + estadoChipHTML(v.estado) + '</p>' +
      '<div class="venta-lineas">' + (queComproHTML(v) || '') + '</div>' +
      '<table><tr><th>Total</th><td>' + money(v.totalManual) + '</td></tr>' +
      '<tr><th>A cuenta</th><td>' + money(v.aCuenta) + '</td></tr>' +
      '<tr class="total-row"><th>Saldo pendiente</th><td>' + money(v.saldo) + '</td></tr></table>' +
      '<h4>Pagos</h4>' + (v.pagos.map(pagoLineaHTML).join('') || '<p class="hint">Sin pagos registrados.</p>') +
      (liquidada ? '<p class="success">Esta venta ya está liquidada.</p>' : '');
    $('#abVentaBox').hidden = false;
    $('#abMonto').disabled = liquidada;
    $('#btnAbGuardar').disabled = liquidada;
    $('#btnAbLiquidar').disabled = liquidada;
    $('#abMonto').value = '';
    $('#abError').hidden = true;
    $('#abVentaBox').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (e) {
    showError('No se encontró la venta: ' + e.message, $('#abError'));
  }
}
async function buscarAbonoPorFolio() {
  const f = $('#abFolio').value.trim().toUpperCase();
  if (!f) { showError('Escribe el folio de la venta (ej. VTA-0001).', $('#abError')); return; }
  $('#abResultados').innerHTML = '';
  await mostrarAbonoVenta(f);
}
async function buscarAbonoPorCliente() {
  const q = $('#abBuscar').value.trim();
  if (!q) return;
  try {
    const res = await buscarClienteAPI(q);
    const box = $('#abResultados');
    box.innerHTML = res.length ? '' : '<p class="hint">Sin resultados.</p>';
    res.forEach(c => {
      const d = document.createElement('div');
      d.className = 'list-item';
      d.innerHTML = clienteItemHTML(c);
      const b = document.createElement('button');
      b.className = 'btn btn-secondary'; b.type = 'button'; b.textContent = 'Ver sus ventas';
      b.onclick = () => mostrarVentasClienteAbono(c);
      d.appendChild(b);
      box.appendChild(d);
    });
  } catch (e) { showError('Error al buscar: ' + e.message, $('#abError')); }
}
async function mostrarVentasClienteAbono(c) {
  try {
    const d = await api('getCliente', { id: c.id });
    const box = $('#abResultados');
    const ventas = d.ventas || [];
    const pendientes = ventas.filter(v => Number(v.saldo || 0) > 0);
    const liquidadas = ventas.filter(v => Number(v.saldo || 0) <= 0);
    box.innerHTML = '<h3>Ventas de ' + esc(c.nombre) + '</h3>';
    if (!ventas.length) { box.innerHTML += '<p class="hint">Sin ventas registradas.</p>'; return; }
    if (!pendientes.length) box.innerHTML += '<p class="hint">Todas sus ventas están liquidadas.</p>';
    pendientes.forEach(v => {
      const item = document.createElement('div');
      item.className = 'list-item';
      item.innerHTML = '<strong>' + esc(v.folio || v.id) + '</strong> · ' + fechaMX(v.fecha) +
        '<div class="venta-lineas">' + (queComproHTML(v) || '') + '</div>' +
        '<small>Total ' + money(v.totalManual) + ' · Pagado ' + money(v.aCuenta) + ' · Saldo ' + money(v.saldo) + ' · ' + esc(v.estado || '') + '</small>' + metodosChipsHTML(v);
      const b = document.createElement('button');
      b.className = 'btn btn-primary'; b.type = 'button'; b.textContent = 'Abonar a esta venta';
      b.onclick = () => mostrarAbonoVenta(v.id);
      item.appendChild(b);
      box.appendChild(item);
    });
    if (liquidadas.length) box.innerHTML += '<p class="hint">Liquidadas: ' + liquidadas.map(v => esc(v.folio || v.id)).join(', ') + '</p>';
  } catch (e) { showError('No se pudieron cargar las ventas: ' + e.message, $('#abError')); }
}
async function registrarAbonoRapido() {
  const monto = Number($('#abMonto').value || 0);
  if (!state.abonoVentaId) { showError('Primero busca y elige una venta.', $('#abError')); return; }
  if (!(monto > 0)) { showError('Captura un monto mayor a 0.', $('#abError')); return; }
  if (monto > state.abonoSaldo) { showError('El monto no puede ser mayor al saldo (' + money(state.abonoSaldo) + ').', $('#abError')); return; }
  try {
    const r = await api('registrarAbono', { ventaId: state.abonoVentaId, monto, metodo: $('#abMetodo').value, concepto: $('#abConcepto').value });
    showOk('Abono registrado. Nuevo saldo: ' + money(r.saldo), $('#abMsg'));
    await mostrarAbonoVenta(state.abonoVentaId);
  } catch (e) { showError('No se pudo registrar el abono: ' + e.message, $('#abError')); }
}
async function registrarCorreccion() {
  const campo = $('#corrCampo').value;
  const nuevo = $('#corrNuevo').value.trim();
  const justif = $('#corrJustif').value.trim();
  if (!nuevo || !justif || !state.currentVentaId) { showError('El valor nuevo y la justificación son obligatorios.'); return; }
  // Valor anterior REAL, tomado de la ficha cargada (el histórico imborrable
  // debe guardar qué había antes, no un texto genérico).
  const mapaGrad = { Grad_Esf_OD: 'gradEsfOD', Grad_Cil_OD: 'gradCilOD', Grad_Eje_OD: 'gradEjeOD', Grad_Esf_OI: 'gradEsfOI', Grad_Cil_OI: 'gradCilOI', Grad_Eje_OI: 'gradEjeOI', Grad_Add: 'gradAdd', DNP: 'dnp' };
  const mapaPrecio = { Total_Manual: 'totalManual', Costo_Final_Inversion: 'costoFinalInversion' };
  let anterior = '';
  if (mapaGrad[campo] && state.currentHistoria) anterior = state.currentHistoria[mapaGrad[campo]];
  else if (mapaPrecio[campo] && state.currentVenta) anterior = state.currentVenta[mapaPrecio[campo]];
  if (anterior === undefined || anterior === null || anterior === '') anterior = 'no registrado';
  try {
    await api('corregir', { ventaId: state.currentVentaId, campo, valorAnterior: String(anterior), valorNuevo: nuevo, justificacion: justif, historiaId: (state.currentHistoria && state.currentHistoria.id) || undefined });
    showOk('Corrección registrada en el histórico imborrable.', $('#corrMsg'));
    $('#corrNuevo').value = ''; $('#corrJustif').value = '';
  } catch (e) { showError('No se pudo registrar la corrección: ' + e.message); }
}

/* ---------- Número a palabras (español, para el comprobante) ---------- */
const UNIDADES = ['', 'uno', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve', 'diez', 'once', 'doce', 'trece', 'catorce', 'quince', 'dieciséis', 'diecisiete', 'dieciocho', 'diecinueve', 'veinte'];
const DECENAS = ['', '', 'veinti', 'treinta', 'cuarenta', 'cincuenta', 'sesenta', 'setenta', 'ochenta', 'noventa'];
function centenas(n) {
  if (n === 0) return '';
  if (n === 100) return 'cien';
  let out = '';
  const c = Math.floor(n / 100), r = n % 100;
  if (c === 1) out = 'ciento';
  else if (c === 2) out = 'doscientos';
  else if (c === 3) out = 'trescientos';
  else if (c === 4) out = 'cuatrocientos';
  else if (c === 5) out = 'quinientos';
  else if (c === 6) out = 'seiscientos';
  else if (c === 7) out = 'setecientos';
  else if (c === 8) out = 'ochocientos';
  else if (c === 9) out = 'novecientos';
  if (r) {
    if (r <= 20) out += (out ? ' ' : '') + UNIDADES[r];
    else if (r < 30) out += (out ? ' ' : '') + 'veinti' + UNIDADES[r % 10];
    else {
      out += (out ? ' ' : '') + DECENAS[Math.floor(r / 10)];
      if (r % 10) out += ' y ' + UNIDADES[r % 10];
    }
  }
  return out;
}
function numeroALetras(n) {
  n = Math.floor(Math.abs(Number(n) || 0));
  if (n === 0) return 'Cero pesos';
  let out = '';
  const miles = Math.floor(n / 1000), resto = n % 1000;
  if (miles === 1) out = 'mil';
  else if (miles > 1) out = centenas(miles) + ' mil';
  if (resto) out += (out ? ' ' : '') + centenas(resto);
  return out.charAt(0).toUpperCase() + out.slice(1) + ' pesos';
}

/* ---------- Documentos (vistas imprimibles) ---------- */
function docHead(titulo) {
  return '<div class="doc-head"><img src="logo.png" alt="Boutique de Lentes Yael"><div><div class="doc-title">' + esc(titulo) + '</div>' +
    '<div><strong>' + esc(NEGOCIO.nombre) + '</strong> · Sucursal ' + esc(NEGOCIO.sucursal) + '</div>' +
    '<div class="addr">' + esc(NEGOCIO.direccion) + ' · Tel. ' + esc(NEGOCIO.telefonos) + '</div></div></div>';
}
/* ---------- Fase 4: graduación y lente de contacto ----------
   Una venta LLEVA lente de contacto solo si tiene tipo Y precio mayor
   a 0: ventas ya guardadas como VTA-0001 traen LC_Tipo 'Esférico' con
   LC_Precio_Def 0 (el wizard mandaba lcTipo siempre) y NO deben
   mostrar la línea de LC en ningún documento.
   La graduación NO vive en la venta: en producción la venta no trae
   `graduacion` (ver docOrdenHTML); vive en la historia clínica, que
   accGetVenta devuelve como `historia` (gradEsfOD… en camelCase). */
function llevaLC(v) {
  return !!(v && v.lcTipo && Number(v.lcPrecioDef) > 0);
}
function graduacionDe(d) {
  const v = (d && d.venta) || {};
  const h = (d && d.historia) || v.historia || {};
  // Si la venta trae graduación incrustada (solo modo demo), manda
  // ella; si no, la de la historia clínica (última del cliente).
  if (v.graduacion && (v.graduacion.esfOD || v.graduacion.cilOD || v.graduacion.esfOI || v.graduacion.cilOI)) return v.graduacion;
  return { esfOD: h.gradEsfOD, cilOD: h.gradCilOD, ejeOD: h.gradEjeOD, esfOI: h.gradEsfOI, cilOI: h.gradCilOI, ejeOI: h.gradEjeOI, add: h.gradAdd, dnp: h.dnp };
}
function graduacionVacia(g) {
  g = g || {};
  return !['esfOD', 'cilOD', 'ejeOD', 'esfOI', 'cilOI', 'ejeOI'].some(k => g[k] !== '' && g[k] != null);
}
/* La historia del wizard (paso 2) guarda la graduación con las claves
   gradEsfOD…; vacía = ninguno de los 6 valores de esfera/cilindro/eje. */
function historiaSinGraduacion(h) {
  h = h || {};
  return graduacionVacia({ esfOD: h.gradEsfOD, cilOD: h.gradCilOD, ejeOD: h.gradEjeOD, esfOI: h.gradEsfOI, cilOI: h.gradCilOI, ejeOI: h.gradEjeOI });
}
function rxTabla(g) {
  g = g || {};
  return '<table class="rx-table"><tr><th></th><th>Esf</th><th>Cil</th><th>Eje</th></tr>' +
    '<tr><td>O.D.</td><td>' + esc(fmtGrad(g.esfOD)) + '</td><td>' + esc(fmtGrad(g.cilOD)) + '</td><td>' + esc(g.ejeOD || '—') + '</td></tr>' +
    '<tr><td>O.I.</td><td>' + esc(fmtGrad(g.esfOI)) + '</td><td>' + esc(fmtGrad(g.cilOI)) + '</td><td>' + esc(g.ejeOI || '—') + '</td></tr></table>' +
    '<p>Add: ' + esc(fmtGrad(g.add)) + ' · DNP: ' + esc(g.dnp || '—') + '</p>';
}
function docHistoriaHTML(d) {
  const v = d.venta || {}, c = d.cliente || {}, h = d.historia || v.historia || {};
  const g = graduacionDe(d);
  return '<div class="doc doc-historia">' + docHead('Historia clínica') +
    '<div class="hc-grid"><div><strong>Paciente:</strong> ' + esc(c.nombre || v.clienteNombre || '') + '</div>' +
    '<div><strong>Fecha:</strong> ' + fechaMX(v.fecha || h.fecha) + '</div>' +
    '<div><strong>Edad:</strong> ' + esc(String(c.edad || '')) + ' años</div>' +
    '<div><strong>Sexo:</strong> ' + esc(c.sexo || '') + '</div>' +
    '<div><strong>Fecha de nacimiento:</strong> ' + fechaMX(c.fechaNac) + '</div>' +
    '<div><strong>Teléfono:</strong> ' + esc(c.telefono || v.telefono || '') + '</div>' +
    '<div><strong>Ocupación:</strong> ' + esc(c.ocupacion || '') + '</div>' +
    '<div><strong>¿Usa lentes?</strong> ' + esc(h.usaLentes || '') + '</div>' +
    '<div><strong>Motivo de consulta:</strong> ' + esc(h.motivo || '') + '</div>' +
    '<div><strong>Antecedentes:</strong> ' + [h.antDiabetes ? 'Diabetes' : '', h.antHipertension ? 'Hipertensión' : '', h.antMigrana ? 'Migraña' : ''].filter(Boolean).join(', ') + '</div></div>' +
    '<h3>Agudeza visual (Snellen)</h3><table><tr><th></th><th>O.D.</th><th>O.I.</th><th>A/O</th></tr>' +
    '<tr><td>Sin Rx</td><td>' + esc(h.avSinOD || '—') + '</td><td>' + esc(h.avSinOI || '—') + '</td><td>' + esc(h.avSinAO || '—') + '</td></tr>' +
    '<tr><td>Con Rx</td><td>' + esc(h.avConOD || '—') + '</td><td>' + esc(h.avConOI || '—') + '</td><td>' + esc(h.avConAO || '—') + '</td></tr></table>' +
    '<h3>Graduación del examen (refracción subjetiva)</h3>' + rxTabla(g) +
    '<p><strong>Diagnóstico refractivo:</strong> ' + esc(h.diagnostico || '') + '</p>' +
    '<p><strong>Indicaciones:</strong> ' + esc(h.indicaciones || '') + '</p>' +
    '<p><strong>Recomendación:</strong> ' + esc(h.recomendacion || '') + '</p>' +
    '<div class="sig"><div>Firma del paciente</div><div>Firma del optometrista</div></div></div>';
}
/* ---------- Fase 5: órdenes de trabajo — marca Luna, 1 etiqueta/trabajo ----------
   SOLO en las órdenes de trabajo va Laboratorio Óptico Luna (nombre en
   texto + logo-luna-fuerte.png con onerror: si el archivo aún no
   existe, la imagen se oculta y queda solo el texto, sin imagen
   rota). En el HTML de la orden NO aparece "Boutique de Lentes Yael"
   en ningún lado: ni encabezado, ni etiquetas, ni notas al pie. El
   resto de documentos y la app siguen con Yael. */
function docOrdenHeadHTML() {
  return '<div class="doc-head doc-head-luna"><img src="' + LABORATORIO.logo + '" alt="Laboratorio Óptico Luna" onerror="this.style.display=\'none\'"><div><div class="doc-title">Orden de trabajo</div><div><strong>' + esc(LABORATORIO.nombre) + '</strong></div><div class="addr">' + esc(LABORATORIO.direccion) + ' · Tel. ' + esc(LABORATORIO.telefonos) + '</div></div></div>';
}
/* UNA etiqueta por trabajo: folio, cliente, fecha, edad, graduación
   (Esf/Cil/Eje OD y OI, Add, DNP — vía graduacionDe, de la historia
   clínica), diseño, material, tratamiento, proveedor y armazón
   (material, diseño, modelo, color). Si no hay graduación en ningún
   lado, la etiqueta muestra el mismo aviso visible de Fase 4
   ("Graduación no registrada") en vez de guiones silenciosos. */
function ordenEtiquetaHTML(d) {
  const v = d.venta || {}, c = d.cliente || {};
  const g = graduacionDe(d);
  const sinGrad = graduacionVacia(g);
  const rx = sinGrad
    ? '<div class="orden-sin-grad">⚠ Graduación no registrada — captúrala en la historia clínica</div>'
    : '<table><tr><th></th><th>Esf</th><th>Cil</th><th>Eje</th></tr>' +
      '<tr><td>O.D.</td><td>' + esc(fmtGrad(g.esfOD)) + '</td><td>' + esc(fmtGrad(g.cilOD)) + '</td><td>' + esc(g.ejeOD || '—') + '</td></tr>' +
      '<tr><td>O.I.</td><td>' + esc(fmtGrad(g.esfOI)) + '</td><td>' + esc(fmtGrad(g.cilOI)) + '</td><td>' + esc(g.ejeOI || '—') + '</td></tr></table>' +
      '<div>Add ' + esc(fmtGrad(g.add)) + ' · DNP ' + esc(g.dnp || '—') + '</div>';
  return '<div class="orden-label"><div class="orden-label-wm" aria-hidden="true"></div><h4>' + esc(LABORATORIO.nombre) + ' · ' + esc(v.folio || v.id || '') + '</h4>' +
    '<div>' + esc(c.nombre || v.clienteNombre || '') + ' · ' + fechaMX(v.fecha) + ' · ' + esc(String(c.edad || '')) + ' años</div>' +
    rx +
    '<div>Diseño: ' + esc(v.lenteDiseno || v.lcTipo || '') + ' · Material: ' + esc(v.lenteMaterial || '') + '</div>' +
    '<div>Tratamiento: ' + esc(v.lenteTratamiento || '') + ' · Prov. ' + esc(v.lenteProveedor || '') + '</div>' +
    '<div>Armazón: ' + esc(v.armazonMaterial || '') + ' ' + esc(v.armazonDiseno || '') + ' · ' + esc(v.armazonModelo || '') + ' · Color ' + esc(v.armazonColor || '') + '</div></div>';
}
/* Una hoja de órdenes: hasta 9 etiquetas (3×3) de UN solo proveedor,
   formato carta (el @page letter lo pone aplicarTamanoPagina('orden')).
   La marca de agua es el logo de Luna en su versión fuerte, DENTRO de
   cada etiqueta (.orden-label-wm, ver styles.css), centrada en el
   recuadro de la tarjeta — antes iba en la hoja (.doc-watermark-luna)
   y quedaba hasta arriba, tapada por las tarjetas.
   El compartir como imagen NO se habilita para órdenes (hoy solo
   ticket y comprobante tienen el botón). */
function docOrdenHojaHTML(datos, proveedor, hojaNum, totalHojas) {
  datos = datos || [];
  hojaNum = hojaNum || 1;
  totalHojas = totalHojas || 1;
  const sinGradFolios = datos
    .filter(x => graduacionVacia(graduacionDe(x)))
    .map(x => (x.venta && (x.venta.folio || x.venta.id)) || '');
  return '<div class="doc doc-orden">' +
    docOrdenHeadHTML() +
    '<p class="orden-hoja-info"><strong>Proveedor: ' + esc(proveedor || SIN_PROVEEDOR) + '</strong> · Hoja ' + hojaNum + ' de ' + totalHojas + ' · ' + datos.length + ' etiqueta' + (datos.length === 1 ? '' : 's') + ' (de 1 a 9 por hoja)</p>' +
    (sinGradFolios.length ? '<p class="error doc-orden-aviso"><strong>⚠ Graduación no registrada</strong> en: ' + esc(sinGradFolios.join(', ')) + '. Captúrala en la historia clínica antes de mandar el trabajo al laboratorio.</p>' : '') +
    '<div class="doc-orden-grid">' + datos.map(ordenEtiquetaHTML).join('') + '</div></div>';
}
/* La orden de UN trabajo (botón "Orden de trabajo" de la ficha de
   venta): UNA sola etiqueta, ya no la misma 9 veces. */
function docOrdenHTML(d) {
  const v = (d && d.venta) || {};
  const prov = (v.lenteProveedor && String(v.lenteProveedor).trim()) || SIN_PROVEEDOR;
  return docOrdenHojaHTML([d], prov, 1, 1);
}
/* ---------- Fase 5: agrupar por proveedor y partir en hojas ----------
   Funciones puras (sin DOM): se prueban en Node. Los trabajos sin
   proveedor van en un grupo aparte "Sin proveedor", bien visible,
   nunca se descartan en silencio; ese grupo queda siempre al final. */
function agruparOrdenesPorProveedor(trabajos) {
  const grupos = {};
  const orden = [];
  (trabajos || []).forEach(t => {
    const v = (t && t.venta) || {};
    const prov = (v.lenteProveedor && String(v.lenteProveedor).trim()) || SIN_PROVEEDOR;
    if (!grupos[prov]) { grupos[prov] = []; orden.push(prov); }
    grupos[prov].push(t);
  });
  // "Sin proveedor" siempre al final, aunque se haya visto primero.
  orden.sort((a, b) => (a === SIN_PROVEEDOR ? 1 : 0) - (b === SIN_PROVEEDOR ? 1 : 0));
  return orden.map(p => ({ proveedor: p, trabajos: grupos[p] }));
}
function partirEnHojas(items, porHoja) {
  const n = Math.max(1, porHoja || ETIQUETAS_POR_HOJA);
  const hojas = [];
  for (let i = 0; i < (items || []).length; i += n) hojas.push(items.slice(i, i + n));
  return hojas;
}
/* Ticket 58 mm estilo ANTERIOR (Fase 4): monocromo, logo CIRCULAR de Yael
   en negro (logo-yael-circular-mono.png, v2.1) centrado arriba,
   nombre del negocio, dirección y teléfonos de la sucursal (NEGOCIO),
   "COMPROBANTE DE VENTA" + folio, cliente + ID + fecha, conceptos,
   Subtotal (precios definidos), Descuento, TOTAL GRANDE en negrita,
   Pagado, Saldo en negrita, Estado y "Gracias por su preferencia".
   Todo el texto en negritas (v2.1, CSS .doc-ticket) para que no se
   pierda al imprimir en la térmica de 58 mm. El compartir como
   imagen lo pinta directo en canvas 2D (v2.3, dibujarTicket), con las
   mismas filas y totales que aquí.
   La graduación NO aparece en el ticket. */
function docTicketHTML(d) {
  const v = d.venta || {}, c = d.cliente || {};
  const filas = [];
  if (v.armazonMaterial) filas.push(['ARMAZÓN — ' + v.armazonMaterial + ' / ' + v.armazonDiseno, money(v.armazonPrecioDef)]);
  if (v.lenteMaterial) filas.push(['LENTE — ' + v.lenteMaterial + ' ' + v.lenteDiseno + ' ' + v.lenteTratamiento, money(v.lentePrecioDef)]);
  // Fase 4: la línea de LC solo si la venta REALMENTE lleva LC
  // (lcTipo no vacío Y lcPrecioDef > 0). VTA-0001 trae LC_Tipo
  // 'Esférico' con precio 0 y ya no muestra la línea en $0.00.
  if (llevaLC(v)) filas.push(['LENTE DE CONTACTO — ' + v.lcTipo + ' ' + (v.lcMarca || '') + ' (caja de 6)', money(v.lcPrecioDef)]);
  if (v.tipoVenta === 'rebisel') filas.push(['REBISEL — ' + (v.rebiselConcepto || ''), money(v.armazonPrecioDef)]);
  if (v.tipoVenta === 'accesorio') filas.push(['ACCESORIO — ' + (v.accesorioDesc || ''), money(v.armazonPrecioDef)]);
  // Descuento = precio definido total − total manual (totalesTicket,
  // misma lógica que el pintor de canvas v2.3).
  const t = totalesTicket(v);
  const precioDef = t.precioDef, tieneDef = t.tieneDef, descuento = t.descuento;
  const estado = Number(v.saldo) > 0 ? 'PENDIENTE' : 'LIQUIDADO';
  return '<div class="doc doc-ticket">' +
    '<div class="tk-center"><img class="ticket-logo" src="logo-yael-circular-mono.png" alt="Boutique de Lentes Yael"></div>' +
    '<div class="tk-nombre">' + esc(NEGOCIO.nombre) + '</div>' +
    '<p class="tk-center">' + esc(NEGOCIO.direccion) + '<br>Tel. ' + esc(NEGOCIO.telefonos) + '</p><hr>' +
    '<p class="tk-titulo">COMPROBANTE DE VENTA</p>' +
    '<p class="tk-center tk-folio">' + esc(v.folio || v.id || '') + '</p>' +
    '<div class="tk-cliente"><strong>Cliente:</strong><br>' + esc(c.nombre || v.clienteNombre || '') + '<br>ID: ' + esc(c.id || v.clienteId || '') + '<br>Fecha: ' + fechaMX(v.fecha) + '</div><hr>' +
    '<table class="tk-conceptos">' + filas.map(f => '<tr><td>' + esc(f[0]) + '</td><td>' + f[1] + '</td></tr>').join('') + '</table><hr>' +
    '<table class="tk-totales">' +
    (tieneDef ? '<tr><td>Subtotal</td><td>' + money(precioDef) + '</td></tr>' : '') +
    (Number.isFinite(descuento) ? '<tr><td>Descuento</td><td>' + money(descuento) + '</td></tr>' : '') +
    '<tr class="tk-total"><td>TOTAL</td><td>' + money(v.totalManual) + '</td></tr>' +
    '<tr><td>Pagado</td><td>' + money(v.aCuenta) + '</td></tr>' +
    '<tr class="tk-saldo"><td>Saldo</td><td>' + money(v.saldo) + '</td></tr>' +
    '<tr><td>Estado</td><td>' + estado + '</td></tr></table><hr>' +
    '<p class="tk-center">Gracias por su preferencia</p>' +
    '<p class="tk-center"><strong>' + esc(NEGOCIO.nombre) + '</strong></p></div>';
}
function docComprobanteHTML(d) {
  const v = d.venta || {}, c = d.cliente || {};
  const prox = new Date(v.fecha || hoyISO());
  prox.setMonth(prox.getMonth() + PROXIMA_VISITA_MESES);
  // La graduación NO aparece en el comprobante.
  // Fase 3: el logo va directo sobre el degradado con su contorno
  // blanco (logo-yael-contorno-blanco.png, versión que mandó Alfredo;
  // ya no lleva pastilla blanca) y lleva marca de agua al
  // fondo (div .doc-watermark, ver styles.css).
  return '<div class="doc doc-comprobante">' +
    '<div class="doc-watermark" aria-hidden="true"></div>' +
    '<div class="banner-top"><img class="banner-logo" src="logo-yael-contorno-blanco.png" alt="Boutique de Lentes Yael"><div style="text-align:right"><div class="doc-title" style="color:#fff">Comprobante de venta</div><div>PEDIDO No. ' + esc(v.folio || v.id || '') + '</div><div>FECHA ' + fechaMX(v.fecha) + '</div></div></div>' +
    '<p><strong>Nombre:</strong> ' + esc(c.nombre || v.clienteNombre || '') + ' &nbsp; <strong>Móvil:</strong> ' + esc(c.telefono || v.telefono || '') + '</p>' +
    // v2.3.6: la tabla va envuelta en .doc-tabla para que el flex de
    // impresión (que reparte el contenido por toda la tarjeta 3x5)
    // no la desarme (una <table> directa como hijo flex se rompe).
    '<div class="doc-tabla"><table><tr><th>Concepto</th><th>Detalle</th><th>Precio</th></tr>' +
    (v.armazonMaterial ? '<tr><td>Armazón</td><td>' + esc(v.armazonMaterial) + ' ' + esc(v.armazonDiseno) + ' · Modelo ' + esc(v.armazonModelo || '') + ' · Marca ' + esc(v.armazonMarca || '') + ' · Color ' + esc(v.armazonColor || '') + '</td><td>' + money(v.armazonPrecioDef) + '</td></tr>' : '') +
    (v.lenteMaterial ? '<tr><td>Lente</td><td>' + esc(v.lenteMaterial) + ' ' + esc(v.lenteDiseno) + ' · ' + esc(v.lenteTratamiento || '') + ' · Proveedor ' + esc(v.lenteProveedor || '') + '</td><td>' + money(v.lentePrecioDef) + '</td></tr>' : '') +
    (llevaLC(v) ? '<tr><td>Lente de contacto</td><td>' + esc(v.lcTipo) + ' · ' + esc(v.lcMarca || '') + ' · Caja de 6 lentes · Reemplazo mensual · BC ' + esc(v.lcCurvaBase || '') + ' · Ø ' + esc(v.lcDiametro || '') + '</td><td>' + money(v.lcPrecioDef) + '</td></tr>' : '') +
    (v.tipoVenta === 'rebisel' ? '<tr><td>Rebisel</td><td>' + esc(v.rebiselConcepto || '') + '</td><td>' + money(v.armazonPrecioDef) + '</td></tr>' : '') +
    (v.tipoVenta === 'accesorio' ? '<tr><td>Accesorio</td><td>' + esc(v.accesorioDesc || '') + '</td><td>' + money(v.armazonPrecioDef) + '</td></tr>' : '') +
    '<tr><td>Total parcial</td><td></td><td>' + money(v.precioDefTotal) + '</td></tr>' +
    '<tr><td>Descuento</td><td></td><td>' + money(v.descuento) + '</td></tr>' +
    '<tr class="total-row"><td>Neto / Total</td><td></td><td>' + money(v.totalManual) + '</td></tr>' +
    '<tr><td>Anticipo / A cuenta</td><td></td><td>' + money(v.aCuenta) + '</td></tr>' +
    '<tr><td>Saldo</td><td></td><td>' + money(v.saldo) + '</td></tr></table></div>' +
    '<p><strong>Cantidad total en palabras:</strong> ' + esc(numeroALetras(v.totalManual)) + ' MXN.</p>' +
    '<div class="garantias"><strong>Garantías:</strong> ' + esc(GARANTIAS.adaptacion) + ' · ' + esc(GARANTIAS.armazon) + ' · ' + esc(GARANTIAS.tratamiento) + '.<br><strong>Próxima visita:</strong> ' + prox.toLocaleDateString('es-MX') + ' (10 meses).</div>' +
    '<div class="sig"><div>Firma del cliente</div><div>Boutique de Lentes Yael</div></div></div>';
}
function docMaterialesHTML(d) {
  const micas = (d && d.micas) || [];
  const armazones = (d && d.armazones) || [];
  return '<div class="doc">' + docHead('Lista de materiales') +
    '<h3>Micas pendientes de realizar</h3>' +
    (micas.length ? '<table><tr><th>Folio</th><th>Cliente</th><th>Graduación OD / OI</th><th>Material</th><th>Diseño</th><th>Tratamiento</th><th>Proveedor</th></tr>' +
      micas.map(m => '<tr><td>' + esc(m.folio || '') + '</td><td>' + esc(m.cliente || '') + '</td><td>OD Esf ' + esc(fmtGrad(m.graduacion && m.graduacion.esfOD)) + ' Cil ' + esc(fmtGrad(m.graduacion && m.graduacion.cilOD)) + ' Eje ' + esc((m.graduacion && m.graduacion.ejeOD) || '—') + '<br>OI Esf ' + esc(fmtGrad(m.graduacion && m.graduacion.esfOI)) + ' Cil ' + esc(fmtGrad(m.graduacion && m.graduacion.cilOI)) + ' Eje ' + esc((m.graduacion && m.graduacion.ejeOI) || '—') + '</td><td>' + esc(m.material || '') + '</td><td>' + esc(m.diseno || '') + '</td><td>' + esc(m.tratamiento || '') + '</td><td>' + esc(m.proveedor || '') + '</td></tr>').join('') + '</table>' : '<p class="hint">Sin micas pendientes.</p>') +
    '<h3 style="page-break-before:always">Armazones pendientes (otra hoja)</h3>' +
    (armazones.length ? '<table><tr><th>Folio</th><th>Cliente</th><th>Material</th><th>Diseño</th><th>Modelo</th><th>Marca</th><th>Color</th></tr>' +
      armazones.map(a => '<tr><td>' + esc(a.folio || '') + '</td><td>' + esc(a.cliente || '') + '</td><td>' + esc(a.material || '') + '</td><td>' + esc(a.diseno || '') + '</td><td>' + esc(a.modelo || '') + '</td><td>' + esc(a.marca || '') + '</td><td>' + esc(a.color || '') + '</td></tr>').join('') + '</table>' : '<p class="hint">Sin armazones pendientes.</p>') + '</div>';
}
async function abrirDoc(kind, ventaId, extra) {
  extra = extra || {};
  let data = null;
  try {
    if (kind === 'materiales') {
      data = state.materialesCache || await api('getListaMateriales');
    } else if (ventaId) {
      data = await api('getVenta', { ventaId });
    } else if (extra.historiaId && extra.clienteId) {
      const exp = await api('getLibroVisitas', { clienteId: extra.clienteId });
      const h = (exp.historias || []).find(x => x.id === extra.historiaId) || (exp.historias || [])[0] || {};
      data = { venta: (exp.ventas || [])[0] || {}, cliente: exp.cliente, historia: h };
    } else if (state.currentVentaId) {
      data = await api('getVenta', { ventaId: state.currentVentaId });
    } else {
      showError('Abre primero la ficha de una venta para ver sus documentos.');
      return;
    }
  } catch (e) { showError('No se pudo cargar el documento: ' + e.message); return; }
  const builders = { historia: docHistoriaHTML, orden: docOrdenHTML, ticket: docTicketHTML, comprobante: docComprobanteHTML, materiales: docMaterialesHTML };
  $('#docArea').innerHTML = (builders[kind] || docHistoriaHTML)(data);
  state.currentDoc = { kind, venta: data.venta || null, cliente: data.cliente || null };
  // v2.3.4: precargar los logos que usa el pintor de canvas para que al
  // tocar Compartir ya estén en la caché del navegador y la imagen se
  // genere sin esperar la descarga (el comprobante usa dos logos y es
  // el que más tardaba).
  if (kind === 'ticket' || kind === 'comprobante') {
    (kind === 'ticket' ? ['logo-yael-circular-mono.png'] : ['logo-yael-contorno-blanco.png', 'logo-yael-circular.png']).forEach(s => { const im = new Image(); im.src = s; });
  }
  aplicarTamanoPagina(kind); // el @page queda listo antes de imprimir
  const shareBtn = $('#btnDocCompartir');
  shareBtn.hidden = !(kind === 'ticket' || kind === 'comprobante');
  show('doc');
}
/* ---------- Fase 3: tamaño de página al imprimir / PDF ----------
   El @page se inyecta según el documento actual para que el PDF salga
   con el tamaño del documento y no con el tamaño por defecto del
   diálogo de impresión (antes salía en Quarto aunque el comprobante es
   media carta). Se llama al abrir el documento y al pulsar Imprimir. */
const PAGE_SIZES = {
  comprobante: '3in 5in',   // Index Card 3x5 (tarjeta)
  historia: '5.5in 8.5in',      // media carta
  orden: 'letter',              // carta
  ticket: '58mm auto',         // 58 mm
  materiales: 'letter'          // carta
};
function aplicarTamanoPagina(kind) {
  const size = PAGE_SIZES[kind] || 'letter';
  // v2.3.6: el comprobante va en tarjeta 3x5 con margen chico (3mm).
  const margin = kind === 'ticket' ? '0' : (kind === 'comprobante' ? '3mm' : ((kind === 'historia') ? '5mm' : '8mm'));
  let st = document.getElementById('pageSizeStyle');
  if (!st) {
    st = document.createElement('style');
    st.id = 'pageSizeStyle';
    document.head.appendChild(st);
  }
  st.textContent = '@page { size: ' + size + '; margin: ' + margin + '; }';
}
/* ---------- v2.3.7: el comprobante cabe en UNA tarjeta 3x5 ----------
   Aunque el @page es 3in x 5in, en el celular el contenido puede
   superar el alto de la tarjeta (detalles largos del armazón/lente)
   y caer a una 2ª página con espacio muerto. Antes de imprimir se
   estima el alto del comprobante a ancho de tarjeta y, si se pasa,
   se reduce con zoom (solo en impresión) para que quepa en una sola
   tarjeta. El zoom nunca sube de 1 ni baja de 0.6 para que el texto
   siga legible. */
function zoomAjusteComprobante() {
  const docEl = document.querySelector('#view-doc .doc-comprobante');
  if (!docEl || !docEl.scrollHeight) return 1;
  const anchoPantalla = docEl.clientWidth || 360;
  const altoPantalla = docEl.scrollHeight;
  const anchoImprimiblePx = (3 * 96) - (2 * 11.34); // 3in menos 2x3mm
  const altoImprimiblePx = (5 * 96) - (2 * 11.34);  // 5in menos 2x3mm
  // Al estrecharse a ancho de tarjeta el texto da más vueltas (más alto);
  // la fuente impresa es más chica (.78rem), lo que lo compensa en parte.
  const altoEst = altoPantalla * (anchoPantalla / anchoImprimiblePx) * 0.8;
  if (altoEst <= altoImprimiblePx) return 1;
  return Math.max(0.6, altoImprimiblePx / altoEst);
}
function imprimirDoc() {
  if (state.currentDoc) aplicarTamanoPagina(state.currentDoc.kind);
  if (state.currentDoc && state.currentDoc.kind === 'comprobante') {
    const z = zoomAjusteComprobante();
    const st = document.getElementById('pageSizeStyle');
    // La regla va dentro de @media print: solo afecta a la impresión
    // y no deja el documento chico en pantalla. aplicarTamanoPagina
    // reescribe el <style> en cada impresión, así que no queda zoom viejo.
    if (st) st.textContent += ' @media print { #view-doc .doc-comprobante { zoom: ' + z.toFixed(3) + '; } }';
  }
  window.print();
}

/* ---------- Fase 3: compartir el documento como IMAGEN ----------
   Sin librerías externas (todo offline): el documento se pinta
   directo en un canvas 2D (v2.3; el camino SVG+foreignObject de
   v1/v2.1 se abandonó porque el <img> del SVG fallaba en el celular)
   y se exporta como PNG para compartirlo con el menú nativo de
   Android (WhatsApp, impresora, etc.). Fallbacks en orden:
   1) navigator.share con archivos -> 2) descarga del PNG y aviso ->
   3) si la imagen no se pudo generar, texto por share / wa.me (el
   comportamiento anterior; el botón nunca queda muerto). Cancelar el
   menú de compartir no dispara ningún fallback.
   Se intenta a 2x y, si el pintado falla, se reintenta a 1x (menos
   memoria); si ambas fallan, el error real se muestra en pantalla
   antes de compartir el texto. */
/* ---------- v2.3: compartir el documento como IMAGEN (canvas 2D) ----------
   Sin librerías externas (todo offline). El camino SVG+foreignObject
   de v1/v2.1 se ABANDONA: en el celular el <img> del SVG disparaba
   onerror a 2x y a 1x ("No se pudo dibujar el documento (SVG)") y el
   botón caía al texto. Ahora el documento se pinta directo en un
   canvas 2D, sin SVG, sin foreignObject y sin cargar el SVG como
   imagen. Los logos se cargan con new Image() normal desde archivos
   locales (logo.png, logo-yael-circular-mono.png): esas imágenes ya
   se muestran en el DOM y cargan bien.
   Flujo (se conserva): navigator.share con archivos -> descarga del
   PNG -> texto como último recurso. Si el pintor falla, el error real
   se muestra en pantalla (ver compartirDoc).
   Los pintores son funciones puras de dibujo (ctx 2D + doc) con dos
   pasadas: dibujar=false solo mide (para conocer el alto exacto antes
   de dimensionar el canvas), dibujar=true pinta. Se prueban en Node
   con un stub de ctx 2D que registra los fillText. */
/* v2.3.4: con tiempo límite (8 s) — antes, si la descarga de un logo
   se quedaba colgada, el await no resolvía nunca y el botón se quedaba
   en "Generando imagen…" sin fallar ni avisar. Con el límite, el
   documento se pinta sin ese logo y la imagen sí se genera. */
function cargarImagen(src) {
  return new Promise((res, rej) => {
    const img = new Image();
    const to = setTimeout(() => rej(new Error('No se pudo cargar ' + src + ' (tiempo agotado)')), 8000);
    img.onload = () => { clearTimeout(to); res(img); };
    img.onerror = () => { clearTimeout(to); rej(new Error('No se pudo cargar ' + src)); };
    img.src = src;
  });
}
/* Trazo de rectángulo redondeado (no se usa ctx.roundRect: no existe
   en WebView antiguos de Android). */
function trazoRedondeado(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}
/* Envuelve un texto en líneas que quepan en maxW (usa el measureText
   de la fuente actual del ctx). */
function envolverTexto(ctx, txt, maxW) {
  const palabras = String(txt == null ? '' : txt).split(/\s+/).filter(Boolean);
  const lineas = [];
  let actual = '';
  for (const p of palabras) {
    const prueba = actual ? actual + ' ' + p : p;
    if (ctx.measureText(prueba).width <= maxW || !actual) actual = prueba;
    else { lineas.push(actual); actual = p; }
  }
  if (actual) lineas.push(actual);
  return lineas;
}
function fuenteDe(familia, tam, negrita) {
  return (negrita ? '700 ' : '') + tam + 'px ' + familia;
}
/* Dibuja un texto de un solo estilo en la línea base (x, y). Si
   dibujar=false solo mide. Devuelve el ancho medido. */
function texto(ctx, s, x, y, fuente, color, align, dibujar) {
  ctx.font = fuente; ctx.fillStyle = color; ctx.textAlign = align || 'left'; ctx.textBaseline = 'alphabetic';
  if (dibujar) ctx.fillText(s, x, y);
  return ctx.measureText(s).width;
}
/* Párrafo con segmentos [{t, b}] (b = negrita) y salto de línea por
   palabras. `y` es la línea base de la primera línea. Devuelve el
   alto consumido (nº líneas × inter). Si dibujar=false solo mide. */
function parrafoMixto(ctx, segmentos, x, y, maxW, familia, tam, inter, dibujar, color) {
  const palabras = [];
  (segmentos || []).forEach(seg => {
    String(seg.t == null ? '' : seg.t).split(/\s+/).filter(Boolean).forEach(w => palabras.push({ w, b: !!seg.b }));
  });
  const medir = (w, b) => { ctx.font = fuenteDe(familia, tam, b); return ctx.measureText(w).width; };
  const espacio = medir(' ', false);
  const lineas = [];
  let linea = [], ancho = 0;
  palabras.forEach(p => {
    const wp = medir(p.w, p.b);
    const extra = linea.length ? espacio : 0;
    if (ancho + extra + wp > maxW && linea.length) { lineas.push(linea); linea = [p]; ancho = wp; }
    else { linea.push(p); ancho += extra + wp; }
  });
  if (linea.length) lineas.push(linea);
  if (dibujar) {
    lineas.forEach((ln, i) => {
      let cx = x;
      ln.forEach((p, j) => {
        ctx.font = fuenteDe(familia, tam, p.b);
        ctx.fillStyle = color || '#241f31';
        ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
        ctx.fillText(p.w, cx, y + i * inter);
        cx += medir(p.w, p.b) + (j < ln.length - 1 ? espacio : 0);
      });
    });
  }
  return lineas.length * inter;
}
/* Precio definido total y descuento de una venta (misma lógica del
   ticket en el DOM): el descuento es definido − manual si la venta no
   lo trae. Lo usan docTicketHTML y el pintor de canvas v2.3. */
function totalesTicket(v) {
  v = v || {};
  const precioDef = Number(v.precioDefTotal);
  const tieneDef = Number.isFinite(precioDef) && v.precioDefTotal !== '' && v.precioDefTotal != null;
  const descNum = Number(v.descuento);
  const descuento = Number.isFinite(descNum) && v.descuento !== '' && v.descuento != null
    ? descNum : (tieneDef ? precioDef - Number(v.totalManual || 0) : NaN);
  return { precioDef, tieneDef, descuento };
}
/* Pinta el COMPROBANTE en un ctx 2D (refleja .doc-comprobante del
   DOM: banner degradado Turquesa→Lila con pastilla blanca + logo,
   Nombre/Móvil, tabla Concepto/Detalle/Precio, cantidad en palabras,
   caja de garantías, firmas y marca de agua). Las coordenadas son en
   px CSS (media carta 5.5in = 528px a 96dpi); la escala se aplica con
   ctx.scale en generarImagenDocumento. Devuelve {ancho, alto} en px
   de canvas (ya con la escala). Si dibujar=false solo mide. */
function dibujarComprobante(ctx, doc, logo, escala, dibujar, marca, altoTotal) {
  const k = (escala && escala > 0) ? escala : 2;
  const v = (doc && doc.venta) || {}, c = (doc && doc.cliente) || {};
  const F = 'system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif';
  const INK = '#241f31';
  const W = 528, M = 20, cw = W - 2 * M;
  const LH = 17;
  let y = M;
  const prox = new Date(v.fecha || hoyISO());
  prox.setMonth(prox.getMonth() + PROXIMA_VISITA_MESES);
  // Marca de agua (logo circular de Yael, simétrico, alfa bajo,
  // centrada detrás del contenido en AMBOS ejes: antes el logo ancho
  // se veía cargado a la izquierda y hacia arriba porque su peso
  // visual no está centrado; el círculo sí lo está. La posición
  // vertical usa el alto total medido (altoTotal), que llega en la
  // 2ª pasada; sin él se usa la posición anterior como respaldo).
  if (dibujar && marca) {
    ctx.save();
    ctx.globalAlpha = 0.10;
    const lw = 380, lh = lw * (marca.height / marca.width);
    const wy = (altoTotal && altoTotal > lh) ? (altoTotal - lh) / 2 : 120;
    ctx.drawImage(marca, (W - lw) / 2, wy, lw, lh);
    ctx.restore();
  }
  // Banner degradado Turquesa #40C5D2 → Lila #9076DA.
  const bannerH = 64;
  if (dibujar) {
    const g = ctx.createLinearGradient(M, 0, W - M, 0);
    g.addColorStop(0, '#40C5D2'); g.addColorStop(1, '#9076DA');
    trazoRedondeado(ctx, M, y, cw, bannerH, 8);
    ctx.fillStyle = g; ctx.fill();
    // v2.3.1: el logo del banner ya trae su propio contorno blanco
    // (logo-yael-contorno-blanco.png, versión de Alfredo); ya no lleva
    // pastilla blanca detrás.
    if (logo) {
      const lw = 140, lh = lw * (logo.height / logo.width);
      ctx.drawImage(logo, M + 14, y + (bannerH - lh) / 2, lw, lh);
    }
    texto(ctx, 'COMPROBANTE DE VENTA', W - M - 12, y + 24, '800 19px ' + F, '#fff', 'right', true);
    texto(ctx, 'PEDIDO No. ' + (v.folio || v.id || ''), W - M - 12, y + 43, '13px ' + F, '#fff', 'right', true);
    texto(ctx, 'FECHA ' + fechaMX(v.fecha), W - M - 12, y + 58, '13px ' + F, '#fff', 'right', true);
  }
  y += bannerH + 14;
  // Nombre / Móvil.
  y += parrafoMixto(ctx, [{ t: 'Nombre: ', b: true }, { t: (c.nombre || v.clienteNombre || '') + '    ' }, { t: 'Móvil: ', b: true }, { t: c.telefono || v.telefono || '' }], M, y + 14, cw, F, 14, LH, dibujar, INK) + 8;
  // Tabla Concepto / Detalle / Precio.
  const xC = M, xD = M + 92, xP = W - M - 84, wD = xP - xD;
  const filas = [];
  if (v.armazonMaterial) filas.push({ c: 'Armazón', d: (v.armazonMaterial || '') + ' ' + (v.armazonDiseno || '') + ' · Modelo ' + (v.armazonModelo || '') + ' · Marca ' + (v.armazonMarca || '') + ' · Color ' + (v.armazonColor || ''), p: money(v.armazonPrecioDef) });
  if (v.lenteMaterial) filas.push({ c: 'Lente', d: (v.lenteMaterial || '') + ' ' + (v.lenteDiseno || '') + ' · ' + (v.lenteTratamiento || '') + ' · Proveedor ' + (v.lenteProveedor || ''), p: money(v.lentePrecioDef) });
  if (llevaLC(v)) filas.push({ c: 'Lente de contacto', d: (v.lcTipo || '') + ' · ' + (v.lcMarca || '') + ' · Caja de 6 lentes · Reemplazo mensual · BC ' + (v.lcCurvaBase || '') + ' · Ø ' + (v.lcDiametro || ''), p: money(v.lcPrecioDef) });
  if (v.tipoVenta === 'rebisel') filas.push({ c: 'Rebisel', d: v.rebiselConcepto || '', p: money(v.armazonPrecioDef) });
  if (v.tipoVenta === 'accesorio') filas.push({ c: 'Accesorio', d: v.accesorioDesc || '', p: money(v.armazonPrecioDef) });
  filas.push({ c: 'Total parcial', d: '', p: money(v.precioDefTotal) });
  filas.push({ c: 'Descuento', d: '', p: money(v.descuento) });
  filas.push({ c: 'Neto / Total', d: '', p: money(v.totalManual), total: true });
  filas.push({ c: 'Anticipo / A cuenta', d: '', p: money(v.aCuenta) });
  filas.push({ c: 'Saldo', d: '', p: money(v.saldo) });
  const tablaTop = y;
  // Encabezado de la tabla.
  const headH = 26;
  if (dibujar) {
    ctx.fillStyle = '#efe9fb';
    ctx.fillRect(M, tablaTop, cw, headH);
    texto(ctx, 'Concepto', xC + 8, tablaTop + 17, '700 13px ' + F, '#6f55b8', 'left', true);
    texto(ctx, 'Detalle', xD + 8, tablaTop + 17, '700 13px ' + F, '#6f55b8', 'left', true);
    texto(ctx, 'Precio', W - M - 8, tablaTop + 17, '700 13px ' + F, '#6f55b8', 'right', true);
  }
  y = tablaTop + headH;
  filas.forEach(f => {
    ctx.font = '13px ' + F;
    const lineas = envolverTexto(ctx, f.d, wD - 16);
    const n = Math.max(1, lineas.length);
    const rowH = n * LH + 12;
    if (dibujar) {
      if (f.total) { ctx.fillStyle = '#efe9fb'; ctx.fillRect(M, y, cw, rowH); }
      const fuente = f.total ? '700 13px ' + F : '13px ' + F;
      texto(ctx, f.c, xC + 8, y + 19, fuente, INK, 'left', true);
      lineas.forEach((ln, i) => texto(ctx, ln, xD + 8, y + 19 + i * LH, fuente, INK, 'left', true));
      texto(ctx, f.p, W - M - 8, y + 19, fuente, INK, 'right', true);
    }
    y += rowH;
  });
  // Bordes de la tabla (exterior + separadores horizontales/verticales).
  if (dibujar) {
    ctx.strokeStyle = '#e3ddf2'; ctx.lineWidth = 1;
    ctx.strokeRect(M, tablaTop, cw, y - tablaTop);
    ctx.beginPath();
    ctx.moveTo(M, tablaTop + headH); ctx.lineTo(W - M, tablaTop + headH);
    ctx.moveTo(xD, tablaTop); ctx.lineTo(xD, y);
    ctx.moveTo(xP, tablaTop); ctx.lineTo(xP, y);
    ctx.stroke();
  }
  y += 10;
  // Cantidad total en palabras.
  y += parrafoMixto(ctx, [{ t: 'Cantidad total en palabras: ', b: true }, { t: numeroALetras(v.totalManual) + ' MXN.' }], M, y + 14, cw, F, 14, LH, dibujar, INK) + 8;
  // Caja de garantías.
  const g1 = parrafoMixto(ctx, [{ t: 'Garantías: ', b: true }, { t: GARANTIAS.adaptacion + ' · ' + GARANTIAS.armazon + ' · ' + GARANTIAS.tratamiento + '.' }], M + 10, 0, cw - 20, F, 13, 16, false, INK);
  const g2 = parrafoMixto(ctx, [{ t: 'Próxima visita: ', b: true }, { t: prox.toLocaleDateString('es-MX') + ' (10 meses).' }], M + 10, 0, cw - 20, F, 13, 16, false, INK);
  const cajaH = 10 + g1 + 4 + g2 + 10;
  if (dibujar) {
    trazoRedondeado(ctx, M, y, cw, cajaH, 8);
    ctx.fillStyle = '#efe9fb'; ctx.fill();
    parrafoMixto(ctx, [{ t: 'Garantías: ', b: true }, { t: GARANTIAS.adaptacion + ' · ' + GARANTIAS.armazon + ' · ' + GARANTIAS.tratamiento + '.' }], M + 10, y + 10 + 13, cw - 20, F, 13, 16, true, INK);
    parrafoMixto(ctx, [{ t: 'Próxima visita: ', b: true }, { t: prox.toLocaleDateString('es-MX') + ' (10 meses).' }], M + 10, y + 10 + g1 + 4 + 13, cw - 20, F, 13, 16, true, INK);
  }
  y += cajaH + 10;
  // Firmas.
  const lineaY = y + 14;
  if (dibujar) {
    ctx.strokeStyle = INK; ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(M, lineaY); ctx.lineTo(M + cw * 0.45, lineaY);
    ctx.moveTo(W - M - cw * 0.45, lineaY); ctx.lineTo(W - M, lineaY);
    ctx.stroke();
    texto(ctx, 'Firma del cliente', M + cw * 0.225, lineaY + 16, '13px ' + F, INK, 'center', true);
    texto(ctx, 'Boutique de Lentes Yael', W - M - cw * 0.225, lineaY + 16, '13px ' + F, INK, 'center', true);
  }
  y = lineaY + 16 + 6;
  return { ancho: Math.round(W * k), alto: Math.round((y + M) * k) };
}
/* Pinta el TICKET 58 mm en un ctx 2D (refleja .doc-ticket del DOM:
   monocromo, todo en negritas, logo circular de Yael en negro).
   Ancho 58 mm ≈ 219 px a 96 dpi en 1x. Devuelve {ancho, alto} en px
   de canvas (ya con la escala). Si dibujar=false solo mide. */
function dibujarTicket(ctx, doc, logo, escala, dibujar) {
  const k = (escala && escala > 0) ? escala : 2;
  const v = (doc && doc.venta) || {}, c = (doc && doc.cliente) || {};
  const F = 'monospace,ui-monospace,Menlo,Consolas,sans-serif';
  const W = 219, M = 6, cw = W - 2 * M;
  const t = totalesTicket(v);
  const estado = Number(v.saldo) > 0 ? 'PENDIENTE' : 'LIQUIDADO';
  let y = M;
  const tl = (s, tam, align, salto) => {
    const f = '700 ' + tam + 'px ' + F;
    ctx.font = f; ctx.fillStyle = '#000'; ctx.textAlign = align || 'center'; ctx.textBaseline = 'alphabetic';
    if (dibujar) ctx.fillText(s, align === 'right' ? W - M : align === 'center' ? W / 2 : M, y + tam);
    y += salto || (tam + 4);
  };
  const separador = () => {
    if (dibujar) {
      ctx.save();
      ctx.strokeStyle = '#000'; ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      ctx.beginPath(); ctx.moveTo(M, y + 3); ctx.lineTo(W - M, y + 3); ctx.stroke();
      ctx.restore();
    }
    y += 7;
  };
  const filaConcepto = (desc, precio) => {
    const f = '700 11px ' + F;
    ctx.font = f;
    const pw = ctx.measureText(precio).width + 8;
    const lineas = envolverTexto(ctx, desc, cw - pw);
    lineas.forEach((ln, i) => {
      if (dibujar) {
        ctx.font = f; ctx.fillStyle = '#000'; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
        ctx.fillText(ln, M, y + 11);
        if (i === 0) { ctx.textAlign = 'right'; ctx.fillText(precio, W - M, y + 11); }
      }
      y += 15;
    });
    separador();
  };
  const filaTotal = (etiqueta, valor, tam) => {
    const f = '700 ' + tam + 'px ' + F;
    if (dibujar) {
      ctx.font = f; ctx.fillStyle = '#000'; ctx.textBaseline = 'alphabetic';
      ctx.textAlign = 'left'; ctx.fillText(etiqueta, M, y + tam);
      ctx.textAlign = 'right'; ctx.fillText(valor, W - M, y + tam);
    }
    y += tam + 5;
  };
  // Logo circular de Yael en negro, centrado.
  if (logo) {
    const lw = 150, lh = lw * (logo.height / logo.width);
    if (dibujar) ctx.drawImage(logo, (W - lw) / 2, y, lw, lh);
    y += lh + 6;
  }
  tl(NEGOCIO.nombre, 13, 'center');
  ctx.font = '700 11px ' + F;
  envolverTexto(ctx, NEGOCIO.direccion, cw).forEach(ln => tl(ln, 11, 'center'));
  tl('Tel. ' + NEGOCIO.telefonos, 11, 'center');
  separador();
  tl('COMPROBANTE DE VENTA', 13, 'center');
  tl(v.folio || v.id || '', 12, 'center');
  // Cliente.
  tl('Cliente:', 11, 'left');
  ctx.font = '700 11px ' + F;
  envolverTexto(ctx, c.nombre || v.clienteNombre || '', cw).forEach(ln => tl(ln, 11, 'left'));
  tl('ID: ' + (c.id || v.clienteId || ''), 11, 'left');
  tl('Fecha: ' + fechaMX(v.fecha), 11, 'left');
  separador();
  // Conceptos (mismas filas que docTicketHTML).
  if (v.armazonMaterial) filaConcepto('ARMAZÓN — ' + v.armazonMaterial + ' / ' + v.armazonDiseno, money(v.armazonPrecioDef));
  if (v.lenteMaterial) filaConcepto('LENTE — ' + v.lenteMaterial + ' ' + v.lenteDiseno + ' ' + v.lenteTratamiento, money(v.lentePrecioDef));
  if (llevaLC(v)) filaConcepto('LENTE DE CONTACTO — ' + v.lcTipo + ' ' + (v.lcMarca || '') + ' (caja de 6)', money(v.lcPrecioDef));
  if (v.tipoVenta === 'rebisel') filaConcepto('REBISEL — ' + (v.rebiselConcepto || ''), money(v.armazonPrecioDef));
  if (v.tipoVenta === 'accesorio') filaConcepto('ACCESORIO — ' + (v.accesorioDesc || ''), money(v.armazonPrecioDef));
  separador();
  // Totales.
  if (t.tieneDef) filaTotal('Subtotal', money(t.precioDef), 11);
  if (Number.isFinite(t.descuento)) filaTotal('Descuento', money(t.descuento), 11);
  separador();
  filaTotal('TOTAL', money(v.totalManual), 16);
  separador();
  filaTotal('Pagado', money(v.aCuenta), 11);
  filaTotal('Saldo', money(v.saldo), 13);
  filaTotal('Estado', estado, 11);
  separador();
  tl('Gracias por su preferencia', 11, 'center');
  tl(NEGOCIO.nombre, 11, 'center');
  return { ancho: Math.round(W * k), alto: Math.round((y + M) * k) };
}
async function generarImagenDocumento(doc, escala) {
  // v2.3: pinta el documento directo en canvas 2D (sin SVG). La escala
  // es 2x por defecto; compartirDoc reintenta a 1x si falla.
  const k = (escala && escala > 0) ? escala : 2;
  const esTicket = doc && doc.kind === 'ticket';
  // v2.3.1: el comprobante usa DOS logos: el del banner con contorno
  // blanco (logo-yael-contorno-blanco.png) y el circular para la marca
  // de agua (logo-yael-circular.png). El ticket sigue con el circular
  // monocromo y sin marca de agua.
  const srcLogo = esTicket ? 'logo-yael-circular-mono.png' : 'logo-yael-contorno-blanco.png';
  let logo = null, marca = null;
  try { logo = await cargarImagen(srcLogo); }
  catch (e) { logo = null; /* el documento se pinta sin logo */ }
  if (!esTicket) {
    try { marca = await cargarImagen('logo-yael-circular.png'); }
    catch (e) { marca = null; /* el comprobante se pinta sin marca de agua */ }
  }
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas no disponible.');
  const pintar = esTicket ? dibujarTicket : dibujarComprobante;
  // 1ª pasada: solo mide (sin pintar) para conocer el alto exacto.
  let dims;
  try { dims = pintar(ctx, doc, logo, k, false, marca, 0); }
  catch (e) { throw new Error('al medir el documento: ' + e.message); }
  if (!dims || !dims.ancho || !dims.alto) throw new Error('No se pudo medir el documento.');
  canvas.width = dims.ancho;
  canvas.height = dims.alto;
  // Cambiar width/height resetea el contexto: se repone la escala
  // (las coordenadas de los pintores son en px CSS).
  ctx.scale(k, k);
  // v2.3.2: fondo blanco opaco ANTES de pintar — el canvas nace
  // transparente y WhatsApp muestra lo transparente como negro, así que
  // el cliente recibía la imagen en negro. Con el fondo blanco el PNG
  // se ve igual que el documento en la app.
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, dims.ancho / k, dims.alto / k);
  try { pintar(ctx, doc, logo, k, true, marca, dims.alto / k); }
  catch (e) { throw new Error('al dibujar el documento: ' + e.message); }
  const png = await new Promise((res, rej) => canvas.toBlob(
    b => (b ? res(b) : rej(new Error('No se pudo exportar el PNG.'))), 'image/png'));
  return png;
}

async function compartirDoc() {
  const doc = state.currentDoc;
  if (!doc) return;
  const v = doc.venta || {};
  const c = doc.cliente || {};
  // v2.3.5: mensaje de WhatsApp como el del ticket que le gusta a
  // Alfredo — saludo personal, sin el texto largo predeterminado
  // ("Boutique de Lentes Yael (El Sol) — Comprobante de venta
  // VTA-0001 · Cliente: … · Total: …"). Los totales ya van dentro
  // de la imagen del documento.
  const tipoTxt = doc.kind === 'ticket' ? 'ticket' : 'comprobante de venta';
  const texto = 'Hola ' + (c.nombre || v.clienteNombre || '') + ', te compartimos tu ' + tipoTxt + ' de Boutique de Lentes Yael.';
  const btn = $('#btnDocCompartir');
  const etiquetaOriginal = btn ? btn.textContent : '';
  const folioLimpio = String(v.folio || doc.kind).replace(/[^A-Za-z0-9_-]/g, '') || doc.kind;
  const nombreArchivo = doc.kind + '-' + folioLimpio + '.png';
  try {
    if (!doc.venta) throw new Error('Documento no visible.');
    if (btn) { btn.disabled = true; btn.textContent = 'Generando imagen…'; }
    // v2.3: el documento se pinta directo en canvas 2D (sin SVG). Se
    // intenta a 2x y, si el pintado falla en el celular, se reintenta
    // a 1x (menos memoria). Si ambas fallan, el error real se muestra
    // en pantalla (catch) para poder diagnosticarlo.
    let blob = null, ultimoError = null;
    for (const escala of [2, 1]) {
      try { blob = await generarImagenDocumento(doc, escala); break; }
      catch (e) { ultimoError = e; }
    }
    if (!blob) throw new Error('No se pudo generar la imagen: ' + (ultimoError && ultimoError.message ? ultimoError.message : 'error desconocido'));
    const archivo = new File([blob], nombreArchivo, { type: 'image/png' });
    // v2.3.4: si el menú nativo falla, NO se cae al texto: se sigue al
    // respaldo de descarga para que la imagen no se pierda (antes, un
    // fallo del menú mandaba directo al texto por wa.me y el cliente
    // nunca recibía la imagen).
    let compartido = false;
    if (navigator.canShare && navigator.canShare({ files: [archivo] })) {
      try {
        await navigator.share({ files: [archivo], title: 'Boutique de Lentes Yael — ' + tipoTxt + ' ' + (v.folio || ''), text: texto });
        compartido = true;
      } catch (e) {
        if (e && e.name === 'AbortError') return; // el usuario canceló el menú
      }
    }
    if (compartido) return;
    // Fallback 1: el dispositivo no comparte archivos (o el menú falló)
    // -> descargar el PNG para enviarlo desde Descargas por WhatsApp.
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = nombreArchivo;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    showError('No se pudo abrir el menú para compartir: se descargó "' + nombreArchivo + '" — envíalo desde Descargas por WhatsApp.');
  } catch (e) {
    if (e && e.name === 'AbortError') return;
    // v2.1: el error real se muestra en pantalla (12 s) en vez de caer
    // en silencio al texto: así en el siguiente test Alfredo puede
    // decirnos qué dice el aviso y diagnosticamos la causa.
    showError('No se pudo compartir la imagen: ' + e.message + ' Se comparte el texto.');
    // Fallback 2: la imagen no se pudo generar -> texto como antes.
    try {
      if (navigator.share) {
        await navigator.share({ title: 'Boutique de Lentes Yael', text: texto });
        return;
      }
      throw new Error('share no disponible');
    } catch (e2) {
      if (e2 && e2.name === 'AbortError') return;
      const tel = String(c.telefono || v.telefono || '').replace(/\D/g, '');
      const url = tel ? 'https://wa.me/52' + tel + '?text=' + encodeURIComponent(texto) : 'https://wa.me/?text=' + encodeURIComponent(texto);
      window.open(url, '_blank');
    }
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = etiquetaOriginal; }
  }
}

/* ---------- Configuración inicial ---------- */
function loadConfig() {
  state.url = localStorage.getItem(LS_URL) || '';
  state.token = localStorage.getItem(LS_TOKEN) || '';
  state.demo = localStorage.getItem(LS_DEMO) === '1';
  $('#modeBadge').hidden = !state.demo;
  // v2.3.7: el botón de Configuración solo se muestra si la app NO está
  // configurada (o está en DEMO): una vez instalada y conectada nadie
  // puede abrirlo y cambiar la URL o el token. Para reconfigurar hay
  // que desinstalar y reinstalar la app (vuelve la configuración inicial).
  const btnCfg = $('#btnConfig');
  if (btnCfg) btnCfg.hidden = !state.demo && !!(state.url && state.token);
  // Fase 5: la selección de trabajos para las hojas de órdenes persiste
  // en este dispositivo mientras Alfredo arma la hoja.
  try { state.ordenesSel = new Set(JSON.parse(localStorage.getItem(LS_ORDENES_SEL) || '[]')); }
  catch (e) { state.ordenesSel = new Set(); }
}
function saveConfig(url, token, demoFlag) {
  if (demoFlag) {
    localStorage.setItem(LS_DEMO, '1');
    localStorage.removeItem(LS_URL);
    localStorage.removeItem(LS_TOKEN);
  } else {
    localStorage.setItem(LS_URL, url);
    localStorage.setItem(LS_TOKEN, token);
    localStorage.removeItem(LS_DEMO);
  }
  loadConfig();
}
/* ---------- Splash de arranque (v2.1 punto 8) ----------
   Al abrir la app ya configurada se muestra brevemente el logo Nexus
   completo (marca-nexus.png) con "By Caremi Sistems Technology" y
   luego pasa al panel. Con un toque se salta. Si la app no está
   configurada no hay splash: va directo a la configuración inicial. */
let splashTimer = null, splashInicio = 0;
function mostrarSplashArranque() {
  const s = $('#splashStart');
  if (!s) return;
  splashInicio = Date.now();
  s.hidden = false;
  if (splashTimer) clearTimeout(splashTimer);
  splashTimer = setTimeout(ocultarSplash, 4000); // failsafe: nunca más de 4 s
}
async function esperarSplashMinimo() {
  // El splash se ve al menos 1.5 s aunque el backend responda antes.
  const falta = 1500 - (Date.now() - splashInicio);
  if (splashInicio && falta > 0) await new Promise(res => setTimeout(res, falta));
}
function ocultarSplash() {
  if (splashTimer) { clearTimeout(splashTimer); splashTimer = null; }
  const s = $('#splashStart');
  if (s) s.hidden = true;
}
async function entrarApp() {
  if (state.demo || (state.url && state.token)) {
    try {
      await api('ping');
    } catch (e) {
      ocultarSplash();
      showError('No se pudo conectar con el backend: ' + e.message + ' Revisa la URL y el token en Configuración.');
      show('setup');
      return;
    }
    await loadCatalogs();
    await esperarSplashMinimo();
    ocultarSplash();
    show('home');
  } else {
    show('setup');
  }
}

/* ---------- Inicio y eventos ---------- */
function init() {
  loadConfig();
  // Configuración
  $('#formSetup').addEventListener('submit', async ev => {
    ev.preventDefault();
    const url = $('#setupUrl').value.trim();
    const token = $('#setupToken').value.trim();
    if (!url || !token) { const e = $('#setupError'); e.textContent = 'Captura la URL del web app y el token.'; e.hidden = false; return; }
    saveConfig(url, token, false);
    entrarApp();
  });
  $('#btnEnterDemo').addEventListener('click', () => { saveConfig('', '', true); entrarApp(); });
  $('#setupDemo').addEventListener('change', ev => { if (ev.target.checked) { $('#setupUrl').required = false; $('#setupToken').required = false; } });
  $('#btnConfig').addEventListener('click', () => show('setup'));
  $('#btnSetupBack').addEventListener('click', goHome);
  // v2.1 punto 8: splash de arranque solo si la app ya está configurada;
  // con un toque se salta.
  if (state.demo || (state.url && state.token)) mostrarSplashArranque();
  const sp = $('#splashStart');
  if (sp) sp.addEventListener('click', ocultarSplash);
  // Dashboard
  $$('#dashboardGrid [data-nav]').forEach(b => b.addEventListener('click', () => show(b.dataset.nav)));
  $$('[data-nav]').forEach(b => { if (!b.closest('#dashboardGrid')) b.addEventListener('click', () => show(b.dataset.nav)); });
  // Wizard
  $('#btnWizardNext').addEventListener('click', wizardNext);
  $('#btnWizardBack').addEventListener('click', wizardBack);
  $('#btnNvBuscar').addEventListener('click', buscarClienteNv);
  $('#nvBuscar').addEventListener('keydown', ev => { if (ev.key === 'Enter') { ev.preventDefault(); buscarClienteNv(); } });
  $('#btnNvCrearCliente').addEventListener('click', crearClienteNv);
  $('#nvFechaNac').addEventListener('change', ev => { $('#nvEdad').value = edadDesde(ev.target.value) + ' años'; });
  $('#hcUsaLentes').addEventListener('change', ev => {
    $('#hcLensometria').hidden = ev.target.value !== 'sí';
    $('#hcMotivoWrap').hidden = ev.target.value !== 'no';
  });
  $$('input[name="tipoVenta"]').forEach(r => r.addEventListener('change', aplicarTipoVenta));
  $('#lcConArmazon').addEventListener('change', aplicarTipoVenta);
  $('#lcSwitch').addEventListener('change', aplicarInterruptorLC);
  $('#lcTipo').addEventListener('change', actualizarMarcasLC);
  $('#lcMarca').addEventListener('change', actualizarMarcasLC);
  $('#lenteTratamiento').addEventListener('change', ev => { $('#filtroTonoWrap').hidden = ev.target.value !== 'Filtro color'; });
  $('#lenteConcepto').addEventListener('change', ev => {
    const m = ev.target.value.match(/\$([\d.,]+)/);
    if (m) $('#lentePrecio').value = m[1].replace(/,/g, '');
  });
  ['#pTotalManual', '#pACuenta'].forEach(s => $(s).addEventListener('input', actualizarPrecios));
  $('#pLiquidar').addEventListener('change', ev => {
    if (ev.target.checked) $('#pACuenta').value = $('#pTotalManual').value;
    actualizarPrecios();
  });
  $('#btnGuardarVenta').addEventListener('click', guardarVenta);
  $$('#docsAfterSave [data-doc]').forEach(b => b.addEventListener('click', () => abrirDoc(b.dataset.doc, state.currentVentaId)));
  // Buscar cliente / libro de visitas
  $('#btnBcBuscar').addEventListener('click', () => buscarClientes($('#bcBuscar').value.trim(), $('#bcResultados'), mostrarFichaCliente));
  $('#btnLvBuscar').addEventListener('click', () => buscarClientes($('#lvBuscar').value.trim(), $('#lvResultados'), mostrarExpediente));
  // Pendientes / en proceso
  $('#btnMarcarEntregados').addEventListener('click', marcarEntregados);
  $('#btnProcArmarHoja').addEventListener('click', () => show('ordenes'));
  // Órdenes de trabajo (Fase 5): acumular etiquetas por proveedor
  $('#btnOrdenesCargar').addEventListener('click', cargarOrdenes);
  $('#btnOrdenesLimpiar').addEventListener('click', limpiarOrdenesSel);
  // Ventas (Fase 2)
  $('#btnVentasBuscar').addEventListener('click', cargarVentas);
  $('#ventasBuscar').addEventListener('keydown', ev => { if (ev.key === 'Enter') { ev.preventDefault(); cargarVentas(); } });
  // Resumen
  $('#btnResCargar').addEventListener('click', cargarResumen);
  $('#btnGasto').addEventListener('click', registrarGasto);
  $('#btnFondoSalida').addEventListener('click', registrarSalidaFondo);
  $('#btnCorteCargar').addEventListener('click', cargarCorte);
  $('#corteContado').addEventListener('input', actualizarDiferencia);
  $('#btnCorteGuardar').addEventListener('click', guardarCorte);
  // Materiales / catálogos
  $('#btnMatCargar').addEventListener('click', cargarMateriales);
  $('#btnCatCargar').addEventListener('click', cargarCatalogosView);
  // Ficha de venta
  $('#btnAbono').addEventListener('click', registrarAbono);
  $('#btnCorregir').addEventListener('click', registrarCorreccion);
  // Registrar abono (vista rápida del dashboard)
  $('#btnAbFolio').addEventListener('click', buscarAbonoPorFolio);
  $('#abFolio').addEventListener('keydown', ev => { if (ev.key === 'Enter') { ev.preventDefault(); buscarAbonoPorFolio(); } });
  $('#btnAbBuscar').addEventListener('click', buscarAbonoPorCliente);
  $('#abBuscar').addEventListener('keydown', ev => { if (ev.key === 'Enter') { ev.preventDefault(); buscarAbonoPorCliente(); } });
  $('#btnAbGuardar').addEventListener('click', registrarAbonoRapido);
  $('#btnAbLiquidar').addEventListener('click', () => {
    if (state.abonoSaldo > 0) { $('#abConcepto').value = 'liquidación'; $('#abMonto').value = state.abonoSaldo.toFixed(2); $('#abMonto').focus(); }
  });
  $('#abConcepto').addEventListener('change', ev => {
    if (ev.target.value === 'liquidación' && state.abonoSaldo > 0) $('#abMonto').value = state.abonoSaldo.toFixed(2);
  });
  $$('#view-venta [data-doc]').forEach(b => b.addEventListener('click', () => abrirDoc(b.dataset.doc, state.currentVentaId)));
  $$('#view-lista-materiales [data-doc]').forEach(b => b.addEventListener('click', () => abrirDoc(b.dataset.doc, null)));
  // Documentos
  $('#btnDocVolver').addEventListener('click', () => show((state.currentDoc && state.currentDoc.volverA) || (state.currentVentaId ? 'venta' : 'home')));
  $('#btnDocImprimir').addEventListener('click', imprimirDoc);
  $('#btnDocCompartir').addEventListener('click', compartirDoc);
  // Valores iniciales del wizard
  aplicarTipoVenta();
  entrarApp();
  // Service worker (PWA instalable)
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => { /* sin SW la app sigue funcionando en línea */ });
  }
}
document.addEventListener('DOMContentLoaded', init);
