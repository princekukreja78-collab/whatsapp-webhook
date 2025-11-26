import os, sys, re

fname = "server.cjs"
bak = fname + ".bak.fix_debug_syntax"

if not os.path.exists(fname):
    print("ERROR: server.cjs not found in", os.getcwd())
    sys.exit(1)

txt = open(fname, "r", encoding="utf8").read()

# The broken literal block (contains backslash-n sequences) inserted previously.
# We'll look for the marker line that starts with the debug call with literal \n sequences.
bad_marker = "if (DEBUG) console.log('➡️ tryVariantListForModel called', { raw: String(raw).slice(0,120), tokens: (userNorm||'').split(' ').filter(Boolean) });\\ntry {\\n  const variantListDone = await tryVariantListForModel({ tables, brandGuess, city, profile, raw, to });\\n  if (DEBUG) console.log('⬅️ tryVariantListForModel returned', { variantListDone });\\n  if (variantListDone) return true;\\n} catch (err) {\\n  if (DEBUG) console.warn('tryVariantListForModel failed', err && err.message ? err.message : err);\\n}"

if bad_marker not in txt:
    # As a fallback, try to find approximate area and show context for manual fix
    idx = txt.find("tryVariantListForModel")
    if idx == -1:
        print("Could not find inserted debug block or tryVariantListForModel token. Nothing changed.")
        sys.exit(2)
    start = max(0, idx-200)
    print("Found tryVariantListForModel near position", idx)
    print("Context (200 chars before → 200 chars after):")
    print(txt[start:start+400])
    sys.exit(3)

fixed_block = (
"if (DEBUG) console.log('➡️ tryVariantListForModel called', { raw: String(raw).slice(0,120), tokens: (userNorm||'').split(' ').filter(Boolean) });\n"
"try {\n"
"  const variantListDone = await tryVariantListForModel({ tables, brandGuess, city, profile, raw, to });\n"
"  if (DEBUG) console.log('⬅️ tryVariantListForModel returned', { variantListDone });\n"
"  if (variantListDone) return true;\n"
"} catch (err) {\n"
"  if (DEBUG) console.warn('tryVariantListForModel failed', err && err.message ? err.message : err);\n"
"}\n"
)

# Replace only the first occurrence
new_txt = txt.replace(bad_marker, fixed_block, 1)

open(bak, "w", encoding="utf8").write(txt)
open(fname, "w", encoding="utf8").write(new_txt)
print("Fixed file written. Backup saved to", bak)
