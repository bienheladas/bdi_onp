import express from "express";
import cors from "cors";
import { PrismaClient, Prisma } from "@prisma/client";
import { newWorkbook, addSheet, addPortada, type Traza } from "./xlsx";

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
  reunion_levantamiento: ["nro", "interlocutores"],
  entidad_conceptual: ["nombre"],
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
  "ADI-02": {
    titulo: "Registro de Levantamiento y Validación Técnica-Funcional (en vivo)",
    columns: ["N°", "Fecha de sesión", "Tipo", "Interlocutores (técnicos/funcionales)", "Áreas participantes",
      "Temas tratados", "Información levantada y validada", "Acuerdos adoptados",
      "Restricciones de acceso o disponibilidad", "Evidencia"],
    sql: `
      select nro as "N°", coalesce(fecha_sesion,'') as "Fecha de sesión", coalesce(tipo,'') as "Tipo",
        coalesce(interlocutores,'') as "Interlocutores (técnicos/funcionales)",
        coalesce(areas_participantes,'') as "Áreas participantes",
        coalesce(temas_tratados,'') as "Temas tratados",
        coalesce(info_levantada,'') as "Información levantada y validada",
        coalesce(acuerdos,'') as "Acuerdos adoptados",
        coalesce(restricciones,'') as "Restricciones de acceso o disponibilidad",
        coalesce(evidencia,'') as "Evidencia"
      from reunion_levantamiento order by nro
    `,
  },
  "ADI-05": {
    titulo: "Mapa de Relaciones e Integraciones entre Fuentes de Datos (en vivo)",
    columns: ["N°", "Fuente origen", "Motor origen", "Fuente destino / consumidora", "Motor destino",
      "Tipo de relación / dependencia", "Mecanismo de integración", "Información intercambiada",
      "Proceso / dominio / área", "Frecuencia", "Responsable", "Limitaciones / restricciones",
      "Riesgos generales", "Detalle (job / DB link)", "Secuencia(s) padre (agrupador)", "Malla (OTI, agrupador)"],
    sql: `
      select
        (row_number() over (order by i.mecanismo, i.id_integracion))::int as "N°",
        coalesce(bo.nombre_bd, nullif(trim(feo.proveedor||' – '||feo.codigo),' – '), nullif(trim(i.origen_externo),''),
          case when d.usa_archivo_plano then 'Archivo plano (texto)' end,
          case when i.mecanismo='ETL DataStage' then '(origen parametrizado — pendiente)' else '' end) as "Fuente origen",
        mo.desc_motor as "Motor origen",
        coalesce(bd.nombre_bd, nullif(trim(i.destino_externo),''),
          case when i.mecanismo='ETL DataStage' then '(destino parametrizado — pendiente)' else '' end) as "Fuente destino / consumidora",
        md.desc_motor as "Motor destino",
        case when i.mecanismo='ETL DataStage' then 'Flujo de datos (ETL)'
             when i.mecanismo='DB Link' then
               (case when exists(select 1 from privilegio_sistema p where p.id_bd=i.id_bd_destino and upper(p.grantee)=upper(dl.usuario_remoto)
                                 and p.privilegio ~ '(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)') then 'Lectura/Escritura'
                     when exists(select 1 from privilegio_sistema p where p.id_bd=i.id_bd_destino and upper(p.grantee)=upper(dl.usuario_remoto)
                                 and p.privilegio like 'SELECT%') then 'Lectura'
                     else 'Lectura/Escritura' end)
             else '' end as "Tipo de relación / dependencia",
        i.mecanismo || case when i.mecanismo='ETL DataStage' and nullif(trim(d.modo_carga),'') is not null then ' ('||d.modo_carga||')' else '' end as "Mecanismo de integración",
        coalesce((select string_agg(x.entidad, ', ' order by x.m desc) from
            (select fe.entidad, sum(fe.nro_menciones) m from fuente_entidad fe
             join base_de_datos b on b.id_bd=fe.id_bd and b.en_modelo_conceptual
             where fe.id_bd in (i.id_bd_origen, i.id_bd_destino) group by fe.entidad order by m desc limit 5) x),'') as "Información intercambiada",
        coalesce((select string_agg(distinct df.desc_dominio,' | ') from aplicacion_basedatos ab
                  join aplicacion_proceso ap on ap.id_aplicacion=ab.id_aplicacion join proceso_negocio pn on pn.id_proceso=ap.id_proceso
                  join dominio_funcional df on df.id_dominio=pn.id_dominio where ab.id_bd=coalesce(i.id_bd_origen,i.id_bd_destino)),'') as "Proceso / dominio / área",
        case when i.mecanismo='DB Link' then 'En línea'
             when i.mecanismo='ETL DataStage' then
               coalesce(nullif(trim(rm.periodicidad),'') || coalesce(' '||nullif(trim(rm.hora),''),''), 'Incremental diario')
             else '' end as "Frecuencia",
        case when i.mecanismo='DB Link' then 'OTI (DBA)'
             when i.mecanismo='ETL DataStage' then
               coalesce(nullif(trim(rm.responsable_oti),''),'OTI')   -- responsable ONP (OTI opera la plataforma DataStage)
               || coalesce(' (operador: '||nullif(trim(coalesce(d.proveedor, d.responsable)),'')||')','')  -- tercero relevado como operador
             else '' end as "Responsable",
        case when i.mecanismo='DB Link' then
               (case when exists(select 1 from privilegio_sistema p where p.id_bd=i.id_bd_destino and upper(p.grantee)=upper(dl.usuario_remoto)
                                 and p.privilegio like 'SELECT%')
                      and not exists(select 1 from privilegio_sistema p where p.id_bd=i.id_bd_destino and upper(p.grantee)=upper(dl.usuario_remoto)
                                 and p.privilegio ~ '(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)')
                     then 'Solo lectura: el enlace no habilita escritura en el destino'
                     when not dl.es_publico then 'Enlace privado: acotado al esquema propietario en la BD origen'
                     else '' end)
             else '' end as "Limitaciones / restricciones",
        case when i.mecanismo='ETL DataStage' then 'Bajo' else coalesce(dl.nivel_riesgo,'') end as "Riesgos generales",
        case when i.mecanismo='DB Link' then
               'Enlace: '||coalesce(i.nombre_enlace,'')||'; Owner: '||coalesce(dl.owner,'')||'; Visibilidad: '||(case when dl.es_publico then 'Público' else 'Privado' end)||'; Usuario remoto: '||coalesce(dl.usuario_remoto,'')
             when i.mecanismo='ETL DataStage' then
               'Job: '||coalesce(i.nombre_enlace,'')||coalesce('; Tabla(s) destino: '||nullif(trim(d.tabla_destino),''),'')||coalesce('; Modo: '||nullif(trim(d.modo_carga),''),'')||coalesce('; Objetivo: '||nullif(trim(d.objetivo),''),'')
             else '' end as "Detalle (job / DB link)",
        coalesce(d.job_padre,'') as "Secuencia(s) padre (agrupador)",
        coalesce(d.malla_raiz,'') as "Malla (OTI, agrupador)"
      from integraciones i
      left join base_de_datos bo on bo.id_bd=i.id_bd_origen
      left join fuentes_externas feo on feo.id_fuente_ext=i.id_fuente_externa_origen
      left join motor_bd mo on mo.id_motor_bd=bo.id_motor_bd
      left join base_de_datos bd on bd.id_bd=i.id_bd_destino
      left join motor_bd md on md.id_motor_bd=bd.id_motor_bd
      left join integracion_datastage d on d.id_integracion=i.id_integracion
      left join integracion_dblink dl on dl.id_integracion=i.id_integracion
      left join relevamiento_malla rm on upper(rm.malla)=upper(trim(split_part(d.malla_raiz,';',1)))
      where left(upper(coalesce(i.nombre_enlace,'')),4) <> 'SEQ_'   -- excluye secuencias/mallas orquestadoras (no mueven datos; su agrupación vive en malla_raiz de los jobs hijos)
      order by i.mecanismo, i.id_integracion
    `,
  },
  "ADI-03": {
    titulo: "Catálogo AS-IS de Fuentes de Datos Institucionales (en vivo)",
    columns: ["ID", "Fuente / BD", "Descripción general", "Motor", "Versión", "Edición", "Packs licenciables en uso", "Ambiente", "Servidor",
      "Datacenter", "Sistema operativo", "Tamaño (GB)", "N° esquemas", "N° tablas", "Crecimiento (GB/mes)",
      "Tipo de fuente", "Tipo de información gestionada",
      "Tipo(s) de proceso", "Dominio(s) funcional(es)", "Proceso(s) de negocio", "Área usuaria responsable", "Área técnica responsable",
      "Gestor", "Responsable funcional", "Aplicaciones consumidoras", "N° integ.", "Integra con (BD / fuentes)",
      "Relevancia p/ trazabilidad", "Restricciones / limitaciones", "Estado", "¿Dentro del modelo conceptual?", "Observaciones de uso actual"],
    sql: `
      select * from (
      (select
        'FTE-'||lpad((row_number() over (order by (case when b.en_modelo_conceptual and exists(select 1 from aplicacion_basedatos ab join aplicacion a2 on a2.id=ab.id_aplicacion where ab.id_bd=b.id_bd and a2.en_modelo_conceptual) then 0 else 1 end), b.nombre_bd))::text,3,'0') as "ID",
        b.nombre_bd || case when (select count(*) from base_de_datos b2 where b2.nombre_bd=b.nombre_bd)>1
                            then ' ('||coalesce(s.nombre_servidor,'sin servidor')||')' else '' end as "Fuente / BD",
        case when length(trim(coalesce(b.desc_base_datos,'')))>=25 then b.desc_base_datos
             else coalesce(nullif(trim(
               'BD '||coalesce(m.desc_motor,'')||coalesce(' '||b.version_bd,'')||' en '||coalesce(lower(a.desc_ambiente),'ambiente n/d')||
               coalesce('; soporta '||(select string_agg(distinct ap.id_app,', ' order by ap.id_app) from aplicacion_basedatos abx join aplicacion ap on ap.id=abx.id_aplicacion where abx.id_bd=b.id_bd),'')||
               coalesce('; dominio '||(select string_agg(distinct df.desc_dominio,', ') from aplicacion_basedatos ab join aplicacion_proceso apx on apx.id_aplicacion=ab.id_aplicacion join proceso_negocio pn on pn.id_proceso=apx.id_proceso join dominio_funcional df on df.id_dominio=pn.id_dominio where ab.id_bd=b.id_bd),'')
             ),''),'') end as "Descripción general",
        m.desc_motor as "Motor", b.version_bd as "Versión", b.edicion as "Edición",
        coalesce((select string_agg(distinct trim(x), ', ' order by trim(x)) from unnest(string_to_array(b.features_usadas, ',')) x where trim(x)<>''),'') as "Packs licenciables en uso",
        a.desc_ambiente as "Ambiente",
        s.nombre_servidor as "Servidor", s.ubicacion as "Datacenter",
        nullif(trim(coalesce(s.nombre_so,'')||' '||coalesce(s.version_so,'')),'') as "Sistema operativo",
        b.tamano_gb as "Tamaño (GB)", b.nro_esquemas as "N° esquemas", b.nro_tablas as "N° tablas",
        b.crecimiento_gb as "Crecimiento (GB/mes)",
        coalesce(nullif(trim(b.tipo_bd),''),
          (case when lower(b.nombre_bd) ~ '(sp2010|sp2013|sharepoint|wss_|_mms_|_ups_|ssapp|_rs_db|admincontent)' then 'Documental/gestión de contenidos'
                when lower(b.nombre_bd||coalesce(b.desc_base_datos,'')) ~ 'aud' then 'Auditoría'
                when lower(b.nombre_bd||coalesce(b.desc_base_datos,'')) ~ '(bdi|dbi|integ|consolid)' then 'Integración/consolidación'
                when lower(b.nombre_bd||coalesce(b.desc_base_datos,'')) ~ '(gcd|glcd|jira|www|sharepoint|wss|filenet|fnet|content|documental|micrograb|sgd)' then 'Documental/gestión de contenidos'
                when lower(b.nombre_bd||coalesce(b.desc_base_datos,'')) ~ '(dwh|datawarehouse|olap| bi |analit|explotaci|dashboard|reporter[íi]a|fnet|fnge|fnle)' then 'Analítica/reportería'
                when lower(b.nombre_bd||coalesce(b.desc_base_datos,'')) ~ '(harvest|aranda|pcsistel)' then 'Herramienta/soporte TI'
                else 'Base de datos relacional' end)) as "Tipo de fuente",
        case when lower(m.desc_motor) like '%oracle%'
             then coalesce(nullif(trim(b.tipo_info_gest),''), nullif(trim(b.entidades_conceptuales),''), '')
             else coalesce(nullif(trim(b.tipo_info_gest),''),'') end as "Tipo de información gestionada",
        coalesce((select string_agg(distinct tp.desc_tipo_proceso, ' | ' order by tp.desc_tipo_proceso)
                  from aplicacion_basedatos ab join aplicacion aflt on aflt.id=ab.id_aplicacion join aplicacion_proceso ap on ap.id_aplicacion=ab.id_aplicacion
                  join proceso_negocio pn on pn.id_proceso=ap.id_proceso join dominio_funcional df on df.id_dominio=pn.id_dominio
                  join tipo_proceso tp on tp.id_tipo_proceso=df.id_tipo_proceso where ab.id_bd=b.id_bd),'') as "Tipo(s) de proceso",
        coalesce((select string_agg(distinct df.desc_dominio, ' | ' order by df.desc_dominio)
                  from aplicacion_basedatos ab join aplicacion aflt on aflt.id=ab.id_aplicacion join aplicacion_proceso ap on ap.id_aplicacion=ab.id_aplicacion
                  join proceso_negocio pn on pn.id_proceso=ap.id_proceso join dominio_funcional df on df.id_dominio=pn.id_dominio
                  where ab.id_bd=b.id_bd),'') as "Dominio(s) funcional(es)",
        coalesce((select string_agg(distinct pn.desc_proceso, ' | ' order by pn.desc_proceso)
                  from aplicacion_basedatos ab join aplicacion aflt on aflt.id=ab.id_aplicacion join aplicacion_proceso ap on ap.id_aplicacion=ab.id_aplicacion
                  join proceso_negocio pn on pn.id_proceso=ap.id_proceso where ab.id_bd=b.id_bd),'') as "Proceso(s) de negocio",
        coalesce((select string_agg(distinct o.nombre_vigente, ' · ')
                  from aplicacion_basedatos ab join aplicacion_area aa on aa.id_aplicacion=ab.id_aplicacion
                  join oficina o on trim(o.sigla)=trim(aa.sigla) where ab.id_bd=b.id_bd),
                 nullif(trim(b.area_usuario_resp_onp),''), '') as "Área usuaria responsable",
        coalesce((select string_agg(distinct nullif(trim(ap.area_tecnica_resp),''), ' / ')
                  from aplicacion_basedatos abx join aplicacion ap on ap.id=abx.id_aplicacion where abx.id_bd=b.id_bd),
                 '') as "Área técnica responsable",
        coalesce((select string_agg(distinct nullif(trim(ap.gestor_resp),''),' | ') from aplicacion_basedatos abx join aplicacion ap on ap.id=abx.id_aplicacion where abx.id_bd=b.id_bd), nullif(trim(b.gestor),''), '') as "Gestor",
        coalesce((select string_agg(distinct nullif(trim(ap.nombre_lider_usuario),''),' | ') from aplicacion_basedatos abx join aplicacion ap on ap.id=abx.id_aplicacion where abx.id_bd=b.id_bd), nullif(trim(b.resp_funcional),''), '') as "Responsable funcional",
        (select string_agg(distinct ap.id_app||' '||coalesce(ap.nombre_app,''),' | ') from aplicacion_basedatos abx join aplicacion ap on ap.id=abx.id_aplicacion where abx.id_bd=b.id_bd) as "Aplicaciones consumidoras",
        (select count(*) from integraciones ix where ix.id_bd_origen=b.id_bd or ix.id_bd_destino=b.id_bd)::int as "N° integ.",
        (select string_agg(distinct case when ix.id_bd_origen=b.id_bd
            then coalesce(ix.mecanismo,'?')||' → '||coalesce(bd2.nombre_bd, ix.destino_externo,'?')
            else coalesce(ix.mecanismo,'?')||' ← '||coalesce(bo2.nombre_bd, nullif(trim(feo.proveedor||' – '||feo.codigo),' – '), ix.origen_externo,'?') end, E'\n')
          from integraciones ix left join base_de_datos bd2 on bd2.id_bd=ix.id_bd_destino
          left join base_de_datos bo2 on bo2.id_bd=ix.id_bd_origen
          left join fuentes_externas feo on feo.id_fuente_ext=ix.id_fuente_externa_origen
          where ix.id_bd_origen=b.id_bd or ix.id_bd_destino=b.id_bd) as "Integra con (BD / fuentes)",
        (case when not (b.en_modelo_conceptual and exists(select 1 from aplicacion_basedatos ab join aplicacion a2 on a2.id=ab.id_aplicacion where ab.id_bd=b.id_bd and a2.en_modelo_conceptual)) then 'Baja'
              when lower(coalesce(b.entidades_conceptuales,'')) ~ '(expediente|pensi|prestaci|aporte|asegurado|derecho|planilla)' then 'Alta'
              when exists(select 1 from aplicacion_basedatos ab join aplicacion aflt on aflt.id=ab.id_aplicacion and aflt.en_modelo_conceptual join aplicacion_proceso ap on ap.id_aplicacion=ab.id_aplicacion join proceso_negocio pn on pn.id_proceso=ap.id_proceso join dominio_funcional df on df.id_dominio=pn.id_dominio join tipo_proceso tp on tp.id_tipo_proceso=df.id_tipo_proceso where ab.id_bd=b.id_bd and tp.desc_tipo_proceso ilike '%misional%') then 'Alta'
              when exists(select 1 from aplicacion_basedatos ab where ab.id_bd=b.id_bd) then 'Media'
              else '' end) as "Relevancia p/ trazabilidad",
        coalesce(nullif(trim(
           (case when (lower(m.desc_motor) like '%oracle%' and (b.version_bd like '11.%' or b.version_bd like '10.%'))
                   or (lower(m.desc_motor) like '%sql%' and b.version_bd ~ '^(7|2000|2005|2008|2012)') then 'Versión fuera de soporte. ' else '' end)||
           (case when b.modo_archivado='NOARCHIVELOG' then 'Sin archivado de redo (NOARCHIVELOG). ' else '' end)||
           (case when b.tde_estado is not null and b.tde_estado not ilike 'Cifrado activo%' and lower(coalesce(b.entidades_conceptuales,'')) ~ '(persona|asegurado|empleador|pension|aporte)' then 'Cifrado en reposo no activo (TDE). ' else '' end)||
           (case when exists(select 1 from integraciones i join integracion_dblink dl on dl.id_integracion=i.id_integracion where i.id_bd_destino=b.id_bd and dl.es_publico) then 'Expuesta vía DB links públicos. ' else '' end)||
           (case when upper(coalesce(b.estado_bd,'')) like '%BAJA%' then 'En baja/candidata. ' else '' end)
         ),''),'') as "Restricciones / limitaciones",
        coalesce(nullif(trim(b.estado_bd),''),
          (select case when bool_or(upper(a.estado_app) like '%OPERATIV%') then 'Operativo'
                       when bool_or(upper(a.estado_app) like '%ANALISIS%') then 'En análisis'
                       when bool_or(upper(a.estado_app) like '%CANDIDATO%') then 'Candidato a dar de baja'
                       when count(*)>0 then 'De baja' else null end
           from aplicacion_basedatos ab join aplicacion a on a.id=ab.id_aplicacion where ab.id_bd=b.id_bd),
          case when b.fec_volumetria is not null then 'Operativo' end, '') as "Estado",
        (case
           when b.en_modelo_conceptual
                and exists(select 1 from aplicacion_basedatos ab join aplicacion a2 on a2.id=ab.id_aplicacion
                           where ab.id_bd=b.id_bd and a2.en_modelo_conceptual)
             then 'Sí'
           when coalesce(b.clase_contenido,'') in ('Metadata de enlatado','Infraestructura','Auditoría','Prueba de migración')
             then 'No — '||b.clase_contenido
           when not exists(select 1 from aplicacion_basedatos ab where ab.id_bd=b.id_bd)
             then 'No — sin aplicación vigente'
           else 'No — aplicación de baja / fuera del modelo conceptual'
         end) as "¿Dentro del modelo conceptual?",
        nullif(trim(
          coalesce(nullif(trim(b.obs_uso_actual),''), nullif(trim(b.observaciones),''),'')
          || case when upper(coalesce(b.estado_bd,'')) like '%CANDIDATO%' and b.en_modelo_conceptual
                  then ' [Para consulta con ONP] Fuente candidata a dar de baja incluida en el alcance porque su información debe migrarse a la BDI antes de su decomiso; inclusión sujeta a confirmación de ONP.'
                  else '' end
        ),'') as "Observaciones de uso actual"
      from base_de_datos b
      left join motor_bd m on m.id_motor_bd=b.id_motor_bd
      left join ambiente a on a.id_ambiente=b.id_ambiente
      left join servidor s on s.id_servidor=b.id_servidor
      order by (case when b.en_modelo_conceptual and exists(select 1 from aplicacion_basedatos ab join aplicacion a2 on a2.id=ab.id_aplicacion where ab.id_bd=b.id_bd and a2.en_modelo_conceptual) then 0 else 1 end), b.nombre_bd)
      union all
      (select
        'EXT-'||lpad((row_number() over (order by fe.codigo))::text,2,'0') as "ID",
        fe.nombre as "Fuente / BD",
        fe.proposito as "Descripción general",
        '' as "Motor", '' as "Versión", '' as "Edición", '' as "Packs licenciables en uso",
        '' as "Ambiente", '' as "Servidor", '' as "Datacenter", '' as "Sistema operativo",
        null::numeric as "Tamaño (GB)", null::int as "N° esquemas", null::int as "N° tablas", null::numeric as "Crecimiento (GB/mes)",
        'Fuente externa' as "Tipo de fuente",
        fe.entidades_negocio as "Tipo de información gestionada",
        '' as "Tipo(s) de proceso",
        fe.dominios_siip as "Dominio(s) funcional(es)",
        '' as "Proceso(s) de negocio",
        '' as "Área usuaria responsable",
        'OTI (DataStage)' as "Área técnica responsable",
        fe.proveedor as "Gestor",
        '' as "Responsable funcional",
        '' as "Aplicaciones consumidoras",
        (select count(*) from integraciones ix where ix.id_fuente_externa_origen=fe.id_fuente_ext)::int as "N° integ.",
        fe.bd_destino_onp as "Integra con (BD / fuentes)",
        'Alta' as "Relevancia p/ trazabilidad",
        nullif('Confidencialidad: '||coalesce(fe.nivel_confidencialidad,''),'Confidencialidad: ') as "Restricciones / limitaciones",
        'Operativo' as "Estado",
        'Sí' as "¿Dentro del modelo conceptual?",
        nullif(concat_ws('. ', nullif(fe.mecanismo,''), nullif('Periodicidad: '||fe.periodicidad,'Periodicidad: '), nullif('Formato: '||fe.formato,'Formato: '), nullif('Vigencia: '||fe.vigencia,'Vigencia: ')),'') as "Observaciones de uso actual"
      from fuentes_externas fe)
      ) q
      order by case when "ID" like 'EXT-%' then 1 else 0 end, "ID"
    `,
  },
  "ADI-07": {
    titulo: "Matriz de Volumetría y Criticidad de Fuentes de Datos (en vivo)",
    columns: ["ID", "Fuente / BD", "Dominio(s) funcional(es)", "Proceso(s) de negocio", "Tipo de información", "Criticidad", "Dependencia operativa (Alta / Media / Baja)",
      "Motor y versión", "Edición", "Packs licenciables en uso", "Ambiente", "Charset",
      "Tamaño total (GB)", "Datos (GB)", "Índices (GB)", "N° esquemas", "N° tablas", "N° índices",
      "N° vistas", "N° procedimientos", "N° triggers", "Tabla más grande", "Tabla más grande (GB)",
      "Crecimiento (GB/mes)", "Redo (GB/día)", "TDE", "Fecha volumetría",
      "Servidor", "Datafiles asignados (GB)", "Datafiles usados (GB)", "% uso datafiles",
      "Disco servidor asignado (GB)", "Disco servidor usado (GB)", "% uso disco servidor",
      "Relevancia para el expediente previsional", "Observaciones de almacenamiento / crecimiento"],
    sql: `
      select
        'FTE-'||lpad((row_number() over (order by (case when b.en_modelo_conceptual and exists(select 1 from aplicacion_basedatos ab join aplicacion a2 on a2.id=ab.id_aplicacion where ab.id_bd=b.id_bd and a2.en_modelo_conceptual) then 0 else 1 end), b.nombre_bd))::text,3,'0') as "ID",
        b.nombre_bd as "Fuente / BD",
        (select case max(case upper(trim(a.criticidad)) when 'ALTA' then 3 when 'MEDIA' then 2 when 'BAJA' then 1 else 0 end)
           when 3 then 'Alta' when 2 then 'Media' when 1 then 'Baja' else '' end
         from aplicacion_basedatos ab join aplicacion a on a.id=ab.id_aplicacion where ab.id_bd=b.id_bd) as "Criticidad",
        coalesce((select string_agg(distinct df.desc_dominio, ' | ' order by df.desc_dominio)
                  from aplicacion_basedatos ab join aplicacion aflt on aflt.id=ab.id_aplicacion join aplicacion_proceso ap on ap.id_aplicacion=ab.id_aplicacion
                  join proceso_negocio pn on pn.id_proceso=ap.id_proceso join dominio_funcional df on df.id_dominio=pn.id_dominio
                  where ab.id_bd=b.id_bd),'') as "Dominio(s) funcional(es)",
        coalesce((select string_agg(distinct pn.desc_proceso, ' | ' order by pn.desc_proceso)
                  from aplicacion_basedatos ab join aplicacion aflt on aflt.id=ab.id_aplicacion join aplicacion_proceso ap on ap.id_aplicacion=ab.id_aplicacion
                  join proceso_negocio pn on pn.id_proceso=ap.id_proceso
                  where ab.id_bd=b.id_bd),'') as "Proceso(s) de negocio",
        case when lower(m.desc_motor) like '%oracle%'
             then coalesce(nullif(trim(b.tipo_info_gest),''), nullif(trim(b.entidades_conceptuales),''), '')
             else coalesce(nullif(trim(b.tipo_info_gest),''),'') end as "Tipo de información",
        (select case when r is null then ''
                 else (case when r>=2.5 then 'Alta' when r>=1.5 then 'Media' else 'Baja' end)
                   || ' — ' ||
                   (case when tpw=3 then 'soporta procesos misionales' when tpw=2 then 'soporta procesos estratégicos'
                         when tpw=1 then 'soporta procesos de soporte' else 'sin proceso asociado' end)
                   || (case when crw>0 then ', con aplicaciones de criticidad ' ||
                              (case crw when 3 then 'alta' when 2 then 'media' else 'baja' end) else '' end)
                 end
           from (
             select tpw, crw,
               case when tpw>0 and crw>0 then (tpw+crw)/2.0 when tpw>0 then tpw::numeric when crw>0 then crw::numeric else null end as r
             from (
               select
                 coalesce((select max(case when tp.desc_tipo_proceso ilike '%misional%' then 3 when tp.desc_tipo_proceso ilike '%estrat%' then 2 when tp.desc_tipo_proceso ilike '%soporte%' then 1 else 0 end)
                   from aplicacion_basedatos ab join aplicacion aflt on aflt.id=ab.id_aplicacion join aplicacion_proceso ap on ap.id_aplicacion=ab.id_aplicacion join proceso_negocio pn on pn.id_proceso=ap.id_proceso join dominio_funcional df on df.id_dominio=pn.id_dominio join tipo_proceso tp on tp.id_tipo_proceso=df.id_tipo_proceso where ab.id_bd=b.id_bd),0) tpw,
                 coalesce((select max(case upper(trim(a2.criticidad)) when 'ALTA' then 3 when 'MEDIA' then 2 when 'BAJA' then 1 else 0 end)
                   from aplicacion_basedatos ab join aplicacion a2 on a2.id=ab.id_aplicacion where ab.id_bd=b.id_bd),0) crw
             ) q
           ) qq) as "Dependencia operativa (Alta / Media / Baja)",
        (m.desc_motor||' '||coalesce(b.version_bd,'')) as "Motor y versión",
        b.edicion as "Edición",
        coalesce((select string_agg(distinct trim(x), ', ' order by trim(x)) from unnest(string_to_array(b.features_usadas, ',')) x where trim(x)<>''),'') as "Packs licenciables en uso",
        a.desc_ambiente as "Ambiente", b.charset as "Charset",
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
        case when s.disco_asignado_gb>0 then round(s.disco_utilizado_gb*100/s.disco_asignado_gb,1) end as "% uso disco servidor",
        (select case
             when not hasapp then ''
             when not bden then 'Baja — fuera del modelo conceptual (metadata/enlatado/soporte), no es fuente del expediente previsional'
             when core and tpw>=3 then 'Alta — contiene entidades núcleo del expediente previsional y soporta procesos misionales'
             when core then 'Media — contiene entidades núcleo del expediente previsional (sin proceso misional asociado)'
             when tpw>=3 then 'Media — soporta procesos misionales del expediente previsional (sin entidades núcleo detectadas)'
             when tpw=2 then 'Media — soporta dominios previsionales de gestión/estrategia'
             when tpw=1 then 'Baja — solo procesos de apoyo administrativo'
             else 'Baja — sin vínculo con dominios del expediente previsional'
           end
           from (
             select
               b.en_modelo_conceptual as bden,
               (lower(coalesce(b.entidades_conceptuales,'')||' '||coalesce(b.tipo_info_gest,'')) ~ '(expediente|pensi|prestaci|aporte|afiliad|asegurado|derecho|planilla|beneficiari|devengue|bono)') as core,
               coalesce((select max(case when tp.desc_tipo_proceso ilike '%misional%' then 3 when tp.desc_tipo_proceso ilike '%estrat%' then 2 when tp.desc_tipo_proceso ilike '%soporte%' then 1 else 0 end)
                 from aplicacion_basedatos ab join aplicacion aflt on aflt.id=ab.id_aplicacion and aflt.en_modelo_conceptual join aplicacion_proceso ap on ap.id_aplicacion=ab.id_aplicacion join proceso_negocio pn on pn.id_proceso=ap.id_proceso join dominio_funcional df on df.id_dominio=pn.id_dominio join tipo_proceso tp on tp.id_tipo_proceso=df.id_tipo_proceso where ab.id_bd=b.id_bd),0) as tpw,
               exists(select 1 from aplicacion_basedatos ab join aplicacion aflt on aflt.id=ab.id_aplicacion and aflt.en_modelo_conceptual where ab.id_bd=b.id_bd) as hasapp
           ) z) as "Relevancia para el expediente previsional",
        coalesce(nullif(trim(
           (case when coalesce(b.tamano_asignado_gb,0)>0 and b.tamano_usado_gb*100.0/b.tamano_asignado_gb>=85 then 'Datafiles al '||round(b.tamano_usado_gb*100.0/b.tamano_asignado_gb)||'% de su asignado. ' else '' end)||
           (case when coalesce(b.crecimiento_gb,0)>0 then 'Crecimiento estimado ~'||b.crecimiento_gb||' GB/mes. ' else '' end)||
           (case when coalesce(s.disco_asignado_gb,0)>0 and s.disco_utilizado_gb*100.0/s.disco_asignado_gb>=85 then 'Disco del servidor al '||round(s.disco_utilizado_gb*100.0/s.disco_asignado_gb)||'%. ' else '' end)
         ),''),'') as "Observaciones de almacenamiento / crecimiento"
      from base_de_datos b
      left join motor_bd m on m.id_motor_bd=b.id_motor_bd
      left join ambiente a on a.id_ambiente=b.id_ambiente
      left join servidor s on s.id_servidor=b.id_servidor
      order by (case when b.en_modelo_conceptual and exists(select 1 from aplicacion_basedatos ab join aplicacion a2 on a2.id=ab.id_aplicacion where ab.id_bd=b.id_bd and a2.en_modelo_conceptual) then 0 else 1 end), b.nombre_bd
    `,
  },
  "ADI-04": {
    titulo: "Matriz de Fuentes de Datos por Dominio Funcional (en vivo)",
    columns: ["Tipo de proceso", "Dominio funcional (normalizado)", "Procesos de negocio incluidos", "N° proc.",
      "N° apps", "Aplicaciones del dominio", "N° BD", "Fuentes de datos / BD del dominio", "Motores involucrados",
      "Tipo de información", "Uso principal", "Áreas usuarias", "Fuentes exclusivas del dominio",
      "Fuentes compartidas con otros dominios", "Nivel de relación",
      "Vacíos / solapamientos / dispersión", "Observaciones para el modelo conceptual"],
    sql: `
      with dom_app as (select ap.id_proceso, ap.id_aplicacion from aplicacion_proceso ap
                       join aplicacion a on a.id=ap.id_aplicacion where a.en_modelo_conceptual)
      select
        tp.desc_tipo_proceso as "Tipo de proceso", df.desc_dominio as "Dominio funcional (normalizado)",
        (select string_agg(distinct pn.desc_proceso,' · ') from proceso_negocio pn where pn.id_dominio=df.id_dominio) as "Procesos de negocio incluidos",
        (select count(*) from proceso_negocio pn where pn.id_dominio=df.id_dominio)::int as "N° proc.",
        (select count(distinct ap.id_aplicacion) from dom_app ap join proceso_negocio pn on pn.id_proceso=ap.id_proceso where pn.id_dominio=df.id_dominio)::int as "N° apps",
        (select string_agg(distinct a.id_app,' ') from dom_app ap join proceso_negocio pn on pn.id_proceso=ap.id_proceso join aplicacion a on a.id=ap.id_aplicacion where pn.id_dominio=df.id_dominio) as "Aplicaciones del dominio",
        (select count(distinct abx.id_bd) from dom_app ap join proceso_negocio pn on pn.id_proceso=ap.id_proceso join aplicacion_basedatos abx on abx.id_aplicacion=ap.id_aplicacion join base_de_datos b on b.id_bd=abx.id_bd and b.en_modelo_conceptual where pn.id_dominio=df.id_dominio)::int as "N° BD",
        (select string_agg(distinct b.nombre_bd,' ') from dom_app ap join proceso_negocio pn on pn.id_proceso=ap.id_proceso join aplicacion_basedatos abx on abx.id_aplicacion=ap.id_aplicacion join base_de_datos b on b.id_bd=abx.id_bd and b.en_modelo_conceptual where pn.id_dominio=df.id_dominio) as "Fuentes de datos / BD del dominio",
        (select string_agg(distinct m.desc_motor,', ') from dom_app ap join proceso_negocio pn on pn.id_proceso=ap.id_proceso join aplicacion_basedatos abx on abx.id_aplicacion=ap.id_aplicacion join base_de_datos b on b.id_bd=abx.id_bd and b.en_modelo_conceptual join motor_bd m on m.id_motor_bd=b.id_motor_bd where pn.id_dominio=df.id_dominio) as "Motores involucrados",
        (select string_agg(z.entidad, ', ' order by z.tot desc, z.entidad) from (select fe.entidad, sum(fe.nro_menciones) tot from dom_app ap join proceso_negocio pn on pn.id_proceso=ap.id_proceso join aplicacion_basedatos abx on abx.id_aplicacion=ap.id_aplicacion join base_de_datos b on b.id_bd=abx.id_bd and b.en_modelo_conceptual join fuente_entidad fe on fe.id_bd=b.id_bd where pn.id_dominio=df.id_dominio group by fe.entidad) z) as "Tipo de información",
        (select string_agg(distinct o.nombre_vigente, ' | ' order by o.nombre_vigente)
           from dom_app ap join proceso_negocio pn on pn.id_proceso=ap.id_proceso
           join aplicacion_area aa on aa.id_aplicacion=ap.id_aplicacion
           join oficina o on trim(o.sigla)=trim(aa.sigla)
           where pn.id_dominio=df.id_dominio) as "Áreas usuarias",
        (select string_agg(distinct b.nombre_bd,' ') from dom_app ap join proceso_negocio pn on pn.id_proceso=ap.id_proceso join aplicacion_basedatos abx on abx.id_aplicacion=ap.id_aplicacion join base_de_datos b on b.id_bd=abx.id_bd and b.en_modelo_conceptual where pn.id_dominio=df.id_dominio and (select count(distinct pn2.id_dominio) from aplicacion_basedatos abx2 join dom_app ap2 on ap2.id_aplicacion=abx2.id_aplicacion join proceso_negocio pn2 on pn2.id_proceso=ap2.id_proceso where abx2.id_bd=b.id_bd)=1) as "Fuentes exclusivas del dominio",
        (select string_agg(distinct b.nombre_bd,' ') from dom_app ap join proceso_negocio pn on pn.id_proceso=ap.id_proceso join aplicacion_basedatos abx on abx.id_aplicacion=ap.id_aplicacion join base_de_datos b on b.id_bd=abx.id_bd and b.en_modelo_conceptual where pn.id_dominio=df.id_dominio and (select count(distinct pn2.id_dominio) from aplicacion_basedatos abx2 join dom_app ap2 on ap2.id_aplicacion=abx2.id_aplicacion join proceso_negocio pn2 on pn2.id_proceso=ap2.id_proceso where abx2.id_bd=b.id_bd)>1) as "Fuentes compartidas con otros dominios",
        coalesce(df.uso_principal,'') as "Uso principal",
        coalesce(df.nivel_relacion,'') as "Nivel de relación",
        df.obs_vacios as "Vacíos / solapamientos / dispersión",
        df.obs_modelo_concept as "Observaciones para el modelo conceptual"
      from dominio_funcional df join tipo_proceso tp on tp.id_tipo_proceso=df.id_tipo_proceso
      order by tp.id_tipo_proceso, df.desc_dominio
    `,
  },
  "ADI-04-FD": {
    titulo: "Matriz de Fuentes de Datos por Dominio Funcional — Fuente × Dominio (en vivo)",
    columns: ["Dominio funcional", "Tipo de proceso", "Fuente de datos asociada", "Sistema / repositorio relacionado",
      "Tipo de información gestionada", "Área responsable", "Uso principal de la información",
      "Nivel de relación con el dominio", "Fuentes compartidas con otros dominios",
      "Vacíos / solapamientos / dispersión", "Observaciones para el modelo conceptual"],
    sql: `
      with dom_app as (select ap.id_proceso, ap.id_aplicacion from aplicacion_proceso ap
                       join aplicacion a on a.id=ap.id_aplicacion where a.en_modelo_conceptual),
      fd as (select distinct abx.id_bd, pn.id_dominio
             from dom_app ap join proceso_negocio pn on pn.id_proceso=ap.id_proceso
             join aplicacion_basedatos abx on abx.id_aplicacion=ap.id_aplicacion
             join base_de_datos b on b.id_bd=abx.id_bd and b.en_modelo_conceptual)
      select
        df.desc_dominio as "Dominio funcional",
        tp.desc_tipo_proceso as "Tipo de proceso",
        b.nombre_bd as "Fuente de datos asociada",
        coalesce((select string_agg(distinct a.id_app||' '||coalesce(a.abreviatura_app,a.nombre_app),', ')
           from dom_app ap join proceso_negocio pn on pn.id_proceso=ap.id_proceso
           join aplicacion a on a.id=ap.id_aplicacion
           join aplicacion_basedatos abx on abx.id_aplicacion=a.id
           where abx.id_bd=b.id_bd and pn.id_dominio=df.id_dominio),'') as "Sistema / repositorio relacionado",
        coalesce(b.tipo_info_gest,'') as "Tipo de información gestionada",
        coalesce((select string_agg(distinct o.nombre_vigente,' · ' order by o.nombre_vigente)
           from dom_app ap join proceso_negocio pn on pn.id_proceso=ap.id_proceso
           join aplicacion_area aa on aa.id_aplicacion=ap.id_aplicacion
           join oficina o on trim(o.sigla)=trim(aa.sigla)
           where pn.id_dominio=df.id_dominio
             and ap.id_aplicacion in (select abx.id_aplicacion from aplicacion_basedatos abx where abx.id_bd=b.id_bd)),'') as "Área responsable",
        coalesce(df.uso_principal,'') as "Uso principal de la información",
        coalesce(nr.nivel,'Referencial') as "Nivel de relación con el dominio", -- tabla curable nivel_relacion_dominio (seed_nivel_relacion.py)
        coalesce((select string_agg(distinct df2.desc_dominio,' · ' order by df2.desc_dominio)
           from fd f2 join dominio_funcional df2 on df2.id_dominio=f2.id_dominio
           where f2.id_bd=b.id_bd and f2.id_dominio<>df.id_dominio),'(exclusiva de este dominio)') as "Fuentes compartidas con otros dominios",
        coalesce(df.obs_vacios,'') as "Vacíos / solapamientos / dispersión",
        coalesce(df.obs_modelo_concept,'') as "Observaciones para el modelo conceptual"
      from fd
      join base_de_datos b on b.id_bd=fd.id_bd
      join dominio_funcional df on df.id_dominio=fd.id_dominio
      join tipo_proceso tp on tp.id_tipo_proceso=df.id_tipo_proceso
      left join nivel_relacion_dominio nr on nr.id_bd=fd.id_bd and nr.id_dominio=fd.id_dominio
      order by tp.id_tipo_proceso, df.desc_dominio,
        (case coalesce(nr.nivel,'Referencial') when 'Principal' then 0 when 'Complementaria' then 1 else 2 end),
        b.nombre_bd
    `,
  },
  "ADI-09": {
    titulo: "Modelo de Correspondencia Procesos, Dominios y Fuentes de Datos (en vivo)",
    columns: ["N°", "Tipo de proceso", "Dominio funcional", "Proceso de negocio", "N° apps", "Aplicaciones",
      "N° fuentes", "Fuentes de datos / BD", "Entidades conceptuales (detectadas)", "Tipo de información",
      "Cobertura del dominio", "Vacíos", "Solapamientos / redundancias", "Fragmentación",
      "Desalineamiento vs. SIIP", "Relevancia p/ modelo AS-IS", "Evidencia"],
    sql: `
      with dom_app as (select ap.id_proceso, ap.id_aplicacion from aplicacion_proceso ap
                       join aplicacion a on a.id=ap.id_aplicacion where a.en_modelo_conceptual)
      select
        (row_number() over (order by tp.id_tipo_proceso, df.desc_dominio, pn.desc_proceso))::int as "N°",
        tp.desc_tipo_proceso as "Tipo de proceso",
        df.desc_dominio as "Dominio funcional",
        pn.desc_proceso as "Proceso de negocio",
        (select count(distinct ap.id_aplicacion) from dom_app ap where ap.id_proceso=pn.id_proceso)::int as "N° apps",
        (select string_agg(distinct a.id_app || coalesce(' ('||nullif(trim(a.abreviatura_app),'')||')',''), ', ') from dom_app ap join aplicacion a on a.id=ap.id_aplicacion where ap.id_proceso=pn.id_proceso) as "Aplicaciones",
        (select count(distinct abx.id_bd) from dom_app ap join aplicacion_basedatos abx on abx.id_aplicacion=ap.id_aplicacion join base_de_datos b on b.id_bd=abx.id_bd and b.en_modelo_conceptual where ap.id_proceso=pn.id_proceso)::int as "N° fuentes",
        (select string_agg(distinct b.nombre_bd,' ') from dom_app ap join aplicacion_basedatos abx on abx.id_aplicacion=ap.id_aplicacion join base_de_datos b on b.id_bd=abx.id_bd and b.en_modelo_conceptual where ap.id_proceso=pn.id_proceso) as "Fuentes de datos / BD",
        (select string_agg(z.entidad, ', ' order by z.tot desc, z.entidad) from (select fe.entidad, sum(fe.nro_menciones) tot from dom_app ap join aplicacion_basedatos abx on abx.id_aplicacion=ap.id_aplicacion join base_de_datos b on b.id_bd=abx.id_bd and b.en_modelo_conceptual join fuente_entidad fe on fe.id_bd=abx.id_bd where ap.id_proceso=pn.id_proceso group by fe.entidad) z) as "Entidades conceptuales (detectadas)",
        (select string_agg(z.entidad, ', ' order by z.tot desc, z.entidad) from (select fe.entidad, sum(fe.nro_menciones) tot from dom_app ap join aplicacion_basedatos abx on abx.id_aplicacion=ap.id_aplicacion join base_de_datos b on b.id_bd=abx.id_bd and b.en_modelo_conceptual join fuente_entidad fe on fe.id_bd=abx.id_bd where ap.id_proceso=pn.id_proceso group by fe.entidad) z) as "Tipo de información",
        coalesce(an.cobertura,'') as "Cobertura del dominio",
        coalesce(an.vacios,'') as "Vacíos",
        coalesce(an.solapamientos,'') as "Solapamientos / redundancias",
        coalesce(an.fragmentacion,'') as "Fragmentación",
        coalesce(an.desalineamiento_siip,'') as "Desalineamiento vs. SIIP",
        coalesce(an.relevancia_asis,'') as "Relevancia p/ modelo AS-IS",
        'Repositorio y aplicativo del Documento Equivalente de la BDI —modelo de datos y web de consulta— como síntesis del levantamiento AS-IS (F-29); el alineamiento conceptual se contrasta con el Modelo Conceptual del SIIP (F-26).' as "Evidencia"
      from proceso_negocio pn
      join dominio_funcional df on df.id_dominio=pn.id_dominio
      join tipo_proceso tp on tp.id_tipo_proceso=df.id_tipo_proceso
      left join analisis_proceso_adi09 an on an.id_proceso=pn.id_proceso
      order by tp.id_tipo_proceso, df.desc_dominio, pn.desc_proceso
    `,
  },
  "ADI-08": {
    titulo: "Brechas, Riesgos y Restricciones del Ecosistema de Datos (en vivo)",
    columns: ["ID", "Tipo", "Tema", "Severidad", "Descripción", "Elemento afectado",
      "Evidencia / sustento", "Causa preliminar", "Impacto", "Riesgo para la implementación",
      "Recomendación inicial", "Relación con la BD Integrada", "Consideraciones de seguridad"],
    sql: `
      select id as "ID", coalesce(tipo,'') as "Tipo", coalesce(tema,'') as "Tema",
        coalesce(severidad,'') as "Severidad", coalesce(descripcion,'') as "Descripción",
        coalesce(elemento_afectado,'') as "Elemento afectado", coalesce(evidencia,'') as "Evidencia / sustento",
        coalesce(causa_preliminar,'') as "Causa preliminar", coalesce(impacto,'') as "Impacto",
        coalesce(riesgo_implementacion,'') as "Riesgo para la implementación",
        coalesce(recomendacion,'') as "Recomendación inicial", coalesce(relacion_bdi,'') as "Relación con la BD Integrada",
        coalesce(consideraciones_seguridad,'') as "Consideraciones de seguridad"
      from riesgo_adi08 order by orden
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

// ---------------- Exportación EN VIVO a Excel (sin archivos estáticos) ----------------
const ART_IDS = ["ADI-01", "ADI-02", "ADI-03", "ADI-04", "ADI-04-FD", "ADI-05", "ADI-07", "ADI-08", "ADI-09"];
const FCOLS: [string, string][] = [
  ["id_fuente", "N°"], ["fuente_documental", "Fuente documental revisada"],
  ["descripcion_proposito", "Descripción / propósito"], ["resumen", "Resumen / análisis del contenido"],
  ["area_responsable", "Área responsable"], ["fecha_version_estado", "Fecha de la fuente"],
  ["version_fuente", "Versión de la fuente"], ["estado_disponibilidad", "Estado de disponibilidad"],
  ["tipo_fuente", "Tipo de fuente"], ["formato_medio", "Formato / medio"],
  ["nivel_confidencialidad", "Confidencialidad"], ["relacion_sistemas_procesos", "Relación con sistemas / procesos"],
  ["sirve_adi", "Sirve a (ADI)"],
  ["hallazgos", "Hallazgos"], ["vacios_inconsistencias", "Vacíos / inconsistencias"],
  ["evidencia_revision", "Evidencia (archivo/patrón)"], ["enlace", "Enlace"],
];
async function artData(id: string): Promise<{ columns: string[]; rows: string[][] }> {
  if (id === "ADI-01") {
    const data: any[] = await (prisma as any).fuentes_institucionales.findMany({ orderBy: { id_fuente: "asc" } });
    const columns = FCOLS.map((x) => x[1]);
    const rows = data.map((r) => FCOLS.map(([f]) => (r[f] == null ? "" : String(r[f]))));
    return { columns, rows };
  }
  const a = ARTE[id];
  if (!a) throw new Error("artefacto no disponible en vivo");
  const d = await prisma.$queryRawUnsafe<any[]>(a.sql);
  const rows = d.map((r) => a.columns.map((c) => (r[c] == null ? "" : String(r[c]))));
  return { columns: a.columns, rows };
}
async function trazaOf(id: string): Promise<Traza[]> {
  return await prisma.$queryRawUnsafe<Traza[]>(
    "select columna_art, fuente_id, origen_pg, estado from trazabilidad_artefacto where artefacto=$1 order by nro", id);
}
async function descOf(id: string): Promise<Record<string, string>> {
  const rows = await prisma.$queryRawUnsafe<any[]>(
    "select columna, descripcion from artefacto_columna_desc where artefacto=$1", id);
  const out: Record<string, string> = {};
  for (const r of rows) out[r.columna] = r.descripcion;
  return out;
}
async function sendWb(res: any, wb: any, filename: string) {
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  // la URL termina en .xlsx (extensión que Cloudflare cachea por defecto): evitamos
  // que se cachee para que la descarga sea siempre EN VIVO y no exponga respuestas con clave.
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
  await wb.xlsx.write(res); res.end();
}
app.get("/api/artefactos.xlsx", async (_req, res) => {
  try {
    const wb = newWorkbook();
    addPortada(wb, ART_IDS);
    for (const id of ART_IDS) {
      const { columns, rows } = await artData(id);
      addSheet(wb, id, columns, rows, await trazaOf(id), await descOf(id));
    }
    await sendWb(res, wb, "Artefactos_ADI_E2_Diagnostico_ASIS_LCP.xlsx");
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});
app.get("/api/artefacto/:id/xlsx", async (req, res) => {
  try {
    const id = req.params.id;
    if (!ART_IDS.includes(id)) return res.status(404).json({ error: "artefacto no disponible" });
    const { columns, rows } = await artData(id);
    const wb = newWorkbook();
    addSheet(wb, id, columns, rows, await trazaOf(id), await descOf(id));
    await sendWb(res, wb, `${id}.xlsx`);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// Descripciones de cabecera de columnas (tooltips web; luego comentarios en Excel).
// Fuente única: tabla artefacto_columna_desc. Devuelve {artefacto:{columna:desc}}.
app.get("/api/columnas_desc", async (_req, res) => {
  try {
    const rows = await prisma.$queryRawUnsafe<any[]>(
      `select artefacto, columna, descripcion from artefacto_columna_desc`);
    const out: Record<string, Record<string, string>> = {};
    for (const r of rows) { (out[r.artefacto] ||= {})[r.columna] = r.descripcion; }
    res.json(out);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ---------------- Bitácora de subsanación (modificaciones al modelo) ----------------
// Solo las subsanaciones del 2.º entregable que CREARON o CORRIGIERON información en
// el modelo de datos. Se lee en vivo desde la tabla bitacora_subsanacion.
app.get("/api/bitacora", async (_req, res) => {
  try {
    const rows = await prisma.$queryRawUnsafe<any[]>(
      `select to_char(fecha,'YYYY-MM-DD') fecha, artefacto, obs_codigo, tipo_cambio,
              objeto, descripcion, fuente, estado
       from bitacora_subsanacion order by artefacto, obs_codigo, id`);
    res.json(rows);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ---------------- Mapa de flujo de datos (en vivo vs PG) ----------------
// Nodos = BD + fuentes externas; aristas = flujos agregados origen->destino,
// fusionadas por par {A,B} con flechas según sentido. Mismo criterio que el
// generador histórico, ahora servido en vivo desde Postgres.
app.get("/api/flujo", async (_req, res) => {
  try {
    const SEP = "";
    const SINK = new Set(["Archivo plano", "Dataset interno"]);
    const MOTOR_COLOR: Record<string, string> = { "Oracle": "#C74634", "SQL Server": "#2B6CB0", "DB2": "#2C7A7B", "MySQL": "#3A7D44" };
    const TIPO_LABEL: [string, string][] = [["mision", "Misional"], ["estrat", "Estratégico"], ["soporte", "Soporte"], ["complement", "Complementario"]];
    const tipoLab = (tp: string) => { const u = (tp || "").toLowerCase(); for (const [p, l] of TIPO_LABEL) if (u.startsWith(p)) return l; return tp || "(otro)"; };
    const isDev = (x: string | null) => !!x && (x.toUpperCase().replace(/\.+$/, "").endsWith("DEV") || x.toUpperCase().includes("DEV."));
    const nid = (ext: string | null, idbd: number | null) => (ext ? "ext:" + ext : "bd:" + String(idbd));

    const raw = await prisma.$queryRawUnsafe<any[]>(
      `select i.origen_externo, i.id_bd_origen, i.id_bd_destino, i.destino_externo, i.mecanismo,
              fe.codigo fe_cod, fe.nombre fe_nom, count(*)::int n
       from integraciones i left join fuentes_externas fe on fe.id_fuente_ext=i.id_fuente_externa_origen
       where left(upper(coalesce(i.nombre_enlace,'')),4) <> 'SEQ_'
       group by 1,2,3,4,5,6,7`);
    const bdRows = await prisma.$queryRawUnsafe<any[]>(
      `select b.id_bd, b.nombre_bd, s.nombre_servidor, m.desc_motor, a.desc_ambiente,
              b.version_bd, b.edicion, b.tamano_gb, b.nro_tablas, b.nro_esquemas, b.estado_bd
       from base_de_datos b
       left join servidor s on s.id_servidor=b.id_servidor
       left join motor_bd m on m.id_motor_bd=b.id_motor_bd
       left join ambiente a on a.id_ambiente=b.id_ambiente`);
    const bd = new Map<number, any>(bdRows.map((r) => [r.id_bd, r]));
    const tipoRows = await prisma.$queryRawUnsafe<any[]>(
      `select b.id_bd, tp.desc_tipo_proceso tp, count(distinct pn.id_proceso)::int n
       from base_de_datos b
       join aplicacion_basedatos ab on ab.id_bd=b.id_bd
       join aplicacion a on a.id=ab.id_aplicacion
       join aplicacion_proceso ap on ap.id_aplicacion=a.id
       join proceso_negocio pn on pn.id_proceso=ap.id_proceso
       join dominio_funcional df on df.id_dominio=pn.id_dominio
       join tipo_proceso tp on tp.id_tipo_proceso=df.id_tipo_proceso
       group by b.id_bd, tp.desc_tipo_proceso`);
    const tiposBd = new Map<number, Record<string, number>>();
    for (const r of tipoRows) { const m = tiposBd.get(r.id_bd) || {}; m[r.tp] = r.n; tiposBd.set(r.id_bd, m); }
    // dominios funcionales asignados a cada BD (vía aplicaciones) — para el filtro por dominio
    const domRows = await prisma.$queryRawUnsafe<any[]>(
      `select distinct b.id_bd, df.desc_dominio
       from base_de_datos b
       join aplicacion_basedatos ab on ab.id_bd=b.id_bd
       join aplicacion a on a.id=ab.id_aplicacion
       join aplicacion_proceso ap on ap.id_aplicacion=a.id
       join proceso_negocio pn on pn.id_proceso=ap.id_proceso
       join dominio_funcional df on df.id_dominio=pn.id_dominio`);
    const domBd = new Map<number, string[]>();
    for (const r of domRows) { const a = domBd.get(r.id_bd) || []; a.push(r.desc_dominio); domBd.set(r.id_bd, a); }
    const allDomains = [...new Set(domRows.map((r) => r.desc_dominio))].sort((a, b) => a.localeCompare(b));

    // nombre_bd -> id_bd (para resolver textos externos que en realidad nombran BD conocidas)
    const bdName2Id = new Map<string, number>();
    for (const r of bdRows) { const u = String(r.nombre_bd).toUpperCase(); if (!bdName2Id.has(u)) bdName2Id.set(u, r.id_bd); }
    const ENGINE = new Set(["ORACLE", "SQL", "SQL SERVER", "ORACLE DATABASE", "DB2", "MYSQL"]);
    const fxLabel: Record<string, string> = {};
    const resolveEp = (text: string | null, idbd: number | null): string[] => {
      if (idbd) return ["bd:" + String(idbd)];
      if (!text || !text.trim()) return [];
      const t = text.trim();
      if (/^archivo plano/i.test(t)) return ["ext:Archivo plano"];   // variantes (.txt, etc.) -> gris
      if (/dataset/i.test(t)) return ["ext:Dataset interno"];
      const base = t.replace(/\s*\*$/, "").trim();
      const out: string[] = [];
      for (let tok of base.split(/[,/]/)) {
        tok = tok.trim(); if (!tok) continue;
        const tu = tok.toUpperCase();
        if (ENGINE.has(tu)) continue;
        if (bdName2Id.has(tu)) out.push("bd:" + String(bdName2Id.get(tu)));
      }
      return out.length ? out : ["ext:" + base];
    };

    const agg = new Map<string, { total: number; mec: Record<string, number> }>();
    const deg: Record<string, number> = {};
    for (const r of raw) {
      const oe = r.origen_externo, de = r.destino_externo, ido = r.id_bd_origen, idd = r.id_bd_destino, mec = r.mecanismo, n = r.n;
      if (isDev(oe) || isDev(de)) continue;
      let srcList: string[];
      if (r.fe_cod) { fxLabel[r.fe_cod] = r.fe_nom || r.fe_cod; srcList = ["fx:" + r.fe_cod]; }
      else srcList = resolveEp(oe, ido);
      const dstList = resolveEp(de, idd);
      for (const src of srcList) for (const dst of dstList) {
        if (!src || !dst || src === dst) continue;
        const k = src + SEP + dst;
        const e = agg.get(k) || { total: 0, mec: {} };
        e.total += n; e.mec[mec] = (e.mec[mec] || 0) + n; agg.set(k, e);
        deg[src] = (deg[src] || 0) + n; deg[dst] = (deg[dst] || 0) + n;
      }
    }

    const nodes = new Map<string, any>();
    const addNode = (nodeId: string) => {
      if (nodes.has(nodeId)) return;
      if (nodeId.startsWith("fx:")) {
        const code = nodeId.slice(3); const lab = fxLabel[code] || code;
        nodes.set(nodeId, { id: nodeId, label: lab, color: "#B83280", group: "fuente_externa", domains: [], tip: `<b>${lab}</b><br>Fuente de datos externa (SUNAT) · registrada en fuentes_externas` });
        return;
      }
      if (nodeId.startsWith("ext:")) {
        const label = nodeId.slice(4);
        if (SINK.has(label)) nodes.set(nodeId, { id: nodeId, label, color: "#9E9E9E", group: "sink", domains: [], tip: `<b>${label}</b><br>Destino no-BD (salida DataStage)` });
        else nodes.set(nodeId, { id: nodeId, label, color: "#E8A33D", group: "externa", domains: [], tip: `<b>${label}</b><br>Fuente externa / destino no mapeado` });
      } else {
        const idb = parseInt(nodeId.slice(3), 10); const r = bd.get(idb); const tipos = tiposBd.get(idb) || {};
        const doms = domBd.get(idb) || [];
        const tiposStr = Object.keys(tipos).length ? Object.entries(tipos).sort((a, b) => b[1] - a[1]).map(([t, n]) => `${tipoLab(t)} (${n})`).join(", ") : "(sin clasificar)";
        const domStr = doms.length ? doms.slice().sort().join(", ") : "(sin dominio asignado)";
        if (!r) nodes.set(nodeId, { id: nodeId, label: nodeId, color: "#777", group: "bd", domains: doms, tip: `<b>${nodeId}</b><br>Dominios: ${domStr}<br>Soporta procesos: ${tiposStr}` });
        else {
          const color = MOTOR_COLOR[r.desc_motor] || "#607D8B";
          const tip = `<b>${r.nombre_bd}</b> <span style='color:#aaa'>(BD · ${r.desc_motor || "-"})</span><br>` +
            `Dominios: ${domStr}<br>` +
            `Soporta procesos: ${tiposStr}<br>` +
            `Servidor: ${r.nombre_servidor || "-"} &nbsp; Ambiente: ${r.desc_ambiente || "-"}<br>` +
            `Tamaño: ${r.tamano_gb ?? "?"} GB &nbsp; Tablas: ${r.nro_tablas ?? "?"} &nbsp; Esquemas: ${r.nro_esquemas ?? "?"}<br>` +
            `Estado: ${r.estado_bd || "-"} &nbsp; Integraciones: ${deg[nodeId] || 0}`;
          nodes.set(nodeId, { id: nodeId, label: r.nombre_bd, color, group: "bd", domains: doms, tip });
        }
      }
    };
    for (const k of agg.keys()) { const [s, d] = k.split(""); addNode(s); addNode(d); }

    const MEC_COLOR: Record<string, string> = { "ETL DataStage": "#38A169", "DB Link": "#9F7AEA", "mixto": "#A0AEC0" };
    const pairs = new Map<string, Record<string, { total: number; mec: Record<string, number> }>>();
    for (const [k, info] of agg.entries()) {
      const [s, d] = k.split(""); const pk = [s, d].sort().join("");
      const p = pairs.get(pk) || {}; p[s + "" + d] = info; pairs.set(pk, p);
    }
    const edges: any[] = []; let maxw = 1;
    for (const [pk, dirs] of pairs.entries()) {
      const [a, b] = pk.split("");
      const fwd = dirs[a + "" + b], bwd = dirs[b + "" + a];
      const total = (fwd ? fwd.total : 0) + (bwd ? bwd.total : 0); maxw = Math.max(maxw, total);
      const mecset = new Set<string>(); for (const dd of [fwd, bwd]) if (dd) Object.keys(dd.mec).forEach((m) => mecset.add(m));
      let col: string, dash: boolean, mlab: string;
      if (mecset.size === 1 && mecset.has("ETL DataStage")) { col = MEC_COLOR["ETL DataStage"]; dash = false; mlab = "Flujo DataStage"; }
      else if (mecset.size === 1 && mecset.has("DB Link")) { col = MEC_COLOR["DB Link"]; dash = true; mlab = "Flujo DB Link"; }
      else { col = MEC_COLOR["mixto"]; dash = false; mlab = "DataStage + DB Link"; }
      const lines: string[] = [];
      if (fwd) lines.push(`${nodes.get(a).label} → ${nodes.get(b).label}: ${fwd.total} (` + Object.entries(fwd.mec).map(([k2, v]) => `${k2}:${v}`).join(", ") + ")");
      if (bwd) lines.push(`${nodes.get(b).label} → ${nodes.get(a).label}: ${bwd.total} (` + Object.entries(bwd.mec).map(([k2, v]) => `${k2}:${v}`).join(", ") + ")");
      const bidir = !!fwd && !!bwd;
      const tip = `<b>${mlab}${bidir ? " (bidireccional)" : ""}</b><br>` + lines.join("<br>");
      edges.push({ from: a, to: b, value: total, arrowTo: !!fwd, arrowFrom: !!bwd, color: col, dashes: dash, tip });
    }
    res.json({ nodes: [...nodes.values()], edges, maxw, domains: allDomains });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ---------------- Modelo conceptual de datos AS-IS (en vivo vs PG) ----------------
// Nodos = entidades conceptuales (coloreadas por dominio de información);
// aristas = relaciones conceptuales (con cardinalidad). Refleja lo editado en la web.
app.get("/api/modelo_conceptual", async (_req, res) => {
  try {
    const PAL: Record<string, string> = {
      "Personas": "#C74634", "Aportes": "#2B6CB0", "Expedientes": "#2C7A7B", "Derechos y prestaciones": "#6B46C1",
      "Pagos y planillas": "#B7791F", "Seguros": "#3A7D44", "Inversiones": "#0E7490", "Atención al asegurado": "#BE5C00",
      "Documentos y notificaciones": "#718096", "Riesgos": "#9B2C2C",
    };
    const ents = await prisma.$queryRawUnsafe<any[]>(
      `select e.id_entidad, e.nombre, e.dominio_info, e.es_nucleo, e.descripcion,
         (select count(distinct fe.id_bd)::int from fuente_entidad fe join base_de_datos b on b.id_bd=fe.id_bd and b.en_modelo_conceptual where fe.entidad=e.nombre) nf
       from entidad_conceptual e order by e.id_entidad`);
    const rels = await prisma.$queryRawUnsafe<any[]>(
      `select eo.nombre origen, ed.nombre destino, r.descripcion, r.cardinalidad
       from relacion_conceptual r join entidad_conceptual eo on eo.id_entidad=r.id_origen
       join entidad_conceptual ed on ed.id_entidad=r.id_destino order by r.id_relacion`);
    const domains = [...new Set(ents.map((e) => e.dominio_info))];
    const nodes = ents.map((e) => ({
      id: e.nombre, label: e.nombre, group: e.dominio_info, color: PAL[e.dominio_info] || "#607D8B",
      borderWidth: e.es_nucleo ? 3 : 1,
      tip: `<b>${e.nombre}</b><br>Dominio: ${e.dominio_info}<br>${e.descripcion || ""}<br>Fuentes AS-IS (en alcance): ${e.nf}` + (e.es_nucleo ? "<br><i>entidad núcleo del expediente</i>" : ""),
    }));
    const edges = rels.map((r) => ({ from: r.origen, to: r.destino, label: r.cardinalidad, title: r.descripcion }));
    res.json({ nodes, edges, domains, palette: PAL });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ---------------- Ecosistema de Datos ONP (explorador en vivo) ----------------
// Versión LCP del explorador: estructuras tomadas correctamente del modelo (en alcance),
// reutilizando la misma lógica de ADI-03/04/05/09 y el modelo conceptual. Los arreglos se
// devuelven como texto separado por '§' y el cliente los parte.
const SEP = "§";
app.get("/api/ecosistema", async (_req, res) => {
  try {
    const raw = (s: string) => prisma.$queryRawUnsafe<any[]>(s);
    const num = (s: string) => raw(s).then((r) => Number(r[0]?.n ?? 0));

    const kpis = {
      bd: await num("select count(*) n from base_de_datos where en_modelo_conceptual"),
      apps: await num("select count(*) n from aplicacion where en_modelo_conceptual"),
      dominios: await num("select count(*) n from dominio_funcional"),
      procesos: await num("select count(*) n from proceso_negocio"),
      entidades: await num("select count(*) n from entidad_conceptual"),
      relaciones: await num("select count(*) n from relacion_conceptual"),
      integraciones: await num("select count(*) n from integraciones"),
    };

    // 1) Sistemas (apps en alcance) con sus bases/dominios/procesos/entidades (en alcance)
    const sistemas = await raw(`
      select a.id_app cod, a.nombre_app nombre, a.estado_app estado, a.criticidad,
        (select string_agg(distinct b.nombre_bd,'${SEP}') from aplicacion_basedatos ab join base_de_datos b on b.id_bd=ab.id_bd and b.en_modelo_conceptual where ab.id_aplicacion=a.id) bases,
        (select string_agg(distinct df.desc_dominio,'${SEP}') from aplicacion_proceso ap join proceso_negocio pn on pn.id_proceso=ap.id_proceso join dominio_funcional df on df.id_dominio=pn.id_dominio where ap.id_aplicacion=a.id) doms,
        (select string_agg(distinct pn.desc_proceso,'${SEP}') from aplicacion_proceso ap join proceso_negocio pn on pn.id_proceso=ap.id_proceso where ap.id_aplicacion=a.id) procs,
        (select string_agg(distinct fe.entidad,'${SEP}') from aplicacion_basedatos ab join fuente_entidad fe on fe.id_bd=ab.id_bd join base_de_datos b on b.id_bd=ab.id_bd and b.en_modelo_conceptual where ab.id_aplicacion=a.id) ents,
        (select string_agg(distinct o.nombre_vigente,'${SEP}') from aplicacion_area aa join oficina o on trim(o.sigla)=trim(aa.sigla) where aa.id_aplicacion=a.id) areas,
        a.gestor_resp gestor, a.nombre_lider_usuario respf, a.uso_informacion uso, a.desc_app descripcion
      from aplicacion a where a.en_modelo_conceptual order by a.id_app`);

    // 2) Dominios funcionales con procesos/bases/apps en alcance
    const dominios = await raw(`
      select df.desc_dominio nombre, tp.desc_tipo_proceso tipo,
        (select count(distinct pn.id_proceso)::int from proceso_negocio pn where pn.id_dominio=df.id_dominio) nproc,
        (select string_agg(distinct pn.desc_proceso,'${SEP}') from proceso_negocio pn where pn.id_dominio=df.id_dominio) procs,
        (select string_agg(distinct a.id_app,'${SEP}') from proceso_negocio pn join aplicacion_proceso ap on ap.id_proceso=pn.id_proceso join aplicacion a on a.id=ap.id_aplicacion and a.en_modelo_conceptual where pn.id_dominio=df.id_dominio) apps,
        (select string_agg(distinct b.nombre_bd,'${SEP}') from proceso_negocio pn join aplicacion_proceso ap on ap.id_proceso=pn.id_proceso join aplicacion a on a.id=ap.id_aplicacion and a.en_modelo_conceptual join aplicacion_basedatos ab on ab.id_aplicacion=a.id join base_de_datos b on b.id_bd=ab.id_bd and b.en_modelo_conceptual where pn.id_dominio=df.id_dominio) bases
      from dominio_funcional df left join tipo_proceso tp on tp.id_tipo_proceso=df.id_tipo_proceso
      order by tp.desc_tipo_proceso, df.desc_dominio`);

    // 3) Procesos de negocio (con apps/bases en alcance)
    const procesos = await raw(`
      select pn.desc_proceso proceso, df.desc_dominio dominio, tp.desc_tipo_proceso tipo,
        (select string_agg(distinct a.id_app,'${SEP}') from aplicacion_proceso ap join aplicacion a on a.id=ap.id_aplicacion and a.en_modelo_conceptual where ap.id_proceso=pn.id_proceso) apps,
        (select string_agg(distinct b.nombre_bd,'${SEP}') from aplicacion_proceso ap join aplicacion a on a.id=ap.id_aplicacion and a.en_modelo_conceptual join aplicacion_basedatos ab on ab.id_aplicacion=a.id join base_de_datos b on b.id_bd=ab.id_bd and b.en_modelo_conceptual where ap.id_proceso=pn.id_proceso) bases,
        (select string_agg(distinct fe.entidad,'${SEP}') from aplicacion_proceso ap join aplicacion a on a.id=ap.id_aplicacion and a.en_modelo_conceptual join aplicacion_basedatos ab on ab.id_aplicacion=a.id join fuente_entidad fe on fe.id_bd=ab.id_bd join base_de_datos b on b.id_bd=ab.id_bd and b.en_modelo_conceptual where ap.id_proceso=pn.id_proceso) ents
      from proceso_negocio pn join dominio_funcional df on df.id_dominio=pn.id_dominio
      left join tipo_proceso tp on tp.id_tipo_proceso=df.id_tipo_proceso
      order by tp.desc_tipo_proceso, df.desc_dominio, pn.desc_proceso`);

    // 4) Entidades conceptuales + fuentes AS-IS en alcance
    const entidades = await raw(`
      select e.nombre, e.dominio_info dominio, e.es_nucleo nucleo, e.descripcion,
        (select count(distinct fe.id_bd)::int from fuente_entidad fe join base_de_datos b on b.id_bd=fe.id_bd and b.en_modelo_conceptual where fe.entidad=e.nombre) nf,
        (select string_agg(distinct b.nombre_bd,'${SEP}') from fuente_entidad fe join base_de_datos b on b.id_bd=fe.id_bd and b.en_modelo_conceptual where fe.entidad=e.nombre) bases
      from entidad_conceptual e order by e.id_entidad`);
    const relaciones = await raw(`
      select eo.nombre origen, ed.nombre destino, r.cardinalidad, r.descripcion
      from relacion_conceptual r join entidad_conceptual eo on eo.id_entidad=r.id_origen
      join entidad_conceptual ed on ed.id_entidad=r.id_destino order by r.id_relacion`);

    // 6) SIIP: dominios de datos (dominio_info) con sus entidades y fuentes AS-IS en alcance
    const siip = await raw(`
      select e.dominio_info dominio, count(*)::int nent, string_agg(distinct e.nombre,'${SEP}') ents,
        (select count(distinct fe.id_bd)::int from fuente_entidad fe join entidad_conceptual e2 on e2.nombre=fe.entidad
          join base_de_datos b on b.id_bd=fe.id_bd and b.en_modelo_conceptual where e2.dominio_info=e.dominio_info) nf,
        (select string_agg(distinct b.nombre_bd,'${SEP}') from fuente_entidad fe join entidad_conceptual e2 on e2.nombre=fe.entidad
          join base_de_datos b on b.id_bd=fe.id_bd and b.en_modelo_conceptual where e2.dominio_info=e.dominio_info) bases
      from entidad_conceptual e group by e.dominio_info order by nent desc, dominio`);

    // 7) Brechas / vacíos computados (categorías del explorador original)
    const bases_sin_dominio = await raw(`
      select b.nombre_bd nombre, b.en_modelo_conceptual emc
      from base_de_datos b
      where not exists (select 1 from aplicacion_basedatos ab join aplicacion_proceso ap on ap.id_aplicacion=ab.id_aplicacion where ab.id_bd=b.id_bd)
      order by b.en_modelo_conceptual desc, b.nombre_bd`);
    const etl = (await raw(`
      select (count(*) filter (where id_bd_origen is null and coalesce(origen_externo,'')=''))::int orig,
             (count(*) filter (where id_bd_destino is null and coalesce(destino_externo,'')=''))::int dest
      from integraciones where mecanismo='ETL DataStage'`))[0];
    const bases_baja = await raw(`
      select b.nombre_bd nombre, b.estado_bd estado,
        (select count(*)::int from aplicacion_basedatos ab where ab.id_bd=b.id_bd) n_apps,
        (select count(*)::int from integraciones i where i.id_bd_origen=b.id_bd or i.id_bd_destino=b.id_bd) n_integ
      from base_de_datos b where upper(coalesce(b.estado_bd,'')) like '%BAJA%'
      order by n_integ desc, n_apps desc`);

    res.json({ kpis, sistemas, dominios, procesos, entidades, relaciones, siip, brechas: { bases_sin_dominio, etl, bases_baja } });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ---------------- Estructura física / DDL (esquema -> tabla -> columna) ----------------
// Se registran ANTES del CRUD genérico para que /api/estructura_bd no lo intercepte /api/:model/:id.

// Mapa { id_bd: n_tablas } (solo BD con >=1 tabla) => el cliente deshabilita el botón de las que no tienen.
app.get("/api/estructura_bd", async (_req, res) => {
  try {
    const rows = await prisma.$queryRaw<{ id_bd: number; n: bigint }[]>`
      select e.id_bd, count(t.id_tabla) n
      from esquema e join tabla t on t.id_esquema = e.id_esquema
      group by e.id_bd`;
    const map: Record<string, number> = {};
    for (const r of rows) map[String(r.id_bd)] = Number(r.n);
    res.json(map);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// Esquemas de una BD con su conteo de tablas, ordenados del más poblado al menos (default = [0]).
app.get("/api/base_de_datos/:id/estructura", async (req, res) => {
  try {
    const id = +req.params.id;
    const bd = await prisma.base_de_datos.findUnique({ where: { id_bd: id }, select: { nombre_bd: true } });
    const esq = await prisma.esquema.findMany({
      where: { id_bd: id },
      select: { id_esquema: true, nombre_esquema: true, tipo: true, _count: { select: { tabla: true } } },
    });
    const esquemas = esq
      .map((e) => ({ id_esquema: e.id_esquema, nombre_esquema: e.nombre_esquema, tipo: e.tipo, n_tablas: e._count.tabla }))
      .sort((a, b) => b.n_tablas - a.n_tablas || collator.compare(a.nombre_esquema, b.nombre_esquema));
    res.json({ nombre_bd: bd?.nombre_bd ?? null, esquemas });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// Tablas de un esquema (búsqueda opcional por nombre) con su conteo de columnas.
app.get("/api/esquema/:id/tablas", async (req, res) => {
  try {
    const id = +req.params.id;
    const q = (req.query.q as string || "").trim();
    const tabs = await prisma.tabla.findMany({
      where: { id_esquema: id, ...(q ? { nombre_tabla: { contains: q, mode: "insensitive" } } : {}) },
      select: { id_tabla: true, nombre_tabla: true, _count: { select: { columna: true } } },
      orderBy: { nombre_tabla: "asc" }, take: 1000,
    });
    res.json(tabs.map((t) => ({ id_tabla: t.id_tabla, nombre_tabla: t.nombre_tabla, n_cols: t._count.columna })));
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// Columnas de una tabla con toda su metadata (tipo/longitud/nullable/PK/comentario).
app.get("/api/tabla/:id/columnas", async (req, res) => {
  try {
    const cols = await prisma.columna.findMany({
      where: { id_tabla: +req.params.id },
      select: { col_id: true, nombre_columna: true, tipo: true, longitud: true, nullable: true, es_pk: true, comentario: true },
      orderBy: [{ col_id: "asc" }, { nombre_columna: "asc" }],
    });
    res.json(cols);
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
// Cascada de alcance: BD en alcance ligadas a esta app (para preguntar si salen tambien
// del modelo conceptual cuando la app sale). 'compartida' = la usan OTRAS apps en alcance.
app.get("/api/aplicacion/:id/bd-cascada", async (req, res) => {
  try {
    const id = +req.params.id;
    const links = await prisma.aplicacion_basedatos.findMany({
      where: { id_aplicacion: id, base_de_datos: { en_modelo_conceptual: true } },
      include: { base_de_datos: { select: { id_bd: true, nombre_bd: true } } },
      orderBy: { base_de_datos: { nombre_bd: "asc" } },
    });
    const out = [];
    for (const l of links) {
      const otras = await prisma.aplicacion_basedatos.findMany({
        where: { id_bd: l.id_bd, id_aplicacion: { not: id }, aplicacion: { en_modelo_conceptual: true } },
        include: { aplicacion: { select: { id_app: true } } },
      });
      out.push({
        id_bd: l.id_bd, nombre_bd: l.base_de_datos.nombre_bd,
        compartida: otras.length > 0, otras_apps: otras.map((o) => o.aplicacion.id_app),
      });
    }
    res.json(out);
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});
app.post("/api/aplicacion/:id/bd-cascada", async (req, res) => {
  try {
    const id = +req.params.id;
    const ids: number[] = (req.body.ids || []).map(Number).filter(Boolean);
    if (!ids.length) return res.json({ updated: 0 });
    // Solo BD realmente ligadas a esta app (evita actualizar ids arbitrarios)
    const valid = await prisma.aplicacion_basedatos.findMany({ where: { id_aplicacion: id, id_bd: { in: ids } }, select: { id_bd: true } });
    const vset = valid.map((v) => v.id_bd);
    const r = await prisma.base_de_datos.updateMany({
      where: { id_bd: { in: vset } },
      data: { en_modelo_conceptual: false, fecha_modificacion: new Date(), ip_modificacion: clientIp(req) },
    });
    res.json({ updated: r.count });
  } catch (e: any) { res.status(400).json({ error: e.message }); }
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
