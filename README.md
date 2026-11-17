# Genopsys OpenClaw mail router 0.3.0-experimental.5

Prototype indépendant du bundle IMAP d’OpenClaw. Conserve l’identifiant de plugin `santal-mail-router` mais utilise un nouvel état propre et des bibliothèques npm déclarées (`imapflow`, `mailparser`). Aucun import depuis `/app/dist`, aucune empreinte du build 2026.11.3.

État : candidate expérimentale. Les dépendances npm sont verrouillées dans
`npm-shrinkwrap.json`, inclus dans l'archive pour les installations. Les tests
incluent un vrai parsing MIME et des appels HTTP locaux. La connexion au vrai
serveur IMAP et la livraison WhatsApp restent à valider sur l’installation cible.

## Fonctionnement

`index.mjs` enregistre le service OpenClaw et démarre un polling IMAP (60 s par défaut). `collector.mjs` traite les UID successifs, accepte les messages MIME jusqu’à 15 Mio et utilise uniquement une boîte ouverte en lecture seule. `auth.mjs` contrôle l’expéditeur autorisé et une assertion DMARC du serveur de réception explicitement approuvé. `routes.mjs` choisit la route et vérifie l’agent et son binding. `webhook.mjs` utilise uniquement le point d’entrée HTTP public `/hooks/agent`, y compris pour le fallback sans publication.

L’indépendance porte sur le collecteur : le plugin reste dépendant des contrats publics de service et de webhook d’OpenClaw, dont la compatibilité doit être testée sur les versions ciblées.

## Analyse documentaire expérimentale

L'analyse documentaire est désactivée par défaut. Lorsqu'elle est activée, le
collecteur appelle un service séparé **après** validation du destinataire et de
l'expéditeur, avant l'enregistrement de l'intention de livraison. Si l'analyse
échoue, le curseur reste inchangé et aucun webhook n'est envoyé. Une nouvelle
tentative peut refaire les GET des liens ; elle ne renvoie pas automatiquement
un webhook déjà admis.

Le service extrait le texte des PDF et des pages HTML ou texte. Les PDF sans
texte sont signalés : l'OCR et les formats Office ne sont pas pris en charge.
Les noms des autres pièces jointes sont rapportés comme non traités. Le
collecteur refuse les messages MIME dépassant 15 Mio (15 × 1024 × 1024 octets) ;
ce plafond
inclut l'encodage des pièces jointes.

L'extraction accepte uniquement HTTPS sur les hôtes exacts
`marches-securises.fr`, `boamp.fr`, `marches-publics.gouv.fr`,
`achatpublic.com`, `aws-achat.info` et `e-marchespublics.com`, ainsi que leur
variante `www` explicite. Chaque redirection est revérifiée, les adresses DNS
non publiques sont refusées et l'adresse vérifiée est utilisée pour la connexion
TLS. Les autres sous-domaines ne sont pas autorisés. Les refus et erreurs
sont inclus dans l'analyse ; les liens hors liste sont comptés et aucun accès
n'est tenté sur un domaine refusé. Les connexions sortantes utilisent IPv4 ;
un site uniquement IPv6 est signalé comme inaccessible.
Les pages dépendantes de JavaScript ne sont pas rendues.

Le service accepte au maximum cinq PDF (15 Mio maximum par pièce jointe) et
cinq liens par mail. Les documents téléchargés depuis des liens restent limités
à 1 Mio avant et après décompression gzip. L'extraction est limitée à 20 pages
par PDF et 40 000 caractères au total.
Le texte transmis au webhook respecte `maxBytes` et signale sa troncature ; ce
plafond de livraison est distinct de la limite de réception des mails.
`includeBody: false` empêche l'extraction de liens depuis le corps du mail.
Tout texte extrait reste une donnée externe non fiable, et peut être transmis
au fournisseur du modèle.

Pour un essai isolé, fournir à la Gateway les variables
`MAIL_ROUTER_ANALYZER_URL` (URL HTTPS d'un service Kubernetes en
`.svc.cluster.local`, chemin `/analyze`) et `MAIL_ROUTER_ANALYZER_TOKEN`
(au moins 32 caractères ASCII visibles). Le même token est fourni au service
comme `ANALYZER_TOKEN`. Le service exige les chemins de certificat et clé TLS
`ANALYZER_TLS_CERT_FILE` et `ANALYZER_TLS_KEY_FILE`. La Gateway doit faire
confiance à l'autorité du certificat, dont le nom doit correspondre au service.
Les variables du client doivent être absentes pour garder le comportement
historique. Ne pas mettre le token ou la clé privée dans Git.

Le prototype du service est dans `analyzer/` :

```sh
python3 -m pip install -r analyzer/requirements.txt
python3 -m unittest discover -s analyzer -p 'test_*.py'
```

