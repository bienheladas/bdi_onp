import { useEffect, useMemo, useState, type ReactNode } from "react";
import { api, setKey, Model, Field, Opt, Rel, type EcoData, type BitacoraRow } from "./api";

const CAT = ["ambiente", "motor_bd", "tipo_proceso", "dominio_funcional", "proceso_negocio", "oficina"];
const ENT = ["servidor", "base_de_datos", "aplicacion"];
const MC = ["entidad_conceptual", "relacion_conceptual"];
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
        <a className={cur === "__bitacora__" ? "active" : ""} onClick={() => setCur("__bitacora__")}>📝 Bitácora de subsanación</a>
        <div className="grp">Catálogos</div>
        {CAT.map((n) => models.find((m) => m.name === n) && (
          <a key={n} className={cur === n ? "active" : ""} onClick={() => setCur(n)}>{n}</a>
        ))}
        <div className="grp">Inventarios</div>
        {ENT.map((n) => models.find((m) => m.name === n) && (
          <a key={n} className={cur === n ? "active" : ""} onClick={() => setCur(n)}>{n}</a>
        ))}
        <div className="grp">Modelo conceptual</div>
        {MC.map((n) => models.find((m) => m.name === n) && (
          <a key={n} className={cur === n ? "active" : ""} onClick={() => setCur(n)}>{n}</a>
        ))}
        <div className="grp">Ecosistema de Datos ONP</div>
        <a className={cur === "__eco_sis__" ? "active" : ""} onClick={() => { ecoFocus = null; ecoSub = null; setCur("__eco_sis__"); }}>👥 Sistemas</a>
        <a className={cur === "__eco_dom__" ? "active" : ""} onClick={() => { ecoFocus = null; ecoSub = null; setCur("__eco_dom__"); }}>🗂 Dominios y bases</a>
        <a className={cur === "__eco_pro__" ? "active" : ""} onClick={() => { ecoFocus = null; ecoSub = null; setCur("__eco_pro__"); }}>⚙ Procesos</a>
        <a className={cur === "__flujo__" ? "active" : ""} onClick={() => setCur("__flujo__")}>🔗 Integraciones</a>
        <a className={cur === "__eco_siip__" ? "active" : ""} onClick={() => { ecoFocus = null; ecoSub = null; setCur("__eco_siip__"); }}>🎯 Trazabilidad al SIIP</a>
        <a className={cur === "__eco_cob__" ? "active" : ""} onClick={() => { ecoFocus = null; ecoSub = null; setCur("__eco_cob__"); }}>🕳 Cobertura y vacíos</a>
        <a className={cur === "__modelo__" ? "active" : ""} onClick={() => setCur("__modelo__")}>🧩 Modelo conceptual</a>
        <div className="grp">Reportería</div>
        <a className={cur === "__artefactos__" ? "active" : ""} onClick={() => setCur("__artefactos__")}>📦 Artefactos · 2.º entregable</a>
      </nav>
      <main className="main">
        {cur === "__pend__"
          ? <Pendientes models={models} opts={opts} ensureOpts={ensureOpts} go={go} />
          : cur === "__bitacora__" ? <Bitacora />
          : cur === "__flujo__" ? <Flujo />
          : cur === "__modelo__" ? <ModeloConceptual />
          : cur.startsWith("__eco_") ? <Ecosistema view={cur.slice(6, -2)} nav={setCur} />
          : cur === "__artefactos__" ? <Artefactos />
          : model ? <Grid key={model.name} model={model} models={models} opts={opts} ensureOpts={ensureOpts} go={go} pending={pending} clearPending={() => setPending(null)} /> : <p>Cargando…</p>}
      </main>
    </div>
  );
}

function Bitacora() {
  const [rows, setRows] = useState<BitacoraRow[] | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => { api.bitacora().then(setRows).catch((e: any) => setErr(e?.message || "error")); }, []);
  if (err) return <div style={{ padding: 24 }}><h2>Bitácora de subsanación</h2><p className="muted">No se pudo cargar: {err}. ¿La tabla <code>bitacora_subsanacion</code> ya está cargada?</p></div>;
  if (!rows) return <p className="muted" style={{ padding: 24 }}>Cargando…</p>;
  const nCre = rows.filter((r) => r.tipo_cambio === "Creación").length;
  const nCor = rows.filter((r) => r.tipo_cambio === "Corrección").length;
  const arts = new Set(rows.map((r) => r.artefacto)).size;
  const kpis: [any, string][] = [[rows.length, "cambios al modelo"], [nCre, "creación"], [nCor, "corrección"], [arts, "artefactos"]];
  return (
    <>
      <div className="toolbar"><h2>Bitácora de subsanación · modificaciones al modelo de datos</h2></div>
      <p className="muted" style={{ margin: "0 0 10px" }}>
        Subsanaciones del 2.º entregable (INFORME 80-2026) que <b>crearon o corrigieron información</b> en el modelo. Lectura en vivo desde PostgreSQL.
      </p>
      <div className="kpis">{kpis.map(([n, l], i) => <div className="kpi" key={i}><div className="n">{n}</div><div className="l">{l}</div></div>)}</div>
      <table className="wrap">
        <thead><tr>
          <th>Fecha</th><th>ADI</th><th>Obs.</th><th>Tipo de cambio</th><th>Objeto del modelo</th><th>Descripción</th><th>Fuente</th><th>Estado</th>
        </tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              <td>{r.fecha}</td>
              <td>{r.artefacto}</td>
              <td>{r.obs_codigo}</td>
              <td><span className={"tag " + (r.tipo_cambio === "Creación" ? "tg-green" : "tg-blue")}>{r.tipo_cambio}</span></td>
              <td><code>{r.objeto}</code></td>
              <td>{r.descripcion}</td>
              <td>{r.fuente}</td>
              <td><span className={"tag " + (/subsan/i.test(r.estado || "") ? "tg-green" : "tg-amber")}>{r.estado}</span></td>
            </tr>
          ))}
          {rows.length === 0 && <tr><td colSpan={8} className="muted">Sin modificaciones registradas aún.</td></tr>}
        </tbody>
      </table>
    </>
  );
}

