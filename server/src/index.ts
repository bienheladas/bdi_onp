import express from "express";
import cors from "cors";
import { PrismaClient, Prisma } from "@prisma/client";

const prisma = new PrismaClient();
const app = express();
app.use(cors());
app.use(express.json());

// Auth simple por clave compartida. En local (sin ADMIN_PASSWORD) queda abierto;
// en el despliegue se exige el header x-admin-key == ADMIN_PASSWORD.
const ADMIN_KEY = process.env.ADMIN_PASSWORD || "";
app.use("/api", (req, res, next) => {
  if (!ADMIN_KEY) return next();
  if (req.headers["x-admin-key"] === ADMIN_KEY) return next();
  return res.status(401).json({ error: "No autorizado" });
});

// Tablas de relación: NO son secciones propias; se gestionan como modales desde los padres.
const HIDDEN = new Set(["aplicacion_basedatos", "aplicacion_proceso", "integraciones", "esquema"]);
// Campos que no se muestran en la web (siguen en la BD). Los JSON de aplicacion son la
// versión antigua de los esquemas: la fuente ahora es la tabla esquema (por par app–BD).
const HIDDEN_FIELDS: Record<string, Set<string>> = {
  aplicacion: new Set(["instancia_bd", "nombre_esquema_bd"]),
};
// Campo(s) descriptivos para mostrar en dropdowns/listas
const LABELS: Record<string, string[]> = {
  ambiente: ["desc_ambiente"], motor_bd: ["desc_motor"], tipo_proceso: ["desc_tipo_proceso"],
  dominio_funcional: ["desc_dominio"], proceso_negocio: ["desc_proceso"],
  servidor: ["nombre_servidor"], base_de_datos: ["nombre_bd"], aplicacion: ["id_app", "nombre_app"],
};
// Relaciones gestionables en modales, por entidad padre
const REL: Record<string, any[]> = {
  aplicacion: [
    { key: "basedatos", label: "Bases de datos", mode: "nm", target: "base_de_datos" },
    { key: "procesos", label: "Procesos", mode: "nm", target: "proceso_negocio" },
  ],
  base_de_datos: [
    { key: "aplicaciones", label: "Aplicaciones", mode: "nm", target: "aplicacion" },
    { key: "integraciones", label: "Integraciones", mode: "child", target: "integraciones" },
  ],
};

const AUDIT = new Set(["fecha_creacion", "ip_creacion", "fecha_modificacion", "ip_modificacion"]);
const clientIp = (req: any) => (String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.ip || null);

const models = (Prisma.dmmf.datamodel.models as any[]);
const modelByName = (n: string) => models.find((m) => m.name === n);
const delegate = (n: string) => (prisma as any)[n];
const labelOf = (n: string) => LABELS[n] ?? [modelByName(n)?.fields.find((f: any) => f.kind === "scalar" && f.type === "String")?.name].filter(Boolean);

function pkFields(m: any): string[] {
  if (m.primaryKey?.fields?.length) return m.primaryKey.fields;
  const idf = m.fields.find((f: any) => f.isId);
  return idf ? [idf.name] : [];
}
function scalarMeta(m: any) {
  const fk: Record<string, any> = {};
  for (const f of m.fields) {
    if (f.kind === "object" && !f.isList && f.relationFromFields?.length === 1) {
      const col = f.relationFromFields[0];
      fk[col] = { model: f.type, toField: f.relationToFields[0], label: labelOf(f.type) };
    }
  }
  const pks = pkFields(m);
  const fields = m.fields
    .filter((f: any) => (f.kind === "scalar" || f.kind === "enum") && !HIDDEN_FIELDS[m.name]?.has(f.name))
    .map((f: any) => ({
      name: f.name,
      type: f.type,                       // Int, String, Decimal, Json, DateTime, Boolean...
      isPk: pks.includes(f.name),
      hasDefault: !!f.hasDefaultValue,    // identity/serial => no pedir en alta
      required: f.isRequired && !f.hasDefaultValue,
      auto: AUDIT.has(f.name),            // auditoría: no editable (la pone el servidor)
      fk: fk[f.name] || null,
    }));
  return { pks, fields };
}

