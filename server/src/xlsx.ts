// Generación EN VIVO de los artefactos ADI en Excel (sin archivos estáticos).
// Replica el diseño oficial LCP: banda (3 filas) + metadatos + glosa de metodología
// + bloque de trazabilidad de campos + datos. ADI-08 va como ficha vertical.
import ExcelJS from "exceljs";

const NAVY = "FF1F3864", BLUE = "FF2F5496", GRAY = "FFF2F2F2",
  STEEL = "FFD6E0F0", ZEBRA = "FFEAF1FB", WHITE = "FFFFFFFF", LINKC = "FF0563C1";
const SEV: Record<string, string> = {
  "Crítica": "FF7F0000", "Critica": "FF7F0000", "Alta": "FFC00000",
  "Media": "FFBF8F00", "Medio": "FFBF8F00", "Baja": "FF548235",
};
const A1 = "Consorcio LCP — Líderes en Competencia Personal EIRL & Ascendant Group SAC";
const VERSION_VAL = "v1.0  ·  2026-10-29  ·  Consolidado AS-IS — validado por LCP, pendiente de conformidad ONP";
const EST_TAG: Record<string, string> = {
  derivado: "   ·   (derivado por cálculo)", manual: "   ·   (análisis experto LCP)",
};

const GLOSA_P1 =
  "El contenido de este artefacto se construyó sobre un modelo de datos único en el que LCP integró dos tipos de " +
  "insumos. Por un lado, las fuentes institucionales entregadas por la ONP —inventarios de aplicaciones, bases de " +
  "datos y servidores, documentos de arquitectura y de procesos, políticas y el modelo conceptual del SIIP—, que se " +
  "normalizaron y depuraron para eliminar duplicidades y homologar nomenclaturas. Por otro lado, información relevada " +
  "directamente por LCP, que generó nuevas fuentes de evidencia: la extracción de volumetría, estructura física y " +
  "metadata de las bases de datos mediante cuentas de solo lectura, el análisis de las integraciones (DataStage y " +
  "enlaces de base de datos) y las actas de las entrevistas con gestores y áreas usuarias. Cada fuente quedó " +
  "registrada y codificada (F-01 … F-29) en el artefacto ADI-01.";
const GLOSA_P2 =
  "Una vez integrada esa información, cada columna de este artefacto tiene un origen conocido y declarado. Algunas " +
  "columnas se toman directamente de una o varias fuentes; otras se obtienen mediante un cálculo o una derivación a " +
  "partir de los datos ya integrados; y otras corresponden a un análisis o interpretación elaborada por LCP. En este " +
  "último caso se explica la regla, fórmula o criterio que sustenta el valor, y el dato se marca con un asterisco (*) " +
  "en la tabla para distinguirlo de la información tomada tal cual de la fuente. Para facilitar la revisión, el bloque " +
  "«Trazabilidad de campos» que aparece a continuación indica, columna por columna, de qué fuente o fuentes proviene y " +
  "cómo se obtuvo, de manera que cualquier dato pueda verificarse desde este artefacto hasta su origen.";

type Meta = { a2: string; a3: string; meta: Record<string, string> };
const METALABELS = ["Tipo de artefacto", "Marco de referencia", "Responsable(s)",
  "Insumo requerido", "Stakeholder del insumo", "Versión / Fecha / Estado"];
