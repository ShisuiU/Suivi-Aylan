#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Régénère growth-reference.js à partir des tables officielles de l'OMS.

Pourquoi ce script existe : growth-reference.js contient des valeurs médicales.
Les saisir ou les corriger à la main, c'est exactement le risque qu'on veut
éviter (un percentile faux inquiète ou rassure à tort). Le fichier est donc
entièrement dérivé des fichiers publiés par l'OMS, et ce script est la seule
façon légitime de le modifier.

Usage :
    python3 tools/gen-growth-reference.py --telecharger   # récupère les 6 .xlsx
    python3 tools/gen-growth-reference.py                 # régénère le .js

Les .xlsx sont déposés dans tools/who-data/ (non versionné).
Aucune dépendance : le lecteur xlsx ci-dessous est un simple zipfile + regex
(openpyxl n'est pas installable partout, et le projet n'a pas de gestionnaire
de paquets Python).

Sources (tables « z-score expanded », paramètres L/M/S quotidiens 0-1856 jours) :
  poids              https://cdn.who.int/media/docs/default-source/child-growth/child-growth-standards/indicators/weight-for-age/expanded-tables/wfa-{boys,girls}-zscore-expanded-tables.xlsx
  longueur / taille  https://cdn.who.int/media/docs/default-source/child-growth/child-growth-standards/indicators/length-height-for-age/expandable-tables/lhfa-{boys,girls}-zscore-expanded-tables.xlsx
  périmètre crânien  https://cdn.who.int/media/docs/default-source/child-growth/child-growth-standards/indicators/head-circumference-for-age/expanded-tables/hcfa-{boys,girls}-zscore-expanded-tables.xlsx

Le script imprime deux contrôles sur stderr :
  - l'écart max introduit par la grille d'âges réduite (vs. les L/M/S quotidiens) ;
  - l'écart max entre nos L/M/S et les colonnes SD publiées par l'OMS.
