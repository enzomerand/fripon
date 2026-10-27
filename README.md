<p align="center">
  <img src="assets/logo.svg" width="112" alt="Logo de Fripon : un renard qui fait un clin d’œil">
</p>

<h1 align="center">Fripon</h1>

<p align="center">
  Repère le dropshipping et les annonces douteuses sur Vinted, directement sur la page.<br>
  Gratuit avec tes clés Google, ou par abonnement · Open source · Chrome, Safari (macOS), Firefox
</p>

---

Sur Vinted, des vendeurs revendent des articles Shein, Temu ou AliExpress achetés quelques euros.
Fripon ajoute une carte sur chaque annonce que tu ouvres : un verdict en couleur, et pourquoi.

## Ce que fait Fripon

- **Un verdict sur chaque annonce** : 🔴 Dropshipping probable, 🟠 Article revendu ou À vérifier,
  🟢 Rien de suspect, avec le détail de chaque vérification.
- **Gratuit, sans rien configurer** : le vendeur (avis, articles neufs en série, même article en
  plusieurs tailles), les photos (allure de catalogue, photo réutilisée) et la description (texte de
  boutique ou traduit).
- **Recherche de la photo** sur Shein, Temu, AliExpress et sept autres boutiques, avec Google Vision.
- **Avis de l’IA** (facultatif) : Gemini résume l’annonce en une à trois phrases.
- **Dans les résultats de recherche**, un bouton « Analyser » sous chaque vignette, ou tous les
  articles visibles d’un coup.
- **Les annonces vendues** ne sont pas analysées à leur ouverture.

## Coûts

Les vérifications gratuites ne demandent rien. Pour la recherche de photo et l’IA, deux façons de
faire, au choix dans la page de réglages :

- **Tes propres clés Google**, sans compte ni abonnement :
  - **Google Vision** : 1 000 recherches gratuites par mois, puis environ 3,50 $ les 1 000. Fripon
    s’arrête à 1 000 par mois (modifiable) et garde les recherches récentes en cache 7 jours.
  - **Gemini** : gratuit, dans un projet Google Cloud sans facturation.

  La page de réglages guide pas à pas la création des clés.

- **L’abonnement Fripon**, sans clé à créer : tu te connectes avec ton e-mail (un code, pas de mot de
  passe) et Fripon s’occupe de la recherche de photo et de l’IA. 15 analyses sont offertes pour
  essayer, puis **Essentiel** (2,99 €/mois ou 29,99 €/an, 300 analyses par mois, 40 par jour) ou
  **Revendeur** (6,99 €/mois, 1 000 analyses par mois, 100 par jour). Une analyse, c’est une
  annonce : la revoir dans le mois ne compte pas.

## Vie privée

Fripon ne mesure rien. Sans abonnement, il n’a aucun serveur : tes clés restent dans ton navigateur,
et seules la photo de l’annonce et, pour l’IA, son texte, son prix et les indices relevés partent
chez Google. Avec l’abonnement, l’adresse de la photo, le titre, la description, le prix et les
indices relevés partent vers le serveur de Fripon, qui appelle Google avec sa propre clé payante
(Google ne les utilise pas pour améliorer ses produits) ; ton e-mail sert à te connecter.

## Installer

Fripon n’est pas encore sur les boutiques d’extensions. Il faut [Node.js](https://nodejs.org/).

```sh
npm install
npm run build
```

- **Chrome** : `chrome://extensions` → « Mode développeur » → « Charger l’extension non empaquetée »
  → dossier `.output/chrome-mv3`.
- **Firefox** : `npm run build:firefox`, puis `about:debugging` → « Ce Firefox » → « Charger un
  module complémentaire temporaire » → `.output/firefox-mv2/manifest.json`.
- **Safari (macOS)** : voir [`docs/safari.md`](docs/safari.md).

## Contribuer

`npm run dev` lance Chrome avec l’extension rechargée à chaud. `npm run check` (formatage, lint,
types, tests) passe avant chaque commit. L’architecture et les pièges de Vinted sont dans
[`CLAUDE.md`](CLAUDE.md).

## Licence

[AGPL-3.0](LICENSE).
