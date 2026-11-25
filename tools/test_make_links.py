#!/usr/bin/env python3
"""Self-test of tools/make_links.py (standard library only).

  python3 tools/test_make_links.py

Runs make_link_codes.py and make_links.py in a temporary folder outside
this repository: links for every row and with filters and a language (one
file per combination), the link format, the hand-typed pid and tester
copied, a table saved by a spreadsheet (BOM, 17.0 slots), --public-file
passing and failing, the refusals (inside the repository, no table, a
broken table, no matching rows, a base URL with a query), links printed
only with --show, and .gitignore.
"""

import csv
import io
import importlib.util
import json
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.dont_write_bytecode = True        # leave no __pycache__ in tools/
HERE = Path(__file__).resolve().parent
CODES = HERE / 'make_link_codes.py'
LINKS = HERE / 'make_links.py'
BASE = 'https://dpdrchain.github.io/dr_experiment/'
spec = importlib.util.spec_from_file_location('make_link_codes', str(CODES))
mlc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mlc)


def run(script, *args):
    p = subprocess.run([sys.executable, str(script)] + [str(a) for a in args],
                       stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True)
    return p.returncode, p.stdout + p.stderr


def read_rows(path):
    return list(csv.DictReader(io.StringIO(Path(path).read_bytes().decode('utf-8-sig'), newline='')))


def write_rows(path, rows, header, bom=True):
    buf = io.StringIO(newline='')
    w = csv.writer(buf, lineterminator='\r\n')
    w.writerow(header)
    for r in rows:
        w.writerow([r.get(h, '') for h in header])
    Path(path).write_bytes((b'\xef\xbb\xbf' if bom else b'') + buf.getvalue().encode('utf-8'))


