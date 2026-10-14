#!/usr/bin/env node
// Test de fumée — Suivi Aylan
// =============================================================================
// Couvre les parcours critiques + les deux régressions de fiabilité trouvées
// lors de l'audit technique d'août 2026 (écriture affichée comme un succès
// alors qu'elle a échoué ; modification concurrente écrasée en silence).
//
// Volontairement pas de framework de test (cohérent avec le reste du projet,
// voir CLAUDE.md §1) : un seul script Node + Playwright, chargé en file://
// exactement comme le reste des tests de ce projet. Stub minimal de
// `window.firebase` posé via addInitScript AVANT navigation — c'est ce qui
// permet de tester sans dépendre d'un vrai projet Firebase ni de réseau.
//
// Usage :
//   node tests/smoke.js
// Nécessite Playwright installé (npm i -D playwright, ou toute installation
// globale/locale exposant le module `playwright`).
// =============================================================================

let chromium;
try {
  ({ chromium } = require('playwright'));
} catch (e) {
  // Repli sur le chemin utilisé dans l'environnement d'exécution de ce projet
  // au moment de l'écriture de ce test, au cas où `playwright` ne serait pas
  // installé localement comme dépendance npm classique.
  ({ chromium } = require('/opt/node22/lib/node_modules/playwright'));
}
const path = require('path');

let PASS = 0, FAIL = 0;
const failures = [];
function assert(cond, label) {
  if (cond) { PASS++; console.log('  ✅', label); }
  else { FAIL++; failures.push(label); console.log('  ❌', label); }
}

function setPath(store, p, val) {
  const parts = p.split('/');
  let cur = store;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!cur[parts[i]] || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = val;
}
function getPath(store, p) {
  const parts = p.split('/');
  let cur = store;
  for (const part of parts) { if (cur == null) return null; cur = cur[part]; }
  return cur === undefined ? null : cur;
}

// Même fuseau que celui posé dans meta.timezone ci-dessous — pour que
// l'entrée de départ tombe bien dans le jour "aujourd'hui" affiché par
// l'app (todayKey() se base sur ce fuseau, pas sur celui du conteneur).
const TEST_TZ = 'Europe/Paris';
function todayKeyFor(tz) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const y = parts.find(p => p.type === 'year').value, m = parts.find(p => p.type === 'month').value, d = parts.find(p => p.type === 'day').value;
  return `${y}-${m}-${d}`;
}

function baseStore() {
  const s = {};
  setPath(s, 'families/fam1/meta', { name: 'Famille Test', features: { sleep: false, health: false, vaccines: false }, reminder: { enabled: false, thresholdMinutes: 210 }, timezone: TEST_TZ });
  setPath(s, 'families/fam1/children/c1/profile', { firstName: 'Test', lastName: 'Enfant', birthDate: '2026-01-15', gender: 'M' });
  setPath(s, 'families/fam1/children/c1/meta', { order: 0 });
  setPath(s, 'families/fam1/children/c1/entries', {
    e1: { id: 'e1', type: 'biberon', ml: 120, diaper: 'none', timestamp: Date.now(), dayKey: todayKeyFor(TEST_TZ), time: '09:00', updatedAt: 1000 },
  });
  setPath(s, 'families/fam1/children/c1/growth', {});
  setPath(s, 'families/fam1/children/c1/vaccines', {});
  setPath(s, 'families/fam1/children/c1/milestones', {});
  return s;
}

