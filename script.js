const firebaseConfig = {
  apiKey: "AIzaSyDS7SatJhkAhqAxjAa-1n2MzLWHHSTpoN4",
  authDomain: "suivi-aylan.firebaseapp.com",
  databaseURL: "https://suivi-aylan-default-rtdb.europe-west1.firebasedatabase.app",
  projectId: "suivi-aylan",
  storageBucket: "suivi-aylan.firebasestorage.app",
  messagingSenderId: "999972029793",
  appId: "1:999972029793:web:06d7eb37bfb78fa4a6f120"
};
firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db = firebase.database();

// --- Garde-fou "écriture en attente" -----------------------------------
// Sans persistance hors-ligne côté SDK Realtime Database, une écriture
// tentée pendant une coupure réseau (ou simplement en vol) reste en file
// UNIQUEMENT en mémoire — fermer/rafraîchir l'onglet à ce moment-là la
// perd silencieusement, sans que rien ne l'ait signalé. On instrumente donc
// `db.ref()` une seule fois ici pour compter les écritures en cours (set/
// update/remove/push), quel que soit l'endroit du code qui les déclenche,
// et on avertit via beforeunload tant que ce compteur n'est pas retombé à 0.
let pendingWriteCount = 0;
const dbRefOriginal = db.ref.bind(db);
db.ref = function(path){
  const ref = dbRefOriginal(path);
  ['set', 'update', 'remove', 'push'].forEach((method) => {
    const original = ref[method].bind(ref);
    ref[method] = function(...args){
      pendingWriteCount++;
      const result = original(...args);
      Promise.resolve(result).finally(() => {
        pendingWriteCount = Math.max(0, pendingWriteCount - 1);
      });
      return result;
    };
  });
  return ref;
};
window.addEventListener('beforeunload', (e) => {
  if(pendingWriteCount > 0){
    e.preventDefault();
    e.returnValue = '';
  }
});

// Clé VAPID (Web Push) — Console Firebase > Paramètres du projet > Cloud
// Messaging > Certificats Web Push > "Générer une paire de clés". Clé
// publique, sans risque à committer (contrairement à un compte de service).
const VAPID_KEY = 'BACXJiPA4HLxqF3k0PqTSZQxsM9oAym4K2kafrjMiY9_Xyvw9_gMaJQuXtjenjhYCriL3crQdQQdL5OZakfpVgc';

let messaging = null;
if('serviceWorker' in navigator && 'PushManager' in window){
  try{ messaging = firebase.messaging(); }catch(e){ messaging = null; }
}

// Le bandeau "Hors connexion" est en position:fixed par-dessus tout
// (nécessaire pour rester visible en toute circonstance) — sans ce
// réajustement, l'en-tête collant (position:sticky, top:0) et le rail de
// navigation desktop restent scotchés au sommet et se retrouvent partiellement
// cachés DERRIÈRE le bandeau quand il apparaît. On mesure sa hauteur réelle
// (variable selon l'encoche/safe-area) et on la republie en variable CSS
// (--offline-banner-h) pour décaler ces éléments d'autant.
function updateOfflineBannerOffset(){
  const banner = document.getElementById('offline-banner');
  if(!banner) return;
  const visible = !banner.classList.contains('off-hidden');
  document.documentElement.style.setProperty('--offline-banner-h', visible ? banner.offsetHeight + 'px' : '0px');
}
window.addEventListener('resize', updateOfflineBannerOffset);

db.ref('.info/connected').on('value', (snap) => {
  const connected = snap.val() === true;
  const banner = document.getElementById('offline-banner');
  if(banner){
    banner.classList.toggle('off-hidden', connected);
    updateOfflineBannerOffset();
  }
});

// Cette app ne met rien en cache côté service worker (pas de mode hors-ligne
// avec cache) — donc aucun service worker ne doit jamais intercepter les
// requêtes de pages, sous peine de servir une version figée de l'app à
// chaque visite, même après une mise à jour du site. On désinscrit donc tout
// service worker résiduel, à une seule exception : firebase-messaging-sw.js,
// qui n'a aucun gestionnaire "fetch" (uniquement push/notificationclick) et
// sert à recevoir les rappels de biberon même app fermée.
if('serviceWorker' in navigator){
  window.addEventListener('load', () => {
    navigator.serviceWorker.getRegistrations()
      .then(regs => regs.forEach(reg => {
        const url = (reg.active && reg.active.scriptURL) || (reg.installing && reg.installing.scriptURL) || (reg.waiting && reg.waiting.scriptURL) || '';
        if(!url.endsWith('/firebase-messaging-sw.js')) reg.unregister();
      }))
      .catch(() => {});
  });
}

let entries = [];
let selectedDiaper = 'none';
let currentView = 'today';
let calMonthDate = new Date();
let selectedCalDay = null;

const $ = (id) => document.getElementById(id);

function applyTheme(theme){
  document.documentElement.setAttribute('data-theme', theme);
  const switchBtn = $('theme-toggle-switch');
  if(switchBtn) switchBtn.classList.toggle('active', theme === 'dark');
  const metaTheme = document.querySelector('meta[name="theme-color"]');
  if(metaTheme) metaTheme.setAttribute('content', theme === 'dark' ? '#0a0d18' : '#f5f2fb');
  try{ localStorage.setItem('aylan-theme', theme); }catch(e){}
}

function toggleTheme(){
  const current = document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
  applyTheme(current === 'dark' ? 'light' : 'dark');
}

let initialTheme = 'light';
try{ initialTheme = localStorage.getItem('aylan-theme') || 'light'; }catch(e){}
applyTheme(initialTheme);

function pad(n){ return String(n).padStart(2,'0'); }

// Remet une clé de jour au format canonique "YYYY-MM-DD" (avec zéros de
// tête). Nécessaire car certaines entrées (notamment via l'import en masse,
// qui stocke la date telle que collée par l'utilisateur) peuvent arriver
// sous une forme non strictement zero-paddée ("2026-8-11" au lieu de
// "2026-08-11") — sans ça, ces entrées deviennent invisibles pour tout ce
// qui compare une dayKey à une clé générée par todayKey() (points du
// calendrier, stats du mois, graphiques), alors qu'elles restent trouvables
// via une comparaison "égale à elle-même" (recherche, détail du jour).
function normalizeDayKey(key){
  if(!key || typeof key !== 'string') return key;
  const parts = key.split('-');
  if(parts.length !== 3) return key;
  const [y, mo, d] = parts;
  if(!/^\d+$/.test(y) || !/^\d+$/.test(mo) || !/^\d+$/.test(d)) return key;
  return `${y.padStart(4,'0')}-${mo.padStart(2,'0')}-${d.padStart(2,'0')}`;
}

function nowTimeStr(){
  const d = new Date();
  return pad(d.getHours()) + ':' + pad(d.getMinutes());
}

function formatTimeFromTimestamp(ts){
  const d = new Date(ts);
  return pad(d.getHours()) + ':' + pad(d.getMinutes());
}

function formatDuration(mins){
  const m = Math.max(0, Math.round(mins));
  if(m < 60) return m + ' min';
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return h + 'h' + (rest ? pad(rest) : '');
}

// --- Sommeil (fonctionnalité optionnelle) ---
function getActiveSleepEntry(){
  return entries.find(e => e.type === 'sleep' && e.end == null) || null;
}

// Démarrer/arrêter une sieste passe par un verrou transactionnel Firebase
// (children/{id}/activeSleep) plutôt que par l'état local `entries` — celui-ci
// vient d'un listener asynchrone qui peut avoir quelques centaines de ms de
// retard. Sans ce verrou, deux parents cliquant "Sommeil" à quelques instants
// d'écart (avant que l'un ne voie l'action de l'autre) créeraient chacun une
// sieste active distincte : deux entrées avec `end: null` en même temps, l'une
// des deux restant bloquée en "En cours" indéfiniment. La transaction rend la
// décision démarrer/arrêter atomique côté serveur, quel que soit l'état local.
async function toggleSleep(){
  const lockRef = childRef('activeSleep');
  let outcome = null; // 'starting' | 'stopping'
  let sleepId = null;
  let sleepStart = null;

  let result;
  try{
    result = await lockRef.transaction((current) => {
      if(current && current.id){
        outcome = 'stopping';
        sleepId = current.id;
        sleepStart = current.start;
        return null; // libère le verrou
      }
      outcome = 'starting';
      sleepId = generateId('sleep');
      sleepStart = Date.now();
      return { id: sleepId, start: sleepStart };
    });
  }catch(e){
    showToast("Erreur d'enregistrement" + errorDetail(e), { duration: 4000 });
    return;
  }
  if(!result.committed) return; // transaction annulée côté serveur — l'utilisateur peut recliquer

  if(outcome === 'starting'){
    const entry = {
      id: sleepId,
      type: 'sleep',
      start: sleepStart,
      end: null,
      timestamp: sleepStart,
      dayKey: todayKey(new Date(sleepStart)),
      time: formatTimeFromTimestamp(sleepStart),
      authorEmail: auth.currentUser ? auth.currentUser.email : null
    };
    await addEntryToDB(entry);
    showToast('Sieste démarrée');
  }else{
    const now = Date.now();
    const known = entries.find(e => String(e.id) === String(sleepId));
    const base = known || {
      id: sleepId, type: 'sleep', start: sleepStart, dayKey: todayKey(new Date(sleepStart)),
      time: formatTimeFromTimestamp(sleepStart), timestamp: sleepStart,
      authorEmail: auth.currentUser ? auth.currentUser.email : null
    };
    const updated = Object.assign({}, base, {
      end: now,
      durationMin: Math.max(1, Math.round((now - sleepStart) / 60000))
    });
    await addEntryToDB(updated);
    showToast('Sommeil enregistré');
  }
  updateSleepButton();
}

let sleepTickInterval = null;
function updateSleepButton(){
  const btn = $('sleep-log-btn');
  const label = $('sleep-log-btn-label');
  if(!btn || !label) return;
  if(btn.classList.contains('hidden') && !familyFeatures.sleep){
    if(sleepTickInterval){ clearInterval(sleepTickInterval); sleepTickInterval = null; }
    return;
  }
  const active = getActiveSleepEntry();
  btn.classList.toggle('sleeping', !!active);
  if(active){
    const mins = Math.max(0, Math.round((Date.now() - active.start) / 60000));
    label.textContent = 'En cours · ' + formatDuration(mins);
    if(!sleepTickInterval) sleepTickInterval = setInterval(updateSleepButton, 30000);
  }else{
    label.textContent = 'Sommeil';
    if(sleepTickInterval){ clearInterval(sleepTickInterval); sleepTickInterval = null; }
  }
}

function setNow(){
  $('time-input').value = nowTimeStr();
  updateTimeFieldDisplay();
}

function dateInputVal(dateObj){
  return dateObj.getFullYear()+'-'+pad(dateObj.getMonth()+1)+'-'+pad(dateObj.getDate());
}

function setDateOffset(daysAgo){
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  $('date-input').value = dateInputVal(d);
  updateDateFieldDisplay();
}

// Étiquette lisible par-dessus les <input type="date">/<input type="time">
// natifs de la modale biberon — l'input natif reste la source de vérité
// (accessible, focusable au clavier, c'est lui qui porte la valeur), seul
// son rendu visuel (police système, format mm/dd/yyyy, horloge 12h — cf.
// audit technique) est masqué au profit d'un texte cohérent avec le reste
// de l'app. Un clic sur la zone stylée ouvre le sélecteur natif normalement.
function updateDateFieldDisplay(){
  const input = $('date-input');
  const display = $('date-input-display');
  if(!input || !display) return;
  display.textContent = input.value ? formatDayLabel(input.value) : 'Choisir une date';
}
function updateTimeFieldDisplay(){
  const input = $('time-input');
  const display = $('time-input-display');
  if(!input || !display) return;
  display.textContent = input.value || '--:--';
}
function openNativePicker(input){
  try{ input.showPicker(); }catch(e){ input.focus(); }
}

// Extrait un identifiant lisible d'une erreur Firebase (ex. "PERMISSION_DENIED")
// pour l'afficher dans le toast — sur Safari mobile il n'y a pas de console
// développeur accessible, ce détail est donc la seule façon de diagnostiquer
// un rejet serveur (règle .validate, permission, etc.) sans capture d'écran.
function errorDetail(e){
  const d = e && (e.code || e.message);
  return d ? ` (${d})` : '';
}

function showToast(msg, opts){
  const t = $('toast');
  t.innerHTML = '';
  const label = document.createElement('span');
  label.textContent = msg;
  t.appendChild(label);
  if(opts && opts.actionLabel && opts.onAction){
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'toast-action';
    btn.textContent = opts.actionLabel;
    btn.addEventListener('click', () => {
      opts.onAction();
      t.classList.remove('show');
      clearTimeout(t._hideTimeout);
    });
    t.appendChild(btn);
  }
  t.classList.add('show');
  clearTimeout(t._hideTimeout);
  t._hideTimeout = setTimeout(()=> t.classList.remove('show'), (opts && opts.duration) || 1800);
}

let childrenRef = null;
let entriesRef = null;
let profileRef = null;
let growthRef = null;
let settingsRef = null;
let vaccinesRef = null;
let milestonesRef = null;
let profileData = null;
let growthEntries = [];
let vaccinesList = [];
let milestonesList = [];
let currentFamilyId = null;
let currentChildId = null;
let childrenList = []; // [{id, firstName, lastName, birthDate, order, createdAt}]
let familyFeatures = { sleep: false, health: false, vaccines: false };

const DEFAULT_SITE_NAME = 'Bébé';

// Raccourcis d'icône (manifest.json "shortcuts") : ?shortcut=biberon|couche
// ouvre directement la fiche d'ajout correspondante dès que le premier enfant
// est prêt, sans attendre que l'utilisateur navigue jusqu'à l'écran Aujourd'hui.
const shortcutParam = new URLSearchParams(location.search).get('shortcut');
let shortcutHandled = false;
function handleLaunchShortcut(){
  if(!shortcutParam || shortcutHandled) return;
  shortcutHandled = true;
  history.replaceState(null, '', location.pathname);
  if(shortcutParam === 'biberon') openAddModal();
  else if(shortcutParam === 'couche') openDiaperModal();
}

function childRef(subpath){
  const base = 'families/' + currentFamilyId + '/children/' + currentChildId;
  return db.ref(subpath ? base + '/' + subpath : base);
}

function activeChildStorageKey(familyId){
  return 'suiviAylan:activeChild:' + familyId;
}
function getStoredActiveChildId(familyId){
  try{ return localStorage.getItem(activeChildStorageKey(familyId)); }catch(e){ return null; }
}
function setStoredActiveChildId(familyId, childId){
  try{ localStorage.setItem(activeChildStorageKey(familyId), childId); }catch(e){}
}

function getChildFirstName(){
  if(profileData && profileData.firstName){
    const first = profileData.firstName.trim().split(/\s+/)[0];
    if(first) return first;
  }
  return null;
}

function frenchDe(name){
  // "d'Aylan" devant une voyelle, "de Bébé" devant une consonne
  return /^[aeiouyâàäéèêëîïôöùûü]/i.test(name) ? "d'" + name : "de " + name;
}

function updateSiteTitle(){
  const displayName = getChildFirstName() || DEFAULT_SITE_NAME;
  document.title = 'Suivi ' + displayName;
  const appTitleEl = document.getElementById('app-title');
  if(appTitleEl) appTitleEl.textContent = displayName;
  const loginTitleEl = document.getElementById('login-title');
  if(loginTitleEl) loginTitleEl.textContent = displayName;
  const appleTitleMeta = document.querySelector('meta[name="apple-mobile-web-app-title"]');
  if(appleTitleMeta) appleTitleMeta.setAttribute('content', 'Suivi ' + displayName);

  const backupHintEl = document.getElementById('backup-hint-text');
  if(backupHintEl) backupHintEl.textContent = `Télécharge une copie complète et brute des données ${frenchDe(displayName)} (format JSON). Utile en cas de souci technique.`;
  const profileHeadingEl = document.getElementById('profile-info-heading');
  if(profileHeadingEl) profileHeadingEl.textContent = `Informations ${frenchDe(displayName)}`;
}

