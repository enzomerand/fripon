# Fripon — extension navigateur anti-dropshipping pour Vinted

_Document de conception — 20 octobre 2026 — statut : approuvé par le porteur le 20 octobre 2026_

## 1. Intention

Sur Vinted, des vendeurs revendent très cher des articles achetés quelques euros sur Shein, Temu ou AliExpress (dropshipping). Aujourd'hui, pour le détecter, il faut copier la photo dans Google Lens à la main : c'est comme ça que le porteur du projet a découvert qu'une annonce chère était en réalité un article Shein.

**Fripon** automatise ce geste et va plus loin : il analyse l'annonce, le vendeur et la cohérence du prix, puis donne un verdict lisible directement sur la page Vinted.

Il existe un outil payant, VintCheck (vintcheck.fr), qui n'analyse que l'image. Fripon se veut **gratuit et open source**, et plus complet.

## 2. Pour qui

Le **grand public** : des acheteurs Vinted ordinaires, pas des technophiles. Conséquences :

- l'extension doit être utile **dès l'installation, sans aucune clé** ;
- le verdict est formulé en mots simples, sans jargon ni score brut ;
- la configuration des clés API doit être guidée pas à pas.

## 3. Périmètre : deux projets

1. **L'extension Fripon** (ce document) : vérifications gratuites lues sur la page, plus les vérifications avec les clés API de l'utilisateur.
2. **Le service d'abonnement Fripon** (conçu plus tard, hors de ce document) : comptes, paiement et clés API hébergées par le porteur du projet, pour ceux qui ne veulent pas créer leurs propres clés.

L'extension est conçue dès le départ pour pouvoir se brancher sur ce service, mais la v1 ne l'inclut pas.

## 4. Objectifs, non-objectifs, anti-objectifs

**Objectifs v1**

- Extension **pour ordinateur** : Chrome et Safari sur Mac (Firefox en bonus si le coût est faible), à partir d'un seul code.
- Analyse automatique de la page d'une annonce Vinted, avec un verdict intégré à la page.
- Analyse à la demande depuis la liste des résultats.
- Cinq vérifications : recherche de l'image, prix, vendeur, photos, description, plus un avis IA qui résume.
- Mode « clés perso » : Google Vision pour la recherche d'image, Gemini pour l'IA.
- Dépôt GitHub **public**, sous licence **AGPL-3.0** _(décision du porteur : protège le futur service d'abonnement contre une revente du code sans partage des modifications)_.

**Non-objectifs v1**

- Le service d'abonnement (projet 2).
- **Le mobile** _(décision du porteur)_ : ni Safari sur iPhone/iPad, ni Firefox sur Android. Les maquettes et la mise en page visent le Vinted pour ordinateur.
- L'analyse automatique de toute la liste des résultats sans clic (elle viderait les crédits).
- La détection de contrefaçons de marques de luxe.
- Une interface traduite dans d'autres langues que le français (le code reste prêt pour la traduction).

**Anti-objectifs** (ce qui serait un échec même si tout fonctionne)

- **Accuser à tort un vendeur honnête.** Fripon donne des indices, pas des certitudes, et le dit sur chaque verdict : quelqu'un peut revendre honnêtement un article Shein qu'il a porté.
- **Une configuration si pénible que personne n'active la recherche d'image.**
- **Faire bannir le compte Vinted de l'utilisateur** à cause d'un trop grand nombre de requêtes vers Vinted.
- Collecter des données sur l'utilisateur ou envoyer ses données à un serveur Fripon en mode clés perso.
- Constituer ou publier une base de vendeurs « signalés ».

## 5. Expérience utilisateur

Les maquettes validées se trouvent dans `docs/mockups/` (`placement.html`, `detail.html`, `grid.html`). Ce sont des fragments HTML : ils montrent la disposition et le ton, pas le style final au pixel près.

### 5.1 Page d'une annonce — carte intégrée _(décision du porteur : option A)_

Une carte est insérée **entre le prix et le bouton « Acheter »**, dans la colonne de droite de l'annonce.

**Version repliée** : un verdict, une ou deux lignes avec le chiffre qui compte, et un lien « Voir les 5 vérifications ». Exemple : « Dropshipping probable — Même photo sur Shein à 8,99 € — Vendu ici 3,8× plus cher ».

**Version dépliée** : les cinq vérifications, chacune avec une étiquette courte (Trouvée, 3,8× trop cher, À surveiller, Photo catalogue, Style boutique, Normale, Désactivée…) et une phrase d'explication. La recherche d'image liste les boutiques trouvées avec leur prix, sous forme de liens. Viennent ensuite l'**avis IA** en langage simple, puis la phrase de prudence.

**Verdicts** (règles précises en section 6) :

| Verdict                          | Couleur | Sens                                                                                                             |
| -------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------- |
| Dropshipping probable            | rouge   | article retrouvé sur une plateforme de dropshipping, revendu avec une forte marge ou avec d'autres signaux forts |
| Article Shein revendu (ou Temu…) | orange  | article retrouvé sur une plateforme, mais prix raisonnable et rien d'autre de suspect _(ajout de Claude)_        |
| À vérifier                       | orange  | des signaux faibles ou un prix anormal, sans preuve d'origine                                                    |
| Rien de suspect                  | vert    | aucun signal notable                                                                                             |

**Sans clé configurée** : les vérifications gratuites s'affichent normalement. La recherche d'image apparaît « Désactivée » avec un bouton **« Activer en 2 minutes »** qui ouvre le guide de configuration.

L'icône de Fripon dans la barre du navigateur prend la couleur du verdict de l'annonce ouverte.

### 5.2 Liste des résultats — bouton sous le prix _(décision du porteur : option B)_

Chaque vignette d'article (recherche, catalogue, vitrine d'un vendeur, fil d'accueil) reçoit un **bouton pleine largeur « 🦊 Analyser » sous le prix et la taille**. Pendant l'analyse, il affiche « ⏳ Analyse… ». Il est ensuite remplacé par le verdict compact (couleur, verdict, une ligne, par exemple « Shein · 8,99 € »). Un clic sur le verdict ouvre le détail.

En haut des résultats, un bouton **« 🦊 Analyser les N articles visibles »** lance l'analyse de tous les articles visibles. Avant de démarrer, il indique combien de crédits seront consommés et demande confirmation. _(Choix de Claude : le porteur n'a pas tranché sur ce bouton ; il est gardé, avec la confirmation.)_