L'image de base du Dockerfile est épinglée par digest et le paquet PDF par
version et empreinte. Le Dockerfile n'a pas été qualifié en production. Avant tout
déploiement, construire et épingler l'image, isoler le service et ses sorties
au niveau réseau, protéger le trafic et le token, limiter ses ressources, et
tester les NetworkPolicies et le traitement de documents malveillants. La
liste de domaines du code ne constitue pas à elle seule une barrière contre
un processus compromis. Aucune de ces étapes ne modifie les curseurs IMAP.

## Authentification

Cette candidate supporte uniquement `senderAuth.min: asserted`, `acceptTrustedAuthservId: true`, et une liste explicite de `trustedAuthservIds`. Elle requiert un unique résultat DMARC pass, correspondant exactement au domaine du From, rapporté par le serveur approuvé. Une liste `allowedSenders` est obligatoire. Les doublons et syntaxes non reconnues sont refusés. Il faut que le serveur de réception retire les en-têtes d’authentification forgés ; le nom authserv-id seul n’est pas une preuve cryptographique. Le mode cryptographique autonome et les addressTokens ne sont pas implémentés. La candidate doit être testée contre les vrais en-têtes OVH avant migration.

## État et reprise

Fichier : `$OPENCLAW_STATE_DIR/santal-mail-router-independent/state.json` (ou `~/.openclaw/santal-mail-router-independent/state.json`). Le collecteur écrit le curseur atomiquement, synchronise les données et prend un verrou exclusif. Un verrou abandonné après arrêt brutal nécessite une vérification manuelle de l’arrêt des anciens processus avant suppression de `collector.lock`.

Chaque demande est enregistrée AVANT l’appel HTTP. Si le processus s’arrête entre l’appel et sa confirmation, le mail reste en `pending` et la boîte est bloquée pour réconciliation manuelle. Cela évite un renvoi automatique incertain ; ce n’est pas une garantie de livraison exactement une fois. Après vérification dans les logs et le groupe, un opérateur doit soit considérer l’UID comme terminé et avancer le curseur, soit autoriser explicitement un nouvel essai. Ne jamais supprimer un pending sans cette vérification.

Un changement d’UIDVALIDITY ou un curseur incohérent bloque la reprise. Les erreurs terminales d’un run admis sont enregistrées et ne provoquent pas de nouvelle annonce automatique. Le fallback ne publie pas dans un canal.

## Premier démarrage et migration depuis 0.1/0.2

Ne pas lancer deux collecteurs sur la même boîte. Sauvegarder configuration et ancien état, puis désactiver l’ancien collecteur. Conserver son code pour rollback.

Deux choix, à décider avec l’opérateur :

1. Nouveaux mails seulement : configurer explicitement `startFrom: "now"`. Le premier passage enregistre UIDNEXT-1 et ignore les mails déjà présents, y compris ceux encore en attente de l’ancien collecteur.
2. Reprendre les mails en attente : exporter le dernier UID réellement terminé et UIDVALIDITY de l’ancien compte, puis importer le curseur avant démarrage. Pas d’export automatique de l’ancien stockage à ce stade ; son format doit être inspecté sur Aisa. Ne jamais deviner cet UID.

Exemple d’export attendu (valeurs fictives) :

```json
{"aisa":{"uidValidity":"123456","lastSeenUid":266}}
```

Prévalidation, sans écriture :

```sh
node scripts/import-cursors.mjs --state-dir /chemin/etat --input cursors.json
```

Ajouter `--write` pour importer dans un nouvel état vide. Le script refuse d’écraser un état existant. Il ne reprend pas les anciens anneaux de Message-ID : un message réinjecté sous un nouvel UID peut être traité. Le curseur ne permet pas à lui seul de déterminer un envoi dont le statut était incertain ; inspecter les derniers runs avant bascule.

Les routes restent au format de la 0.2. Si Aisa tourne encore avec les routes WETY codées en dur de la 0.1, sa configuration doit d’abord être enrichie avec `routes` et `recipientNamespaces` sans remplacer ses identifiants réels.

## Étapes restantes sur l’installation expérimentale

1. Disposer de l’accès au cluster de test.
2. Installer avec `npm ci --ignore-scripts`, lancer les tests puis vérifier une connexion IMAP de lecture seule.
3. Sauvegarder et inspecter Aisa : version, plugin actif, configuration sans affichage des secrets, états et logs récents.
4. Décider baseline ou import de curseur, arrêter l’ancien collecteur, installer la candidate désactivée, valider la configuration et reprendre.
5. Envoyer un nouveau mail autorisé ; vérifier UID, run de l’agent WETY et présence du résumé dans le groupe. Tester un mail ordinaire, un alias inconnu et une reprise après redémarrage.
6. Réactiver l’ancienne version en cas d’échec, après réconciliation des UID traités pendant le test pour éviter une double publication.