function generateId(prefix){
  return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function generateInviteCode(){
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for(let i = 0; i < 8; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

// Convertit une famille sur l'ancien schéma (profil/biberons/mesures directement
// sous la famille) vers le nouveau schéma multi-enfants (families/{id}/children/{childId}/...).
// Crée aussi le tout premier enfant (vide) pour une famille toute neuve.
// Protégé par une transaction sur le nœud "children" pour éviter qu'un double
// chargement simultané (deux appareils) crée deux enfants en double.
async function migrateFamilyToChildren(familyId){
  const childrenSnap = await db.ref('families/' + familyId + '/children').once('value');
  if(childrenSnap.exists()) return;

  const [profileSnap, entriesSnap, growthSnap] = await Promise.all([
    db.ref('families/' + familyId + '/profile').once('value'),
    db.ref('families/' + familyId + '/entries').once('value'),
    db.ref('families/' + familyId + '/growth').once('value')
  ]);

  const childId = generateId('child');
  const txResult = await db.ref('families/' + familyId + '/children').transaction(current => {
    if(current) return; // un autre appareil a déjà créé/migré entre-temps : on abandonne
    return { [childId]: { profile: profileSnap.val() || {}, meta: { order: 0, createdAt: Date.now() } } };
  });
  if(!txResult.committed) return;

  const updates = {};
  if(entriesSnap.exists()) updates['children/' + childId + '/entries'] = entriesSnap.val();
  if(growthSnap.exists()) updates['children/' + childId + '/growth'] = growthSnap.val();
  updates['profile'] = null;
  updates['entries'] = null;
  updates['growth'] = null;
  await db.ref('families/' + familyId).update(updates);
}

function applyFeatureVisibility(){
  $('sleep-log-btn').classList.toggle('hidden', !familyFeatures.sleep);
  $('health-log-btn').classList.toggle('hidden', !familyFeatures.health);
  const vaccinesTabBtn = $('profile-tab-vaccines');
  vaccinesTabBtn.classList.toggle('hidden', !familyFeatures.vaccines);
  if(!familyFeatures.vaccines && vaccinesTabBtn.classList.contains('active')){
    // Le feature était actif sur cet onglet : on retombe sur "Souvenirs" plutôt que
    // de laisser un onglet caché actif.
    const milestonesTabBtn = document.querySelector('.tab-btn[data-tab-group="profile"][data-tab="milestones"]');
    if(milestonesTabBtn) milestonesTabBtn.click();
  }
  $('filter-chip-sleep').classList.toggle('hidden', !familyFeatures.sleep);
  $('filter-chip-health').classList.toggle('hidden', !familyFeatures.health);
  $('feature-toggle-sleep').classList.toggle('active', familyFeatures.sleep);
  $('feature-toggle-health').classList.toggle('active', familyFeatures.health);
  $('feature-toggle-vaccines').classList.toggle('active', familyFeatures.vaccines);
  updateSleepButton();
}

async function toggleFamilyFeature(key){
  const newVal = !familyFeatures[key];
  try{
    // Rangé sous meta/ (déjà autorisé en écriture pour tout membre de la
    // famille par les règles existantes) plutôt que dans un nouveau chemin
    // "settings", pour éviter une nouvelle mise à jour des règles Firebase.
    await db.ref('families/' + currentFamilyId + '/meta/features/' + key).set(newVal);
  }catch(e){
    console.error('Erreur sauvegarde feature toggle :', e);
    showToast('Erreur de sauvegarde du paramètre');
  }
}

async function saveFamilyName(){
  const name = $('settings-family-name-input').value.trim() || 'Ma famille';
  $('settings-family-name-input').value = name;
  try{
    await db.ref('families/' + currentFamilyId + '/meta/name').set(name);
    showToast('Nom de la famille enregistré');
  }catch(e){
    showToast("Erreur d'enregistrement du nom" + errorDetail(e), { duration: 4000 });
  }
}

// Fuseau horaire de référence de la famille — utilisé par todayKey() pour que
// le regroupement par jour reste cohérent entre appareils, même si un parent
// voyage dans un autre fuseau (au lieu de dépendre du fuseau local de
// l'appareil qui enregistre chaque entrée). Auto-détecté à la création de la
// famille, modifiable ici.
let familyTimezone = null;

function populateTimezoneSelect(){
  const select = $('settings-timezone-select');
  if(!select || select.options.length) return; // déjà peuplé, pas besoin de refaire la liste à chaque rendu
  const deviceTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  let zones;
  try{ zones = Intl.supportedValuesOf('timeZone'); }catch(e){ zones = null; }
  if(!zones || !zones.length) zones = [deviceTz]; // navigateur ancien sans Intl.supportedValuesOf — au moins le fuseau de cet appareil
  select.innerHTML = zones.map(z => `<option value="${escapeHtml(z)}">${escapeHtml(z.replace(/_/g, ' '))}</option>`).join('');
}

async function saveFamilyTimezone(){
  const tz = $('settings-timezone-select').value;
  if(!tz) return;
  try{
    await db.ref('families/' + currentFamilyId + '/meta/timezone').set(tz);
    showToast('Fuseau horaire enregistré');
  }catch(e){
    showToast("Erreur d'enregistrement du fuseau" + errorDetail(e), { duration: 4000 });
  }
}

function switchToChild(childId){
  if(!childId || childId === currentChildId) return;
  if(entriesRef) entriesRef.off();
  if(profileRef) profileRef.off();
  if(growthRef) growthRef.off();
  if(vaccinesRef) vaccinesRef.off();
  if(milestonesRef) milestonesRef.off();

  // Annule toute édition en cours (le formulaire de mesure est affiché en
  // permanence dans l'onglet Infos > Croissance, hors modale) pour ne pas
  // laisser des champs pré-remplis avec les infos de l'enfant précédent.
  if(editingGrowthId !== null) cancelEditGrowth();
  if(typeof editingId !== 'undefined' && editingId !== null) cancelEdit();
  if(typeof editingDiaperId !== 'undefined' && editingDiaperId !== null) cancelEditDiaper();

  currentChildId = childId;
  setStoredActiveChildId(currentFamilyId, childId);
  dailySummaryChecked = false;
  const dsc = $('daily-summary-container');
  if(dsc){ dsc.classList.add('hidden'); dsc.innerHTML = ''; }

  entriesRef = childRef('entries');
  entriesRef.on('value', (snapshot) => {
    const val = snapshot.val();
    entries = val ? Object.values(val).map(e => ({ ...e, dayKey: normalizeDayKey(e.dayKey) })) : [];
    render();
  }, () => showToast("Erreur de synchronisation"));

  profileRef = childRef('profile');
  profileRef.on('value', (snapshot) => {
    profileData = snapshot.val() || null;
    renderProfileForm();
    renderAgeHero();
    updateSiteTitle();
    renderTodayHeader();
  }, () => showToast("Erreur de synchronisation"));

  growthRef = childRef('growth');
  growthRef.on('value', (snapshot) => {
    const val = snapshot.val();
    growthEntries = val ? Object.values(val) : [];
    renderGrowthList();
    renderGrowthCharts();
    // La carte "Croissance" du tableau de bord desktop (renderTodaySidebar,
    // appelée normalement depuis render()) dépend de growthEntries — sans cet
    // appel, elle resterait vide au premier chargement si ce listener répond
    // après celui des entrées (aucun ordre garanti entre deux écouteurs
    // Firebase distincts), jusqu'au prochain render() déclenché ailleurs.
    renderTodaySidebar();
  }, () => showToast("Erreur de synchronisation"));

  vaccinesRef = childRef('vaccines');
  vaccinesRef.on('value', (snapshot) => {
    const val = snapshot.val() || {};
    vaccinesList = Object.values(val).sort((a, b) => (a.date || '').localeCompare(b.date || ''));
    renderVaccinesList();
  }, () => showToast("Erreur de synchronisation"));

  milestonesRef = childRef('milestones');
  milestonesRef.on('value', (snapshot) => {
    const val = snapshot.val() || {};
    milestonesList = Object.values(val).sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    renderMilestones();
  }, () => showToast("Erreur de synchronisation"));

  refreshChildrenUI();
}

function refreshChildrenUI(){
  const deleteBtn = $('profile-delete-child-btn');
  if(deleteBtn){
    deleteBtn.classList.toggle('hidden', childrenList.length <= 1);
    deleteBtn.textContent = 'Supprimer cet enfant';
    deleteBtn.classList.remove('confirming');
    deleteChildArmed = false;
  }

  renderChildrenPage();
  renderChildSwitcherToday();
}

function childChipsMarkup(){
  return childrenList.map(c => {
    const fullName = [c.firstName, c.lastName].filter(Boolean).join(' ').trim() || DEFAULT_SITE_NAME;
    const initial = initialLetterFor(c.firstName, c.lastName);
    const active = c.id === currentChildId ? ' active' : '';
    const avatarContent = c.avatar ? `<img src="${escapeHtml(c.avatar)}" alt="">` : escapeHtml(initial);
    return `<button type="button" class="child-chip${active}" data-child="${c.id}" title="${escapeHtml(fullName)}" aria-label="${escapeHtml(fullName)}">${avatarContent}</button>`;
  }).join('');
}

function renderChildrenPage(){
  const list = $('children-list-page');
  if(!list) return;

  if(!childrenList.length && lastMigrationError){
    list.innerHTML = `<div class="child-switcher-error">⚠️ Erreur de chargement du suivi. Vérifie ta connexion et recharge la page.</div>`;
    return;
  }

  list.innerHTML = childChipsMarkup() + `<button type="button" class="child-chip child-chip-add" data-add-child aria-label="Ajouter un enfant">
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
  </button>`;
}

// Raccourci de changement d'enfant directement sur l'écran "Aujourd'hui" :
// une famille à plusieurs enfants devait auparavant passer par l'onglet Profil
// pour logger sur le second enfant. N'apparaît que s'il y a plus d'un enfant —
// inutile de montrer un sélecteur à une famille qui n'en a qu'un.
function renderChildSwitcherToday(){
  const row = $('children-list-today');
  if(!row) return;
  if(childrenList.length <= 1){
    row.classList.add('hidden');
    row.innerHTML = '';
    return;
  }
  row.classList.remove('hidden');
  row.innerHTML = childChipsMarkup();
}

async function addChild(profile){
  const maxOrder = childrenList.reduce((m, c) => Math.max(m, c.order || 0), -1);
  const childId = generateId('child');
  try{
    await db.ref('families/' + currentFamilyId + '/children/' + childId).set({
      profile: profile || {},
      meta: { order: maxOrder + 1, createdAt: Date.now() }
    });
    switchToChild(childId);
    showToast('Enfant ajouté');
  }catch(e){
    showToast("Erreur lors de l'ajout");
  }
}

function openAddChildModal(){
  $('add-child-firstname-input').value = '';
  $('add-child-lastname-input').value = '';
  $('add-child-birthdate-input').value = '';
  openModal('add-child-modal-overlay');
}

function closeAddChildModal(){
  closeModal('add-child-modal-overlay');
}

async function confirmAddChild(){
  const firstName = $('add-child-firstname-input').value.trim();
  const lastName = $('add-child-lastname-input').value.trim();
  const birthDate = $('add-child-birthdate-input').value;

  if(!firstName){
    showToast('Le prénom est obligatoire');
    return;
  }

  await addChild({ firstName, lastName, birthDate });
  closeAddChildModal();
}

let deleteChildArmed = false;
async function deleteCurrentChild(){
  if(childrenList.length <= 1) return;
  try{
    await db.ref('families/' + currentFamilyId + '/children/' + currentChildId).remove();
    showToast('Enfant supprimé');
  }catch(e){
    showToast('Erreur de suppression');
  }
}

let lastMigrationError = null;

// Code d'invitation de la page Paramètres : masqué par défaut (visible par-dessus
// une épaule ou en partage d'écran), un bouton "œil" le dévoile et un bouton
// "copier" le met dans le presse-papier sans avoir à le sélectionner à la main.
let inviteCodeValue = '—';
let inviteCodeRevealed = false;
const EYE_ICON = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>';
const EYE_OFF_ICON = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3l18 18"/><path d="M10.6 5.2A10.6 10.6 0 0 1 12 5c6.5 0 10 7 10 7a17.9 17.9 0 0 1-3.2 4.2M6.6 6.6C4 8.3 2 12 2 12s3.5 7 10 7c1.4 0 2.6-.3 3.7-.8"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>';

function renderInviteCodeDisplay(){
  const el = $('settings-invite-code');
  const btn = $('settings-invite-reveal-btn');
  if(!el || !btn) return;
  const hasCode = inviteCodeValue && inviteCodeValue !== '—';
  el.textContent = (inviteCodeRevealed || !hasCode) ? inviteCodeValue : '••••••••';
  btn.innerHTML = inviteCodeRevealed ? EYE_OFF_ICON : EYE_ICON;
  btn.setAttribute('aria-label', inviteCodeRevealed ? 'Masquer le code' : 'Afficher le code');
  btn.setAttribute('aria-pressed', String(inviteCodeRevealed));
}

function toggleInviteCodeReveal(){
  inviteCodeRevealed = !inviteCodeRevealed;
  renderInviteCodeDisplay();
}

async function copyInviteCode(explicitCode){
  const code = explicitCode || inviteCodeValue;
  if(!code || code === '—'){ showToast('Code pas encore disponible'); return; }
  try{
    await navigator.clipboard.writeText(code);
    showToast('Code copié dans le presse-papier');
  }catch(e){
    showToast('Impossible de copier le code');
  }
}

function startSync(){
  settingsRef = db.ref('families/' + currentFamilyId + '/meta');
  settingsRef.on('value', (snapshot) => {
    const meta = snapshot.val() || {};
    $('settings-family-name-input').value = meta.name || 'Ma famille';
    inviteCodeValue = meta.inviteCode || '—';
    renderInviteCodeDisplay();
    $('settings-summary-name').textContent = meta.name || 'Ma famille';
    const val = meta.features || {};
    familyFeatures = { sleep: !!val.sleep, health: !!val.health, vaccines: !!val.vaccines };
    applyFeatureVisibility();

    // Réglage du rappel de biberon : partagé par toute la famille (pas par
    // appareil comme avant) — un parent qui règle un seuil le voit s'appliquer
    // partout, y compris côté worker qui envoie le push planifié (§ Cloudflare).
    const r = meta.reminder || {};
    reminderEnabled = !!r.enabled;
    reminderThresholdMinutes = (r.thresholdMinutes > 0) ? r.thresholdMinutes : 210;
    renderReminderPrefsUI();

    familyTimezone = meta.timezone || null;
    populateTimezoneSelect();
    const tzSelect = $('settings-timezone-select');
    if(tzSelect) tzSelect.value = familyTimezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  }, (err) => {
    console.error('Erreur de lecture de meta :', err);
  });

  silentlyRefreshPushToken();

  migrateFamilyToChildren(currentFamilyId).then(() => {
    lastMigrationError = null;
  }).catch((err) => {
    console.error('Migration vers le schéma multi-enfants échouée :', err);
    lastMigrationError = err;
    showToast('Erreur : impossible de préparer le suivi (vérifie les règles Firebase)');
  }).then(() => {
    childrenRef = db.ref('families/' + currentFamilyId + '/children');
    childrenRef.on('value', (snapshot) => {
      const val = snapshot.val() || {};
      childrenList = Object.keys(val).map(id => {
        const c = val[id] || {};
        const meta = c.meta || {};
        return { id, ...(c.profile || {}), order: meta.order || 0, createdAt: meta.createdAt || 0 };
      }).sort((a, b) => a.order - b.order || a.createdAt - b.createdAt);

      refreshChildrenUI();
      if(!childrenList.length) return;

      const stillExists = currentChildId && childrenList.some(c => c.id === currentChildId);
      if(!stillExists){
        const stored = getStoredActiveChildId(currentFamilyId);
        const fallback = (stored && childrenList.find(c => c.id === stored)) || childrenList[0];
        switchToChild(fallback.id);
      }
      handleLaunchShortcut();
    }, (err) => {
      console.error('Erreur de lecture des enfants :', err);
      showToast('Erreur de synchronisation');
    });
  });
}

function stopSync(){
  if(childrenRef) childrenRef.off();
  if(entriesRef) entriesRef.off();
  if(profileRef) profileRef.off();
  if(growthRef) growthRef.off();
  if(settingsRef) settingsRef.off();
  if(vaccinesRef) vaccinesRef.off();
  if(milestonesRef) milestonesRef.off();
  childrenRef = entriesRef = profileRef = growthRef = settingsRef = vaccinesRef = milestonesRef = null;
  entries = [];
  profileData = null;
  growthEntries = [];
  vaccinesList = [];
  milestonesList = [];
  childrenList = [];
  currentChildId = null;
  familyFeatures = { sleep: false, health: false, vaccines: false };
  updateSiteTitle();
  refreshChildrenUI();
  applyFeatureVisibility();

  // Repart sur "Aujourd'hui" à la prochaine connexion, même si on s'est
  // déconnecté depuis la page Paramètres ou une autre vue.
  currentView = 'today';
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === 'view-today'));
  document.querySelectorAll('.bottom-nav-btn[data-view]').forEach(b => b.classList.toggle('active', b.getAttribute('data-view') === 'today'));
  $('app-wrap').classList.add('wide-view');
  const viewLabelEl = $('current-view-label');
  if(viewLabelEl) viewLabelEl.textContent = VIEW_LABELS.today;
  $('fab-btn').classList.remove('hidden');
}

async function addEntryToDB(entry){
  // Horodatage systématique de la dernière écriture — sert de base à la
  // détection de conflit d'édition concurrente (voir checkEditConflict).
  entry.updatedAt = Date.now();
  try{
    await childRef('entries/' + entry.id).set(entry);
  }catch(e){
    showToast("Erreur d'enregistrement" + errorDetail(e), { duration: 4000 });
    throw e; // l'appelant ne doit jamais afficher un succès après un échec réel
  }
}

// Avant d'écraser une entrée en édition, vérifie qu'elle n'a pas été modifiée
// par quelqu'un d'autre depuis son ouverture (usage multi-parents normal de
// l'app). `loadedUpdatedAt` est la valeur vue au moment d'ouvrir l'édition ;
// si elle diffère de celle actuellement en base, l'utilisateur est prévenu
// avant d'écraser silencieusement le travail de l'autre personne.
// `subpath` est le chemin relatif à l'enfant courant (ex. "entries/123" ou
// "growth/456") — généralisé pour servir tous les types d'édition, pas
// seulement les entrées journalières.
async function checkEditConflict(subpath, loadedUpdatedAt){
  if(loadedUpdatedAt == null) return true; // pas de référence connue (entrée jamais modifiée avant cette fonctionnalité) — rien à comparer
  try{
    const snap = await childRef(subpath).once('value');
    const fresh = snap.val();
    if(!fresh){
      return confirm("Cette entrée a été supprimée entre-temps par quelqu'un d'autre. Créer quand même une nouvelle entrée avec tes modifications ?");
    }
    if(fresh.updatedAt && fresh.updatedAt !== loadedUpdatedAt){
      return confirm('Cette entrée a été modifiée par quelqu\'un d\'autre depuis que tu l\'as ouverte. Écraser quand même avec tes modifications ?');
    }
  }catch(e){
    // Lecture de vérification impossible (hors-ligne, etc.) — on ne bloque pas
    // la sauvegarde pour autant, ce serait pire que le risque qu'on couvre.
  }
  return true;
}

async function removeEntryFromDB(id){
  try{
    await childRef('entries/' + id).remove();
  }catch(e){
    showToast("Erreur de suppression");
    throw e; // l'appelant ne doit jamais afficher un succès après un échec réel
  }
}

function computeAge(birthDateStr){
  const [y,mo,d] = birthDateStr.split('-').map(Number);
  const birth = new Date(y, mo-1, d);
  const now = new Date();
  if(birth > now) return '—';

  let years = now.getFullYear() - birth.getFullYear();
  let months = now.getMonth() - birth.getMonth();
  let days = now.getDate() - birth.getDate();

  if(days < 0){
    months--;
    const prevMonth = new Date(now.getFullYear(), now.getMonth(), 0);
    days += prevMonth.getDate();
  }
  if(months < 0){
    years--;
    months += 12;
  }

  if(years > 0) return `${years} an${years > 1 ? 's' : ''}${months > 0 ? ' et ' + months + ' mois' : ''}`;
  if(months > 0) return `${months} mois${days > 0 ? ' et ' + days + ' jour' + (days > 1 ? 's' : '') : ''}`;
  return `${days} jour${days > 1 ? 's' : ''}`;
}

function renderProfileForm(){
  $('profile-firstname').value = (profileData && profileData.firstName) || '';
  $('profile-lastname').value = (profileData && profileData.lastName) || '';
  $('profile-birthdate').value = (profileData && profileData.birthDate) || '';
  selectGender((profileData && profileData.gender) || null);
  profileAvatarDataUrl = (profileData && profileData.avatar) || null;
  $('profile-avatar-input').value = '';
  renderAvatarEditPreview();
}

let selectedGender = null;
function selectGender(val){
  selectedGender = val;
  document.querySelectorAll('#profile-gender-row .diaper-btn').forEach(b => {
    b.classList.toggle('active', b.getAttribute('data-val') === val);
  });
}

let profileAvatarDataUrl = null;
function initialLetterFor(firstName, lastName){
  return ((firstName || lastName || '?').trim().charAt(0) || '?').toUpperCase();
}
function renderAvatarEditPreview(){
  const preview = $('profile-avatar-preview');
  const initial = initialLetterFor($('profile-firstname').value, $('profile-lastname').value);
  preview.innerHTML = profileAvatarDataUrl ? `<img src="${escapeHtml(profileAvatarDataUrl)}" alt="">` : escapeHtml(initial);
  $('profile-avatar-remove-btn').classList.toggle('hidden', !profileAvatarDataUrl);
}

// En-tête chaleureux de l'écran "Aujourd'hui" — remplace le générique
// .app-header (masqué sur cet écran, voir switchView) par une identité
// construite autour de l'enfant : son prénom + un avatar, pas un titre
// d'application. Même logique d'avatar que renderAgeHero() (photo si
// définie, sinon initiale).
function renderTodayHeader(){
  const nameEl = $('today-hero-name');
  const avatarEl = $('today-hero-avatar');
  if(!nameEl || !avatarEl) return;
  const name = getChildFirstName() || DEFAULT_SITE_NAME;
  nameEl.textContent = name;
  const initial = initialLetterFor(profileData && profileData.firstName, profileData && profileData.lastName);
  avatarEl.innerHTML = (profileData && profileData.avatar) ? `<img src="${escapeHtml(profileData.avatar)}" alt="">` : escapeHtml(initial);
}

function renderAgeHero(){
  const hero = $('age-hero');
  if(profileData && profileData.birthDate){
    hero.classList.remove('hidden');
    const name = getChildFirstName() || DEFAULT_SITE_NAME;
    $('age-name-lbl').textContent = 'Suivi(e) actuellement';
    $('age-value').textContent = `${name} · ${computeAge(profileData.birthDate)}`;
    const initial = initialLetterFor(profileData.firstName, profileData.lastName);
    $('profile-hero-avatar').innerHTML = profileData.avatar ? `<img src="${escapeHtml(profileData.avatar)}" alt="">` : escapeHtml(initial);
  }else{
    hero.classList.add('hidden');
  }
}

async function saveProfile(){
  const firstName = $('profile-firstname').value.trim();
  const lastName = $('profile-lastname').value.trim();
  const birthDate = $('profile-birthdate').value;

  if(!birthDate){
    showToast('Merci de renseigner la date de naissance');
    return;
  }

  const btn = $('profile-save-btn');
  btn.disabled = true;
  try{
    await childRef('profile').set({ firstName, lastName, birthDate, gender: selectedGender || null, avatar: profileAvatarDataUrl || null });
    showToast('Informations enregistrées');
  }catch(e){
    showToast("Erreur d'enregistrement" + errorDetail(e), { duration: 4000 });
  }finally{
    btn.disabled = false;
  }
}

function formatShortDate(dateStr){
  const [y,m,d] = dateStr.split('-');
  return `${d}/${m}/${y}`;
}

function formatShortDateNoYear(dateStr){
  const [y,m,d] = dateStr.split('-');
  return `${d}/${m}`;
}

function growthRowHtml(g){
  const parts = [];
  if(g.weight != null) parts.push(`${g.weight} kg`);
  if(g.height != null) parts.push(`${g.height} cm`);
  if(g.headCirc != null) parts.push(`PC ${g.headCirc} cm`);
  return `
    <div class="entry" data-id="${g.id}">
      <div class="node growth-node"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 17l6-6 4 4 8-8"/><path d="M17 7h4v4"/></svg></div>
      <div class="entry-card">
        <div class="entry-main">
          <div class="entry-time">${formatShortDate(g.date)}</div>
          <div class="entry-details">
            <div class="entry-ml">${parts.join(' · ')}</div>
          </div>
        </div>
        <div class="entry-actions">
          <button class="entry-edit" data-gedit="${g.id}" aria-label="Modifier">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
          </button>
          <button class="entry-del" data-gdel="${g.id}">✕</button>
        </div>
      </div>
    </div>`;
}

function bindGrowthButtons(container){
  container.querySelectorAll('[data-gdel]').forEach(btn => {
    btn.addEventListener('click', () => {
      if(btn.classList.contains('confirming')){
        clearTimeout(btn._confirmTimeout);
        deleteGrowthEntry(btn.getAttribute('data-gdel'));
        return;
      }
      btn.classList.add('confirming');
      btn.textContent = 'Confirmer';
      btn._confirmTimeout = setTimeout(() => {
        btn.classList.remove('confirming');
        btn.textContent = '✕';
      }, 3000);
    });
  });
  container.querySelectorAll('[data-gedit]').forEach(btn => {
    btn.addEventListener('click', () => startEditGrowth(btn.getAttribute('data-gedit')));
  });
}

function renderGrowthList(){
  const container = $('growth-list');
  if(!growthEntries.length){
    container.innerHTML = `<div class="empty">Aucune mesure enregistrée pour l'instant.</div>`;
    return;
  }
  const sorted = [...growthEntries].sort((a,b) => b.date.localeCompare(a.date));
  container.innerHTML = `<div class="timeline">${sorted.map(growthRowHtml).join('')}</div>`;
  bindGrowthButtons(container);
}

function resetGrowthForm(){
  $('growth-date-input').value = dateInputVal(new Date());
  $('growth-weight-input').value = '';
  $('growth-height-input').value = '';
  $('growth-headcirc-input').value = '';
}

let editingGrowthId = null;
let editingGrowthLoadedUpdatedAt = null;

function startEditGrowth(id){
  const g = growthEntries.find(x => String(x.id) === String(id));
  if(!g) return;

  editingGrowthId = id;
  editingGrowthLoadedUpdatedAt = g.updatedAt || null;
  $('growth-date-input').value = g.date;
  $('growth-weight-input').value = g.weight != null ? g.weight : '';
  $('growth-height-input').value = g.height != null ? g.height : '';
  $('growth-headcirc-input').value = g.headCirc != null ? g.headCirc : '';

  $('growth-form-title').textContent = 'Modifier cette mesure';
  $('growth-save-btn').textContent = 'Enregistrer les modifications';
  $('growth-cancel-btn').classList.remove('hidden');

  const section = $('growth-form-section');
  section.classList.add('expanded');
  section.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function cancelEditGrowth(){
  editingGrowthId = null;
  editingGrowthLoadedUpdatedAt = null;
  $('growth-form-title').textContent = 'Ajouter une mesure';
  $('growth-save-btn').textContent = 'Enregistrer la mesure';
  $('growth-cancel-btn').classList.add('hidden');
  resetGrowthForm();
}

// Bornes de plausibilité (pas des limites médicales strictes) — juste de quoi
// attraper une faute de frappe évidente (ex. 45 kg au lieu de 4,5) sans jamais
// bloquer une mesure réelle, même atypique.
const GROWTH_BOUNDS = {
  weight: { min: 0.3, max: 40, label: 'Poids', unit: 'kg' },
  height: { min: 15, max: 150, label: 'Taille', unit: 'cm' },
  headCirc: { min: 15, max: 65, label: 'Périmètre crânien', unit: 'cm' },
};
function parseGrowthField(rawVal, key){
  if(!rawVal) return { value: null, error: null };
  const n = parseFloat(rawVal);
  const bounds = GROWTH_BOUNDS[key];
  if(!Number.isFinite(n)){
    return { value: null, error: `${bounds.label} : valeur non reconnue` };
  }
  if(n < bounds.min || n > bounds.max){
    return { value: null, error: `${bounds.label} hors limites (${bounds.min} à ${bounds.max} ${bounds.unit}) — vérifie la valeur` };
  }
  return { value: n, error: null };
}

async function saveGrowthEntry(){
  const dateVal = $('growth-date-input').value || dateInputVal(new Date());
  const weightVal = $('growth-weight-input').value;
  const heightVal = $('growth-height-input').value;
  const headCircVal = $('growth-headcirc-input').value;

  if(!weightVal && !heightVal && !headCircVal){
    showToast('Renseigne au moins un poids, une taille ou un périmètre crânien');
    return;
  }

  const weight = parseGrowthField(weightVal, 'weight');
  const height = parseGrowthField(heightVal, 'height');
  const headCirc = parseGrowthField(headCircVal, 'headCirc');
  const firstError = weight.error || height.error || headCirc.error;
  if(firstError){
    showToast(firstError);
    return;
  }

  const isEditing = editingGrowthId !== null;
  const entry = {
    id: isEditing ? editingGrowthId : generateId('gr'),
    date: dateVal,
    weight: weight.value,
    height: height.value,
    headCirc: headCirc.value,
    updatedAt: Date.now()
  };

  if(isEditing && !(await checkEditConflict('growth/' + editingGrowthId, editingGrowthLoadedUpdatedAt))) return;

  const btn = $('growth-save-btn');
  btn.disabled = true;
  try{
    await childRef('growth/' + entry.id).set(entry);
    showToast(isEditing ? 'Mesure modifiée' : 'Mesure enregistrée');
  }catch(e){
    showToast("Erreur d'enregistrement" + errorDetail(e), { duration: 4000 });
  }finally{
    btn.disabled = false;
  }

  if(isEditing) cancelEditGrowth();
  else resetGrowthForm();
}

async function deleteGrowthEntry(id){
  const removed = growthEntries.find(g => String(g.id) === String(id));
  try{
    await childRef('growth/' + id).remove();
    showToast('Mesure supprimée', removed ? { actionLabel: 'Annuler', onAction: () => childRef('growth/' + id).set(removed) } : undefined);
  }catch(e){
    showToast('Erreur de suppression');
  }
}

// --- Vaccins & rendez-vous (fonctionnalité optionnelle) ---
function renderVaccinesList(){
  const container = $('vaccines-list');
  if(!container) return;
  if(!vaccinesList.length){
    container.innerHTML = `<div class="empty">Aucun vaccin ou rendez-vous enregistré.</div>`;
    return;
  }
  container.innerHTML = vaccinesList.map(v => `
    <div class="vaccine-row" data-id="${v.id}">
      <button class="vaccine-check${v.done ? ' done' : ''}" data-vaccine-toggle="${v.id}" aria-label="Marquer comme fait">${v.done ? '✓' : ''}</button>
      <div class="vaccine-info">
        <div class="vaccine-name${v.done ? ' done' : ''}">${escapeHtml(v.name)}</div>
        <div class="vaccine-date">${v.date ? formatShortDate(v.date) : 'Sans date'}</div>
      </div>
      <button class="entry-del" data-vaccine-del="${v.id}">✕</button>
    </div>`).join('');

  container.querySelectorAll('[data-vaccine-toggle]').forEach(btn => {
    btn.addEventListener('click', () => toggleVaccineDone(btn.getAttribute('data-vaccine-toggle')));
  });
  container.querySelectorAll('[data-vaccine-del]').forEach(btn => {
    btn.addEventListener('click', () => {
      if(btn.classList.contains('confirming')){
        clearTimeout(btn._confirmTimeout);
        deleteVaccine(btn.getAttribute('data-vaccine-del'));
        return;
      }
      btn.classList.add('confirming');
      btn.textContent = 'Confirmer';
      btn._confirmTimeout = setTimeout(() => {
        btn.classList.remove('confirming');
        btn.textContent = '✕';
      }, 3000);
    });
  });
}

async function addVaccine(){
  const name = $('vaccine-name-input').value.trim();
  const date = $('vaccine-date-input').value;
  if(!name){
    showToast('Merci de donner un nom (ex : DTP 2 mois)');
    return;
  }
  const id = generateId('vax');
  const btn = $('vaccine-add-btn');
  btn.disabled = true;
  try{
    await childRef('vaccines/' + id).set({ id, name, date: date || '', done: false });
    $('vaccine-name-input').value = '';
    $('vaccine-date-input').value = '';
    showToast('Ajouté');
  }catch(e){
    showToast("Erreur d'enregistrement" + errorDetail(e), { duration: 4000 });
  }finally{
    btn.disabled = false;
  }
}

async function toggleVaccineDone(id){
  const v = vaccinesList.find(x => x.id === id);
  if(!v) return;
  try{
    await childRef('vaccines/' + id + '/done').set(!v.done);
  }catch(e){
    showToast('Erreur de mise à jour');
  }
}

async function deleteVaccine(id){
  const removed = vaccinesList.find(v => String(v.id) === String(id));
  try{
    await childRef('vaccines/' + id).remove();
    showToast('Supprimé', removed ? { actionLabel: 'Annuler', onAction: () => childRef('vaccines/' + id).set(removed) } : undefined);
  }catch(e){
    showToast('Erreur de suppression');
  }
}

// --- Souvenirs & photos ---
function renderMilestones(){
  const grid = $('milestone-grid');
  if(!grid) return;
  if(!milestonesList.length){
    grid.innerHTML = '';
    return;
  }
  grid.innerHTML = milestonesList.map(m => `
    <div class="milestone-card" data-id="${m.id}">
      ${m.photo ? `<img class="milestone-photo" src="${escapeHtml(m.photo)}" alt="${escapeHtml(m.label || '')}">` : ''}
      <div class="milestone-info">
        <div class="milestone-label">${escapeHtml(m.label || 'Souvenir')}</div>
        <div class="milestone-date">${m.date ? formatShortDate(m.date) : ''}</div>
      </div>
      <button class="milestone-del" data-milestone-del="${m.id}" aria-label="Supprimer">✕</button>
    </div>`).join('');

  grid.querySelectorAll('[data-milestone-del]').forEach(btn => {
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      if(btn.classList.contains('confirming')){
        clearTimeout(btn._confirmTimeout);
        deleteMilestone(btn.getAttribute('data-milestone-del'));
        return;
      }
      btn.classList.add('confirming');
      btn.textContent = '?';
      btn._confirmTimeout = setTimeout(() => {
        btn.classList.remove('confirming');
        btn.textContent = '✕';
      }, 3000);
    });
  });

  // Toucher/cliquer la photo l'ouvre en plein écran (lightbox) — sinon
  // aucun moyen de la consulter en grand une fois enregistrée, la vignette
  // carrée de la grille la recadre systématiquement.
  grid.querySelectorAll('.milestone-photo').forEach(img => {
    img.addEventListener('click', () => {
      const id = img.closest('.milestone-card').getAttribute('data-id');
      const m = milestonesList.find(x => String(x.id) === String(id));
      if(m && m.photo) openPhotoLightbox(m.photo, m.label);
    });
  });
}

