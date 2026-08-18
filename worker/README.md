# Worker de rappel — déploiement

Ce Worker Cloudflare envoie un vrai push (même app fermée) quand le dernier
biberon dépasse le seuil réglé dans Paramètres > Rappel de biberon. Il tourne
indépendamment du reste de l'app (pas de lien avec le déploiement Vercel).

Pas besoin d'installer quoi que ce soit en local — tout se fait depuis le
tableau de bord Cloudflare, dans le navigateur.

## 1. Récupérer la clé de compte de service Firebase

Console Firebase → ⚙️ **Paramètres du projet** → onglet **Comptes de
service** → **Générer une nouvelle clé privée**. Un fichier `.json` se
télécharge — **garde-le en sécurité, ne le colle jamais dans un chat ou un
commit**, il donne un accès administrateur complet au projet Firebase.

## 2. Créer le Worker

1. [dash.cloudflare.com](https://dash.cloudflare.com) → **Workers & Pages** →
   **Create** → **Create Worker**.
2. Donne-lui un nom (ex. `suivi-aylan-reminder`) → **Deploy** (le code
   par défaut "Hello World" sera remplacé à l'étape suivante).
3. **Edit code** → remplace tout le contenu par celui de
   [`reminder-worker.js`](./reminder-worker.js) de ce dossier → **Deploy**.

## 3. Configurer les secrets

Sur la page du Worker → **Settings** → **Variables and Secrets** → **Add** :

| Nom | Type | Valeur |
|---|---|---|
| `FIREBASE_SERVICE_ACCOUNT` | Secret | Colle le contenu **complet** du fichier `.json` téléchargé à l'étape 1 |
| `FIREBASE_DATABASE_URL` | Secret (ou texte) | `https://suivi-aylan-default-rtdb.europe-west1.firebasedatabase.app` |
| `MANUAL_TRIGGER_KEY` | Secret | Une chaîne inventée par toi (ex. un mot de passe long) — sert uniquement à te permettre de déclencher un test manuel |

## 4. Planifier l'exécution

Toujours sur la page du Worker → **Settings** → **Triggers** → **Cron
Triggers** → **Add Cron Trigger** → colle `*/15 * * * *` (toutes les 15
minutes) → **Add**.

## 5. Tester

Une fois activé le rappel dans l'app (Paramètres > Rappel de biberon) et les
notifications autorisées sur au moins un appareil, ouvre dans un navigateur :

```
https://suivi-aylan-reminder.<ton-sous-domaine>.workers.dev/?key=LA_VALEUR_DE_MANUAL_TRIGGER_KEY
```

(l'URL exacte est affichée en haut de la page du Worker dans le dashboard).
Ça déclenche un passage immédiat et renvoie un résumé JSON — pratique pour
vérifier sans attendre le prochain créneau planifié. Consulte aussi
**Logs** (onglet du Worker) pour voir les exécutions passer.

## Notes

- Le Worker bypasse les règles de sécurité Firebase (accès admin via le
  compte de service) — c'est normal et attendu, comme n'importe quel accès
  serveur légitime.
- Le format de la clé VAPID et du jeton FCM correspond à celui déjà utilisé
  côté client (`script.js`) — rien à modifier là-dessus si tu changes la
  clé un jour, tant que client et Worker utilisent le même projet Firebase.
- Coût réel attendu : 0 €/mois pour ce volume d'usage (bien en dessous des
  quotas gratuits Cloudflare et Firebase — pas de plan Blaze nécessaire).
