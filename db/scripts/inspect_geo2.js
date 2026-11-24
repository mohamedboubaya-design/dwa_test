const ag = require('algerian-geo');
const w = ag.getAllWilayas();
console.log('Total wilayas:', w ? w.length : 'undef');
if (w && w.length > 0) {
  console.log('Wilaya[0]:', JSON.stringify(w[0]));
  console.log('Wilaya[1]:', JSON.stringify(w[1]));
  console.log('Wilaya[15]:', JSON.stringify(w[15]));
}
// Check commune structure more
const c = ag.getCommunesByWilaya('16');
console.log('Communes for 16 (Alger):', c.length);
console.log('Sample:', JSON.stringify(c[0]));

// Check available wilaya IDs
console.log('All wilaya IDs:', w.map(x => x.id).join(','));