const M: Record<string, Meta> = {
  "ADI-01": { a2: "ADI-01 · Fuentes de Información y Evidencias Técnicas", a3: "Entregable 2 · Diagnostico del ecosistema de datos (AS-IS)   |   Actividad 1 · Revisión y análisis de fuentes de información institucionales", meta: { "Tipo de artefacto": "Catálogo / Matriz (tabla rellenable)", "Marco de referencia": "TOGAF Fase C (Data Architecture) · DAMA-DMBOK: Metadata / Data Quality — inventario documental", "Responsable(s)": "Arquitecto de Datos, Especialista BD Senior", "Insumo requerido": "Documentos normativos, de arquitectura, diagramas, manuales, inventarios y reportes previos.", "Stakeholder del insumo": "UE003 / OTI / Áreas Usuarias" } },
  "ADI-03": { a2: "ADI-03 · Catálogo AS-IS de Fuentes de Datos Institucionales", a3: "Entregable 2 · Diagnostico del ecosistema de datos (AS-IS)   |   Actividad 3 · Identificación y caracterización de fuentes de datos", meta: { "Tipo de artefacto": "Catálogo / Matriz (tabla rellenable)", "Marco de referencia": "TOGAF: Data Component catalog · DAMA: Data Architecture / Metadata — catálogo de fuentes", "Responsable(s)": "Arquitecto de Datos, Especialista BD Senior, Analistas", "Insumo requerido": "Especificaciones de BD transaccionales, analíticas e históricas.", "Stakeholder del insumo": "OTI" } },
  "ADI-04": { a2: "ADI-04 · Matriz de Fuentes de Datos por Dominio Funcional", a3: "Entregable 2 · Diagnostico del ecosistema de datos (AS-IS)   |   Actividad 4 · Clasificación de fuentes de datos por dominio funcional", meta: { "Tipo de artefacto": "Catálogo / Matriz (tabla rellenable)", "Marco de referencia": "TOGAF: Data Entity/Business Function matrix · DAMA: Data Architecture", "Responsable(s)": "Arquitecto de Datos, Especialista BD Senior, Analistas", "Insumo requerido": "Clasificación institucional de datos por procesos misionales.", "Stakeholder del insumo": "Áreas Usuarias / Arq. Datos" } },
  "ADI-05": { a2: "ADI-05 · Mapa de Relaciones e Integraciones entre Fuentes de Datos", a3: "Entregable 2 · Diagnostico del ecosistema de datos (AS-IS)   |   Actividad 5 · Identificación de relaciones e integraciones entre fuentes", meta: { "Tipo de artefacto": "Catálogo / Matriz (tabla rellenable)", "Marco de referencia": "TOGAF: Data Dissemination diagram / Application-Data matrix", "Responsable(s)": "Arquitecto de Datos, Especialista BD Senior, Analistas", "Insumo requerido": "Documentación de interfaces, APIs y servicios de interoperabilidad.", "Stakeholder del insumo": "OTI" } },
  "ADI-07": { a2: "ADI-07 · Matriz de Volumetría y Criticidad de Fuentes de Datos", a3: "Entregable 2 · Diagnostico del ecosistema de datos (AS-IS)   |   Actividad 7 · Análisis de volumetría y criticidad de fuentes de datos", meta: { "Tipo de artefacto": "Catálogo / Matriz (tabla rellenable)", "Marco de referencia": "DAMA: Data Storage & Operations — volumetría · TOGAF: análisis de criticidad de datos", "Responsable(s)": "Especialista BD Senior, Especialista Funcional, Analistas", "Insumo requerido": "Reportes de almacenamiento, crecimiento (8 GB/mes) y criticidad.", "Stakeholder del insumo": "OTI (DBAs internos)" } },
  "ADI-08": { a2: "ADI-08 · Matriz de Brechas, Riesgos y Restricciones del Ecosistema de Datos", a3: "Entregable 2 · Diagnostico del ecosistema de datos (AS-IS)   |   Actividad 8 · Identificación de brechas, riesgos y restricciones", meta: { "Tipo de artefacto": "Catálogo / Matriz (tabla rellenable)", "Marco de referencia": "TOGAF: Gap Analysis (matriz de brechas) · gestión de riesgos de arquitectura", "Responsable(s)": "Arquitecto de Datos, Especialista BD Senior, Analistas", "Insumo requerido": "Reportes de incidentes, obsolescencia tecnológica y fallas de BD.", "Stakeholder del insumo": "OTI / Riesgos" } },
  "ADI-09": { a2: "ADI-09 · Modelo de Correspondencia Procesos, Dominios y Fuentes de Datos", a3: "Entregable 2 · Diagnostico del ecosistema de datos (AS-IS)   |   Actividad 9 · Correspondencia entre procesos, dominios y fuentes de datos", meta: { "Tipo de artefacto": "Catálogo / Matriz (tabla rellenable)", "Marco de referencia": "TOGAF: Data Entity/Business Function matrix — insumo del modelo conceptual", "Responsable(s)": "Arquitecto de Datos, Especialista BD Senior, Esp. Funcional, Analistas", "Insumo requerido": "Mapeo de actividades de negocio vs. repositorios (Anexo 01).", "Stakeholder del insumo": "Áreas Usuarias" } },
};

