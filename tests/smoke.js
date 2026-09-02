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

// Une heure "HH:MM" garantie dans le passé proche (maintenant - 5 min), pour les
// fixtures d'entrées du jour — un horaire codé en dur (ex. "09:00") est refusé
// par le garde-fou "pas de biberon futur" quand les tests tournent tôt le matin.
// Volontairement dans le fuseau LOCAL du bac à sable (pas TEST_TZ) : saveEntry()
// construit sa comparaison via `new Date(y, mo-1, d, h, m)`, qui est toujours
// interprété dans le fuseau local du navigateur — utiliser l'heure "murale" de
// TEST_TZ ici a déjà produit un décalage de 2h (Europe/Paris vs bac à sable en
// UTC) et un faux échec des tests d'édition.
function nowTimeFor() {
  const d = new Date(Date.now() - 5 * 60000);
  return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}

function baseStore() {
  const s = {};
  setPath(s, 'families/fam1/meta', { name: 'Famille Test', features: { sleep: false, health: false, vaccines: false }, reminder: { enabled: false, thresholdMinutes: 210 }, timezone: TEST_TZ });
  setPath(s, 'families/fam1/children/c1/profile', { firstName: 'Test', lastName: 'Enfant', birthDate: '2026-01-15', gender: 'M' });
  setPath(s, 'families/fam1/children/c1/meta', { order: 0 });
  setPath(s, 'families/fam1/children/c1/entries', {
    e1: { id: 'e1', type: 'biberon', ml: 120, diaper: 'none', timestamp: Date.now(), dayKey: todayKeyFor(TEST_TZ), time: nowTimeFor(), updatedAt: 1000 },
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
    setPath(store, 'families/fam1/children/c1/entries/e1', { id: 'e1', type: 'biberon', ml: 120, diaper: 'none', timestamp: Date.now(), dayKey: todayKeyFor(TEST_TZ), time: nowTimeFor(), updatedAt: 1000, authorEmail: 'autre-parent@example.com' });
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

  console.log('\n12. RÉGRESSION — refuse un biberon à une heure future (pas de temps négatif sur "Dernier biberon")');
  {
    const store = baseStore();
    const page = await newPage(browser, store);
    await page.click('#fab-btn');
    await page.waitForTimeout(200);
    await page.evaluate(() => {
      const tomorrow = new Date(Date.now() + 24 * 3600000);
      const y = tomorrow.getFullYear(), m = String(tomorrow.getMonth() + 1).padStart(2, '0'), d = String(tomorrow.getDate()).padStart(2, '0');
      const dateInput = document.getElementById('date-input');
      dateInput.value = `${y}-${m}-${d}`;
      dateInput.dispatchEvent(new Event('input'));
    });
    await page.fill('#ml-input', '120');
    const entriesBefore = Object.keys(getPath(store, 'families/fam1/children/c1/entries')).length;
    await page.click('#save-btn');
    await page.waitForTimeout(400);
    const toastText = await page.evaluate(() => document.querySelector('.toast')?.textContent.trim() || '');
    const modalStillOpen = await page.evaluate(() => !document.getElementById('add-modal-overlay')?.classList.contains('hidden'));
    const entriesAfter = Object.keys(getPath(store, 'families/fam1/children/c1/entries')).length;
    assert(toastText.includes('pas encore') || toastText.toLowerCase().includes('futur'), 'Un message explique que l\'heure n\'est pas encore passée');
    assert(modalStillOpen, 'La modale reste ouverte (rien n\'est enregistré silencieusement)');
    assert(entriesAfter === entriesBefore, 'Aucune entrée future n\'est écrite en base');

    // Un biberon "maintenant" (aujourd'hui, heure actuelle) doit lui passer.
    await page.evaluate(() => { setDateOffset(0); document.getElementById('now-btn').click(); });
    await page.click('#save-btn');
    await page.waitForTimeout(400);
    const modalClosedAfterValid = await page.evaluate(() => document.getElementById('add-modal-overlay')?.classList.contains('hidden'));
    assert(modalClosedAfterValid, 'Un biberon à l\'heure actuelle est bien accepté');
    await page.close();
  }

  console.log('\n13. "Pas de couche" à l\'ajout d\'un biberon — n\'est pas compté comme un changement de couche');
  {
    const store = baseStore();
    const page = await newPage(browser, store);
    await page.click('#fab-btn');
    await page.waitForTimeout(200);
    await page.click('[data-val="skip"]');
    await page.fill('#ml-input', '110');
    await page.click('#save-btn');
    await page.waitForTimeout(400);
    const entries = getPath(store, 'families/fam1/children/c1/entries');
    const saved = Object.values(entries).find((e) => e.ml === 110);
    assert(!!saved && saved.diaper === 'skip', 'L\'entrée est bien enregistrée avec diaper:"skip"');
    const logic = await page.evaluate(() => ({
      label: diaperLabel('skip'),
      isChangeSkip: isDiaperChange('skip'),
      isChangeNone: isDiaperChange('none'),
      isChangePipi: isDiaperChange('pipi'),
    }));
    assert(logic.label === 'Pas de couche', 'diaperLabel("skip") affiche "Pas de couche"');
    assert(logic.isChangeSkip === false && logic.isChangeNone === false, '"skip" et "none" ne comptent pas comme un changement de couche');
    assert(logic.isChangePipi === true, '"pipi" compte bien comme un changement de couche (pas de régression)');
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
