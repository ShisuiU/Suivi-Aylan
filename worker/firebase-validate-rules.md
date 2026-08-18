> **Mise à jour (2e round d'audit) — déjà répercutée dans `firebase-rules-complete.json`.**
> Trois changements par rapport à la version publiée précédemment :
> 1. **`authorEmail` lié à l'auteur réel de l'écriture** (`families/$familyId/children/$childId/entries/$entryId/authorEmail`) —
>    jusqu'ici n'importe quel membre de la famille pouvait écrire n'importe quelle adresse dans ce champ (attribution "qui a
>    fait quoi" falsifiable). Nouvelle règle : `newData.val() == auth.token.email || newData.val() == data.val()` — un membre
>    ne peut désormais s'attribuer que sa propre adresse à la création, et une édition ne peut que laisser inchangée
>    l'adresse déjà enregistrée (jamais l'attribuer à un tiers).
> 2. **Champs obligatoires ajoutés** sur `growth/$growthId` (`id`, `date`), `vaccines/$vaccineId` (`id`, `name`) et
>    `milestones/$milestoneId` (`id`, `label`, `date`) — jusqu'ici seul `entries/$entryId` l'imposait.
> 3. **Nouveau nœud `activeSleep`** sous `children/$childId` (verrou transactionnel démarrage/arrêt de sieste, évite que deux
>    parents créent chacun une sieste active en cliquant presque simultanément) — couvert par le `.write` déjà en place sur
>    `children`, avec juste une validation de forme (`{id, start}` ou vide).
>
> **À republier** : recopie l'intégralité de `firebase-rules-complete.json` dans la console (méthode déjà utilisée la
> dernière fois), pas seulement les extraits ci-dessous — ce document reste la référence explicative détaillée, mais
> `firebase-rules-complete.json` est la source de vérité complète à coller.

# Règles `.validate` — à ajouter aux règles Realtime Database

Complète l'audit technique (constat 🟠 "Aucune règle `.validate` côté
serveur") : les règles actuelles filtrent *qui* peut écrire (appartenance à
la famille) mais rien ne filtre *quoi* — n'importe quelle forme de donnée
peut être écrite sur un chemin autorisé. Ce document liste les
`.validate` à **ajouter** aux nœuds existants, sans toucher au reste des
règles (`.read`/`.write` déjà en place restent inchangées).

**Comment appliquer :** Console Firebase → Realtime Database → Règles.
Pour chaque chemin ci-dessous, ajoute la ligne `.validate` correspondante
au bloc JSON déjà existant pour ce nœud (à côté de `.read`/`.write`, pas à
leur place). Teste ensuite avec le simulateur de règles de la console
(bouton "Playground") avant de publier, avec quelques écritures réelles de
l'app (ajout de biberon, modification de profil) pour vérifier que rien
n'est bloqué à tort.

## `families/$familyId/meta`

```json
"name": {
  ".validate": "newData.isString() && newData.val().length <= 60"
},
"timezone": {
  ".validate": "newData.isString() && newData.val().length <= 64"
},
"features": {
  "sleep": { ".validate": "newData.isBoolean()" },
  "health": { ".validate": "newData.isBoolean()" },
  "vaccines": { ".validate": "newData.isBoolean()" }
},
"reminder": {
  "enabled": { ".validate": "newData.isBoolean()" },
  "thresholdMinutes": { ".validate": "newData.isNumber() && newData.val() > 0 && newData.val() <= 1440" }
}
```

## `families/$familyId/children/$childId/profile`

```json
".validate": "newData.hasChildren(['firstName']) || !newData.exists()",
"firstName": { ".validate": "newData.isString() && newData.val().length <= 60" },
"lastName": { ".validate": "newData.isString() && newData.val().length <= 60" },
"birthDate": { ".validate": "newData.isString() && newData.val().length <= 10" },
"gender": { ".validate": "newData.val() == 'M' || newData.val() == 'F' || newData.val() == null" },
"avatar": { ".validate": "newData.val() == null || (newData.isString() && newData.val().length <= 300000)" }
```