function coerce(m: any, col: string, val: any) {
  if (val === "" || val === undefined) return null;
  const f = m.fields.find((x: any) => x.name === col);
  if (!f) return val;
  if (val === null) return null;
  if (f.type === "Int") return typeof val === "number" ? val : parseInt(val, 10);
  if (f.type === "Decimal") return new Prisma.Decimal(val);
  if (f.type === "Boolean") return val === true || val === "true";
  return val; // String, Json, DateTime
}
function writableBody(m: any, body: any, isCreate: boolean) {
  const out: any = {};
  for (const f of m.fields) {
    if (f.kind !== "scalar" && f.kind !== "enum") continue;
    if (AUDIT.has(f.name)) continue;                    // auditoría: la pone el servidor
    if (!(f.name in body)) continue;
    if (f.isId && f.hasDefaultValue) continue;          // identity: no insertar/editar id
    out[f.name] = coerce(m, f.name, body[f.name]);
  }
  return out;
}
function whereId(m: any, params: any) {
  const pks = pkFields(m);
  if (pks.length === 1) return { [pks[0]]: coerce(m, pks[0], params.id) };
  // compuesta: nombre del índice = campos unidos por "_"
  const name = pks.join("_");
  const obj: any = {};
  for (const k of pks) obj[k] = coerce(m, k, params[k]);
  return { [name]: obj };
}

// ---------------- META ----------------
app.get("/api/meta", (_req, res) => {
  const main = models
    .filter((m) => !HIDDEN.has(m.name))
    .map((m) => {
      const { pks, fields } = scalarMeta(m);
      return { name: m.name, label: m.name, pks, labelFields: labelOf(m.name), fields, relations: REL[m.name] || [] };
    });
  res.json(main);
});

const asLabel = (n: string, row: any) => labelOf(n).map((f) => row[f]).filter((v) => v != null).join(" · ");

// Orden alfabético real (ignora mayúsculas/acentos, "AP9" < "AP10"). La collation de la BD es "C"
// (mayúsculas antes que minúsculas), por eso el orden por columna se hace en memoria.
const collator = new Intl.Collator("es", { sensitivity: "base", numeric: true });
function cmpVal(a: any, b: any) {
  if (a == null || b == null) return a == null ? (b == null ? 0 : 1) : -1;   // nulos al final
  if (typeof a === "string") return collator.compare(a, b);
  if (a instanceof Date) return a.getTime() - b.getTime();
  return Number(a) - Number(b);                                                // Int, Decimal
}

