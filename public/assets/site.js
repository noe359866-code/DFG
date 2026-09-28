const manifestUrl = new URL('/manifest.json', window.location.origin).href;
const input = document.getElementById('url');
input.value = manifestUrl;
const installLink = document.getElementById('install');
const host = window.location.host;
const isSecure = window.location.protocol === 'https:';
installLink.href = isSecure ? `stremio://${host}/manifest.json` : manifestUrl;
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
