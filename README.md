# PanelApp

PanelApp es una PWA académica para que pequeños productores paneleros practiquen una revisión sanitaria guiada. El checklist y los ejemplos son datos sintéticos/de referencia; la herramienta no representa una inspección oficial.

## Supuestos de esta entrega

- Esta entrega implementa las Fases 1 a 6: perfil, auditoría, PWA/offline, bitácoras, voz, alertas, asesor, panel experto, trazabilidad, sellos, sincronización, pruebas automáticas, accesibilidad y despliegue.
- La Fase 3 agrega bitácoras locales, captura y extracción de voz con confirmación, y alertas deterministas.
- La Fase 4 agrega búsqueda local sin conexión, asesor conversacional respaldado solo por requisitos y fragmentos de los PDF locales, y validación de checklist guardada en IndexedDB.
- Las bitácoras se crean y sellan localmente. Al reconectar, el servidor Node las sincroniza en SQLite y ofrece verificación pública de lotes.
- La Fase 6 agrega: suite de pruebas `npm test` (motor de puntaje y alertas contra las 5 fincas demo, determinismo, sellos de la Fase 5, y escaneo del build sin URLs locales), ajustes de accesibilidad (contraste AA en textos grises, tipografía mínima de 12 px, botón de marca accesible por teclado) y despliegue como servicio único (ver `DEPLOY.md`).
- El PDF de resultados se obtiene con **Imprimir o guardar PDF** del navegador.
- Los archivos adjuntos se copiaron a `data/`; el checklist activo se amplió y versionó, sin alterar los archivos originales de Descargas.

## Ejecutar localmente

Requisitos: Node.js 22.5 o posterior y npm. El servidor usa `@libsql/client` y puede trabajar contra Turso (nube) o SQLite local.

```sh
npm install
npm run dev
```

Abre la URL local que muestra Vite. Para compilar y servir la versión de producción:

```sh
npm run build
npm run preview
```

Para iniciar la Fase 3, abre dos ventanas de PowerShell en la carpeta del proyecto. En la primera configura el servidor local (las claves se quedan en `.env`, solo en el backend):

```powershell
Copy-Item .env.example .env
notepad .env
npm run server
```

En `.env`, completa `GEMINI_API_KEY` desde Google AI Studio. La misma clave se usa en el servidor para transcribir audios y extraer campos con `gemini-3.5-flash-lite` mediante la Interactions API. El audio se envía inline codificado en base64; el navegador nunca recibe la clave. Si no configuras la clave, formularios, grabación local, sellos y trazabilidad siguen disponibles; las funciones IA muestran un aviso. No compartas ni publiques el archivo `.env`.

En Chrome móvil, el permiso de micrófono requiere que la app se abra por HTTPS. `http://localhost` es seguro en el mismo computador, pero una dirección de red local como `http://192.168.x.x:5173` no sirve para grabar desde el teléfono. Para probar voz en teléfono hace falta un origen HTTPS y conceder permiso al micrófono. Para desarrollo, se puede publicar temporalmente el Vite local con un túnel HTTPS, por ejemplo `cloudflared tunnel --url http://localhost:5173`; abre en el teléfono la URL `https://...trycloudflare.com` que imprima el comando. Mantén ejecutándose tanto el servidor API (`npm run server`) como Vite (`npm run dev`).

En la segunda ventana inicia Vite:

```powershell
npm run dev
```

Abre la URL local que muestra Vite. El servidor de desarrollo reenvía `/api` al backend local. Mantén ambos procesos activos para que funcionen la sincronización y la verificación pública.

Para ejecutar todas las pruebas (Fase 6: motor de puntaje/alertas sobre las 5 fincas demo + integración de la Fase 5):

```powershell
npm test
```

Solo la suite de integración de la Fase 5:

```powershell
npm run test:phase5
```

## Despliegue

