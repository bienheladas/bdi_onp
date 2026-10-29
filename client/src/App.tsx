import { useEffect, useMemo, useState, type ReactNode } from "react";
import { api, setKey, Model, Field, Opt, Rel } from "./api";

const CAT = ["ambiente", "motor_bd", "tipo_proceso", "dominio_funcional", "proceso_negocio", "oficina"];
const ENT = ["servidor", "base_de_datos", "aplicacion"];
const PAGE = 50;
// Orden inicial de las vistas principales (el resto, por su PK); clic en un encabezado lo cambia
const DEFAULT_SORT: Record<string, string> = { base_de_datos: "nombre_bd", servidor: "nombre_servidor", aplicacion: "id_app" };
type Sort = { field: string; dir: "asc" | "desc" } | null;
// Vistas con la columna "acciones" a la izquierda (primera columna); el resto la tiene al final
const ACTS_LEFT = new Set(["base_de_datos", "aplicacion", "servidor"]);

export default function App() {
  const [models, setModels] = useState<Model[]>([]);
  const [cur, setCur] = useState<string>("base_de_datos");
  const [opts, setOpts] = useState<Record<string, Opt[]>>({});
  const [gate, setGate] = useState<"loading" | "ok" | "login">("loading");
  const [pending, setPending] = useState<{ model: string; id: any } | null>(null);
  const model = useMemo(() => models.find((m) => m.name === cur), [models, cur]);

  const loadMeta = () => api.meta().then((m) => { setModels(m); setGate("ok"); }).catch((e: any) => setGate(e.auth ? "login" : "ok"));
  useEffect(() => { loadMeta(); }, []);
  // carga opciones de los modelos FK del modelo actual
  useEffect(() => {
    if (!model) return;
    const need = new Set<string>();
    model.fields.forEach((f) => f.fk && need.add(f.fk.model));
    need.forEach((mn) => { if (!opts[mn]) api.options(mn).then((o) => setOpts((p) => ({ ...p, [mn]: o }))); });
    // catálogos de texto (p.ej. oficina) => endpoint dedicado
    if (model.fields.some((f) => f.catalog === "oficina") && !opts["oficina"])
      api.oficinas().then((o) => setOpts((p) => ({ ...p, oficina: o })));
  }, [model]);

  const ensureOpts = (mn: string) => { if (!opts[mn]) api.options(mn).then((o) => setOpts((p) => ({ ...p, [mn]: o }))); };
  const go = (m: string, id: any) => { setCur(m); setPending({ model: m, id }); };

  if (gate === "loading") return <p style={{ padding: 24 }}>Cargando…</p>;
  if (gate === "login") return <Login onOk={loadMeta} />;

  return (
    <div className="app">
      <nav className="side">
        <h1>BDI ONP · Modelo</h1>
        <div className="grp">Tablero</div>
        <a className={cur === "__pend__" ? "active" : ""} onClick={() => setCur("__pend__")}>⚠ Pendientes</a>
        <div className="grp">Catálogos</div>
        {CAT.map((n) => models.find((m) => m.name === n) && (
          <a key={n} className={cur === n ? "active" : ""} onClick={() => setCur(n)}>{n}</a>
        ))}
        <div className="grp">Entidades</div>
        {ENT.map((n) => models.find((m) => m.name === n) && (
          <a key={n} className={cur === n ? "active" : ""} onClick={() => setCur(n)}>{n}</a>
        ))}
        <div className="grp">Reportería</div>
        <a className={cur === "__flujo__" ? "active" : ""} onClick={() => setCur("__flujo__")}>🗺 Mapa de flujo</a>
        <a className={cur === "__artefactos__" ? "active" : ""} onClick={() => setCur("__artefactos__")}>📦 Artefactos</a>
      </nav>
      <main className="main">
        {cur === "__pend__"
          ? <Pendientes models={models} opts={opts} ensureOpts={ensureOpts} go={go} />
          : cur === "__flujo__" ? <Flujo />
          : cur === "__artefactos__" ? <Artefactos />
          : model ? <Grid key={model.name} model={model} models={models} opts={opts} ensureOpts={ensureOpts} go={go} pending={pending} clearPending={() => setPending(null)} /> : <p>Cargando…</p>}
      </main>
    </div>
  );
}

