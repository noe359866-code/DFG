require('dotenv').config();
const app = require('./app');
if (require.main === module) {
  app.listen(process.env.PORT || 7000, '0.0.0.0', () => console.log('Nexo Play 1.2.2 listo'));
}
module.exports = app;