class MakeLinks(unittest.TestCase):

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix='make_links_test_'))
        self.priv = self.tmp / 'private'
        self.pub = self.priv / 'codes_public.json'
        rc, out = run(CODES, '--private-dir', self.priv, '--public-out', self.pub,
                      '--test', 2, '--pilot', 3, '--main', 4)
        self.assertEqual(rc, 0, out)
        self.table = self.priv / 'link_codes_private.csv'

    def tearDown(self):
        shutil.rmtree(str(self.tmp))

    def links(self, *extra):
        return run(LINKS, '--private-dir', self.priv, '--base-url', BASE, *extra)

    def test_all_links(self):
        rc, out = self.links()
        self.assertEqual(rc, 0, out)
        f = self.priv / 'links_private.csv'
        self.assertTrue(f.read_bytes().startswith(b'\xef\xbb\xbf'))
        self.assertEqual(stat.S_IMODE(f.stat().st_mode), 0o600)
        rows = read_rows(f)
        table = read_rows(self.table)
        self.assertEqual(list(rows[0]), ['link_id', 'phase', 'group', 'slot', 'pid', 'tester', 'link'])
        self.assertEqual(len(rows), len(table))
        for r, t in zip(rows, table):
            self.assertEqual((r['link_id'], r['phase'], r['group'], r['slot']),
                             (t['link_id'], t['phase'], t['group'], t['slot']))
            self.assertEqual(r['link'], BASE + '?code=' + t['code'])
            self.assertNotIn(t['code'], out)             # not printed without --show
        pub = json.loads(self.pub.read_text())
        for r, t in zip(rows, table):
            code = r['link'].split('?code=')[1]
            d = mlc.decrypt_entry(code, pub['codes'][mlc.lookup_key(code)])
            self.assertEqual(d['link_id'], r['link_id'])

    def test_filters_and_language_one_file_each(self):
        cases = [
            (['--phase', 'pilot', '--lang', 'ja'], 'links_private_pilot_ja.csv', 6, '&lang=ja'),
            (['--phase', 'main', '--lang', 'en'], 'links_private_main_en.csv', 8, '&lang=en'),
            (['--phase', 'test'], 'links_private_test.csv', 4, None),
            (['--group', 'control'], 'links_private_control.csv', 9, None),
            (['--phase', 'main', '--group', 'participant', '--lang', 'ja'],
             'links_private_main_participant_ja.csv', 4, '&lang=ja'),
            (['--lang', 'ja'], 'links_private_ja.csv', 18, '&lang=ja'),
        ]
        for extra, name, n, suffix in cases:
            rc, out = self.links(*extra)
            self.assertEqual(rc, 0, out)
            rows = read_rows(self.priv / name)
            self.assertEqual(len(rows), n, name)
            for r in rows:
                if suffix:
                    self.assertTrue(r['link'].endswith(suffix), r['link'])
                else:
                    self.assertNotIn('&lang=', r['link'])
                self.assertRegex(r['link'], r'^https://dpdrchain\.github\.io/dr_experiment/\?code=[A-Z2-9]{12}(&lang=(ja|en))?$')
                if '--phase' in extra:
                    self.assertEqual(r['phase'], extra[extra.index('--phase') + 1])
                if '--group' in extra:
                    self.assertEqual(r['group'], extra[extra.index('--group') + 1])
        # Every combination kept its own file.
        for _, name, _, _ in cases:
            self.assertTrue((self.priv / name).exists(), name)

    def test_base_url_forms(self):
        for base, want in (('https://x.github.io/dr_experiment', 'https://x.github.io/dr_experiment/?code='),
                           ('https://x.github.io/dr_experiment/index.html',
                            'https://x.github.io/dr_experiment/index.html?code='),
                           ('http://localhost:8000/', 'http://localhost:8000/?code=')):
            rc, out = run(LINKS, '--private-dir', self.priv, '--base-url', base, '--phase', 'test')
            self.assertEqual(rc, 0, out)
            self.assertTrue(read_rows(self.priv / 'links_private_test.csv')[0]['link'].startswith(want))
        for bad in ('https://x.github.io/?code=1', 'ftp://x/', 'dpdrchain.github.io/dr_experiment/'):
            rc, out = run(LINKS, '--private-dir', self.priv, '--base-url', bad)
            self.assertEqual(rc, 1, out)
            self.assertIn('--base-url', out)

    def test_hand_typed_columns_and_spreadsheet_table(self):
        rows = read_rows(self.table)
        header = list(rows[0]) + ['my_column']
        for r in rows:
            r['slot'] = r['slot'] + '.0'
        rows[0].update(tester='沢田 慕', notes='x, "y"')
        rows[8].update(pid='R_9rJJWk01c767jE8', tester='')
        write_rows(self.table, rows, header)
        rc, out = self.links('--public-file', self.pub)
        self.assertEqual(rc, 0, out)
        got = {r['link_id']: r for r in read_rows(self.priv / 'links_private.csv')}
        self.assertEqual(got[rows[0]['link_id']]['tester'], '沢田 慕')
        self.assertEqual(got[rows[8]['link_id']]['pid'], 'R_9rJJWk01c767jE8')
        self.assertEqual(got[rows[0]['link_id']]['slot'], '1')
        # Without a BOM too.
        write_rows(self.table, rows, header, bom=False)
        rc, out = self.links()
        self.assertEqual(rc, 0, out)

    def test_public_file_check(self):
        rc, out = self.links('--phase', 'main', '--public-file', self.pub)
        self.assertEqual(rc, 0, out)
        self.assertIn('opens its entry', out)
        # One entry edited: refused, nothing written.
        (self.priv / 'links_private_main.csv').unlink()
        pub = json.loads(self.pub.read_text())
        table = read_rows(self.table)
        main = [t for t in table if t['phase'] == 'main']
        k = mlc.lookup_key(main[0]['code'])
        v = pub['codes'][k]
        pub['codes'][k] = ('A' if v[0] != 'A' else 'B') + v[1:]
        edited = self.tmp / 'edited.json'
        edited.write_text(json.dumps(pub))
        rc, out = self.links('--phase', 'main', '--public-file', edited)
        self.assertEqual(rc, 1, out)
        self.assertIn('integrity', out)
        self.assertFalse((self.priv / 'links_private_main.csv').exists())
        # Another table's public file: no entries for these codes.
        other = self.tmp / 'other'
        rc, out2 = run(CODES, '--private-dir', other, '--public-out', other / 'pub.json',
                       '--test', 1, '--pilot', 0, '--main', 1)
        self.assertEqual(rc, 0, out2)
        rc, out = self.links('--public-file', other / 'pub.json')
        self.assertEqual(rc, 1, out)
        self.assertIn('no entry in the public file', out)
        # A missing public file.
        rc, out = self.links('--public-file', self.tmp / 'nope.json')
        self.assertEqual(rc, 1, out)

    def test_show(self):
        rc, out = self.links('--phase', 'test', '--lang', 'ja', '--show')
        self.assertEqual(rc, 0, out)
        for r in read_rows(self.priv / 'links_private_test_ja.csv'):
            self.assertIn(r['link'], out)

    def test_refusals(self):
        repo = HERE.parent
        for d in (repo, repo / 'tools', Path(str(repo).upper()) / 'x'):
            rc, out = run(LINKS, '--private-dir', d, '--base-url', BASE)
            self.assertEqual(rc, 1, out)
            self.assertIn('inside this repository', out)
        self.assertFalse(list(repo.rglob('links_private*.csv')))
        rc, out = run(LINKS, '--private-dir', self.tmp / 'empty', '--base-url', BASE)
        self.assertEqual(rc, 1, out)
        self.assertIn('not found', out)
        rows = read_rows(self.table)
        rows[1]['code'] = rows[0]['code']
        write_rows(self.table, rows, list(rows[0]))
        rc, out = self.links()
        self.assertEqual(rc, 1, out)
        self.assertIn('problems', out)
        self.assertFalse((self.priv / 'links_private.csv').exists())
        rc, out = run(LINKS, '--private-dir', self.priv)
        self.assertEqual(rc, 2, out)                      # --base-url required

    def test_no_matching_rows(self):
        rows = [r for r in read_rows(self.table) if r['phase'] != 'pilot']
        write_rows(self.table, rows, list(rows[0]))
        rc, out = self.links('--phase', 'pilot')
        self.assertEqual(rc, 1, out)
        self.assertIn('No rows match', out)

    def test_gitignore(self):
        lines = (HERE.parent / '.gitignore').read_text().split()
        self.assertIn('links_private*.csv', lines)


if __name__ == '__main__':
    unittest.main(verbosity=2)
