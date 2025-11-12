const fs = require('fs');
let code = fs.readFileSync('server.cjs', 'utf8');

if (!code.includes('Quick quote reply')) {
  code = code.replace(
    /Variant matched reason: full-row-match[^\n]*\n/g,
    `Variant matched reason: full-row-match\\n` +
    `      // === Quick quote reply (patched) ===\\n` +
    `      const variant = msg.text || '';\\n` +
    `      const quoteBody = '✅ *Quick Quote* for ' + variant + '\\n' +` +
    `        'Ex-Showroom: ₹' + (matchedRow?.['Ex Showroom Price'] || matchedRow?.['EX SHOWROOM PRICE'] || 'NA') + '\\n' +` +
    `        'On-Road: ₹' + (matchedRow?.['On Road Price'] || matchedRow?.['ON ROAD PRICE'] || 'NA') + '\\n' +` +
    `        'Est. EMI (60M @8.1%): ₹' + Math.round(((matchedRow?.['On Road Price']||0)*0.0204)||0) + '/mo';\\n` +
    `      console.log('Quick quote composed:', quoteBody);\\n` +
    `      await waSendText(from, quoteBody);\\n`
  );
  fs.writeFileSync('server.cjs', code);
  console.log('✅ Patch applied successfully: quick quote restored.');
} else {
  console.log('Already patched or custom quick quote present.');
}