La Fase 6 despliega **un único servicio Node.js** que sirve la app compilada (`dist/`), la API `/api/*` y el fallback SPA para `/verificar/:codigo`, detrás de HTTPS. La persistencia vive en **Turso (libSQL en la nube)**, por lo que no se necesita disco persistente. Los pasos para Turso y Render (`render.yaml`, variables de entorno y `API_HOST=0.0.0.0`) están en `DEPLOY.md`. Los QR se generan con `window.location.origin`, así que funcionan sin cambios en el dominio público.

## Datos de entrada

- `data/checklists/checklist_panela.json`: checklist versionado (98 requisitos); se validan los campos y los identificadores al iniciar.
- `data/sinteticos/fincas_demo_panela.json`: 5 establecimientos ficticios.
- `data/prompts/prompts_sistema_ia.md`: prompts para fases posteriores.
- `data/normativa/`: PDFs proporcionados.

Los datos JSON se publican también bajo `public/data/` para que Vite, el navegador y el service worker los carguen. Los PDF fuente permanecen en `data/normativa/` y no se precargan en el móvil por su tamaño. El checklist activo añade 25 requisitos BPM de la Resolución 2674/2013 y 5 requisitos ambientales condicionales. El estado preparado y sus umbrales son simulación de PanelApp; el artículo 20 de la Resolución 779 no fija porcentajes.

El asesor extrae texto de los PDF relevantes bajo `data/normativa/` en el servidor, selecciona pasajes relacionados con la pregunta y envía solo esos pasajes y los requisitos encontrados a Gemini. El log del backend registra IDs de requisitos y páginas de PDF, sin guardar la pregunta ni datos de perfil. Sin internet, la búsqueda usa el checklist local. El asesor no promete respuestas si las fuentes no traen la información.

El selector de roles permite recorrer la app como Productor, Experto validador o Evaluador de solo lectura. Es un control académico local, no autenticación: no se usa para proteger información en un despliegue público.

## Arquitectura

```text
Navegador (React + TypeScript + Vite)
  ├─ Interfaz accesible y responsive (Tailwind + CSS)
  ├─ Motor local: aplicabilidad → auditoría → puntuación → brechas
  ├─ IndexedDB (Dexie): historial, bitácoras, cambios expertos, sellos y cola local
  ├─ Service Worker (vite-plugin-pwa): shell y recursos en caché
  ├─ /data: checklist, fincas ficticias, prompts y normativa
  ├─ Búsqueda offline del asesor: requisitos del checklist en memoria
  ├─ SHA-256 WebCrypto: cadenas por establecimiento y dispositivo
  └─ API Node + libSQL/Turso: sincronización append-only, LWW de perfil y verificación pública firmada
```

### Modelo local actual

- `profiles`: preparada para perfiles locales (id, nombre).
- `audits`: id, fecha, establecimiento, perfil, respuestas, puntajes.
- Requisitos de checklist: JSON de solo lectura, no se modifican.
- `logs`: bitácoras append-only locales con `recordId`, dispositivo, secuencia, hash anterior, hash y estado de sync.
- `settings`: identificador local del dispositivo.
- `syncProfiles`: ID de establecimiento y token privado de sincronización.
- `voiceNotes`: audio guardado en el dispositivo con estado pendiente, transcrito o confirmado.
- `expertReviews`: cambios append-only de estado y observación, con autor y fecha.
- `checklistOverrides` / `checklistVersions`: copia activa local y registro de versiones cargadas; el JSON fuente no se modifica.

### Fase 5 · lotes, sellos y sincronización

