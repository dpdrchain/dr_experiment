#!/usr/bin/env python3
"""Build the participant links from the private link-code table.

Reads <private-dir>/link_codes_private.csv (made by make_link_codes.py) and
writes the links, one per row, to a PRIVATE file in the same folder:

  links_private.csv                     all rows
  links_private_<phase>_<group>_<lang>.csv   with filters and/or --lang
                                        (only the parts given, e.g.
                                        links_private_pilot_ja.csv)

with the columns link_id, phase, group, slot, pid, tester, link. A link is

  <base-url>?code=<code>             or, with --lang,
  <base-url>?code=<code>&lang=ja

SHORT TEST LINKS (--dev-short N): for test codes only, links to the short
test session on dev.html (SETUP.md, "Short test links"):

  <base-url>dev.html?code=<code>&lang=ja&preset=short&n=N

written to links_private_test[_<group>][_<lang>]_short<N>.csv. --dev-short
selects the test rows by itself and refuses --phase pilot or main.

Never commit these files: they hold the codes. The same safety rules as
make_link_codes.py apply (this script reuses its reading and checks): the
private folder must be outside this repository; links are printed only
with --show; tables saved by Excel or Numbers are read.

Usage (Python 3.8+, standard library only):

  python3 tools/make_links.py --private-dir DIR --base-url URL
          [--lang ja|en] [--phase test|pilot|main] [--group participant|control]
          [--public-file FILE] [--dev-short N] [--show]

--public-file: before writing, check that every selected code opens its
entry in that public file with the same link_id, phase, group and slot.
See SETUP.md, "Link codes".
"""

import argparse
import csv
import importlib.util
import io
import json
import sys
from pathlib import Path

sys.dont_write_bytecode = True        # leave no __pycache__ in tools/
HERE = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location('make_link_codes', str(HERE / 'make_link_codes.py'))
mlc = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(mlc)

OUT_COLUMNS = ['link_id', 'phase', 'group', 'slot', 'pid', 'tester', 'link']
LANGS = ('ja', 'en')


def out_name(phase, group, lang, dev_short=None):
    parts = [x for x in (phase, group, lang) if x]
    if dev_short:
        parts.append('short%d' % dev_short)
    return 'links_private' + ''.join('_' + x for x in parts) + '.csv'


def _base(base):
    if '?' in base or '#' in base:
        raise mlc.Problem('--base-url must not contain "?" or "#": %s' % base)
    if not (base.startswith('https://') or base.startswith('http://')):
        raise mlc.Problem('--base-url must start with https:// (or http:// for a local test): %s' % base)
    if not (base.endswith('/') or base.endswith('.html')):
        base += '/'
    return base


def make_link(base, code, lang):
    return _base(base) + '?code=' + code + (('&lang=' + lang) if lang else '')


def make_dev_short_link(base, code, lang, n):
    """The short test session on dev.html: the site folder + dev.html (a
    base ending in a page, e.g. index.html, has that page replaced)."""
    base = _base(base)
    if base.endswith('.html'):
        base = base[:base.rfind('/') + 1]
    return (base + 'dev.html?code=' + code + (('&lang=' + lang) if lang else '') +
            '&preset=short&n=%d' % n)


def check_public(rows, public_file):
    """Problems for the selected rows against a public file (as in
    make_link_codes.py --verify, for these rows)."""
    problems = []
    try:
        pub = json.loads(Path(public_file).read_text(encoding='utf-8'))
    except (OSError, ValueError) as e:
        return ['public file %s could not be read (%s)' % (public_file, e)]
    if pub.get('format') != mlc.FORMAT:
        problems.append('public file: "format" is not %r' % mlc.FORMAT)
    codes = pub.get('codes')
    if not isinstance(codes, dict):
        return problems + ['public file: no "codes" object']
    for r in rows:
        k = mlc.lookup_key(r['code'])
        if k not in codes:
            problems.append('%s: its code has no entry in the public file' % r['link_id'])
            continue
        try:
            d = mlc.decrypt_entry(r['code'], codes[k])
        except mlc.Problem as e:
            problems.append('%s: its public entry %s' % (r['link_id'], e))
            continue
        if (d['link_id'], d['phase'], d['group'], d['slot']) != (r['link_id'], r['phase'], r['group'], r['_slot']):
            problems.append('%s: its public entry says %s' % (r['link_id'], d['link_id']))
    return problems


