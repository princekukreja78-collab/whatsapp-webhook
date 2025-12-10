import re,sys,os
p='server.cjs'
if not os.path.exists(p):
    print("server.cjs not found"); sys.exit(1)
s = open(p,'r',encoding='utf8').read()
open(p+'.fixbak','w',encoding='utf8').write(s)

# find all occurrences of const commonModelToBrand = { ... };
pattern = re.compile(r"const\s+commonModelToBrand\s*=\s*\{([\\s\\S]*?)\\};", re.M)
matches = pattern.findall(s)
if not matches:
    print("No commonModelToBrand block found — nothing to do.")
    sys.exit(0)

# parse key: value pairs from each block
entries = {}
for body in matches:
    # simple parser: find 'key': 'VALUE' pairs (handles single/double quotes)
    for m in re.finditer(r"['\"]([^'\"]+)['\"]\\s*:\\s*['\"]([^'\"]+)['\"]", body):
        k = m.group(1).strip()
        v = m.group(2).strip()
        entries[k] = v

# build merged block string (sorted keys for stability)
merged_lines = []
for k in sorted(entries.keys(), key=lambda x: x.lower()):
    merged_lines.append(f"    '{k}': '{entries[k]}',")
merged_block = "const commonModelToBrand = {\n" + "\\n".join(merged_lines) + "\n  };"

# replace the first occurrence with merged block, remove others
def replace_first_and_remove_others(text):
    # find start index of first match
    first = pattern.search(text)
    if not first:
        return text
    start, end = first.span()
    before = text[:start]
    after = text[end:]
    # remove other matches from 'after'
    after_clean = pattern.sub('', after)
    return before + merged_block + after_clean

new_s = replace_first_and_remove_others(s)

# sanity: ensure single occurrence now
if len(pattern.findall(new_s)) != 1:
    print("Warning: expected single merged block, found", len(pattern.findall(new_s)))
open(p,'w',encoding='utf8').write(new_s)
print("Merged commonModelToBrand entries and wrote", p, "(backup at server.cjs.fixbak)")