**Analyse réduite dans la liste** _(choix de Claude)_ : pour ne pas multiplier les requêtes vers Vinted, une vignette lance seulement la recherche de l'image, le rapport avec le prix d'origine, et les vérifications photos et description à partir des données déjà présentes dans la liste. La vérification vendeur et la comparaison avec les annonces Vinted similaires ne sont faites que sur la page de l'annonce. Le verdict compact le signale (« analyse rapide »), et le détail propose « Ouvrir l'analyse complète ». En cas d'analyse en lot, les vignettes sont traitées une à une, avec un délai entre chaque.

### 5.3 Quand l'analyse se lance _(décision du porteur)_

- **Par défaut** : sur la page d'une annonce, tout se lance automatiquement à l'ouverture.
- **Option « Analyse au clic »** dans les réglages : les vérifications qui consomment des crédits (recherche d'image, IA) attendent un clic. Les vérifications gratuites restent automatiques.
- Dans la liste des résultats, l'analyse se lance **toujours au clic** (5.2).
- **Cache** : une annonce déjà analysée n'est jamais repayée. Le résultat est réutilisé tant que l'annonce (photos, prix) n'a pas changé.

**Crédits et plafond** _(choix de Claude)_ : un crédit, c'est un appel payant. Fripon tient deux compteurs séparés, un pour Google Vision (au mois) et un pour Gemini (au jour), tous deux remis à zéro à minuit, heure du Pacifique, comme chez Google. Par défaut, Fripon **s'arrête de lui-même** : à la limite gratuite pour Vision (environ 1 000 analyses par mois), et à 100 avis par jour pour Gemini, un garde-fou plus qu'une limite gratuite (la clé vient d'un projet sans facturation, que Google ne peut pas facturer : au-delà de sa limite, il refuse sans frais). Il prévient à 80 %, puis bascule sur les vérifications gratuites et le lien Google Lens. L'utilisateur peut relever ou supprimer ce plafond dans les réglages, avec un avertissement clair qu'il risque alors d'être facturé par Google. Le compteur est local : il ne voit pas ce que la même clé consomme ailleurs, et le guide le dit.

### 5.4 Réglages et guide

