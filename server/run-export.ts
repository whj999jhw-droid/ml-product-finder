import { fetchAllProductsAndExport } from './mercadolibre.js';

const start = Date.now();
fetchAllProductsAndExport(['MLM', 'MLB'], (p) => {
  const t = ((Date.now() - start) / 1000).toFixed(0);
  console.log(`[${t}s] ${p.phase} ${p.site || ''} ${p.category || ''} - ${p.message}`);
}).then((r) => {
  console.log('\n=== EXPORT DONE ===');
  console.log('filePath:', r.filePath);
  console.log('fileName:', r.fileName);
  console.log('totalCount:', r.totalCount);
  console.log('siteStats:', JSON.stringify(r.siteStats));
}).catch((e) => {
  console.error('EXPORT ERROR:', e);
  process.exit(1);
});