export type Traza = { columna_art: string; fuente_id: string | null; origen_pg: string; estado: string };

const solid = (argb: string) => ({ type: "pattern" as const, pattern: "solid" as const, fgColor: { argb } });
const thin = { style: "thin" as const, color: { argb: "FFD9D9D9" } };
const BORDER = { bottom: thin, right: thin };

function txtH(text: string, totw: number, base = 14, pad = 4) {
  const cpl = Math.max(totw * 0.78, 50);
  let lines = 0;
  for (const p of String(text).split("\n")) lines += Math.max(1, Math.ceil(p.length / cpl));
  return Math.max(16, lines * base + pad);
}

function isUrl(s: string) { return /^(https?:\/\/|www\.)/.test(s); }

export function newWorkbook() {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Consorcio LCP"; wb.created = new Date();
  return wb;
}

// banda + metadatos + metodología + trazabilidad. Devuelve la fila de inicio del contenido.
function topSection(ws: ExcelJS.Worksheet, lastC: number, id: string, traza: Traza[], totw: number, withTraza = true): number {
  const md = M[id];
  const two = lastC === 2;
  const full = (r: number, text: string, font: any, fillArgb: string | null, h: number | null, va = "middle") => {
    ws.mergeCells(r, 1, r, lastC);
    const c = ws.getCell(r, 1);
    c.value = text; c.font = font;
    if (fillArgb) c.fill = solid(fillArgb);
    c.alignment = { horizontal: "left", vertical: va as any, wrapText: true };
    if (h) ws.getRow(r).height = h;
    return c;
  };
  const labF = { name: "Calibri", size: 10, bold: true, color: { argb: NAVY } };
  const valF = { name: "Calibri", size: 10 };
  let r = 1;
  full(r++, A1, { name: "Calibri", size: 11, bold: true, color: { argb: WHITE } }, NAVY, 20);
  full(r++, md.a2, { name: "Calibri", size: 13, bold: true, color: { argb: WHITE } }, BLUE, 24);
  full(r++, md.a3, { name: "Calibri", size: 9, bold: true, color: { argb: NAVY } }, GRAY, 26);
  const metaAll: Record<string, string> = { ...md.meta, "Versión / Fecha / Estado": VERSION_VAL };
  for (const lab of METALABELS) {
    if (!(lab in metaAll)) continue;
    const val = metaAll[lab];
    if (two) {
      const k = ws.getCell(r, 1); k.value = lab; k.font = labF; k.fill = solid(GRAY);
      k.alignment = { horizontal: "left", vertical: "middle", wrapText: true };
      const v = ws.getCell(r, 2); v.value = val; v.font = valF;
      v.alignment = { horizontal: "left", vertical: "middle", wrapText: true };
    } else {
      ws.mergeCells(r, 1, r, 2);
      const k = ws.getCell(r, 1); k.value = lab; k.font = labF; k.fill = solid(GRAY);
      k.alignment = { horizontal: "left", vertical: "middle", wrapText: true };
      ws.mergeCells(r, 3, r, lastC);
      const v = ws.getCell(r, 3); v.value = val; v.font = valF;
      v.alignment = { horizontal: "left", vertical: "middle", wrapText: true };
    }
    ws.getRow(r).height = txtH(val, two ? totw : totw * 0.9);
    r++;
  }
  const glosa = GLOSA_P1 + (withTraza ? "\n" + GLOSA_P2 : "");
  full(r++, "Metodología de consolidación y relevamiento", labF, STEEL, 16);
  full(r++, glosa, { name: "Calibri", size: 9 }, null, txtH(glosa, totw), "top");
  if (withTraza) {
    full(r++, "Trazabilidad de campos  (campo  ←  fuente(s)  ·  regla / cálculo)", labF, STEEL, 16);
    for (const t of traza) {
      const fu = (t.fuente_id == null || t.fuente_id === "" || t.fuente_id === "-") ? "—" : t.fuente_id;
      const tag = EST_TAG[t.estado] || "";
      const txt = `${t.columna_art}      ←   Fuentes: ${fu}   ·   Regla/cálculo: ${t.origen_pg}${tag}`;
      full(r, txt, { name: "Calibri", size: 9 }, (r % 2 ? ZEBRA : null), txtH(txt, totw), "top");
      r++;
    }
  }
  r++; // separador
  return r;
}

