# Ajouter un biberon depuis l'app Raccourcis (iPhone)

Le Worker expose une route `POST /biberon` qui écrit directement une entrée
en base. Un raccourci iPhone de quatre actions suffit donc pour enregistrer un
biberon **sans ouvrir l'app** — y compris à la voix, en bloquant l'écran, ou
depuis un bouton sur l'écran d'accueil. L'entrée apparaît en temps réel sur
les téléphones de la famille, exactement comme si elle avait été saisie à la
main.

Prérequis : le Worker est déjà déployé et configuré (voir [`README.md`](./README.md)).

---

## 1. Créer la clé d'accès

Sur la page du Worker → **Settings** → **Variables and Secrets** → **Add** :

| Nom | Type | Valeur |
|---|---|---|
| `ENTRY_API_KEY` | Secret | une longue chaîne aléatoire inventée par toi |
| `ENTRY_API_AUTHOR_EMAIL` | Secret (ou texte) | ton adresse e-mail de connexion à l'app |

Tant que `ENTRY_API_KEY` n'existe pas, la route répond `501` et n'écrit rien :
le Worker déjà déployé ne change pas de comportement tant que tu n'as pas
fait cette étape.

**Pourquoi une clé séparée de `MANUAL_TRIGGER_KEY` ?** Celle-ci va vivre en
clair dans un raccourci sur un téléphone, que n'importe qui ayant le téléphone
en main peut ouvrir et lire. Il faut pouvoir la changer seule, sans casser le
déclenchement manuel des rappels — et elle n'autorise rien d'autre que
l'ajout d'un biberon.

`ENTRY_API_AUTHOR_EMAIL` sert uniquement à l'affichage : c'est l'auteur
attribué à l'entrée, donc la pastille d'initiales dans la liste du jour. Si tu
l'omets, l'entrée n'a simplement pas d'auteur.

Pense à **redéployer** le Worker après avoir ajouté les secrets.

---

## 2. Vérifier que la route répond

Depuis un terminal (ou n'importe quel client HTTP) :

```sh
curl -X POST "https://suivi-aylan-reminder.<ton-sous-domaine>.workers.dev/biberon?key=TA_CLE&ml=150"
```

Réponse attendue :

```json
{
  "ok": true,
  "message": "Biberon de 150 ml enregistré pour Aylan à 14:32.",
  "entry": { "...": "..." },
  "family": "...", "child": "...", "prenom": "Aylan",
  "timezone": "Europe/Paris"
}
```

Vérifie dans l'app que le biberon est bien apparu, puis supprime-le.

Si quelque chose cloche, la réponse explique quoi (clé invalide, volume hors
bornes, enfant introuvable...) — il n'y a pas d'erreur muette.

---

## 3. Construire le raccourci

App **Raccourcis** → **+** → ajoute ces actions dans l'ordre :

1. **Demander une entrée**
   - Type : `Nombre`
   - Question : `Combien de ml ?`

2. **Obtenir le contenu de l'URL**
   - URL : `https://suivi-aylan-reminder.<ton-sous-domaine>.workers.dev/biberon`
   - Déplie **Afficher plus** :
     - Méthode : `POST`
     - Corps de la requête : `JSON`
     - Ajoute deux champs :

       | Clé | Type | Valeur |
       |---|---|---|
       | `key` | Texte | ta valeur de `ENTRY_API_KEY` |
       | `ml` | Nombre | la variable **Entrée fournie** de l'étape 1 |

3. **Obtenir la valeur du dictionnaire**
   - Clé : `message`
   - Dans : **Contenu de l'URL**

4. **Afficher une notification**
   - Corps : la variable **Valeur du dictionnaire**

Nomme-le « Ajouter un biberon », donne-lui une icône, puis :

- **Ajouter à l'écran d'accueil** pour un bouton d'une seule tape ;
- ou dis simplement « Dis Siri, ajouter un biberon » — le nom du raccourci
  est la phrase de déclenchement.

### Variante sans question (volume fixe)

Supprime l'action 1 et mets directement `180` dans le champ `ml`. Le raccourci
devient instantané : une tape, rien à saisir. Pratique pour un volume
habituel, avec la version « qui demande » gardée à côté pour les exceptions.

### Afficher aussi les erreurs

En cas de refus, la réponse contient `error` et non `message`, donc la
notification serait vide. Pour couvrir le cas, insère entre les actions 3 et
4 :

- **Si** `Valeur du dictionnaire` **n'a pas de valeur**
  - **Obtenir la valeur du dictionnaire** pour la clé `error`, dans
    **Contenu de l'URL**
- **Fin de Si**

et laisse l'action 4 afficher le résultat du **Si**.

---

## 4. Paramètres acceptés par la route

Tous passent indifféremment en paramètre d'URL ou dans le corps JSON (le
corps l'emporte en cas de doublon).

| Paramètre | Obligatoire | Détail |
|---|---|---|
| `key` | oui | doit valoir `ENTRY_API_KEY` |
| `ml` | oui | entier de 0 à 1000 (même borne que l'app) |
| `diaper` | non | `none` (défaut), `pipi`, `caca`, `both`, `skip` |
| `comment` | non | 500 caractères maximum |
| `at` | non | horodatage ISO 8601 ou millisecondes ; par défaut maintenant. Une heure future est refusée, comme dans l'app |
| `family` | non | exigé seulement si la base contient plusieurs familles |
| `child` | non | prénom (`Aylan`) ou identifiant interne. Par défaut : le premier enfant, au sens du classement de l'app |
| `force` | non | `1` pour désactiver l'anti-doublon |

**Anti-doublon.** Un raccourci vocal part facilement deux fois (double appui,
Siri qui redemande). Deux biberons du même volume à moins d'une minute
d'intervalle sont donc traités comme un seul : la route renvoie
`"doublon_ignore": true` avec l'entrée déjà écrite, et n'ajoute rien.

**Plusieurs enfants.** Sans paramètre `child`, c'est le premier enfant au sens
de l'app qui est pris. Le prénom retenu figure dans `message` et dans
`prenom` : si la notification du raccourci nomme le mauvais enfant, ça se voit
à la première utilisation. Ajoute alors `child` dans le corps JSON.

---

## 5. Points d'attention

- **Le Worker écrit avec le compte de service, qui contourne les règles de
  sécurité Firebase.** Toute la validation (bornes, valeurs autorisées, refus
  d'une heure future) est donc refaite dans le Worker, et couverte par
  [`tests/bottle-route.mjs`](./tests/bottle-route.mjs). Si tu modifies la
  route, fais tourner ce test : `node worker/tests/bottle-route.mjs`.
- **Qui a la clé peut ajouter des biberons** à ta famille. Rien d'autre : pas
  de lecture, pas de suppression, pas d'accès aux autres données. Pour la
  révoquer, change la valeur de `ENTRY_API_KEY` et redéploie — les anciens
  raccourcis cessent de fonctionner immédiatement.
- **Fuseau horaire.** La date et l'heure de l'entrée sont calculées dans le
  fuseau réglé dans Paramètres > Fuseau horaire de la famille, pas en UTC :
  sans ça, un biberon de minuit et demi tomberait le mauvais jour. Si la
  famille n'a pas encore réglé de fuseau, le Worker utilise `Europe/Paris` et
  le signale dans le champ `timezone` de sa réponse.
- **Pas de fichier `.shortcut` fourni.** Un raccourci exporté est un format
  binaire signé par Apple, que je ne peux ni produire ni vérifier d'ici. Mieux
  vaut quatre actions construites à la main et comprises qu'un fichier opaque
  qui écrit dans le suivi d'un bébé.