function Flujo() {
  return (
    <>
      <div className="toolbar">
        <h2>Mapa de flujo de datos</h2>
        <a className="btn" href="/flujo_datos_onp.html" target="_blank" rel="noreferrer">Abrir en pestaña nueva ↗</a>
      </div>
      <iframe src="/flujo_datos_onp.html" title="Mapa de flujo de datos ONP"
        style={{ width: "100%", height: "calc(100vh - 150px)", border: "1px solid #334", borderRadius: 8, background: "#1b1f27" }} />
    </>
  );
}

type ArtMeta = { id: string; titulo: string; generador: string; archivo?: string; fuente?: string };
type ArtData = { id: string; titulo: string; columns: string[]; rows: string[][]; links: Record<string, string> };
// ADI-01 se arma EN VIVO desde la tabla fuentes_institucionales (22 oficiales + nuevas LCP),
// no de un Excel en duro. El resto de artefactos sí vienen de su <ID>.json.
const FCOLS: [string, string][] = [
  ["id_fuente", "N°"], ["fuente_documental", "Fuente documental revisada"], ["descripcion_proposito", "Descripción / propósito"],
  ["resumen", "Resumen / análisis del contenido"],
  ["area_responsable", "Área responsable"], ["fecha_version_estado", "Fecha de la fuente"],
  ["tipo_fuente", "Tipo de fuente"], ["formato_medio", "Formato / medio"], ["nivel_confidencialidad", "Confidencialidad"],
  ["relacion_sistemas_procesos", "Relación con sistemas / procesos"], ["hallazgos", "Hallazgos"],
  ["vacios_inconsistencias", "Vacíos / inconsistencias"],
  ["evidencia_revision", "Evidencia (archivo/patrón)"], ["enlace", "Enlace"],
];
async function loadFuentes(): Promise<ArtData> {
  const d = await api.list("fuentes_institucionales", "", 0, 500, null);
  const columns = FCOLS.map((c) => c[1]);
  const enlaceIdx = FCOLS.findIndex((c) => c[0] === "enlace");
  const rows: string[][] = [];
  const links: Record<string, string> = {};
  d.rows.forEach((r: any, ri: number) => {
    rows.push(FCOLS.map(([f]) => (r[f] == null ? "" : String(r[f]))));
    if (r.enlace) links[`${ri}_${enlaceIdx}`] = r.enlace;
  });
  return { id: "ADI-01", titulo: "Fuentes de Información (ADI-01 consolidado + nuevas LCP)", columns, rows, links };
}
function Artefactos() {
  const [meta, setMeta] = useState<ArtMeta[]>([]);
  const [sel, setSel] = useState<string>("");
  const [data, setData] = useState<ArtData | null>(null);
  const [q, setQ] = useState("");
  const [desc, setDesc] = useState<Record<string, Record<string, string>>>({});
  useEffect(() => {
    fetch("/artefactos/manifest.json").then((r) => r.json()).then((m: ArtMeta[]) => { setMeta(m); if (m[0]) setSel(m[0].id); });
    api.columnasDesc().then(setDesc).catch(() => setDesc({}));
  }, []);
  useEffect(() => {
    if (!sel || meta.length === 0) return;
    setData(null);
    const m0 = meta.find((m) => m.id === sel);
    const p = m0?.fuente === "tabla" ? loadFuentes()
      : m0?.fuente === "live" ? api.artefacto(sel)
      : fetch(`/artefactos/${sel}.json`).then((r) => r.json());
    p.then(setData).catch(() => setData(null));
  }, [sel, meta]);
  const cur = meta.find((m) => m.id === sel);
  const rows = useMemo(() => {
    if (!data) return [] as { i: number; r: string[] }[];
    const all = data.rows.map((r, i) => ({ i, r }));
    if (!q.trim()) return all;
    const s = q.toLowerCase();
    return all.filter(({ r }) => r.some((c) => c.toLowerCase().includes(s)));
  }, [data, q]);
  return (
    <>
      <div className="toolbar">
        <h2>Artefactos</h2>
        <select className="search" value={sel} onChange={(e) => setSel(e.target.value)} style={{ maxWidth: 440 }}>
          {meta.map((m) => <option key={m.id} value={m.id}>{m.id} · {m.titulo}</option>)}
        </select>
        <input className="search" placeholder="Buscar…" value={q} onChange={(e) => setQ(e.target.value)} />
        {sel === "ADI-05" && <a className="btn sec" href="/flujo_datos_onp.html" target="_blank" rel="noreferrer">🗺 Mapa de flujo ↗</a>}
        {cur && cur.archivo && <a className="btn sec" href={`/artefactos/${cur.archivo}`} download>⬇ Este (.xlsx)</a>}
        <a className="btn" href="/artefactos/artefactos.zip" download>⬇ Descargar todos</a>
      </div>
      {cur && <p className="muted" style={{ margin: "0 0 10px" }}>Generador: <code>{cur.generador}</code> · <span className="pill">{rows.length}</span> filas</p>}
      {!data ? <p className="muted">Cargando…</p> : (
        <div className="tablewrap">
          <table>
            <thead><tr>{data.columns.map((c, i) => {
              const d = desc[sel]?.[c];
              return <th key={i} title={d ? `${c} — ${d}` : c}>{c}{d ? <span className="hdrinfo"> ⓘ</span> : null}</th>;
            })}</tr></thead>
            <tbody>
              {rows.map(({ i, r }) => <tr key={i}>{r.map((c, ci) => {
                const link = data.links[`${i}_${ci}`];
                return <td key={ci} title={c}>{link ? <a className="lnk" href={link} target="_blank" rel="noreferrer">{c || "🔗 abrir"}</a> : c}</td>;
              })}</tr>)}
              {rows.length === 0 && <tr><td colSpan={data.columns.length || 1} className="muted">Sin resultados.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function fkLabel(opts: Record<string, Opt[]>, f: Field, val: any) {
  if (val == null) return "";
  const o = opts[f.fk!.model]?.find((x) => x.value === val);
  return o ? o.label : String(val);
}
const cell = (opts: any, f: Field, v: any) => {
  if (v == null) return "";
  if (f.fk) return fkLabel(opts, f, v);
  if (f.type === "Json") return Array.isArray(v) ? v.join(", ") : JSON.stringify(v);
  return String(v);
};

const ICO: Record<string, any> = {
  edit: <><path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z" /></>,
  del: <><path d="M3 6h18" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /><path d="M10 11v6M14 11v6" /></>,
  db: <><ellipse cx="12" cy="5" rx="9" ry="3" /><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" /><path d="M3 12c0 1.66 4 3 9 3s9-1.34 9-3" /></>,
  proc: <><circle cx="18" cy="5" r="3" /><circle cx="6" cy="12" r="3" /><circle cx="18" cy="19" r="3" /><path d="M8.6 13.5l6.8 4M15.4 6.5l-6.8 4" /></>,
  app: <><path d="M3 3h7v7H3zM14 3h7v7h-7zM14 14h7v7h-7zM3 14h7v7H3z" /></>,
  link: <><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7" /><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7" /></>,
  org: <><path d="M3 21h18M6 21V5a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v16" /><path d="M9 8h2M13 8h2M9 12h2M13 12h2M9 16h2M13 16h2" /></>,
};
const relIco: Record<string, string> = { basedatos: "db", procesos: "proc", aplicaciones: "app", integraciones: "link", areas: "org" };
const Ico = ({ n }: { n: string }) => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">{ICO[n]}</svg>
);

function Grid({ model, models, opts, ensureOpts, go, pending, clearPending }: { model: Model; models: Model[]; opts: Record<string, Opt[]>; ensureOpts: (m: string) => void; go: (m: string, id: any) => void; pending: { model: string; id: any } | null; clearPending: () => void }) {
  const [rows, setRows] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [q, setQ] = useState("");
  const [page, setPage] = useState(0);
  const [edit, setEdit] = useState<any | null>(null);  // registro en edición (o {} nuevo)
  const [rel, setRel] = useState<{ rel: Rel; row: any } | null>(null);
  const [sort, setSort] = useState<Sort>(DEFAULT_SORT[model.name] ? { field: DEFAULT_SORT[model.name], dir: "asc" } : null);
  const pk = model.pks[0];
  const cols = model.fields.filter((f) => f.type !== "Json" || true); // mostrar todas
  const actsLeft = ACTS_LEFT.has(model.name);
  const actsCell = (r: any) => (
    <td key="__acts"><div className="acts">
      <button className="btn xs sec ico" title="Editar" onClick={() => setEdit(r)}><Ico n="edit" /></button>
      <button className="btn xs danger ico" title="Eliminar" onClick={async () => { if (confirm("¿Eliminar registro?")) { try { await api.remove(model.name, r[pk]); load(); } catch (e: any) { alert(e.message); } } }}><Ico n="del" /></button>
      {model.relations.map((rl) => <button key={rl.key} className="btn xs ico" title={rl.label} onClick={() => { ensureOpts(rl.target); setRel({ rel: rl, row: r }); }}><Ico n={relIco[rl.key] || "link"} /></button>)}
    </div></td>
  );

  const load = () => api.list(model.name, q, page * PAGE, PAGE, sort).then((d) => { setRows(d.rows); setTotal(d.total); });
  useEffect(() => { load(); }, [model.name, page, sort]);
  // clic en encabezado: asc -> desc -> asc ...; columna nueva empieza en asc y vuelve a la página 1
  const toggleSort = (f: Field) => {
    if (f.type === "Json") return;
    setSort((s) => (s?.field === f.name ? { field: f.name, dir: s.dir === "asc" ? "desc" : "asc" } : { field: f.name, dir: "asc" }));
    setPage(0);
  };
  useEffect(() => { const t = setTimeout(() => { setPage(0); load(); }, 300); return () => clearTimeout(t); }, [q]);
  // navegación: si venimos de otro registro, abre el formulario de este
  useEffect(() => {
    if (pending && pending.model === model.name) {
      api.one(model.name, pending.id).then((r) => setEdit(r)).catch(() => {}).finally(clearPending);
    }
  }, []);

  return (
    <>
      <div className="toolbar">
        <h2>{model.name} <span className="pill">{total}</span></h2>
        <input className="search" placeholder="Buscar…" value={q} onChange={(e) => setQ(e.target.value)} />
        <button className="btn" onClick={() => setEdit({})}>+ Nuevo</button>
      </div>
      <div className="tablewrap">
        <table>
          <thead><tr>
            {actsLeft && <th>acciones</th>}
            {cols.map((f) => (
              <th key={f.name} className={f.type === "Json" ? "" : "sortable"} title={f.type === "Json" ? "" : "Ordenar por esta columna"} onClick={() => toggleSort(f)}>
                {f.name}{sort?.field === f.name && <span className="sort-ind">{sort.dir === "asc" ? " ▲" : " ▼"}</span>}
              </th>
            ))}
            {!actsLeft && <th>acciones</th>}
          </tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r[pk]}>
                {actsLeft && actsCell(r)}
                {cols.map((f) => {
                  const txt = cell(opts, f, r[f.name]);
                  return <td key={f.name} title={txt}>{f.fk && r[f.name] != null ? <a className="lnk" onClick={() => go(f.fk!.model, r[f.name])}>{txt}</a> : txt}</td>;
                })}
                {!actsLeft && actsCell(r)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="pager">
        <button className="btn sec" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>◀</button>
        <span className="muted">Página {page + 1} de {Math.max(1, Math.ceil(total / PAGE))}</span>
        <button className="btn sec" disabled={(page + 1) * PAGE >= total} onClick={() => setPage((p) => p + 1)}>▶</button>
      </div>

      {edit && <RecordForm model={model} opts={opts} rec={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); load(); }} />}
      {rel && <RelationModal parent={model} models={models} opts={opts} ensureOpts={ensureOpts} go={go} rel={rel.rel} row={rel.row} onClose={() => setRel(null)} />}
    </>
  );
}

function Login({ onOk }: { onOk: () => void }) {
  const [pw, setPw] = useState("");
  const [err, setErr] = useState("");
  const submit = async () => { setKey(pw); try { await api.meta(); onOk(); } catch (e: any) { setErr(e.auth ? "Clave incorrecta" : e.message); } };
  return (
    <div className="overlay" style={{ alignItems: "center" }}>
      <div className="modal" style={{ width: 360 }}>
        <h3>BDI ONP · Acceso</h3>
        {err && <div className="err">{err}</div>}
        <div className="body">
          <div className="frow"><label>Clave de acceso</label>
            <input type="password" value={pw} autoFocus onChange={(e) => setPw(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()} /></div>
        </div>
        <div className="foot"><button className="btn" onClick={submit}>Entrar</button></div>
      </div>
    </div>
  );
}

function Pendientes({ models, opts, ensureOpts, go }: { models: Model[]; opts: Record<string, Opt[]>; ensureOpts: (m: string) => void; go: (m: string, id: any) => void }) {
  const [data, setData] = useState<{ bd_sin_app: any[]; apps_sin_proceso: any[] }>({ bd_sin_app: [], apps_sin_proceso: [] });
  const [rel, setRel] = useState<any | null>(null);
  const load = () => api.pendientes().then((d) => setData({ bd_sin_app: d.bd_sin_app ?? [], apps_sin_proceso: d.apps_sin_proceso ?? [] })).catch(() => {});
  useEffect(() => { load(); }, []);
  const bdModel = models.find((m) => m.name === "base_de_datos")!;
  const appModel = models.find((m) => m.name === "aplicacion")!;
  const bdRel = bdModel?.relations.find((r) => r.key === "aplicaciones");
  const procRel = appModel?.relations.find((r) => r.key === "procesos");
  return (
    <>
      <div className="toolbar"><h2>Pendientes por completar</h2></div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>
        <div className="tablewrap">
          <table><thead><tr><th>BD sin aplicación ({data.bd_sin_app.length})</th><th></th></tr></thead>
            <tbody>
              {data.bd_sin_app.map((b) => (
                <tr key={b.id_bd}><td><a className="lnk" onClick={() => go("base_de_datos", b.id_bd)}>{b.nombre_bd}</a></td>
                  <td><button className="btn xs" onClick={() => { ensureOpts("aplicacion"); setRel({ parent: bdModel, rel: bdRel, row: { id_bd: b.id_bd, nombre_bd: b.nombre_bd } }); }}>Asociar app</button></td></tr>
              ))}
              {data.bd_sin_app.length === 0 && <tr><td colSpan={2} className="muted">Nada pendiente 🎉</td></tr>}
            </tbody></table>
        </div>
        <div className="tablewrap">
          <table><thead><tr><th>App con BD pero sin proceso ({data.apps_sin_proceso.length})</th><th></th></tr></thead>
            <tbody>
              {data.apps_sin_proceso.map((a) => (
                <tr key={a.id}><td><a className="lnk" onClick={() => go("aplicacion", a.id)}>{a.id_app} · {a.nombre_app}</a></td>
                  <td><button className="btn xs" onClick={() => { ensureOpts("proceso_negocio"); setRel({ parent: appModel, rel: procRel, row: { id: a.id, id_app: a.id_app, nombre_app: a.nombre_app } }); }}>Agregar proceso</button></td></tr>
              ))}
              {data.apps_sin_proceso.length === 0 && <tr><td colSpan={2} className="muted">Nada pendiente 🎉</td></tr>}
            </tbody></table>
        </div>
      </div>
      {rel && <RelationModal parent={rel.parent} models={models} opts={opts} ensureOpts={ensureOpts} go={go} rel={rel.rel} row={rel.row} onClose={() => { setRel(null); load(); }} />}
    </>
  );
}

function RecordForm({ model, opts, rec, onClose, onSaved }: { model: Model; opts: Record<string, Opt[]>; rec: any; onClose: () => void; onSaved: () => void }) {
  const isNew = !rec[model.pks[0]] && model.pks.every((k) => rec[k] === undefined);
  const init: any = {};
  model.fields.forEach((f) => { init[f.name] = rec[f.name] == null ? "" : (f.type === "Json" ? JSON.stringify(rec[f.name]) : f.type === "DateTime" ? String(rec[f.name]).slice(0, 10) : rec[f.name]); });
  const [form, setForm] = useState<any>(init);
  const [err, setErr] = useState("");

  const editable = model.fields.filter((f) => !(f.isPk && f.hasDefault) && !f.auto);  // oculta PK identity y auditoría
  const set = (n: string, v: any) => setForm((p: any) => ({ ...p, [n]: v }));

  const save = async () => {
    try {
      const body: any = {};
      for (const f of editable) {
        if (!isNew && f.isPk) continue;                // no cambiar PK en edición
        let v = form[f.name];
        if (v === "" || v == null) { body[f.name] = null; continue; }
        if (f.type === "Json") { try { body[f.name] = JSON.parse(v); } catch { throw new Error(`JSON inválido en ${f.name}`); } }
        else if (f.type === "DateTime") body[f.name] = v.length === 10 ? v + "T00:00:00.000Z" : v;
        else body[f.name] = v;
      }
      if (isNew) await api.create(model.name, body);
      else await api.update(model.name, rec[model.pks[0]] ?? model.pks.map((k) => rec[k]).join("/"), body);
      onSaved();
    } catch (e: any) { setErr(e.message); }
  };

  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>{isNew ? "Nuevo" : "Editar"} · {model.name}</h3>
        {err && <div className="err">{err}</div>}
        <div className="body">
          {editable.map((f) => (
            <div className="frow" key={f.name}>
              <label>{f.name}{f.required && <span className="req"> *</span>}{f.fk && <span className="muted"> (→{f.fk.model})</span>}</label>
              <FieldInput f={f} opts={opts} value={form[f.name]} disabled={!isNew && f.isPk} onChange={(v) => set(f.name, v)} />
            </div>
          ))}
        </div>
        <div className="foot">
          <button className="btn sec" onClick={onClose}>Cancelar</button>
          <button className="btn" onClick={save}>Guardar</button>
        </div>
      </div>
    </div>
  );
}

function FieldInput({ f, opts, value, disabled, onChange }: { f: Field; opts: Record<string, Opt[]>; value: any; disabled?: boolean; onChange: (v: any) => void }) {
  if (f.fk) {
    const o = opts[f.fk.model] || [];
    return (
      <select value={value ?? ""} disabled={disabled} onChange={(e) => onChange(e.target.value === "" ? "" : Number(e.target.value))}>
        <option value="">— (ninguno)</option>
        {o.map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}
      </select>
    );
  }
  if (f.catalog) {
    const o = opts[f.catalog] || [];
    return (
      <select value={value ?? ""} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
        <option value="">— (ninguno)</option>
        {o.map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}
      </select>
    );
  }
  if (f.type === "Json") return <textarea rows={2} placeholder='["valor1","valor2"]' value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} />;
  if (f.type === "DateTime") return <input type="date" value={value || ""} disabled={disabled} onChange={(e) => onChange(e.target.value)} />;
  if (f.type === "Int" || f.type === "Decimal") return <input type="number" step={f.type === "Decimal" ? "any" : "1"} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} />;
  if (/^(desc_|observ|coment)/.test(f.name)) return <textarea rows={2} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} />;
  return <input type="text" value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} />;
}