async function newPage(browser, store, opts) {
  opts = opts || {};
  const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
  const consoleErrors = [];
  page.on('pageerror', (e) => consoleErrors.push(e.message));
  page.consoleErrors = consoleErrors;

  // Les quatre <script> du CDN Firebase écrasent window.firebase quand le
  // réseau est disponible : le test se retrouvait alors face au vrai SDK (donc
  // un vrai écran de connexion, aucun utilisateur) au lieu du stub. On bloque
  // ces requêtes pour que le stub posé par addInitScript reste le seul
  // Firebase de la page, avec ou sans connectivité.
  await page.route('**/firebasejs/**', (route) => route.abort());

  await page.exposeFunction('__bridgeGet', (p) => getPath(store, p));
  await page.exposeFunction('__bridgeSet', (p, val) => { setPath(store, p, val); return true; });
  await page.exposeFunction('__shouldFailWrite', () => !!opts.failWrites);

  await page.addInitScript((confirmResult) => {
    const listeners = {};
    window.confirm = () => confirmResult;
    window.firebase = {
      initializeApp: () => {},
      auth: () => ({
        onAuthStateChanged: (cb) => cb({ uid: 'u1', email: 'test@example.com' }),
        signInWithEmailAndPassword: () => Promise.reject(new Error('stub')),
        createUserWithEmailAndPassword: () => Promise.reject(new Error('stub')),
        signOut: () => Promise.resolve(),
        currentUser: { email: 'test@example.com' },
      }),
      database: () => ({
        ref: (p) => ({
          on: async (evt, cb) => {
            listeners[p] = cb;
            cb({ val: () => null });
            const v = await window.__bridgeGet(p);
            cb({ val: () => v });
          },
          once: async (evt) => {
            if (p === 'userFamilies/u1') return { val: () => 'fam1' };
            if (p === 'legacyMigration/claimed') return { val: () => true };
            const v = await window.__bridgeGet(p);
            return { val: () => v, exists: () => v != null };
          },
          set: async (val) => {
            if (await window.__shouldFailWrite()) throw new Error('PERMISSION_DENIED simulé');
            await window.__bridgeSet(p, val);
            return true;
          },
          update: async (val) => { await window.__bridgeSet(p, val); return true; },
          push: async (val) => { const key = 'push_' + Math.random().toString(36).slice(2); await window.__bridgeSet(p + '/' + key, val); return { key }; },
          remove: async () => { await window.__bridgeSet(p, null); },
          transaction: async (updateFn) => {
            const current = await window.__bridgeGet(p);
            const newVal = updateFn(current);
            if (newVal === undefined) return { committed: false, snapshot: { val: () => current } };
            await window.__bridgeSet(p, newVal);
            return { committed: true, snapshot: { val: () => newVal } };
          },
          off: () => {},
          orderByChild: () => ({ equalTo: () => ({ once: async () => ({ exists: () => false }) }) }),
        }),
      }),
      messaging: () => ({ getToken: () => Promise.resolve('TOK'), onMessage: () => {} }),
    };
  }, opts.confirmResult !== false);

  await page.goto('file://' + path.resolve(__dirname, '..', 'index.html'));
  await page.waitForTimeout(700);
  return page;
}