- Une page de réglages : mode d'analyse (automatique / au clic), clé Google Vision, clé Gemini, compteur de crédits consommés ce mois-ci.
- Un **guide pas à pas** illustré pour obtenir chaque clé. Il doit prévenir que Google Cloud demande une carte bancaire pour activer Vision, même dans la limite gratuite (environ 1 000 analyses par mois), et que Gemini a une offre gratuite sans carte.
- Un écran d'accueil à l'installation qui explique en trois phrases ce que fait Fripon et propose le guide, sans l'imposer.

### 5.5 Ton et identité _(choix de Claude)_

- Tutoiement, comme Vinted.
- Emblème : un renard 🦊 (en attendant un vrai logo). Couleur d'accent : violet, pour se distinguer du vert de Vinted.
- Verdicts en mots, sans score sur 100.

## 6. Les vérifications

| Vérification             | Ce qu'elle regarde                                                                                                                                                           | Source                                                                                                                      | Clé ?                                                                                          |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| **Recherche de l'image** | La photo principale (et éventuellement les autres) apparaît-elle sur Shein, Temu, AliExpress, Alibaba, DHgate, Wish, Romwe, Cider, Zaful, etc. ? À quel prix ?               | Google Cloud Vision, fonction « Web Detection »                                                                             | Google Vision                                                                                  |
| **Prix**                 | Écart entre le prix Vinted et le prix d'origine trouvé ; comparaison avec le prix médian des annonces Vinted similaires                                                      | Résultat de la recherche d'image + recherche Vinted                                                                         | Partiel : la comparaison Vinted est gratuite, le prix d'origine dépend de la recherche d'image |
| **Vendeur**              | Ancienneté du compte, nombre d'avis et note, nombre d'articles en vente, part d'articles « neuf avec étiquette », même article proposé en plusieurs tailles (signe de stock) | Données Vinted (page et profil)                                                                                             | Non                                                                                            |
| **Photos**               | Photo de catalogue (fond uni, mannequin, studio) ou photo réelle ; même photo réutilisée sur d'autres annonces du vendeur                                                    | Comparaison d'images locale ; détection « catalogue » par l'IA si une clé est présente, sinon par une méthode locale simple | Non (amélioré par Gemini)                                                                      |
| **Description**          | Texte au style fiche produit traduite, mots-clés empilés, marque absente ou « Sans marque »                                                                                  | Règles locales ; affinées par l'IA si une clé est présente                                                                  | Non (amélioré par Gemini)                                                                      |
| **Avis IA**              | Résumé en une à trois phrases de tous les signaux, en langage simple                                                                                                         | Gemini                                                                                                                      | Gemini                                                                                         |

Le **verdict final** combine les signaux selon des règles explicites et documentées, dans le code ouvert. L'IA résume ; elle ne décide pas seule du verdict.