// Leyenda de columnas al final de la hoja: una celda por columna (nombre + descripción).
function addLegend(ws: ExcelJS.Worksheet, lastC: number, startRow: number, columns: string[],
  desc: Record<string, string>, totw: number) {
  let r = startRow + 1; // separador
  ws.mergeCells(r, 1, r, lastC);
  const b = ws.getCell(r, 1); b.value = "Leyenda de columnas";
  b.font = { name: "Calibri", size: 10, bold: true, color: { argb: NAVY } }; b.fill = solid(STEEL);
  b.alignment = { horizontal: "left", vertical: "middle", wrapText: true }; ws.getRow(r).height = 16; r++;
  for (const c of columns) {
    const d = desc[c] || "";
    const txt = d ? `${c}:   ${d}` : c;
    ws.mergeCells(r, 1, r, lastC);
    const cell = ws.getCell(r, 1); cell.value = txt;
    cell.font = { name: "Calibri", size: 9 };
    cell.alignment = { horizontal: "left", vertical: "top", wrapText: true };
    if (r % 2) cell.fill = solid(ZEBRA);
    ws.getRow(r).height = txtH(txt, totw); r++;
  }
}

export function addSheet(wb: ExcelJS.Workbook, id: string, columns: string[], rows: string[][], traza: Traza[], desc: Record<string, string> = {}) {
  const ws = wb.addWorksheet(id, { views: [] });
  if (id === "ADI-08") { addFicha(ws, columns, rows, traza, desc); return; }
  const ncol = columns.length;
  const maxlen = columns.map((c) => c.length);
  for (const row of rows) row.forEach((v, i) => { const s = v == null ? "" : String(v); if (s.length > maxlen[i]) maxlen[i] = s.length; });
  const widths = maxlen.map((ml) => Math.min(Math.max(ml + 2, 9), 60));
  widths.forEach((wd, i) => { ws.getColumn(i + 1).width = wd; });
  const totw = widths.reduce((a, b) => a + b, 0);
  const hr = topSection(ws, ncol, id, traza, totw, id !== "ADI-01");
  // cabecera de tabla
  columns.forEach((c, i) => {
    const cell = ws.getCell(hr, i + 1);
    cell.value = c; cell.font = { name: "Calibri", size: 10, bold: true, color: { argb: WHITE } };
    cell.fill = solid(NAVY); cell.alignment = { horizontal: "left", vertical: "middle", wrapText: true };
  });
  ws.getRow(hr).height = 30;
  rows.forEach((row, ri) => {
    const rr = hr + 1 + ri;
    const zebra = ri % 2 ? ZEBRA : null;
    row.forEach((v, i) => {
      const s = v == null ? "" : String(v);
      const cell = ws.getCell(rr, i + 1);
      cell.font = { name: "Calibri", size: 10 };
      cell.alignment = { vertical: "top", wrapText: s.length > 40 };
      cell.border = BORDER;
      if (zebra) cell.fill = solid(zebra);
      if (isUrl(s)) { cell.value = { text: s, hyperlink: s }; cell.font = { name: "Calibri", size: 10, color: { argb: LINKC }, underline: true }; }
      else cell.value = s;
    });
  });
  ws.views = [{ state: "frozen", ySplit: hr }];
  ws.autoFilter = { from: { row: hr, column: 1 }, to: { row: hr + rows.length, column: ncol } };
  addLegend(ws, ncol, hr + rows.length, columns, desc, totw);
}