function Flujo() {
  return (
    <>
      <div className="toolbar">
        <h2>Integraciones · mapa de flujo de datos</h2>
        <a className="btn" href="/flujo_datos_onp.html" target="_blank" rel="noreferrer">Abrir en pestaña nueva ↗</a>
      </div>
      <iframe src="/flujo_datos_onp.html" title="Mapa de flujo de datos ONP"
        style={{ width: "100%", height: "calc(100vh - 150px)", border: "1px solid #334", borderRadius: 8, background: "#1b1f27" }} />
    </>
  );
}

function ModeloConceptual() {
  return (
    <>
      <div className="toolbar">
        <h2>Modelo conceptual de datos (AS-IS)</h2>
        <a className="btn" href="/modelo_conceptual.html" target="_blank" rel="noreferrer">Abrir en pestaña nueva ↗</a>
      </div>
      <iframe src="/modelo_conceptual.html" title="Modelo conceptual de datos ONP"
        style={{ width: "100%", height: "calc(100vh - 150px)", border: "1px solid #334", borderRadius: 8, background: "#1b1f27" }} />
    </>
  );
}

// ============ Ecosistema de Datos ONP (data en vivo) ============
// 5 vistas que aportan algo distinto a los 2 diagramas que ya existen
// (Entidades/relaciones = Modelo conceptual; Integraciones = Mapa de flujo).
// Cada vista es un ítem del menú lateral; se renderiza <Ecosistema view=...>.
const ECO_VIEWS: [string, string][] = [
  ["sis", "Sistemas"], ["dom", "Dominios y bases"], ["pro", "Procesos"],
  ["siip", "Trazabilidad al SIIP"], ["cob", "Cobertura y vacíos"],
];
const ECO_ICON: Record<string, string> = { sis: "👥", dom: "🗂", pro: "⚙", siip: "🎯", cob: "🕳", fte: "🗄" };
const ECO_TITLE: Record<string, string> = { fte: "Fuente / BD" };   // vistas sin ítem de menú
const sp = (s: string | null | undefined) => (s ? s.split("§").filter(Boolean) : []);
let ecoCache: EcoData | null = null;   // se consulta una vez; se comparte entre las vistas
let ecoFocus: string | null = null;    // clave a preseleccionar en la vista destino tras un link
let ecoSub: "dom" | "bd" | null = null; // sub-pestaña destino dentro de "Dominios y bases"
function Chips({ items, empty = "—" }: { items: string[]; empty?: string }) {
  if (!items.length) return <span className="eco-muted">{empty}</span>;
  return <div className="eco-chips">{items.map((x, i) => <span className="eco-chip" key={i}>{x}</span>)}</div>;
}
// Chips clicables que navegan a otra vista del explorador (BD→ficha, dominio→ADI-04, etc.)
function LinkChips({ items, onClick, empty = "—" }: { items: string[]; onClick: (x: string) => void; empty?: string }) {
  if (!items.length) return <span className="eco-muted">{empty}</span>;
  return <div className="eco-chips">{items.map((x, i) => <button className="eco-chip" key={i} title="Ver ficha" onClick={() => onClick(x)}>{x}</button>)}</div>;
}
// Paleta por dominio de datos del SIIP (misma del modelo conceptual del HTML).
const SIIP_PAL: Record<string, string> = {
  "Personas": "#C74634", "Aportes": "#2B6CB0", "Expedientes": "#2C7A7B", "Derechos y prestaciones": "#6B46C1",
  "Pagos y planillas": "#B7791F", "Seguros": "#3A7D44", "Inversiones": "#0E7490", "Atención al asegurado": "#BE5C00",
  "Documentos y notificaciones": "#718096", "Riesgos": "#9B2C2C", "Usuario/Seguridad": "#4A5568", "Documento": "#718096", "Atención": "#BE5C00",
};
// Chips de entidad coloreados por su dominio SIIP.
function EntChips({ items, domOf, empty = "—" }: { items: string[]; domOf: (e: string) => string | undefined; empty?: string }) {
  if (!items.length) return <span className="eco-muted">{empty}</span>;
  return <div className="eco-chips">{items.map((x, i) => {
    const c = SIIP_PAL[domOf(x) || ""] || "#5b6472";
    return <span className="eco-chip" key={i} style={{ background: "#fff", borderColor: c, color: c }} title={domOf(x) || ""}>{x}</span>;
  })}</div>;
}
function EcoRow({ k, children }: { k: string; children: ReactNode }) {
  return <div className="eco-grow"><dt>{k}</dt><dd>{children}</dd></div>;
}
// Decoración: color de badge según el valor de ciertas dimensiones (como en el HTML).
function tagClass(col: string, v: string): string | null {
  const t = (v || "").trim().toLowerCase().replace(/\s*\*$/, "");
  if (/tipo de proceso|tproc/i.test(col)) return /misional/.test(t) ? "tg-blue" : /estrat/.test(t) ? "tg-teal" : /soporte/.test(t) ? "tg-grey" : "tg-grey";
  if (/criticidad|nivel|dependencia|relevancia/i.test(col)) return /alta/.test(t) ? "tg-red" : /media/.test(t) ? "tg-amber" : /baja/.test(t) ? "tg-green" : null;
  if (/estado/i.test(col)) return /(operativo|activo|^sí|^si)/.test(t) ? "tg-green" : /(baja|candidat|desuso)/.test(t) ? "tg-red" : null;
  if (/alcance/i.test(col)) return /^sí|^si\b/.test(t) ? "tg-green" : /^no/.test(t) ? "tg-red" : null;
  if (/^motor/i.test(col)) return /oracle/.test(t) ? "tg-red" : /sql ?server/.test(t) ? "tg-blue" : /db2/.test(t) ? "tg-teal" : /mysql/.test(t) ? "tg-amber" : /postgre/.test(t) ? "tg-violet" : "tg-grey";
  return null;
}
function Tag({ col, v }: { col: string; v: string | null | undefined }) {
  if (!v) return <span className="eco-muted">—</span>;
  const cls = tagClass(col, v);
  return cls ? <span className={"tag " + cls}>{v}</span> : <>{v}</>;
}

