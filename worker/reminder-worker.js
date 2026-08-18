/**
 * Suivi Aylan — Worker Cloudflare : rappel de biberon en push réel.
 *
 * Déclenché par un Cron Trigger (voir wrangler.toml). Pour chaque famille où
 * le rappel est activé (families/{id}/meta/reminder.enabled) : cherche le
 * dernier biberon (tous enfants confondus — voir limitation ci-dessous),
 * compare au seuil réglé, et envoie un push FCM à chaque appareil enregistré
 * si le seuil est dépassé et qu'on n'a pas déjà notifié pour ce biberon.
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
  const summary = { checked: 0, notified: 0, errors: [] };

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
      const notified = await processFamily(familyId, { databaseURL, accessToken, projectId, now });
      if (notified) summary.notified++;
    } catch (err) {
      console.error(`Erreur famille ${familyId} :`, err);
      summary.errors.push({ familyId, message: String(err && err.message || err) });
    }
  }

  return summary;
}

async function processFamily(familyId, ctx) {
  const { databaseURL, accessToken } = ctx;

  // Réglage + jetons d'abord (petit volume) — on ne lit les entrées (gros
  // volume potentiel) que si la famille a réellement un rappel actif ET au
  // moins un appareil enregistré, pour ne pas payer le coût d'une lecture
  // complète de l'historique à chaque passage pour toutes les familles.
  const [meta, pushTokens] = await Promise.all([
    rtdbGet(databaseURL, `families/${familyId}/meta`, accessToken),
    rtdbGet(databaseURL, `families/${familyId}/pushTokens`, accessToken),
  ]);

  const reminder = meta && meta.reminder;
  if (!reminder || !reminder.enabled) return false;

  const tokenEntries = Object.entries(pushTokens || {});
  if (!tokenEntries.length) return false;

  const thresholdMinutes = reminder.thresholdMinutes > 0 ? reminder.thresholdMinutes : 210;

  const children = await rtdbGet(databaseURL, `families/${familyId}/children`, accessToken);
  if (!children) return false;

  // Dernier biberon tous enfants confondus, par timestamp réel de l'événement
  // (pas par date de création de l'entrée — une entrée peut être datée
  // rétroactivement) : même logique que renderStats() côté client.
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
  if (lastBottleTimestamp === null) return false;

  const minutesSince = (ctx.now - lastBottleTimestamp) / 60000;
  if (minutesSince < thresholdMinutes) return false;

  // Anti-doublon : ne renotifie pas en boucle toutes les 15 min pour le même
  // biberon en retard — seulement quand un NOUVEAU biberon en retard apparaît.
  if (reminder.lastNotifiedBottleTimestamp === lastBottleTimestamp) return false;

  const hoursTxt = (thresholdMinutes / 60).toFixed(1).replace('.0', '').replace('.', ',');
  const notification = {
    title: `${childFirstName || 'Bébé'} a peut-être faim`,
    body: `Ça fait plus de ${hoursTxt} h depuis le dernier biberon.`,
  };

  const staleTokenIds = [];
  for (const [tokenId, entry] of tokenEntries) {
    if (!entry || !entry.token) continue;
    const result = await sendFCM(ctx.projectId, ctx.accessToken, entry.token, notification);
    if (!result.ok) {
      const status = result.data && result.data.error && result.data.error.status;
      if (status === 'UNREGISTERED' || status === 'NOT_FOUND' || status === 'INVALID_ARGUMENT') {
        // Jeton mort (app désinstallée, permission révoquée...) — on le
        // retire pour ne pas continuer à payer une tentative d'envoi dessus.
        staleTokenIds.push(tokenId);
      } else {
        console.error(`Échec envoi push famille ${familyId}, jeton ${tokenId} :`, result.status, result.data);
      }
    }
  }

  await rtdbPut(databaseURL, `families/${familyId}/meta/reminder/lastNotifiedBottleTimestamp`, accessToken, lastBottleTimestamp);
  for (const tokenId of staleTokenIds) {
    await rtdbPut(databaseURL, `families/${familyId}/pushTokens/${tokenId}`, accessToken, null);
  }

  return true;
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
