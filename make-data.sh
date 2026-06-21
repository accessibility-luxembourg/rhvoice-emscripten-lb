#!/usr/bin/env bash
# (Re)build the servable data/ tree from the vendored sources:
#   - stage the Luxembourgish language data + Mil/Mia/slt voice packs,
#   - drop files the engine never reads (LICENSE / README / COPYRIGHT_NOTICE),
#   - gzip every file (the browser fetches <file>.gz and inflates it client-side
#     via DecompressionStream; the raw files are kept for the Node test),
#   - emit manifest.json describing the language set and each voice separately
#     so the loader can fetch only the voice that's actually used.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
V="$ROOT/vendor"
D="$ROOT/data"

EXCLUDES=(--exclude='.git' --exclude='.gitignore'
          --exclude='LICENSE' --exclude='README.md' --exclude='COPYRIGHT_NOTICE')

rm -rf "$D"
mkdir -p "$D/languages" "$D/voices"
rsync -a "${EXCLUDES[@]}" "$V/RHVoice-Luxembourgish-bin/" "$D/languages/Luxembourgish/"
rsync -a "${EXCLUDES[@]}" "$V/English/" "$D/languages/English/"
rsync -a "${EXCLUDES[@]}" "$V/RHVoice-Mil/"                "$D/voices/mil/"
rsync -a "${EXCLUDES[@]}" "$V/RHVoice-Mia/"                "$D/voices/mia/"
rsync -a "${EXCLUDES[@]}" "$V/slt-eng/"                "$D/voices/slt/"

echo "Gzipping files…"
find "$D" -type f ! -name '*.gz' -print0 | while IFS= read -r -d '' f; do
  gzip -9 -c "$f" > "$f.gz"
done

echo "Writing manifest.json…"
python3 - "$D" <<'PY'
import os, sys, json
root = sys.argv[1]
def rels(base):
    out = []
    for dp, _, fn in os.walk(os.path.join(root, base)):
        for f in fn:
            if f.endswith('.gz'):
                continue
            out.append(os.path.relpath(os.path.join(dp, f), root).replace(os.sep, '/'))
    return sorted(out)
manifest = {
    'language': rels('languages'),
    'voices': {v: rels(f'voices/{v}') for v in ('mil', 'mia', 'slt')},
}
with open(os.path.join(root, 'manifest.json'), 'w') as fh:
    json.dump(manifest, fh, indent=0)
n = len(manifest['language']) + sum(len(x) for x in manifest['voices'].values())
print(f'{n} files described')
PY

echo "Sizes (what a first run actually downloads = language.gz + one voice.gz):"
lang=$(find "$D/languages" -name '*.gz' -exec cat {} + | wc -c)
mia=$(find "$D/voices/mia" -name '*.gz' -exec cat {} + | wc -c)
mil=$(find "$D/voices/mil" -name '*.gz' -exec cat {} + | wc -c)
slt=$(find "$D/voices/slt" -name '*.gz' -exec cat {} + | wc -c)
awk -v l="$lang" -v a="$mia" -v m="$mil" -v s="$slt" 'BEGIN{
  mb=1048576;
  printf "  language gz: %5.1f MB\n  mia gz:      %5.1f MB\n  mil gz:      %5.1f MB\n slt gz:      %5.1f MB\n", l/mb, a/mb, m/mb, s/mb;
  printf "  => first run (language + Mil): %5.1f MB\n", (l+m)/mb;
}'