Les deux doivent rester très en dessous de 1 %.
"""

import argparse
import os
import re
import sys
import math
import bisect
import zipfile
import urllib.request

ICI = os.path.dirname(os.path.abspath(__file__))
DD = os.path.join(ICI, 'who-data')
SORTIE = os.path.join(ICI, '..', 'growth-reference.js')

BASE = ('https://cdn.who.int/media/docs/default-source/child-growth/'
        'child-growth-standards/indicators/')
URLS = {
    'wfa':  BASE + 'weight-for-age/expanded-tables/wfa-%s-zscore-expanded-tables.xlsx',
    # Oui, « expandable » et non « expanded » pour celle-ci : c'est l'URL de l'OMS.
    'lhfa': BASE + 'length-height-for-age/expandable-tables/lhfa-%s-zscore-expanded-tables.xlsx',
    'hcfa': BASE + 'head-circumference-for-age/expanded-tables/hcfa-%s-zscore-expanded-tables.xlsx',
}


def telecharger():
    os.makedirs(DD, exist_ok=True)
    for pre, url in URLS.items():
        for sexe in ('boys', 'girls'):
            dest = os.path.join(DD, '%s-%s.xlsx' % (pre, sexe))
            print('  ->', dest, file=sys.stderr)
            urllib.request.urlretrieve(url % sexe, dest)


import zipfile, re

def read_xlsx(path):
    z = zipfile.ZipFile(path)
    shared = []
    if 'xl/sharedStrings.xml' in z.namelist():
        s = z.read('xl/sharedStrings.xml').decode('utf8')
        shared = [re.sub('<.*?>','',m) for m in re.findall(r'<si>(.*?)</si>', s, re.S)]
    sheet = z.read('xl/worksheets/sheet1.xml').decode('utf8')
    rows = []
    for rm in re.finditer(r'<row[^>]*>(.*?)</row>', sheet, re.S):
        cells = {}
        for cm in re.finditer(r'<c r="([A-Z]+)(\d+)"([^>]*)>(.*?)</c>', rm.group(1), re.S):
            col, _, attrs, body = cm.groups()
            vm = re.search(r'<v>(.*?)</v>', body, re.S)
            if not vm: continue
            v = vm.group(1)
            if 't="s"' in attrs:
                v = shared[int(v)]
            cells[col] = v
        if cells: rows.append(cells)
    return rows

ap = argparse.ArgumentParser()
ap.add_argument('--telecharger', action='store_true', help="récupère les 6 fichiers de l'OMS avant de générer")
args = ap.parse_args()
if args.telecharger:
    telecharger()
if not os.path.isdir(DD):
    sys.exit("tools/who-data/ absent — lancer d'abord avec --telecharger")


def load(f):
    rows = read_xlsx(os.path.join(DD, f)); d = {}
    for r in rows[1:]:
        d[int(r['A'])] = (float(r['B']), float(r['C']), float(r['D']))
    return d

def val(lms, z):
    L, M, S = lms
    return M * math.pow(1 + L * S * z, 1 / L) if abs(L) > 1e-9 else M * math.exp(S * z)

GRID = sorted(set(
    list(range(0, 15)) + [16, 18, 21, 24, 27, 30] + list(range(37, 184, 7))
    + [int(m * 30.4375 + 0.5) for m in range(6, 61)] + [730, 731, 1856]
))

TABLES = [('weight', 'wfa'), ('height', 'lhfa'), ('headCirc', 'hcfa')]
SEXES = [('M', 'boys'), ('F', 'girls')]

data = {}
for key, pre in TABLES:
    for sx, sfx in SEXES:
        d = load('%s-%s.xlsx' % (pre, sfx))
        data[(key, sx)] = d
        worst = 0; wd = None
        for day in range(0, 1857):
            j = bisect.bisect_right(GRID, day) - 1
            if j >= len(GRID) - 1:
                interp = d[GRID[-1]]
            else:
                a, b = d[GRID[j]], d[GRID[j + 1]]
                fr = (day - GRID[j]) / (GRID[j + 1] - GRID[j])
                interp = tuple(a[k] + (b[k] - a[k]) * fr for k in range(3))
            for z in (-3, -1.88079, 0, 1.88079, 3):
                e = abs(val(interp, z) - val(d[day], z)) / val(d[day], z) * 100
                if e > worst: worst = e; wd = (day, round(z, 2))
        print('%-9s %-5s max %.3f pct' % (key, sx, worst), wd, file=sys.stderr)

# Contrôle croisé : nos L/M/S doivent reproduire les colonnes SD du fichier OMS
for (key, sx), d in data.items():
    rows = read_xlsx(os.path.join(DD, '%s-%s.xlsx' % (dict(TABLES)[key], dict(SEXES)[sx])))
    worst = 0
    for r in rows[1:]:
        lms = (float(r['B']), float(r['C']), float(r['D']))
        for col, z in (('F', -3), ('G', -2), ('I', 0), ('K', 2), ('L', 3)):
            ref = float(r[col])
            worst = max(worst, abs(val(lms, z) - ref) / ref * 100)
    print('controle %-9s %s ecart max colonnes SD %.4f pct' % (key, sx, worst), file=sys.stderr)

def num(x, nd):
    s = ('%.*f' % (nd, x)).rstrip('0').rstrip('.')
    return s if s not in ('', '-0') else '0'

out = []
out.append('''// === Références de croissance OMS (Normes de croissance de l'enfant, 2006) ===
// Fichier GÉNÉRÉ — ne pas éditer à la main. Source : tables « z-score expanded »
// officielles de l'OMS (paramètres L, M, S quotidiens), filtrées sur une grille
// d'âges resserrée sur les premières semaines (où la courbe est la plus
// incurvée) puis mensuelle jusqu'à 5 ans.
//   poids-pour-l'âge          : wfa-{boys,girls}-zscore-expanded-tables.xlsx
//   taille/longueur-pour-l'âge: lhfa-{boys,girls}-zscore-expanded-tables.xlsx
//   périmètre crânien         : hcfa-{boys,girls}-zscore-expanded-tables.xlsx
// La méthode LMS (Cole & Green) donne la valeur d'un z-score donné :
//   X = M * (1 + L*S*Z)^(1/L)   (L != 0)  |   X = M * exp(S*Z)   (L = 0)
// Chargé en <script> classique avant script.js : GROWTH_REF devient global.
//
// Note : la table taille contient la rupture OMS à 24 mois (passage de la
// longueur couchée à la taille debout, ~0,7 cm) — les deux jours 730 et 731
// sont donc présents dans la grille pour ne pas lisser cette marche.
//
// Réutilisation autorisée par l'OMS à des fins non commerciales (CC BY-NC-SA 3.0 IGO).

const GROWTH_REF_AGE_DAYS = [''')
for i in range(0, len(GRID), 16):
    out.append('  ' + ', '.join(str(x) for x in GRID[i:i + 16]) + ',')
out[-1] = out[-1].rstrip(',')
out.append('];\n')
out.append('// Pour chaque âge de GROWTH_REF_AGE_DAYS : L, M, S à la suite (3 nombres par âge).')
out.append('const GROWTH_REF = {')
LABEL = {'weight': 'poids (kg)', 'height': 'longueur / taille (cm)', 'headCirc': 'périmètre crânien (cm)'}
for key, pre in TABLES:
    out.append('  // %s' % LABEL[key])
    out.append('  %s: {' % key)
    for sx, sfx in SEXES:
        d = data[(key, sx)]
        flat = []
        for day in GRID:
            L, M, S = d[day]
            flat += [num(L, 4), num(M, 4), num(S, 5)]
        out.append('    %s: [' % sx)
        for i in range(0, len(flat), 12):
            out.append('      ' + ', '.join(flat[i:i + 12]) + ',')
        out[-1] = out[-1].rstrip(',')
        out.append('    ],')
    out.append('  },')
out.append('};')
out.append('')
open(SORTIE, 'w', encoding='utf8').write('\n'.join(out))
print('écrit :', os.path.normpath(SORTIE), file=sys.stderr)
