# Tests — Suivi Aylan

Un seul script de fumée (`smoke.js`), pas de framework de test — cohérent avec
le reste du projet (voir `CLAUDE.md` §1) : trois fichiers vanilla, aucune
étape de build. Playwright est le seul outil utilisé, chargé en `file://`
exactement comme l'app elle-même s'ouvre en local, avec `window.firebase`
remplacé par un stub avant navigation (aucun projet Firebase réel requis pour
lancer ce test).

## Lancer le test

```sh
npm i -D playwright   # si Playwright n'est pas déjà disponible
node tests/smoke.js
```

## Ce qui est couvert

- Chargement de l'app sans erreur console.
- Ajout, édition et suppression (double confirmation) d'un biberon.
- Activation d'un paramètre familial partagé.
- Deux régressions de fiabilité trouvées lors de l'audit technique d'août
  2026 (voir le rapport d'audit) :
  - Une écriture qui échoue ne doit **jamais** afficher un toast de succès
    ni fermer la modale comme si tout s'était bien passé.
  - Une modification concurrente (un autre appareil a changé l'entrée entre
    temps) doit être signalée à l'utilisateur avant d'écraser, pas écrasée
    en silence.

## Étendre ce test

Avant d'ajouter un nouveau parcours critique (ex. croissance, vaccins,
souvenirs, changement d'enfant), regarder si le stub `window.firebase`
existant dans `newPage()` couvre déjà les méthodes nécessaires
(`on`/`once`/`set`/`update`/`push`/`remove`/`off`) — c'est généralement le
cas, il suffit d'enrichir `baseStore()` avec les données de départ voulues.
