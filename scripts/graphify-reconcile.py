"""Reconcile dangling edge endpoints before graph build.

Two causes, two fixes:
  1. The AST extractor emits `imports` edges to external modules (ref_react,
     ref_next, sys, ...) but never creates target nodes -> materialize them as
     external dependency nodes. Safe and mechanical.
  2. Semantic subagents guess IDs for entities owned by another chunk -> remap
     onto the real node, but ONLY on strong evidence.

Rule 2 is deliberately strict. An earlier permissive version mapped
`..._e7_abstract_background_grain` onto `..._e1_demo_video_recipe` purely because
they shared a file stem, which fabricates a relationship that does not exist.
Fabricating an edge is worse than dropping one, so anything that does not clear
the bar below is LEFT dangling and the build drops it.

Bar for a remap:
  - candidate must come from the same source_file as the referencing edge, and
  - if either side carries an archetype code (e1, h4, s1, ft3, n10, c4, t1...),
    the codes must be identical, and
  - Jaccard overlap of the entity tokens must be >= 0.8 (near-identity).

The 0.8 bar is deliberate. At 0.5 the only match it produced crossed files
(`references_hero_enrichment` -> `references_slop_test_hero_enrichment_gates`),
which is a different concept. Genuine cross-chunk misses are better fixed by
re-extracting the owning file with the real ID list supplied.
"""
import json, re, sys
from pathlib import Path
from collections import defaultdict

PY_STDLIB = {'sys', 're', 'zipfile', 'xml_etree', 'os', 'json', 'pathlib', 'typing',
             'datetime', 'collections', 'glob', 'math', 'subprocess', 'argparse',
             'io', 'csv', 'hashlib'}

# Hand-verified aliases. Each target was confirmed by reading its label in the
# extraction, not fuzzy-matched. Most exist because a re-extraction prompt supplied
# an invented cross-file ID whitelist; the subagent used it faithfully and the ids
# never existed. Fixing it here is cheaper than another extraction pass.
ALIASES = {
    'references_slop_test_gate_54':
        'references_slop_test_gate_54_tag_left_header_right',
    'references_slop_test_gate_38a':
        'references_slop_test_gate_38a_italic_headings',
    'components_h1_marquee_h1_marquee':
        'components_h1_marquee_marquee',
    'components_h3_quote_led_h3_quote_led':
        'components_h3_quote_led_quote_led',
    'components_h4_stat_led_h4_stat_led':
        'components_h4_stat_led_stat_led',
    'components_s1_left_margin_numbered_left_margin_numbered':
        'components_s1_left_margin_numbered_s1_left_margin_numbered',
    'references_hero_enrichment_e1_clipped_edge_demo_video':
        'references_hero_enrichment_e1_clipped_video',
    'references_hero_enrichment_e7_abstract_background_grain':
        'references_hero_enrichment_e7_abstract_background',
    'follow_ups_phase_7_superuser_dashboard':
        'follow_ups_phase7_superuser_dashboard',
    'design_working_palette':
        'design_palette',
}

CODE_RE = re.compile(r'^(e|h|s|n|ft|c|t|f)[0-9]+[a-z]?$')

def toks(i):
    return i.split('_')

def archetype_code(tokens):
    for t in tokens:
        if CODE_RE.match(t):
            return t
    return None

def jaccard(a, b):
    sa, sb = set(a), set(b)
    if not sa or not sb:
        return 0.0
    return len(sa & sb) / len(sa | sb)

def normfile(f):
    return Path(str(f).replace(chr(92), '/')).as_posix().lower() if f else ''

def reconcile(extraction, verbose=True):
    nodes = extraction['nodes']
    edges = extraction['edges']
    ids = {n['id'] for n in nodes}

    file_ids = defaultdict(list)
    for n in nodes:
        file_ids[normfile(n.get('source_file'))].append(n['id'])

    dangling = defaultdict(list)
    for e in edges:
        for k in ('source', 'target'):
            if e[k] not in ids:
                dangling[e[k]].append(e)

    remap, materialized, unresolved = {}, [], []
    for d, refs in dangling.items():
        if d.startswith('ref_') or d in PY_STDLIB:
            name = d[4:] if d.startswith('ref_') else d
            materialized.append({
                'id': d,
                'label': name.replace('_', '-') + ' (external)',
                'file_type': 'code',
                'source_file': None, 'source_location': None,
                'source_url': None, 'captured_at': None,
                'author': None, 'contributor': None,
            })
            continue

        if d in ALIASES and ALIASES[d] in ids:
            remap[d] = (ALIASES[d], 1.0)
            continue

        dt = toks(d)
        dcode = archetype_code(dt)
        pool = set()
        for e in refs:
            pool.update(file_ids.get(normfile(e.get('source_file')), []))

        best, best_j = None, 0.0
        for r in pool:
            rt = toks(r)
            rcode = archetype_code(rt)
            if dcode is not None and rcode is not None and dcode != rcode:
                continue
            if (dcode is None) != (rcode is None):
                continue
            j = jaccard(dt, rt)
            if j > best_j:
                best, best_j = r, j
        if best is not None and best_j >= 0.8:
            remap[d] = (best, best_j)
        else:
            unresolved.append((d, len(refs)))

    n_ref = 0
    flat = {k: v[0] for k, v in remap.items()}
    for e in edges:
        for k in ('source', 'target'):
            if e[k] in flat:
                e[k] = flat[e[k]]
                n_ref += 1
    for h in extraction.get('hyperedges', []):
        h['nodes'] = [flat.get(x, x) for x in h.get('nodes', [])]

    extraction['nodes'] = nodes + materialized
    before = len(edges)
    extraction['edges'] = [e for e in edges if e['source'] != e['target']]
    selfloops = before - len(extraction['edges'])

    if verbose:
        recovered = sum(len(dangling[m['id']]) for m in materialized)
        print('  materialized ' + str(len(materialized)) + ' external dependency nodes ('
              + str(recovered) + ' edges recovered)')
        print('  remapped ' + str(len(remap)) + ' guessed ids (' + str(n_ref)
              + ' edge endpoints recovered)')
        for k, (v, j) in sorted(remap.items(), key=lambda x: -x[1][1]):
            print('      ' + k)
            print('        -> ' + v + '   (jaccard ' + format(j, '.2f') + ')')
        print('  dropped ' + str(selfloops) + ' self-loops introduced by remapping')
        print('  left ' + str(len(unresolved)) + ' ids unresolved ('
              + str(sum(c for _, c in unresolved)) + ' refs dropped by design)')
        for d, c in sorted(unresolved, key=lambda x: -x[1])[:12]:
            print('      ' + str(c).rjust(3) + '  ' + d)
    return extraction

if __name__ == '__main__':
    ex = json.loads(Path(sys.argv[1]).read_text(encoding='utf-8'))
    print('before: ' + str(len(ex['nodes'])) + ' nodes, ' + str(len(ex['edges'])) + ' edges')
    ex = reconcile(ex)
    print('after:  ' + str(len(ex['nodes'])) + ' nodes, ' + str(len(ex['edges'])) + ' edges')
    if len(sys.argv) > 2:
        Path(sys.argv[2]).write_text(json.dumps(ex, indent=2, ensure_ascii=False), encoding='utf-8')
        print('written -> ' + sys.argv[2])