// Vínculo app–BD con sus esquemas (tabla esquema): agregar/quitar esquemas y quitar el vínculo
function PairCard({ it, title, onUnlink, onChange, setErr }: { it: any; title: ReactNode; onUnlink: () => void; onChange: () => void; setErr: (m: string) => void }) {
  const [nombre, setNombre] = useState("");
  const add = async () => {
    if (!nombre.trim()) return;
    try { await api.esqAdd(it.id_aplicacion, it.id_bd, nombre); setNombre(""); setErr(""); onChange(); } catch (e: any) { setErr(e.message); }
  };
  const del = async (e: any) => {
    if (!confirm(`¿Quitar el esquema ${e.nombre_esquema}?`)) return;
    try { await api.esqDel(it.id_aplicacion, it.id_bd, e.id_esquema); setErr(""); onChange(); } catch (x: any) { setErr(x.message); }
  };
  return (
    <div className="card">
      <div className="card-h"><b>{title}</b><button className="btn xs danger" onClick={onUnlink}>quitar vínculo</button></div>
      <div className="chips">
        <span className="muted">Esquemas:</span>
        {it.esquemas.map((e: any) => <span className="chip" key={e.id_esquema}>{e.nombre_esquema}<button onClick={() => del(e)}>×</button></span>)}
        {it.esquemas.length === 0 && <span className="muted">(sin esquemas)</span>}
      </div>
      <div className="card-add">
        <input placeholder="nombre del esquema" value={nombre} onChange={(e) => setNombre(e.target.value)} onKeyDown={(e) => e.key === "Enter" && add()} />
        <button className="btn xs" onClick={add}>+ Agregar esquema</button>
      </div>
    </div>
  );
}

