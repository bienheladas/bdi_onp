export type Field = {
  name: string; type: string; isPk: boolean; hasDefault: boolean; required: boolean; auto?: boolean;
  fk: { model: string; toField: string; label: string[] } | null;
};
export type Rel = { key: string; label: string; mode: "nm" | "ro" | "child"; target: string };
export type Model = { name: string; label: string; pks: string[]; labelFields: string[]; fields: Field[]; relations: Rel[] };
export type Opt = { value: any; label: string };

let KEY = localStorage.getItem("adminkey") || "";
export const setKey = (k: string) => { KEY = k; localStorage.setItem("adminkey", k); };

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
  list: (m: string, q = "", skip = 0, take = 50): Promise<{ rows: any[]; total: number }> =>
    req(`/api/${m}?q=${encodeURIComponent(q)}&skip=${skip}&take=${take}`),
  options: (m: string): Promise<Opt[]> => req(`/api/${m}/options`),
  create: (m: string, body: any) => req(`/api/${m}`, { method: "POST", body: JSON.stringify(body) }),
  update: (m: string, id: any, body: any) => req(`/api/${m}/${id}`, { method: "PUT", body: JSON.stringify(body) }),
  remove: (m: string, id: any) => req(`/api/${m}/${id}`, { method: "DELETE" }),
  relList: (parent: string, id: any, key: string): Promise<any[]> => req(`/api/${parent}/${id}/${key}`),
  relAdd: (parent: string, id: any, key: string, body: any) => req(`/api/${parent}/${id}/${key}`, { method: "POST", body: JSON.stringify(body) }),
  relDel: (parent: string, id: any, key: string, childId: any) => req(`/api/${parent}/${id}/${key}/${childId}`, { method: "DELETE" }),
  relUpd: (parent: string, id: any, key: string, childId: any, body: any) => req(`/api/${parent}/${id}/${key}/${childId}`, { method: "PUT", body: JSON.stringify(body) }),
};
