const XLSX = require('xlsx');
const path = require('path');

const filePath = path.resolve(__dirname, '../../database/seeds/clean_NOMENCLATURE.VERSION.AOUT_.2026-.xlsx');
console.log('Reading:', filePath);

const wb = XLSX.readFile(filePath);
console.log('Sheets:', wb.SheetNames);

const ws = wb.Sheets[wb.SheetNames[0]];
const range = XLSX.utils.decode_range(ws['!ref']);
console.log('Range:', ws['!ref'], 'Total rows:', range.e.r + 1, 'Cols:', range.e.c + 1);

// Print rows 0-20 to see header location
const data = XLSX.utils.sheet_to_json(ws, { header: 1 });
for (let i = 0; i < Math.min(22, data.length); i++) {
  console.log(`Row ${i}:`, JSON.stringify(data[i]));
}

// Also show rows around 15-18 more clearly
console.log('\n--- Around row 15-18 (potential header area) ---');
for (let i = 13; i < Math.min(20, data.length); i++) {
  console.log(`Row ${i}:`, JSON.stringify(data[i]));
}

// Show a few data rows after potential header
console.log('\n--- Sample data rows 16-25 ---');
for (let i = 16; i < Math.min(26, data.length); i++) {
  console.log(`Row ${i}:`, JSON.stringify(data[i]));
}

console.log('\n--- Last 3 rows ---');
for (let i = Math.max(0, data.length - 3); i < data.length; i++) {
  console.log(`Row ${i}:`, JSON.stringify(data[i]));
}
