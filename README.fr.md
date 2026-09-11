# homebridge-xiaomi-go2rtc

[English version](README.md)

Plugin Homebridge qui amène les **caméras Xiaomi Mi Home dans l'app Maison d'Apple (HomeKit)** : vidéo en direct,
captures, son, orientation et réglages de la caméra.

Les caméras Xiaomi ne proposent pas de flux RTSP : elles diffusent avec le protocole P2P chiffré de Xiaomi. Le plugin
lance et pilote [go2rtc](https://github.com/AlexxIT/go2rtc), qui sait lire ce protocole, et présente chaque caméra
comme une caméra HomeKit.

> **Projet sans lien avec Xiaomi, Apple, Homebridge ou go2rtc.** Voir [Avertissement](#avertissement).

## Sommaire

- [Fonctionnalités](#fonctionnalités)
- [Fonctionnement](#fonctionnement)
- [Prérequis](#prérequis)
- [Installation](#installation)
- [Connecter le compte Xiaomi](#connecter-le-compte-xiaomi)
- [Déclarer une caméra non détectée](#déclarer-une-caméra-non-détectée)
- [Ajouter la caméra dans l'app Maison](#ajouter-la-caméra-dans-lapp-maison)
- [Performances vidéo](#performances-vidéo)
- [Son](#son)
- [Orientation et réglages de la caméra](#orientation-et-réglages-de-la-caméra)
- [À propos de go2rtc-xiaomi-control](#à-propos-de-go2rtc-xiaomi-control)
- [Référence de la configuration](#référence-de-la-configuration)
- [Sécurité et vie privée](#sécurité-et-vie-privée)
- [Dépannage](#dépannage)
- [Mise à jour et désinstallation](#mise-à-jour-et-désinstallation)
- [Avertissement](#avertissement)
- [Crédits et licence](#crédits-et-licence)

## Fonctionnalités

- Vidéo en direct et captures dans l'app Maison, pour chaque caméra du compte Xiaomi.
- Détection automatique des caméras, ou déclaration à la main pour celles que le cloud Xiaomi ne liste pas.
- Les caméras H.264 sont copiées telles quelles (presque aucun calcul). Les caméras H.265 sont réencodées en H.264,
  le seul codec accepté par HomeKit.
- Son du micro de la caméra.
- Interrupteurs d'orientation et interrupteurs de réglages (veille, voyant, suivi des mouvements, détection de
  mouvement, vision nocturne), regroupés avec la caméra.
- Rien d'autre à installer : le plugin télécharge et vérifie la version de go2rtc dont il a besoin.

Testé avec : Orange Pi One (Allwinner H3, armv7, 512 Mo, Armbian), Node.js 22, caméra **MJSXJ10CM** (Mi 360°
Camera 1080p, modèle `chuangmi.camera.026c02`, H.265), réencodée en temps réel en qualité SD.

## Fonctionnement

```
Caméra Xiaomi ──(réseau local, P2P chiffré)──► go2rtc ──(RTSP, 127.0.0.1 uniquement)──► FFmpeg ──(SRTP)──► iPhone / iPad
                         ▲
        clés de chiffrement demandées au cloud Xiaomi à chaque connexion
```

- La vidéo va de la caméra à votre serveur **sur le réseau local**, puis vers vos appareils Apple.
- go2rtc a besoin d'Internet à chaque connexion pour obtenir les clés de chiffrement auprès du cloud Xiaomi, avec
  votre compte.
- go2rtc ne se connecte à une caméra que pendant qu'on la regarde ou qu'une capture est demandée.
- La version de go2rtc utilisée par défaut est [go2rtc-xiaomi-control](#à-propos-de-go2rtc-xiaomi-control) : le
  go2rtc officiel plus un petit correctif public, compilé par GitHub Actions pour chaque version du plugin.

## Prérequis

- **Homebridge** 1.8 ou plus récent, avec **Node.js 22** ou plus récent (`node -v`).
- Un serveur pris en charge :

  | Système | Architectures | État |
  |---|---|---|
  | Linux (Raspberry Pi, Orange Pi, mini-PC, NAS, Docker) | armv6, armv7, arm64, x86, x64 | Testé sur armv7 |
  | macOS | Intel, Apple Silicon | Devrait fonctionner, pas encore testé |
  | Windows | x64 | Devrait fonctionner, pas encore testé |

  Le Raspberry Pi 5 n'est pas encore pris en charge par ffmpeg-for-homebridge : installez FFmpeg vous-même et
  renseignez `ffmpegPath`.
- Un **compte Xiaomi avec mot de passe**. go2rtc ne sait pas utiliser « Se connecter avec Google / Apple /
  Facebook » : voir [Connecter le compte Xiaomi](#connecter-le-compte-xiaomi).
- Surtout des caméras sorties après 2020 (protocole `xiaomi/miss` de go2rtc). Voir la
  [liste des caméras connues](https://github.com/AlexxIT/go2rtc/issues/1982) de go2rtc.
- Pour les caméras H.265, assez de puissance pour réencoder, ou la qualité SD de la caméra (voir
  [Performances vidéo](#performances-vidéo)).

## Installation

### 1. Installer le plugin

**Depuis Homebridge UI (conseillé) :** onglet **Plugins** → cherchez `homebridge-xiaomi-go2rtc` → **Installer**.

**Depuis un terminal**, avec le npm de votre installation Homebridge. Pour le savoir, lancez sur le serveur :

```bash
ps -eo user,args | grep [h]omebridge
```

| Ce que vous voyez | Commande |
|---|---|
| Utilisateur `homebridge`, chemins sous `/opt/homebridge` ou `/var/lib/homebridge` (image officielle, paquet apt) | `sudo -u homebridge /opt/homebridge/bin/npm install --prefix /var/lib/homebridge homebridge-xiaomi-go2rtc` |
| `homebridge` lancé depuis `/usr/lib/node_modules` ou `/usr/local/lib/node_modules` (installation npm globale) | `sudo npm install -g homebridge-xiaomi-go2rtc` |
| Docker (image `homebridge/homebridge`) | Dans Homebridge UI → menu (⋮) → **Terminal** : `npm install homebridge-xiaomi-go2rtc` |

Le paquet de chaque version est aussi joint aux
[releases GitHub](https://github.com/moguennouni/homebridge-xiaomi-go2rtc/releases) : remplacez
`homebridge-xiaomi-go2rtc` par l'URL de son fichier `.tgz` dans les commandes ci-dessus.

L'installation télécharge aussi [ffmpeg-for-homebridge](https://www.npmjs.com/package/ffmpeg-for-homebridge), ce qui
peut prendre quelques minutes sur une petite carte.

### 2. Configuration minimale

Dans Homebridge UI → **Plugins** → **Xiaomi Cameras (go2rtc)** → **Paramètres**, ou dans `config.json` :

```json
{
  "platform": "XiaomiGo2rtc",
  "name": "Xiaomi Cameras",
  "uiUsername": "admin",
  "uiPassword": "choisissez-un-mot-de-passe"
}
```

Renseignez **`uiUsername` et `uiPassword`** : sans eux, tout appareil du réseau local peut ouvrir l'interface
go2rtc et regarder vos caméras.

N'activez **pas** le « pont enfant » (*child bridge*) sur les petites cartes (512 Mo) : il lance un processus Node.js
de plus. Les caméras sont de toute façon des accessoires HomeKit séparés.

### 3. Redémarrer Homebridge

Au premier démarrage, le plugin télécharge go2rtc-xiaomi-control pour votre système depuis la release GitHub de sa
version, et vérifie son empreinte SHA-256 (inscrite dans le plugin lui-même). Les logs affichent ensuite :

```
Téléchargement de go2rtc-xiaomi-control 1.9.14-xiaomi-control...
go2rtc-xiaomi-control 1.9.14-xiaomi-control téléchargé et vérifié.
go2rtc-xiaomi-control démarré. Interface web : http://192.168.1.10:1984
Aucun compte Xiaomi connecté. Ouvrez http://192.168.1.10:1984, cliquez sur "Add" puis "Xiaomi"...
```

## Connecter le compte Xiaomi

Cela se fait une seule fois, dans l'interface go2rtc, et pas dans la configuration du plugin : votre mot de passe
Xiaomi n'est jamais enregistré par le plugin.

1. Si vous vous connectez d'habitude à Mi Home avec **Google, Apple ou Facebook**, ajoutez d'abord un mot de passe à
   votre compte Xiaomi : allez sur [account.xiaomi.com](https://account.xiaomi.com), connectez-vous comme d'habitude,
   notez votre **Xiaomi ID** (le numéro affiché sur la page du compte et dans Mi Home → Profil), puis **Sécurité** →
   **Mot de passe**. Xiaomi peut d'abord demander de lier et vérifier un e-mail ou un numéro de téléphone. Votre
   connexion habituelle continue de fonctionner.
2. Ouvrez l'interface go2rtc (`http://<ip-du-serveur>:1984`), avec `uiUsername` / `uiPassword`.
3. Cliquez sur **Add**, puis **Xiaomi**. Saisissez votre Xiaomi ID (ou l'e-mail / le téléphone) et le mot de passe,
   puis le code reçu par e-mail ou SMS, et le captcha s'il s'affiche.
4. Dans les 30 secondes, les logs Homebridge affichent chaque caméra détectée :

   ```
   Caméra ajoutée : "Salon" (chuangmi.camera.026c02, 192.168.1.50, did 123456789).
   ```

go2rtc enregistre un jeton (pas votre mot de passe) dans `xiaomi-go2rtc/go2rtc.yaml`, dans le dossier de stockage
de Homebridge (par exemple `/var/lib/homebridge`). Le fichier n'est lisible que par l'utilisateur qui fait tourner
Homebridge.

## Déclarer une caméra non détectée

Certaines caméras, comme la **MJSXJ10CM**, fonctionnent dans Mi Home mais sont absentes de la liste d'appareils que
le cloud Xiaomi fournit aux outils tiers. go2rtc répond alors « no sources » dans toutes les régions, et les logs
affichent `Aucune caméra trouvée automatiquement`. Elles restent utilisables si on fournit leur **adresse IP**, leur
**did** (identifiant de l'appareil) et leur **région**.

### Trouver le did, l'IP et la région automatiquement

Sur le serveur Homebridge (Linux ou macOS), avec le compte Xiaomi connecté dans go2rtc :

```bash
curl -fsSL -o /tmp/find-xiaomi-camera.sh https://raw.githubusercontent.com/moguennouni/homebridge-xiaomi-go2rtc/main/scripts/find-xiaomi-camera.sh
```

```bash
bash /tmp/find-xiaomi-camera.sh
```

Le script liste les appareils Xiaomi de votre réseau, puis essaie chacun dans chaque région du cloud Xiaomi (une à
deux minutes). Gardez la ligne marquée `OK` :

```
no      ip=192.168.1.50 did=123456789 region=de  (streams: xiaomi: permit deny)
OK      ip=192.168.1.50 did=123456789 region=sg  <-- declare this camera with these values
```

`permit deny` veut dire que le cloud Xiaomi refuse cet appareil dans cette région : c'est normal pour toutes les
régions sauf la vôtre. Si votre caméra n'apparaît pas du tout, donnez son IP (affichée dans Mi Home → caméra →
réglages → informations réseau) en deuxième argument : `bash /tmp/find-xiaomi-camera.sh 1984 192.168.1.50`.

À propos des régions : Mi Home demande un **pays**, go2rtc a besoin du **serveur Xiaomi** de ce pays : `de` (Europe),
`sg` (Singapour, utilisé aussi pour beaucoup d'autres pays), `us`, `ru`, `i2` (Inde), `cn` (Chine continentale). Le
script la trouve pour vous.

### Déclarer la caméra

Dans les paramètres du plugin → **Réglages par caméra** → ajoutez une caméra, ou dans `config.json` :

```json
"cameras": [
  {
    "did": "123456789",
    "ip": "192.168.1.50",
    "region": "sg",
    "model": "chuangmi.camera.026c02",
    "name": "Salon"
  }
]
```

`model` est facultatif pour la vidéo, mais indispensable pour les interrupteurs de réglages. Mi Home l'affiche en
général, avec le did, dans les réglages de la caméra → informations sur l'appareil (le nom du menu dépend de la
caméra). La MJSXJ10CM est une `chuangmi.camera.026c02`.

Donnez à la caméra une **adresse IP fixe** (réservation DHCP dans votre box) : une caméra déclarée n'est pas suivie
si son IP change.

## Ajouter la caméra dans l'app Maison

Chaque caméra est un accessoire séparé, qui ne fait pas partie du pont Homebridge :

1. App Maison → **+** → **Ajouter un accessoire** → **Autres options...**
2. Choisissez la caméra.
3. Saisissez le **code PIN de Homebridge** (le même que celui du pont).

La première ouverture de la vidéo prend 5 à 10 secondes : go2rtc obtient les clés auprès du cloud Xiaomi, puis
ouvre la connexion P2P.

## Performances vidéo

HomeKit n'accepte que la vidéo **H.264**. Les logs indiquent ce que la caméra envoie :

```
[Salon] Flux détecté : vidéo hevc, audio pcm_alaw → réencodage en H.264.
```

- **`h264`** : copié tel quel, sans problème sur n'importe quel serveur.
- **`hevc`** (H.265) : décodé et réencodé par FFmpeg, ce qui demande beaucoup de calcul. Sur les petites cartes,
  demandez le flux SD de la caméra : `"subtype": "sd"`.

Pour mesurer si votre serveur suit, fermez l'app Maison et lancez sur le serveur (adaptez le nom du flux,
`xiaomi_<did>` ; cet exemple correspond à une installation npm globale) :

```bash
F=$(npm root -g)/homebridge-xiaomi-go2rtc/node_modules/ffmpeg-for-homebridge/ffmpeg; [ -x "$F" ] || F=ffmpeg; "$F" -hide_banner -rtsp_transport tcp -i rtsp://127.0.0.1:8554/xiaomi_123456789 -t 30 -map 0:v:0 -c:v libx264 -preset ultrafast -tune zerolatency -pix_fmt yuv420p -vf "scale='min(1280,iw)':-2:flags=fast_bilinear" -b:v 800k -f null - 2>&1 | tr '\r' '\n' | grep -E "Video: |speed=" | sed -n '1p;$p'
```

Un `speed=` final de **1.0x ou plus** signifie temps réel. Pour comparaison, un Orange Pi One atteint 0.85x en HD
(1920×1080) et 1.03x en SD (640×360).

## Son

À activer par caméra avec `"audio": true`. Le son est converti en AAC-ELD pour HomeKit.

Certaines caméras (par exemple la `chuangmi.camera.026c02`) envoient un son à 16 kHz, que le go2rtc officiel
étiquette 8 kHz : la voix paraît alors grave et ralentie. go2rtc-xiaomi-control, utilisé par défaut, mesure la vraie
fréquence et corrige le problème. Seulement si vous utilisez le go2rtc officiel (`useOfficialGo2rtc`), réglez
`"audioSampleRate": 16000` sur une telle caméra.

## Orientation et réglages de la caméra

- **Orientation** (`"ptz": true`) : quatre interrupteurs, Gauche / Droite / Haut / Bas. Ils ne fonctionnent **que
  pendant que la vidéo est ouverte**, car la commande passe par la connexion vidéo.
- **Réglages** (`"settings": true`) : Veille, Voyant, Suivi des mouvements, Détection de mouvement, Vision nocturne
  (automatique ou désactivée), selon ce que le modèle propose. Le plugin les trouve dans la spécification MIoT
  publique du modèle (miot-spec.org) : `model` doit donc être connu (automatique pour une caméra détectée). Ils
  passent par le cloud Xiaomi et sont relus toutes les minutes, pour suivre les changements faits dans Mi Home.

### Directions et amplitude

Les directions ont été vérifiées sur la `chuangmi.camera.026c02`, où un pas horizontal est petit (environ 3 unités)
et un pas vertical plus grand (environ 9). Augmentez `ptzPanSteps` / `ptzTiltSteps` pour bouger davantage à chaque
appui. Sur un autre modèle, si une direction est fausse, modifiez `ptzLeft`, `ptzRight`, `ptzUp`, `ptzDown` (par
défaut : `{"operation":2}`, `{"operation":1}`, `{"operation":4}`, `{"operation":3}`). Pour tester une commande à la
main, vidéo ouverte :

```bash
curl -s -X POST -G http://127.0.0.1:1984/api/xiaomi/command --data-urlencode src=xiaomi_123456789 --data-urlencode cmd=0x112 --data-urlencode 'data={"operation":1}'
```

La réponse contient `"ret":0` quand la caméra a accepté la commande, ainsi que la position du moteur.

### Regroupement dans l'app Maison

Tous les interrupteurs sont rattachés au service caméra. Si l'app Maison les affiche en tuiles séparées : appui long
sur la caméra → ⚙️ → désactivez l'affichage en tuiles séparées si l'option est proposée, ou mettez la caméra et ses
interrupteurs dans la même pièce. L'app Maison ne permet pas d'ajouter des boutons dans la vidéo en plein écran.

## À propos de go2rtc-xiaomi-control

Le go2rtc officiel ne sait ni orienter la caméra, ni modifier ses réglages, ni détecter un son à 16 kHz.
go2rtc-xiaomi-control est une version **non officielle** de go2rtc 1.9.14 avec un petit
[correctif](go2rtc-xiaomi-control/go2rtc-xiaomi-control.patch) public (environ 230 lignes, décrit dans
[go2rtc-xiaomi-control/README.md](go2rtc-xiaomi-control/README.md)).

- Elle est compilée par GitHub Actions à partir du code officiel de go2rtc et du correctif, pour chaque version du
  plugin ([workflow](.github/workflows/release.yml), journaux de compilation publics).
- Le plugin télécharge le binaire de sa propre version et le refuse si son empreinte SHA-256 diffère de celle
  inscrite dans le plugin.
- Les compilations sont reproductibles : `bash scripts/build-go2rtc.sh` reproduit les mêmes binaires.
- Sa version s'affiche `1.9.14-xiaomi-control+dev.b5948cf.dirty` : révision `b5948cf` de go2rtc (l'étiquette
  v1.9.14), avec des modifications locales.
- Elle n'est ni faite ni soutenue par l'auteur de go2rtc : signalez ses problèmes ici, jamais au projet go2rtc.

Pour utiliser un autre go2rtc : `useOfficialGo2rtc` télécharge le go2rtc officiel 1.9.14 (Linux uniquement, sans
orientation, réglages ni correction du son), et `go2rtcPath` lance un binaire go2rtc que vous avez installé vous-même.

## Référence de la configuration

### Réglages généraux

| Clé | Par défaut | Description |
|---|---|---|
| `platform` | | Doit valoir `XiaomiGo2rtc` |
| `name` | `Xiaomi Cameras` | Nom de la plateforme dans les logs |
| `uiUsername`, `uiPassword` | aucun | Identifiants de l'interface go2rtc depuis le réseau local. **Fortement conseillé.** |
| `region` | automatique | Serveur Xiaomi du compte (`de`, `sg`, `us`, `ru`, `i2`, `cn`). Accélère la détection ; c'est aussi la région par défaut des caméras déclarées |
| `apiPort` | `1984` | Port de l'interface et de l'API go2rtc |
| `rtspPort` | `8554` | Port RTSP local de go2rtc (écoute uniquement sur 127.0.0.1) |
| `useOfficialGo2rtc` | `false` | Avancé : télécharger le go2rtc officiel 1.9.14 au lieu de go2rtc-xiaomi-control |
| `go2rtcPath` | | Avancé : chemin d'un binaire go2rtc à lancer à la place de celui téléchargé |
| `ffmpegPath` | ffmpeg-for-homebridge | Chemin d'un autre FFmpeg |
| `cameras` | `[]` | Réglages par caméra, voir ci-dessous |

### Réglages par caméra (`cameras[]`)

| Clé | Par défaut | Description |
|---|---|---|
| `did` | **obligatoire** | Identifiant Xiaomi de l'appareil, affiché dans les logs quand une caméra est détectée |
| `name` | nom Mi Home | Nom dans HomeKit |
| `hidden` | `false` | `true` pour ne pas exposer cette caméra |
| `ip` | | Adresse IP : déclare la caméra à la main (caméras non détectées) |
| `region` | `region` générale, sinon `de` | Serveur Xiaomi d'une caméra déclarée |
| `model` | | Modèle Xiaomi, par exemple `chuangmi.camera.026c02`. Indispensable pour `settings` sur une caméra déclarée |
| `account` | premier compte | Identifiant du compte Xiaomi, si plusieurs comptes sont connectés dans go2rtc |
| `subtype` | défaut de la caméra | Qualité demandée à la caméra : `hd`, `sd` |
| `videoMode` | `auto` | `auto` (copie si H.264, sinon réencodage), `copy`, `transcode` |
| `encoder` | `libx264` | Encodeur H.264 en réencodage, par exemple `h264_v4l2m2m` (matériel, selon la carte) |
| `maxWidth` | `1280` | Largeur maximale en réencodage |
| `audio` | `false` | Son de la caméra |
| `audioSampleRate` | `0` | `16000` corrige un son grave et ralenti, avec le go2rtc **officiel** uniquement |
| `settings` | `false` | Interrupteurs de réglages |
| `ptz` | `false` | Interrupteurs d'orientation |
| `ptzPanSteps`, `ptzTiltSteps` | `1` | Pas du moteur par appui, horizontal et vertical |
| `ptzLeft`, `ptzRight`, `ptzUp`, `ptzDown` | voir plus haut | Avancé : contenu de la commande d'orientation |

Un exemple complet se trouve dans [config.example.json](config.example.json).

## Sécurité et vie privée

| Port | Écoute sur | Rôle |
|---|---|---|
| 1984 (`apiPort`) | réseau local | Interface et API go2rtc, protégées par `uiUsername` / `uiPassword` |
| 8554 (`rtspPort`) | 127.0.0.1 uniquement | Flux lus par FFmpeg |
| 8555 | réseau local | WebRTC de go2rtc (aperçu dans l'interface) |

- N'ouvrez pas ces ports sur votre box.
- Le jeton du compte Xiaomi est enregistré dans `xiaomi-go2rtc/go2rtc.yaml` (droits 600). Votre mot de passe n'est
  pas enregistré.
- Ce qui passe par Internet : go2rtc contacte le cloud Xiaomi (connexion, liste des appareils, clés de chiffrement,
  réglages de la caméra) ; le plugin télécharge go2rtc depuis GitHub et les spécifications MIoT depuis
  miot-spec.org. La vidéo elle-même reste sur votre réseau local. Quand vous regardez hors de chez vous, HomeKit la
  relaie, chiffrée de bout en bout, via votre concentrateur.

## Dépannage

Lancez Homebridge en mode debug (`-D`, dans Homebridge UI → Paramètres Homebridge) pour voir les messages de go2rtc
et de FFmpeg.

| Symptôme | Cause | Solution |
|---|---|---|
| « no sources » dans toutes les régions dans go2rtc, `Aucune caméra trouvée automatiquement` | Le cloud Xiaomi ne liste pas cette caméra | [La déclarer](#déclarer-une-caméra-non-détectée) |
| `streams: xiaomi: permit deny` | Mauvaise région (ou mauvais did) pour ce compte | Lancer `find-xiaomi-camera.sh` |
| `Capture d'écran impossible ... 404 Not Found` | go2rtc n'arrive pas à ouvrir le flux | Regarder la ligne go2rtc juste avant |
| `Échec du téléchargement de go2rtc-xiaomi-control` | Pas d'accès à Internet ou à GitHub au premier démarrage | Vérifier la connexion, redémarrer Homebridge |
| `Empreinte SHA-256 ... invalide` | Le fichier téléchargé n'est pas celui attendu | Réessayer ; si ça persiste, ouvrir une *issue* (ne jamais contourner cette vérification) |
| Vidéo saccadée ou en retard, processeur à 100 % | Réencodage H.265 trop lourd | `"subtype": "sd"`, baisser `maxWidth` |
| Voix grave et ralentie | Son à 16 kHz étiqueté 8 kHz | Garder go2rtc-xiaomi-control (par défaut), ou `"audioSampleRate": 16000` avec le go2rtc officiel |
| `Ce go2rtc ne gère pas l'orientation` / `les réglages` | C'est le go2rtc officiel ou un go2rtc personnalisé qui tourne | Retirer `go2rtcPath` et `useOfficialGo2rtc` |
| `Ouvrez la caméra dans l'app Maison pour pouvoir l'orienter` | Orientation demandée vidéo fermée | Ouvrir d'abord la vidéo |
| `Modèle "..." inconnu de miot-spec.org` | `model` absent ou faux | Renseigner `model` |
| `modification impossible (refusé par le cloud Xiaomi (code ...))` | Ce modèle n'accepte pas ce réglage par le cloud | Le modifier dans Mi Home |
| `sudo: unknown user homebridge` pendant l'installation | Homebridge n'est pas installé avec l'image officielle | Utiliser la commande de votre type d'installation |

Vérifiez aussi le flux dans l'interface go2rtc (onglet Streams) : s'il ne s'affiche pas là, le problème est entre
go2rtc et la caméra, pas dans HomeKit.

## Mise à jour et désinstallation

- **Mise à jour** : depuis Homebridge UI (Plugins → Mettre à jour), ou avec la commande d'installation. Au démarrage
  suivant, le plugin télécharge le go2rtc-xiaomi-control de la nouvelle version et supprime l'ancien. La
  configuration et la connexion Xiaomi sont conservées.
- **Désinstallation** : retirez la plateforme de la configuration, désinstallez le plugin (Homebridge UI, ou
  `npm uninstall` au lieu de `npm install` dans la commande d'installation), puis supprimez le dossier
  `xiaomi-go2rtc` du dossier de stockage de Homebridge : il contient le jeton du compte Xiaomi et go2rtc. Retirez
  les caméras de l'app Maison.

## Avertissement

- Ce projet n'est **ni affilié, ni approuvé, ni soutenu** par Xiaomi, Apple, le projet Homebridge ou l'auteur de
  go2rtc. Xiaomi, Mi Home, Apple, HomeKit et les autres noms sont des marques de leurs propriétaires respectifs,
  citées uniquement pour décrire la compatibilité.
- **go2rtc-xiaomi-control n'est pas une version officielle de go2rtc.** Signalez ses problèmes ici, pas au projet
  go2rtc.
- Le plugin utilise votre propre compte Xiaomi et les mêmes services cloud que l'app Mi Home. Xiaomi peut les changer
  à tout moment, ce qui peut empêcher le plugin de fonctionner. Utilisez-le à vos risques et dans le respect des
  conditions des services que vous utilisez.
- Le logiciel est fourni « tel quel », sans aucune garantie (voir [LICENSE](LICENSE)).

## Crédits et licence

- [go2rtc](https://github.com/AlexxIT/go2rtc) d'Alexey Khit (MIT) fait tout le travail de streaming Xiaomi.
- [ffmpeg-for-homebridge](https://github.com/homebridge/ffmpeg-for-homebridge) fournit FFmpeg.
- Licences tierces : [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
- Ce plugin : [MIT](LICENSE), Copyright (c) 2026 Amine GUENNOUNI.
- Mainteneurs : [docs/RELEASING.md](docs/RELEASING.md).