- Una molienda con código de lote crea la raíz local de trazabilidad. En **Lote o lotes de caña de origen**, escribe los códigos anotados en las cosechas, separados por punto y coma. Análisis y despachos se enlazan por el mismo código de lote de panela.
- Cada bitácora nueva se sella con SHA-256 sobre contenido estable, hash anterior y número de secuencia. Las cadenas son independientes por establecimiento y dispositivo para permitir capturas offline concurrentes. Las bitácoras antiguas sin sello se migran al final de la cadena local sin alterar los eslabones ya sellados.
- “Sincronizar ahora” sube hasta 200 bitácoras pendientes y descarga registros de otros dispositivos por páginas. El servidor valida hashes y guarda bitácoras inmutables en SQLite. Las correcciones conservan el anterior. Perfil y auditorías se resuelven por `updatedAt`; si dos cambios tienen la misma fecha, se desempata por ID del dispositivo. La app avisa cuando un cambio local fue reemplazado por otro más reciente y rechaza cadenas incompletas o fuera de orden.
- La clave para vincular otro dispositivo se descarga como `panelapp-vinculo-privado.json`. Pásala únicamente por un canal privado e impórtala en el segundo equipo, con el mismo nombre de establecimiento, antes de crear allí bitácoras. Ese archivo funciona como credencial; no lo publiques ni lo incluyas en el QR.
- La verificación pública se habilita después de sincronizar. La URL contiene un código aleatorio y la ficha publica campos seleccionados, no responsables, comprador, predio ni laboratorio. La ficha muestra por separado el resultado de las cadenas SHA-256 y la firma del checkpoint Ed25519. Mientras un lote tenga registros pendientes, la PWA indica cuántos faltan y no muestra el QR.
- “Imprimir ficha o guardar PDF” abre el diálogo de impresión. “Exportar para Excel” descarga un CSV UTF-8 compatible con Excel. Para que el QR funcione fuera de la red local, la app publicada debe tener HTTPS y acceso público al servidor.
- El servidor crea `data/panelapp.sqlite` y `data/.panelapp-signing-private.pem` al iniciar. Ambos se excluyen de Git; respáldalos juntos. Si se pierde la llave privada, los checkpoints anteriores dejarán de verificarse.
- No hay cuentas de usuario todavía. Antes de usar datos reales en producción, configura HTTPS, controles de acceso y políticas de retención y copias de seguridad en la Fase 6.

### Tablas SQLite del servidor

- `establishments`: perfil y hash del token privado; guarda el último perfil por `updatedAt`.
- `log_records`: eventos inmutables con secuencia por dispositivo, hash y fecha de aceptación.
- `lots`: código interno asociado a un código público aleatorio para el QR.
- `synced_entities`: perfil/auditorías y otros datos sincronizables con regla de último cambio.
- `pending_references`: correcciones que llegaron antes que su registro original; impide que otro establecimiento resuelva una referencia ajena.

## Guion de demostración de 5 minutos

1. **0:00–0:40** — Explica el problema rural y muestra el aviso de alcance en la pantalla inicial.
2. **0:40–1:20** — Abre “Modo demostración” y elige una finca ficticia.
3. **1:20–2:30** — Recorre categorías y contesta Cumple / En parte / No cumple / No aplica. Muestra fuentes y acciones sugeridas.
4. **2:30–3:30** — Abre resultados; explica puntajes por criticidad, brechas priorizadas y que los umbrales son una propuesta de simulación.
5. **3:30–4:15** — Imprime o guarda el informe PDF y enseña el aviso permanente.
6. **4:15–5:00** — Registra molienda con código y lote de caña de origen. Muestra el sello, la sincronización, el QR y la ficha imprimible; compara el CSV en Excel.

## PWA y límites

La caché precarga la interfaz y los datos JSON durante la primera visita online. IndexedDB guarda el historial en el dispositivo. El soporte offline no puede garantizar la primera visita si el usuario nunca abrió la app con internet. La exportación PDF depende del diálogo de impresión del navegador. Acerca del proyecto muestra las fuentes normativas verificadas y los límites del checklist.

La regla de preparado es una propuesta de simulación, no una regla oficial. Revisar contenido normativo con profesionales y autoridades competentes antes de cualquier uso operativo.