async function deleteMilestone(id){
  const removed = milestonesList.find(m => String(m.id) === String(id));
  try{
    await childRef('milestones/' + id).remove();
    showToast('Souvenir supprimé', removed ? { actionLabel: 'Annuler', onAction: () => childRef('milestones/' + id).set(removed) } : undefined);
  }catch(e){
    showToast('Erreur de suppression');
  }
}

let milestonePhotoDataUrl = null;

function compressImageFile(file, maxDim, quality){
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('read failed'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('decode failed'));
      img.onload = () => {
        let w = img.width, h = img.height;
        if(w > h && w > maxDim){ h = Math.round(h * maxDim / w); w = maxDim; }
        else if(h > maxDim){ w = Math.round(w * maxDim / h); h = maxDim; }
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

function resetMilestoneForm(){
  milestonePhotoDataUrl = null;
  $('milestone-photo-input').value = '';
  $('milestone-photo-preview').classList.add('hidden');
  $('milestone-photo-preview').src = '';
  $('milestone-label-input').value = '';
  $('milestone-date-input').value = dateInputVal(new Date());
  $('milestone-note-input').value = '';
}

function openMilestoneModal(){
  resetMilestoneForm();
  openModal('milestone-modal-overlay');
}
function closeMilestoneModal(){
  closeModal('milestone-modal-overlay');
}

async function saveMilestone(){
  const label = $('milestone-label-input').value.trim();
  const date = $('milestone-date-input').value || dateInputVal(new Date());
  const note = $('milestone-note-input').value.trim();
  if(!label){
    showToast('Donne un nom à ce souvenir');
    return;
  }
  const id = generateId('mile');
  const payload = { id, label, date, note };
  if(milestonePhotoDataUrl) payload.photo = milestonePhotoDataUrl;
  const btn = $('milestone-save-btn');
  btn.disabled = true;
  try{
    await childRef('milestones/' + id).set(payload);
    showToast('Souvenir enregistré');
    closeMilestoneModal();
  }catch(e){
    showToast("Erreur d'enregistrement (photo peut-être trop lourde)" + errorDetail(e), { duration: 4000 });
  }finally{
    btn.disabled = false;
  }
}

// Repères de croissance approximatifs (garçons), à titre indicatif uniquement — ne remplace pas le carnet de santé officiel.
const WHO_WEIGHT_BOYS = [
  {m:0, p3:2.5, p50:3.3, p97:4.4}, {m:1, p3:3.4, p50:4.5, p97:5.8},
  {m:2, p3:4.3, p50:5.6, p97:7.1}, {m:3, p3:5.0, p50:6.4, p97:8.0},
  {m:4, p3:5.6, p50:7.0, p97:8.7}, {m:5, p3:6.0, p50:7.5, p97:9.3},
  {m:6, p3:6.4, p50:7.9, p97:9.8}, {m:9, p3:7.1, p50:8.9, p97:11.0},
  {m:12, p3:7.7, p50:9.6, p97:11.8}, {m:15, p3:8.3, p50:10.3, p97:12.8},
  {m:18, p3:8.8, p50:10.9, p97:13.7}, {m:21, p3:9.2, p50:11.5, p97:14.5},
  {m:24, p3:9.7, p50:12.2, p97:15.3}
];
const WHO_HEIGHT_BOYS = [
  {m:0, p3:46.1, p50:49.9, p97:53.7}, {m:1, p3:50.8, p50:54.7, p97:58.6},
  {m:2, p3:54.4, p50:58.4, p97:62.4}, {m:3, p3:57.3, p50:61.4, p97:65.5},
  {m:4, p3:59.7, p50:63.9, p97:68.0}, {m:5, p3:61.7, p50:65.9, p97:70.1},
  {m:6, p3:63.3, p50:67.6, p97:71.9}, {m:9, p3:67.5, p50:72.0, p97:76.5},
  {m:12, p3:71.0, p50:75.7, p97:80.5}, {m:15, p3:74.1, p50:79.1, p97:84.2},
  {m:18, p3:76.9, p50:82.3, p97:87.7}, {m:21, p3:79.4, p50:85.1, p97:90.9},
  {m:24, p3:81.7, p50:87.8, p97:93.9}
];
// Filles — mêmes repères approximatifs, à titre indicatif uniquement.
const WHO_WEIGHT_GIRLS = [
  {m:0, p3:2.4, p50:3.2, p97:4.3}, {m:1, p3:3.2, p50:4.2, p97:5.4},
  {m:2, p3:3.9, p50:5.1, p97:6.5}, {m:3, p3:4.5, p50:5.8, p97:7.3},
  {m:4, p3:5.1, p50:6.4, p97:8.0}, {m:5, p3:5.5, p50:6.9, p97:8.6},
  {m:6, p3:5.9, p50:7.3, p97:9.1}, {m:9, p3:6.5, p50:8.2, p97:10.1},
  {m:12, p3:7.1, p50:8.9, p97:10.9}, {m:15, p3:7.7, p50:9.6, p97:11.9},
  {m:18, p3:8.2, p50:10.2, p97:12.8}, {m:21, p3:8.7, p50:10.9, p97:13.7},
  {m:24, p3:9.1, p50:11.5, p97:14.4}
];
const WHO_HEIGHT_GIRLS = [
  {m:0, p3:45.4, p50:49.1, p97:52.8}, {m:1, p3:49.9, p50:53.7, p97:57.5},
  {m:2, p3:53.2, p50:57.1, p97:61.0}, {m:3, p3:55.8, p50:59.8, p97:63.8},
  {m:4, p3:58.0, p50:62.1, p97:66.1}, {m:5, p3:59.9, p50:64.0, p97:68.1},
  {m:6, p3:61.5, p50:65.7, p97:69.9}, {m:9, p3:65.7, p50:70.1, p97:74.5},
  {m:12, p3:69.4, p50:74.0, p97:78.7}, {m:15, p3:72.6, p50:77.5, p97:82.5},
  {m:18, p3:75.4, p50:80.7, p97:86.0}, {m:21, p3:78.1, p50:83.7, p97:89.4},
  {m:24, p3:80.4, p50:86.4, p97:92.4}
];
// Périmètre crânien — repères approximatifs, à titre indicatif uniquement.
const WHO_HEADCIRC_BOYS = [
  {m:0, p3:32.1, p50:34.5, p97:36.9}, {m:1, p3:35.1, p50:37.3, p97:39.5},
  {m:2, p3:36.9, p50:39.1, p97:41.3}, {m:3, p3:38.3, p50:40.5, p97:42.8},
  {m:4, p3:39.4, p50:41.6, p97:43.9}, {m:5, p3:40.3, p50:42.6, p97:44.8},
  {m:6, p3:41.0, p50:43.3, p97:45.6}, {m:9, p3:42.6, p50:45.0, p97:47.4},
  {m:12, p3:43.5, p50:46.1, p97:48.6}, {m:15, p3:44.2, p50:46.9, p97:49.4},
  {m:18, p3:44.8, p50:47.5, p97:50.1}, {m:21, p3:45.2, p50:48.0, p97:50.7},
  {m:24, p3:45.6, p50:48.3, p97:51.1}
];
const WHO_HEADCIRC_GIRLS = [
  {m:0, p3:31.5, p50:33.9, p97:36.2}, {m:1, p3:34.2, p50:36.5, p97:38.9},
  {m:2, p3:35.8, p50:38.3, p97:40.7}, {m:3, p3:37.1, p50:39.5, p97:42.0},
  {m:4, p3:38.1, p50:40.6, p97:43.1}, {m:5, p3:38.9, p50:41.5, p97:44.0},
  {m:6, p3:39.6, p50:42.2, p97:44.8}, {m:9, p3:41.1, p50:43.8, p97:46.4},
  {m:12, p3:42.2, p50:45.0, p97:47.6}, {m:15, p3:43.0, p50:45.8, p97:48.5},
  {m:18, p3:43.6, p50:46.5, p97:49.2}, {m:21, p3:44.1, p50:47.0, p97:49.8},
  {m:24, p3:44.5, p50:47.5, p97:50.2}
];

function ageInMonths(birthDateStr, dateStr){
  const [by,bm,bd] = birthDateStr.split('-').map(Number);
  const [dy,dm,dd] = dateStr.split('-').map(Number);
  const birth = new Date(by, bm-1, bd);
  const date = new Date(dy, dm-1, dd);
  return Math.max(0, (date - birth) / 86400000 / 30.4375);
}

function interpolateWHO(table, ageMonths){
  if(ageMonths <= table[0].m) return table[0];
  const last = table[table.length-1];
  if(ageMonths >= last.m) return last;
  for(let i=0; i<table.length-1; i++){
    const a = table[i], b = table[i+1];
    if(ageMonths >= a.m && ageMonths <= b.m){
      const f = (ageMonths - a.m) / (b.m - a.m);
      return {
        p3: a.p3 + (b.p3 - a.p3) * f,
        p50: a.p50 + (b.p50 - a.p50) * f,
        p97: a.p97 + (b.p97 - a.p97) * f
      };
    }
  }
  return last;
}

// Estimation approximative du percentile à partir des 3 repères P3/P50/P97
// (interpolation linéaire en 2 segments) — indicatif uniquement.
function estimatePercentile(table, ageMonths, value){
  const ref = interpolateWHO(table, ageMonths);
  if(value <= ref.p3) return 3;
  if(value >= ref.p97) return 97;
  if(value <= ref.p50){
    const span = (ref.p50 - ref.p3) || 1;
    return Math.round(3 + (value - ref.p3) / span * (50 - 3));
  }
  const span = (ref.p97 - ref.p50) || 1;
  return Math.round(50 + (value - ref.p50) / span * (97 - 50));
}

function renderSimpleLineChart(container, points, opts){
  if(!points.length){
    container.innerHTML = `<div class="chart-empty">Pas encore de mesure enregistrée.</div>`;
    return;
  }

  const hasWHO = opts.whoTable && profileData && profileData.birthDate;

  if(!hasWHO){
    const n = points.length;
    const leftPad = 34, rightPad = 20, topPad = 24, bottomPad = 28, chartH = 120;
    const minSpacing = 56;
    const minSvgW = Math.max(260, leftPad + rightPad + (n - 1) * minSpacing);
    // Étire l'espacement sur un conteneur plus large que ce minimum (desktop) —
    // cf. renderDayChartSVG pour le même principe.
    const svgW = Math.max(minSvgW, container.clientWidth || minSvgW);
    const spacing = n > 1 ? (svgW - leftPad - rightPad) / (n - 1) : 0;
    const svgH = topPad + chartH + bottomPad;

    const values = points.map(p => p.value);
    const minV = Math.min(...values);
    const maxV = Math.max(...values);
    const range = (maxV - minV) || 1;
    const padV = range * 0.2 || 1;
    const scaleMin = Math.max(0, minV - padV);
    const scaleMax = maxV + padV;

    const xFor = i => n > 1 ? leftPad + i * spacing : svgW / 2;
    const yFor = v => topPad + chartH - ((v - scaleMin) / (scaleMax - scaleMin)) * chartH;

    const gridLines = [0, 0.5, 1].map(f => {
      const val = scaleMin + (scaleMax - scaleMin) * f;
      const y = yFor(val);
      return `<line x1="${leftPad}" y1="${y}" x2="${svgW - rightPad}" y2="${y}" stroke="var(--line)" stroke-width="1" stroke-dasharray="3,4"/><text x="2" y="${y + 3.5}" font-size="9" fill="var(--ink-faint)" font-family="Sora">${val.toFixed(opts.decimals || 0)}</text>`;
    }).join('');

    const pathD = 'M ' + points.map((p,i) => `${xFor(i)},${yFor(p.value)}`).join(' L ');
    const areaD = n > 1 ? `${pathD} L ${xFor(n-1)},${topPad+chartH} L ${xFor(0)},${topPad+chartH} Z` : '';
    const dots = points.map((p,i) => `<circle cx="${xFor(i)}" cy="${yFor(p.value)}" r="3.5" fill="var(--milk)"/>`).join('');
    const labels = points.map((p,i) => `<text x="${xFor(i)}" y="${topPad + chartH + 20}" font-size="9" fill="var(--ink-faint)" font-family="Sora" text-anchor="middle">${p.label}</text>`).join('');
    const last = points[n-1];
    const lastLabel = `<text x="${xFor(n-1)}" y="${yFor(last.value) - 10}" font-size="10.5" font-weight="600" fill="var(--milk)" font-family="Sora" text-anchor="middle">${last.value}${opts.suffix || ''}</text>`;

    container.innerHTML = `
      <svg width="${svgW}" height="${svgH}" viewBox="0 0 ${svgW} ${svgH}">
        ${gridLines}
        ${areaD ? `<path d="${areaD}" fill="var(--milk-dim)" opacity="0.6"/>` : ''}
        <path class="chart-line-path" d="${pathD}" fill="none" stroke="var(--milk)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
        ${dots}
        ${lastLabel}
        ${labels}
      </svg>
      ${opts.whoTable ? `<div class="who-hint">Renseigne la date de naissance dans Enfant(s) pour comparer aux repères OMS.</div>` : ''}
    `;

    requestAnimationFrame(() => { container.scrollLeft = container.scrollWidth; });
    return;
  }

  const birthDate = profileData.birthDate;
  const pointsWithAge = points.map(p => ({ ...p, ageM: ageInMonths(birthDate, p.date) }));
  const todayAgeM = ageInMonths(birthDate, todayKey(new Date()));
  const maxAgeMonths = Math.max(...pointsWithAge.map(p => p.ageM), todayAgeM, 1);
  const domainMax = maxAgeMonths * 1.12;

  const leftPad = 34, rightPad = 20, topPad = 22, bottomPad = 28, chartH = 150;
  const minPlotW = Math.max(260, domainMax * 42);
  // Étire le tracé sur un conteneur plus large que ce minimum (desktop) — cf.
  // renderDayChartSVG pour le même principe.
  const plotW = Math.max(minPlotW, (container.clientWidth || (leftPad + rightPad + minPlotW)) - leftPad - rightPad);
  const svgW = leftPad + rightPad + plotW;
  const svgH = topPad + chartH + bottomPad;

  const sampleAges = [];
  for(let a = 0; a < domainMax; a += 0.5) sampleAges.push(a);
  sampleAges.push(domainMax);
  const whoSamples = sampleAges.map(a => interpolateWHO(opts.whoTable, a));

  const allVals = [
    ...pointsWithAge.map(p => p.value),
    ...whoSamples.map(s => s.p3),
    ...whoSamples.map(s => s.p97)
  ];
  const minV = Math.min(...allVals);
  const maxV = Math.max(...allVals);
  const range = (maxV - minV) || 1;
  const padV = range * 0.08;
  const scaleMin = Math.max(0, minV - padV);
  const scaleMax = maxV + padV;

  const xFor = ageM => leftPad + (ageM / domainMax) * plotW;
  const yFor = v => topPad + chartH - ((v - scaleMin) / (scaleMax - scaleMin)) * chartH;

  const gridLines = [0, 0.5, 1].map(f => {
    const val = scaleMin + (scaleMax - scaleMin) * f;
    const y = yFor(val);
    return `<line x1="${leftPad}" y1="${y}" x2="${svgW - rightPad}" y2="${y}" stroke="var(--line)" stroke-width="1" stroke-dasharray="3,4"/><text x="2" y="${y + 3.5}" font-size="9" fill="var(--ink-faint)" font-family="Sora">${val.toFixed(opts.decimals || 0)}</text>`;
  }).join('');

  const p3Path = sampleAges.map((a,i) => `${i===0?'M':'L'} ${xFor(a)},${yFor(whoSamples[i].p3)}`).join(' ');
  const p97PathRev = [...sampleAges].map((a,i) => i).reverse().map(idx => `L ${xFor(sampleAges[idx])},${yFor(whoSamples[idx].p97)}`).join(' ');
  const bandPath = `${p3Path} ${p97PathRev} Z`;
  const p50Path = sampleAges.map((a,i) => `${i===0?'M':'L'} ${xFor(a)},${yFor(whoSamples[i].p50)}`).join(' ');

  const tickCount = Math.min(8, Math.max(2, Math.ceil(domainMax) + 1));
  const tickStep = domainMax / (tickCount - 1);
  let xLabels = '';
  for(let i = 0; i < tickCount; i++){
    const a = i * tickStep;
    xLabels += `<text x="${xFor(a)}" y="${topPad + chartH + 20}" font-size="9" fill="var(--ink-faint)" font-family="Sora" text-anchor="middle">${Math.round(a)}m</text>`;
  }

  const pathD = 'M ' + pointsWithAge.map(p => `${xFor(p.ageM)},${yFor(p.value)}`).join(' L ');
  const dots = pointsWithAge.map(p => `<circle cx="${xFor(p.ageM)}" cy="${yFor(p.value)}" r="3.5" fill="var(--milk)"/>`).join('');
  const last = pointsWithAge[pointsWithAge.length - 1];
  const lastLabel = `<text x="${xFor(last.ageM)}" y="${yFor(last.value) - 10}" font-size="10.5" font-weight="600" fill="var(--milk)" font-family="Sora" text-anchor="middle">${last.value}${opts.suffix || ''}</text>`;

  container.innerHTML = `
    <svg width="${svgW}" height="${svgH}" viewBox="0 0 ${svgW} ${svgH}">
      ${gridLines}
      <path d="${bandPath}" fill="var(--who-band)" opacity="0.45"/>
      <path d="${p50Path}" fill="none" stroke="var(--ink-faint)" stroke-width="1.3" stroke-dasharray="4,3"/>
      <path class="chart-line-path" d="${pathD}" fill="none" stroke="var(--milk)" stroke-width="2.3" stroke-linejoin="round" stroke-linecap="round"/>
      ${dots}
      ${lastLabel}
      ${xLabels}
    </svg>
    <div class="who-legend">
      <span><span class="who-dot who-dot-band"></span>Zone OMS (P3–P97)</span>
      <span><span class="who-dot who-dot-median"></span>Médiane</span>
    </div>
  `;

  requestAnimationFrame(() => { container.scrollLeft = container.scrollWidth; });
}

function avgRatePerDay(points, unit){
  if(points.length < 2) return '';
  const first = points[0], last = points[points.length - 1];
  const days = (new Date(last.date) - new Date(first.date)) / 86400000;
  if(days <= 0) return '';
  const rate = (last.value - first.value) / days;
  if(unit === 'g'){
    const gPerDay = Math.round(rate * 1000);
    const sign = gPerDay > 0 ? '+' : '';
    return `${sign}${gPerDay} g/j en moyenne`;
  }
  const cmPerDay = Math.round(rate * 10) / 10;
  const sign = cmPerDay > 0 ? '+' : '';
  return `${sign}${cmPerDay.toFixed(1).replace('.', ',')} cm/j en moyenne`;
}

function renderGrowthCharts(){
  const sorted = [...growthEntries].sort((a,b) => a.date.localeCompare(b.date));
  const weightPoints = sorted.filter(g => g.weight != null).map(g => ({ date: g.date, label: formatShortDateNoYear(g.date), value: g.weight }));
  const heightPoints = sorted.filter(g => g.height != null).map(g => ({ date: g.date, label: formatShortDateNoYear(g.date), value: g.height }));
  const headCircPoints = sorted.filter(g => g.headCirc != null).map(g => ({ date: g.date, label: formatShortDateNoYear(g.date), value: g.headCirc }));
  const isGirl = profileData && profileData.gender === 'F';
  const weightTable = isGirl ? WHO_WEIGHT_GIRLS : WHO_WEIGHT_BOYS;
  const heightTable = isGirl ? WHO_HEIGHT_GIRLS : WHO_HEIGHT_BOYS;
  const headCircTable = isGirl ? WHO_HEADCIRC_GIRLS : WHO_HEADCIRC_BOYS;
  renderSimpleLineChart($('weight-chart-scroll'), weightPoints, { suffix: ' kg', decimals: 2, whoTable: weightTable });
  renderSimpleLineChart($('height-chart-scroll'), heightPoints, { suffix: ' cm', decimals: 0, whoTable: heightTable });
  renderSimpleLineChart($('headcirc-chart-scroll'), headCircPoints, { suffix: ' cm', decimals: 1, whoTable: headCircTable });

  const weightAvg = avgRatePerDay(weightPoints, 'g');
  const heightAvg = avgRatePerDay(heightPoints, 'cm');
  const headCircAvg = avgRatePerDay(headCircPoints, 'cm');

  let weightPercentileTxt = '', heightPercentileTxt = '', headCircPercentileTxt = '';
  if(profileData && profileData.birthDate){
    if(weightPoints.length){
      const last = weightPoints[weightPoints.length - 1];
      const ageM = ageInMonths(profileData.birthDate, last.date);
      weightPercentileTxt = ' · ~' + estimatePercentile(weightTable, ageM, last.value) + 'e percentile';
    }
    if(heightPoints.length){
      const last = heightPoints[heightPoints.length - 1];
      const ageM = ageInMonths(profileData.birthDate, last.date);
      heightPercentileTxt = ' · ~' + estimatePercentile(heightTable, ageM, last.value) + 'e percentile';
    }
    if(headCircPoints.length){
      const last = headCircPoints[headCircPoints.length - 1];
      const ageM = ageInMonths(profileData.birthDate, last.date);
      headCircPercentileTxt = ' · ~' + estimatePercentile(headCircTable, ageM, last.value) + 'e percentile';
    }
  }

  $('weight-chart-label').textContent = 'Courbe de poids' + (weightAvg ? ' · ' + weightAvg : '') + weightPercentileTxt;
  $('height-chart-label').textContent = 'Courbe de taille' + (heightAvg ? ' · ' + heightAvg : '') + heightPercentileTxt;
  $('headcirc-chart-label').textContent = 'Courbe du périmètre crânien' + (headCircAvg ? ' · ' + headCircAvg : '') + headCircPercentileTxt;
}

function exportDataJSON(){
  // format/version : permet à la restauration de vérifier qu'un fichier est
  // bien une sauvegarde Suivi Aylan avant d'écraser quoi que ce soit.
  // vaccines/milestones ajoutés : la sauvegarde ne couvrait auparavant que
  // biberons/couches/croissance, une omission qui aurait rendu une
  // restauration incomplète sans qu'on s'en rende compte avant d'en avoir besoin.
  const payload = {
    format: 'suivi-aylan-backup',
    version: 1,
    exportedAt: new Date().toISOString(),
    childName: getChildFirstName() || DEFAULT_SITE_NAME,
    profile: profileData || null,
    entries: entries,
    growth: growthEntries,
    vaccines: vaccinesList,
    milestones: milestonesList,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const dateStr = todayKey(new Date());
  const a = document.createElement('a');
  a.href = url;
  a.download = `aylan-sauvegarde-${dateStr}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  showToast('Export téléchargé');
}

let pediatricPeriodDays = 14;

function formatDateRangeLabel(startKey, endKey){
  return `${formatShortDate(startKey)} au ${formatShortDate(endKey)}`;
}

function exportPDF(){
  const name = getChildFirstName() || DEFAULT_SITE_NAME;
  const age = profileData && profileData.birthDate ? computeAge(profileData.birthDate) : '—';
  const birth = profileData && profileData.birthDate ? formatShortDate(profileData.birthDate) : '—';

  const sortedGrowth = [...growthEntries].sort((a,b) => b.date.localeCompare(a.date));
  const growthRows = sortedGrowth.slice(0, 8).map(g => `
    <tr>
      <td>${formatShortDate(g.date)}</td>
      <td>${g.weight != null ? g.weight + ' kg' : '—'}</td>
      <td>${g.height != null ? g.height + ' cm' : '—'}</td>
      <td>${g.headCirc != null ? g.headCirc + ' cm' : '—'}</td>
    </tr>`).join('');

  const today = new Date();
  const days = [];
  for(let i = pediatricPeriodDays - 1; i >= 0; i--){
    days.push(todayKey(addDays(today, -i)));
  }
  const startKey = days[0];
  const endKey = days[days.length - 1];

  const dayRows = days.map(dayKey => {
    const dayEntries = entries.filter(e => e.dayKey === dayKey);
    const bottles = dayEntries.filter(e => e.type === 'biberon');
    const totalMl = bottles.reduce((s,e) => s + (e.ml||0), 0);
    const bottleDiapers = bottles.filter(e => isDiaperChange(e.diaper)).length;
    const standaloneDiapers = dayEntries.filter(e => e.type === 'diaper').length;
    const diaperCount = bottleDiapers + standaloneDiapers;
    const vomitCount = dayEntries.filter(e => e.type === 'vomit').length;
    return `
      <tr>
        <td>${formatShortDate(dayKey)}</td>
        <td>${bottles.length}</td>
        <td>${totalMl} ml</td>
        <td>${diaperCount}</td>
        <td>${vomitCount || '—'}</td>
      </tr>`;
  }).join('');

  const periodBottles = entries.filter(e => e.type === 'biberon' && days.includes(e.dayKey));
  const periodTotalMl = periodBottles.reduce((s,e) => s + (e.ml||0), 0);
  const daysWithBottles = new Set(periodBottles.map(e => e.dayKey)).size;
  const avgMlPerDay = daysWithBottles ? Math.round(periodTotalMl / daysWithBottles) : 0;
  const avgFeedsPerDay = daysWithBottles ? Math.round((periodBottles.length / daysWithBottles) * 10) / 10 : 0;

  $('print-summary').innerHTML = `
    <h1>${escapeHtml(name)}</h1>
    <p>Né(e) le ${birth} · Âge actuel : ${age}</p>
    <h2>Résumé du ${formatDateRangeLabel(startKey, endKey)} (${pediatricPeriodDays} jours)</h2>
    <p>Moyenne : ${avgMlPerDay} ml/jour · ${avgFeedsPerDay} biberon(s)/jour</p>
    <table>
      <thead><tr><th>Date</th><th>Biberons</th><th>Total ml</th><th>Couches</th><th>Vomiss.</th></tr></thead>
      <tbody>${dayRows}</tbody>
    </table>
    <h2>Mesures de croissance récentes</h2>
    <table>
      <thead><tr><th>Date</th><th>Poids</th><th>Taille</th><th>PC</th></tr></thead>
      <tbody>${growthRows || '<tr><td colspan="4">Aucune mesure enregistrée</td></tr>'}</tbody>
    </table>
    <p class="print-footer">Document généré le ${formatShortDate(todayKey(new Date()))} depuis le carnet de suivi.</p>
  `;

  window.print();
}

let authMode = 'login';

function toggleAuthMode(){
  authMode = authMode === 'login' ? 'signup' : 'login';
  $('auth-mode-label').textContent = authMode === 'login' ? 'Connexion' : 'Créer un compte';
  $('login-btn').textContent = authMode === 'login' ? 'Se connecter' : 'Créer le compte';
  $('login-password-confirm-wrap').classList.toggle('hidden', authMode === 'login');
  $('auth-toggle-link').textContent = authMode === 'login' ? "Pas encore de compte ? Créer un compte" : "Déjà un compte ? Se connecter";
  $('login-error').textContent = '';
}

function authErrorMessage(e){
  if(e.code === 'auth/email-already-in-use') return 'Cet email est déjà utilisé.';
  if(e.code === 'auth/invalid-email') return 'Email invalide.';
  if(e.code === 'auth/weak-password') return 'Le mot de passe doit faire au moins 6 caractères.';
  if(e.code === 'auth/wrong-password' || e.code === 'auth/user-not-found' || e.code === 'auth/invalid-credential') return 'Email ou mot de passe incorrect.';
  return "Une erreur s'est produite.";
}

async function doAuthSubmit(){
  const email = $('login-email').value.trim();
  const password = $('login-password').value;
  const btn = $('login-btn');
  const errEl = $('login-error');
  errEl.textContent = '';

  if(!email || !password){
    errEl.textContent = 'Merci de remplir les champs requis.';
    return;
  }
  if(authMode === 'signup'){
    const confirm = $('login-password-confirm').value;
    if(password.length < 6){
      errEl.textContent = 'Le mot de passe doit faire au moins 6 caractères.';
      return;
    }
    if(password !== confirm){
      errEl.textContent = 'Les mots de passe ne correspondent pas.';
      return;
    }
  }

  btn.disabled = true;
  btn.textContent = authMode === 'login' ? 'Connexion...' : 'Création...';
  try{
    if(authMode === 'login'){
      await auth.signInWithEmailAndPassword(email, password);
    }else{
      await auth.createUserWithEmailAndPassword(email, password);
    }
  }catch(e){
    errEl.textContent = authErrorMessage(e);
  }
  btn.disabled = false;
  btn.textContent = authMode === 'login' ? 'Se connecter' : 'Créer le compte';
}

function doLogout(){
  currentFamilyId = null;
  auth.signOut();
}

function showScreen(id){
  ['login-screen', 'family-setup-screen', 'app-wrap'].forEach(s => {
    $(s).classList.toggle('hidden', s !== id);
  });
}

async function resolveFamily(uid){
  // Pendant cet appel, l'écran encore visible est celui affiché avant que
  // l'auth ne se résolve (login-screen le plus souvent) — on y montre l'état
  // de chargement/erreur plutôt que de laisser l'utilisateur face à un écran
  // figé sans aucun indice de ce qui se passe.
  const errEl = $('login-error');
  if(errEl) errEl.textContent = 'Chargement de ton espace famille…';

  let userFamilySnap;
  try{
    userFamilySnap = await db.ref('userFamilies/' + uid).once('value');
  }catch(e){
    if(errEl){
      errEl.textContent = '';
      const msg = document.createElement('span');
      msg.textContent = 'Impossible de charger ton espace famille (connexion instable). ';
      const retryBtn = document.createElement('button');
      retryBtn.type = 'button';
      retryBtn.className = 'auth-toggle-link';
      retryBtn.style.display = 'inline';
      retryBtn.style.padding = '0';
      retryBtn.textContent = 'Réessayer';
      retryBtn.addEventListener('click', () => resolveFamily(uid));
      errEl.appendChild(msg);
      errEl.appendChild(retryBtn);
    }
    return;
  }
  if(errEl) errEl.textContent = '';

  const familyId = userFamilySnap.val();

  if(familyId){
    currentFamilyId = familyId;
    showScreen('app-wrap');
    startSync();
    return;
  }

  renderFamilySetup('choice');
  showScreen('family-setup-screen');
}

function renderFamilySetup(mode, data){
  const hero = $('family-setup-hero');
  const sheet = $('family-setup-sheet');
  const childName = getChildFirstName() || DEFAULT_SITE_NAME;

  const arrowIc = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 6 15 12 9 18"/></svg>';
  const familyIc = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="8.5" cy="7" r="3"/><path d="M3 20c0-3 2.5-5 5.5-5s5.5 2 5.5 5"/><circle cx="17.5" cy="8.5" r="2.3"/><path d="M14.8 20c.3-2.2 1.6-3.8 3.6-3.8"/></svg>';
  const plusIc = '<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="5"/><line x1="12" y1="8.5" x2="12" y2="15.5"/><line x1="8.5" y1="12" x2="15.5" y2="12"/></svg>';
  const keyIc = '<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="15" r="4.2"/><path d="M11 12 19.5 3.5"/><path d="M16.5 6.5 19 9"/><path d="M14 9 16.2 11.2"/></svg>';
  const checkIc = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="m8 12.5 2.5 2.5 5-5"/></svg>';

  const heroHtml = (icon, sub) => `
    <div class="auth-hero-badge">${icon}</div>
    <h1 class="auth-hero-title">${childName}</h1>
    <div class="auth-hero-sub">${sub}</div>
    <svg class="auth-hero-wave" viewBox="0 0 390 46" preserveAspectRatio="none"><path d="M0,0 C85,46 140,0 195,18 C250,36 305,4 390,20 L390,46 L0,46 Z"/></svg>
  `;

  if(mode === 'choice'){
    hero.innerHTML = heroHtml(familyIc, 'Espace famille');
    sheet.innerHTML = `
      <button class="family-choice-btn" id="fs-create-btn" type="button">
        <span class="fc-ic">${plusIc}</span>
        <span class="fc-text">Créer une nouvelle famille<span class="sub">Pour commencer le suivi d'un enfant</span></span>
        <span class="fc-arrow">${arrowIc}</span>
      </button>
      <button class="family-choice-btn" id="fs-join-btn" type="button">
        <span class="fc-ic">${keyIc}</span>
        <span class="fc-text">Rejoindre une famille existante<span class="sub">Avec un code d'invitation reçu</span></span>
        <span class="fc-arrow">${arrowIc}</span>
      </button>
      <div class="login-error" id="fs-error"></div>
    `;
    $('fs-create-btn').addEventListener('click', () => renderFamilySetup('create'));
    $('fs-join-btn').addEventListener('click', () => renderFamilySetup('join'));
    return;
  }

  if(mode === 'create'){
    hero.innerHTML = heroHtml(plusIc, 'Créer une famille');
    sheet.innerHTML = `
      <div class="auth-field-wrap">
        <span class="auth-field-ic">${familyIc}</span>
        <input class="auth-field" type="text" id="fs-family-name" placeholder="ex : Famille Dupont">
      </div>
      <button class="login-btn" id="fs-create-submit">Créer</button>
      <button class="family-back-link" id="fs-back">← Retour</button>
      <div class="login-error" id="fs-error"></div>
    `;
    $('fs-create-submit').addEventListener('click', () => submitCreateFamily());
    $('fs-back').addEventListener('click', () => renderFamilySetup('choice'));
    return;
  }

  if(mode === 'join'){
    hero.innerHTML = heroHtml(keyIc, 'Rejoindre une famille');
    sheet.innerHTML = `
      <div class="auth-field-wrap">
        <span class="auth-field-ic">${keyIc}</span>
        <input class="auth-field" type="text" id="fs-join-code" placeholder="Code d'invitation" style="text-transform:uppercase;">
      </div>
      <button class="login-btn" id="fs-join-submit">Rejoindre</button>
      <button class="family-back-link" id="fs-back">← Retour</button>
      <div class="login-error" id="fs-error"></div>
    `;
    $('fs-join-submit').addEventListener('click', () => submitJoinFamily());
    $('fs-back').addEventListener('click', () => renderFamilySetup('choice'));
    return;
  }

  if(mode === 'created'){
    hero.innerHTML = heroHtml(checkIc, 'Famille créée 🎉');
    sheet.innerHTML = `
      <p class="backup-hint">Partage ce code avec l'autre parent (ou toute autre personne) pour qu'il/elle rejoigne votre espace.</p>
      <div class="invite-code-display">
        <div class="label">Code d'invitation</div>
        <div class="invite-code-row">
          <div class="code">${data.inviteCode}</div>
          <button type="button" class="invite-code-btn" id="fs-invite-copy-btn" aria-label="Copier le code">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>
          </button>
        </div>
      </div>
      <button class="login-btn" id="fs-continue">Continuer</button>
    `;
    $('fs-invite-copy-btn').addEventListener('click', () => copyInviteCode(data.inviteCode));
    $('fs-continue').addEventListener('click', () => {
      currentFamilyId = data.familyId;
      showScreen('app-wrap');
      startSync();
    });
    return;
  }
}

async function submitCreateFamily(){
  const name = $('fs-family-name').value.trim() || 'Ma famille';
  const errEl = $('fs-error');
  const btn = $('fs-create-submit');
  const uid = auth.currentUser.uid;

  const familyId = generateId('family');
  const inviteCode = generateInviteCode();

  btn.disabled = true;
  btn.textContent = 'Création...';
  try{
    await db.ref('families/' + familyId + '/meta').set({ name, inviteCode, createdBy: uid, createdAt: Date.now(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone });
    await db.ref('families/' + familyId + '/members/' + uid).set(true);
    await db.ref('userFamilies/' + uid).set(familyId);
    await db.ref('inviteCodes/' + inviteCode).set(familyId);
    renderFamilySetup('created', { familyId, inviteCode });
  }catch(e){
    errEl.textContent = "Erreur : " + (e.message || e.code || e);
    btn.disabled = false;
    btn.textContent = 'Créer';
  }
}

async function submitJoinFamily(){
  const code = $('fs-join-code').value.trim().toUpperCase();
  const errEl = $('fs-error');
  const btn = $('fs-join-submit');
  const uid = auth.currentUser.uid;

  if(!code){
    errEl.textContent = 'Merci de saisir un code.';
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Vérification...';
  try{
    const codeSnap = await db.ref('inviteCodes/' + code).once('value');
    const familyId = codeSnap.val();
    if(!familyId){
      errEl.textContent = "Ce code n'est pas valide.";
      btn.disabled = false;
      btn.textContent = 'Rejoindre';
      return;
    }
    await db.ref('families/' + familyId + '/joinRequests/' + uid).set(code);
    await db.ref('families/' + familyId + '/members/' + uid).set(true);
    await db.ref('userFamilies/' + uid).set(familyId);
    currentFamilyId = familyId;
    showScreen('app-wrap');
    startSync();
  }catch(e){
    errEl.textContent = "Erreur : " + (e.message || e.code || e);
    btn.disabled = false;
    btn.textContent = 'Rejoindre';
  }
}

auth.onAuthStateChanged((user) => {
  if(user){
    resolveFamily(user.uid);
  }else{
    currentFamilyId = null;
    showScreen('login-screen');
    stopSync();
  }
});

function diaperLabel(val){
  return { none:'Couche sèche', pipi:'Pipi', caca:'Caca', both:'Pipi + caca', skip:'Pas de couche' }[val] || '';
}
function diaperIcon(val){
  const droplet = '<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M12 3c-3 4-6 8-6 11.5A6 6 0 0 0 12 21a6 6 0 0 0 6-6.5C18 11 15 7 12 3z"/></svg>';
  const both = '<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M8.5 4c-1.8 2.2-3.5 4.6-3.5 6.8A3.5 3.5 0 0 0 8.5 14a3.5 3.5 0 0 0 3.5-3.2C12 8.6 10.3 6.2 8.5 4z"/><path d="M15.5 9c-1.5 1.9-3 3.9-3 5.8a3 3 0 0 0 3 3 3 3 0 0 0 3-3c0-1.9-1.5-3.9-3-5.8z" opacity=".55"/></svg>';
  return { none:'·', pipi:droplet, caca:'●', both, skip:'–' }[val] || '·';
}
// "none" (couche sèche) et "skip" (couche pas changée) décrivent deux
// situations différentes mais aucune des deux n'est un changement de couche
// à proprement parler — regroupées ici pour que les compteurs/statistiques
// de couches n'aient qu'un seul endroit à tenir à jour si un 3e cas apparaît.
function isDiaperChange(val){
  return !!val && val !== 'none' && val !== 'skip';
}

// Un objet Date représente un instant précis (son epoch interne) — ses
// méthodes getFullYear()/getMonth()/getDate() le lisent par défaut dans le
// fuseau LOCAL de l'appareil qui exécute ce code. Pour qu'une famille voie
// systématiquement la même date de calendrier pour un même instant, quel que
// soit l'appareil (ex. un parent en déplacement dans un autre fuseau), on
// formate plutôt dans le fuseau de référence choisi pour la famille — avec
// repli sur le fuseau local si la famille n'en a pas encore choisi un
// (familles créées avant l'introduction de ce réglage).
function todayKey(dateObj){
  const tz = familyTimezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(dateObj);
  const y = parts.find(p => p.type === 'year').value;
  const m = parts.find(p => p.type === 'month').value;
  const d = parts.find(p => p.type === 'day').value;
  return `${y}-${m}-${d}`;
}

function formatDayLabel(key){
  const [y,m,d] = key.split('-').map(Number);
  const date = new Date(y, m-1, d);
  const today = new Date();
  const yest = new Date(); yest.setDate(today.getDate()-1);
  if(todayKey(date) === todayKey(today)) return "Aujourd'hui";
  if(todayKey(date) === todayKey(yest)) return "Hier";
  return date.toLocaleDateString('fr-FR', { weekday:'long', day:'numeric', month:'long' });
}

let tabAnimating = false;
const TAB_ORDER = ['today', 'calendar', 'chart', 'profile', 'settings'];
const VIEW_LABELS = { today: "Aujourd'hui", calendar: 'Calendrier', chart: 'Infos', profile: 'Enfant(s)', settings: 'Paramètres' };
const SUBPAGES = ['settings'];

function switchView(view){
  if(view === currentView || tabAnimating) return;
  tabAnimating = true;

  const oldView = currentView;
  if(SUBPAGES.includes(view) && !SUBPAGES.includes(oldView)) viewBeforeSettings = oldView;
  const oldIndex = TAB_ORDER.indexOf(oldView);
  const newIndex = TAB_ORDER.indexOf(view);
  const direction = newIndex > oldIndex ? 1 : -1;

  document.querySelectorAll('.bottom-nav-btn[data-view]').forEach(b => {
    b.classList.toggle('active', b.getAttribute('data-view') === view);
  });
  const viewLabelEl = $('current-view-label');
  if(viewLabelEl) viewLabelEl.textContent = VIEW_LABELS[view] || '';

  const oldEl = $('view-' + oldView);
  const newEl = $('view-' + view);
  const outClass = direction === 1 ? 'tab-slide-out-l' : 'tab-slide-out-r';
  const inPrepClass = direction === 1 ? 'tab-slide-in-prep-l' : 'tab-slide-in-prep-r';

  oldEl.classList.add(outClass);

  setTimeout(() => {
    try{
      oldEl.classList.remove('active', outClass);
      currentView = view;

      newEl.classList.add(inPrepClass);
      newEl.classList.add('active');
      void newEl.offsetWidth;
      newEl.classList.remove(inPrepClass);

      if(view === 'calendar') renderCalendar();
      if(view === 'chart'){ renderChart(); renderMilkInsight(); renderVomitChart(); renderGrowthCharts(); }
      if(view === 'settings'){
        const email = auth.currentUser ? auth.currentUser.email : '—';
        $('settings-account').textContent = email;
        $('settings-summary-email').textContent = email;
      }
      $('fab-btn').classList.toggle('hidden', view === 'profile' || view === 'settings');
      $('app-wrap').classList.toggle('wide-view', view === 'today' || view === 'calendar');
      // L'écran "Aujourd'hui" a son propre en-tête chaleureux (prénom + avatar,
      // voir renderTodayHeader) ; le générique .app-header ne sert que sur les
      // autres écrans, d'où le hidden statique dans index.html + ce toggle ici.
      const appHeaderEl = $('app-header');
      if(appHeaderEl) appHeaderEl.classList.toggle('hidden', view === 'today');
    }finally{
      setTimeout(() => { tabAnimating = false; }, 210);
    }
  }, 200);
}

function render(){
  renderTodayHeader();
  renderStats();
  renderTodayTimeline();
  updateSleepButton();
  maybeShowDailySummary();
  renderTodaySidebar();
  if(currentView === 'calendar') renderCalendar();
  if(currentView === 'chart'){ renderChart(); renderMilkInsight(); renderVomitChart(); }
}

// Colonne latérale "Aujourd'hui" (desktop ≥900px, cf. media query CSS) : aperçu
// du mois en cours et dernière mesure de croissance, pour éviter d'avoir à
// changer d'écran pour vérifier une info déjà disponible ailleurs dans l'app.
// Toujours calculé (coût négligeable, mêmes tableaux déjà en mémoire) — le CSS
// masque juste la colonne sur mobile, donc le contenu est prêt si la fenêtre
// est redimensionnée au-delà du seuil desktop sans recharger la page.
function renderTodaySidebar(){
  const calEl = $('today-mini-cal');
  if(calEl){
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth();
    const monthLabel = now.toLocaleDateString('fr-FR', { month:'long', year:'numeric' });
    const entriesByDay = {};
    entries.forEach(e => { (entriesByDay[e.dayKey] || (entriesByDay[e.dayKey] = [])).push(e); });
    const firstOfMonth = new Date(year, month, 1);
    let startOffset = firstOfMonth.getDay() - 1; // lundi = 0
    if(startOffset < 0) startOffset = 6;
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const todayStr = todayKey(now);
    const dowLabels = ['L','M','M','J','V','S','D'];

    let html = `<div class="mini-cal-head"><span class="m">${monthLabel}</span></div><div class="mini-cal-grid">`;
    html += dowLabels.map(d => `<div class="dow">${d}</div>`).join('');
    for(let i=0; i<startOffset; i++) html += `<div></div>`;
    for(let d=1; d<=daysInMonth; d++){
      const key = todayKey(new Date(year, month, d));
      const has = !!entriesByDay[key];
      const isToday = key === todayStr;
      html += `<button type="button" class="day${has ? ' has' : ''}${isToday ? ' today' : ''}" data-day="${key}">${d}</button>`;
    }
    html += `</div>`;
    calEl.innerHTML = html;
    calEl.querySelectorAll('[data-day]').forEach(btn => {
      btn.addEventListener('click', () => {
        const key = btn.getAttribute('data-day');
        selectedCalDay = key;
        const [y, m] = key.split('-').map(Number);
        calMonthDate = new Date(y, m - 1, 1);
        switchView('calendar');
      });
    });
  }

  const growthEl = $('today-growth-snapshot');
  const growthLbl = $('today-growth-lbl');
  if(growthEl){
    const sorted = [...growthEntries].filter(g => g.weight != null).sort((a, b) => a.date.localeCompare(b.date));
    if(!sorted.length || !profileData || !profileData.birthDate){
      growthEl.innerHTML = '';
      if(growthLbl) growthLbl.style.display = 'none';
      return;
    }
    if(growthLbl) growthLbl.style.display = '';
    const last = sorted[sorted.length - 1];
    const table = (profileData.gender === 'F') ? WHO_WEIGHT_GIRLS : WHO_WEIGHT_BOYS;
    const ageM = ageInMonths(profileData.birthDate, last.date);
    const pct = estimatePercentile(table, ageM, last.weight);
    growthEl.innerHTML = `
      <button type="button" class="today-growth-card" id="today-growth-card-btn">
        <div class="val">${last.weight} kg</div>
        <div class="pct">~${pct}ᵉ percentile OMS</div>
        <div class="date">${formatShortDateNoYear(last.date)}</div>
      </button>
    `;
    $('today-growth-card-btn').addEventListener('click', () => {
      switchView('chart');
      setTimeout(() => {
        const tabBtn = document.querySelector('.tab-btn[data-tab-group="chart"][data-tab="growth"]');
        if(tabBtn) tabBtn.click();
      }, 220);
    });
  }
}

// --- Résumé "Hier" : un rappel bref au premier retour de la journée, pour
// comprendre la journée précédente d'un coup d'œil sans rouvrir la timeline.
// Calculé une seule fois par enfant/jour (localStorage), pas à chaque render().
let dailySummaryChecked = false;
function maybeShowDailySummary(){
  const container = $('daily-summary-container');
  if(!container || dailySummaryChecked || !currentChildId) return;
  dailySummaryChecked = true;

  const todayK = todayKey(new Date());
  const storageKey = 'dailySummarySeen_' + currentChildId + '_' + todayK;
  if(localStorage.getItem(storageKey)) return;

  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const yKey = todayKey(yesterday);
  const yEntries = entries.filter(e => e.dayKey === yKey);
  if(!yEntries.length) return;

  const bottles = yEntries.filter(e => e.type === 'biberon');
  const totalMl = bottles.reduce((s,e) => s + (e.ml || 0), 0);
  const bottleDiaperCount = bottles.filter(e => isDiaperChange(e.diaper)).length;
  const diaperCount = bottleDiaperCount + yEntries.filter(e => e.type === 'diaper').length;
  const vomitCount = yEntries.filter(e => e.type === 'vomit').length;
  const sleepEntries = yEntries.filter(e => e.type === 'sleep' && (e.durationMin != null || e.end != null));
  const sleepMin = sleepEntries.reduce((s,e) => s + (e.durationMin != null ? e.durationMin : (e.end - e.start) / 60000), 0);

  const parts = [];
  if(bottles.length) parts.push(`${bottles.length} biberon${bottles.length > 1 ? 's' : ''} (${totalMl} ml)`);
  if(diaperCount) parts.push(`${diaperCount} couche${diaperCount > 1 ? 's' : ''}`);
  if(sleepMin > 0) parts.push(formatDuration(sleepMin) + ' de sommeil');
  if(vomitCount) parts.push(`${vomitCount} vomissement${vomitCount > 1 ? 's' : ''}`);
  if(!parts.length) return;

  container.innerHTML = `
    <div class="daily-summary-card">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/></svg>
      <div class="daily-summary-text"><b>Hier —</b> ${parts.join(' · ')}</div>
      <button type="button" class="daily-summary-close" aria-label="Fermer">✕</button>
    </div>`;
  container.classList.remove('hidden');
  container.querySelector('.daily-summary-close').addEventListener('click', () => {
    container.classList.add('hidden');
    container.innerHTML = '';
    localStorage.setItem(storageKey, '1');
  });
}

let reminderEnabled = false;
let reminderThresholdMinutes = 210;
let lastNotifiedBottleTimestamp = null;

// Reflète reminderEnabled/reminderThresholdMinutes (synchronisés depuis
// families/{id}/meta/reminder, cf. startSync()) sur les contrôles des
// Paramètres. Ne lit/n'écrit plus jamais localStorage pour ce réglage — une
// seule source de vérité partagée par toute la famille.
function renderReminderPrefsUI(){
  const btn = $('reminder-toggle-btn');
  if(btn) btn.classList.toggle('active', reminderEnabled);
  const hoursInput = $('reminder-hours-input');
  if(hoursInput && document.activeElement !== hoursInput) hoursInput.value = reminderThresholdMinutes / 60;
  if(!reminderEnabled) lastNotifiedBottleTimestamp = null;
  updateNotifPermissionStatus();
}

async function toggleReminderEnabled(){
  if(!currentFamilyId) return;
  const next = !reminderEnabled;
  try{
    await db.ref('families/' + currentFamilyId + '/meta/reminder/enabled').set(next);
  }catch(e){
    showToast("Erreur lors de l'enregistrement du réglage");
  }
}

async function saveReminderHours(){
  const val = parseFloat($('reminder-hours-input').value);
  if(isNaN(val) || val <= 0){
    showToast('Seuil invalide — vérifie la valeur (1 à 8 h)');
    renderReminderPrefsUI(); // remet la dernière valeur connue plutôt que de laisser la saisie invalide affichée
    return;
  }
  if(!currentFamilyId) return;
  try{
    await db.ref('families/' + currentFamilyId + '/meta/reminder/thresholdMinutes').set(val * 60);
  }catch(e){
    showToast("Erreur lors de l'enregistrement du réglage");
  }
}

// true si l'app tourne déjà en PWA installée (pas dans un onglet de
// navigateur classique) — partagé par la détection iOS ci-dessous et par
// la bannière/le réglage d'installation.
function isAppInstalled(){
  return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
}

// true uniquement sur les plateformes qui exigent une PWA installée pour le
// push web (Safari/iOS) — sert juste à afficher le bon message d'aide.
function isIOSStandaloneRequired(){
  const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  return isIOS && !isAppInstalled();
}

// Bannière d'installation PWA proactive — manifest, icônes et raccourcis
// existent déjà (§9/10 de l'audit) mais ne servent à rien tant que l'app
// n'est pas installée ; sur iOS en particulier, le push (§7) ne fonctionne
// QUE si l'app est installée. Capte beforeinstallprompt pour proposer
// l'installation nous-mêmes plutôt que de compter sur l'icône discrète du
// navigateur, que la plupart des gens ne remarquent jamais.
let deferredInstallPrompt = null;

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
  renderInstallUI();
});

window.addEventListener('appinstalled', () => {
  deferredInstallPrompt = null;
  renderInstallUI();
});

function renderInstallUI(){
  renderInstallBanner();
  renderInstallSettingsSection();
}

function renderInstallBanner(){
  const container = $('install-banner-container');
  if(!container) return;

  if(isAppInstalled()){ container.classList.add('hidden'); container.innerHTML = ''; return; }

  let dismissed = false, visitCount = 0;
  try{
    dismissed = localStorage.getItem('aylan-install-dismissed') === '1';
    visitCount = parseInt(localStorage.getItem('aylan-visit-count') || '0', 10);
  }catch(e){}
  if(dismissed) { container.classList.add('hidden'); container.innerHTML = ''; return; }

  const isIOS = isIOSStandaloneRequired();
  // Sur un navigateur qui ne propose pas beforeinstallprompt et n'est pas
  // iOS (ex. Safari desktop), il n'y a rien d'actionnable à proposer —
  // mieux vaut rester silencieux que montrer un bouton qui ne fait rien.
  if(!isIOS && !deferredInstallPrompt){ container.classList.add('hidden'); container.innerHTML = ''; return; }
  // Laisse le temps de découvrir l'app avant de suggérer l'installation —
  // pas dès la toute première visite.
  if(visitCount < 3){ container.classList.add('hidden'); container.innerHTML = ''; return; }

  container.classList.remove('hidden');
  container.innerHTML = `
    <div class="install-banner-card">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="2.5" width="12" height="19" rx="2.5"/><path d="M11 18h2"/><path d="M12 6.5v6"/><path d="M9.5 10 12 12.5 14.5 10"/></svg>
      <div class="install-banner-text">${isIOS
        ? "Installe l'app pour recevoir les rappels même fermée : appuie sur <b>Partager</b> puis <b>Sur l'écran d'accueil</b>."
        : "Installe l'app pour un accès plus rapide, et pour que les rappels fonctionnent même app fermée."}</div>
      ${isIOS ? '' : '<button type="button" class="install-banner-btn" id="install-banner-btn">Installer</button>'}
      <button type="button" class="install-banner-close" aria-label="Fermer">✕</button>
    </div>
  `;
  container.querySelector('.install-banner-close').addEventListener('click', () => {
    container.classList.add('hidden');
    container.innerHTML = '';
    try{ localStorage.setItem('aylan-install-dismissed', '1'); }catch(e){}
  });
  const installBtn = container.querySelector('#install-banner-btn');
  if(installBtn) installBtn.addEventListener('click', triggerInstallPrompt);
}

async function triggerInstallPrompt(){
  if(!deferredInstallPrompt) return;
  deferredInstallPrompt.prompt();
  const choice = await deferredInstallPrompt.userChoice;
  deferredInstallPrompt = null;
  if(choice.outcome === 'accepted') showToast('Installation en cours...');
  renderInstallUI();
}

function renderInstallSettingsSection(){
  const btn = $('install-app-btn');
  const hint = $('install-hint-text');
  if(!btn || !hint) return;

  if(isAppInstalled()){
    hint.textContent = '✓ App déjà installée sur cet appareil.';
    btn.classList.add('hidden');
    return;
  }
  if(isIOSStandaloneRequired()){
    hint.textContent = "Sur iPhone/iPad : appuie sur Partager puis « Sur l'écran d'accueil ».";
    btn.classList.add('hidden'); // pas d'invite programmable sur iOS
    return;
  }
  if(deferredInstallPrompt){
    hint.textContent = "Accès plus rapide, et les rappels fonctionnent même app fermée.";
    btn.classList.remove('hidden');
    return;
  }
  hint.textContent = "Ton navigateur ne propose pas d'installation directe ici — cherche l'icône d'installation dans la barre d'adresse.";
  btn.classList.add('hidden');
}

// true seulement une fois qu'un jeton FCM a réellement été obtenu ET
// enregistré en base sur CET appareil (pas juste la permission navigateur
// accordée — les deux peuvent diverger : getToken()/le Service Worker
// peuvent échouer après coup, en particulier sur Safari/iOS, et la
// permission seule ne garantit pas que le worker a quelqu'un à qui écrire).
let pushTokenConfirmed = false;
let lastPushError = null;

function updateNotifPermissionStatus(){
  const el = $('notif-permission-status');
  if(!el) return;
  if(!('Notification' in window) || !messaging){
    el.textContent = "Les notifications ne sont pas prises en charge sur cet appareil.";
    return;
  }
  if(isIOSStandaloneRequired()){
    el.textContent = "Sur iPhone/iPad : installe d'abord l'app (Partager → Sur l'écran d'accueil) pour pouvoir activer les notifications.";
    return;
  }
  if(Notification.permission === 'denied'){
    el.textContent = 'Notifications bloquées — à réactiver dans les réglages du navigateur.';
    return;
  }
  if(Notification.permission !== 'granted'){
    el.textContent = 'Notifications pas encore activées sur cet appareil.';
    return;
  }
  if(pushTokenConfirmed){
    el.textContent = '✓ Notifications activées sur cet appareil.';
  }else if(lastPushError){
    el.textContent = `Permission accordée mais l'activation a échoué : ${lastPushError}`;
  }else{
    el.textContent = 'Permission accordée — clique à nouveau si besoin pour finaliser.';
  }
}

// Active le push sur CET appareil : permission, Service Worker dédié, jeton
// FCM, puis enregistrement du jeton en base pour que le worker planifié
// puisse l'utiliser. Chaque appareil d'une même famille doit l'activer
// séparément (le jeton est propre au couple navigateur/appareil).
async function enablePushNotifications(){
  if(!messaging){
    updateNotifPermissionStatus();
    return;
  }
  if(isIOSStandaloneRequired()){
    updateNotifPermissionStatus();
    return;
  }
  try{
    const permission = await Notification.requestPermission();
    if(permission !== 'granted'){
      updateNotifPermissionStatus();
      return;
    }

    const registration = await navigator.serviceWorker.register('/firebase-messaging-sw.js');
    const token = await messaging.getToken({ vapidKey: VAPID_KEY, serviceWorkerRegistration: registration });
    if(!token){
      lastPushError = "aucun jeton renvoyé par Firebase (getToken a résolu sans erreur mais sans valeur)";
      updateNotifPermissionStatus();
      showToast("Impossible d'activer les notifications — réessaie");
      return;
    }
    await savePushToken(token);
    pushTokenConfirmed = true;
    lastPushError = null;
    updateNotifPermissionStatus();
    showToast('Notifications activées sur cet appareil');
  }catch(e){
    console.error('Erreur activation notifications :', e);
    lastPushError = (e && e.message) ? e.message : String(e);
    updateNotifPermissionStatus();
    showToast("Erreur lors de l'activation des notifications");
  }
}

async function savePushToken(token){
  if(!currentFamilyId) return;
  const tokensRef = db.ref('families/' + currentFamilyId + '/pushTokens');
  const existing = await tokensRef.orderByChild('token').equalTo(token).once('value');
  if(existing.exists()) return;
  await tokensRef.push({
    token,
    childId: currentChildId,
    updatedAt: Date.now(),
    ua: navigator.userAgent.slice(0, 120),
  });
}

// Si la permission a déjà été accordée lors d'une session précédente, on
// revalide silencieusement le jeton au démarrage (les jetons FCM peuvent
// tourner) — jamais de nouvelle demande de permission ici.
async function silentlyRefreshPushToken(){
  if(!messaging || !('Notification' in window) || Notification.permission !== 'granted') return;
  try{
    const registration = await navigator.serviceWorker.register('/firebase-messaging-sw.js');
    const token = await messaging.getToken({ vapidKey: VAPID_KEY, serviceWorkerRegistration: registration });
    if(token){
      await savePushToken(token);
      pushTokenConfirmed = true;
      lastPushError = null;
    }
  }catch(e){
    console.error('Erreur de rafraîchissement du jeton push :', e);
    lastPushError = (e && e.message) ? e.message : String(e);
  }
  updateNotifPermissionStatus();
}

// Affiche un toast quand un push arrive alors que l'app est déjà ouverte au
// premier plan (FCM ne déclenche pas nativement showNotification() dans ce
// cas, contrairement à l'app fermée/arrière-plan gérée par le Service Worker).
if(messaging){
  messaging.onMessage((payload) => {
    const title = (payload.notification && payload.notification.title) || 'Suivi Aylan';
    showToast(title);
  });
}

function checkReminderNotification(overdue, lastBottleTimestamp){
  if(!overdue || !lastBottleTimestamp) return;
  if(!('Notification' in window) || Notification.permission !== 'granted') return;
  if(lastNotifiedBottleTimestamp === lastBottleTimestamp) return;

  lastNotifiedBottleTimestamp = lastBottleTimestamp;
  const title = `${getChildFirstName() || DEFAULT_SITE_NAME} a peut-être faim`;
  const body = `Ça fait plus de ${(reminderThresholdMinutes/60).toFixed(1).replace('.0','').replace('.', ',')} h depuis le dernier biberon.`;

  if(navigator.serviceWorker && navigator.serviceWorker.controller){
    navigator.serviceWorker.ready.then(reg => reg.showNotification(title, { body, icon: undefined }));
  }else{
    try{ new Notification(title, { body }); }catch(e){}
  }
}

function renderStats(){
  // Premier lancement : aucune entrée n'existe encore pour cet enfant, tous
  // temps confondus (pas juste "aujourd'hui"). Un mur de "0 ml / 0 vomissements"
  // n'aide personne à démarrer — on remplace la carte héro par un accueil qui
  // invite explicitement au premier geste plutôt que de constater son absence.
  if(entries.length === 0){
    const name = getChildFirstName() || DEFAULT_SITE_NAME;
    $('stat-hero-container').innerHTML = `
      <div class="stat-hero stat-hero-welcome">
        <div class="today-hero-top">
          <div class="today-hero-icon">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10 2h4"/><path d="M10.5 2v3c0 .7-.4 1.1-.9 1.6-1 .9-1.6 1.9-1.6 3.4v9c0 1.1.9 2 2 2h4c1.1 0 2-.9 2-2v-9c0-1.5-.6-2.5-1.6-3.4-.5-.5-.9-.9-.9-1.6V2"/><line x1="8.5" y1="12.5" x2="15.5" y2="12.5"/></svg>
          </div>
          <div>
            <div class="lbl">Bienvenue</div>
            <div class="num" style="font-size:19px;">Ajoute le premier biberon de ${escapeHtml(name)}</div>
          </div>
        </div>
        <p class="stat-hero-welcome-hint">Tout ce que tu enregistres ici — biberons, couches, et plus si tu actives d'autres suivis dans les paramètres — apparaît immédiatement ci-dessous et nourrit les statistiques et le calendrier.</p>
      </div>
    `;
    const heroTopEl2 = document.querySelector('#stat-hero-container .today-hero-top');
    if(heroTopEl2) heroTopEl2.addEventListener('click', openAddModal);
    const diaperBadge2 = $('diaper-qa-badge');
    if(diaperBadge2) diaperBadge2.classList.add('hidden');
    const vomitBadge2 = $('vomit-qa-badge');
    if(vomitBadge2) vomitBadge2.classList.add('hidden');
    return;
  }

  const today = todayKey(new Date());
  const todays = entries.filter(e => e.dayKey === today);
  const bottlesToday = todays.filter(e => e.type === 'biberon');
  const totalMl = bottlesToday.reduce((s,e)=> s + (e.ml||0), 0);
  const feedCount = bottlesToday.length;
  const bottleDiaperCount = bottlesToday.filter(e => isDiaperChange(e.diaper)).length;
  const standaloneDiaperCount = todays.filter(e => e.type === 'diaper').length;
  const diaperCount = bottleDiaperCount + standaloneDiaperCount;
  const vomitCount = todays.filter(e => e.type === 'vomit').length;

  let lastAgo = '—';
  let minutesSinceLast = null;
  let lastBottleTimestamp = null;
  const bottleEntries = entries.filter(e => e.type === 'biberon');
  if(bottleEntries.length){
    const sorted = [...bottleEntries].sort((a,b)=> b.timestamp - a.timestamp);
    lastBottleTimestamp = sorted[0].timestamp;
    const diffMin = Math.round((Date.now() - sorted[0].timestamp) / 60000);
    minutesSinceLast = diffMin;
    if(diffMin < 60) lastAgo = diffMin + ' min';
    else lastAgo = Math.floor(diffMin/60) + ' h ' + (diffMin%60) + ' min';
  }

  const overdue = reminderEnabled && minutesSinceLast !== null && minutesSinceLast >= reminderThresholdMinutes;

  const progressPct = (reminderEnabled && minutesSinceLast !== null)
    ? Math.max(4, Math.min(100, Math.round(minutesSinceLast / reminderThresholdMinutes * 100)))
    : null;
  const progressHtml = progressPct !== null
    ? `<div class="hero-progress-track"><div class="hero-progress-fill" style="width:${progressPct}%"></div></div>`
    : '';

  // Moyenne des ml/jour sur les 7 jours précédents (jours réellement suivis uniquement),
  // pour situer le total du jour par rapport aux habitudes récentes.
  let pastMlTotal = 0, pastDaysTracked = 0;
  for(let i = 1; i <= 7; i++){
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = todayKey(d);
    const dayEntries = entries.filter(e => e.dayKey === key);
    if(dayEntries.length){
      pastDaysTracked++;
      pastMlTotal += dayEntries.filter(e => e.type === 'biberon').reduce((s,e)=> s + (e.ml||0), 0);
    }
  }
  const avgPastMl = pastDaysTracked >= 3 ? Math.round(pastMlTotal / pastDaysTracked) : null;
  let mlDeltaHtml = '';
  if(avgPastMl){
    const pct = Math.round(Math.abs(totalMl - avgPastMl) / avgPastMl * 100);
    const up = totalMl >= avgPastMl;
    mlDeltaHtml = `<span class="ml-delta">${up ? '↑' : '↓'} ${pct}% vs 7j</span>`;
  }

  const sparkBars = bottlesToday.slice(-7);
  const maxMl = Math.max(1, ...sparkBars.map(e => e.ml || 0));
  const sparkHtml = sparkBars.length
    ? `<div class="bento-spark">${sparkBars.map(e => `<i style="height:${Math.max(18, Math.round((e.ml || 0) / maxMl * 100))}%"></i>`).join('')}</div>`
    : '';

  // Prochain repas estimé : simple projection lastBottleTimestamp + seuil de
  // rappel, affichée seulement quand le rappel est actif et qu'on a une
  // dernière prise — sinon la ligne n'a pas de sens (pas de seuil, ou aucun
  // biberon jamais enregistré).
  const nextMealHtml = (reminderEnabled && lastBottleTimestamp)
    ? `<div class="hero-next-meal">Prochain repas estimé <b>${formatTimeFromTimestamp(lastBottleTimestamp + reminderThresholdMinutes * 60000)}</b></div>`
    : '';

  $('stat-hero-container').innerHTML = `
    <div class="stat-hero${overdue ? ' overdue' : ''}">
      <img class="stat-hero-photo" src="images/bottle-hero.webp" alt="" aria-hidden="true">
      <div class="today-hero-top">
        <div class="today-hero-icon">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10 2h4"/><path d="M10.5 2v3c0 .7-.4 1.1-.9 1.6-1 .9-1.6 1.9-1.6 3.4v9c0 1.1.9 2 2 2h4c1.1 0 2-.9 2-2v-9c0-1.5-.6-2.5-1.6-3.4-.5-.5-.9-.9-.9-1.6V2"/><line x1="8.5" y1="12.5" x2="15.5" y2="12.5"/></svg>
        </div>
        <div class="hero-top-text">
          <div class="hero-lbl-row">
            <div class="lbl">Dernier biberon</div>
            ${overdue ? `<span class="overdue-pill"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/></svg>En retard</span>` : ''}
          </div>
          <div class="num">${lastAgo}</div>
          ${progressHtml}
          ${nextMealHtml}
        </div>
      </div>
      <div class="bento-row">
        <div class="bento-wide">
          <div>
            <div class="v">${totalMl} ml</div>
            <div class="l">Aujourd'hui${mlDeltaHtml}</div>
          </div>
          ${sparkHtml}
        </div>
        <div class="bento-small"><div class="v">${feedCount} / ${diaperCount}</div><div class="l">Bib. / Couches</div></div>
        <div class="bento-small"><div class="v">${vomitCount}</div><div class="l">Vomissements</div></div>
      </div>
    </div>
  `;

  const heroTopEl = document.querySelector('#stat-hero-container .today-hero-top');
  if(heroTopEl) heroTopEl.addEventListener('click', openAddModal);

  const diaperBadge = $('diaper-qa-badge');
  if(diaperBadge){
    diaperBadge.textContent = diaperCount;
    diaperBadge.classList.toggle('hidden', diaperCount === 0);
  }
  const vomitBadge = $('vomit-qa-badge');
  if(vomitBadge){
    vomitBadge.textContent = vomitCount;
    vomitBadge.classList.toggle('hidden', vomitCount === 0);
  }

  renderTodayTicker(totalMl, feedCount, diaperCount, vomitCount);
  checkReminderNotification(overdue, lastBottleTimestamp);
}

// Bande défilante de stats du jour (inspirée des bandes "marquee" vues sur
// ciaokombucha.com) — reste factuelle plutôt que décorative : une seule
// occurrence dans l'app (Aujourd'hui), masquée tant qu'il n'y a rien à
// résumer, jamais un doublon pur du bloc "Dernier biberon" juste au-dessus.
function renderTodayTicker(totalMl, feedCount, diaperCount, vomitCount){
  const el = $('today-ticker-container');
  if(!el) return;
  if(!feedCount && !diaperCount && !vomitCount){ el.innerHTML = ''; return; }

  const stats = [`<b>${totalMl}</b> ml aujourd'hui`, `<b>${diaperCount}</b> couche${diaperCount > 1 ? 's' : ''}`];
  if(familyFeatures.sleep){
    const today = todayKey(new Date());
    const sleepToday = entries.filter(e => e.dayKey === today && e.type === 'sleep' && e.end != null);
    const totalSleepMin = sleepToday.reduce((s,e) => s + (e.durationMin != null ? e.durationMin : (e.end - e.start) / 60000), 0);
    if(totalSleepMin > 0) stats.push(`<b>${formatDuration(totalSleepMin)}</b> de sommeil`);
  }
  if(vomitCount) stats.push(`<b>${vomitCount}</b> vomissement${vomitCount > 1 ? 's' : ''}`);

  const items = stats.map(s => `<span>${s}</span>`).join('');
  el.innerHTML = `<div class="today-ticker"><div class="today-ticker-track">${items}${items}</div></div>`;
}

function buildDailySummaryText(){
  const today = todayKey(new Date());
  const todays = entries.filter(e => e.dayKey === today);
  const bottlesToday = todays.filter(e => e.type === 'biberon');
  const totalMl = bottlesToday.reduce((s,e)=> s + (e.ml||0), 0);
  const feedCount = bottlesToday.length;
  const bottleDiaperCount = bottlesToday.filter(e => isDiaperChange(e.diaper)).length;
  const standaloneDiaperCount = todays.filter(e => e.type === 'diaper').length;
  const diaperCount = bottleDiaperCount + standaloneDiaperCount;
  const vomitCount = todays.filter(e => e.type === 'vomit').length;

  const name = getChildFirstName() || DEFAULT_SITE_NAME;
  const lines = [`Résumé du jour pour ${name} :`, `🍼 ${feedCount} biberon${feedCount > 1 ? 's' : ''} (${totalMl} ml)`, `💧 ${diaperCount} couche${diaperCount > 1 ? 's' : ''}`];
  if(vomitCount) lines.push(`🤮 ${vomitCount} vomissement${vomitCount > 1 ? 's' : ''}`);

  if(familyFeatures.sleep){
    const sleepToday = todays.filter(e => e.type === 'sleep' && e.end != null);
    const totalSleepMin = sleepToday.reduce((s,e) => s + (e.durationMin != null ? e.durationMin : (e.end - e.start) / 60000), 0);
    if(totalSleepMin > 0) lines.push(`🌙 ${formatDuration(totalSleepMin)} de sommeil`);
  }
  if(familyFeatures.health){
    const healthToday = todays.filter(e => e.type === 'health');
    healthToday.forEach(e => lines.push(healthKindLabel(e)));
  }

  return lines.join('\n');
}

async function shareDailySummary(){
  const text = buildDailySummaryText();
  if(navigator.share){
    try{
      await navigator.share({ text });
      return;
    }catch(e){
      if(e && e.name === 'AbortError') return;
      // tombe en repli sur la copie presse-papier ci-dessous
    }
  }
  try{
    await navigator.clipboard.writeText(text);
    showToast('Résumé copié dans le presse-papier');
  }catch(e){
    showToast('Impossible de partager ou copier le résumé');
  }
}

function authorInitials(email){
  if(!email) return '?';
  const namePart = email.split('@')[0];
  return namePart.slice(0, 2).toUpperCase();
}

// La pastille d'auteur affiche toujours les initiales de la personne qui a
// créé l'entrée (comportement inchangé) — mais si quelqu'un d'autre l'a
// modifiée depuis, l'info-bulle le précise désormais explicitement plutôt que
// de laisser croire que l'auteur d'origine est aussi le dernier à y avoir
// touché.
function entryAuthorBadgeHtml(e){
  if(!e.authorEmail) return '';
  const editedByOther = e.lastEditedBy && e.lastEditedBy !== e.authorEmail;
  const title = editedByOther ? `Ajouté par ${e.authorEmail} · modifié par ${e.lastEditedBy}` : e.authorEmail;
  return `<div class="entry-author" title="${escapeHtml(title)}">${authorInitials(e.authorEmail)}</div>`;
}

function escapeHtml(str){
  const div = document.createElement('div');
  div.textContent = str;
  // Le tour textContent/innerHTML échappe &, < et > mais PAS les guillemets
  // (ils n'ont pas besoin de l'être dans un nœud texte) — or cette fonction
  // est aussi utilisée dans des attributs (title="…", src="…"), où un
  // guillemet non échappé permet de sortir de l'attribut et d'injecter du
  // HTML arbitraire. On les échappe donc explicitement en plus.
  return div.innerHTML.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function healthKindLabel(e){
  if(e.kind === 'temperature') return `🌡️ Température · ${e.value}°C`;
  if(e.kind === 'teething') return `🦷 Poussée dentaire`;
  if(e.kind === 'stool') return `💩 Selles · ${({dure:'Dure',normale:'Normale',molle:'Molle',liquide:'Liquide'})[e.value] || e.value}`;
  return 'Santé';
}

function entryRowHtml(e){
  if(e.type === 'sleep'){
    const durationLabel = e.end != null
      ? formatDuration(e.durationMin != null ? e.durationMin : (e.end - e.start) / 60000)
      : 'En cours…';
    const endLabel = e.end != null ? ' → ' + formatTimeFromTimestamp(e.end) : '';
    return `
    <div class="entry" data-id="${e.id}">
      <div class="node sleep-node"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a7 7 0 0 0 10.5 10.5z"/></svg></div>
      <div class="entry-card">
        <div class="entry-main">
          <div class="entry-time">${e.time}</div>
          <div class="entry-details">
            <div class="entry-sleep-label">Sommeil${endLabel} · ${durationLabel}</div>
          </div>
        </div>
        <div class="entry-actions">
          ${entryAuthorBadgeHtml(e)}
          <button class="entry-del" data-del="${e.id}">✕</button>
        </div>
      </div>
    </div>`;
  }
  if(e.type === 'health'){
    return `
    <div class="entry" data-id="${e.id}">
      <div class="node health-node"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12h4l2-7 4 14 2-7h6"/></svg></div>
      <div class="entry-card">
        <div class="entry-main">
          <div class="entry-time">${e.time}</div>
          <div class="entry-details">
            <div class="entry-health-label">${healthKindLabel(e)}</div>
            ${e.comment ? `<div class="entry-comment">💬 ${escapeHtml(e.comment)}</div>` : ''}
          </div>
        </div>
        <div class="entry-actions">
          ${entryAuthorBadgeHtml(e)}
          <button class="entry-del" data-del="${e.id}">✕</button>
        </div>
      </div>
    </div>`;
  }
  if(e.type === 'vomit'){
    return `
    <div class="entry" data-id="${e.id}">
      <div class="node vomit-node"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12c1.5-2 3-2 4.5 0s3 2 4.5 0 3-2 4.5 0 3 2 4.5 0"/><path d="M3 17c1.5-2 3-2 4.5 0s3 2 4.5 0 3-2 4.5 0 3 2 4.5 0"/></svg></div>
      <div class="entry-card">
        <div class="entry-main">
          <div class="entry-time">${e.time}</div>
          <div class="entry-details">
            <div class="entry-vomit-label">Vomissement</div>
          </div>
        </div>
        <div class="entry-actions">
          ${entryAuthorBadgeHtml(e)}
          <button class="entry-del" data-del="${e.id}">✕</button>
        </div>
      </div>
    </div>`;
  }
  if(e.type === 'diaper'){
    return `
    <div class="entry" data-id="${e.id}">
      <div class="node diaper-node">${diaperIcon(e.diaper)}</div>
      <div class="entry-card entry-card-clickable" data-edit-diaper-row="${e.id}">
        <div class="entry-main">
          <div class="entry-time">${e.time}</div>
          <div class="entry-details">
            <div class="entry-diaper">Couche · ${diaperLabel(e.diaper)}</div>
            ${e.comment ? `<div class="entry-comment">💬 ${escapeHtml(e.comment)}</div>` : ''}
          </div>
        </div>
        <div class="entry-actions">
          ${entryAuthorBadgeHtml(e)}
          <button class="entry-del" data-del="${e.id}">✕</button>
        </div>
      </div>
    </div>`;
  }
  return `
    <div class="entry" data-id="${e.id}">
      <div class="node biberon-node">${diaperIcon(e.diaper)}</div>
      <div class="entry-card entry-card-clickable" data-edit-row="${e.id}">
        <div class="entry-main">
          <div class="entry-time">${e.time}</div>
          <div class="entry-details">
            <div class="entry-ml">${e.ml} ml</div>
            <div class="entry-diaper">${diaperLabel(e.diaper)}</div>
            ${e.comment ? `<div class="entry-comment">💬 ${escapeHtml(e.comment)}</div>` : ''}
          </div>
        </div>
        <div class="entry-actions">
          ${entryAuthorBadgeHtml(e)}
          <button class="entry-del" data-del="${e.id}">✕</button>
        </div>
      </div>
    </div>`;
}

function bindEntryButtons(container){
  container.querySelectorAll('[data-del]').forEach(btn => {
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      if(btn.classList.contains('confirming')){
        clearTimeout(btn._confirmTimeout);
        deleteEntry(btn.getAttribute('data-del'));
        return;
      }
      btn.classList.add('confirming');
      btn.textContent = 'Confirmer';
      btn._confirmTimeout = setTimeout(() => {
        btn.classList.remove('confirming');
        btn.textContent = '✕';
      }, 3000);
    });
  });
  container.querySelectorAll('[data-edit-row]').forEach(card => {
    card.addEventListener('click', (ev) => {
      if(ev.target.closest('.entry-del')) return;
      startEdit(card.getAttribute('data-edit-row'));
    });
  });
  container.querySelectorAll('[data-edit-diaper-row]').forEach(card => {
    card.addEventListener('click', (ev) => {
      if(ev.target.closest('.entry-del')) return;
      startEditDiaper(card.getAttribute('data-edit-diaper-row'));
    });
  });
}

function renderTodayTimeline(){
  const container = $('timeline-container');
  const today = todayKey(new Date());
  const todays = entries.filter(e => e.dayKey === today).sort((a,b)=> a.timestamp - b.timestamp);

  if(!todays.length){
    container.innerHTML = `<div class="empty">Aucun biberon aujourd'hui pour le moment.<br>Ajoutez le premier ci-dessus.</div>`;
    return;
  }

  container.innerHTML = `<div class="timeline">${todays.map(entryRowHtml).join('')}</div>`;
  bindEntryButtons(container);
}

function highlightMatch(text, query){
  const escaped = escapeHtml(text);
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if(idx === -1) return escaped;
  const before = escapeHtml(text.slice(0, idx));
  const match = escapeHtml(text.slice(idx, idx + query.length));
  const after = escapeHtml(text.slice(idx + query.length));
  return `${before}<mark>${match}</mark>${after}`;
}

let activeFilterType = 'all';
function selectFilterType(type){
  activeFilterType = type;
  document.querySelectorAll('#search-filter-row .filter-chip').forEach(b => {
    b.classList.toggle('active', b.getAttribute('data-filter-type') === type);
  });
  renderCommentSearch();
}

function entrySearchSummaryLabel(e){
  if(e.type === 'biberon') return `🍼 ${e.ml} ml` + (isDiaperChange(e.diaper) ? ' · ' + diaperLabel(e.diaper) : '');
  if(e.type === 'diaper') return `💧 ${diaperLabel(e.diaper)}`;
  if(e.type === 'vomit') return '🤮 Vomissement';
  if(e.type === 'sleep') return '🌙 Sommeil' + (e.end != null ? ' · ' + formatDuration(e.durationMin != null ? e.durationMin : (e.end - e.start) / 60000) : ' · en cours');
  if(e.type === 'health') return healthKindLabel(e);
  return '';
}

function renderCommentSearch(){
  const query = $('comment-search-input').value.trim();
  const resultsEl = $('comment-search-results');
  const mainBlock = $('calendar-main-block');

  if(!query && activeFilterType === 'all'){
    resultsEl.innerHTML = '';
    mainBlock.classList.remove('hidden');
    return;
  }

  mainBlock.classList.add('hidden');

  const matches = entries
    .filter(e => activeFilterType === 'all' || e.type === activeFilterType)
    .filter(e => !query || (e.comment && e.comment.toLowerCase().includes(query.toLowerCase())))
    .sort((a,b) => b.timestamp - a.timestamp)
    .slice(0, 30);

  if(!matches.length){
    resultsEl.innerHTML = `<div class="search-no-results">Aucun résultat.</div>`;
    return;
  }

  resultsEl.innerHTML = matches.map(e => `
    <div class="search-result-item" data-jump-day="${e.dayKey}">
      <div class="search-result-date">${formatShortDate(e.dayKey)} · ${e.time}</div>
      <div class="search-result-comment">${(e.comment && query) ? highlightMatch(e.comment, query) : escapeHtml(entrySearchSummaryLabel(e))}</div>
    </div>`).join('');

  resultsEl.querySelectorAll('[data-jump-day]').forEach(el => {
    el.addEventListener('click', () => {
      const dayKey = el.getAttribute('data-jump-day');
      const [y,m,d] = dayKey.split('-').map(Number);
      calMonthDate = new Date(y, m-1, 1);
      selectedCalDay = dayKey;
      $('comment-search-input').value = '';
      activeFilterType = 'all';
      document.querySelectorAll('#search-filter-row .filter-chip').forEach(b => {
        b.classList.toggle('active', b.getAttribute('data-filter-type') === 'all');
      });
      resultsEl.innerHTML = '';
      mainBlock.classList.remove('hidden');
      $('cal-search-panel').classList.add('hidden');
      $('cal-search-toggle').classList.remove('active');
      renderCalendar();
      setTimeout(() => {
        $('cal-day-detail').scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 50);
    });
  });
}

function toggleCalSearch(){
  const panel = $('cal-search-panel');
  const btn = $('cal-search-toggle');
  const opening = panel.classList.contains('hidden');
  panel.classList.toggle('hidden', !opening);
  btn.classList.toggle('active', opening);
  if(opening){
    setTimeout(() => $('comment-search-input').focus(), 50);
  }else{
    $('comment-search-input').value = '';
    activeFilterType = 'all';
    document.querySelectorAll('#search-filter-row .filter-chip').forEach(b => {
      b.classList.toggle('active', b.getAttribute('data-filter-type') === 'all');
    });
    renderCommentSearch();
  }
}

function dayDotClasses(dayEntries){
  const order = [
    { type:'biberon', cls:'dot-milk' },
    { type:'diaper', cls:'dot-diaper' },
    { type:'vomit', cls:'dot-vomit' },
    { type:'sleep', cls:'dot-sleep' },
    { type:'health', cls:'dot-health' },
  ];
  const present = new Set(dayEntries.map(e => e.type));
  return order.filter(o => present.has(o.type)).map(o => o.cls).slice(0, 3);
}

function renderCalendar(){
  const year = calMonthDate.getFullYear();
  const month = calMonthDate.getMonth();

  $('cal-title').textContent = calMonthDate.toLocaleDateString('fr-FR', { month:'long', year:'numeric' });

  const monthPrefix = `${year}-${pad(month + 1)}`;
  const monthEntries = entries.filter(e => e.dayKey.startsWith(monthPrefix));
  const monthBottles = monthEntries.filter(e => e.type === 'biberon');
  const monthMl = monthBottles.reduce((s, e) => s + (e.ml || 0), 0);
  const monthDiaperCount = monthEntries.filter(e => e.type === 'diaper').length
    + monthBottles.filter(e => isDiaperChange(e.diaper)).length;
  $('cal-month-stats').innerHTML = monthEntries.length ? `
    <span><b>${monthBottles.length}</b> biberon${monthBottles.length > 1 ? 's' : ''}</span>
    <span><b>${monthMl}</b> ml</span>
    <span><b>${monthDiaperCount}</b> couche${monthDiaperCount > 1 ? 's' : ''}</span>
  ` : `<span>Aucune entrée ce mois-ci</span>`;

  const entriesByDay = {};
  entries.forEach(e => { (entriesByDay[e.dayKey] || (entriesByDay[e.dayKey] = [])).push(e); });
  const firstOfMonth = new Date(year, month, 1);
  let startOffset = firstOfMonth.getDay() - 1; // lundi = 0
  if(startOffset < 0) startOffset = 6;
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const todayStr = todayKey(new Date());

  const dowLabels = ['L','M','M','J','V','S','D'];
  let html = dowLabels.map(d => `<div class="cal-dow">${d}</div>`).join('');

  for(let i=0; i<startOffset; i++){
    html += `<div class="cal-day empty-cell"></div>`;
  }

  for(let d=1; d<=daysInMonth; d++){
    const dateObj = new Date(year, month, d);
    const key = todayKey(dateObj);
    const dayEntries = entriesByDay[key];
    const has = !!dayEntries;
    const classes = ['cal-day'];
    if(has) classes.push('has-entries');
    if(key === todayStr) classes.push('is-today');
    if(key === selectedCalDay) classes.push('selected');
    const dotsHtml = has ? `<span class="dots">${dayDotClasses(dayEntries).map(c => `<span class="dot ${c}"></span>`).join('')}</span>` : '';
    const dayLabel = escapeHtml(dateObj.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' }) + (has ? ', avec des entrées' : ''));
    html += `<div class="${classes.join(' ')}" data-day="${key}" tabindex="0" role="button" aria-label="${dayLabel}">${d}${dotsHtml}</div>`;
  }

  $('cal-grid').innerHTML = html;
  $('cal-grid').querySelectorAll('[data-day]').forEach(el => {
    const selectDay = () => {
      selectedCalDay = el.getAttribute('data-day');
      renderCalendar();
      renderCalDayDetail();
      // renderCalendar() vient de reconstruire toute la grille (innerHTML) —
      // sans ceci, le focus clavier serait perdu après chaque sélection.
      const reselected = $('cal-grid').querySelector(`[data-day="${selectedCalDay}"]`);
      if(reselected) reselected.focus();
    };
    el.addEventListener('click', selectDay);
    // Cellules en <div> (pas <button>) pour rester dans le style de grille déjà
    // en place — on leur redonne l'activation clavier standard d'un bouton.
    el.addEventListener('keydown', (e) => {
      if(e.key === 'Enter' || e.key === ' '){
        e.preventDefault();
        selectDay();
      }
    });
  });

  if(selectedCalDay) renderCalDayDetail();
  else $('cal-day-detail').innerHTML = `<div class="empty">Sélectionnez un jour pour voir ses biberons.</div>`;
}

function renderCalDayDetail(){
  const container = $('cal-day-detail');
  const dayEntries = entries.filter(e => e.dayKey === selectedCalDay).sort((a,b)=> a.timestamp - b.timestamp);
  const label = formatDayLabel(selectedCalDay);

  if(!dayEntries.length){
    container.innerHTML = `<div class="cal-day-detail-label">${label}</div><div class="empty">Aucun biberon ce jour-là.</div>`;
    return;
  }

  const bottleEntries = dayEntries.filter(e => e.type !== 'vomit');
  const vomitCount = dayEntries.length - bottleEntries.length;
  const totalMl = bottleEntries.reduce((s,e)=> s + (e.ml||0), 0);
  container.innerHTML = `
    <div class="cal-day-detail-label">${label} · ${bottleEntries.length} biberon${bottleEntries.length>1?'s':''} · ${totalMl} ml${vomitCount ? ` · ${vomitCount} vomissement${vomitCount>1?'s':''}` : ''}</div>
    <div class="timeline">${dayEntries.map(entryRowHtml).join('')}</div>
  `;
  bindEntryButtons(container);
}

function addDays(date, n){
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

function buildDayRange(){
  if(!entries.length) return [];
  const keys = [...new Set(entries.map(e => e.dayKey))].sort();
  const [sy, smo, sd] = keys[0].split('-').map(Number);
  const startDate = new Date(sy, smo - 1, sd);
  const todayDate = new Date();
  const todayStr = todayKey(todayDate);
  const lastKey = keys[keys.length - 1] > todayStr ? keys[keys.length - 1] : todayStr;
  const [ey, emo, ed] = lastKey.split('-').map(Number);
  const endDate = new Date(ey, emo - 1, ed);

  const days = [];
  let cursor = new Date(startDate);
  while(cursor <= endDate){
    days.push({ dayKey: todayKey(cursor), date: new Date(cursor) });
    cursor = addDays(cursor, 1);
  }
  return days;
}

function renderDayChartSVG(container, days, values, opts){
  if(!days.length){
    container.innerHTML = `<div class="chart-empty">${opts.emptyText}</div>`;
    return;
  }

  const todayStr = todayKey(new Date());
  const n = days.length;
  const leftPad = 32;
  const rightPad = 20;
  const topPad = 24;
  const bottomPad = 28;
  const chartH = 140;
  const minSpacing = 46;
  const minSvgW = Math.max(320, leftPad + rightPad + (n - 1) * minSpacing);
  // Sur un conteneur plus large que ce minimum (desktop), on étire l'espacement
  // entre points pour occuper toute la largeur disponible plutôt que de laisser
  // le graphique flotter, cramponné à gauche, dans une carte trop grande pour
  // lui — mobile est inchangé puisque son conteneur avoisine déjà ce minimum.
  const svgW = Math.max(minSvgW, container.clientWidth || minSvgW);
  const spacing = n > 1 ? (svgW - leftPad - rightPad) / (n - 1) : 0;
  const svgH = topPad + chartH + bottomPad;

  const maxVal = Math.max(...values, opts.minScale || 1);
  const step = opts.step || 50;
  const niceMax = Math.ceil(maxVal / step) * step || step;

  const xFor = i => leftPad + i * spacing;
  const yFor = v => topPad + chartH - (v / niceMax) * chartH;

  const gridLines = [0, 0.5, 1].map(f => {
    const val = Math.round(niceMax * f);
    const y = yFor(val);
    return `<line x1="${leftPad}" y1="${y}" x2="${svgW - rightPad}" y2="${y}" stroke="var(--line)" stroke-width="1" stroke-dasharray="3,4"/><text x="2" y="${y + 3.5}" font-size="9" fill="var(--ink-faint)" font-family="Sora">${val}</text>`;
  }).join('');

  const pathD = 'M ' + days.map((d,i) => `${xFor(i)},${yFor(values[i])}`).join(' L ');
  const areaD = `${pathD} L ${xFor(n-1)},${topPad+chartH} L ${xFor(0)},${topPad+chartH} Z`;

  const labelInterval = Math.max(1, Math.ceil(n / 9));
  const xLabels = days.map((d,i) => {
    if(i % labelInterval !== 0 && i !== n - 1) return '';
    const short = `${pad(d.date.getDate())}/${pad(d.date.getMonth()+1)}`;
    return `<text x="${xFor(i)}" y="${topPad + chartH + 20}" font-size="9.5" fill="var(--ink-faint)" font-family="Sora" text-anchor="middle">${short}</text>`;
  }).join('');

  const dots = days.map((d,i) => {
    const isToday = d.dayKey === todayStr;
    const r = isToday ? 4.5 : 3;
    const ring = isToday ? `stroke="var(--sage)" stroke-width="2"` : '';
    return `<g class="chart-point" data-idx="${i}">
      <circle cx="${xFor(i)}" cy="${yFor(values[i])}" r="13" fill="transparent"/>
      <circle cx="${xFor(i)}" cy="${yFor(values[i])}" r="${r}" fill="var(--milk)" ${ring}/>
    </g>`;
  }).join('');

  const todayIdx = days.findIndex(d => d.dayKey === todayStr);
  let todayLabel = '';
  if(todayIdx >= 0){
    todayLabel = `<text x="${xFor(todayIdx)}" y="${yFor(values[todayIdx]) - 10}" font-size="10.5" font-weight="600" fill="var(--milk)" font-family="Sora" text-anchor="middle">${opts.formatValue(values[todayIdx])}</text>`;
  }

  container.innerHTML = `
    <div class="chart-tooltip hidden" data-tooltip></div>
    <svg width="${svgW}" height="${svgH}" viewBox="0 0 ${svgW} ${svgH}">
      ${gridLines}
      <path d="${areaD}" fill="var(--milk-dim)" opacity="0.6"/>
      <path class="chart-line-path" d="${pathD}" fill="none" stroke="var(--milk)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
      ${dots}
      ${todayLabel}
      ${xLabels}
    </svg>
  `;

  const tooltip = container.querySelector('[data-tooltip]');
  container.querySelectorAll('.chart-point').forEach(g => {
    g.addEventListener('click', () => {
      const idx = Number(g.getAttribute('data-idx'));
      const d = days[idx];
      const v = values[idx];
      const isSameOpen = !tooltip.classList.contains('hidden') && tooltip.dataset.idx === String(idx);
      if(isSameOpen){
        tooltip.classList.add('hidden');
        return;
      }
      tooltip.dataset.idx = idx;
      tooltip.textContent = `${formatShortDateNoYear(d.dayKey)} · ${opts.formatValue(v)}`;
      tooltip.style.left = xFor(idx) + 'px';
      tooltip.style.top = (yFor(v) - 34) + 'px';
      tooltip.classList.remove('hidden');
    });
  });

  requestAnimationFrame(() => { container.scrollLeft = container.scrollWidth; });
}

// Tendance automatique au-dessus du graphique de lait : transforme les
// données déjà enregistrées en une lecture immédiate ("toutes les X h,
// plutôt le soir") au lieu de laisser l'utilisateur interpréter des chiffres
// bruts. Toujours factuel et descriptif, jamais un conseil ou un jugement.
function computeMilkInsight(){
  const now = Date.now();
  const sevenDaysAgo = now - 7 * 24 * 3600000;
  const recent = entries
    .filter(e => e.type === 'biberon' && e.timestamp >= sevenDaysAgo)
    .sort((a, b) => a.timestamp - b.timestamp);

  // Historique trop court pour qu'une moyenne/un créneau soit fiable plutôt
  // que du bruit statistique.
  if(recent.length < 5) return null;

  const gaps = [];
  for(let i = 1; i < recent.length; i++) gaps.push(recent[i].timestamp - recent[i - 1].timestamp);
  const avgGapMin = Math.round(gaps.reduce((s, g) => s + g, 0) / gaps.length / 60000);
  const gapH = Math.floor(avgGapMin / 60);
  const gapM = avgGapMin % 60;
  const gapTxt = gapH > 0 ? `${gapH} h${gapM ? ' ' + pad(gapM) : ''}` : `${gapM} min`;

  // Créneau de 3h le plus fréquent (0-2h, 3-5h, ... 21-23h).
  const buckets = new Array(8).fill(0);
  recent.forEach(e => { buckets[Math.floor(new Date(e.timestamp).getHours() / 3)]++; });
  const topBucket = buckets.indexOf(Math.max(...buckets));
  const slotStart = topBucket * 3;
  const slotEnd = slotStart + 3;

  return { gapTxt, slotTxt: `${pad(slotStart)}h–${pad(slotEnd)}h` };
}

function renderMilkInsight(){
  const container = $('milk-insight-container');
  if(!container) return;
  const insight = computeMilkInsight();
  if(!insight){
    container.innerHTML = '';
    return;
  }
  const name = getChildFirstName() || DEFAULT_SITE_NAME;
  container.innerHTML = `
    <div class="insight-card">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18h6"/><path d="M10 21h4"/><path d="M12 3a6 6 0 0 0-3.8 10.6c.6.5.8 1 .8 1.4h6c0-.4.2-.9.8-1.4A6 6 0 0 0 12 3z"/></svg>
      <div class="insight-text">${escapeHtml(name)} tète en moyenne toutes les <b>${insight.gapTxt}</b>, le plus souvent entre <b>${insight.slotTxt}</b> (7 derniers jours).</div>
    </div>
  `;
}

function renderChart(){
  const days = buildDayRange();
  const scroll = $('chart-scroll');

  if(!days.length){
    scroll.innerHTML = `<div class="chart-empty">Pas encore de données à afficher.<br>Ajoute quelques biberons pour voir la courbe.</div>`;
    $('chart-stats').innerHTML = '';
    $('chart-stats').classList.add('hidden');
    return;
  }

  const totalsMap = {};
  entries.forEach(e => {
    totalsMap[e.dayKey] = (totalsMap[e.dayKey] || 0) + (e.ml || 0);
  });
  const values = days.map(d => totalsMap[d.dayKey] || 0);

  renderDayChartSVG(scroll, days, values, {
    step: 50,
    formatValue: v => `${v} ml`
  });

  const n = days.length;
  const avg = Math.round(values.reduce((s,v) => s + v, 0) / n);
  const max = Math.max(...values);
  $('chart-stats').classList.remove('hidden');
  $('chart-stats').innerHTML = `
    <div class="cs-stat"><span class="v">${avg} ml</span><span class="l">Moyenne / jour</span></div>
    <div class="cs-stat"><span class="v">${max} ml</span><span class="l">Record</span></div>
    <div class="cs-stat"><span class="v">${n}</span><span class="l">Jours suivis</span></div>
  `;
}

function renderVomitChart(){
  const days = buildDayRange();
  const scroll = $('vomit-chart-scroll');

  if(!days.length){
    scroll.innerHTML = `<div class="chart-empty">Pas encore de données à afficher.</div>`;
    return;
  }

  const countMap = {};
  entries.forEach(e => {
    if(e.type === 'vomit') countMap[e.dayKey] = (countMap[e.dayKey] || 0) + 1;
  });
  const values = days.map(d => countMap[d.dayKey] || 0);
  const maxCount = Math.max(...values, 0);
  const step = maxCount <= 4 ? 1 : Math.ceil(maxCount / 4);

  renderDayChartSVG(scroll, days, values, {
    step,
    minScale: 1,
    formatValue: v => `${v} vomissement${v > 1 ? 's' : ''}`
  });
}

async function deleteEntry(id){
  await removeEntryFromDB(id);
  showToast('Entrée supprimée');
}

function selectDiaper(val){
  selectedDiaper = val;
  document.querySelectorAll('#diaper-row .diaper-btn').forEach(b => {
    b.classList.toggle('active', b.getAttribute('data-val') === val);
  });
}

let selectedDiaperType = 'pipi';
function selectDiaperType(val){
  selectedDiaperType = val;
  document.querySelectorAll('#diaper-type-row .diaper-btn').forEach(b => {
    b.classList.toggle('active', b.getAttribute('data-val') === val);
  });
}

async function logVomit(){
  const btn = $('vomit-log-btn');
  if(btn.disabled) return;
  btn.disabled = true;
  try{
    const now = new Date();
    const entry = {
      id: generateId('e'),
      type: 'vomit',
      time: nowTimeStr(),
      timestamp: now.getTime(),
      dayKey: todayKey(now),
      authorEmail: auth.currentUser ? auth.currentUser.email : null
    };
    await addEntryToDB(entry);
    showToast('Vomissement enregistré', { actionLabel: 'Annuler', onAction: () => removeEntryFromDB(entry.id) });
  }finally{
    btn.disabled = false;
  }
}

// --- Santé (fonctionnalité optionnelle) ---
let selectedHealthKind = 'temperature';
function selectHealthKind(val){
  selectedHealthKind = val;
  document.querySelectorAll('#health-type-row .diaper-btn').forEach(b => {
    b.classList.toggle('active', b.getAttribute('data-val') === val);
  });
  $('health-temperature-field').classList.toggle('hidden', val !== 'temperature');
  $('health-stool-field').classList.toggle('hidden', val !== 'stool');
}

let selectedStoolVal = 'normale';
function selectStool(val){
  selectedStoolVal = val;
  document.querySelectorAll('#health-stool-row .diaper-btn').forEach(b => {
    b.classList.toggle('active', b.getAttribute('data-val') === val);
  });
}

function resetHealthForm(){
  selectHealthKind('temperature');
  selectStool('normale');
  $('health-temperature-input').value = '';
  $('health-date-input').value = dateInputVal(new Date());
  $('health-time-input').value = nowTimeStr();
  $('health-comment-input').value = '';
}

function openHealthModal(){
  resetHealthForm();
  openModal('health-modal-overlay');
}
function closeHealthModal(){
  closeModal('health-modal-overlay');
}

async function saveHealthEntry(){
  const dateVal = $('health-date-input').value;
  const timeVal = $('health-time-input').value;
  if(!dateVal || !timeVal){
    showToast('Merci de renseigner le jour et l\'heure');
    return;
  }
  const [y, mo, d] = dateVal.split('-').map(Number);
  const [h, mi] = timeVal.split(':').map(Number);
  const entryDate = new Date(y, mo - 1, d, h, mi);

  let value = null;
  if(selectedHealthKind === 'temperature'){
    const t = parseFloat($('health-temperature-input').value);
    if(isNaN(t)){
      showToast('Merci de renseigner une température');
      return;
    }
    if(t < 30 || t > 43){
      showToast('Température hors limites (30 à 43°C) — vérifie la valeur');
      return;
    }
    value = t;
  }else if(selectedHealthKind === 'stool'){
    value = selectedStoolVal;
  }

  const entry = {
    id: generateId('e'),
    type: 'health',
    kind: selectedHealthKind,
    value: value,
    time: timeVal,
    timestamp: entryDate.getTime(),
    dayKey: dateVal,
    comment: $('health-comment-input').value.trim(),
    authorEmail: auth.currentUser ? auth.currentUser.email : null
  };
  const btn = $('health-save-btn');
  btn.disabled = true;
  try{
    await addEntryToDB(entry);
    showToast('Entrée santé enregistrée', { actionLabel: 'Annuler', onAction: () => removeEntryFromDB(entry.id) });
    closeHealthModal();
  }finally{
    btn.disabled = false;
  }
}

let editingDiaperId = null;
let editingDiaperOriginalAuthor = null;
let editingDiaperLoadedUpdatedAt = null;

function resetDiaperForm(){
  $('diaper-date-input').value = dateInputVal(new Date());
  $('diaper-time-input').value = nowTimeStr();
  selectDiaperType('pipi');
  $('diaper-comment-input').value = '';
}

function openDiaperModal(){
  openModal('diaper-modal-overlay');
}

function closeDiaperModal(){
  closeModal('diaper-modal-overlay');
}

function startEditDiaper(id){
  const entry = entries.find(e => String(e.id) === String(id));
  if(!entry) return;

  editingDiaperId = id;
  editingDiaperOriginalAuthor = entry.authorEmail || null;
  editingDiaperLoadedUpdatedAt = entry.updatedAt || null;
  $('diaper-date-input').value = entry.dayKey;
  $('diaper-time-input').value = entry.time;
  selectDiaperType(entry.diaper);
  $('diaper-comment-input').value = entry.comment || '';

  $('diaper-form-title').textContent = 'Modifier cette couche';
  $('diaper-save-btn').textContent = 'Enregistrer les modifications';
  $('diaper-cancel-edit-btn').classList.remove('hidden');

  openDiaperModal();
}

function cancelEditDiaper(){
  editingDiaperId = null;
  editingDiaperOriginalAuthor = null;
  editingDiaperLoadedUpdatedAt = null;
  $('diaper-form-title').textContent = 'Couche seule';
  $('diaper-save-btn').textContent = 'Enregistrer';
  $('diaper-cancel-edit-btn').classList.add('hidden');
  resetDiaperForm();
  closeDiaperModal();
}

async function saveDiaperEntry(){
  const timeVal = $('diaper-time-input').value || nowTimeStr();
  const dateVal = $('diaper-date-input').value || dateInputVal(new Date());
  const comment = $('diaper-comment-input').value.trim();
  const [h,m] = timeVal.split(':').map(Number);
  const [y,mo,d] = dateVal.split('-').map(Number);

  const entryDate = new Date(y, mo-1, d, h, m);
  const isEditing = editingDiaperId !== null;
  const currentEmail = auth.currentUser ? auth.currentUser.email : null;

  const entry = {
    id: isEditing ? editingDiaperId : generateId('e'),
    type: 'diaper',
    time: timeVal,
    diaper: selectedDiaperType,
    comment: comment,
    timestamp: entryDate.getTime(),
    dayKey: dateVal,
    authorEmail: isEditing ? (editingDiaperOriginalAuthor || currentEmail) : currentEmail,
    lastEditedBy: isEditing ? currentEmail : null
  };

  const btn = $('diaper-save-btn');
  if(isEditing && !(await checkEditConflict('entries/' + editingDiaperId, editingDiaperLoadedUpdatedAt))) return;

  btn.disabled = true;
  try{
    await addEntryToDB(entry);
    showToast(isEditing ? 'Couche modifiée' : 'Couche enregistrée', isEditing ? undefined : { actionLabel: 'Annuler', onAction: () => removeEntryFromDB(entry.id) });

    if(isEditing){
      cancelEditDiaper();
    }else{
      resetDiaperForm();
      closeDiaperModal();
    }
  }finally{
    btn.disabled = false;
  }
}

let editingId = null;
let editingOriginalAuthor = null;
let editingLoadedUpdatedAt = null;

// Fonction de fermeture "propre" (annule l'édition en cours, etc.) associée
// à chaque overlay — sert à la fois à la fermeture par clic extérieur (déjà
// en place) et à la fermeture par la touche Échap (ci-dessous).
const MODAL_CLOSERS = {
  'add-modal-overlay': () => cancelEdit(),
  'diaper-modal-overlay': () => cancelEditDiaper(),
  'health-modal-overlay': () => closeHealthModal(),
  'milestone-modal-overlay': () => closeMilestoneModal(),
  'add-child-modal-overlay': () => closeAddChildModal(),
  'photo-lightbox-overlay': () => closePhotoLightbox(),
};

function getOpenModalOverlayId(){
  return Object.keys(MODAL_CLOSERS).find(id => {
    const el = $(id);
    return el && !el.classList.contains('hidden');
  }) || null;
}

function getModalFocusables(container){
  return Array.from(container.querySelectorAll(
    'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
  )).filter(el => el.offsetParent !== null);
}

// Échap ferme la modale ouverte ; Tab reste piégé à l'intérieur (pattern
// standard des dialogues accessibles — sans ça, un utilisateur au clavier
// peut tabuler "à travers" la modale jusque dans l'écran resté en dessous).
document.addEventListener('keydown', (e) => {
  const openId = getOpenModalOverlayId();
  if(!openId) return;
  if(e.key === 'Escape'){
    e.preventDefault();
    MODAL_CLOSERS[openId]();
    return;
  }
  if(e.key === 'Tab'){
    const panel = $(openId).querySelector('.modal-panel');
    const focusables = getModalFocusables(panel);
    if(!focusables.length) return;
    const first = focusables[0], last = focusables[focusables.length - 1];
    if(e.shiftKey && document.activeElement === first){
      e.preventDefault(); last.focus();
    }else if(!e.shiftKey && document.activeElement === last){
      e.preventDefault(); first.focus();
    }
  }
});

let modalReturnFocusEl = null;

function openModal(overlayId){
  const overlay = $(overlayId);
  const panel = overlay.querySelector('.modal-panel');
  modalReturnFocusEl = document.activeElement;
  overlay.classList.remove('hidden');
  panel.classList.remove('modal-pop');
  void panel.offsetWidth;
  panel.classList.add('modal-pop');
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  if(!panel.hasAttribute('tabindex')) panel.setAttribute('tabindex', '-1');
  const focusables = getModalFocusables(panel);
  (focusables[0] || panel).focus();
}

function closeModal(overlayId){
  const overlay = $(overlayId);
  overlay.classList.add('hidden');
  overlay.querySelector('.modal-panel').classList.remove('modal-pop');
  // Rend le focus à ce qui l'avait avant l'ouverture (le bouton "+", "✕"
  // d'une entrée, etc.) — sans ça un utilisateur au clavier/lecteur d'écran
  // perd son point de repère à la fermeture.
  if(modalReturnFocusEl && document.body.contains(modalReturnFocusEl) && typeof modalReturnFocusEl.focus === 'function'){
    modalReturnFocusEl.focus();
  }
  modalReturnFocusEl = null;
}

// Visionneuse plein écran pour une photo de souvenir — réutilise le
// mécanisme des modales (Échap, piège du focus au Tab, retour du focus à
// la fermeture) mais avec un habillage visuel dédié (fond sombre, image
// centrée sans recadrage) plutôt que le bottom-sheet standard, voir le
// scoping #photo-lightbox-overlay dans style.css.
function openPhotoLightbox(src, label){
  const img = $('photo-lightbox-img');
  img.src = src;
  img.alt = label ? `Souvenir : ${label}` : 'Souvenir';
  openModal('photo-lightbox-overlay');
}

function closePhotoLightbox(){
  closeModal('photo-lightbox-overlay');
  $('photo-lightbox-img').src = '';
}

function openAddModal(){
  openModal('add-modal-overlay');
  $('fab-btn').classList.add('is-open');
}

function closeAddModal(){
  closeModal('add-modal-overlay');
  $('fab-btn').classList.remove('is-open');
}

let viewBeforeSettings = 'today';

function closeSettingsModal(){
  switchView(viewBeforeSettings);
}

function toggleSettingsSection(titleBtn){
  const section = titleBtn.closest('.settings-section');
  if(section) section.classList.toggle('expanded');
}

function startEdit(id){
  const entry = entries.find(e => String(e.id) === String(id));
  if(!entry) return;

  editingId = id;
  editingOriginalAuthor = entry.authorEmail || null;
  editingLoadedUpdatedAt = entry.updatedAt || null;
  $('date-input').value = entry.dayKey;
  $('time-input').value = entry.time;
  updateDateFieldDisplay();
  updateTimeFieldDisplay();
  $('ml-input').value = entry.ml;
  selectDiaper(entry.diaper);
  $('comment-input').value = entry.comment || '';

  $('form-title').textContent = 'Modifier ce biberon';
  $('save-btn').textContent = 'Enregistrer les modifications';
  $('cancel-edit-btn').classList.remove('hidden');

  openAddModal();
}

function cancelEdit(){
  editingId = null;
  editingOriginalAuthor = null;
  editingLoadedUpdatedAt = null;
  $('form-title').textContent = "Ajout d'un biberon";
  $('save-btn').textContent = 'Enregistrer';
  $('cancel-edit-btn').classList.add('hidden');
  selectDiaper('none');
  setDateOffset(0);
  setNow();
  $('comment-input').value = '';
  closeAddModal();
}

async function saveEntry(){
  const timeVal = $('time-input').value || nowTimeStr();
  const dateVal = $('date-input').value || dateInputVal(new Date());
  const ml = parseInt($('ml-input').value, 10) || 0;
  if(ml < 0 || ml > 1000){
    showToast('Quantité hors limites (0 à 1000 ml) — vérifie la valeur');
    return;
  }
  const comment = $('comment-input').value.trim();
  const [h,m] = timeVal.split(':').map(Number);
  const [y,mo,d] = dateVal.split('-').map(Number);

  const entryDate = new Date(y, mo-1, d, h, m);
  // Un biberon "dans le futur" fausserait le calcul du temps écoulé sur
  // "Dernier biberon" (minutesSinceLast négatif) — refusé explicitement
  // plutôt que de laisser un nombre négatif s'afficher silencieusement.
  if(entryDate.getTime() > Date.now()){
    showToast("Impossible d'enregistrer un biberon à une heure qui n'est pas encore passée");
    return;
  }
  const isEditing = editingId !== null;
  const currentEmail = auth.currentUser ? auth.currentUser.email : null;

  const entry = {
    id: isEditing ? editingId : generateId('e'),
    type: 'biberon',
    time: timeVal,
    ml: ml,
    diaper: selectedDiaper,
    comment: comment,
    timestamp: entryDate.getTime(),
    dayKey: dateVal,
    authorEmail: isEditing ? (editingOriginalAuthor || currentEmail) : currentEmail,
    lastEditedBy: isEditing ? currentEmail : null
  };

  const saveBtn = $('save-btn');
  if(isEditing && !(await checkEditConflict('entries/' + editingId, editingLoadedUpdatedAt))) return;

  saveBtn.disabled = true;
  try{
  await addEntryToDB(entry);
  showToast(
    isEditing ? 'Biberon modifié' : (entry.dayKey === todayKey(new Date()) ? 'Biberon enregistré' : `Biberon ajouté pour le ${formatDayLabel(entry.dayKey)}`),
    isEditing ? undefined : { actionLabel: 'Annuler', onAction: () => removeEntryFromDB(entry.id) }
  );

  if(isEditing){
    cancelEdit();
  }else{
    selectDiaper('none');
    setDateOffset(0);
    setNow();
    $('comment-input').value = '';
    closeAddModal();
  }
  }finally{
    saveBtn.disabled = false;
  }
}

// init
$('now-btn').addEventListener('click', setNow);
$('save-btn').addEventListener('click', saveEntry);

// Champs date/heure de la modale biberon : l'input natif reste la source de
// vérité et le sélecteur normal, la zone stylée par-dessus ouvre ce même
// sélecteur au clic et affiche un texte lisible ("Aujourd'hui", "14:44"...)
// au lieu du rendu système brut (voir updateDateFieldDisplay ci-dessus).
$('date-input').addEventListener('input', updateDateFieldDisplay);
$('date-field-wrap').addEventListener('click', () => openNativePicker($('date-input')));
$('time-input').addEventListener('input', updateTimeFieldDisplay);
$('time-field-wrap').addEventListener('click', () => openNativePicker($('time-input')));
updateDateFieldDisplay();
updateTimeFieldDisplay();
$('cancel-edit-btn').addEventListener('click', cancelEdit);

$('profile-save-btn').addEventListener('click', saveProfile);
$('profile-delete-child-btn').addEventListener('click', () => {
  const btn = $('profile-delete-child-btn');
  if(!deleteChildArmed){
    deleteChildArmed = true;
    btn.textContent = 'Confirmer la suppression ?';
    btn.classList.add('confirming');
    return;
  }
  deleteCurrentChild();
});
$('children-list-page').addEventListener('click', (ev) => {
  if(ev.target.closest('[data-add-child]')){ openAddChildModal(); return; }
  const card = ev.target.closest('[data-child]');
  if(card) switchToChild(card.getAttribute('data-child'));
});
$('children-list-today').addEventListener('click', (ev) => {
  const card = ev.target.closest('[data-child]');
  if(card) switchToChild(card.getAttribute('data-child'));
});
$('add-child-modal-close-btn').addEventListener('click', closeAddChildModal);
$('add-child-modal-overlay').addEventListener('click', (e) => {
  if(e.target.id === 'add-child-modal-overlay') closeAddChildModal();
});
$('add-child-save-btn').addEventListener('click', confirmAddChild);
$('growth-save-btn').addEventListener('click', saveGrowthEntry);
$('growth-cancel-btn').addEventListener('click', cancelEditGrowth);
$('export-json-btn').addEventListener('click', exportDataJSON);
$('export-pdf-btn').addEventListener('click', exportPDF);

// Restauration depuis une sauvegarde — pendant du bouton d'export, jusqu'ici
// resté un aller simple (télécharger un JSON sans jamais pouvoir le
// réimporter). Confirmation à deux clics comme deleteCurrentChild(), pour
// une action irréversible.
let restorePendingData = null;
let restoreArmed = false;

$('restore-pick-btn').addEventListener('click', () => $('restore-file-input').click());

$('restore-file-input').addEventListener('change', async (ev) => {
  const input = ev.target;
  const file = input.files[0];
  if(!file) return;
  try{
    const text = await file.text();
    const data = JSON.parse(text);
    if(data.format !== 'suivi-aylan-backup'){
      showToast("Ce fichier ne semble pas être une sauvegarde Suivi Aylan");
      return;
    }
    restorePendingData = data;
    restoreArmed = false;
    const btn = $('restore-confirm-btn');
    btn.classList.remove('confirming');
    btn.textContent = 'Restaurer ces données';

    const nEntries = Array.isArray(data.entries) ? data.entries.length : 0;
    const nGrowth = Array.isArray(data.growth) ? data.growth.length : 0;
    const nVaccines = Array.isArray(data.vaccines) ? data.vaccines.length : 0;
    const nMilestones = Array.isArray(data.milestones) ? data.milestones.length : 0;
    const exportDateTxt = data.exportedAt ? formatShortDate(data.exportedAt.slice(0, 10)) : '?';
    $('restore-preview-text').textContent =
      `${data.childName || 'Enfant'} · ${nEntries} entrée${nEntries > 1 ? 's' : ''}, ${nGrowth} mesure${nGrowth > 1 ? 's' : ''}, ${nVaccines} vaccin${nVaccines > 1 ? 's' : ''}, ${nMilestones} souvenir${nMilestones > 1 ? 's' : ''} · sauvegarde du ${exportDateTxt}. `
      + `Tout ce qui a été ajouté après cette date sera perdu si tu restaures.`;
    $('restore-preview').classList.remove('hidden');
  }catch(e){
    showToast("Fichier illisible — vérifie qu'il s'agit bien d'un export Suivi Aylan");
  }finally{
    input.value = ''; // permet de resélectionner le même fichier si besoin
  }
});

$('restore-confirm-btn').addEventListener('click', async () => {
  if(!restorePendingData) return;
  const btn = $('restore-confirm-btn');
  if(!restoreArmed){
    restoreArmed = true;
    btn.textContent = 'Confirmer le remplacement ?';
    btn.classList.add('confirming');
    return;
  }
  btn.disabled = true;
  try{
    const data = restorePendingData;
    const toObj = (arr) => {
      const obj = {};
      (Array.isArray(arr) ? arr : []).forEach(item => { if(item && item.id != null) obj[item.id] = item; });
      return obj;
    };
    await Promise.all([
      childRef('entries').set(toObj(data.entries)),
      childRef('growth').set(toObj(data.growth)),
      childRef('vaccines').set(toObj(data.vaccines)),
      childRef('milestones').set(toObj(data.milestones)),
      data.profile ? childRef('profile').set(data.profile) : Promise.resolve(),
    ]);
    showToast('Données restaurées');
    $('restore-preview').classList.add('hidden');
    restorePendingData = null;
    restoreArmed = false;
  }catch(e){
    showToast('Erreur lors de la restauration');
  }finally{
    btn.disabled = false;
  }
});
document.querySelectorAll('#pediatric-period-row .period-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    pediatricPeriodDays = Number(btn.getAttribute('data-days'));
    document.querySelectorAll('#pediatric-period-row .period-btn').forEach(b => {
      b.classList.toggle('active', b === btn);
    });
  });
});

document.querySelectorAll('.bottom-nav-btn[data-view]').forEach(btn => {
  btn.addEventListener('click', () => {
    switchView(btn.getAttribute('data-view'));
  });
});
function wireTabs(groupName){
  const buttons = document.querySelectorAll(`.tab-btn[data-tab-group="${groupName}"]`);
  const panels = document.querySelectorAll(`.tab-panel[data-tab-group="${groupName}"]`);
  buttons.forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.getAttribute('data-tab');
      buttons.forEach(b => b.classList.toggle('active', b === btn));
      panels.forEach(p => p.classList.toggle('active', p.getAttribute('data-tab') === tab));
      // Les courbes (.chart-scroll) sont scrollées vers la droite (valeur la
      // plus récente) au rendu — mais un onglet masqué (display:none) a un
      // scrollWidth de 0 au moment du rendu, donc ce scroll ne "prend" pas
      // tant que l'onglet n'a jamais été affiché. On le refait ici, une fois
      // le panneau réellement visible, pour les courbes qu'il contient.
      const activePanel = document.querySelector(`.tab-panel[data-tab-group="${groupName}"].active`);
      if(activePanel){
        activePanel.querySelectorAll('.chart-scroll').forEach(el => {
          requestAnimationFrame(() => { el.scrollLeft = el.scrollWidth; });
        });
      }
    });
  });
}
wireTabs('chart');
wireTabs('profile');
wireTabs('growth-chart');

