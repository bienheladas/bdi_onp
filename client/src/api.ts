export type Field = {
  name: string; type: string; isPk: boolean; hasDefault: boolean; required: boolean; auto?: boolean;
  fk: { model: string; toField: string; label: string[] } | null;
  catalog?: string | null;   // si está, el campo se edita como dropdown desde ese catálogo (p.ej. "oficina")
};
export type Rel = { key: string; label: string; mode: "nm" | "ro" | "child"; target: string };
export type Model = { name: string; label: string; pks: string[]; labelFields: string[]; fields: Field[]; relations: Rel[] };
export type Opt = { value: any; label: string };

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
  esqAdd: (idApp: any, idBd: any, nombre_esquema: string) => req(`/api/aplicacion/${idApp}/basedatos/${idBd}/esquemas`, { method: "POST", body: JSON.stringify({ nombre_esquema }) }),
  esqDel: (idApp: any, idBd: any, idEsq: any) => req(`/api/aplicacion/${idApp}/basedatos/${idBd}/esquemas/${idEsq}`, { method: "DELETE" }),
};