function RelationModal({ parent, models, opts, ensureOpts, go, rel, row, onClose }: any) {
  const pid = row[parent.pks[0]];
  const target: Model = models.find((m: Model) => m.name === rel.target);
  const tgtPk = target?.pks[0];
  const tgtLabel = target?.labelFields[0];
  const [items, setItems] = useState<any[]>([]);
  const [sel, setSel] = useState("");
  const [err, setErr] = useState("");
  const [intg, setIntg] = useState<any>({ id_bd_destino: "", destino_externo: "", mecanismo: "", nombre_enlace: "", estado_enlace: "" });

  const reload = () => api.relList(parent.name, pid, rel.key).then(setItems).catch((e) => setErr(e.message));
  useEffect(() => { reload(); if (rel.mode !== "child") ensureOpts(rel.target); else ensureOpts("base_de_datos"); }, []);

  const addNM = async () => { if (!sel) return; try { await api.relAdd(parent.name, pid, rel.key, { [tgtPk]: sel }); setSel(""); reload(); } catch (e: any) { setErr(e.message); } };
  const delNM = async (cid: any) => { try { await api.relDel(parent.name, pid, rel.key, cid); reload(); } catch (e: any) { setErr(e.message); } };
  const addIntg = async () => {
    try { await api.relAdd(parent.name, pid, rel.key, { ...intg, id_bd_destino: intg.id_bd_destino || null }); setIntg({ id_bd_destino: "", destino_externo: "", mecanismo: "", nombre_enlace: "", estado_enlace: "" }); reload(); }
    catch (e: any) { setErr(e.message); }
  };

  const title = `${rel.label} · ${parent.name} ${parent.labelFields.map((f: string) => row[f]).filter(Boolean).join(" ")}`;
  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <h3>{title}</h3>
        {err && <div className="err">{err}</div>}
        <div className="body">
          {rel.mode === "nm" && (
            <>
              <div className="toolbar" style={{ marginBottom: 10 }}>
                <select style={{ flex: 1 }} value={sel} onChange={(e) => setSel(e.target.value)}>
                  <option value="">— elegir {rel.target} para asociar —</option>
                  {(opts[rel.target] || []).map((o: Opt) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
                <button className="btn" onClick={addNM}>Asociar</button>
              </div>
              {/* app–BD: cada vínculo es una tarjeta con sus esquemas; otras N:M van como chips */}
              {items.some((it) => it.esquemas) ? (
                <>
                  {items.map((it) => (
                    <PairCard key={it[tgtPk]} it={it} title={<><a className="lnk" onClick={() => go(rel.target, it[tgtPk])}>{it[tgtLabel] ?? it[tgtPk]}</a>{it.nombre_app && <span className="muted"> · {it.nombre_app}</span>}</>}
                      onUnlink={() => delNM(it[tgtPk])} onChange={reload} setErr={setErr} />
                  ))}
                </>
              ) : (
                <div className="chips">
                  {items.map((it) => <span className="chip" key={it[tgtPk]}><a className="lnk" onClick={() => go(rel.target, it[tgtPk])}>{it[tgtLabel] ?? it[tgtPk]}</a><button onClick={() => delNM(it[tgtPk])}>×</button></span>)}
                </div>
              )}
              {items.length === 0 && <span className="muted">Sin asociaciones.</span>}
            </>
          )}
          {rel.mode === "ro" && (
            <div className="tablewrap"><table><thead><tr><th>id_app</th><th>nombre_app</th></tr></thead>
              <tbody>{items.map((it) => <tr key={it.id}><td>{it.id_app}</td><td>{it.nombre_app}</td></tr>)}
                {items.length === 0 && <tr><td colSpan={2} className="muted">Ninguna.</td></tr>}</tbody></table></div>
          )}
          {rel.mode === "child" && (
            <>
              <div className="tablewrap" style={{ marginBottom: 12 }}><table>
                <thead><tr><th>destino</th><th>mecanismo</th><th>enlace</th><th>estado</th><th></th></tr></thead>
                <tbody>{items.map((it) => (
                  <tr key={it.id_integracion}>
                    <td>{it.id_bd_destino ? <a className="lnk" onClick={() => go("base_de_datos", it.id_bd_destino)}>{it.destino}</a> : it.destino}</td><td>{it.mecanismo}</td><td>{it.nombre_enlace}</td><td>{it.estado_enlace}</td>
                    <td><button className="btn xs danger" onClick={async () => { try { await api.relDel(parent.name, pid, rel.key, it.id_integracion); reload(); } catch (e: any) { setErr(e.message); } }}>borrar</button></td>
                  </tr>))}
                  {items.length === 0 && <tr><td colSpan={5} className="muted">Sin integraciones.</td></tr>}</tbody></table></div>
              <div className="frow"><label>Agregar integración</label></div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                <select value={intg.id_bd_destino} onChange={(e) => setIntg({ ...intg, id_bd_destino: e.target.value })}>
                  <option value="">— BD destino (interna) —</option>
                  {(opts["base_de_datos"] || []).map((o: Opt) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
                <input placeholder="destino externo (si no es BD interna)" value={intg.destino_externo} onChange={(e) => setIntg({ ...intg, destino_externo: e.target.value })} />
                <input placeholder="mecanismo (p.ej. DB Link)" value={intg.mecanismo} onChange={(e) => setIntg({ ...intg, mecanismo: e.target.value })} />
                <input placeholder="nombre del enlace" value={intg.nombre_enlace} onChange={(e) => setIntg({ ...intg, nombre_enlace: e.target.value })} />
                <input placeholder="estado" value={intg.estado_enlace} onChange={(e) => setIntg({ ...intg, estado_enlace: e.target.value })} />
              </div>
              <div style={{ marginTop: 10, textAlign: "right" }}><button className="btn" onClick={addIntg}>Agregar</button></div>
            </>
          )}
        </div>
        <div className="foot"><button className="btn sec" onClick={onClose}>Cerrar</button></div>
      </div>
    </div>
  );
}
