# grist_widgets
Plusieurs widget personnalisés


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
2. les identifiants sont écrits dans une colonne texte masquée `<champ>_ids` (« id des documents »), au format `12,13` ;
3. une colonne **formule** de type Pièces jointes relit ces identifiants : `[int(i) for i in str($<champ>_ids or "").replace(";", ",").split(",") if i.strip().isdigit()]`.

Le bouton « Créer les éléments manquants » crée les deux colonnes et masque la colonne d'identifiants. Le mode se change dans l'onglet *Comportement* (« Écriture directe » reste disponible). Une colonne Pièces jointes existante, choisie dans le mappage, continue d'être écrite directement.

## Utilisateurs externes et règles d'accès

Le widget s'exécute avec les droits de la personne connectée. Pour un formulaire public ou partagé, donnez à ces utilisateurs le droit d'**ajouter** des lignes dans la table principale et dans les tables liées (règles d'accès Grist). Les pièces jointes passent par l'API REST du document : testez avec le rôle réel des utilisateurs concernés, car des restrictions d'accès peuvent bloquer l'envoi de fichiers pour des rôles non propriétaires.

## Limites connues

- Les types des colonnes existantes sont mémorisés à l'enregistrement de la configuration ; si vous changez le type d'une colonne, rouvrez la configuration et enregistrez à nouveau.
- Si le JSON change (nouveau champ, nouveau niveau), repassez par l'onglet *Mappage* : les choix déjà faits sont conservés.
- En mode « modifier », les lignes liées sont supprimées puis recréées à l'envoi.
- En cas d'échec en cours d'envoi (création), les lignes déjà créées sont supprimées au mieux ; les pièces jointes déjà envoyées restent dans le document.
- Niveaux imbriqués détectés : panneaux dynamiques, matrices dynamiques, panneaux de détail de ligne (`detailElements`) et colonnes dont la cellule est une matrice ou un panneau dynamique, à toute profondeur.
- Les questions `html`, `image` et les variables ne sont pas enregistrées.ariables ne sont pas enregistrées.
