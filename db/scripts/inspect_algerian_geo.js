const ag = require('algerian-geo');

console.log('Type:', typeof ag);
console.log('Keys:', Object.keys(ag));

// Try different API shapes
if (ag.wilayas) {
  const w = ag.wilayas;
  console.log('wilayas type:', typeof w, Array.isArray(w) ? 'len=' + w.length : '');
  if (Array.isArray(w) && w.length > 0) {
    console.log('Sample wilaya[0]:', JSON.stringify(w[0]));
    console.log('Sample wilaya[1]:', JSON.stringify(w[1]));
  }
}

if (ag.communes) {
  const c = ag.communes;
  console.log('communes type:', typeof c, Array.isArray(c) ? 'len=' + c.length : '');
  if (Array.isArray(c) && c.length > 0) {
    console.log('Sample commune[0]:', JSON.stringify(c[0]));
    console.log('Sample commune[1]:', JSON.stringify(c[1]));
  }
}

if (ag.getWilayas) {
  const w = ag.getWilayas();
  console.log('getWilayas():', Array.isArray(w) ? 'len=' + w.length : typeof w);
  if (Array.isArray(w) && w.length > 0) console.log('Sample:', JSON.stringify(w[0]));
}

if (ag.getCommunesByWilaya) {
  const c = ag.getCommunesByWilaya(16);
  console.log('getCommunesByWilaya(16):', Array.isArray(c) ? 'len=' + c.length : typeof c);
  if (Array.isArray(c) && c.length > 0) console.log('Sample commune for Alger:', JSON.stringify(c[0]));
}

// Try default export
if (ag.default) {
  console.log('default keys:', Object.keys(ag.default));
}