Documentation des dépendances : https://imapflow.com/docs/api/imapflow-client/ et https://nodemailer.com/extras/mailparser/.


## Développement et vérification

```sh
git clone https://github.com/Genopsys-io/openclaw-mail-router.git
cd openclaw-mail-router
npm ci --ignore-scripts
npm run check
npm test
npm pack
```

La CI GitHub exécute ces contrôles sous Node 22.19.0 et Node 24 et conserve une archive npm en artefact. Elle teste aussi l'analyseur sous Python 3.13, construit son image et vérifie son démarrage Python sans privilèges ; elle ne publie pas l'image. Aucun mail réel n’est utilisé et aucun message WhatsApp n’est envoyé par la CI. Le fichier `examples/config.json` est fictif ; adapter ses comptes, routes et références d’environnement dans la configuration de l’instance.

## Installation depuis une archive

La version du dépôt n’est pas nécessairement publiée sur npm. Une archive construite avec `npm pack` peut être copiée sur l’hôte puis installée via le CLI OpenClaw :

```sh
openclaw plugins install /tmp/genopsys-openclaw-mail-router-0.3.0-experimental.5.tgz --no-enable
```

Adapter les options d’acceptation des capacités à la version du CLI. Préparer la configuration avant activation et ne pas laisser fonctionner l’ancien collecteur en parallèle. Pour l’installation via le registre une fois la version publiée :

```sh
openclaw plugins install npm:@genopsys/openclaw-mail-router@0.3.0-experimental.5 --no-enable
```

Le package npm et l’ID OpenClaw sont distincts : le premier est `@genopsys/openclaw-mail-router`, le second reste `santal-mail-router`.

## Publication npm

Le package conserve `publishConfig.access: restricted`. Il faut disposer du scope npm `@genopsys` avec les droits et l’offre nécessaires ; l’existence de l’organisation GitHub ne confère aucun droit npm. Aucun secret d’installation client n’appartient au dépôt ni au package. Aucune licence de redistribution n’a été choisie : les métadonnées indiquent `UNLICENSED`.

Avant une première publication, valider la candidate sur OpenClaw, puis un mainteneur peut publier explicitement depuis son poste authentifié :

```sh
npm ci --ignore-scripts
npm login
npm publish --tag experimental
```

`prepack` exécute la vérification de syntaxe et les tests avant construction/publication. Une préversion ne doit pas devenir `latest`.

Pour les publications suivantes, le workflow **Publish npm package** (`.github/workflows/publish.yml`) est uniquement manuel et refuse les branches autres que `main`. Il utilise l’environnement GitHub `npm` et OIDC. Dans les paramètres npm du package, ajouter un trusted publisher avec les valeurs exactes :

- GitHub owner : `Genopsys-io`
- Repository : `openclaw-mail-router`
- Workflow filename : `publish.yml`
- Environment : `npm`

Créer/configurer l’environnement GitHub `npm` et ses éventuelles règles d’approbation avant d’utiliser ce workflow. La publication manuelle initiale permet d’accéder aux paramètres du package. Aucun jeton npm de publication permanent n’est requis pour OIDC. Le workflow teste et construit la version indiquée par `package.json` ; modifier sa version avant chaque nouvelle publication.

Référence : [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/).


## Configuration par environnement (0.3.0-experimental.2)

Le mode JSON existant reste inchangé. Pour une boîte IMAP configurée par environnement, activez explicitement ce mode :

```sh
openclaw config set plugins.entries.santal-mail-router.config '{"fromEnv":true}' --strict-json
```

Cette commande remplace la configuration du plugin. Sauvegardez-la avant de migrer une instance existante. Ne combinez pas `fromEnv:true` avec `accounts`, `routes`, `recipientNamespaces` ou `startFrom` dans le JSON : le schéma et le runtime refusent ce mélange pour éviter une priorité implicite entre deux configurations.

`openclaw config validate` vérifie la forme du JSON ; la présence et les valeurs des variables sont vérifiées au démarrage du service. Une erreur indique le nom de la variable manquante, sans sa valeur.

Les variables sont lues dans **process.env de la gateway au démarrage du service**, pas dans un fichier `.env` chargé implicitement. Copier `.env.example` vers un fichier privé, remplacer les valeurs fictives puis injecter ce fichier ou un Secret dans le processus gateway. Un export dans un autre shell du conteneur ne modifie pas l’environnement de la gateway déjà démarrée.

### Variables obligatoires pour une route

