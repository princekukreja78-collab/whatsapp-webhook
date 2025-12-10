import io,sys,os,re
p='server.cjs'
if not os.path.exists(p):
    print("server.cjs not found in cwd"); sys.exit(1)
s=open(p,'r',encoding='utf8').read()
open(p+'.debugbak','w',encoding='utf8').write(s)

# 1) Ensure commonModelToBrand contains fortuner/legender/hycross mapping
# Find the commonModelToBrand block if present, else insert one after brandAliasMap declaration
cm_re = re.compile(r"(const commonModelToBrand\s*=\s*\{)([\\s\\S]*?)(\\};)", re.M)
if cm_re.search(s):
    def add_entries(m):
        body = m.group(2)
        additions = "\\n    'fortuner': 'TOYOTA',\\n    'legender': 'TOYOTA',\\n    'hycross': 'TOYOTA',\\n"
        if 'fortuner' not in body:
            body = additions + body
        return m.group(1)+body+m.group(3)
    s = cm_re.sub(add_entries, s, count=1)
else:
    # find "const brandAliasMap =" and insert a new commonModelToBrand block right after
    s = re.sub(r"(const brandAliasMap\s*=\s*\{\s*\};?|const brandAliasMap\s*=\s*\{\s*)",
               r"\1\n\n  const commonModelToBrand = {\n    'fortuner': 'TOYOTA',\n    'legender': 'TOYOTA',\n    'hycross': 'TOYOTA'\n  };\n",
               s, count=1)

# 2) Insert safety fallback after the allowedBrandSet finalize block if not present
fallback_snip = "\n  // Safety fallback: if a Set was created but ended up empty, treat as ALL (null)\n  if (allowedBrandSet && allowedBrandSet.size === 0) {\n    if (DEBUG) console.log(\"allowedBrandSet empty -> switching to ALL (null) fallback\");\n    allowedBrandSet = null;\n  }\n"
if 'allowedBrandSet empty' not in s and 'allowedBrandSet && allowedBrandSet.size === 0' not in s:
    # try to locate the finalize comment and place fallback right after it
    s = re.sub(r"(Finalise allowedBrandSet: prefer explicit detected brands[\\s\\S]*?allowedBrandSet = null;)",
               r"\1" + fallback_snip, s, count=1)

open(p,'w',encoding='utf8').write(s)
print("patched",p,"(backup at server.cjs.debugbak)")