function Ecosistema({ view, nav }: { view: string; nav: (c: string) => void }) {
  const [d, setD] = useState<EcoData | null>(ecoCache);
  const [err, setErr] = useState("");
  const [sel, setSel] = useState<any>(null);
  useEffect(() => { if (!ecoCache) api.ecosistema().then((x) => { ecoCache = x; setD(x); }).catch((e) => setErr(e.message)); }, []);
  // al entrar a una vista: si venimos de un link, preselecciona (sis se resuelve aquí;
  // las vistas ArtExplorer consumen ecoFocus por su cuenta).
  useEffect(() => {
    if (!d) { return; }
    if (view === "sis") { setSel(ecoFocus ? (d.sistemas.find((s) => s.cod === ecoFocus) ?? null) : null); }
    else { setSel(null); }
  }, [view, d]);

  if (err) return <div className="err" style={{ margin: 20 }}>{err}</div>;
  if (!d) return <p style={{ padding: 24 }}>Cargando ecosistema…</p>;

  // navega a otra vista del explorador preseleccionando 'key' (sub = pestaña dentro de Dominios y bases)
  const goto = (v: string, key: string, sub?: "dom" | "bd") => { ecoFocus = key; ecoSub = sub ?? null; nav(`__eco_${v}__`); };
  const K = d.kpis;
  const kpis: [number, string][] = [
    [K.bd, "BD en alcance"], [K.apps, "Aplicaciones"], [K.dominios, "Dominios"],
    [K.procesos, "Procesos"], [K.entidades, "Entidades"], [K.relaciones, "Relaciones"], [K.integraciones, "Integraciones"],
  ];
  const title = ECO_TITLE[view] ?? ECO_VIEWS.find(([k]) => k === view)?.[1] ?? "Ecosistema";
  const entDom: Record<string, string> = {};   // entidad -> dominio SIIP (para colorear chips)
  d.siip.forEach((r) => sp(r.ents).forEach((e) => { entDom[e] = r.dominio; }));

  return (
    <div className="eco">
      <div className="toolbar"><h2>{ECO_ICON[view]} {title}</h2><span className="eco-muted">Ecosistema de Datos ONP · data en vivo</span></div>
      <div className="kpis">{kpis.map(([n, l], i) => <div className="kpi" key={i}><div className="n">{n}</div><div className="l">{l}</div></div>)}</div>
      <div className="eco-content">
          {view === "sis" && <EcoSplit
            items={d.sistemas} keyOf={(s) => s.cod} sel={sel} onSel={setSel}
            card={(s) => <><div className="eco-t">{s.cod} · {s.nombre}</div><div className="eco-m">{sp(s.bases).length} BD · {sp(s.doms).length} dominios · {sp(s.procs).length} procesos</div></>}
            detail={(s) => <>
              <h3>{s.cod} · {s.nombre}</h3>
              <dl className="eco-dl">
                <EcoRow k="Estado"><Tag col="Estado" v={s.estado} />{s.criticidad ? <> · <Tag col="Criticidad" v={s.criticidad} /></> : null}</EcoRow>
                {s.descripcion && <EcoRow k="Descripción">{s.descripcion}</EcoRow>}
                {s.uso && <EcoRow k="Uso de la información">{s.uso}</EcoRow>}
                <EcoRow k="Bases (en alcance)"><LinkChips items={sp(s.bases)} onClick={(b) => goto("dom", b, "bd")} empty="Sin BD en alcance" /></EcoRow>
                <EcoRow k="Dominios"><LinkChips items={sp(s.doms)} onClick={(x) => goto("dom", x, "dom")} /></EcoRow>
                <EcoRow k="Procesos"><LinkChips items={sp(s.procs)} onClick={(x) => goto("pro", x)} /></EcoRow>
                <EcoRow k="Entidades"><EntChips items={sp(s.ents)} domOf={(e) => entDom[e]} /></EcoRow>
                <EcoRow k="Áreas usuarias"><Chips items={sp(s.areas)} empty="—" /></EcoRow>
                <EcoRow k="Gestor / Responsable">{[s.gestor, s.respf].filter(Boolean).join(" · ") || "—"}</EcoRow>
              </dl></>} />}

          {view === "dom" && <DomBasesView />}

          {view === "pro" && <ArtExplorer artId="ADI-09" nameCol="Proceso de negocio"
            metaCols={["Tipo de proceso", "Dominio funcional", "N° fuentes"]} focus={ecoFocus} />}

          {view === "siip" && <div className="eco-cards">
            {d.siip.map((s, i) => {
              const nivel = s.nf === 0 ? "Sin cobertura AS-IS" : s.nf < 3 ? "Cobertura parcial" : "Cobertura amplia";
              return (
                <div className="eco-card2" key={i}>
                  <div className="eco-t">{s.dominio}</div>
                  <div className="eco-m">{s.nent} entidades · {s.nf} fuentes AS-IS · <span className={"tag " + (s.nf === 0 ? "tg-red" : s.nf < 3 ? "tg-amber" : "tg-green")}>{nivel}</span></div>
                  <div className="eco-bar"><span style={{ width: `${Math.min(100, s.nf * 12)}%`, background: s.nf === 0 ? "#b3261e" : s.nf < 3 ? "#b56a00" : "#0f7a4d" }} /></div>
                  <dl className="eco-dl">
                    <EcoRow k="Entidades conceptuales"><EntChips items={sp(s.ents)} domOf={() => s.dominio} /></EcoRow>
                    <EcoRow k="Fuentes AS-IS (en alcance)"><LinkChips items={sp(s.bases)} onClick={(b) => goto("dom", b, "bd")} empty="Ninguna" /></EcoRow>
                  </dl>
                </div>
              );
            })}
          </div>}

          {view === "cob" && <EcoCobertura d={d} />}
      </div>
    </div>
  );
}

