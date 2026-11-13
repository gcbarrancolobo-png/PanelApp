# Despliegue de PanelApp (servicio único + Turso)

PanelApp se despliega como **un solo servicio Node.js** que sirve:

- la aplicación (archivos estáticos de `dist/`) en `/`,
- la API en `/api/*` (`/api/sync`, `/api/verify/:code`, `/api/transcribe`, `/api/extract`, `/api/advisor`, `/api/health`),
- el *fallback* SPA para rutas como `/verificar/:codigo`.

La base de datos vive en **Turso (libSQL en la nube)**, así que el host no
necesita disco persistente.

## 0. URL de producción

- App y API: https://panelapp.onrender.com
- Health: https://panelapp.onrender.com/api/health


## 1. Requisitos

- Node.js ≥ 22.5 (probado con Node 24).
- Una base de datos Turso y un token con permiso de lectura/escritura.
- Una `GEMINI_API_KEY` de Google AI Studio.

## 2. Configurar Turso

1. Crea la base en https://turso.tech (o con `turso db create panelapp`).
2. Obtén la URL y el token:

   ```bash
   turso db show panelapp --url
   turso db tokens create panelapp
   ```

3. El esquema y la clave de firma Ed25519 se crean automáticamente en el
   primer arranque. La clave privada se guarda en la tabla `app_settings`,
   por lo que los comprobantes públicos siguen validando tras reinicios y
   redeploys.

## 3. Construir y ejecutar localmente

```bash
npm install
npm run build     # genera dist/ (tsc -b && vite build)
npm start         # sirve dist/ + /api en el puerto API_PORT
```

Copia `.env.example` a `.env` y completa:

- `GEMINI_API_KEY`, `GEMINI_MODEL`
- `PANELAPP_DB_URL=libsql://...` y `PANELAPP_DB_AUTH_TOKEN=...`
- `API_PORT`, `API_HOST`
- Si dejas `PANELAPP_DB_URL` vacío, se usa SQLite local en `data/panelapp.sqlite`
  (útil para desarrollo sin red).

## 4. Despliegue en Render (Web Service gratuito)

El repositorio incluye `render.yaml` para crear el servicio automáticamente.
También se puede crear a mano:

| Ajuste | Valor |
|---|---|
| Runtime | Node |
| Build command | `npm install && npm run build` |
| Start command | `npm start` |
| Health check path | `/api/health` |
| Disco persistente | No necesario |

Variables de entorno:

| Variable | Valor |
|---|---|
| `PANELAPP_DB_URL` | `libsql://...` (URL de Turso) |
| `PANELAPP_DB_AUTH_TOKEN` | token de Turso |
| `GEMINI_API_KEY` | clave de Google AI Studio |
| `GEMINI_MODEL` | `gemini-3.5-flash-lite` |
| `API_HOST` | `0.0.0.0` |
| `NODE_VERSION` | `24.20.0` |

Render inyecta `PORT`; el servidor lo usa automáticamente. Si la app y la API
se sirven desde el mismo dominio, deja `API_ALLOWED_ORIGINS` vacío.

### Crear el servicio desde el blueprint

1. En Render: **New → Blueprint**.
2. Conecta `https://github.com/gcbarrancolobo-png/PanelApp`.
3. Render lee `render.yaml` y pide los valores marcados con `sync: false`.
4. Aplica y espera el primer deploy.

## 5. Verificación posterior al despliegue

```bash
curl -s https://TU-DOMINIO/api/health
# {"ok":true,...,"storage":{"database":"turso","ready":true}}
```

- Abre `https://TU-DOMINIO/` → la app carga y se instala como PWA.
- Abre `https://TU-DOMINIO/verificar/CODIGO` → muestra la ficha del lote
  o el mensaje de código no encontrado (fallback SPA).
- Sincroniza un lote desde la app; el QR generado usa
  `window.location.origin`, así que apunta al dominio público automáticamente.
- Verifica un lote y comprueba que la ficha muestra cadenas consistentes y
  `serverCheckpointValid: true`.

## 6. Notas de seguridad

- `PANELAPP_SIGNING_KEY_PATH` solo aplica al modo SQLite local. En Turso la
  clave se guarda en `app_settings`; respalda la base para conservarla.
- El servidor no registra datos personales en `/api/verify`.
- No subas `.env`, `promt.txt` ni `sesiontranscript.txt` al repositorio: están
  excluidos en `.gitignore` porque contienen credenciales.
- Si un token se compartió por un canal inseguro, rótalo en Turso y actualiza
  `PANELAPP_DB_AUTH_TOKEN` en Render.
- Mantén `API_ALLOWED_ORIGINS` vacío salvo que la app se sirva desde otro
  dominio.
