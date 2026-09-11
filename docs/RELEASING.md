# Publier une version (mainteneur)

## Principe

Tout est fait par GitHub Actions (`.github/workflows/release.yml`) quand on pousse une étiquette `vX.Y.Z` :

1. compilation de go2rtc-xiaomi-control pour toutes les plateformes, à partir du code officiel de go2rtc et du
   correctif, sans rien d'autre ;
2. attestation d'origine des binaires (dépôt public uniquement) ;
3. empreintes SHA-256 inscrites dans `lib/go2rtc-binaries.json` du paquet npm ;
4. création de la release GitHub : binaires, `SHA256SUMS`, licence de go2rtc, correctif, paquet `.tgz` ;
5. publication sur npm, seulement si la variable de dépôt `NPM_PUBLISH` vaut `true` et que le dépôt est public.

Le plugin installé télécharge ensuite le binaire de sa plateforme depuis la release **de sa propre version** et
vérifie son empreinte. **Une release ne doit donc jamais être supprimée ni ses fichiers remplacés** : les
installations de cette version ne pourraient plus démarrer.

## Publier une nouvelle version

1. Mettre à jour `version` dans `package.json` et ajouter une section `## X.Y.Z` dans `CHANGELOG.md`.
2. Commit, puis étiquette et envoi :

   ```bash
   git tag vX.Y.Z
   ```

   ```bash
   git push origin main vX.Y.Z
   ```

3. Suivre l'exécution dans l'onglet **Actions** du dépôt.

## Première publication sur npm (une seule fois)

npm ne permet de configurer la publication automatique que pour un paquet qui existe déjà. La première version se
publie donc à la main, **après** avoir rendu le dépôt public :

1. Créer un compte sur [npmjs.com](https://www.npmjs.com) et activer la double authentification.
2. Pousser l'étiquette de la version : la release GitHub est créée (sans publication npm).
3. Télécharger le `.tgz` de cette release : c'est le paquet construit par GitHub Actions, avec les empreintes des
   binaires. Ne pas publier un paquet construit sur son PC, qui aurait `lib/go2rtc-binaries.json` vide.
4. Le publier :

   ```bash
   npm login
   ```

   ```bash
   npm publish homebridge-xiaomi-go2rtc-X.Y.Z.tgz --access public
   ```

5. Sur npmjs.com → le paquet → **Settings** → **Trusted Publisher** → GitHub Actions : utilisateur `moguennouni`,
   dépôt `homebridge-xiaomi-go2rtc`, workflow `release.yml`.
6. Sur GitHub → **Settings** → **Secrets and variables** → **Actions** → **Variables** : créer `NPM_PUBLISH` = `true`.

Les versions suivantes sont publiées automatiquement par l'étape 5 du workflow, sans jeton npm stocké.

## Mettre à jour go2rtc

1. Changer `GO2RTC_VERSION` dans `scripts/build-go2rtc.sh`, les versions dans le correctif (`main.go`) et dans
   `lib/go2rtc.js` (binaires officiels de secours et leurs empreintes, publiées sur la release go2rtc).
2. Vérifier que le correctif s'applique encore : `bash scripts/build-go2rtc.sh`. S'il ne s'applique plus, refaire les
   modifications sur le nouveau code et régénérer le correctif (`git diff` dans le dossier go2rtc).
3. Tester, puis publier une nouvelle version du plugin.

## Vérifier un binaire publié

Les compilations Go étant reproductibles, n'importe qui peut recompiler avec `bash scripts/build-go2rtc.sh` (même
version de Go que celle affichée dans le journal GitHub Actions) et comparer les empreintes. Pour un dépôt public,
l'attestation se vérifie aussi avec :

```bash
gh attestation verify go2rtc-xiaomi-control_linux_arm --repo moguennouni/homebridge-xiaomi-go2rtc
```
