import re, sys, os
fname = "server.cjs"
bak = fname + ".bak.variant_debug"
if not os.path.exists(fname):
    print("ERROR: server.cjs not found in", os.getcwd()); sys.exit(1)

s = open(fname, "r", encoding="utf8").read()

old = "const variantListDone = await tryVariantListForModel({ tables, brandGuess, city, profile, raw, to });"
if old not in s:
    print("ERROR: exact invocation line not found. Aborting. (file may use slightly different whitespace)")
    # show nearby lines to help
    idx = s.find("tryVariantListForModel")
    if idx != -1:
        start = max(0, idx-200)
        print("Context:", s[start:start+400].replace('\\n','\\n'))
    sys.exit(2)

new = (
"if (DEBUG) console.log('➡️ tryVariantListForModel called', { raw: String(raw).slice(0,120), tokens: (userNorm||'').split(' ').filter(Boolean) });\\n"
+ "try {\\n"
+ "  const variantListDone = await tryVariantListForModel({ tables, brandGuess, city, profile, raw, to });\\n"
+ "  if (DEBUG) console.log('⬅️ tryVariantListForModel returned', { variantListDone });\\n"
+ "  if (variantListDone) return true;\\n"
+ "} catch (err) {\\n"
+ "  if (DEBUG) console.warn('tryVariantListForModel failed', err && err.message ? err.message : err);\\n"
+ "}"
)

# Replace the first occurrence only
s2 = s.replace(old, new, 1)
open(bak, "w", encoding="utf8").write(s)
open(fname, "w", encoding="utf8").write(s2)
print("Patched file and wrote backup to", bak)
