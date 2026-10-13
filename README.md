# Web de mantenimiento — Modelo BDI ONP

CRUD sobre la base `onp_bdi` (PostgreSQL en Coolify). Stack: **Node + Express + Prisma**
(backend) y **React + Vite** (frontend). Corre **local**, conectándose a la BD por el túnel SSH.

## Requisitos
- Node 20+ y el túnel SSH a la BD abierto en `localhost:5434`:
  ```
  ssh -i %USERPROFILE%\.ssh\mibodega.key -N -L 5434:10.0.2.14:5432 ubuntu@168.129.177.74
  ```

## Arranque
```
# 1) Backend (puerto 4100)
cd server
npm install
npm start            # http://localhost:4100

# 2) Frontend (puerto 5180)
cd client
npm install
npm run dev          # http://localhost:5180  <-- abrir aquí
```
`server/.env` tiene `DATABASE_URL` (usuario **onp**, lectura/escritura). ⚠️ Los cambios en la
web se guardan en la BD real.

## Estructura / diseño
- **Entidades** (menú): catálogos (ambiente, motor_bd, tipo_proceso, dominio_funcional,
  proceso_negocio), `servidor`, `base_de_datos`, `aplicacion`.
- **Tablas de relación NO tienen menú propio**; se gestionan como **modales desde el padre**:
  - `aplicacion` → botones **Bases de datos** y **Procesos** (asociar/quitar).
  - `base_de_datos` → **Aplicaciones** (ver) e **Integraciones** (agregar/quitar).
- CRUD genérico con dropdowns de FK, búsqueda y paginación.

## Si cambia el esquema de la BD
```
cd server
npm run introspect   # prisma db pull
npm run generate     # prisma generate
```

## Autenticación
- Login por **clave compartida** (`ADMIN_PASSWORD`). En local, si no se define la variable,
  la web queda abierta; en el despliegue se exige la clave (header `x-admin-key`).

## Despliegue en Coolify
Repo: https://github.com/bienheladas/bdi_onp
1. En Coolify (proyecto *base-de-datos-integrada-onp*) → **New Resource → Docker Compose** → apuntar a este repo (`docker-compose.yml`).
2. Variables de entorno del recurso:
   - `DATABASE_URL = postgresql://onp:<PASSWORD>@vfyn4fyx9lqwhd3tj87yjxze:5432/onp_bdi?schema=public&sslmode=disable`
   - `ADMIN_PASSWORD = <clave de acceso a la web>`
3. El servicio `api` se une a la red externa **`coolify`** (ya declarado en el compose) para
   alcanzar el contenedor Postgres de ONP por su hostname interno.
4. Publicar el **dominio en el servicio `web`** (puerto 80). nginx sirve la SPA y hace proxy de `/api` al `api`.
5. Deploy. No se corren migraciones (la BD ya existe).

