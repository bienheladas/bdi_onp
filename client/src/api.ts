export type Field = {
  name: string; type: string; isPk: boolean; hasDefault: boolean; required: boolean; auto?: boolean;
  fk: { model: string; toField: string; label: string[] } | null;
  catalog?: string | null;   // si está, el campo se edita como dropdown desde ese catálogo (p.ej. "oficina")
};
export type Rel = { key: string; label: string; mode: "nm" | "ro" | "child"; target: string };
export type Model = { name: string; label: string; pks: string[]; labelFields: string[]; fields: Field[]; relations: Rel[] };
export type Opt = { value: any; label: string };

// Explorador "Ecosistema de Datos ONP" (live). Los campos de lista llegan como texto con '§'.
export type BitacoraRow = {
  fecha: string; artefacto: string; obs_codigo: string; tipo_cambio: string;
  objeto: string; descripcion: string; fuente: string | null; estado: string | null;
};
export type EcoData = {
  kpis: { bd: number; apps: number; dominios: number; procesos: number; entidades: number; relaciones: number; integraciones: number };
  sistemas: { cod: string; nombre: string; estado: string | null; criticidad: string | null; bases: string | null; doms: string | null; procs: string | null; ents: string | null; areas: string | null; gestor: string | null; respf: string | null; uso: string | null; descripcion: string | null }[];
  dominios: { nombre: string; tipo: string | null; nproc: number; procs: string | null; apps: string | null; bases: string | null }[];
  procesos: { proceso: string; dominio: string; tipo: string | null; apps: string | null; bases: string | null; ents: string | null }[];
  entidades: { nombre: string; dominio: string; nucleo: boolean; descripcion: string | null; nf: number; bases: string | null }[];
  relaciones: { origen: string; destino: string; cardinalidad: string | null; descripcion: string | null }[];
  siip: { dominio: string; nent: number; ents: string | null; nf: number; bases: string | null }[];
  brechas: {
    bases_sin_dominio: { nombre: string; emc: boolean }[];
    etl: { orig: number; dest: number };
    bases_baja: { nombre: string; estado: string | null; n_apps: number; n_integ: number }[];
  };
};

let KEY = localStorage.getItem("adminkey") || "";
export const setKey = (k: string) => { KEY = k; localStorage.setItem("adminkey", k); };

function stamp() {
  const d = new Date(), p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}
async function downloadXlsx(url: string, baseName: string) {
  // ?t= busca-caché (además del no-store del server); el archivo se baja con sufijo de fecha-hora.
  const r = await fetch(url + (url.includes("?") ? "&" : "?") + "t=" + Date.now(), { headers: { "x-admin-key": KEY } });
  if (r.status === 401) { const e: any = new Error("No autorizado"); e.auth = true; throw e; }
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
  const blob = await r.blob();
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = baseName.replace(/\.xlsx$/i, `_${stamp()}.xlsx`);
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
async function req(url: string, opts: RequestInit = {}) {
  const r = await fetch(url, { ...opts, headers: { "Content-Type": "application/json", "x-admin-key": KEY, ...(opts.headers || {}) } });
  const d = await r.json().catch(() => ({}));
  if (r.status === 401) { const e: any = new Error("No autorizado"); e.auth = true; throw e; }
  if (!r.ok) throw new Error(d.error || r.statusText);
  return d;
}
export const api = {
  meta: (): Promise<Model[]> => req("/api/meta"),
  pendientes: (): Promise<{ bd_sin_app: any[]; apps_sin_proceso: any[] }> => req("/api/pendientes"),
  one: (m: string, id: any): Promise<any> => req(`/api/${m}/${id}`),
  list: (m: string, q = "", skip = 0, take = 50, sort?: { field: string; dir: "asc" | "desc" } | null): Promise<{ rows: any[]; total: number }> =>
    req(`/api/${m}?q=${encodeURIComponent(q)}&skip=${skip}&take=${take}${sort ? `&sort=${sort.field}&dir=${sort.dir}` : ""}`),
  options: (m: string): Promise<Opt[]> => req(`/api/${m}/options`),
  oficinas: (): Promise<Opt[]> => req("/api/oficinas"),
  artefacto: (id: string): Promise<{ id: string; titulo: string; columns: string[]; rows: string[][]; links: Record<string, string> }> => req(`/api/artefacto/${encodeURIComponent(id)}`),
  ecosistema: (): Promise<EcoData> => req("/api/ecosistema"),
  bitacora: (): Promise<BitacoraRow[]> => req("/api/bitacora"),
  columnasDesc: (): Promise<Record<string, Record<string, string>>> => req("/api/columnas_desc"),
  // Descarga EN VIVO del Excel (genera el workbook al vuelo desde PG). Envía la clave por header.
  xlsx: (url: string, filename: string) => downloadXlsx(url, filename),
  create: (m: string, body: any) => req(`/api/${m}`, { method: "POST", body: JSON.stringify(body) }),
  update: (m: string, id: any, body: any) => req(`/api/${m}/${id}`, { method: "PUT", body: JSON.stringify(body) }),
  remove: (m: string, id: any) => req(`/api/${m}/${id}`, { method: "DELETE" }),
  relList: (parent: string, id: any, key: string): Promise<any[]> => req(`/api/${parent}/${id}/${key}`),
  relAdd: (parent: string, id: any, key: string, body: any) => req(`/api/${parent}/${id}/${key}`, { method: "POST", body: JSON.stringify(body) }),
  relDel: (parent: string, id: any, key: string, childId: any) => req(`/api/${parent}/${id}/${key}/${childId}`, { method: "DELETE" }),
  relUpd: (parent: string, id: any, key: string, childId: any, body: any) => req(`/api/${parent}/${id}/${key}/${childId}`, { method: "PUT", body: JSON.stringify(body) }),
  // Cascada de alcance al sacar una app del modelo conceptual
  bdCascadaPreview: (idApp: any): Promise<{ id_bd: number; nombre_bd: string; compartida: boolean; otras_apps: string[] }[]> => req(`/api/aplicacion/${idApp}/bd-cascada`),
  bdCascadaApply: (idApp: any, ids: number[]): Promise<{ updated: number }> => req(`/api/aplicacion/${idApp}/bd-cascada`, { method: "POST", body: JSON.stringify({ ids }) }),
  esqAdd: (idApp: any, idBd: any, nombre_esquema: string) => req(`/api/aplicacion/${idApp}/basedatos/${idBd}/esquemas`, { method: "POST", body: JSON.stringify({ nombre_esquema }) }),
  esqDel: (idApp: any, idBd: any, idEsq: any) => req(`/api/aplicacion/${idApp}/basedatos/${idBd}/esquemas/${idEsq}`, { method: "DELETE" }),
  // Estructura física / DDL
  estructuraBd: (): Promise<Record<string, number>> => req("/api/estructura_bd"),
  bdEstructura: (idBd: any): Promise<{ nombre_bd: string | null; esquemas: { id_esquema: number; nombre_esquema: string; tipo: string | null; n_tablas: number }[] }> => req(`/api/base_de_datos/${idBd}/estructura`),
  esquemaTablas: (idEsq: any, q = ""): Promise<{ id_tabla: number; nombre_tabla: string; n_cols: number }[]> => req(`/api/esquema/${idEsq}/tablas?q=${encodeURIComponent(q)}`),
  tablaColumnas: (idTab: any): Promise<{ col_id: number | null; nombre_columna: string; tipo: string | null; longitud: string | null; nullable: string | null; es_pk: string | null; comentario: string | null }[]> => req(`/api/tabla/${idTab}/columnas`),
};