def main(argv=None):
    ap = argparse.ArgumentParser(description='Build the participant links from the private '
                                             'link-code table (see SETUP.md, "Link codes").')
    ap.add_argument('--private-dir', required=True,
                    help='the folder with link_codes_private.csv (outside this repository)')
    ap.add_argument('--base-url', required=True,
                    help='the experiment address, e.g. https://dpdrchain.github.io/dr_experiment/')
    ap.add_argument('--lang', choices=LANGS, help='add &lang= to every link')
    ap.add_argument('--phase', choices=mlc.PHASES, help='only this phase')
    ap.add_argument('--group', choices=mlc.GROUPS, help='only this group')
    ap.add_argument('--public-file', help='check every selected code against this public file first')
    ap.add_argument('--dev-short', type=int, metavar='N',
                    help='short test links on dev.html (test codes only), N main trials '
                         'per block (1 to 200; 41 shows the first break)')
    ap.add_argument('--show', action='store_true', help='print the links')
    args = ap.parse_args(argv)
    if args.dev_short is not None:
        if not 1 <= args.dev_short <= 200:
            ap.error('--dev-short N: N must be from 1 to 200 (main trials per block)')
        if args.phase and args.phase != 'test':
            ap.error('--dev-short is for test codes only: it refuses --phase %s' % args.phase)
        args.phase = 'test'
    try:
        private_dir = Path(args.private_dir).expanduser().resolve()
        root = mlc.repo_root()
        if mlc.inside(private_dir, root):
            raise mlc.Problem('Refusing: --private-dir %s is inside this repository (%s). The '
                              'links hold the codes and must never be where they could be '
                              'committed.' % (private_dir, root))
        table = private_dir / mlc.PRIVATE_NAME
        if not table.exists():
            raise mlc.Problem('%s not found. Make the codes first with make_link_codes.py.' % table)
        _, rows = mlc.read_private(table)
        problems = []
        mlc.check_table(rows, problems)
        if problems:
            raise mlc.Problem('The private table has problems; no links written:\n  ' +
                              '\n  '.join(problems) + '\nRun make_link_codes.py --verify.')
        sel = [r for r in rows
               if (not args.phase or r['phase'] == args.phase)
               and (not args.group or r['group'] == args.group)]
        if not sel:
            raise mlc.Problem('No rows match --phase %s --group %s.' % (args.phase or '(any)',
                                                                        args.group or '(any)'))
        if args.dev_short is not None:
            links = [make_dev_short_link(args.base_url, r['code'], args.lang, args.dev_short)
                     for r in sel]
        else:
            links = [make_link(args.base_url, r['code'], args.lang) for r in sel]
        if args.public_file:
            pf = Path(args.public_file).expanduser().resolve()
            problems = check_public(sel, pf)
            if problems:
                raise mlc.Problem('Not writing: the codes do not all open in %s:\n  ' % pf +
                                  '\n  '.join(problems))
        buf = io.StringIO(newline='')
        w = csv.writer(buf, lineterminator='\r\n')
        w.writerow(OUT_COLUMNS)
        for r, link in zip(sel, links):
            w.writerow([r['link_id'], r['phase'], r['group'], r['_slot'],
                        r.get('pid', ''), r.get('tester', ''), link])
        out = private_dir / out_name(args.phase, args.group, args.lang, args.dev_short)
        mlc.atomic_write(out, b'\xef\xbb\xbf' + buf.getvalue().encode('utf-8'), 0o600)
        counts = {}
        for r in sel:
            counts[(r['phase'], r['group'])] = counts.get((r['phase'], r['group']), 0) + 1
        print('Wrote %d links to %s' % (len(sel), out))
        print('  ' + ', '.join('%s %s %d' % (p, g, n) for (p, g), n in sorted(
            counts.items(), key=lambda x: (mlc.PHASES.index(x[0][0]), mlc.GROUPS.index(x[0][1])))))
        if args.public_file:
            print('Every link\'s code opens its entry in %s.' % pf)
        if args.show:
            print('')
            for r, link in zip(sel, links):
                print('%-26s %s' % (r['link_id'], link))
        return 0
    except mlc.Problem as e:
        print('ERROR: %s' % e, file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
