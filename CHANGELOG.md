# Historial de cambios

## 1.2.3 — 2026-09-27

### Rendimiento
- La página de instalación y los archivos de `assets/` se sirven como archivos estáticos: el CDN de Vercel los entrega sin invocar la función serverless. La portada deja de consumir invocaciones con cada visita.
- `/assets/` anuncia un día de `Cache-Control` también en el edge (antes el día de caché solo aplicaba al navegador del visitante).
- `/manifest.json` se cachea cinco minutos en el edge con `stale-while-revalidate` de una hora: las oleadas de instalación tras una publicación en el catálogo no se traducen en una invocación por cada descarga.

## 1.2.2 — 2026-09-27

### Verificación
- El manifiesto público incluye `stremioAddonsConfig` con el emisor y la firma emitidos por stremio-addons.net. La configuración viaja en `/manifest.json` para todo el mundo, sin depender de archivos ni variables locales.

## 1.2.1 — 2026-09-27

### Identidad
- Nuevo nombre Nexo Play, adecuado para contenido en español e inglés.
- Descripción pública sin referencias a la base de datos o infraestructura.
- Imagen original generada con IA, alojada en el propio despliegue.
- Nueva página adaptable a móviles, con instalación y copia de enlace accesible.

### Correcciones
- Los archivos en inglés ya no se etiquetan por defecto como españoles.
- Audio, subtítulos y calidad desconocidos no se inventan.
- Validación estricta de IDs y episodios; soporte de temporada cero.
- Lectura de hashes BTIH base32 y hexadecimal, descarte de magnets inválidos.
- Eliminación de streams duplicados y respeto del índice de archivo.
- Tamaños con coma decimal, cero y valores inválidos.
- Rutas reescritas de Vercel, incluidos manifiesto, streams e imagen.
- Sin interpolar cabeceras HTTP en HTML o JavaScript.
- Recuperación cuando el navegador no permite copiar al portapapeles.

### Mantenimiento
- Aplicación HTTP compartida entre local y Vercel.
- Consultas con timeout de ocho segundos, nulos al final y caché HTTP de 120 segundos para resultados correctos.
- Actualización de dependencias vulnerables y dotenv disponible en producción.
- Diez pruebas automatizadas unitarias y HTTP.

Las pruebas utilizan datos simulados: la reproducción y la conexión con la base real requieren validación en el despliegue configurado.
