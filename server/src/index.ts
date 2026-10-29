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
const HIDDEN = new Set(["aplicacion_basedatos", "aplicacion_proceso", "integraciones", "esquema", "esquema_aplicacion", "tabla", "columna"]);
// Campos que no se muestran en la web (siguen en la BD). Los JSON de aplicacion son la
// versión antigua de los esquemas: la fuente ahora es la tabla esquema (por par app–BD).
const HIDDEN_FIELDS: Record<string, Set<string>> = {
  aplicacion: new Set(["nombre_esquema_bd", "area_usuaria_resp", "unidad_jerarquica"]),
};
// Campo(s) descriptivos para mostrar en dropdowns/listas
const LABELS: Record<string, string[]> = {
  ambiente: ["desc_ambiente"], motor_bd: ["desc_motor"], tipo_proceso: ["desc_tipo_proceso"],
  dominio_funcional: ["desc_dominio"], proceso_negocio: ["desc_proceso"],
  servidor: ["nombre_servidor"], base_de_datos: ["nombre_bd"], aplicacion: ["id_app", "nombre_app"],
  oficina: ["sigla", "nombre_vigente"],
};
// Campos de texto respaldados por un catálogo => en la web se pintan como dropdown (no texto libre).
const CATALOG_FIELDS: Record<string, Record<string, string>> = {
  aplicacion: { area_usuaria_resp: "oficina", unidad_jerarquica: "oficina" },
};
// Relaciones gestionables en modales, por entidad padre
const REL: Record<string, any[]> = {
  aplicacion: [
    { key: "basedatos", label: "Bases de datos", mode: "nm", target: "base_de_datos" },
    { key: "procesos", label: "Procesos", mode: "nm", target: "proceso_negocio" },
    { key: "areas", label: "Áreas propietarias", mode: "nm", target: "oficina" },
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
      catalog: CATALOG_FIELDS[m.name]?.[f.name] || null,   // dropdown desde catálogo (p.ej. oficina)
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

// ---------------- Catálogo de áreas/unidades (oficina) para dropdowns ----------------
// 'oficina' no está en el cliente Prisma (tabla creada aparte) => consulta cruda.
app.get("/api/oficinas", async (_req, res) => {
  try {
    const rows = await prisma.$queryRaw<{ sigla: string; nombre_vigente: string }[]>`
      select sigla, nombre_vigente from oficina order by sigla`;
    res.json(rows.map((r) => ({ value: r.sigla, label: `${r.sigla} · ${r.nombre_vigente}` })));
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ---------------- ARTEFACTOS en vivo (Reportería) ----------------
// Cada artefacto se arma desde la data actual (no un Excel en duro). Devuelve
// {columns, rows, links} igual que los <ID>.json estáticos.
const ARTE: Record<string, { titulo: string; columns: string[]; sql: string }> = {
  "ADI-05": {
    titulo: "Mapa de Relaciones e Integraciones entre Fuentes de Datos (en vivo)",
    columns: ["N°", "Fuente origen", "Motor origen", "Fuente destino / consumidora", "Motor destino",
      "Mecanismo", "Nombre del enlace / job", "Esquema / owner", "Visibilidad", "Usuario remoto (DB Link)",
      "Riesgo del enlace", "Tabla(s) destino", "Modo de carga",
      "Objetivo / propósito", "Proveedor", "Estado"],
    sql: `
      select
        (row_number() over (order by i.mecanismo, i.id_integracion))::int as "N°",
        coalesce(bo.nombre_bd, i.origen_externo) as "Fuente origen",
        mo.desc_motor as "Motor origen",
        coalesce(bd.nombre_bd, i.destino_externo) as "Fuente destino / consumidora",
        md.desc_motor as "Motor destino",
        i.mecanismo as "Mecanismo",
        i.nombre_enlace as "Nombre del enlace / job",
        coalesce(dl.owner, d.esquema_owner) as "Esquema / owner",
        case when i.mecanismo <> 'DB Link' then '' when dl.es_publico then 'Público' else 'Privado' end as "Visibilidad",
        coalesce(dl.usuario_remoto,'') as "Usuario remoto (DB Link)",
        coalesce(dl.nivel_riesgo,'') as "Riesgo del enlace",
        d.tabla_destino as "Tabla(s) destino",
        d.modo_carga as "Modo de carga",
        d.objetivo as "Objetivo / propósito",
        d.proveedor as "Proveedor",
        coalesce(i.estado_enlace,'') as "Estado"
      from integraciones i
      left join base_de_datos bo on bo.id_bd=i.id_bd_origen
      left join motor_bd mo on mo.id_motor_bd=bo.id_motor_bd
      left join base_de_datos bd on bd.id_bd=i.id_bd_destino
      left join motor_bd md on md.id_motor_bd=bd.id_motor_bd
      left join integracion_datastage d on d.id_integracion=i.id_integracion
      left join integracion_dblink dl on dl.id_integracion=i.id_integracion
      order by i.mecanismo, i.id_integracion
    `,
  },
  "ADI-03": {
    titulo: "Catálogo AS-IS de Fuentes de Datos Institucionales (en vivo)",
    columns: ["ID", "Fuente / BD", "Descripción general", "Motor", "Versión", "Edición", "Ambiente", "Servidor",
      "Datacenter", "Sistema operativo", "Tamaño (GB)", "N° esquemas", "N° tablas", "Crecimiento (GB/mes)",
      "Tipo de fuente", "Tipo de información gestionada",
      "Tipo(s) de proceso", "Dominio(s) funcional(es)", "Proceso(s) de negocio", "Área usuaria responsable",
      "Área técnica responsable", "Aplicaciones consumidoras",
      "Relevancia p/ trazabilidad", "Restricciones / limitaciones", "Estado", "Observaciones de uso actual"],
    sql: `
      select
        'FTE-'||lpad((row_number() over (order by b.nombre_bd))::text,3,'0') as "ID",
        b.nombre_bd as "Fuente / BD",
        case when length(trim(coalesce(b.desc_base_datos,'')))>=25 then b.desc_base_datos
             else coalesce(nullif(trim(
               'BD '||coalesce(m.desc_motor,'')||coalesce(' '||b.version_bd,'')||' en '||coalesce(lower(a.desc_ambiente),'ambiente n/d')||
               coalesce('; soporta '||(select string_agg(distinct ap.id_app,', ' order by ap.id_app) from aplicacion_basedatos abx join aplicacion ap on ap.id=abx.id_aplicacion where abx.id_bd=b.id_bd),'')||
               coalesce('; dominio '||(select string_agg(distinct df.desc_dominio,', ') from aplicacion_basedatos ab join aplicacion_proceso apx on apx.id_aplicacion=ab.id_aplicacion join proceso_negocio pn on pn.id_proceso=apx.id_proceso join dominio_funcional df on df.id_dominio=pn.id_dominio where ab.id_bd=b.id_bd),'')
             ),'')||' *','') end as "Descripción general",
        m.desc_motor as "Motor", b.version_bd as "Versión", b.edicion as "Edición", a.desc_ambiente as "Ambiente",
        s.nombre_servidor as "Servidor", s.ubicacion as "Datacenter",
        nullif(trim(coalesce(s.nombre_so,'')||' '||coalesce(s.version_so,'')),'') as "Sistema operativo",
        b.tamano_gb as "Tamaño (GB)", b.nro_esquemas as "N° esquemas", b.nro_tablas as "N° tablas",
        b.crecimiento_gb as "Crecimiento (GB/mes)",
        coalesce(nullif(trim(b.tipo_bd),''),
          (case when lower(b.nombre_bd||coalesce(b.desc_base_datos,'')) ~ 'aud' then 'Auditoría'
                when lower(b.nombre_bd||coalesce(b.desc_base_datos,'')) ~ '(bdi|dbi|integ|consolid)' then 'Integración/consolidación'
                when lower(b.nombre_bd||coalesce(b.desc_base_datos,'')) ~ '(gcd|glcd|jira|www|sharepoint|wss|content|document|sgd)' then 'Documental/gestión de contenidos'
                when lower(b.nombre_bd||coalesce(b.desc_base_datos,'')) ~ '(dwh|datawarehouse|olap| bi |analit|fnet|fnge|fnle)' then 'Analítica/reportería'
                when lower(b.nombre_bd||coalesce(b.desc_base_datos,'')) ~ '(harvest|aranda|pcsistel)' then 'Herramienta/soporte TI'
                else 'Transaccional (relacional)' end)||' *') as "Tipo de fuente",
        case when lower(m.desc_motor) like '%oracle%'
             then coalesce(nullif(trim(b.tipo_info_gest),''), nullif(trim(b.entidades_conceptuales),'')||' *', '')
             else coalesce(nullif(trim(b.tipo_info_gest),''),'') end as "Tipo de información gestionada",
        coalesce((select string_agg(distinct tp.desc_tipo_proceso, ' | ' order by tp.desc_tipo_proceso)
                  from aplicacion_basedatos ab join aplicacion_proceso ap on ap.id_aplicacion=ab.id_aplicacion
                  join proceso_negocio pn on pn.id_proceso=ap.id_proceso join dominio_funcional df on df.id_dominio=pn.id_dominio
                  join tipo_proceso tp on tp.id_tipo_proceso=df.id_tipo_proceso where ab.id_bd=b.id_bd),'') as "Tipo(s) de proceso",
        coalesce((select string_agg(distinct df.desc_dominio, ' | ' order by df.desc_dominio)
                  from aplicacion_basedatos ab join aplicacion_proceso ap on ap.id_aplicacion=ab.id_aplicacion
                  join proceso_negocio pn on pn.id_proceso=ap.id_proceso join dominio_funcional df on df.id_dominio=pn.id_dominio
                  where ab.id_bd=b.id_bd),'') as "Dominio(s) funcional(es)",
        coalesce((select string_agg(distinct pn.desc_proceso, ' | ' order by pn.desc_proceso)
                  from aplicacion_basedatos ab join aplicacion_proceso ap on ap.id_aplicacion=ab.id_aplicacion
                  join proceso_negocio pn on pn.id_proceso=ap.id_proceso where ab.id_bd=b.id_bd),'') as "Proceso(s) de negocio",
        coalesce((select string_agg(distinct o.nombre_vigente, ' · ')
                  from aplicacion_basedatos ab join aplicacion_area aa on aa.id_aplicacion=ab.id_aplicacion
                  join oficina o on trim(o.sigla)=trim(aa.sigla) where ab.id_bd=b.id_bd),
                 nullif(trim(b.area_usuario_resp_onp),''), '') as "Área usuaria responsable",
        coalesce(nullif(trim(b.area_tecnica_resp_onp),''),
                 (select string_agg(distinct nullif(trim(ap.gestor_resp),''),' · ') from aplicacion_basedatos abx join aplicacion ap on ap.id=abx.id_aplicacion where abx.id_bd=b.id_bd), '') as "Área técnica responsable",
        (select string_agg(distinct ap.id_app||' '||coalesce(ap.nombre_app,''),' | ') from aplicacion_basedatos abx join aplicacion ap on ap.id=abx.id_aplicacion where abx.id_bd=b.id_bd) as "Aplicaciones consumidoras",
        (case when lower(coalesce(b.entidades_conceptuales,'')) ~ '(expediente|pensi|prestaci|aporte|asegurado|derecho|planilla)' then 'Alta *'
              when exists(select 1 from aplicacion_basedatos ab join aplicacion_proceso ap on ap.id_aplicacion=ab.id_aplicacion join proceso_negocio pn on pn.id_proceso=ap.id_proceso join dominio_funcional df on df.id_dominio=pn.id_dominio join tipo_proceso tp on tp.id_tipo_proceso=df.id_tipo_proceso where ab.id_bd=b.id_bd and tp.desc_tipo_proceso ilike '%misional%') then 'Alta *'
              when exists(select 1 from aplicacion_basedatos ab where ab.id_bd=b.id_bd) then 'Media *'
              else '' end) as "Relevancia p/ trazabilidad",
        coalesce(nullif(trim(
           (case when (lower(m.desc_motor) like '%oracle%' and (b.version_bd like '11.%' or b.version_bd like '10.%'))
                   or (lower(m.desc_motor) like '%sql%' and b.version_bd ~ '^(7|2000|2005|2008|2012)') then 'Versión fuera de soporte. ' else '' end)||
           (case when b.modo_archivado='NOARCHIVELOG' then 'Sin archivado de redo (NOARCHIVELOG). ' else '' end)||
           (case when b.tde_estado is not null and b.tde_estado<>'OPEN' and lower(coalesce(b.entidades_conceptuales,'')) ~ '(persona|asegurado|empleador|pension|aporte)' then 'Datos personales sin cifrado (TDE). ' else '' end)||
           (case when exists(select 1 from integraciones i join integracion_dblink dl on dl.id_integracion=i.id_integracion where i.id_bd_destino=b.id_bd and dl.es_publico) then 'Expuesta vía DB links públicos. ' else '' end)||
           (case when upper(coalesce(b.estado_bd,'')) like '%BAJA%' then 'En baja/candidata. ' else '' end)
         ),'')||' *','') as "Restricciones / limitaciones",
        coalesce(nullif(trim(b.estado_bd),''),
          (select case when bool_or(upper(a.estado_app) like '%OPERATIV%') then 'Operativo'
                       when bool_or(upper(a.estado_app) like '%ANALISIS%') then 'En análisis'
                       when bool_or(upper(a.estado_app) like '%CANDIDATO%') then 'Candidato a dar de baja'
                       when count(*)>0 then 'De baja' else null end
           from aplicacion_basedatos ab join aplicacion a on a.id=ab.id_aplicacion where ab.id_bd=b.id_bd), '') as "Estado",
        coalesce(nullif(trim(b.observaciones),''),'') as "Observaciones de uso actual"
      from base_de_datos b
      left join motor_bd m on m.id_motor_bd=b.id_motor_bd
      left join ambiente a on a.id_ambiente=b.id_ambiente
      left join servidor s on s.id_servidor=b.id_servidor
      order by b.nombre_bd
    `,
  },
  "ADI-07": {
    titulo: "Matriz de Volumetría y Criticidad de Fuentes de Datos (en vivo)",
    columns: ["ID", "Fuente / BD", "Motor y versión", "Edición", "Ambiente", "Charset",
      "Tamaño total (GB)", "Datos (GB)", "Índices (GB)", "N° esquemas", "N° tablas", "N° índices",
      "N° vistas", "N° procedimientos", "N° triggers", "Tabla más grande", "Tabla más grande (GB)",
      "Crecimiento (GB/mes)", "Redo (GB/día)", "TDE", "Fecha volumetría",
      "Servidor", "Datafiles asignados (GB)", "Datafiles usados (GB)", "% uso datafiles",
      "Disco servidor asignado (GB)", "Disco servidor usado (GB)", "% uso disco servidor"],
    sql: `
      select
        'FTE-'||lpad((row_number() over (order by b.nombre_bd))::text,3,'0') as "ID",
        b.nombre_bd as "Fuente / BD", (m.desc_motor||' '||coalesce(b.version_bd,'')) as "Motor y versión",
        b.edicion as "Edición", a.desc_ambiente as "Ambiente", b.charset as "Charset",
        b.tamano_gb as "Tamaño total (GB)", b.tamano_datos_gb as "Datos (GB)", b.tamano_indices_gb as "Índices (GB)",
        b.nro_esquemas as "N° esquemas", b.nro_tablas as "N° tablas", b.nro_indices as "N° índices",
        b.nro_vistas as "N° vistas", b.nro_procedimientos as "N° procedimientos", b.nro_triggers as "N° triggers",
        b.tabla_mas_grande as "Tabla más grande", b.tabla_mas_grande_gb as "Tabla más grande (GB)",
        b.crecimiento_gb as "Crecimiento (GB/mes)", b.redo_gb_dia as "Redo (GB/día)",
        b.tde_estado as "TDE", b.fec_volumetria::text as "Fecha volumetría",
        s.nombre_servidor as "Servidor", b.tamano_asignado_gb as "Datafiles asignados (GB)",
        b.tamano_usado_gb as "Datafiles usados (GB)",
        case when b.tamano_asignado_gb>0 then round(b.tamano_usado_gb*100/b.tamano_asignado_gb,1) end as "% uso datafiles",
        s.disco_asignado_gb as "Disco servidor asignado (GB)", s.disco_utilizado_gb as "Disco servidor usado (GB)",
        case when s.disco_asignado_gb>0 then round(s.disco_utilizado_gb*100/s.disco_asignado_gb,1) end as "% uso disco servidor"
      from base_de_datos b
      left join motor_bd m on m.id_motor_bd=b.id_motor_bd
      left join ambiente a on a.id_ambiente=b.id_ambiente
      left join servidor s on s.id_servidor=b.id_servidor
      order by b.nombre_bd
    `,
  },
  "ADI-04": {
    titulo: "Matriz de Fuentes de Datos por Dominio Funcional (en vivo)",
    columns: ["Tipo de proceso", "Dominio funcional (normalizado)", "Procesos de negocio incluidos", "N° proc.",
      "N° apps", "Aplicaciones del dominio", "N° BD", "Fuentes de datos / BD del dominio", "Motores involucrados",
      "Áreas usuarias", "Fuentes exclusivas del dominio", "Fuentes compartidas con otros dominios",
      "Vacíos / dispersión", "Observaciones para el modelo conceptual"],
    sql: `
      select
        tp.desc_tipo_proceso as "Tipo de proceso", df.desc_dominio as "Dominio funcional (normalizado)",
        (select string_agg(distinct pn.desc_proceso,' · ') from proceso_negocio pn where pn.id_dominio=df.id_dominio) as "Procesos de negocio incluidos",
        (select count(*) from proceso_negocio pn where pn.id_dominio=df.id_dominio)::int as "N° proc.",
        (select count(distinct ap.id_aplicacion) from aplicacion_proceso ap join proceso_negocio pn on pn.id_proceso=ap.id_proceso where pn.id_dominio=df.id_dominio)::int as "N° apps",
        (select string_agg(distinct a.id_app,' ') from aplicacion_proceso ap join proceso_negocio pn on pn.id_proceso=ap.id_proceso join aplicacion a on a.id=ap.id_aplicacion where pn.id_dominio=df.id_dominio) as "Aplicaciones del dominio",
        (select count(distinct abx.id_bd) from aplicacion_proceso ap join proceso_negocio pn on pn.id_proceso=ap.id_proceso join aplicacion_basedatos abx on abx.id_aplicacion=ap.id_aplicacion where pn.id_dominio=df.id_dominio)::int as "N° BD",
        (select string_agg(distinct b.nombre_bd,' ') from aplicacion_proceso ap join proceso_negocio pn on pn.id_proceso=ap.id_proceso join aplicacion_basedatos abx on abx.id_aplicacion=ap.id_aplicacion join base_de_datos b on b.id_bd=abx.id_bd where pn.id_dominio=df.id_dominio) as "Fuentes de datos / BD del dominio",
        (select string_agg(distinct m.desc_motor,', ') from aplicacion_proceso ap join proceso_negocio pn on pn.id_proceso=ap.id_proceso join aplicacion_basedatos abx on abx.id_aplicacion=ap.id_aplicacion join base_de_datos b on b.id_bd=abx.id_bd join motor_bd m on m.id_motor_bd=b.id_motor_bd where pn.id_dominio=df.id_dominio) as "Motores involucrados",
        (select string_agg(distinct o.nombre_vigente, ' | ' order by o.nombre_vigente)
           from aplicacion_proceso ap join proceso_negocio pn on pn.id_proceso=ap.id_proceso
           join aplicacion_area aa on aa.id_aplicacion=ap.id_aplicacion
           join oficina o on trim(o.sigla)=trim(aa.sigla)
           where pn.id_dominio=df.id_dominio) as "Áreas usuarias",
        (select string_agg(distinct b.nombre_bd,' ') from aplicacion_proceso ap join proceso_negocio pn on pn.id_proceso=ap.id_proceso join aplicacion_basedatos abx on abx.id_aplicacion=ap.id_aplicacion join base_de_datos b on b.id_bd=abx.id_bd where pn.id_dominio=df.id_dominio and (select count(distinct pn2.id_dominio) from aplicacion_basedatos abx2 join aplicacion_proceso ap2 on ap2.id_aplicacion=abx2.id_aplicacion join proceso_negocio pn2 on pn2.id_proceso=ap2.id_proceso where abx2.id_bd=b.id_bd)=1) as "Fuentes exclusivas del dominio",
        (select string_agg(distinct b.nombre_bd,' ') from aplicacion_proceso ap join proceso_negocio pn on pn.id_proceso=ap.id_proceso join aplicacion_basedatos abx on abx.id_aplicacion=ap.id_aplicacion join base_de_datos b on b.id_bd=abx.id_bd where pn.id_dominio=df.id_dominio and (select count(distinct pn2.id_dominio) from aplicacion_basedatos abx2 join aplicacion_proceso ap2 on ap2.id_aplicacion=abx2.id_aplicacion join proceso_negocio pn2 on pn2.id_proceso=ap2.id_proceso where abx2.id_bd=b.id_bd)>1) as "Fuentes compartidas con otros dominios",
        ('Dispersión máx '||coalesce((select max(n) from (select count(distinct fe.id_bd) n from fuente_entidad fe where fe.id_bd in (select abx.id_bd from aplicacion_proceso ap join proceso_negocio pn on pn.id_proceso=ap.id_proceso join aplicacion_basedatos abx on abx.id_aplicacion=ap.id_aplicacion where pn.id_dominio=df.id_dominio) group by fe.entidad) z),0)::text||' BD por entidad · '||
         (select count(*) from (select distinct abx.id_bd ib from aplicacion_proceso ap join proceso_negocio pn on pn.id_proceso=ap.id_proceso join aplicacion_basedatos abx on abx.id_aplicacion=ap.id_aplicacion where pn.id_dominio=df.id_dominio) q where q.ib not in (select id_bd from fuente_entidad))::text||' BD sin catálogo de entidades') as "Vacíos / dispersión",
        '' as "Observaciones para el modelo conceptual"
      from dominio_funcional df join tipo_proceso tp on tp.id_tipo_proceso=df.id_tipo_proceso
      order by tp.id_tipo_proceso, df.desc_dominio
    `,
  },
  "ADI-09": {
    titulo: "Modelo de Correspondencia Procesos, Dominios y Fuentes de Datos (en vivo)",
    columns: ["N°", "Tipo de proceso", "Dominio funcional", "Proceso de negocio", "Cobertura",
      "Relevancia (criticidad)", "N° apps", "Aplicaciones", "N° fuentes", "Fuentes de datos / BD",
      "Entidades conceptuales (detectadas)", "Tipo de información", "Dispersión máx (entidad en N fuentes)",
      "Solapamientos / redundancias (máx entre fuentes)", "Desalineamiento vs. SIIP", "Evidencia"],
    sql: `
      select
        (row_number() over (order by tp.id_tipo_proceso, df.desc_dominio, pn.desc_proceso))::int as "N°",
        tp.desc_tipo_proceso as "Tipo de proceso",
        df.desc_dominio as "Dominio funcional",
        pn.desc_proceso as "Proceso de negocio",
        case when exists(select 1 from aplicacion_proceso ap where ap.id_proceso=pn.id_proceso) then 'Con sistema' else 'Sin fuente (vacío)' end as "Cobertura",
        (select case max(case upper(trim(a.criticidad)) when 'ALTA' then 3 when 'MEDIA' then 2 when 'BAJA' then 1 else 0 end)
           when 3 then 'Alta' when 2 then 'Media' when 1 then 'Baja' else '' end
         from aplicacion_proceso ap join aplicacion a on a.id=ap.id_aplicacion where ap.id_proceso=pn.id_proceso) as "Relevancia (criticidad)",
        (select count(distinct ap.id_aplicacion) from aplicacion_proceso ap where ap.id_proceso=pn.id_proceso)::int as "N° apps",
        (select string_agg(distinct a.id_app,' ') from aplicacion_proceso ap join aplicacion a on a.id=ap.id_aplicacion where ap.id_proceso=pn.id_proceso) as "Aplicaciones",
        (select count(distinct abx.id_bd) from aplicacion_proceso ap join aplicacion_basedatos abx on abx.id_aplicacion=ap.id_aplicacion where ap.id_proceso=pn.id_proceso)::int as "N° fuentes",
        (select string_agg(distinct b.nombre_bd,' ') from aplicacion_proceso ap join aplicacion_basedatos abx on abx.id_aplicacion=ap.id_aplicacion join base_de_datos b on b.id_bd=abx.id_bd where ap.id_proceso=pn.id_proceso) as "Fuentes de datos / BD",
        (select string_agg(distinct fe.entidad,', ' order by fe.entidad) from aplicacion_proceso ap join aplicacion_basedatos abx on abx.id_aplicacion=ap.id_aplicacion join fuente_entidad fe on fe.id_bd=abx.id_bd where ap.id_proceso=pn.id_proceso) as "Entidades conceptuales (detectadas)",
        (select string_agg(distinct left(b.tipo_info_gest,45),' · ') from aplicacion_proceso ap join aplicacion_basedatos abx on abx.id_aplicacion=ap.id_aplicacion join base_de_datos b on b.id_bd=abx.id_bd where ap.id_proceso=pn.id_proceso and b.tipo_info_gest is not null) as "Tipo de información",
        (select max(gc.n)::int from (select fe2.entidad, count(distinct fe2.id_bd) n from fuente_entidad fe2 group by fe2.entidad) gc
           where gc.entidad in (select distinct fe.entidad from aplicacion_proceso ap join aplicacion_basedatos abx on abx.id_aplicacion=ap.id_aplicacion join fuente_entidad fe on fe.id_bd=abx.id_bd where ap.id_proceso=pn.id_proceso)) as "Dispersión máx (entidad en N fuentes)",
        (select max(x.n)::int from (
           select count(*) n from fuente_entidad fa join fuente_entidad fb on fa.entidad=fb.entidad and fa.id_bd<fb.id_bd
           where fa.id_bd in (select abx.id_bd from aplicacion_proceso ap join aplicacion_basedatos abx on abx.id_aplicacion=ap.id_aplicacion where ap.id_proceso=pn.id_proceso)
             and fb.id_bd in (select abx.id_bd from aplicacion_proceso ap join aplicacion_basedatos abx on abx.id_aplicacion=ap.id_aplicacion where ap.id_proceso=pn.id_proceso)
           group by fa.id_bd, fb.id_bd) x) as "Solapamientos / redundancias (máx entre fuentes)",
        'Dominios de datos SIIP pendientes de definición (MC v.proyecto 18-09-2026)' as "Desalineamiento vs. SIIP",
        'Catálogo físico (tabla/columna) + MC SIIP (F-26) · análisis automatizado' as "Evidencia"
      from proceso_negocio pn
      join dominio_funcional df on df.id_dominio=pn.id_dominio
      join tipo_proceso tp on tp.id_tipo_proceso=df.id_tipo_proceso
      order by tp.id_tipo_proceso, df.desc_dominio, pn.desc_proceso
    `,
  },
  "ADI-08": {
    titulo: "Brechas, Riesgos y Restricciones del Ecosistema de Datos (en vivo)",
    columns: ["Tema", "Brecha / Riesgo", "Severidad", "Alcance", "Evidencia / dato", "Recomendación"],
    sql: `
      with v as (select b.id_bd, b.version_bd, b.edicion, b.estado_bd, m.desc_motor motor
                 from base_de_datos b join motor_bd m on m.id_motor_bd=b.id_motor_bd
                 where coalesce(b.estado_bd,'')<>'Fuera de alcance')
      select 1 ord, 'Documentación' as "Tema", 'Modelo físico poco documentado (comentarios)' as "Brecha / Riesgo", 'Alta' as "Severidad",
        (select count(*) from (select e.id_esquema from esquema e join tabla t on t.id_esquema=e.id_esquema join columna c on c.id_tabla=t.id_tabla where not e.es_ruido group by e.id_esquema having count(c.comentario)=0) z)::text||' esquemas con 0 comentarios' as "Alcance",
        'BD core <15% columnas comentadas (BDPRFNT 0%, ONPPROD 5.7%, BDPRDBDI 8.3%, BDPR11G2 14.6%)' as "Evidencia / dato",
        'Exigir diccionario de datos y comentarios en el modelo; priorizar BD misionales y candidatas a maestro' as "Recomendación"
      union all
      select 2, 'Versiones', 'Oracle 11g/10g fuera de soporte', 'Crítica',
        (select count(*) from v where lower(motor) like '%oracle%' and (version_bd like '11.%' or version_bd like '10.%'))::text||' BD Oracle',
        'Oracle 11.2/10g sin soporte del fabricante (Premier/Extended vencido)',
        'Plan de migración a 19c; priorizar por criticidad y datos sensibles'
      union all
      select 3, 'Versiones', 'SQL Server fuera de soporte (≤2012/2008/7)', 'Crítica',
        (select count(*) from v where lower(motor) like '%sql%' and version_bd ~ '^(7|2000|2005|2008|2012)')::text||' BD SQL Server',
        'SQL Server 2012 (EOL jul-2022) ×54, 2008 R2 y SQL Server 7 ×2',
        'Migrar a versión soportada (2019/2022); aislar las SQL 7 de inmediato'
      union all
      select 4, 'Versiones', 'DB2 y MySQL obsoletos', 'Alta',
        (select count(*) from v where lower(motor) like '%db2%' or lower(motor) like '%mysql%')::text||' BD (DB2 9.5/10.x, MySQL 5.0)',
        'DB2 9.5/10.1/10.5 y MySQL 5.0.95 sin soporte',
        'Evaluar migración/retiro; reforzar respaldo mientras persistan'
      union all
      select 5, 'Versiones', 'Servidores con soporte vencido', 'Alta',
        (select count(*) from servidor where fec_fin_soporte_bd is not null and fec_fin_soporte_bd < current_date)::text||' servidores',
        'SO/HW fuera de soporte (AIX 6.1, CentOS 5.6, etc.)',
        'Renovar soporte o plan de reemplazo de infraestructura'
      union all
      select 6, 'Licenciamiento', 'Oracle Enterprise Edition + packs licenciables en uso', 'Media',
        (select count(*) from v where edicion='Enterprise')::text||' BD Enterprise; '||
        (select count(*) from base_de_datos where features_usadas is not null)::text||' con packs licenciables en uso',
        'Enterprise = licencia premium por core; además packs aparte detectados en uso (dba_feature_usage_statistics): Diagnostic Pack y SQL Tuning Advisor (Tuning Pack)',
        'Revisar uso real y licenciamiento de los packs; consolidar y optar por Standard donde aplique'
      union all
      select 7, 'Seguridad de integraciones', 'DB Links públicos (acoplamiento no controlado)', 'Alta',
        (select count(*) from integracion_dblink where es_publico)::text||' DB Links públicos (de '||(select count(*) from integracion_dblink)::text||' reales, 24 instancias)',
        'Links PUBLIC usables por cualquier esquema; credenciales embebidas → acceso cruzado/lateral',
        'Convertir a privados por esquema; inventariar consumidores antes de dar de baja BD'
      union all
      select 8, 'Seguridad de integraciones', 'DB Links de alto riesgo (público + usuario remoto privilegiado)', 'Crítica',
        (select count(*) from integracion_dblink where nivel_riesgo='Critico')::text||' DB Links críticos; '||
        (select count(*) from integracion_dblink where usuario_remoto_privilegiado)::text||' con usuario remoto DBA/ANY',
        'Links PUBLIC cuyo usuario remoto tiene DBA/privilegios ANY en el destino (ej. SNPCONNECT entrelaza EMI18/19/20↔NSP18/20; USUA_DBL_BDI_SGPSYS→BDPRD11G) → acceso privilegiado lateral',
        'Reemplazar por usuarios remotos de mínimo privilegio y hacer privados los links; rotar credenciales embebidas'
      union all
      select 9, 'Seguridad de cuentas', 'Cuentas con contraseña por defecto', 'Baja',
        (select count(*) from usuario_bd where pwd_default)::text||' cuentas con pwd de fábrica; '||
        (select count(*) from usuario_bd where pwd_default and estado_cuenta like '%LOCKED%')::text||' bloqueadas/expiradas, '||
        (select count(*) from usuario_bd where pwd_default and estado_cuenta='OPEN')::text||' ABIERTA',
        'DBA_USERS_WITH_DEFPWD: casi todas son cuentas de muestra/sistema ya bloqueadas; única ABIERTA = PERFSTAT@EMI18PRD (Statspack)',
        'Cambiar/eliminar la cuenta abierta (PERFSTAT); dar de baja cuentas de muestra no usadas como hardening'
      union all
      select 10, 'Seguridad de datos', 'Datos en reposo sin cifrado (TDE inactivo)', 'Alta',
        (select count(*) from base_de_datos b join motor_bd m on m.id_motor_bd=b.id_motor_bd where lower(m.desc_motor) like '%oracle%' and b.fec_volumetria is not null and coalesce(b.tde_estado,'')<>'OPEN')::text||' BD Oracle sin TDE activo (de 24 medidas)',
        'Wallet TDE cerrado/no disponible y 0 tablespaces/columnas cifradas, pese a datos personales (afiliados, RENIEC/SUNAT)',
        'Evaluar TDE o cifrado de almacenamiento en BD con datos sensibles; priorizar las de mayor volumen'
      union all
      select 11, 'Continuidad operativa', 'BD en NOARCHIVELOG (sin recuperación punto-en-tiempo)', 'Crítica',
        (select count(*) from base_de_datos where modo_archivado='NOARCHIVELOG')::text||' BD en NOARCHIVELOG',
        'Sin archivado de redo no hay recuperación a un instante ni respaldo en caliente consistente (ej. EMI18/EMI19/EMI20)',
        'Activar ARCHIVELOG en las BD productivas y validar la estrategia de respaldo RMAN'
      union all
      select 12, 'Calidad / salud', 'Objetos de BD inválidos', 'Media',
        (select coalesce(sum(nro_objetos_invalidos),0) from base_de_datos)::text||' objetos INVALID en '||(select count(*) from base_de_datos where coalesce(nro_objetos_invalidos,0)>0)::text||' BD',
        'Objetos (vistas/packages/procedimientos) en estado INVALID (EMI19=80, BDPR11G2=72) → dependencias rotas o despliegues incompletos',
        'Recompilar (utlrp) y revisar dependencias; usar como indicador de salud del esquema'
      order by ord
    `,
  },
};
app.get("/api/artefacto/:id", async (req, res) => {
  try {
    const a = ARTE[req.params.id];
    if (!a) return res.status(404).json({ error: "artefacto no disponible en vivo" });
    const data = await prisma.$queryRawUnsafe<any[]>(a.sql);
    const rows = data.map((r) => a.columns.map((c) => (r[c] == null ? "" : String(r[c]))));
    res.json({ id: req.params.id, titulo: a.titulo, columns: a.columns, rows, links: {} });
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
    const pk = pkFields(m)[0];
    // base_de_datos: no ofrecer las 'Fuera de alcance' y desambiguar nombres repetidos
    // mostrando el servidor (evita re-enlazar la copia equivocada desde los modales).
    if (m.name === "base_de_datos") {
      const rows = await prisma.base_de_datos.findMany({
        where: { OR: [{ estado_bd: null }, { estado_bd: { not: FUERA_ALCANCE } }] },
        include: { servidor: true }, take: 2000,
      });
      const seen = new Set<string>(), dup = new Set<string>();
      for (const r of rows) { if (seen.has(r.nombre_bd)) dup.add(r.nombre_bd); else seen.add(r.nombre_bd); }
      return res.json(rows.map((r: any) => ({
        value: r[pk],
        label: dup.has(r.nombre_bd) ? `${r.nombre_bd} @ ${r.servidor?.nombre_servidor ?? "?"}` : r.nombre_bd,
      })).sort((a: any, b: any) => collator.compare(a.label, b.label)));
    }
    const rows = await delegate(m.name).findMany({ take: 2000 });
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
// Esquemas de un par app–BD (via junction esquema_aplicacion -> esquema maestro), ordenados por nombre
const esquemasInclude = {
  esquema_aplicacion: {
    select: { id_esquema_aplicacion: true, esquema: { select: { id_esquema: true, nombre_esquema: true } } },
    orderBy: { esquema: { nombre_esquema: "asc" as const } },
  },
};
// Aplana el include a [{ id_esquema, nombre_esquema, id_esquema_aplicacion }]
const mapEsq = (l: any) => l.esquema_aplicacion.map((x: any) => ({
  id_esquema: x.esquema.id_esquema, nombre_esquema: x.esquema.nombre_esquema, id_esquema_aplicacion: x.id_esquema_aplicacion,
}));
// Quitar un vínculo app–BD: se bloquea si el par tiene esquemas enlazados (no se borran en cascada)
async function delAppBd(id_aplicacion: number, id_bd: number) {
  const n = await prisma.esquema_aplicacion.count({ where: { id_aplicacion, id_bd } });
  if (n > 0) throw new Error(`Este vínculo tiene ${n} esquema(s) registrado(s); quítalos primero.`);
  await prisma.aplicacion_basedatos.delete({ where: { id_aplicacion_id_bd: { id_aplicacion, id_bd } } });
}
// aplicacion <-> base_de_datos (aplicacion_basedatos)
app.get("/api/aplicacion/:id/basedatos", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const links = await prisma.aplicacion_basedatos.findMany({ where: { id_aplicacion: id }, include: { base_de_datos: true, ...esquemasInclude }, orderBy: { base_de_datos: { nombre_bd: "asc" } } });
  res.json(links.map((l) => ({ id_aplicacion: l.id_aplicacion, id_bd: l.id_bd, nombre_bd: l.base_de_datos.nombre_bd, esquemas: mapEsq(l) })));
});
app.post("/api/aplicacion/:id/basedatos", async (req, res) => {
  try { await prisma.aplicacion_basedatos.create({ data: { id_aplicacion: +req.params.id, id_bd: +req.body.id_bd, ip_creacion: clientIp(req) } }); res.json({ ok: true }); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});
app.delete("/api/aplicacion/:id/basedatos/:id_bd", async (req, res) => {
  try { await delAppBd(+req.params.id, +req.params.id_bd); res.json({ ok: true }); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});
// esquemas de un par app–BD. El esquema fisico vive en el maestro 'esquema' (por BD);
// aqui se crea/borra el VINCULO app<->esquema en la junction 'esquema_aplicacion'.
app.post("/api/aplicacion/:id/basedatos/:id_bd/esquemas", async (req, res) => {
  try {
    const nombre = String(req.body.nombre_esquema || "").trim();
    if (!nombre) return res.status(400).json({ error: "Indica el nombre del esquema." });
    const id_aplicacion = +req.params.id, id_bd = +req.params.id_bd, ip = clientIp(req);
    // maestro: buscar o crear el esquema fisico (id_bd, nombre)
    const esq = await prisma.esquema.upsert({
      where: { id_bd_nombre_esquema: { id_bd, nombre_esquema: nombre } },
      update: {},
      create: { id_bd, nombre_esquema: nombre },
    });
    // junction: enlazar la app con ese esquema
    const row = await prisma.esquema_aplicacion.create({ data: { id_aplicacion, id_bd, id_esquema: esq.id_esquema, ip_creacion: ip } });
    res.json({ id_esquema: esq.id_esquema, nombre_esquema: nombre, id_esquema_aplicacion: row.id_esquema_aplicacion });
  } catch (e: any) {
    if (e.code === "P2002") return res.status(400).json({ error: `El esquema "${String(req.body.nombre_esquema).trim()}" ya está registrado para esta app y BD.` });
    res.status(400).json({ error: e.message });
  }
});
app.delete("/api/aplicacion/:id/basedatos/:id_bd/esquemas/:id_esquema", async (req, res) => {
  try {
    // borra el VINCULO en la junction (no el esquema fisico maestro)
    const { count } = await prisma.esquema_aplicacion.deleteMany({ where: { id_esquema: +req.params.id_esquema, id_aplicacion: +req.params.id, id_bd: +req.params.id_bd } });
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
// aplicacion <-> oficina (aplicacion_area: áreas propietarias N:M). Tabla fuera de Prisma => raw.
app.get("/api/aplicacion/:id/areas", async (req, res) => {
  try {
    const rows = await prisma.$queryRaw<{ sigla: string; nombre_vigente: string }[]>`
      select o.sigla, o.nombre_vigente from aplicacion_area aa join oficina o on o.sigla=aa.sigla
      where aa.id_aplicacion=${+req.params.id} order by o.sigla`;
    res.json(rows);
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});
app.post("/api/aplicacion/:id/areas", async (req, res) => {
  try {
    await prisma.$executeRaw`insert into aplicacion_area(id_aplicacion, sigla)
      values(${+req.params.id}, ${String(req.body.sigla)}) on conflict do nothing`;
    res.json({ ok: true });
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});
app.delete("/api/aplicacion/:id/areas/:sigla", async (req, res) => {
  try {
    await prisma.$executeRaw`delete from aplicacion_area where id_aplicacion=${+req.params.id} and sigla=${req.params.sigla}`;
    res.json({ ok: true });
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});
// base_de_datos -> aplicaciones (solo lectura)
app.get("/api/base_de_datos/:id/aplicaciones", async (req, res) => {
  const links = await prisma.aplicacion_basedatos.findMany({ where: { id_bd: +req.params.id }, include: { aplicacion: true, ...esquemasInclude }, orderBy: { aplicacion: { id_app: "asc" } } });
  res.json(links.map((l) => ({ id: l.id_aplicacion, id_aplicacion: l.id_aplicacion, id_bd: l.id_bd, id_app: l.aplicacion.id_app, nombre_app: l.aplicacion.nombre_app, esquemas: mapEsq(l) })));
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
    estado_enlace: r.estado_enlace, id_bd_destino: r.id_bd_destino,
    destino: r.base_de_datos_integraciones_id_bd_destinoTobase_de_datos?.nombre_bd || r.destino_externo,
  })));
});
app.post("/api/base_de_datos/:id/integraciones", async (req, res) => {
  try {
    const b = req.body;
    const row = await prisma.integraciones.create({ data: {
      id_bd_origen: +req.params.id, id_bd_destino: b.id_bd_destino ? +b.id_bd_destino : null,
      destino_externo: b.destino_externo || null, mecanismo: b.mecanismo || null,
      nombre_enlace: b.nombre_enlace || null, estado_enlace: b.estado_enlace || null,
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
      estado_enlace: b.estado_enlace || null,
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
