// Test de la route POST /biberon du Worker — Suivi Aylan
// =============================================================================
// Le Worker écrit avec le compte de service, qui CONTOURNE les règles de
// sécurité Firebase : la validation faite dans handleAddBottle est le seul
// garde-fou avant la base. Ce test existe pour ça.
//
// Pas de framework (cohérent avec le reste du projet) et pas de réseau : une
// vraie paire de clés RSA est générée à la volée, donc le JWT est réellement
// signé par le même code qu'en production, et `fetch` est remplacé par une
// base de données en mémoire. Seuls Google et Firebase sont simulés.
//
// Usage :  node worker/tests/bottle-route.mjs
// =============================================================================

import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';

let PASS = 0, FAIL = 0;
const failures = [];
function assert(cond, label) {
  if (cond) { PASS++; console.log('  ✅', label); }
  else { FAIL++; failures.push(label); console.log('  ❌', label); }
}

// --- Clé de service factice, mais réellement utilisable pour signer ---------
const pair = await webcrypto.subtle.generateKey(
  { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
  true, ['sign', 'verify'],
);
const pkcs8 = Buffer.from(await webcrypto.subtle.exportKey('pkcs8', pair.privateKey)).toString('base64');
const SERVICE_ACCOUNT = JSON.stringify({
  project_id: 'suivi-aylan-test',
  client_email: 'worker@suivi-aylan-test.iam.gserviceaccount.com',
  private_key: `-----BEGIN PRIVATE KEY-----\n${pkcs8.replace(/(.{64})/g, '$1\n')}\n-----END PRIVATE KEY-----\n`,
});
const DB_URL = 'https://suivi-aylan-test.europe-west1.firebasedatabase.app';

// --- Base en mémoire + stub réseau -----------------------------------------
let db, tokenCalls, putCalls;
function resetDb(extra) {
  db = {
    families: {
      fam1: {
        meta: { name: 'Famille Test', timezone: 'Europe/Paris' },
        children: {
          c1: { meta: { order: 0 }, profile: { firstName: 'Aylan' }, entries: {} },
          c2: { meta: { order: 1 }, profile: { firstName: 'Nour' }, entries: {} },
        },
      },
    },
  };
  if (extra) extra(db);
  tokenCalls = 0; putCalls = [];
}
const at = (path) => path.split('/').filter(Boolean).reduce((c, k) => (c == null ? null : c[k]), db) ?? null;

globalThis.fetch = async (input, init) => {
  const url = String(input);
  if (url.startsWith('https://oauth2.googleapis.com/token')) {
    tokenCalls++;
    const assertion = new URLSearchParams(init.body).get('assertion');
    const [h, p, sig] = assertion.split('.');
    const ok = await webcrypto.subtle.verify(
      'RSASSA-PKCS1-v1_5', pair.publicKey,
      Buffer.from(sig.replace(/-/g, '+').replace(/_/g, '/'), 'base64'),
      new TextEncoder().encode(`${h}.${p}`),
    );
    if (!ok) return new Response(JSON.stringify({ error: 'signature invalide' }), { status: 401 });
    return new Response(JSON.stringify({ access_token: 'jeton-test' }), { status: 200 });
  }
  if (url.startsWith(DB_URL)) {
    const u = new URL(url);
    const path = u.pathname.replace(/^\//, '').replace(/\.json$/, '');
    if ((init?.method || 'GET') === 'GET') {
      const val = at(path);
      const body = u.searchParams.get('shallow') === 'true' && val && typeof val === 'object'
        ? Object.fromEntries(Object.keys(val).map((k) => [k, true]))
        : val;
      return new Response(JSON.stringify(body), { status: 200 });
    }
    if (init.method === 'PUT') {
      putCalls.push(path);
      const parts = path.split('/');
      let cur = db;
      for (const k of parts.slice(0, -1)) { cur[k] = cur[k] || {}; cur = cur[k]; }
      cur[parts.at(-1)] = JSON.parse(init.body);
      return new Response(init.body, { status: 200 });
    }
  }
  throw new Error('fetch inattendu vers ' + url);
};

// --- Chargement du Worker ---------------------------------------------------
const src = readFileSync(new URL('../reminder-worker.js', import.meta.url), 'utf8');
const worker = (await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'))).default;

const ENV = {
  FIREBASE_SERVICE_ACCOUNT: SERVICE_ACCOUNT,
  FIREBASE_DATABASE_URL: DB_URL,
  MANUAL_TRIGGER_KEY: 'cle-rappels',
  ENTRY_API_KEY: 'cle-raccourci',
  ENTRY_API_AUTHOR_EMAIL: 'parent@example.com',
};

async function post(query, body, env) {
  const req = new Request('https://w.example/biberon' + (query || ''), {
    method: 'POST',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const resp = await worker.fetch(req, env || ENV);
  return { status: resp.status, json: await resp.json() };
}

console.log('\n1. Authentification');
{
  resetDb();
  assert((await post('?key=mauvaise&ml=180')).status === 401, 'Une clé fausse est refusée en 401');
  assert((await post('?ml=180')).status === 401, 'Une requête sans clé est refusée en 401');
  const sansSecret = await post('?key=cle-raccourci&ml=180', null, { ...ENV, ENTRY_API_KEY: undefined });
  assert(sansSecret.status === 501, 'Sans ENTRY_API_KEY configuré, la route est désactivée (501)');
  assert(!putCalls.length, 'Aucune écriture en base sur une requête refusée');

  const get = await worker.fetch(new Request('https://w.example/biberon?key=cle-raccourci&ml=180'), ENV);
  assert(get.status === 405, 'GET est refusé en 405 (la route écrit, elle doit être en POST)');
  // La clé des rappels ne doit pas ouvrir l'écriture, et inversement.
  assert((await post('?key=cle-rappels&ml=180')).status === 401, 'MANUAL_TRIGGER_KEY n\'autorise pas l\'écriture d\'un biberon');
}

console.log('\n2. Validation des paramètres (les règles Firebase ne protègent pas une écriture par compte de service)');
{
  resetDb();
  const k = '?key=cle-raccourci';
  assert((await post(k)).status === 400, 'Sans « ml », refus en 400');
  assert((await post(k + '&ml=abc')).status === 400, 'Un « ml » non numérique est refusé');
  assert((await post(k + '&ml=12.5')).status === 400, 'Un « ml » non entier est refusé');
  assert((await post(k + '&ml=-10')).status === 400, 'Un « ml » négatif est refusé');
  assert((await post(k + '&ml=1001')).status === 400, 'Un « ml » au-dessus de 1000 est refusé (même borne que l\'app)');
  assert((await post(k + '&ml=180&diaper=pleine')).status === 400, 'Une valeur de couche hors liste est refusée');
  assert((await post(k + '&ml=180', { comment: 'x'.repeat(501) })).status === 400, 'Un commentaire de plus de 500 caractères est refusé');
  assert((await post(k + '&ml=180&at=pas-une-date')).status === 400, 'Une date « at » illisible est refusée');
  const futur = await post(k + '&ml=180&at=' + new Date(Date.now() + 3 * 3600000).toISOString());
  assert(futur.status === 400 && /pas encore passée/.test(futur.json.error), 'Un biberon dans le futur est refusé, comme dans l\'app');
  assert(!putCalls.length, 'Aucune de ces requêtes invalides n\'a écrit en base');
}

console.log('\n3. Écriture nominale');
{
  resetDb();
  const r = await post('?key=cle-raccourci&ml=180');
  assert(r.status === 200 && r.json.ok === true, 'Un biberon valide répond 200');
  assert(putCalls.length === 1, 'Exactement une écriture en base (comme addEntryToDB côté app)');
  assert(/^families\/fam1\/children\/c1\/entries\/e_/.test(putCalls[0]), 'Écrit au bon chemin, sous l\'enfant par défaut (meta.order le plus bas)');
  const e = r.json.entry;
  assert(e.type === 'biberon' && e.ml === 180 && e.diaper === 'none' && e.comment === '', 'Les champs type/ml/diaper/comment sont corrects');
  assert(/^e_[0-9a-z]+$/.test(e.id) && e.id === putCalls[0].split('/').at(-1), 'L\'identifiant suit la forme de generateId(\'e\') et sert de clé');
  assert(e.authorEmail === 'parent@example.com', 'authorEmail reprend ENTRY_API_AUTHOR_EMAIL (pastille d\'auteur correcte dans l\'app)');
  assert(typeof e.timestamp === 'number' && typeof e.updatedAt === 'number', 'timestamp et updatedAt sont des nombres');
  assert(/^\d{4}-\d{2}-\d{2}$/.test(e.dayKey) && /^\d{2}:\d{2}$/.test(e.time), 'dayKey et time ont le format attendu par l\'app');
  assert(r.json.message.includes('180 ml') && r.json.message.includes('Aylan'), 'Le message prêt à afficher nomme le volume et l\'enfant');
  assert(Object.keys(at('families/fam1/children/c1/entries')).length === 1, 'L\'entrée est bien présente en base');

  const sansAuteur = await post('?key=cle-raccourci&ml=150', null, { ...ENV, ENTRY_API_AUTHOR_EMAIL: undefined });
  assert(sansAuteur.json.entry.authorEmail === null, 'Sans ENTRY_API_AUTHOR_EMAIL, l\'entrée n\'a simplement pas d\'auteur');
}

console.log('\n4. Fuseau horaire de la famille');
{
  // 31 décembre 2025, 23h30 UTC = 1er janvier 2026, 00h30 à Paris. Si le
  // Worker calculait en UTC, le biberon tomberait le mauvais jour.
  const minuitPlus30 = Date.parse('2025-12-31T23:30:00Z');
  resetDb();
  let r = await post(`?key=cle-raccourci&ml=120&at=${minuitPlus30}`);
  assert(r.json.entry.dayKey === '2026-01-01' && r.json.entry.time === '00:30', 'dayKey/time sont calculés dans le fuseau de la famille, pas en UTC');

  resetDb((d) => { d.families.fam1.meta.timezone = 'Pacific/Noumea'; });
  r = await post(`?key=cle-raccourci&ml=120&at=${minuitPlus30}`);
  assert(r.json.entry.dayKey === '2026-01-01' && r.json.entry.time === '10:30', 'Un autre fuseau de famille est bien respecté');

  resetDb((d) => { delete d.families.fam1.meta.timezone; });
  r = await post(`?key=cle-raccourci&ml=120&at=${minuitPlus30}`);
  assert(r.json.timezone === 'Europe/Paris', 'Sans fuseau réglé, le repli est annoncé dans la réponse');
}

console.log('\n5. Anti-doublon (un raccourci vocal part facilement deux fois)');
{
  resetDb();
  const t = Date.now() - 5000;
  const a = await post(`?key=cle-raccourci&ml=180&at=${t}`);
  const b = await post(`?key=cle-raccourci&ml=180&at=${t + 2000}`);
  assert(b.json.doublon_ignore === true, 'Un second biberon identique à 2 s d\'intervalle est ignoré');
  assert(b.json.entry.id === a.json.entry.id, 'La réponse renvoie l\'entrée déjà écrite, pas une nouvelle');
  assert(Object.keys(at('families/fam1/children/c1/entries')).length === 1, 'Une seule entrée en base après le doublon');

  const force = await post(`?key=cle-raccourci&ml=180&at=${t + 2000}&force=1`);
  assert(!force.json.doublon_ignore && Object.keys(at('families/fam1/children/c1/entries')).length === 2, '« force=1 » permet quand même d\'enregistrer deux biberons identiques');

  const autreVolume = await post(`?key=cle-raccourci&ml=90&at=${t + 2000}`);
  assert(!autreVolume.json.doublon_ignore, 'Un volume différent n\'est pas traité comme un doublon');

  resetDb();
  await post(`?key=cle-raccourci&ml=180&at=${Date.now() - 300000}`);
  const plusTard = await post('?key=cle-raccourci&ml=180');
  assert(!plusTard.json.doublon_ignore, 'Passée la fenêtre d\'une minute, un même volume est bien un nouveau biberon');
}

console.log('\n6. Choix de l\'enfant et de la famille');
{
  resetDb();
  let r = await post('?key=cle-raccourci&ml=180&child=Nour');
  assert(r.json.child === 'c2' && r.json.prenom === 'Nour', 'L\'enfant peut être désigné par son prénom (ce que Siri dictera)');
  r = await post('?key=cle-raccourci&ml=170&child=NOUR');
  assert(r.json.child === 'c2', 'La casse du prénom est ignorée');
  r = await post('?key=cle-raccourci&ml=160&child=c2');
  assert(r.json.child === 'c2', 'L\'identifiant interne reste accepté');
  r = await post('?key=cle-raccourci&ml=150&child=Inconnu');
  assert(r.status === 400 && Array.isArray(r.json.enfants), 'Un enfant inconnu renvoie 400 avec la liste des enfants disponibles');

  resetDb((d) => { d.families.fam2 = { meta: {}, children: { x: { profile: { firstName: 'Z' } } } }; });
  r = await post('?key=cle-raccourci&ml=180');
  assert(r.status === 400 && r.json.familles.length === 2, 'À plusieurs familles, le paramètre « family » est exigé plutôt que deviné');
  r = await post('?key=cle-raccourci&ml=180&family=fam1');
  assert(r.status === 200 && r.json.family === 'fam1', 'La famille explicite est bien prise en compte');
}

console.log('\n7. Corps JSON et non-régression du déclenchement manuel des rappels');
{
  resetDb();
  const r = await post('', { key: 'cle-raccourci', ml: 200, diaper: 'both', comment: 'Rot difficile' });
  assert(r.status === 200 && r.json.entry.ml === 200 && r.json.entry.diaper === 'both' && r.json.entry.comment === 'Rot difficile',
    'Les paramètres passent aussi par un corps JSON (l\'autre façon de construire un raccourci)');

  resetDb();
  const autreRoute = await worker.fetch(new Request('https://w.example/?key=mauvaise'), ENV);
  assert(autreRoute.status === 401, 'La route de déclenchement manuel des rappels contrôle toujours sa propre clé');
  const racine = await worker.fetch(new Request('https://w.example/?key=cle-rappels'), ENV);
  assert(racine.status === 200, 'Le déclenchement manuel des rappels fonctionne toujours (pas de régression)');
  assert(tokenCalls > 0, 'Le jeton Google a bien été signé et accepté par le stub (chemin de signature réellement exercé)');
}

console.log(`\n${'='.repeat(60)}`);
console.log(`TOTAL : ${PASS} réussis / ${FAIL} échoués`);
if (failures.length) { console.log('\nÉchecs :'); failures.forEach((f) => console.log('  -', f)); }
process.exit(FAIL > 0 ? 1 : 0);