// Explorador genérico sobre un artefacto en vivo (ADI-04/09): lista por 'nameCol' y el
// panel de detalle muestra TODAS las columnas no vacías de la fila (máxima riqueza).
function ArtExplorer({ artId, nameCol, metaCols, focus }: { artId: string; nameCol: string; metaCols?: string[]; focus?: string | null }) {
  const [a, setA] = useState<{ columns: string[]; rows: string[][] } | null>(null);
  const [err, setErr] = useState("");
  const [i, setI] = useState<number | null>(null);
  useEffect(() => { setI(null); setA(null); api.artefacto(artId).then((x) => setA({ columns: x.columns, rows: x.rows })).catch((e) => setErr(e.message)); }, [artId]);
  // si llegamos por un link, preselecciona la fila cuyo nombre coincide (y consume el foco)
  useEffect(() => {
    if (!a || !focus) return;
    const ni = Math.max(0, a.columns.indexOf(nameCol));
    const idx = a.rows.findIndex((r) => r[ni] === focus);
    if (idx >= 0) setI(idx);
  }, [a, focus, nameCol]);
  if (err) return <div className="err">{err}</div>;
  if (!a) return <p className="eco-muted" style={{ padding: 10 }}>Cargando {artId}…</p>;
  const ni = Math.max(0, a.columns.indexOf(nameCol));
  const metaIdx = (metaCols || []).map((c) => a.columns.indexOf(c)).filter((x) => x >= 0);
  return (
    <div className="eco-split">
      <div className="eco-list">{a.rows.map((r, ri) => (
        <button key={ri} className={"eco-card" + (i === ri ? " sel" : "")} onClick={() => setI(ri)}>
          <div className="eco-t">{r[ni] || "—"}</div>
          {metaIdx.length > 0 && <div className="eco-m">{metaIdx.map((mi, k) => {
            const val = r[mi]; if (!val) return null;
            const cls = tagClass(a.columns[mi], val);
            return <span key={k}>{k > 0 && !cls ? " · " : " "}{cls ? <span className={"tag " + cls}>{val}</span> : val}</span>;
          })}</div>}
        </button>))}
      </div>
      <div className="eco-panel">{i == null ? <span className="eco-muted">Selecciona un elemento de la lista.</span> :
        <><h3>{a.rows[i][ni] || "—"}</h3><dl className="eco-dl">
          {a.columns.map((c, ci) => (ci === ni || !a.rows[i][ci]) ? null : <EcoRow k={c} key={ci}><Tag col={c} v={a.rows[i][ci]} /></EcoRow>)}
        </dl></>}
      </div>
    </div>
  );
}

// Vista "Dominios y bases": muestra AMBAS dimensiones (ADI-04 dominios + ADI-03 bases) con un
// sub-selector. Entrando por el menú arranca en Dominios; por el link de una BD, en Bases y
// con esa BD seleccionada.
function DomBasesView() {
  const [sub, setSub] = useState<"dom" | "bd">(ecoSub ?? "dom");
  return (
    <>
      <div className="eco-subtabs">
        <button className={sub === "dom" ? "on" : ""} onClick={() => setSub("dom")}>Dominios</button>
        <button className={sub === "bd" ? "on" : ""} onClick={() => setSub("bd")}>Bases de datos</button>
      </div>
      {sub === "dom"
        ? <ArtExplorer artId="ADI-04" nameCol="Dominio funcional (normalizado)" metaCols={["Tipo de proceso", "N° BD", "Nivel de relación"]} focus={ecoFocus} />
        : <ArtExplorer artId="ADI-03" nameCol="Fuente / BD" metaCols={["Motor", "Ambiente", "Servidor", "Tamaño (GB)"]} focus={ecoFocus} />}
    </>
  );
}

// Lista (izquierda) + panel de detalle (derecha). 'embed' evita envolver dos veces en .eco-split.
function EcoSplit<T>({ items, keyOf, sel, onSel, card, detail, embed }: {
  items: T[]; keyOf: (x: T) => string; sel: any; onSel: (x: T) => void;
  card: (x: T) => ReactNode; detail: (x: T) => ReactNode; embed?: boolean;
}) {
  const body = (<>
    <div className="eco-list">{items.map((x) => {
      const k = keyOf(x);
      return <button key={k} className={"eco-card" + (sel && keyOf(sel) === k ? " sel" : "")} onClick={() => onSel(x)}>{card(x)}</button>;
    })}</div>
    <div className="eco-panel">{sel ? detail(sel) : <span className="eco-muted">Selecciona un elemento de la lista.</span>}</div>
  </>);
  return embed ? body : <div className="eco-split">{body}</div>;
}

