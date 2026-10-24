# Widget Grist « Formulaires SurveyJS »

Widget personnalisé Grist qui affiche un formulaire [SurveyJS](https://surveyjs.io/) à partir d'un JSON et enregistre les réponses dans Grist, y compris les données imbriquées (matrices et panneaux dynamiques) dans des tables liées, et les pièces jointes dans de vraies colonnes « Pièces jointes ».

## Fichiers

| Fichier | Rôle |
|---|---|
| `index.html` | Page du widget (styles, chargement de SurveyJS 3.2.2 depuis jsDelivr) |
| `core.js` | Logique pure : analyse du JSON, mappage, conversions de valeurs |
| `app.js` | Interface de configuration, rendu du formulaire, accès à l'API Grist |
| `exemple-formulaire.json` | Formulaire d'exemple à 3 niveaux (projet → partenaires → actions) |

## Installation

1. Hébergez les 4 fichiers dans un même dossier en HTTPS (GitHub Pages convient : dépôt public, *Settings → Pages → Deploy from branch*).
2. Dans Grist : **Ajouter une page/un widget → Personnalisé → URL personnalisée** → `https://<utilisateur>.github.io/<dépôt>/index.html`.
3. Choisissez la table de données du widget et accordez l'**accès complet** (nécessaire pour créer des colonnes/tables et lire les tables liées).
4. Dans le panneau de création du widget, cliquez sur **Ouvrir la configuration**.

## Configuration (4 onglets)

1. **Formulaire** : collez le JSON SurveyJS (généré par [SurveyJS Creator](https://surveyjs.io/create-free-survey) ou écrit à la main). Il est validé en direct puis analysé.
2. **Mappage des données** :
   - chaque champ est relié à une colonne de la table (proposition automatique par nom/libellé, avec contrôle de compatibilité des types) ;
   - les colonnes manquantes se créent en un clic avec le bon type (Texte, Numérique, Date, Choix, Liste de choix, Booléen, Pièces jointes…) et les choix du formulaire comme valeurs de la colonne ;
   - les questions imbriquées (matrice dynamique, panneau dynamique, matrice à lignes fixes) sont envoyées dans des **tables liées** : table existante ou nouvelle, colonne de liaison (Réf.) vers le parent, créée si besoin. Les niveaux multiples sont gérés (ex. panneau → matrice).
3. **Apparence** : thème parmi les 32 thèmes officiels SurveyJS, ou thème personnalisé exporté du Creator, options du modèle SurveyJS en JSON (`locale`, `showProgressBar`, `completeText`…), CSS libre, aperçu en direct. À l'envoi de l'aperçu, rien n'est écrit : une simulation des enregistrements est affichée.
4. **Comportement** : créer une nouvelle ligne à chaque envoi, ou modifier la ligne sélectionnée (le formulaire est alors pré-rempli, y compris les lignes liées).

## Listes liées (valeurs issues d'une autre table)

Onglet **3 · Listes liées** : un champ de type choix unique, liste déroulante, cases à cocher, étiquettes, classement ou **texte** (suggestions) prend ses valeurs dans une autre table Grist. Cela fonctionne à tous les niveaux (matrices, panneaux dynamiques, panneaux de détail).

- **Valeur enregistrée / libellé affiché** : deux colonnes de la table source (ou l'ID de la ligne, pour remplir une colonne **Référence**).
- **Filtre par défaut (concepteur)** : conditions fixes combinées par « ET » (égal, différent, contient, supérieur/inférieur, dans la liste, vide / non vide).
- **Filtre dynamique (utilisateur)** : la condition compare une colonne de la table source à la réponse d'un autre champ du formulaire : champ de la même ligne ou du même panneau, ou d'un niveau parent. Ce champ peut être une question purement « filtre », non enregistrée (mappage : « ignorer »). Chaque ligne d'une matrice a sa propre liste. Tant que le champ est vide : aucune valeur, ou toutes les valeurs (au choix).
- Si la valeur choisie n'est plus dans la liste après un changement de filtre, elle est effacée. Les listes se recalculent à chaque changement.
- Le bouton « Tester la liste » affiche le nombre de valeurs et un aperçu.
- Les utilisateurs du formulaire doivent avoir un **accès en lecture** à la table source (règles d'accès Grist).
- Les données de la table source sont lues une fois par formulaire, puis filtrées dans le navigateur : à éviter pour des tables de plusieurs dizaines de milliers de lignes.
- Pour une colonne **Référence**, le bouton « Créer les éléments manquants » crée la colonne `Ref:<table>` et tente de régler la colonne affichée ; si Grist le refuse, choisissez-la à la main dans les options de la colonne.

## Remplissage automatique de lignes

Même onglet (« 3 · Listes liées et remplissage »). Une **matrice dynamique** ou un **panneau dynamique** peut être peuplé automatiquement avec les lignes d'une table Grist dès qu'un champ change.

- **Correspondance des colonnes** : chaque colonne de la matrice reçoit une colonne de la table source (ou l'ID de la ligne). La première correspondance sert de clé : une seule ligne par valeur. Les autres colonnes (cases à cocher, dates, nombres…) peuvent être reprises aussi.
- **Déclencheur** : le filtre dynamique compare une colonne de la table source à la réponse d'un champ du formulaire (ex. : la tutelle). Les lignes sont ajoutées quand cette réponse **change**. Au chargement d'une saisie existante (mode « modifier »), rien n'est modifié ; tant que le champ est vide, les lignes en place sont conservées.
- **Mode** : *remplacer* les lignes à chaque changement de filtre, ou *ajouter seulement les lignes manquantes* (les lignes déjà présentes sont conservées ; à réserver aux cas où elles restent valides pour le nouveau filtre).
- **Déplier le détail** : ouvre le détail de chaque ligne ajoutée (utile si le détail contient des champs obligatoires, comme les années d'un contrat).
- Le bouton « Tester » affiche le nombre de lignes et un aperçu ; la lecture de la table source demande un accès en lecture.

### Exemple : formulaire des dettes (`formulaire-dettes-liban.json`)

1. **Liste liée** du champ `tutelleNom` : table `Institutions`, valeur = *ID de la ligne*, libellé = `nom`.
2. **Liste liée** du champ `contratNom` (niveau `contrats`) : table `Contrats`, valeur = *ID de la ligne*, libellé = `nom`, filtre dynamique `institution` *est égal à* `tutelleNom`.
3. **Remplissage automatique** de la matrice `contrats` : table `Contrats`, correspondance `contratNom` ← *ID de la ligne* (et, si la table les contient, `etablissementFerme`, `contratRompu`, `contratSuspendu` ← les colonnes correspondantes), filtre dynamique `institution` *est égal à* `tutelleNom`, mode *remplacer*.
4. Mappage : `tutelleNom` et `contratNom` vers des colonnes **Référence** (`Ref:Institutions`, `Ref:Contrats`), créées par « Créer les éléments manquants ».

Si la colonne de rattachement de `Contrats` est du texte (et non une référence), enregistrez plutôt la valeur `nom` de l'institution et comparez `institution` à cette valeur.

## Correspondance des types

| Question SurveyJS | Colonne Grist créée |
|---|---|
| text, comment, multipletext | Texte (ou Numérique / Date / Date+heure selon `inputType`) |
| radiogroup, dropdown, buttongroup, imagepicker | Choix |
| checkbox, tagbox, ranking | Liste de choix |
| boolean | Booléen |
| rating | Entier |
| file, signaturepad | Pièces jointes |
| matrix (simple) | une colonne Choix par ligne |
| paneldynamic, matrixdynamic | table liée (une ligne par panneau / ligne) |
| matrixdropdown | table liée avec une colonne « Ligne (clé) » |

Les fichiers sont envoyés avec le jeton d'accès de l'API des widgets (`docApi.getAccessToken` puis `POST /attachments`) ; leurs identifiants sont écrits dans les colonnes Pièces jointes, à n'importe quel niveau d'imbrication.

### Pièces jointes pour les non-propriétaires (mode par défaut)

Un utilisateur qui n'est pas propriétaire du document ne peut pas toujours écrire dans une colonne « Pièces jointes ». Le widget utilise donc, par défaut, ce contournement :

1. le fichier est envoyé avec l'API standard des widgets, ce qui donne son identifiant ;
2. les identifiants sont écrits **sous forme de liste** (colonne de type Liste de choix, même pour un seul fichier : `["12","13"]`) dans une colonne masquée `<champ>_ids` (« id des documents ») ;
3. une colonne **formule** de type Pièces jointes relit cette liste (elle accepte aussi l'ancien format texte `12,13`) :

```python
ids = $champ_ids
if isinstance(ids, str):
  ids = ids.replace(";", ",").split(",")
return [int(i) for i in (ids or []) if str(i).strip().isdigit()]
```

Le bouton « Créer les éléments manquants » crée les deux colonnes et masque la colonne d'identifiants. Le mode se change dans l'onglet *Comportement* (« Écriture directe » reste disponible). Une colonne Pièces jointes existante, choisie dans le mappage, continue d'être écrite directement.

## Utilisateurs externes et règles d'accès

Le widget s'exécute avec les droits de la personne connectée. Pour un formulaire public ou partagé, donnez à ces utilisateurs le droit d'**ajouter** des lignes dans la table principale et dans les tables liées (règles d'accès Grist). Les pièces jointes passent par l'API REST du document : testez avec le rôle réel des utilisateurs concernés, car des restrictions d'accès peuvent bloquer l'envoi de fichiers pour des rôles non propriétaires.

## Limites connues

- Les types des colonnes existantes sont mémorisés à l'enregistrement de la configuration ; si vous changez le type d'une colonne, rouvrez la configuration et enregistrez à nouveau.
- Si le JSON change (nouveau champ, nouveau niveau), repassez par l'onglet *Mappage* : les choix déjà faits sont conservés.
- En mode « modifier », les lignes liées sont supprimées puis recréées à l'envoi.
- En cas d'échec en cours d'envoi (création), les lignes déjà créées sont supprimées au mieux ; les pièces jointes déjà envoyées restent dans le document.
- Niveaux imbriqués détectés : panneaux dynamiques, matrices dynamiques, panneaux de détail de ligne (`detailElements`) et colonnes dont la cellule est une matrice ou un panneau dynamique, à toute profondeur.
- Les questions `html`, `image` et les variables ne sont pas enregistrées.