let calAnimating = false;

function goToMonth(direction){
  if(calAnimating) return;
  calAnimating = true;

  try{
    const grid = $('cal-grid');
    const title = $('cal-title');
    const outClass = direction === 1 ? 'slide-out-l' : 'slide-out-r';
    const inPrepClass = direction === 1 ? 'slide-in-prep-l' : 'slide-in-prep-r';

    title.style.opacity = '0';
    grid.classList.add(outClass);

    setTimeout(() => {
      try{
        calMonthDate = new Date(calMonthDate.getFullYear(), calMonthDate.getMonth() + direction, 1);
        renderCalendar();

        const newGrid = $('cal-grid');
        newGrid.classList.remove(outClass);
        newGrid.classList.add(inPrepClass);
        void newGrid.offsetWidth;
        newGrid.classList.remove(inPrepClass);
        $('cal-title').style.opacity = '1';
      }finally{
        setTimeout(() => { calAnimating = false; }, 220);
      }
    }, 220);
  }catch(e){
    calAnimating = false;
  }
}

$('cal-prev').addEventListener('click', () => goToMonth(-1));
$('comment-search-input').addEventListener('input', renderCommentSearch);
$('cal-next').addEventListener('click', () => goToMonth(1));
$('cal-search-toggle').addEventListener('click', toggleCalSearch);