function EcoCobertura({ d }: { d: EcoData }) {
  const K = d.kpis;
  const entSin = d.entidades.filter((e) => e.nf === 0);
  const domSin = d.dominios.filter((x) => sp(x.bases).length === 0);
  const proSin = d.procesos.filter((x) => sp(x.apps).length === 0);
  const sisSin = d.sistemas.filter((s) => sp(s.bases).length === 0);
  const siipSin = d.siip.filter((s) => s.nf === 0);
  const siipParc = d.siip.filter((s) => s.nf > 0 && s.nf < 3);
  const niveles = [
    { nivel: "Sistema / aplicación", n: K.apps, fuente: "ADI-03 · apps consumidoras", ok: true },
    { nivel: "Base de datos", n: K.bd, fuente: "ADI-03", ok: true },
    { nivel: "Dominio funcional", n: K.dominios, fuente: "ADI-04", ok: true },
    { nivel: "Proceso de negocio", n: K.procesos, fuente: "ADI-09", ok: true },
    { nivel: "Entidad conceptual", n: K.entidades, fuente: "ADI-09 · AMC", ok: true },
    { nivel: "Integraciones", n: K.integraciones, fuente: "ADI-05", ok: true },
    { nivel: "Relación entre entidades", n: K.relaciones, fuente: "AMC · ADI-05", ok: false },
  ];
  const B = d.brechas;
  const basesBajaUso = B.bases_baja.filter((x) => x.n_apps > 0 || x.n_integ > 0);
  const blocks = [
    { t: "Entidades conceptuales sin fuente AS-IS", arr: entSin.map((e) => `${e.nombre} (${e.dominio})`) },
    { t: "Dominios SIIP sin cobertura AS-IS", arr: siipSin.map((s) => s.dominio) },
    { t: "Dominios SIIP con cobertura parcial (<3 fuentes)", arr: siipParc.map((s) => `${s.dominio} · ${s.nf}`) },
    { t: "Bases sin dominio funcional asociado", arr: B.bases_sin_dominio.map((b) => b.nombre + (b.emc ? " · en alcance" : "")) },
    { t: "Bases en baja/candidata que aún se usan", arr: basesBajaUso.map((x) => `${x.nombre} · ${x.estado} · ${x.n_apps} apps · ${x.n_integ} integr.`) },
    { t: "Dominios funcionales sin BD en alcance", arr: domSin.map((x) => x.nombre) },
    { t: "Procesos sin aplicación en alcance", arr: proSin.map((x) => `${x.proceso} · ${x.dominio}`) },
    { t: "Sistemas en alcance sin BD en alcance", arr: sisSin.map((s) => `${s.cod} ${s.nombre}`) },
  ];
  return (
    <div>
      <h3 className="eco-h">Nivel de detalle existente (en alcance)</h3>
      <div className="tablewrap" style={{ maxHeight: "none", marginBottom: 20 }}>
        <table>
          <thead><tr><th>Nivel</th><th>Disponibilidad</th><th>Fuente</th></tr></thead>
          <tbody>
            {niveles.map((x, i) => (
              <tr key={i}>
                <td><b>{x.nivel}</b></td>
                <td><span className={"tag " + (x.ok ? "tg-green" : "tg-amber")}>{x.ok ? "Completo" : "Parcial"} · {x.n}</span></td>
                <td>{x.fuente}</td>
              </tr>))}
            <tr><td><b>Nombre de tabla → entidad</b></td><td><span className="tag tg-red">No disponible</span></td><td>Extracción de estructura física (F-24)</td></tr>
          </tbody>
        </table>
      </div>
      <h3 className="eco-h">Vacíos detectados</h3>
      <div className="eco-panel" style={{ marginBottom: 14 }}>
        <h3>Extremos de ETL sin resolver <span className="eco-muted">(endpoint «parametrizado — pendiente», requiere OTI)</span></h3>
        <span className={"tag " + (B.etl.orig ? "tg-amber" : "tg-green")}>{B.etl.orig} orígenes pendientes</span>{" "}
        <span className={"tag " + (B.etl.dest ? "tg-amber" : "tg-green")}>{B.etl.dest} destinos pendientes</span>
        <span className="eco-muted"> · de {K.integraciones} integraciones</span>
      </div>
      <div className="eco-cob">{blocks.map((b, i) => (
        <div className="eco-panel" key={i}>
          <h3>{b.t} <span className={"tag " + (b.arr.length ? "tg-amber" : "tg-green")}>{b.arr.length}</span></h3>
          {b.arr.length ? <ul className="eco-ul">{b.arr.map((x, j) => <li key={j}>{x}</li>)}</ul> : <span className="eco-muted">Sin vacíos.</span>}
        </div>))}
      </div>
    </div>
  );
}

