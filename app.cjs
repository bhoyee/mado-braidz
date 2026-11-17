// Passenger loads its startup file using require(). Keep this small CommonJS
// bridge while the application itself uses native ES modules.
import('./src/server.js').catch((error) => {
  console.error('Mado application startup failed:', error.message);
  process.exit(1);
});