function addFicha(ws: ExcelJS.Worksheet, columns: string[], rows: string[][], traza: Traza[], desc: Record<string, string>) {
  ws.getColumn(1).width = 30; ws.getColumn(2).width = 108;
  let r = topSection(ws, 2, "ADI-08", traza, 138);
  const idx: Record<string, number> = {}; columns.forEach((c, i) => (idx[c] = i));
  const labF = { name: "Calibri", size: 10, bold: true, color: { argb: NAVY } };
  const valF = { name: "Calibri", size: 10 };
  const skip = new Set(["ID", "Tema"]);
  for (const row of rows) {
    const v: Record<string, string> = {}; columns.forEach((c, i) => (v[c] = row[i] == null ? "" : String(row[i])));
    ws.mergeCells(r, 1, r, 2);
    const hc = ws.getCell(r, 1); hc.value = `${v["ID"] || ""}  ·  ${v["Tema"] || ""}`;
    hc.font = { name: "Calibri", size: 11, bold: true, color: { argb: WHITE } };
    hc.fill = solid(SEV[v["Severidad"]] || NAVY);
    hc.alignment = { horizontal: "left", vertical: "middle" };
    ws.getRow(r).height = 20; r++;
    let bi = 0;
    for (const c of columns) {
      if (skip.has(c)) continue;
      const k = ws.getCell(r, 1); k.value = c; k.font = labF; k.fill = solid(GRAY);
      k.alignment = { horizontal: "left", vertical: "top", wrapText: true }; k.border = BORDER;
      const val = ws.getCell(r, 2); val.value = v[c]; val.font = valF;
      val.alignment = { horizontal: "left", vertical: "top", wrapText: true }; val.border = BORDER;
      if (bi % 2) val.fill = solid(ZEBRA);
      bi++; r++;
    }
    r++;
  }
  addLegend(ws, 2, r, columns, desc, 138);
}

export function addPortada(wb: ExcelJS.Workbook, ids: string[]) {
  const ws = wb.addWorksheet("Portada", { views: [] });
  ws.getColumn(1).width = 30; for (let i = 2; i <= 6; i++) ws.getColumn(i).width = 22;
  const full = (r: number, text: string, font: any, fillArgb: string | null, h: number | null, va = "middle") => {
    ws.mergeCells(r, 1, r, 6); const c = ws.getCell(r, 1); c.value = text; c.font = font;
    if (fillArgb) c.fill = solid(fillArgb);
    c.alignment = { horizontal: "left", vertical: va as any, wrapText: true };
    if (h) ws.getRow(r).height = h; return c;
  };
  full(1, A1, { name: "Calibri", size: 11, bold: true, color: { argb: WHITE } }, NAVY, 22);
  full(2, "Documento Equivalente de la BDI — Artefactos del Diagnóstico AS-IS", { name: "Calibri", size: 15, bold: true, color: { argb: WHITE } }, BLUE, 30);
  full(3, "Entregable 2 · Diagnóstico del ecosistema de datos (AS-IS)", { name: "Calibri", size: 10, bold: true, color: { argb: NAVY } }, GRAY, 22);
  full(4, VERSION_VAL, { name: "Calibri", size: 9, italic: true }, null, 18);
  full(6, "Contenido", { name: "Calibri", size: 11, bold: true, color: { argb: NAVY } }, STEEL, 16);
  let r = 7;
  for (const id of ids) { full(r, `${id}  ·  ${M[id]?.a2.split("· ")[1] || id}`, { name: "Calibri", size: 10 }, (r % 2 ? ZEBRA : null), 16); r++; }
  r++;
  full(r++, "Metodología de consolidación y relevamiento", { name: "Calibri", size: 11, bold: true, color: { argb: NAVY } }, STEEL, 16);
  full(r, GLOSA, { name: "Calibri", size: 9 }, null, txtH(GLOSA, 180), "top");
}