type ArtMeta = { id: string; titulo: string; generador: string; archivo?: string; fuente?: string; sheets?: { id: string; label: string }[] };
type ArtData = { id: string; titulo: string; columns: string[]; rows: string[][]; links: Record<string, string> };
// ADI-01 se arma EN VIVO desde la tabla fuentes_institucionales (22 oficiales + nuevas LCP),
// no de un Excel en duro. El resto de artefactos sí vienen de su <ID>.json.
const FCOLS: [string, string][] = [
  ["id_fuente", "N°"], ["fuente_documental", "Fuente documental revisada"], ["descripcion_proposito", "Descripción / propósito"],
  ["resumen", "Resumen / análisis del contenido"],
  ["area_responsable", "Área responsable"], ["fecha_version_estado", "Fecha de la fuente"],
  ["tipo_fuente", "Tipo de fuente"], ["formato_medio", "Formato / medio"], ["nivel_confidencialidad", "Confidencialidad"],
  ["relacion_sistemas_procesos", "Relación con sistemas / procesos"], ["sirve_adi", "Sirve a (ADI)"], ["hallazgos", "Hallazgos"],
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
// Anchos por columna para ADI-09 (layout fijo): ancho a las listas largas (fuentes/
// entidades), medio a los textos de análisis, angosto a los conteos.
const W09: Record<string, number> = {
  "N°": 38, "Tipo de proceso": 72, "Dominio funcional": 135, "Proceso de negocio": 170,
  "N° apps": 46, "Aplicaciones": 230, "N° fuentes": 46, "Fuentes de datos / BD": 420,
  "Entidades conceptuales (detectadas)": 300, "Tipo de información": 150,
  "Cobertura del dominio": 230, "Vacíos": 230, "Solapamientos / redundancias": 245,
  "Fragmentación": 245, "Desalineamiento vs. SIIP": 235, "Relevancia p/ modelo AS-IS": 235,
  "Evidencia": 160,
};
// Anchos ADI-04 (incorporó textos de análisis: Uso principal, Nivel de relación, Vacíos, Observaciones).
const W04: Record<string, number> = {
  "Tipo de proceso": 85, "Dominio funcional (normalizado)": 150, "Procesos de negocio incluidos": 220,
  "N° proc.": 46, "N° apps": 46, "Aplicaciones del dominio": 170, "N° BD": 46,
  "Fuentes de datos / BD del dominio": 240, "Motores involucrados": 95, "Tipo de información": 190,
  "Uso principal": 320, "Áreas usuarias": 160, "Fuentes exclusivas del dominio": 190,
  "Fuentes compartidas con otros dominios": 190, "Nivel de relación": 72,
  "Vacíos / solapamientos / dispersión": 240, "Observaciones para el modelo conceptual": 260,
};
const WMAP: Record<string, Record<string, number>> = { "ADI-09": W09, "ADI-04": W04 };
function Artefactos() {
  const [meta, setMeta] = useState<ArtMeta[]>([]);
  const [sel, setSel] = useState<string>("");
  const [sheet, setSheet] = useState<string>("");
  const [data, setData] = useState<ArtData | null>(null);
  const [q, setQ] = useState("");
  const [desc, setDesc] = useState<Record<string, Record<string, string>>>({});
  const [sort, setSort] = useState<{ col: number; dir: "asc" | "desc" } | null>(null);
  useEffect(() => {
    fetch("/artefactos/manifest.json").then((r) => r.json()).then((m: ArtMeta[]) => { setMeta(m); if (m[0]) setSel(m[0].id); });
    api.columnasDesc().then(setDesc).catch(() => setDesc({}));
  }, []);
  const cur = meta.find((m) => m.id === sel);
  const sheets = cur?.sheets;
  const effSheet = sheets ? (sheets.some((s) => s.id === sheet) ? sheet : sheets[0].id) : "";
  const viewId = sheets ? effSheet : sel;   // artefacto/hoja efectivamente mostrado
  useEffect(() => {
    if (!viewId || meta.length === 0) return;
    setData(null); setSort(null);
    const p = sheets ? api.artefacto(viewId)
      : cur?.fuente === "tabla" ? loadFuentes()
      : cur?.fuente === "live" ? api.artefacto(viewId)
      : fetch(`/artefactos/${viewId}.json`).then((r) => r.json());
    p.then(setData).catch(() => setData(null));
  }, [viewId, meta]);
  // clic en cabecera: asc -> desc -> sin orden
  const toggleSort = (ci: number) => setSort((s) =>
    s && s.col === ci ? (s.dir === "asc" ? { col: ci, dir: "desc" } : null) : { col: ci, dir: "asc" });
  const rows = useMemo(() => {
    if (!data) return [] as { i: number; r: string[] }[];
    let all = data.rows.map((r, i) => ({ i, r }));
    if (q.trim()) { const s = q.toLowerCase(); all = all.filter(({ r }) => r.some((c) => c.toLowerCase().includes(s))); }
    if (sort) {
      const isNum = (v: string) => /^-?\d+(\.\d+)?$/.test(v.replace(/\s/g, "").replace("%", ""));
      const num = (v: string) => parseFloat(v.replace(/\s/g, "").replace("%", ""));
      const cmp = (a: string, b: string) => {
        // vacíos siempre "mayores" => al final en asc, arriba en desc (para cazar huecos)
        if (a === "" || b === "") return a === b ? 0 : a === "" ? 1 : -1;
        if (isNum(a) && isNum(b)) return num(a) - num(b);
        return a.localeCompare(b, "es", { numeric: true, sensitivity: "base" });
      };
      all = all.slice().sort((x, y) => {
        const base = cmp(x.r[sort.col] ?? "", y.r[sort.col] ?? "");
        return sort.dir === "desc" ? -base : base;
      });
    }
    return all;
  }, [data, q, sort]);
  return (
    <>
      <div className="toolbar">
        <h2>Artefactos</h2>
        <select className="search" value={sel} onChange={(e) => setSel(e.target.value)} style={{ maxWidth: 440 }}>
          {meta.map((m) => <option key={m.id} value={m.id}>{m.id} · {m.titulo}</option>)}
        </select>
        <input className="search" placeholder="Buscar…" value={q} onChange={(e) => setQ(e.target.value)} />
        {sel === "ADI-05" && <a className="btn sec" href="/flujo_datos_onp.html" target="_blank" rel="noreferrer">🗺 Mapa de flujo de datos ↗</a>}
        {viewId && <a className="btn sec" onClick={() => api.xlsx(`/api/artefacto/${encodeURIComponent(viewId)}/xlsx`, `${viewId}.xlsx`).catch((e) => alert(e.message))}>⬇ Esta hoja (.xlsx)</a>}
        <a className="btn" onClick={() => api.xlsx("/api/artefactos.xlsx", "Artefactos_ADI_E2_Diagnostico_ASIS_LCP.xlsx").catch((e) => alert(e.message))}>⬇ Descargar todo (.xlsx)</a>
      </div>
      {sheets && <div className="subtabs" style={{ display: "flex", gap: 6, margin: "0 0 8px" }}>
        {sheets.map((s) => <button key={s.id} className={"btn sec" + (s.id === viewId ? " active" : "")}
          style={s.id === viewId ? { background: "#1F4E78", color: "#fff" } : {}}
          onClick={() => setSheet(s.id)}>{s.label}</button>)}
      </div>}
      {cur && <p className="muted" style={{ margin: "0 0 10px" }}>Generador: <code>{cur.generador}</code> · <span className="pill">{rows.length}</span> filas</p>}
      <p className="muted" style={{ margin: "0 0 10px", fontSize: 12, borderLeft: "3px solid #bbb", paddingLeft: 8 }}>
        {["ADI-03", "ADI-04", "ADI-04-FD", "ADI-07"].includes(viewId) && <>
          <b>Alcance:</b> se consideran únicamente las fuentes de datos en ambiente de <b>Producción</b>, según lo delimitado en el <b>Acta de inicio del servicio</b> (Kick off, AR-001-DE_BDI, 16/09/2026 — <b>F-32</b>): «del total de BD mapeadas, 172 se encuentran en producción y son las que se tomarán en cuenta como parte del presente servicio». · </>}
        <b>Procedencia:</b> todos los valores de los artefactos ADI provienen del repositorio del Documento Equivalente (modelo PostgreSQL de LCP) y son <b>calculados o derivados</b> de datos recopilados de las <b>fuentes institucionales</b> (F-01…F-32); ninguno es inferido sin sustento (ver matriz de trazabilidad).
      </p>
      {!data ? <p className="muted">Cargando…</p> : viewId === "ADI-08" ? (() => {
        // Vista FORMULARIO (una ficha por riesgo): campos cortos en rejilla (etiqueta+dato),
        // campos de texto/análisis a todo el ancho (etiqueta + texto completo).
        const maxlen = data.columns.map((_, ci) => rows.reduce((m, { r }) => Math.max(m, (r[ci] || "").length), 0));
        const shortIdx = data.columns.map((_, i) => i).filter((i) => maxlen[i] <= 40);
        const longIdx = data.columns.map((_, i) => i).filter((i) => maxlen[i] > 40);
        return (
          <div className="formswrap">
            {rows.map(({ i, r }) => (
              <div className="riskcard" key={i}>
                <div className="rc-head">
                  {shortIdx.flatMap((ci) => [
                    <div className="rc-k" key={ci + "k"} title={desc[viewId]?.[data.columns[ci]] || ""}>{data.columns[ci]}</div>,
                    <div className="rc-v" key={ci + "v"}>{r[ci]}</div>,
                  ])}
                </div>
                {longIdx.map((ci) => (
                  <div className="rc-row" key={ci}>
                    <div className="rc-k" title={desc[viewId]?.[data.columns[ci]] || ""}>{data.columns[ci]}</div>
                    <div className="rc-v">{r[ci]}</div>
                  </div>
                ))}
              </div>
            ))}
            {rows.length === 0 && <p className="muted">Sin resultados.</p>}
          </div>
        );
      })() : (
        <div className="tablewrap">
          <table className={WMAP[viewId] ? "wrap" : ""}>
            {WMAP[viewId] && <colgroup>{data.columns.map((c, i) => <col key={i} style={{ width: (WMAP[viewId][c] || 180) + "px" }} />)}</colgroup>}
            <thead><tr>{data.columns.map((c, i) => {
              const d = desc[viewId]?.[c];
              const ind = sort && sort.col === i ? (sort.dir === "asc" ? " ▲" : " ▼") : "";
              return <th key={i} className="sortable" onClick={() => toggleSort(i)}
                title={d ? `${c} — ${d}` : c}>{c}{d ? <span className="hdrinfo"> ⓘ</span> : null}
                <span className="sort-ind">{ind}</span></th>;
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
  ddl: <><rect x="3" y="3" width="18" height="18" rx="1" /><path d="M3 9h18M9 3v18" /></>,
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
  const [estr, setEstr] = useState<Record<string, number>>({});          // id_bd -> n_tablas (solo base_de_datos)
  const [struct, setStruct] = useState<{ id: any; nombre: string } | null>(null);  // modal de estructura DDL
  const pk = model.pks[0];
  const cols = model.fields.filter((f) => f.type !== "Json" || true); // mostrar todas
  const actsLeft = ACTS_LEFT.has(model.name);
  const actsCell = (r: any) => (
    <td key="__acts"><div className="acts">
      <button className="btn xs sec ico" title="Editar" onClick={() => setEdit(r)}><Ico n="edit" /></button>
      <button className="btn xs danger ico" title="Eliminar" onClick={async () => { if (confirm("¿Eliminar registro?")) { try { await api.remove(model.name, r[pk]); load(); } catch (e: any) { alert(e.message); } } }}><Ico n="del" /></button>
      {model.relations.map((rl) => <button key={rl.key} className="btn xs ico" title={rl.label} onClick={() => { ensureOpts(rl.target); setRel({ rel: rl, row: r }); }}><Ico n={relIco[rl.key] || "link"} /></button>)}
      {model.name === "base_de_datos" && (() => {
        const n = estr[String(r[pk])] || 0;   // sin estructura DDL -> botón deshabilitado
        return <button className="btn xs ico" disabled={!n} title={n ? `Estructura DDL (${n} tablas)` : "Sin estructura DDL cargada"} onClick={() => setStruct({ id: r[pk], nombre: r.nombre_bd })}><Ico n="ddl" /></button>;
      })()}
    </div></td>
  );

  const load = () => api.list(model.name, q, page * PAGE, PAGE, sort).then((d) => { setRows(d.rows); setTotal(d.total); });
  useEffect(() => { load(); }, [model.name, page, sort]);
  // mapa de estructura (qué BD tienen DDL) para habilitar/deshabilitar el botón
  useEffect(() => { if (model.name === "base_de_datos") api.estructuraBd().then(setEstr).catch(() => {}); }, [model.name]);
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
      {struct && <EstructuraModal idBd={struct.id} nombre={struct.nombre} onClose={() => setStruct(null)} />}
    </>
  );
}

// Explorador de estructura DDL de una BD: elige esquema (por defecto el más poblado),
// busca una tabla y muestra sus columnas con toda la metadata (tipo, longitud, PK, comentario).
function EstructuraModal({ idBd, nombre, onClose }: { idBd: any; nombre: string; onClose: () => void }) {
  const [esquemas, setEsquemas] = useState<{ id_esquema: number; nombre_esquema: string; tipo: string | null; n_tablas: number }[]>([]);
  const [selEsq, setSelEsq] = useState<number | null>(null);
  const [tablas, setTablas] = useState<{ id_tabla: number; nombre_tabla: string; n_cols: number }[]>([]);
  const [q, setQ] = useState("");
  const [selTab, setSelTab] = useState<{ id: number; nombre: string } | null>(null);
  const [cols, setCols] = useState<any[]>([]);
  const [err, setErr] = useState("");

  // al abrir: trae esquemas (ordenados desc) y selecciona el más poblado; si ninguno tiene tablas, null
  useEffect(() => {
    api.bdEstructura(idBd).then((d) => {
      setEsquemas(d.esquemas);
      const first = d.esquemas[0];
      setSelEsq(first && first.n_tablas > 0 ? first.id_esquema : null);
    }).catch((e: any) => setErr(e.message));
  }, [idBd]);

  // tablas del esquema seleccionado (búsqueda con debounce)
  useEffect(() => {
    if (selEsq == null) { setTablas([]); setSelTab(null); setCols([]); return; }
    setSelTab(null); setCols([]);
    const t = setTimeout(() => { api.esquemaTablas(selEsq, q).then(setTablas).catch((e: any) => setErr(e.message)); }, 250);
    return () => clearTimeout(t);
  }, [selEsq, q]);

  const openTabla = (t: { id_tabla: number; nombre_tabla: string }) => {
    setSelTab({ id: t.id_tabla, nombre: t.nombre_tabla });
    api.tablaColumnas(t.id_tabla).then(setCols).catch((e: any) => setErr(e.message));
  };

  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()} style={{ width: "min(1100px, 95vw)" }}>
        <h3>Estructura DDL · {nombre}</h3>
        {err && <div className="err">{err}</div>}
        <div className="body" style={{ display: "grid", gridTemplateColumns: "340px 1fr", gap: 14 }}>
          <div>
            <div className="frow"><label>Esquema</label>
              <select value={selEsq ?? ""} onChange={(e) => setSelEsq(e.target.value === "" ? null : Number(e.target.value))}>
                <option value="">— (sin esquema) —</option>
                {esquemas.map((s) => <option key={s.id_esquema} value={s.id_esquema}>{s.nombre_esquema} ({s.n_tablas}){s.tipo ? ` · ${s.tipo}` : ""}</option>)}
              </select>
            </div>
            <input className="search" style={{ width: "100%", margin: "8px 0" }} placeholder="Buscar tabla…" value={q} onChange={(e) => setQ(e.target.value)} disabled={selEsq == null} />
            <div className="tablewrap" style={{ maxHeight: "54vh", overflow: "auto" }}>
              <table>
                <thead><tr><th>Tabla</th><th>#cols</th></tr></thead>
                <tbody>
                  {tablas.map((t) => (
                    <tr key={t.id_tabla} style={{ cursor: "pointer", background: selTab?.id === t.id_tabla ? "#2a3350" : undefined }} onClick={() => openTabla(t)}>
                      <td>{t.nombre_tabla}</td><td>{t.n_cols}</td>
                    </tr>
                  ))}
                  {selEsq != null && tablas.length === 0 && <tr><td colSpan={2} className="muted">Sin tablas.</td></tr>}
                  {selEsq == null && <tr><td colSpan={2} className="muted">Elige un esquema.</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
          <div>
            {!selTab ? <p className="muted">Selecciona una tabla para ver sus columnas.</p> : (
              <>
                <div className="toolbar" style={{ marginBottom: 8 }}><b>{selTab.nombre}</b> <span className="pill">{cols.length} columnas</span></div>
                <div className="tablewrap" style={{ maxHeight: "58vh", overflow: "auto" }}>
                  <table>
                    <thead><tr><th>#</th><th>Columna</th><th>Tipo</th><th>Long.</th><th>Nulo</th><th>PK</th><th>Comentario</th></tr></thead>
                    <tbody>
                      {cols.map((c, i) => (
                        <tr key={i}>
                          <td>{c.col_id ?? ""}</td>
                          <td>{c.nombre_columna}</td>
                          <td>{c.tipo ?? ""}</td>
                          <td>{c.longitud ?? ""}</td>
                          <td>{c.nullable ?? ""}</td>
                          <td style={{ textAlign: "center" }}>{c.es_pk === "Y" ? "🔑" : ""}</td>
                          <td title={c.comentario ?? ""}>{c.comentario ?? ""}</td>
                        </tr>
                      ))}
                      {cols.length === 0 && <tr><td colSpan={7} className="muted">Sin columnas.</td></tr>}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </div>
        </div>
        <div className="foot"><button className="btn sec" onClick={onClose}>Cerrar</button></div>
      </div>
    </div>
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
  model.fields.forEach((f) => {
    init[f.name] = f.type === "Boolean"
      ? (rec[f.name] == null ? true : !!rec[f.name])   // default marcado en alta
      : rec[f.name] == null ? "" : (f.type === "Json" ? JSON.stringify(rec[f.name]) : f.type === "DateTime" ? String(rec[f.name]).slice(0, 10) : rec[f.name]);
  });
  const [form, setForm] = useState<any>(init);
  const [err, setErr] = useState("");
  const [cascade, setCascade] = useState<{ id_bd: number; nombre_bd: string; compartida: boolean; otras_apps: string[] }[] | null>(null);
  const wasEnModelo = model.name === "aplicacion" && !!rec.en_modelo_conceptual;   // estaba en alcance antes de editar

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
      if (isNew) { await api.create(model.name, body); onSaved(); return; }
      await api.update(model.name, rec[model.pks[0]] ?? model.pks.map((k) => rec[k]).join("/"), body);
      // Al sacar una aplicación del modelo conceptual, ofrecer cascada a sus BD asociadas.
      if (wasEnModelo && body.en_modelo_conceptual === false) {
        const prev = await api.bdCascadaPreview(rec[model.pks[0]]);
        if (prev.length) { setCascade(prev); return; }   // abre el modal; onSaved se llama al resolverlo
      }
      onSaved();
    } catch (e: any) { setErr(e.message); }
  };

  if (cascade) return <CascadeModal appId={rec[model.pks[0]]} rows={cascade} onDone={onSaved} />;

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

// Modal que aparece al sacar una app del modelo conceptual: pregunta si sacar también
// sus BD asociadas. Las compartidas (usadas por otras apps en alcance) vienen desmarcadas.
function CascadeModal({ appId, rows, onDone }: { appId: any; rows: { id_bd: number; nombre_bd: string; compartida: boolean; otras_apps: string[] }[]; onDone: () => void }) {
  const [sel, setSel] = useState<Record<number, boolean>>(() => Object.fromEntries(rows.map((r) => [r.id_bd, !r.compartida])));
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const toggle = (id: number) => setSel((s) => ({ ...s, [id]: !s[id] }));
  const apply = async () => {
    setBusy(true);
    try {
      const ids = rows.filter((r) => sel[r.id_bd]).map((r) => r.id_bd);
      if (ids.length) await api.bdCascadaApply(appId, ids);
      onDone();
    } catch (e: any) { setErr(e.message); setBusy(false); }
  };
  return (
    <div className="overlay" onClick={() => onDone()}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>Sacar también las BD del modelo conceptual</h3>
        <p className="muted">La aplicación salió del alcance. ¿Quieres sacar también del modelo conceptual sus bases de datos asociadas? Las que aún usan otras aplicaciones en alcance vienen desmarcadas (quedan como están para tratamiento manual).</p>
        {err && <div className="err">{err}</div>}
        <div className="body">
          {rows.map((r) => (
            <label className="frow" key={r.id_bd} style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input type="checkbox" checked={!!sel[r.id_bd]} onChange={() => toggle(r.id_bd)} />
              <span>{r.nombre_bd}</span>
              {r.compartida && <span className="muted"> · en alcance también por: {r.otras_apps.join(", ")}</span>}
            </label>
          ))}
        </div>
        <div className="foot">
          <button className="btn sec" disabled={busy} onClick={() => onDone()}>No, dejarlas</button>
          <button className="btn" disabled={busy} onClick={apply}>Sacar las seleccionadas</button>
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
  if (f.type === "Boolean") return <input type="checkbox" checked={!!value} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />;
  if (f.type === "Json") return <textarea rows={2} placeholder='["valor1","valor2"]' value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} />;
  if (f.type === "DateTime") return <input type="date" value={value || ""} disabled={disabled} onChange={(e) => onChange(e.target.value)} />;
  if (f.type === "Int" || f.type === "Decimal") return <input type="number" step={f.type === "Decimal" ? "any" : "1"} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} />;
  if (/^(desc_|observ|coment|uso_)/.test(f.name)) return <textarea rows={2} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} />;
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
