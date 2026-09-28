const manifestUrl = new URL('/manifest.json', window.location.origin).href;
const input = document.getElementById('url');
input.value = manifestUrl;
document.getElementById('install').href = `stremio://${window.location.host}/manifest.json`;
document.getElementById('copy').addEventListener('click', async () => {
  const feedback = document.getElementById('feedback');
  try {
    await navigator.clipboard.writeText(manifestUrl);
    feedback.textContent = 'Enlace copiado. Pégalo en Complementos de Stremio.';
  } catch (_) {
    document.querySelector('details').open = true;
    input.focus();
    input.select();
    feedback.textContent = 'No se pudo copiar automáticamente. Copia el enlace seleccionado.';
  }
});
