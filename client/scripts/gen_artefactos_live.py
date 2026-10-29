# -*- coding: utf-8 -*-
"""Genera los .xlsx de artefactos para descarga DESDE LA DATA EN VIVO (API local),
para que el Excel descargable sea identico al grid. Incluye ADI-01 (tabla
fuentes_institucionales) y ADI-08. Reconstruye artefactos.zip.
Requisito: server corriendo en localhost:4100 (npm start en /server).
Uso: python scripts/gen_artefactos_live.py
"""
import json, zipfile, sys, urllib.request
from pathlib import Path
from openpyxl import Workbook

API = "http://localhost:4100/api"
ART = Path(__file__).resolve().parent.parent / "public" / "artefactos"

# ADI-01 se arma de la tabla fuentes_institucionales con este mapeo (igual que el cliente FCOLS)
FCOLS = [
    ("id_fuente","N°"), ("fuente_documental","Fuente documental revisada"),
    ("descripcion_proposito","Descripción / propósito"), ("resumen","Resumen / análisis del contenido"),
    ("area_responsable","Área responsable"), ("fecha_version_estado","Fecha de la fuente"),
    ("tipo_fuente","Tipo de fuente"), ("formato_medio","Formato / medio"),
    ("nivel_confidencialidad","Confidencialidad"), ("relacion_sistemas_procesos","Relación con sistemas / procesos"),
    ("hallazgos","Hallazgos"), ("vacios_inconsistencias","Vacíos / inconsistencias"),
    ("evidencia_revision","Evidencia (archivo/patrón)"),
    ("enlace","Enlace"), ("origen_fuente","Origen"),
]
LIVE = ["ADI-03","ADI-04","ADI-05","ADI-07","ADI-08","ADI-09"]
TITULOS = {
    "ADI-01":"ADI-01 - Fuentes de Información y Evidencias Técnicas",
    "ADI-03":"ADI-03 - Catálogo AS-IS de Fuentes de Datos Institucionales",
    "ADI-04":"ADI-04 - Matriz de Fuentes de Datos por Dominio Funcional",
    "ADI-05":"ADI-05 - Mapa de Relaciones e Integraciones entre Fuentes de Datos",
    "ADI-07":"ADI-07 - Matriz de Volumetría y Criticidad de Fuentes de Datos",
    "ADI-08":"ADI-08 - Brechas, Riesgos y Restricciones del Ecosistema de Datos",
    "ADI-09":"ADI-09 - Modelo de Correspondencia Procesos, Dominios y Fuentes de Datos",
}


def get(path):
    with urllib.request.urlopen(API + path, timeout=120) as r:
        return json.loads(r.read().decode("utf-8"))


def write_xlsx(idp, columns, rows):
    wb = Workbook(); ws = wb.active; ws.title = idp
    ws.append([TITULOS.get(idp, idp)])
    ws.append(columns)
    for row in rows:
        ws.append([("" if v is None else str(v)) for v in row])
    out = ART / f"{idp}.xlsx"
    wb.save(out)
    return out


def main():
    generated = []
    # ADI-01 desde la tabla
    d = get("/fuentes_institucionales?take=500&skip=0")
    cols = [lbl for _, lbl in FCOLS]
    rows = [[r.get(f) for f, _ in FCOLS] for r in d["rows"]]
    write_xlsx("ADI-01", cols, rows); generated.append("ADI-01"); print(f"  ADI-01  {len(cols)}c x {len(rows)}f")
    # ADI-03..09 desde el endpoint en vivo
    for idp in LIVE:
        a = get("/artefacto/" + idp)
        write_xlsx(idp, a["columns"], a["rows"]); generated.append(idp)
        print(f"  {idp}  {len(a['columns'])}c x {len(a['rows'])}f")
    # zip
    xlsxs = sorted(ART.glob("ADI-*.xlsx"))
    with zipfile.ZipFile(ART / "artefactos.zip", "w", zipfile.ZIP_DEFLATED) as z:
        for x in xlsxs:
            z.write(x, x.name)
        flujo = ART.parent / "flujo_datos_onp.html"
        if flujo.exists(): z.write(flujo, flujo.name)
    print(f"artefactos.zip -> {len(xlsxs)} xlsx + diagrama  ({(ART/'artefactos.zip').stat().st_size} bytes)")


if __name__ == "__main__":
    main()