// ---------------- PENDIENTES (tablero de lo que falta levantar) ----------------
// Las BD marcadas estado_bd = 'Fuera de alcance' quedan excluidas del tablero.
// OJO: el { not } de Prisma excluye los NULL, así que se incluyen explícitamente
// (las BD con estado en blanco SÍ son pendientes y deben aparecer).
const FUERA_ALCANCE = "Fuera de alcance";
app.get("/api/pendientes", async (_req, res) => {
  try {
    const bd_sin_app = await prisma.base_de_datos.findMany({
      where: {
        aplicacion_basedatos: { none: {} },
        OR: [{ estado_bd: null }, { estado_bd: { not: FUERA_ALCANCE } }],
      },
      select: { id_bd: true, nombre_bd: true }, orderBy: { nombre_bd: "asc" },
    });
    const apps_sin_proceso = await prisma.aplicacion.findMany({
      where: { aplicacion_basedatos: { some: {} }, aplicacion_proceso: { none: {} } },
      select: { id: true, id_app: true, nombre_app: true }, orderBy: { id_app: "asc" },
    });
    res.json({ bd_sin_app, apps_sin_proceso });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ---------------- CRUD genérico (entidades principales) ----------------
app.get("/api/:model", async (req, res) => {
  try {
    const m = modelByName(req.params.model);
    if (!m || HIDDEN.has(m.name)) return res.status(404).json({ error: "modelo no disponible" });
    const take = Math.min(parseInt((req.query.take as string) || "50", 10), 500);
    const skip = parseInt((req.query.skip as string) || "0", 10);
    const q = (req.query.q as string || "").trim();
    let where: any = undefined;
    if (q) {
      const strFields = m.fields.filter((f: any) => f.kind === "scalar" && f.type === "String");
      where = { OR: strFields.map((f: any) => ({ [f.name]: { contains: q, mode: "insensitive" } })) };
    }
    const pks = pkFields(m);
    const sortF = m.fields.find((f: any) => f.name === req.query.sort && f.kind === "scalar" && f.type !== "Json");
    if (!sortF) {
      const [rows, total] = await Promise.all([
        delegate(m.name).findMany({ where, take, skip, orderBy: pks.length === 1 ? { [pks[0]]: "asc" } : undefined }),
        delegate(m.name).count({ where }),
      ]);
      return res.json({ rows, total });
    }
    // ?sort=<columna>&dir=asc|desc. Una FK se ordena por la etiqueta del registro relacionado.
    const dir = req.query.dir === "desc" ? -1 : 1;
    const relF = m.fields.find((f: any) => f.kind === "object" && !f.isList && f.relationFromFields?.length === 1 && f.relationFromFields[0] === sortF.name);
    const all = await delegate(m.name).findMany({ where, include: relF ? { [relF.name]: true } : undefined });
    const key = (r: any) => relF ? (r[relF.name] ? asLabel(relF.type, r[relF.name]) : null) : r[sortF.name];
    all.sort((a: any, b: any) => {
      const ka = key(a), kb = key(b);
      if (ka == null || kb == null) return cmpVal(ka, kb);                       // nulos al final en ambos sentidos
      return dir * cmpVal(ka, kb) || cmpVal(a[pks[0]], b[pks[0]]);
    });
    const rows = all.slice(skip, skip + take);
    if (relF) rows.forEach((r: any) => delete r[relF.name]);
    res.json({ rows, total: all.length });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

app.get("/api/:model/options", async (req, res) => {
  try {
    const m = modelByName(req.params.model);
    if (!m) return res.status(404).json({ error: "modelo no disponible" });
    const rows = await delegate(m.name).findMany({ take: 2000 });
    const pk = pkFields(m)[0];
    res.json(rows.map((r: any) => ({ value: r[pk], label: asLabel(m.name, r) || String(r[pk]) })).sort((a: any, b: any) => collator.compare(a.label, b.label)));
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

app.get("/api/:model/:id", async (req, res) => {
  try {
    const m = modelByName(req.params.model);
    if (!m || HIDDEN.has(m.name)) return res.status(404).json({ error: "modelo no disponible" });
    const row = await delegate(m.name).findUnique({ where: whereId(m, req.params) });
    if (!row) return res.status(404).json({ error: "no encontrado" });
    res.json(row);
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

app.post("/api/:model", async (req, res) => {
  try {
    const m = modelByName(req.params.model);
    if (!m || HIDDEN.has(m.name)) return res.status(404).json({ error: "modelo no disponible" });
    const data = writableBody(m, req.body, true); data.ip_creacion = clientIp(req);
    const row = await delegate(m.name).create({ data });
    res.json(row);
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

app.put("/api/:model/:id", async (req, res) => {
  try {
    const m = modelByName(req.params.model);
    if (!m || HIDDEN.has(m.name)) return res.status(404).json({ error: "modelo no disponible" });
    const data = writableBody(m, req.body, false); data.fecha_modificacion = new Date(); data.ip_modificacion = clientIp(req);
    const row = await delegate(m.name).update({ where: whereId(m, req.params), data });
    res.json(row);
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

app.delete("/api/:model/:id", async (req, res) => {
  try {
    const m = modelByName(req.params.model);
    if (!m || HIDDEN.has(m.name)) return res.status(404).json({ error: "modelo no disponible" });
    await delegate(m.name).delete({ where: whereId(m, req.params) });
    res.json({ ok: true });
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

// ---------------- Relaciones (modales desde padres) ----------------
// Esquemas de un par app–BD, ordenados por nombre
const esquemasInclude = { esquema: { select: { id_esquema: true, nombre_esquema: true }, orderBy: { nombre_esquema: "asc" as const } } };
// Quitar un vínculo app–BD: se bloquea si el par tiene esquemas (no se borran en cascada)
async function delAppBd(id_aplicacion: number, id_bd: number) {
  const n = await prisma.esquema.count({ where: { id_aplicacion, id_bd } });
  if (n > 0) throw new Error(`Este vínculo tiene ${n} esquema(s) registrado(s); quítalos primero.`);
  await prisma.aplicacion_basedatos.delete({ where: { id_aplicacion_id_bd: { id_aplicacion, id_bd } } });
}
// aplicacion <-> base_de_datos (aplicacion_basedatos)
app.get("/api/aplicacion/:id/basedatos", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const links = await prisma.aplicacion_basedatos.findMany({ where: { id_aplicacion: id }, include: { base_de_datos: true, ...esquemasInclude }, orderBy: { base_de_datos: { nombre_bd: "asc" } } });
  res.json(links.map((l) => ({ id_aplicacion: l.id_aplicacion, id_bd: l.id_bd, nombre_bd: l.base_de_datos.nombre_bd, esquemas: l.esquema })));
});
app.post("/api/aplicacion/:id/basedatos", async (req, res) => {
  try { await prisma.aplicacion_basedatos.create({ data: { id_aplicacion: +req.params.id, id_bd: +req.body.id_bd, ip_creacion: clientIp(req) } }); res.json({ ok: true }); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});
app.delete("/api/aplicacion/:id/basedatos/:id_bd", async (req, res) => {
  try { await delAppBd(+req.params.id, +req.params.id_bd); res.json({ ok: true }); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});
// esquemas de un par app–BD (esquema). Se usan desde ambos modales (app y BD).
app.post("/api/aplicacion/:id/basedatos/:id_bd/esquemas", async (req, res) => {
  try {
    const nombre = String(req.body.nombre_esquema || "").trim();
    if (!nombre) return res.status(400).json({ error: "Indica el nombre del esquema." });
    const row = await prisma.esquema.create({ data: { id_aplicacion: +req.params.id, id_bd: +req.params.id_bd, nombre_esquema: nombre, ip_creacion: clientIp(req) } });
    res.json(row);
  } catch (e: any) {
    if (e.code === "P2002") return res.status(400).json({ error: `El esquema "${String(req.body.nombre_esquema).trim()}" ya está registrado para esta app y BD.` });
    res.status(400).json({ error: e.message });
  }
});
app.delete("/api/aplicacion/:id/basedatos/:id_bd/esquemas/:id_esquema", async (req, res) => {
  try {
    const { count } = await prisma.esquema.deleteMany({ where: { id_esquema: +req.params.id_esquema, id_aplicacion: +req.params.id, id_bd: +req.params.id_bd } });
    if (!count) return res.status(404).json({ error: "Esquema no encontrado." });
    res.json({ ok: true });
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});
// aplicacion <-> proceso_negocio (aplicacion_proceso)
app.get("/api/aplicacion/:id/procesos", async (req, res) => {
  const links = await prisma.aplicacion_proceso.findMany({ where: { id_aplicacion: +req.params.id }, include: { proceso_negocio: true } });
  res.json(links.map((l) => ({ id_proceso: l.id_proceso, desc_proceso: l.proceso_negocio.desc_proceso })));
});
app.post("/api/aplicacion/:id/procesos", async (req, res) => {
  try { await prisma.aplicacion_proceso.create({ data: { id_aplicacion: +req.params.id, id_proceso: +req.body.id_proceso, ip_creacion: clientIp(req) } }); res.json({ ok: true }); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});
app.delete("/api/aplicacion/:id/procesos/:id_proceso", async (req, res) => {
  try { await prisma.aplicacion_proceso.delete({ where: { id_aplicacion_id_proceso: { id_aplicacion: +req.params.id, id_proceso: +req.params.id_proceso } } }); res.json({ ok: true }); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});
// base_de_datos -> aplicaciones (solo lectura)
app.get("/api/base_de_datos/:id/aplicaciones", async (req, res) => {
  const links = await prisma.aplicacion_basedatos.findMany({ where: { id_bd: +req.params.id }, include: { aplicacion: true, ...esquemasInclude }, orderBy: { aplicacion: { id_app: "asc" } } });
  res.json(links.map((l) => ({ id: l.id_aplicacion, id_aplicacion: l.id_aplicacion, id_bd: l.id_bd, id_app: l.aplicacion.id_app, nombre_app: l.aplicacion.nombre_app, esquemas: l.esquema })));
});
app.post("/api/base_de_datos/:id/aplicaciones", async (req, res) => {
  try { await prisma.aplicacion_basedatos.create({ data: { id_bd: +req.params.id, id_aplicacion: +req.body.id, ip_creacion: clientIp(req) } }); res.json({ ok: true }); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});
app.delete("/api/base_de_datos/:id/aplicaciones/:aid", async (req, res) => {
  try { await delAppBd(+req.params.aid, +req.params.id); res.json({ ok: true }); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});
// base_de_datos -> integraciones (hijas; CRUD scoped al origen)
app.get("/api/base_de_datos/:id/integraciones", async (req, res) => {
  const rows = await prisma.integraciones.findMany({
    where: { id_bd_origen: +req.params.id },
    include: { base_de_datos_integraciones_id_bd_destinoTobase_de_datos: true },
  });
  res.json(rows.map((r) => ({
    id_integracion: r.id_integracion, mecanismo: r.mecanismo, nombre_enlace: r.nombre_enlace,
    esquema_owner: r.esquema_owner, estado_enlace: r.estado_enlace, id_bd_destino: r.id_bd_destino,
    destino: r.base_de_datos_integraciones_id_bd_destinoTobase_de_datos?.nombre_bd || r.destino_externo,
  })));
});
app.post("/api/base_de_datos/:id/integraciones", async (req, res) => {
  try {
    const b = req.body;
    const row = await prisma.integraciones.create({ data: {
      id_bd_origen: +req.params.id, id_bd_destino: b.id_bd_destino ? +b.id_bd_destino : null,
      destino_externo: b.destino_externo || null, mecanismo: b.mecanismo || null,
      nombre_enlace: b.nombre_enlace || null, esquema_owner: b.esquema_owner || null, estado_enlace: b.estado_enlace || null,
      ip_creacion: clientIp(req),
    } });
    res.json(row);
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});
app.put("/api/base_de_datos/:id/integraciones/:iid", async (req, res) => {
  try {
    const b = req.body;
    const row = await prisma.integraciones.update({ where: { id_integracion: +req.params.iid }, data: {
      id_bd_destino: b.id_bd_destino ? +b.id_bd_destino : null, destino_externo: b.destino_externo || null,
      mecanismo: b.mecanismo || null, nombre_enlace: b.nombre_enlace || null,
      esquema_owner: b.esquema_owner || null, estado_enlace: b.estado_enlace || null,
    } });
    res.json(row);
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});
app.delete("/api/base_de_datos/:id/integraciones/:iid", async (req, res) => {
  try { await prisma.integraciones.delete({ where: { id_integracion: +req.params.iid } }); res.json({ ok: true }); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

const PORT = parseInt(process.env.PORT || "4100", 10);
app.listen(PORT, () => console.log(`BDI admin API en http://localhost:${PORT}`));