(300 000 caractères ≈ 220 Ko en base64 — largement au-dessus de ce que
produit `compressImageFile()` côté client à 320px/qualité 0.82, ça laisse
de la marge sans autoriser un blob arbitrairement gros.)

## `families/$familyId/children/$childId/entries/$entryId`

```json
".validate": "newData.hasChildren(['id', 'type', 'timestamp', 'dayKey'])",
"type": { ".validate": "newData.val() == 'biberon' || newData.val() == 'diaper' || newData.val() == 'sleep' || newData.val() == 'vomit' || newData.val() == 'health'" },
"ml": { ".validate": "newData.val() == null || (newData.isNumber() && newData.val() >= 0 && newData.val() <= 1000)" },
"diaper": { ".validate": "newData.val() == null || newData.val() == 'none' || newData.val() == 'pipi' || newData.val() == 'caca' || newData.val() == 'both'" },
"comment": { ".validate": "newData.val() == null || (newData.isString() && newData.val().length <= 500)" },
"timestamp": { ".validate": "newData.isNumber()" },
"dayKey": { ".validate": "newData.isString() && newData.val().matches(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/)" },
"updatedAt": { ".validate": "newData.val() == null || newData.isNumber()" },
"authorEmail": { ".validate": "newData.val() == null || (newData.isString() && newData.val().length <= 254)" }
```

## `families/$familyId/children/$childId/growth/$growthId`

```json
"date": { ".validate": "newData.isString() && newData.val().length <= 10" },
"weight": { ".validate": "newData.val() == null || (newData.isNumber() && newData.val() >= 0 && newData.val() <= 50)" },
"height": { ".validate": "newData.val() == null || (newData.isNumber() && newData.val() >= 0 && newData.val() <= 150)" },
"headCirc": { ".validate": "newData.val() == null || (newData.isNumber() && newData.val() >= 0 && newData.val() <= 70)" }
```

## `families/$familyId/children/$childId/vaccines/$vaccineId`

```json
"name": { ".validate": "newData.isString() && newData.val().length <= 120" },
"date": { ".validate": "newData.val() == null || (newData.isString() && newData.val().length <= 10)" },
"done": { ".validate": "newData.val() == null || newData.isBoolean()" }
```

## `families/$familyId/children/$childId/milestones/$milestoneId`

```json
"label": { ".validate": "newData.val() == null || (newData.isString() && newData.val().length <= 120)" },
"date": { ".validate": "newData.val() == null || (newData.isString() && newData.val().length <= 10)" },
"photo": { ".validate": "newData.val() == null || (newData.isString() && newData.val().length <= 500000)" }
```

(500 000 caractères ≈ 365 Ko en base64 — au-dessus de ce que produit
`compressImageFile()` à 900px/qualité 0.72, avec marge.)

## `families/$familyId/pushTokens/$uid`

```json
".validate": "newData.val() == null || (newData.isString() && newData.val().length <= 500)"
```

## Ce qui n'est volontairement PAS ajouté ici

- `inviteCode`, `createdBy`, `createdAt`, `members` : écrits une seule fois
  à la création par du code déjà maîtrisé (pas de surface exposée côté
  UI qui laisserait un membre les modifier librement) — pas prioritaire.
- Les chemins "legacy" pré-migration (`families/$familyId/entries`,
  `/profile`, `/growth` directement sous la famille) : en attente de la
  purge (constat séparé de l'audit, une fois confirmé qu'aucune famille
  n'en dépend plus) — pas la peine de les valider pour les supprimer
  juste après.

## Vérification avant publication

Dans le simulateur de règles (Console Firebase → Règles → Playground),
teste au minimum :
- Écriture d'un biberon valide sur `entries/$id` → doit passer.
- Écriture d'un `ml` à `5000` → doit être refusée.
- Écriture d'un `dayKey` mal formé (`"hier"`) → doit être refusée.
- Écriture normale du profil (prénom, nom, date de naissance) → doit
  passer.
