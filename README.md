# Genopsys OpenClaw mail router 0.3.0-experimental.1

Prototype indépendant du bundle IMAP d’OpenClaw. Conserve l’identifiant de plugin `santal-mail-router` mais utilise un nouvel état propre et des bibliothèques npm déclarées (`imapflow`, `mailparser`). Aucun import depuis `/app/dist`, aucune empreinte du build 2026.11.3.

État réel : 18 tests locaux passés avec clients IMAP, parsing et HTTP simulés. Dépendances non installées : la tentative npm hors ligne a échoué (`ENOTCACHED` pour imapflow) et l’accès réseau n’a pas été accordé. Aucun lockfile validé, aucun test du vrai parseur, de TLS, de l’instance OpenClaw ou de WhatsApp pour cette version. Ne pas publier cette candidate comme validée.

## Fonctionnement

`index.mjs` enregistre le service OpenClaw et démarre un polling IMAP (60 s par défaut). `collector.mjs` traite les UID successifs, limite les messages à 1 Mio et utilise uniquement une boîte ouverte en lecture seule. `auth.mjs` contrôle l’expéditeur autorisé et une assertion DMARC du serveur de réception explicitement approuvé. `routes.mjs` choisit la route et vérifie l’agent et son binding. `webhook.mjs` utilise uniquement le point d’entrée HTTP public `/hooks/agent`, y compris pour le fallback sans publication.

L’indépendance porte sur le collecteur : le plugin reste dépendant des contrats publics de service et de webhook d’OpenClaw, dont la compatibilité doit être testée sur les versions ciblées.

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

1. Accorder les accès réseau et au cluster (non obtenus pendant cette préparation).
2. Installer les dépendances, vérifier les versions publiées, générer et examiner le package-lock, lancer les tests avec les vrais parseurs et une connexion IMAP de lecture seule.
3. Sauvegarder et inspecter Aisa : version, plugin actif, configuration sans affichage des secrets, états et logs récents.
4. Décider baseline ou import de curseur, arrêter l’ancien collecteur, installer la candidate désactivée, valider la configuration et reprendre.
5. Envoyer un nouveau mail autorisé ; vérifier UID, run de l’agent WETY et présence du résumé dans le groupe. Tester un mail ordinaire, un alias inconnu et une reprise après redémarrage.
6. Réactiver l’ancienne version en cas d’échec, après réconciliation des UID traités pendant le test pour éviter une double publication.

Documentation des dépendances : https://imapflow.com/docs/api/imapflow-client/ et https://nodemailer.com/extras/mailparser/.
