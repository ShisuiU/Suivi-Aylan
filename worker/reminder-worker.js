/**
 * Suivi Aylan — Worker Cloudflare : rappels en push réel.
 *
 * Déclenché par un Cron Trigger (voir wrangler.toml). Deux rappels
 * indépendants, chacun avec sa propre condition de déclenchement :
 *
 * 1. Rappel de biberon (families/{id}/meta/reminder.enabled) : cherche le
 *    dernier biberon (tous enfants confondus — voir limitation ci-dessous),
 *    compare au seuil réglé, envoie un push si dépassé et pas déjà notifié.
 * 2. Rappel de vaccin à venir : pas de réglage dédié, se déclenche
 *    automatiquement pour toute famille ayant au moins un appareil avec
 *    notifications activées, dès qu'un vaccin (tous enfants confondus) a une
 *    date à moins de 3 jours et n'a pas déjà été notifié.
 *
 * Aucune dépendance npm : tout est écrit avec les APIs natives du runtime
 * Workers (fetch, Web Crypto) pour rester déployable tel quel sans étape de
 * build, dans le même esprit que le reste du projet (voir CLAUDE.md).
 *
 * Limitation connue (héritée du comportement client existant) : pour une
 * famille à plusieurs enfants, le rappel porte sur le biberon le plus récent
 * TOUS enfants confondus, pas par enfant — cohérent avec le fait qu'il n'y a
 * qu'un seul réglage de rappel par famille, pas par enfant.
 *
 * Secrets attendus (Cloudflare > Settings > Variables) :
 *   FIREBASE_SERVICE_ACCOUNT  — JSON complet du compte de service (secret)
 *   FIREBASE_DATABASE_URL     — ex. https://suivi-aylan-default-rtdb.europe-west1.firebasedatabase.app
 *   MANUAL_TRIGGER_KEY        — clé arbitraire pour déclencher un run manuel via GET ?key=... (secret)
 */

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      runReminders(env).catch((err) => {
        console.error('Échec du passage planifié :', err && err.message || err, err && err.stack);
      })
    );
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    // Deux causes distinctes derrière un "Unauthorized" générique : le
    // secret n'est pas configuré sur ce Worker, ou la clé fournie ne
    // correspond pas — on les distingue explicitement pour ne pas laisser
    // une simple faute de frappe ressembler à un problème de déploiement.
    // Ne révèle jamais la valeur du secret, seulement s'il est défini.
    if (!env.MANUAL_TRIGGER_KEY) {
      return new Response(
        "Unauthorized — le secret MANUAL_TRIGGER_KEY n'est pas configuré sur ce Worker (Settings > Variables and Secrets).",
        { status: 401 }
      );
    }
    if (url.searchParams.get('key') !== env.MANUAL_TRIGGER_KEY) {
      return new Response(
        "Unauthorized — la clé fournie dans ?key=... ne correspond pas à la valeur du secret MANUAL_TRIGGER_KEY enregistré.",
        { status: 401 }
      );
    }
    // Capture toute exception ici plutôt que de la laisser remonter telle
    // quelle : Cloudflare masque alors le vrai message derrière une page
    // générique "Error 1101 - Worker threw exception", inutilisable pour
    // diagnostiquer (JSON du compte de service mal collé, clé privée
    // invalide, FIREBASE_DATABASE_URL absente...).
    try {
      const summary = await runReminders(env);
      return new Response(JSON.stringify(summary, null, 2), {
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (err) {
      return new Response(
        JSON.stringify({ error: String(err && err.message || err), stack: err && err.stack }, null, 2),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }
  },
};

async function runReminders(env) {
  if (!env.FIREBASE_SERVICE_ACCOUNT) throw new Error("Le secret FIREBASE_SERVICE_ACCOUNT n'est pas configuré.");
  if (!env.FIREBASE_DATABASE_URL) throw new Error("Le secret FIREBASE_DATABASE_URL n'est pas configuré.");

  let serviceAccount;
  try {
    serviceAccount = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT);
  } catch (e) {
    throw new Error("FIREBASE_SERVICE_ACCOUNT n'est pas un JSON valide — vérifie que tout le fichier .json a été collé sans modification (guillemets, retours à la ligne compris).");
  }
  if (!serviceAccount.private_key || !serviceAccount.client_email || !serviceAccount.project_id) {
    throw new Error("FIREBASE_SERVICE_ACCOUNT est un JSON valide mais il manque private_key, client_email ou project_id — vérifie que c'est bien le fichier téléchargé depuis Firebase (Comptes de service > Générer une nouvelle clé privée), pas un autre JSON.");
  }

  const databaseURL = env.FIREBASE_DATABASE_URL.replace(/\/$/, '');
  const projectId = serviceAccount.project_id;
  const now = Date.now();
  const summary = { checked: 0, notified: 0, errors: [], details: [] };

  const accessToken = await getGoogleAccessToken(serviceAccount, [
    // userinfo.email est exigé par la Realtime Database REST API en plus de
    // firebase.database (documenté par Firebase, facile à manquer) — sans
    // lui, chaque requête RTDB échoue en 401 "Unauthorized request." malgré
    // un jeton par ailleurs valide.
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/firebase.database',
    'https://www.googleapis.com/auth/firebase.messaging',
  ]);

  // Lecture peu coûteuse : juste les IDs de famille (shallow=true ne
  // renvoie pas le contenu, seulement true/false par clé).
  const familyIds = await rtdbGet(databaseURL, 'families', accessToken, { shallow: true });
  if (!familyIds) return summary;

  for (const familyId of Object.keys(familyIds)) {
    summary.checked++;
    try {
      const result = await processFamily(familyId, { databaseURL, accessToken, projectId, now });
      if (result.bottleSent || result.vaccinesSent > 0) summary.notified++;
      summary.details.push({ familyId, ...result });
    } catch (err) {
      console.error(`Erreur famille ${familyId} :`, err);
      summary.errors.push({ familyId, message: String(err && err.message || err) });
    }
  }

  return summary;
}

// Retourne toujours un état détaillé (pas juste vrai/faux) : sert de
// diagnostic direct via le déclenchement manuel (?key=...) quand quelque
// chose ne se passe pas comme attendu côté app — sans ça, la seule façon de
// savoir où ça bloque (rappel désactivé ? aucun jeton enregistré ? pas
// encore en retard ? déjà notifié ?) serait d'inspecter la base à la main.
async function processFamily(familyId, ctx) {
  const { databaseURL, accessToken } = ctx;

  const [meta, pushTokens] = await Promise.all([
    rtdbGet(databaseURL, `families/${familyId}/meta`, accessToken),
    rtdbGet(databaseURL, `families/${familyId}/pushTokens`, accessToken),
  ]);

  const reminder = (meta && meta.reminder) || {};
  const tokenEntries = Object.entries(pushTokens || {});
  const thresholdMinutes = reminder.thresholdMinutes > 0 ? reminder.thresholdMinutes : 210;

  const state = {
    reminderEnabled: !!reminder.enabled,
    tokenCount: tokenEntries.length,
    thresholdMinutes,
    lastBottleTimestamp: null,
    minutesSinceLastBottle: null,
    overdue: false,
    alreadyNotifiedForThisBottle: false,
    bottleSent: false,
    vaccinesSent: 0,
    reason: null, // pourquoi le rappel de biberon n'a rien envoyé, si c'est le cas
  };

  if (!state.tokenCount) { state.reason = "aucun appareil n'a activé les notifications pour cette famille"; return state; }

  const children = await rtdbGet(databaseURL, `families/${familyId}/children`, accessToken);
  if (!children) { state.reason = 'aucun enfant trouvé'; return state; }

  // --- Rappel de biberon (réglage families/{id}/meta/reminder.enabled) ---
  if (state.reminderEnabled) {
    await checkBottleReminder(familyId, children, reminder, thresholdMinutes, tokenEntries, ctx, state);
  } else {
    state.reason = 'rappel de biberon désactivé pour cette famille';
  }

  // --- Rappel de vaccin à venir (indépendant du réglage ci-dessus) ---
  state.vaccinesSent = await checkVaccineReminders(familyId, children, tokenEntries, ctx);

  return state;
}

// Dernier biberon tous enfants confondus, par timestamp réel de l'événement
// (pas par date de création de l'entrée — une entrée peut être datée
// rétroactivement) : même logique que renderStats() côté client. Mute
// `state` directement plutôt que de retourner un nouvel objet — appelé une
// seule fois par famille, pas de risque de partage d'état entre appels.
async function checkBottleReminder(familyId, children, reminder, thresholdMinutes, tokenEntries, ctx, state) {
  const { databaseURL, accessToken } = ctx;

  let lastBottleTimestamp = null;
  let childFirstName = '';
  for (const child of Object.values(children)) {
    const entries = (child && child.entries) || {};
    for (const entry of Object.values(entries)) {
      if (entry && entry.type === 'biberon' && typeof entry.timestamp === 'number') {
        if (lastBottleTimestamp === null || entry.timestamp > lastBottleTimestamp) {
          lastBottleTimestamp = entry.timestamp;
          childFirstName = (child.profile && child.profile.firstName) || '';
        }
      }
    }
  }
  state.lastBottleTimestamp = lastBottleTimestamp;
  if (lastBottleTimestamp === null) { state.reason = 'aucun biberon enregistré'; return; }

  const minutesSince = (ctx.now - lastBottleTimestamp) / 60000;
  state.minutesSinceLastBottle = Math.round(minutesSince);
  state.overdue = minutesSince >= thresholdMinutes;
  if (!state.overdue) { state.reason = `pas encore en retard (${Math.round(minutesSince)} min sur ${thresholdMinutes} requises)`; return; }

  // Anti-doublon : ne renotifie pas en boucle toutes les 15 min pour le même
  // biberon en retard — seulement quand un NOUVEAU biberon en retard apparaît.
  state.alreadyNotifiedForThisBottle = reminder.lastNotifiedBottleTimestamp === lastBottleTimestamp;
  if (state.alreadyNotifiedForThisBottle) { state.reason = 'déjà notifié pour ce biberon (anti-doublon)'; return; }

  const hoursTxt = (thresholdMinutes / 60).toFixed(1).replace('.0', '').replace('.', ',');
  const notification = {
    title: `${childFirstName || 'Bébé'} a peut-être faim`,
    body: `Ça fait plus de ${hoursTxt} h depuis le dernier biberon.`,
  };

  const staleTokenIds = [];
  let sentCount = 0;
  for (const [tokenId, entry] of tokenEntries) {
    if (!entry || !entry.token) continue;
    const result = await sendFCM(ctx.projectId, ctx.accessToken, entry.token, notification);
    if (result.ok) {
      sentCount++;
    } else {
      const status = result.data && result.data.error && result.data.error.status;
      if (status === 'UNREGISTERED' || status === 'NOT_FOUND' || status === 'INVALID_ARGUMENT') {
        // Jeton mort (app désinstallée, permission révoquée...) — on le
        // retire pour ne pas continuer à payer une tentative d'envoi dessus.
        staleTokenIds.push(tokenId);
      } else {
        console.error(`Échec envoi push biberon famille ${familyId}, jeton ${tokenId} :`, result.status, result.data);
      }
    }
  }

  await rtdbPut(databaseURL, `families/${familyId}/meta/reminder/lastNotifiedBottleTimestamp`, accessToken, lastBottleTimestamp);
  await removeStaleTokens(familyId, staleTokenIds, ctx);

  state.bottleSent = sentCount > 0;
  state.sentCount = sentCount;
  state.staleTokensRemoved = staleTokenIds.length;
  if (!state.bottleSent) state.reason = `envoi tenté sur ${tokenEntries.length} jeton(s) mais aucun n'a réussi`;
}

// Rappel de vaccin à venir : parcourt les vaccins de tous les enfants,
// notifie une seule fois par vaccin (jamais en boucle) dès que sa date est à
// moins de 3 jours. Fenêtre volontairement large plutôt que "exactement la
// veille" pour rester robuste à la granularité de 15 min du Cron Trigger —
// le pire cas est une notification 1-2 jours plus tôt que prévu, jamais un
// vaccin manqué silencieusement.
const VACCINE_REMINDER_WINDOW_MS = 3 * 24 * 3600000;

async function checkVaccineReminders(familyId, children, tokenEntries, ctx) {
  const { databaseURL, accessToken } = ctx;
  const notifiedPath = `families/${familyId}/meta/vaccineReminders/notifiedIds`;
  const notifiedIds = (await rtdbGet(databaseURL, notifiedPath, accessToken)) || {};

  const staleTokenIds = new Set();
  const newlyNotified = {};
  let sentCount = 0;

  for (const child of Object.values(children)) {
    const vaccines = (child && child.vaccines) || {};
    const childName = (child.profile && child.profile.firstName) || 'Bébé';
    for (const [vaccineId, vaccine] of Object.entries(vaccines)) {
      if (!vaccine || !vaccine.date || notifiedIds[vaccineId]) continue;
      const vaccineTs = Date.parse(vaccine.date + 'T00:00:00');
      if (Number.isNaN(vaccineTs)) continue;
      const msUntil = vaccineTs - ctx.now;
      if (msUntil < 0 || msUntil > VACCINE_REMINDER_WINDOW_MS) continue;

      const daysTxt = msUntil < 24 * 3600000 ? "aujourd'hui" : `dans ${Math.ceil(msUntil / (24 * 3600000))} jours`;
      const notification = {
        title: `Vaccin de ${childName} à venir`,
        body: `${vaccine.name || 'Vaccin'} prévu ${daysTxt}.`,
      };

      let anySent = false;
      for (const [tokenId, entry] of tokenEntries) {
        if (!entry || !entry.token) continue;
        const result = await sendFCM(ctx.projectId, ctx.accessToken, entry.token, notification);
        if (result.ok) {
          anySent = true;
        } else {
          const status = result.data && result.data.error && result.data.error.status;
          if (status === 'UNREGISTERED' || status === 'NOT_FOUND' || status === 'INVALID_ARGUMENT') staleTokenIds.add(tokenId);
          else console.error(`Échec envoi push vaccin famille ${familyId}, jeton ${tokenId} :`, result.status, result.data);
        }
      }

      if (anySent) {
        sentCount++;
        newlyNotified[vaccineId] = true;
      }
    }
  }

  if (Object.keys(newlyNotified).length) {
    await rtdbPut(databaseURL, notifiedPath, accessToken, { ...notifiedIds, ...newlyNotified });
  }
  await removeStaleTokens(familyId, [...staleTokenIds], ctx);

  return sentCount;
}

async function removeStaleTokens(familyId, staleTokenIds, ctx) {
  for (const tokenId of staleTokenIds) {
    await rtdbPut(ctx.databaseURL, `families/${familyId}/pushTokens/${tokenId}`, ctx.accessToken, null);
  }
}

// ---------------------------------------------------------------------------
// Realtime Database (REST)
// ---------------------------------------------------------------------------

async function rtdbGet(databaseURL, path, accessToken, opts) {
  const params = new URLSearchParams();
  if (opts && opts.shallow) params.set('shallow', 'true');
  const qs = params.toString() ? `?${params.toString()}` : '';
  const resp = await fetch(`${databaseURL}/${path}.json${qs}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!resp.ok) throw new Error(`RTDB GET ${path} a échoué (${resp.status}) : ${await resp.text()}`);
  return resp.json();
}

async function rtdbPut(databaseURL, path, accessToken, value) {
  const resp = await fetch(`${databaseURL}/${path}.json`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(value),
  });
  if (!resp.ok) throw new Error(`RTDB PUT ${path} a échoué (${resp.status}) : ${await resp.text()}`);
  return resp.json();
}

// ---------------------------------------------------------------------------
// Firebase Cloud Messaging (HTTP v1)
// ---------------------------------------------------------------------------

async function sendFCM(projectId, accessToken, token, notification) {
  const resp = await fetch(`https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: {
        token,
        notification,
        webpush: {
          fcm_options: { link: 'https://suivi-bebe-nu.vercel.app/' },
        },
      },
    }),
  });
  let data = null;
  try { data = await resp.json(); } catch (e) { /* réponse vide */ }
  return { ok: resp.ok, status: resp.status, data };
}

// ---------------------------------------------------------------------------
// Authentification Google (JWT signé avec la clé privée du compte de
// service, échangé contre un jeton d'accès OAuth2) — implémenté avec Web
// Crypto (disponible nativement dans le runtime Workers), sans dépendance.
// ---------------------------------------------------------------------------

async function getGoogleAccessToken(serviceAccount, scopes) {
  const header = { alg: 'RS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const claimSet = {
    iss: serviceAccount.client_email,
    scope: scopes.join(' '),
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now,
  };

  const encoder = new TextEncoder();
  const base64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const base64urlJSON = (obj) => base64url(encoder.encode(JSON.stringify(obj)));

  const signingInput = `${base64urlJSON(header)}.${base64urlJSON(claimSet)}`;

  const pem = serviceAccount.private_key
    .replace('-----BEGIN PRIVATE KEY-----', '')
    .replace('-----END PRIVATE KEY-----', '')
    .replace(/\s/g, '');
  const derBytes = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));

  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8',
    derBytes.buffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    cryptoKey,
    encoder.encode(signingInput)
  );

  const jwt = `${signingInput}.${base64url(signature)}`;

  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(`Échec d'obtention du jeton Google : ${JSON.stringify(data)}`);
  return data.access_token;
}