let swipeStartX = null;
let swipeStartY = null;
const swipeZone = $('view-calendar');
swipeZone.addEventListener('touchstart', (e) => {
  swipeStartX = e.touches[0].clientX;
  swipeStartY = e.touches[0].clientY;
}, { passive: true });
swipeZone.addEventListener('touchend', (e) => {
  if(swipeStartX === null) return;
  const dx = e.changedTouches[0].clientX - swipeStartX;
  const dy = e.changedTouches[0].clientY - swipeStartY;
  swipeStartX = null;
  if(Math.abs(dx) > 55 && Math.abs(dx) > Math.abs(dy) * 1.5){
    goToMonth(dx < 0 ? 1 : -1);
  }
});

document.querySelectorAll('#diaper-row .diaper-btn').forEach(btn => {
  btn.addEventListener('click', () => selectDiaper(btn.getAttribute('data-val')));
});
document.querySelectorAll('#diaper-type-row .diaper-btn').forEach(btn => {
  btn.addEventListener('click', () => selectDiaperType(btn.getAttribute('data-val')));
});

$('vomit-log-btn').addEventListener('click', logVomit);

$('diaper-log-btn').addEventListener('click', () => {
  if(editingDiaperId !== null){
    editingDiaperId = null;
    editingDiaperOriginalAuthor = null;
    $('diaper-form-title').textContent = 'Couche seule';
    $('diaper-save-btn').textContent = 'Enregistrer';
    $('diaper-cancel-edit-btn').classList.add('hidden');
  }
  resetDiaperForm();
  openDiaperModal();
});
$('diaper-now-btn').addEventListener('click', () => {
  $('diaper-time-input').value = nowTimeStr();
});
$('diaper-save-btn').addEventListener('click', saveDiaperEntry);
$('diaper-cancel-edit-btn').addEventListener('click', cancelEditDiaper);
$('diaper-modal-close-btn').addEventListener('click', cancelEditDiaper);
$('diaper-modal-overlay').addEventListener('click', (e) => {
  if(e.target.id === 'diaper-modal-overlay') cancelEditDiaper();
});