| Variable | Fonction |
|---|---|
| `MAIL_ROUTER_HOST` | Hôte IMAP |
| `MAIL_ROUTER_USER` | Identifiant IMAP |
| `MAIL_ROUTER_PASSWORD` | Mot de passe IMAP, jamais recopié dans la configuration persistée |
| `MAIL_ROUTER_FALLBACK_AGENT_ID` | Agent pour les mails ordinaires, sans publication |
| `MAIL_ROUTER_ALLOWED_SENDERS` | Adresses ou `@domain`, séparées par des virgules |
| `MAIL_ROUTER_TRUSTED_AUTHSERV_IDS` | Serveurs d’authentification approuvés, séparés par des virgules |
| `MAIL_ROUTER_TRUST_RECEIVER` | Doit être exactement `true`, après vérification du traitement des en-têtes par le serveur mail |
| `MAIL_ROUTER_RECIPIENT` | Alias de la route (ou plusieurs alias du même client, séparés par des virgules) |
| `MAIL_ROUTER_AGENT_ID` | Agent dédié à cette route |
| `MAIL_ROUTER_WHATSAPP_GROUP` | Groupe destinataire, au format `123@g.us` |

### Variables facultatives

| Variable | Valeur par défaut |
|---|---|
| `MAIL_ROUTER_ACCOUNT_ID` | `shared` |
| `MAIL_ROUTER_ROUTE_ID` | `default` |
| `MAIL_ROUTER_RECIPIENT_NAMESPACE` | Valeur de `MAIL_ROUTER_USER` ; obligatoire explicitement si le login n’est pas une adresse principale sans plus-alias |
| `MAIL_ROUTER_PORT` | `993` (TLS obligatoire) |
| `MAIL_ROUTER_MAILBOX` | `INBOX` |
| `MAIL_ROUTER_CHANNEL_ACCOUNT_ID` | `default` |
| `MAIL_ROUTER_POLL_SECONDS` | `60`, minimum 15 |
| `MAIL_ROUTER_MAX_BYTES` | `20000`, entre 256 et 1048576 |
| `MAIL_ROUTER_START_FROM` | Omis : un curseur importé/existant est nécessaire ; `now` initialise au dernier UID, sans traiter les mails déjà présents |

Sur une instance existante, conserver l’ID du compte (par exemple `aisa`) et l’ID de route (par exemple `wety-veille`) pour préserver les curseurs et les identités de requêtes. Ne pas supprimer le répertoire d’état pour tester une autre configuration.

### Plusieurs clients sur la même boîte

Définir `MAIL_ROUTER_ROUTES_JSON` avec le tableau complet de routes au format de `examples/config.json`. Chaque route référence `MAIL_ROUTER_ACCOUNT_ID` (ou `shared` par défaut). Dans ce mode, retirer les variables de route simple : `MAIL_ROUTER_RECIPIENT`, `MAIL_ROUTER_AGENT_ID`, `MAIL_ROUTER_WHATSAPP_GROUP`, `MAIL_ROUTER_CHANNEL_ACCOUNT_ID` et `MAIL_ROUTER_ROUTE_ID`. Un mélange est refusé.

Le mode environnement couvre une boîte IMAP et plusieurs routes. Pour plusieurs boîtes, garder la configuration JSON existante et ses références de secrets par environnement.

### Injection dans Docker ou Kubernetes

Docker Compose : utiliser le fragment `examples/docker-env.yaml` dans le service gateway existant. Le fichier privé doit se nommer `mail-router.env` dans l’exemple. Le plugin lui-même ne lit pas ce fichier.

Kubernetes : créer un Secret depuis un fichier privé (à exécuter avec le bon namespace), puis ajouter le fragment `examples/kubernetes-env.yaml` au Deployment gateway :

```sh
kubectl -n MON_NAMESPACE create secret generic mail-router-env --from-env-file=mail-router.env
```

Redémarrer/recréer le conteneur après changement des variables. Un simple rechargement du plugin ne récupère pas les valeurs d’un Secret modifié pour un pod déjà lancé.

Les agents, leurs outils, les bindings WhatsApp et `hooks` restent configurés par OpenClaw. Le plugin ne les crée pas et ne change pas leurs autorisations. Le jeton du webhook peut garder la référence `${MAIL_ROUTER_HOOK_TOKEN}` dans `hooks.token`, mais cette variable n’est pas lue par le générateur de routes et ne configure pas automatiquement les hooks.

Ordre conseillé : injecter l’environnement → configurer les agents/bindings/hooks → définir `fromEnv:true` → valider → redémarrer la gateway → activer le plugin → attendre la baseline avant le premier mail. Le mode environnement est signalé dans les dangerousFlags du manifeste pour rendre visible la confiance dans les assertions du serveur de réception, même sans bloc senderAuth dans le JSON.
