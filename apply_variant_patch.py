import re, os, sys

fname = "server.cjs"
bak = fname + ".bak.variant_call"
if not os.path.exists(fname):
    print("ERROR: server.cjs not found in", os.getcwd()); sys.exit(1)

s = open(fname, "r", encoding="utf8").read()

# 1) Ensure findPriceColumnForCity helper exists (insert after detectExShowIdx)
if "function findPriceColumnForCity" not in s:
    m = re.search(r'function\s+detectExShowIdx\s*\([^)]*\)\s*\{', s)
    if m:
        # find end of detectExShowIdx block
        i = m.end()-1
        depth = 1
        L = len(s)
        while i < L - 1 and depth > 0:
            i += 1
            if s[i] == '{': depth += 1
            elif s[i] == '}': depth -= 1
        insert_pos = i+1
    else:
        # fallback: insert near top after header helpers (after toHeaderIndexMap)
        m2 = re.search(r'function\s+toHeaderIndexMap\s*\([^)]*\)\s*\{', s)
        if m2:
            i = m2.end()-1
            depth = 1
            L = len(s)
            while i < L - 1 and depth > 0:
                i += 1
                if s[i] == '{': depth += 1
                elif s[i] == '}': depth -= 1
            insert_pos = i+1
        else:
            insert_pos = 0

    helper = r'''
function findPriceColumnForCity(idxMap, cityToken, row) {
  const keys = Object.keys(idxMap || {});
  const cityLower = String(cityToken || '').toLowerCase();

  // 1) exact 'on road' + city substring
  for (const k of keys) {
    const kl = k.toLowerCase();
    if ((kl.includes('on road') || kl.includes('on-road') || kl.includes('onroad')) && kl.includes(cityLower)) {
      return idxMap[k];
    }
  }
  // 2) header contains city name (looser) with 'on' or 'road' or 'price'
  for (const k of keys) {
    const kl = k.toLowerCase();
    if (kl.includes(cityLower) && (kl.includes('on') || kl.includes('price') || kl.includes('road'))) {
      return idxMap[k];
    }
  }
  // 3) header contains state/city common abbreviations
  for (const k of keys) {
    const kl = k.toLowerCase();
    if ((kl.includes('chd') || kl.includes('chandigarh') || kl.includes('up') || kl.includes('delhi') || kl.includes('dl') || kl.includes('hr')) &&
        (kl.includes('on') || kl.includes('price') || kl.includes('road'))) {
      return idxMap[k];
    }
  }
  // 4) any header that looks like price/on-road or ex-showroom
  for (const k of keys) {
    const kl = k.toLowerCase();
    if (kl.includes('on road') || kl.includes('on-road') || kl.includes('onroad') || kl.includes('price') || kl.includes('ex-showroom') || kl.includes('ex showroom') || kl.includes('exshowroom')) {
      return idxMap[k];
    }
  }
  // 5) fallback: first numeric column in row
  for (let i = 0; i < (row || []).length; i++) {
    const v = String(row[i] || '').replace(/[,₹\\s]/g, '');
    if (v && /^\\d+$/.test(v)) return i;
  }
  return -1;
}
'''
    s = s[:insert_pos] + helper + s[insert_pos:]
    print("Inserted findPriceColumnForCity helper.")

# 2) Insert variant-list call after tokens line inside tryQuickNewCarQuote
tokens_pattern = r"(const\s+modelGuess\s*=\s*raw\.split\(' '\)\.slice\(0,\s*3\)\.join\(' '\);\s*\n\s*const\s+userNorm\s*=\s*normForMatch\(raw\);\s*\n\s*const\s+tokens\s*=\s*userNorm\.split\(' '\)\.filter\(Boolean\);)"
if re.search(r"tryVariantListForModel\s*\(", s):
    # check if call already inserted
    if "variantListDone = await tryVariantListForModel" not in s and "tryVariantListForModel(" in s:
        # find tokens spot
        m = re.search(tokens_pattern, s)
        if m:
            insert_after = m.end()
            insertion = r'''
    // If user only typed the model name (or a short phrase), show a variant list first
    try {
      const variantListDone = await tryVariantListForModel({ tables, brandGuess, city, profile, raw, to });
      if (variantListDone) return true;
    } catch (err) {
      if (DEBUG) console.warn('tryVariantListForModel failed', err && err.message ? err.message : err);
    }
'''
            s = s[:insert_after] + insertion + s[insert_after:]
            print("Inserted variant-list invocation after tokens.")
        else:
            print("Could not find the precise tokens line to insert after. Please check file and run manual insert.")
    else:
        print("Variant-list call already present or tryVariantListForModel referenced elsewhere.")
else:
    # If tryVariantListForModel not found at all, still insert the variant call at tokens spot (safe)
    m = re.search(tokens_pattern, s)
    if m:
        insert_after = m.end()
        insertion = r'''
    // If user only typed the model name (or a short phrase), show a variant list first
    try {
      const variantListDone = await tryVariantListForModel({ tables, brandGuess, city, profile, raw, to });
      if (variantListDone) return true;
    } catch (err) {
      if (DEBUG) console.warn('tryVariantListForModel failed', err && err.message ? err.message : err);
    }
'''
        s = s[:insert_after] + insertion + s[insert_after:]
        print("Inserted variant-list invocation after tokens (tryVariantListForModel not found earlier).")
    else:
        print("Could not find tokens line; manual insertion required.")

# backup & write
open(bak, "w", encoding="utf8").write(open(fname,"r",encoding="utf8").read())
open(fname, "w", encoding="utf8").write(s)
print("Backup written to", bak)