// --- Fonctionnalités optionnelles : toggles des paramètres ---
$('feature-toggle-sleep').addEventListener('click', () => toggleFamilyFeature('sleep'));
$('feature-toggle-health').addEventListener('click', () => toggleFamilyFeature('health'));
$('feature-toggle-vaccines').addEventListener('click', () => toggleFamilyFeature('vaccines'));

// --- Sommeil ---
$('sleep-log-btn').addEventListener('click', toggleSleep);

// --- Santé ---
document.querySelectorAll('#health-type-row .diaper-btn').forEach(btn => {
  btn.addEventListener('click', () => selectHealthKind(btn.getAttribute('data-val')));
});
document.querySelectorAll('#health-stool-row .diaper-btn').forEach(btn => {
  btn.addEventListener('click', () => selectStool(btn.getAttribute('data-val')));
});
$('health-log-btn').addEventListener('click', openHealthModal);
$('health-now-btn').addEventListener('click', () => { $('health-time-input').value = nowTimeStr(); });
$('health-save-btn').addEventListener('click', saveHealthEntry);
$('health-modal-close-btn').addEventListener('click', closeHealthModal);
$('health-modal-overlay').addEventListener('click', (e) => {
  if(e.target.id === 'health-modal-overlay') closeHealthModal();
});