**Règles du verdict** _(choix de Claude, guidé par l'anti-objectif « ne pas accuser à tort »)_ :

- **Correspondance avérée** : Google Vision renvoie la même image (correspondance complète, pas seulement « visuellement similaire ») sur une page produit d'une plateforme de dropshipping de la liste. Les correspondances partielles ou seulement similaires ne sont jamais avérées.
- **Rouge « Dropshipping probable »** : correspondance avérée, plus soit un prix Vinted au moins 2× le prix d'origine, soit (si le prix d'origine est inconnu) au moins un autre signal fort (stock en plusieurs tailles, majorité d'articles neufs avec étiquette ; la photo catalogue ne devient forte que confirmée par l'IA et appuyée par une correspondance avérée ; sans elle, l'IA ne fait qu'ajouter un signal faible, « L'IA voit une photo de catalogue »).
- **Orange « Article Shein revendu »** (ou Temu, AliExpress…) : correspondance avérée mais prix raisonnable et aucun autre signal fort. C'est le cas du particulier qui revend un article porté.
- **Orange « À vérifier »** : correspondance partielle ou similaire, ou prix anormal par rapport aux annonces Vinted similaires, ou un signal fort, ou des signaux faibles venant d'au moins deux familles différentes (profil du vendeur, texte, photo). Deux signaux de la même famille ne comptent qu'une fois.
- **Vert « Rien de suspect »** : aucune correspondance et aucun signal notable. Si la recherche d'image n'a pas tourné (pas de clé, plafond atteint), le vert le précise : « Rien de suspect (sans recherche d'image) ».
- Les pages de Vinted lui-même et des autres sites de seconde main sont exclues des correspondances.
- Sans correspondance avérée, aucune vérification locale (vendeur, photos, description) ne s'affiche en rouge : elles plafonnent à l'orange. La photo catalogue détectée localement est un signal faible, formulé « Ressemble à une photo catalogue ».
- Une donnée que Fripon n'a pas pu lire (nombre d'avis, marque, description, état des articles) ne produit jamais de signal : elle est signalée comme non lue.
- Les seuils (2×, nombre de signaux) sont des constantes nommées et regroupées.

**Repli gratuit pour la recherche d'image** _(choix de Claude)_ : sans clé Google Vision, la ligne « Recherche de l'image » propose aussi un lien « Chercher moi-même sur Google Lens », qui ouvre Lens dans un nouvel onglet avec la photo de l'annonce. C'est manuel, mais sans clé et sans coût.

## 7. Contraintes

- **Navigateurs** : Chrome sur ordinateur (Chrome Web Store, 5 $ une fois) et Safari sur Mac (Xcode et compte Apple Developer, 99 $ par an, à la charge du porteur). Les deux sont générés à partir d'un même code.
- **Sites** : tous les domaines Vinted (vinted.fr, .be, .es, .it, .de, .nl, .pl, .co.uk, etc.). _(Choix de Claude :)_ les prix sont convertis en euros avec les taux quotidiens de la Banque centrale européenne pour calculer les écarts, et affichés dans la devise de l'annonce. Les règles locales de la vérification « Description » couvrent le français et l'anglais (les fiches Shein traduites sont souvent en anglais). Pour les autres langues, cette vérification s'appuie sur Gemini si une clé est présente, sinon elle s'affiche « Non disponible dans cette langue ».
- **Vinted** est une application d'une seule page : la navigation entre annonces ne recharge pas la page, et l'extension doit s'en rendre compte. Sa mise en page peut changer sans prévenir ; l'insertion de la carte doit pouvoir se réparer facilement (sélecteurs regroupés à un seul endroit) et échouer proprement, sans casser la page Vinted.
- **Requêtes vers Vinted** : limitées, espacées et mises en cache, pour ne pas faire bloquer le compte de l'utilisateur.
- **Vie privée** : en mode clés perso, aucune donnée ne transite par un serveur Fripon. Les clés restent stockées localement dans le navigateur. Vers Google, et seulement pour l'analyse d'une annonce, partent : la photo principale vers Vision (recherche d'image) ; vers Gemini (avis IA), la photo, le titre, la description, le prix et les indices que Fripon a calculés (par exemple « la même photo est en vente sur Shein » ou une phrase sur le vendeur). Avec l'offre gratuite de Gemini, Google peut utiliser ces données pour améliorer ses services : la page des réglages et le guide le disent. Une politique de confidentialité est publiée, comme l'exigent les stores.
- **Marques** : le nom et les visuels n'utilisent ni « Vinted » ni « Shein », pour éviter un refus des stores.
- **Pas de GitHub Actions** (préférence du porteur) : les vérifications se lancent en local.
- **Branchement futur** : l'accès aux services payants (Vision, Gemini) passe par une couche unique, pour qu'un futur fournisseur « Fripon Cloud » (abonnement) puisse remplacer les clés perso sans toucher au reste.

## 8. Choix de construction _(choix de Claude, modifiables par le porteur)_

- Framework d'extension **WXT** en **TypeScript** : un seul code pour Chrome, Safari et Firefox, au format Manifest V3.
- L'interface injectée dans Vinted est isolée de la page (Shadow DOM), pour que le style de Vinted ne la casse pas et inversement.
- Les appels aux API externes partent du service d'arrière-plan de l'extension, jamais de la page.

## 9. Ce qui est laissé au constructeur

- Le choix de la bibliothèque d'interface et de l'outillage de test.
- La méthode exacte pour lire les données Vinted (page, données embarquées, ou API interne de Vinted appelée depuis l'onglet de l'utilisateur).
- Les seuils précis des signaux (combien d'articles neufs, quel écart de prix, etc.), à condition qu'ils soient regroupés, nommés et faciles à ajuster.
- La méthode de comparaison d'images (empreinte perceptuelle ou autre).
- La présentation détaillée des réglages et du guide, dans l'esprit des maquettes.

## 10. Risques et inconnues à lever en premier

1. **Le prix d'origine.** Google Vision renvoie des pages qui contiennent l'image, pas leurs prix. Il faut un essai rapide pour choisir comment l'obtenir : lire la page trouvée depuis l'extension (Shein et Temu se protègent contre les robots), demander à Gemini de lire la page ou de chercher le produit, ou proposer un fournisseur optionnel qui renvoie les prix (SerpApi Google Lens, payant). Sans prix fiable, la carte affiche « Trouvé sur Shein » sans montant, et le verdict reste valable.
   - **Conclusion de l'essai (27 octobre 2026) : le prix n'est pas lisible avec des clés gratuites.** Shein sert une page anti-robot, même quand elle est ouverte dans un navigateur. L'outil de lecture de page de Gemini (`url_context`) ouvre la page mais n'y trouve pas de prix. L'ancrage sur la recherche Google (Google Search grounding), qui aurait pu le retrouver, n'est pas dans l'offre gratuite (quota à 0). Temu n'a pas été essayé à part : la carte parle des deux plateformes par prudence. La v1 sort donc avec « Trouvée sur Shein » sans montant, comme prévu : la ligne Prix reste « Non comparé » et renvoie vers les liens de la recherche d'image, et le verdict n'utilise aucun rapport de prix (règle du « prix d'origine inconnu »). Un fournisseur payant de type SerpApi reste une option pour plus tard.
2. **La qualité de Google Vision** face à Google Lens sur des photos de vêtements recadrées ou retouchées. À mesurer sur un petit échantillon d'annonces réelles connues.
   - **Conclusion partielle (27 octobre 2026) : encourageante, pas encore mesurée.** Sur des photos catalogue de Shein, Vision renvoie des correspondances exactes sur des pages produit (parfois accompagnées de pages de catégorie, qui ne comptent pas). Sur des photos de vendeurs particuliers, il ne renvoie aucune correspondance exacte. Le jeu de référence complet d'environ 30 annonces reste à constituer : tant qu'il n'est pas fait, le seuil « 2 annonces sur 3 » ci-dessous n'est pas vérifié.
3. **L'offre gratuite de Gemini** (limites, conditions, disponibilité en Europe) : à vérifier au moment de construire.
   - **Conclusion de l'essai (27 octobre 2026) : elle fonctionne en France.** Avec une clé d'un projet sans facturation, `gemini-flash-lite-latest` répond en 5 à 7 secondes pour environ 1 300 jetons par avis, en JSON structuré (une photo catalogue de Shein donne `catalogPhoto: true` et un résumé prudent, une photo prise à la maison donne `false`). Les modèles plus gros ont échoué : `gemini-3.8-flash` dépasse le délai ou répond 503, `gemini-2.5-flash` répond 404. Google Search grounding n'est pas dans l'offre gratuite. Au-delà de sa limite gratuite, un projet sans facturation reçoit un 429 de Google, sans frais : le plafond de Fripon (100 avis par jour par défaut) est un garde-fou, pas une protection du porte-monnaie. Condition à connaître : avec l'offre gratuite, Google peut utiliser la photo, le titre et la description envoyés pour améliorer ses services, et le guide le dit.
4. **La lecture des données Vinted** sans déclencher leurs protections anti-robots.
   - **Conclusion : elle tient avec des précautions.** Les données de l'annonce viennent du JSON-LD et de la page elle-même (l'API de détail d'un article répond toujours 403). L'API du vendeur n'accepte les requêtes qu'avec l'en-tête `accept: application/json` ; Fripon les espace de 1,5 seconde entre tous les onglets, garde 24 heures de cache et fait une pause après un 403 ou un 429.

**Comment conclure ces essais** _(choix de Claude)_ :

- Le constructeur constitue lui-même un échantillon d'environ 30 annonces : 15 articles manifestement issus de Shein ou Temu (retrouvés à la main via Google Lens) et 15 articles de marque portés. Il le garde dans le dépôt comme jeu de référence.
- Google Vision est jugé suffisant s'il retrouve la plateforme d'origine pour au moins 2 annonces sur 3 du premier groupe, sans aucune correspondance avérée dans le second. Sinon, la recherche automatique reste proposée mais signalée « expérimentale », et le lien Google Lens est mis en avant.
- Pour le prix d'origine, la v1 n'ajoute **pas** de troisième clé obligatoire. Si ni la lecture de la page ni Gemini ne donnent un prix fiable, la v1 sort avec « Trouvé sur Shein » sans montant. Un fournisseur payant de type SerpApi reste une option avancée pour plus tard.

## 11. Après la v1

- Le service d'abonnement (projet 2), avec sa propre conception.
- Le mobile (Safari iPhone/iPad, Firefox Android).
- D'autres fournisseurs d'IA en clé perso (OpenAI, Claude).
- Les traductions de l'interface.
