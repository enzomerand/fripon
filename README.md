<p align="center">
  <img src="assets/logo.svg" width="112" alt="Logo de Fripon : un renard qui fait un clin d’œil">
</p>

<h1 align="center">Fripon</h1>

<p align="center">
  Repère le dropshipping et les annonces douteuses sur Vinted, directement sur la page.<br>
  Gratuit · Open source · Sans serveur · Chrome, Safari (macOS), Firefox
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

Pas d’abonnement ni de compte. La recherche de photo et l’IA utilisent **tes propres clés Google** :

- **Google Vision** : 1 000 recherches gratuites par mois, puis environ 3,50 $ les 1 000. Fripon
  s’arrête à 1 000 par mois (modifiable) et garde les recherches récentes en cache 7 jours.
- **Gemini** : gratuit, dans un projet Google Cloud sans facturation.

La page de réglages guide pas à pas la création des clés.

## Vie privée

Fripon n’a aucun serveur et ne mesure rien. Tes clés restent dans ton navigateur. Seules la photo de
l’annonce et, pour l’IA, son texte, son prix et les indices relevés partent chez Google.

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