// --- Résumé du jour ---
$('share-summary-btn').addEventListener('click', shareDailySummary);

// --- Filtres de recherche (Calendrier) ---
document.querySelectorAll('#search-filter-row .filter-chip').forEach(btn => {
  btn.addEventListener('click', () => selectFilterType(btn.getAttribute('data-filter-type')));
});

// --- Sexe (Profil, pour le percentile) ---
document.querySelectorAll('#profile-gender-row .diaper-btn').forEach(btn => {
  btn.addEventListener('click', () => selectGender(btn.getAttribute('data-val')));
});

// --- Vaccins & rendez-vous ---
$('vaccine-add-btn').addEventListener('click', addVaccine);

// --- Souvenirs & photos ---
$('milestone-add-btn').addEventListener('click', openMilestoneModal);
$('milestone-modal-close-btn').addEventListener('click', closeMilestoneModal);
$('milestone-modal-overlay').addEventListener('click', (e) => {
  if(e.target.id === 'milestone-modal-overlay') closeMilestoneModal();
});
$('milestone-save-btn').addEventListener('click', saveMilestone);

// --- Visionneuse plein écran (photo de souvenir) ---
$('photo-lightbox-close-btn').addEventListener('click', closePhotoLightbox);
// Contrairement aux autres modales (bottom-sheet ne couvrant pas tout
// l'overlay), .modal-panel occupe ici 100% de l'écran — un clic "en dehors"
// n'existe donc plus au sens strict. On ferme sur tout clic qui n'est ni la
// photo elle-même ni le bouton ✕ (qui a déjà son propre écouteur).
$('photo-lightbox-overlay').addEventListener('click', (e) => {
  if(e.target.id === 'photo-lightbox-img' || e.target.closest('.modal-close-btn')) return;
  closePhotoLightbox();
});

