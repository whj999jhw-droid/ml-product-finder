import { fetchBestSellersByCategory } from './mercadolibre.js';

async function main() {
  console.log('=== testing fetchBestSellersByCategory MLB1051 ===');
  const products = await fetchBestSellersByCategory('MLB', '巴西', { id: 'MLB1051', name: 'Celulares e Telefones' }, 0.19);
  console.log(`got ${products.length} products`);
  for (const p of products.slice(0, 5)) {
    console.log(`#${p.rank} ${p.title?.slice(0, 50)} | $${p.price} ${p.currency} | weight:${p.weight} | size:${p.length}x${p.width}x${p.height} | seller:${p.sellerName}`);
  }

  console.log('\n=== testing fetchBestSellersByCategory MLM1051 ===');
  const products2 = await fetchBestSellersByCategory('MLM', '墨西哥', { id: 'MLM1051', name: 'Celulares y Telefonía' }, 0.052);
  console.log(`got ${products2.length} products`);
  for (const p of products2.slice(0, 5)) {
    console.log(`#${p.rank} ${p.title?.slice(0, 50)} | $${p.price} ${p.currency} | weight:${p.weight} | size:${p.length}x${p.width}x${p.height} | seller:${p.sellerName}`);
  }
}

main().catch(console.error);
