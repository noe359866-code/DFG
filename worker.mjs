// Punto de entrada ESM para Wrangler; la implementación vive en worker.js
// (CommonJS, para que las pruebas y el servidor local puedan require()rla).
import worker from './worker.js';

export default worker;