async function run() {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });

  console.log('\n1. Chargement de l\'app sans erreur console');
  {
    const store = baseStore();
    const page = await newPage(browser, store);
    assert(page.consoleErrors.length === 0, `Aucune erreur JS au chargement (reçu: ${page.consoleErrors.join(', ') || 'aucune'})`);
    const homeVisible = await page.evaluate(() => !document.getElementById('view-today')?.classList.contains('hidden'));
    assert(homeVisible, 'L\'écran "Aujourd\'hui" est affiché après connexion');
    await page.close();
  }

  console.log('\n2. Ajout d\'un biberon');
  {
    const store = baseStore();
    const page = await newPage(browser, store);
    await page.click('#fab-btn');
    await page.waitForTimeout(200);
    await page.fill('#ml-input', '150');
    await page.click('#save-btn');
    await page.waitForTimeout(400);
    const entries = getPath(store, 'families/fam1/children/c1/entries');
    const added = Object.values(entries).some(e => e.ml === 150);
    assert(added, 'La nouvelle entrée (150 ml) est bien écrite en base');
    assert(page.consoleErrors.length === 0, 'Aucune erreur JS pendant l\'ajout');
    await page.close();
  }

  console.log('\n3. Édition d\'un biberon existant');
  {
    const store = baseStore();
    const page = await newPage(browser, store);
    await page.evaluate(() => startEdit('e1'));
    await page.waitForTimeout(200);
    await page.fill('#ml-input', '200');
    await page.click('#save-btn');
    await page.waitForTimeout(400);
    const entry = getPath(store, 'families/fam1/children/c1/entries/e1');
    assert(entry.ml === 200, 'L\'entrée modifiée est bien mise à jour en base (200 ml)');
    assert(!!entry.updatedAt, 'updatedAt est renseigné après une écriture');
    await page.close();
  }

  console.log('\n4. Suppression d\'un biberon (double confirmation)');
  {
    const store = baseStore();
    const page = await newPage(browser, store);
    const delBtn = page.locator('[data-del="e1"]');
    await delBtn.click();
    await page.waitForTimeout(150);
    const stillThereAfterFirstClick = getPath(store, 'families/fam1/children/c1/entries/e1') != null;
    assert(stillThereAfterFirstClick, 'Un seul clic n\'efface pas encore l\'entrée (garde-fou anti-suppression accidentelle)');
    await delBtn.click();
    await page.waitForTimeout(300);
    const goneAfterSecondClick = getPath(store, 'families/fam1/children/c1/entries/e1') == null;
    assert(goneAfterSecondClick, 'Le second clic de confirmation supprime bien l\'entrée');
    await page.close();
  }

  console.log('\n5. Activation d\'un paramètre familial (fonctionnalité Sommeil)');
  {
    const store = baseStore();
    const page = await newPage(browser, store);
    await page.evaluate(() => switchView('settings'));
    await page.waitForTimeout(200);
    // La section "Fonctionnalités" est un accordéon replié par défaut.
    await page.evaluate(() => {
      const section = document.getElementById('feature-toggle-sleep')?.closest('.settings-section');
      if (section) section.classList.add('expanded');
    });
    await page.click('#feature-toggle-sleep');
    await page.waitForTimeout(300);
    const enabled = getPath(store, 'families/fam1/meta/features/sleep') === true;
    assert(enabled, 'Le paramètre "Sommeil" est bien activé et persisté en base');
    await page.close();
  }

  console.log('\n6. RÉGRESSION — échec d\'écriture ne doit jamais afficher un succès');
  {
    const store = baseStore();
    const page = await newPage(browser, store, { failWrites: true });
    await page.click('#fab-btn');
    await page.waitForTimeout(200);
    await page.fill('#ml-input', '150');
    await page.click('#save-btn');
    await page.waitForTimeout(400);
    const toastText = await page.evaluate(() => document.querySelector('.toast')?.textContent.trim() || '');
    const modalStillOpen = await page.evaluate(() => !document.getElementById('add-modal-overlay')?.classList.contains('hidden'));
    assert(toastText.includes('Erreur'), 'Le toast signale bien l\'échec');
    assert(!toastText.toLowerCase().includes('enregistré'), 'Le toast ne prétend jamais un succès après un échec réel');
    assert(modalStillOpen, 'La modale reste ouverte (pas de fermeture trompeuse après échec)');
    await page.close();
  }

  console.log('\n7. RÉGRESSION — édition concurrente doit être signalée, pas écrasée en silence');
  {
    const store = baseStore();
    const page = await newPage(browser, store, { confirmResult: false });
    // Une autre personne modifie l'entrée après son chargement initial.
    setPath(store, 'families/fam1/children/c1/entries/e1', { id: 'e1', type: 'biberon', ml: 999, diaper: 'none', timestamp: Date.now(), dayKey: 'x', time: '09:00', updatedAt: 5000 });
    await page.click('#fab-btn');
    await page.waitForTimeout(200);
    await page.evaluate(() => { editingId = 'e1'; editingLoadedUpdatedAt = 1000; });
    await page.fill('#ml-input', '150');
    await page.click('#save-btn');
    await page.waitForTimeout(400);
    const entry = getPath(store, 'families/fam1/children/c1/entries/e1');
    assert(entry.ml === 999, 'La donnée de l\'autre personne n\'est pas écrasée sans confirmation');
    await page.close();
  }

  console.log('\n8. Démarrage puis arrêt d\'une sieste (verrou transactionnel)');
  {
    const store = baseStore();
    setPath(store, 'families/fam1/meta/features/sleep', true);
    const page = await newPage(browser, store);
    await page.click('#sleep-log-btn');
    await page.waitForTimeout(300);
    const lockAfterStart = getPath(store, 'families/fam1/children/c1/activeSleep');
    assert(!!(lockAfterStart && lockAfterStart.id), 'Le verrou activeSleep est posé au démarrage');
    const entriesAfterStart = getPath(store, 'families/fam1/children/c1/entries');
    const activeEntry = Object.values(entriesAfterStart).find(e => e.type === 'sleep' && e.end == null);
    assert(!!activeEntry, 'Une entrée sommeil "en cours" (end: null) est créée');

    await page.click('#sleep-log-btn');
    await page.waitForTimeout(300);
    const lockAfterStop = getPath(store, 'families/fam1/children/c1/activeSleep');
    assert(lockAfterStop == null, 'Le verrou activeSleep est libéré à l\'arrêt');
    const entriesAfterStop = getPath(store, 'families/fam1/children/c1/entries');
    const closedEntry = entriesAfterStop[activeEntry.id];
    assert(!!(closedEntry && closedEntry.end != null && closedEntry.durationMin >= 0), 'La même entrée est refermée (end renseigné) plutôt qu\'une deuxième créée');
    assert(page.consoleErrors.length === 0, 'Aucune erreur JS pendant le cycle sommeil');
    await page.close();
  }

  console.log('\n9. RÉGRESSION — édition concurrente d\'une mesure de croissance doit être signalée');
  {
    const store = baseStore();
    setPath(store, 'families/fam1/children/c1/growth/g1', { id: 'g1', date: '2026-06-01', weight: 7.2, height: null, headCirc: null, updatedAt: 1000 });
    const page = await newPage(browser, store, { confirmResult: false });
    // Une autre personne modifie la mesure après son chargement initial.
    setPath(store, 'families/fam1/children/c1/growth/g1', { id: 'g1', date: '2026-06-01', weight: 9.9, height: null, headCirc: null, updatedAt: 5000 });
    await page.evaluate(() => { switchView('profile'); });
    await page.waitForTimeout(200);
    await page.evaluate(() => { editingGrowthId = 'g1'; editingGrowthLoadedUpdatedAt = 1000; document.getElementById('growth-weight-input').value = '7.5'; });
    await page.evaluate(() => saveGrowthEntry());
    await page.waitForTimeout(400);
    const growth = getPath(store, 'families/fam1/children/c1/growth/g1');
    assert(growth.weight === 9.9, 'La mesure de l\'autre personne n\'est pas écrasée sans confirmation');
    await page.close();
  }

  console.log('\n10. Édition d\'un biberon créé par quelqu\'un d\'autre — lastEditedBy renseigné, authorEmail préservé');
  {
    const store = baseStore();
    setPath(store, 'families/fam1/children/c1/entries/e1', { id: 'e1', type: 'biberon', ml: 120, diaper: 'none', timestamp: Date.now(), dayKey: todayKeyFor(TEST_TZ), time: '09:00', updatedAt: 1000, authorEmail: 'autre-parent@example.com' });
    const page = await newPage(browser, store);
    await page.evaluate(() => startEdit('e1'));
    await page.waitForTimeout(200);
    await page.fill('#ml-input', '140');
    await page.click('#save-btn');
    await page.waitForTimeout(400);
    const entry = getPath(store, 'families/fam1/children/c1/entries/e1');
    assert(entry.authorEmail === 'autre-parent@example.com', 'authorEmail (créateur d\'origine) reste inchangé après édition par quelqu\'un d\'autre');
    assert(entry.lastEditedBy === 'test@example.com', 'lastEditedBy porte bien l\'email de la personne qui vient d\'éditer');
    await page.close();
  }

  console.log('\n11. Suppression d\'une mesure de croissance — annulation restaure la donnée');
  {
    const store = baseStore();
    setPath(store, 'families/fam1/children/c1/growth/g1', { id: 'g1', date: '2026-06-01', weight: 7.2, height: null, headCirc: null, updatedAt: 1000 });
    const page = await newPage(browser, store);
    await page.evaluate(() => deleteGrowthEntry('g1'));
    await page.waitForTimeout(200);
    const goneAfterDelete = getPath(store, 'families/fam1/children/c1/growth/g1') == null;
    assert(goneAfterDelete, 'La mesure est bien supprimée');
    await page.click('.toast .toast-action');
    await page.waitForTimeout(200);
    const restored = getPath(store, 'families/fam1/children/c1/growth/g1');
    assert(!!(restored && restored.weight === 7.2), 'Le bouton "Annuler" du toast restaure la mesure supprimée');
    await page.close();
  }

  console.log('\n12. Croissance — référence OMS en paramètres L/M/S');
  {
    const store = baseStore();
    const page = await newPage(browser, store);

    // 12.a Les tables générées sont bien chargées (growth-reference.js).
    const refLoaded = await page.evaluate(() => typeof GROWTH_REF === 'object'
      && GROWTH_REF.weight && GROWTH_REF.height && GROWTH_REF.headCirc
      && GROWTH_REF_AGE_DAYS.length * 3 === GROWTH_REF.weight.M.length);
    assert(refLoaded, 'growth-reference.js est chargé et les 3 tables ont la bonne longueur');

    // 12.b Les L/M/S reproduisent les valeurs publiées par l'OMS
    // (contre-vérifiées sur les fichiers « zscore expanded tables » officiels).
    const casOMS = await page.evaluate(() => [
      [lmsValue(growthLMS('weight', 'M', 0), -2), 2.459],
      [lmsValue(growthLMS('weight', 'M', 0), 0), 3.3464],
      [lmsValue(growthLMS('weight', 'M', 0), 2), 4.419],
      [lmsValue(growthLMS('weight', 'F', 365), 0), 8.9462],
      [lmsValue(growthLMS('height', 'M', 365), 0), 75.7488],
      [lmsValue(growthLMS('headCirc', 'M', 274), 0), 45.0007],
    ].map(([got, exp]) => Math.abs(got - exp) / exp));
    assert(casOMS.every(e => e < 0.0005), `Les L/M/S reproduisent les valeurs OMS (écart max ${(Math.max(...casOMS) * 100).toFixed(3)}%)`);

    // 12.c z-score et valeur sont bien réciproques sur toute la plage 0-5 ans.
    const allerRetour = await page.evaluate(() => {
      let max = 0;
      for (const m of ['weight', 'height', 'headCirc']) for (const g of ['M', 'F'])
        for (let d = 0; d <= 1856; d += 11) for (const z of [-3, -1.88079, 0, 1.88079, 3]) {
          const lms = growthLMS(m, g, d);
          max = Math.max(max, Math.abs(lmsZScore(lms, lmsValue(lms, z)) - z));
        }
      return max;
    });
    assert(allerRetour < 1e-9, `z -> valeur -> z est réciproque (écart max ${allerRetour.toExponential(1)})`);

    // 12.d Le percentile affiché correspond bien au z-score de la mesure.
    const libelles = await page.evaluate(() => {
      const lms = growthLMS('weight', 'M', 183);
      return {
        median: growthPercentileLabel('weight', 'M', 183, lmsValue(lms, 0)),
        p3: growthPercentileLabel('weight', 'M', 183, lmsValue(lms, -1.88079)),
        p97: growthPercentileLabel('weight', 'M', 183, lmsValue(lms, 1.88079)),
        tresBas: growthPercentileLabel('weight', 'M', 183, 3),
      };
    });
    assert(libelles.median === '50ᵉ percentile', `La médiane OMS s'affiche « 50ᵉ percentile » (reçu « ${libelles.median} »)`);
    assert(libelles.p3 === '3ᵉ percentile', `Le P3 OMS s'affiche « 3ᵉ percentile » (reçu « ${libelles.p3} »)`);
    assert(libelles.p97 === '97ᵉ percentile', `Le P97 OMS s'affiche « 97ᵉ percentile » (reçu « ${libelles.p97} »)`);
    assert(libelles.tresBas === '<1ᵉ percentile', `Un poids très bas s'affiche « <1ᵉ percentile » plutôt que « 0ᵉ » (reçu « ${libelles.tresBas} »)`);
    await page.close();
  }

  console.log('\n13. Croissance — rendu du graphique et du percentile dans l\'écran Infos');
  {
    const store = baseStore();
    // Mesures posées à des âges connus (la naissance est au 2026-01-15).
    setPath(store, 'families/fam1/children/c1/growth/g1', { id: 'g1', date: '2026-02-15', weight: 4.5, height: 55, headCirc: 38, updatedAt: 1000 });
    setPath(store, 'families/fam1/children/c1/growth/g2', { id: 'g2', date: '2026-04-15', weight: 6.4, height: 62, headCirc: 41, updatedAt: 2000 });
    setPath(store, 'families/fam1/children/c1/growth/g3', { id: 'g3', date: '2026-07-17', weight: 7.9, height: 68, headCirc: 43.5, updatedAt: 3000 });
    const page = await newPage(browser, store);
    await page.evaluate(() => switchView('chart'));
    await page.waitForTimeout(150);
    await page.evaluate(() => {
      const b = document.querySelector('.tab-btn[data-tab-group="chart"][data-tab="growth"]');
      if (b) b.click();
    });
    await page.waitForTimeout(400);

    const chart = await page.evaluate(() => {
      const svg = document.querySelector('#weight-chart-scroll svg');
      const paths = svg ? [...svg.querySelectorAll('path')].map(p => p.getAttribute('d') || '') : [];
      return {
        svg: !!svg,
        bande: paths.some(d => d.includes('Z') && d.length > 200),
        nan: paths.some(d => d.includes('NaN')),
        label: (document.getElementById('weight-chart-label') || {}).textContent || '',
        note: !!document.querySelector('.growth-ref-note'),
      };
    });
    assert(chart.svg, 'La courbe de poids est bien rendue en SVG');
    assert(chart.bande, 'La bande OMS P3-P97 est tracée sous la courbe');
    assert(!chart.nan, 'Aucune coordonnée NaN dans les tracés (interpolation LMS saine)');
    assert(/\d+ᵉ percentile/.test(chart.label), `Le libellé de la courbe porte un percentile (reçu « ${chart.label} »)`);
    assert(chart.note, 'La note « quelle référence ? » est présente sous les courbes');

    // La carte d'accueil doit afficher le même percentile, pas « ~0ᵉ ».
    await page.evaluate(() => switchView('today'));
    await page.waitForTimeout(300);
    const carte = await page.evaluate(() => {
      const el = document.querySelector('#today-growth-snapshot .pct');
      return el ? el.textContent.trim() : '';
    });
    assert(/percentile OMS$/.test(carte), `La carte d'accueil affiche le percentile OMS (reçu « ${carte} »)`);
    assert(page.consoleErrors.length === 0, `Aucune erreur JS pendant le parcours croissance (reçu: ${page.consoleErrors.join(', ') || 'aucune'})`);
    await page.close();
  }

  await browser.close();

  console.log(`\n${'='.repeat(60)}`);
  console.log(`TOTAL : ${PASS} réussis / ${FAIL} échoués`);
  if (failures.length) {
    console.log('\nÉchecs :');
    failures.forEach(f => console.log('  -', f));
  }
  process.exit(FAIL > 0 ? 1 : 0);
}

run().catch(e => { console.error('CRASH:', e); process.exit(1); });
