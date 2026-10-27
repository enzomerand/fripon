# Fripon

Extension de navigateur qui repère, sur les annonces Vinted, le dropshipping (Shein, Temu,
AliExpress…) et les prix incohérents. Gratuite et open source (AGPL-3.0).

- Navigateurs : Chrome (bureau), Safari (macOS), Firefox en bonus.
- Conception : `docs/superpowers/specs/2026-10-20-fripon-extension-design.md`.
- Pour contribuer, voir `CLAUDE.md` (commandes, architecture, pièges).

## Installer sur Chrome

```sh
npm install
npm run build
```

Puis dans Chrome : `chrome://extensions` → activer le « Mode développeur » → « Charger l’extension
non empaquetée » → choisir le dossier `.output/chrome-mv3`.

Pendant le développement, `npm run dev` ouvre Chrome avec l’extension et la recharge à chaque
modification (`npm run dev:firefox` pour Firefox).

## Installer sur Safari (macOS)

Safari ne charge pas un dossier : l’extension doit être emballée dans une petite application macOS.
Le projet Xcode est déjà dans `safari/`. Il n’y a pas de compte Apple Developer dans ce projet : la
compilation est signée « ad hoc » (sans identité) et Safari doit être autorisé à charger des
extensions non signées. Seul macOS est géré (pas iPhone ni iPad).

Prérequis : macOS 13 ou plus récent, Xcode (avec ses outils en ligne de commande) et Node.js.

1. Compiler l’application :

   ```sh
   npm install
   npm run safari:app
   ```

   La commande construit l’extension, la copie dans le projet Xcode puis lance `xcodebuild`
   (Debug, signature ad hoc). Elle affiche à la fin le chemin de l’application :
   `.output/safari-xcode/Build/Products/Debug/Fripon.app`.

2. Ouvrir `Fripon.app` une fois (double-clic ou `open` sur ce chemin), puis la quitter. Cela
   déclare l’extension à Safari.
3. Dans Safari : Réglages → Avancées → cocher « Afficher les fonctionnalités pour les développeurs
   web ».
4. Menu Développement → « Autoriser les extensions non signées » (mot de passe de session
   demandé). **Ce réglage se désactive à chaque redémarrage de Safari** : il faut le refaire.
5. Safari → Réglages → Extensions → cocher « Fripon ».
6. Toujours dans cet écran, autoriser l’extension sur les sites : `vinted.fr` (ou le domaine Vinted
   utilisé) et, pour l’analyse des photos et la recherche d’image, les autres sites demandés
   (`vinted.net`, `googleapis.com`). Le plus simple est de mettre « Autres sites web » sur
   « Autoriser » (bouton « Modifier les sites web »).

Après une nouvelle compilation (`npm run safari:app`), relancer `Fripon.app`, puis recharger la page
Vinted. Si Safari garde l’ancienne version, le redémarrer (et refaire l’étape 4).

Publier sur l’App Store demande un compte Apple Developer (99 $ par an) : ce n’est pas fait ici.

### Comment ça marche

- `npm run build:safari` construit l’extension pour Safari dans `.output/safari-mv3`.
- `npm run safari:sync` la copie dans `safari/Fripon/Fripon Extension/Resources/`. Ce dossier est
  généré et ignoré par Git : ne pas le modifier à la main.
- `npm run safari:app` enchaîne les deux puis compile l’application.
- Le projet Xcode (`safari/Fripon/Fripon.xcodeproj`) est versionné et ne dépend d’aucun chemin de
  machine. On peut aussi l’ouvrir dans Xcode (choisir « Sign to Run Locally » comme signature).

### Régénérer le projet Xcode

À faire seulement si `npm run safari:sync` signale que la compilation ne correspond plus au projet
(par exemple après l’ajout d’une page ou d’un fichier au premier niveau de l’extension, comme une
fenêtre de barre d’outils) :

```sh
npm run build:safari
xcrun safari-web-extension-converter .output/safari-mv3 --project-location safari \
  --app-name Fripon --bundle-identifier fr.fripon.Fripon --macos-only --swift \
  --copy-resources --no-open --no-prompt --force
```

Le convertisseur réécrit aussi l’application conteneur (textes en français, en-têtes Swift) : avec
`git diff`, garder le nouveau `project.pbxproj` et rétablir le reste (`git checkout -- <fichier>`).

Le convertisseur vise aussi le macOS de la machine qui l’a lancé (27.0 par exemple), ce qui
empêcherait l’application de démarrer sur un macOS plus ancien : dans le nouveau `project.pbxproj`,
remettre toutes les lignes `MACOSX_DEPLOYMENT_TARGET` à `13.0` (le projet et la cible Fripon Extension).
`npm run safari:sync` refuse de continuer tant qu’une de ces lignes dépasse 13.0.

## Licence

AGPL-3.0, voir `LICENSE`.