$('milestone-photo-input').addEventListener('change', async () => {
  const file = $('milestone-photo-input').files[0];
  if(!file) return;
  try{
    milestonePhotoDataUrl = await compressImageFile(file, 900, 0.72);
    const preview = $('milestone-photo-preview');
    preview.src = milestonePhotoDataUrl;
    preview.classList.remove('hidden');
  }catch(e){
    showToast('Impossible de charger cette photo');
  }
});

$('profile-avatar-pick-btn').addEventListener('click', () => $('profile-avatar-input').click());
$('profile-avatar-input').addEventListener('change', async () => {
  const file = $('profile-avatar-input').files[0];
  if(!file) return;
  try{
    profileAvatarDataUrl = await compressImageFile(file, 320, 0.82);
    renderAvatarEditPreview();
  }catch(e){
    showToast('Impossible de charger cette photo');
  }
});
$('profile-avatar-remove-btn').addEventListener('click', () => {
  profileAvatarDataUrl = null;
  $('profile-avatar-input').value = '';
  renderAvatarEditPreview();
});

document.querySelectorAll('#quick-ml button').forEach(btn => {
  btn.addEventListener('click', () => {
    $('ml-input').value = btn.getAttribute('data-ml');
  });
});

$('ml-minus').addEventListener('click', () => {
  const cur = parseInt($('ml-input').value,10) || 0;
  $('ml-input').value = Math.max(0, cur - 10);
});
$('ml-plus').addEventListener('click', () => {
  const cur = parseInt($('ml-input').value,10) || 0;
  $('ml-input').value = cur + 10;
});

$('login-btn').addEventListener('click', doAuthSubmit);
$('login-password').addEventListener('keydown', (e) => { if(e.key === 'Enter') doAuthSubmit(); });
$('login-password-confirm').addEventListener('keydown', (e) => { if(e.key === 'Enter') doAuthSubmit(); });
$('auth-toggle-link').addEventListener('click', toggleAuthMode);
$('settings-logout-btn').addEventListener('click', doLogout);
$('settings-invite-reveal-btn').addEventListener('click', toggleInviteCodeReveal);
$('settings-invite-copy-btn').addEventListener('click', () => copyInviteCode());
$('settings-family-name-save-btn').addEventListener('click', saveFamilyName);
$('settings-timezone-save-btn').addEventListener('click', saveFamilyTimezone);
$('settings-family-name-input').addEventListener('keydown', (e) => { if(e.key === 'Enter') saveFamilyName(); });
$('theme-toggle-switch').addEventListener('click', toggleTheme);

$('fab-btn').addEventListener('click', () => {
  const isOpen = !$('add-modal-overlay').classList.contains('hidden');
  if(isOpen){
    cancelEdit();
    return;
  }
  if(editingId !== null){
    editingId = null;
    editingOriginalAuthor = null;
    $('form-title').textContent = "Ajout d'un biberon";
    $('save-btn').textContent = 'Enregistrer';
    $('cancel-edit-btn').classList.add('hidden');
    selectDiaper('none');
    setDateOffset(0);
    setNow();
    $('comment-input').value = '';
  }
  openAddModal();
});

$('modal-close-btn').addEventListener('click', cancelEdit);
$('add-modal-overlay').addEventListener('click', (e) => {
  if(e.target.id === 'add-modal-overlay') cancelEdit();
});

$('settings-back-btn').addEventListener('click', closeSettingsModal);
document.querySelectorAll('[data-section-toggle]').forEach(btn => {
  btn.addEventListener('click', () => toggleSettingsSection(btn));
});

$('reminder-toggle-btn').addEventListener('click', toggleReminderEnabled);
$('reminder-hours-input').addEventListener('change', saveReminderHours);
$('notif-permission-btn').addEventListener('click', enablePushNotifications);

// "Comme d'habitude" : au lieu de reprendre littéralement la toute dernière
// entrée (qui peut être une tétée de nuit atypique, ou même — bug latent
// corrigé au passage — une entrée d'un autre type que biberon puisque
// l'ancien filtre "type !== vomit" laissait passer couches/sommeil/santé),
// on reprend la valeur la plus fréquente sur les 7 derniers jours. Historique
// récent trop court (<5 tétées) -> on élargit aux 10 dernières tétées, toutes
// dates confondues, plutôt que de retomber sur une valeur unique non fiable.
function mostFrequentValue(values){
  if(!values.length) return null;
  const counts = new Map();
  for(const v of values) counts.set(v, (counts.get(v) || 0) + 1);
  let best = values[0], bestCount = 0;
  for(const [v, c] of counts){ if(c > bestCount){ best = v; bestCount = c; } }
  return best;
}

function computeUsualBottleValues(){
  const allBottles = entries.filter(e => e.type === 'biberon').sort((a, b) => b.timestamp - a.timestamp);
  if(!allBottles.length) return null;

  const sevenDaysAgo = Date.now() - 7 * 24 * 3600000;
  let pool = allBottles.filter(e => e.timestamp >= sevenDaysAgo);
  if(pool.length < 5) pool = allBottles.slice(0, 10);

  const ml = mostFrequentValue(pool.map(e => e.ml).filter(v => v != null)) ?? allBottles[0].ml;
  const diaper = mostFrequentValue(pool.map(e => e.diaper).filter(v => v != null)) ?? allBottles[0].diaper ?? 'none';
  return { ml, diaper };
}

$('same-as-last-btn').addEventListener('click', () => {
  const usual = computeUsualBottleValues();
  if(!usual){
    showToast('Aucun biberon précédent trouvé');
    return;
  }
  $('ml-input').value = usual.ml;
  selectDiaper(usual.diaper);
  showToast('Quantité habituelle reprise');
});

$('import-toggle').addEventListener('click', () => {
  $('import-box').classList.toggle('hidden');
});

$('import-btn').addEventListener('click', async () => {
  const resultEl = $('import-result');
  resultEl.textContent = '';
  let list;
  try{
    list = JSON.parse($('import-textarea').value);
    if(!Array.isArray(list)) throw new Error('not an array');
  }catch(e){
    resultEl.textContent = 'Format invalide : vérifie le JSON collé.';
    return;
  }

  const updates = {};
  let count = 0;
  list.forEach((item, i) => {
    if(!item.date || !item.time) return;
    const [y, mo, d] = item.date.split('-').map(Number);
    const [h, mi] = item.time.split(':').map(Number);
    if(!y || !mo || !d || isNaN(h) || isNaN(mi)) return;
    const entryDate = new Date(y, mo - 1, d, h, mi);
    const id = 'imp_' + Date.now() + '_' + i;
    updates[id] = {
      id: id,
      type: 'biberon',
      time: pad(h) + ':' + pad(mi),
      ml: Number(item.ml) || 0,
      diaper: item.diaper || 'none',
      timestamp: entryDate.getTime(),
      dayKey: `${y}-${pad(mo)}-${pad(d)}`
    };
    count++;
  });

  if(!count){
    resultEl.textContent = 'Aucune entrée valide trouvée.';
    return;
  }

  try{
    await childRef('entries').update(updates);
    resultEl.textContent = `${count} biberon${count > 1 ? 's' : ''} importé${count > 1 ? 's' : ''} avec succès.`;
    showToast(`${count} biberons importés`);
  }catch(e){
    resultEl.textContent = "Erreur lors de l'import.";
  }
});

selectDiaper('none');
setDateOffset(0);
setNow();
$('growth-date-input').value = dateInputVal(new Date());
resetDiaperForm();
resetHealthForm();
resetMilestoneForm();
renderReminderPrefsUI();

try{
  const visitCount = parseInt(localStorage.getItem('aylan-visit-count') || '0', 10) + 1;
  localStorage.setItem('aylan-visit-count', String(visitCount));
}catch(e){}
renderInstallUI();
$('install-app-btn').addEventListener('click', triggerInstallPrompt);

setInterval(() => {
  if(auth.currentUser){
    renderStats();
    renderAgeHero();
  }
}, 30000);

document.addEventListener('visibilitychange', () => {
  if(!document.hidden && auth.currentUser){
    renderStats();
    renderAgeHero();
  }
});

// Révélation au défilement — voir .scroll-reveal dans style.css. Les
// éléments déjà visibles à l'écran au moment d'observer (ex. les premières
// sections de Paramètres sur un grand écran) sont révélés immédiatement :
// pas de contenu qui reste invisible en attendant un scroll qui n'arrivera
// peut-être jamais (voir la même exigence pour les artefacts publiés).
function initScrollReveal(selector){
  const els = document.querySelectorAll(selector);
  if(!els.length) return;
  let reduced = false;
  try{ reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches; }catch(e){}
  if(reduced || !window.IntersectionObserver){
    els.forEach(el => el.classList.add('revealed'));
    return;
  }
  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if(entry.isIntersecting){
        entry.target.classList.add('revealed');
        observer.unobserve(entry.target);
      }
    });
  }, { threshold: 0.15, rootMargin: '0px 0px -30px 0px' });
  els.forEach(el => {
    el.classList.add('scroll-reveal');
    const rect = el.getBoundingClientRect();
    if(rect.top < window.innerHeight && rect.bottom > 0){
      el.classList.add('revealed');
    }else{
      observer.observe(el);
    }
  });
}
initScrollReveal('.settings-section');
