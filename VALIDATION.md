# Validation de la candidate 0.3.0-experimental.1

- Installation réelle des 46 packages npm réussie ; versions directes épinglées et dépendances transitives verrouillées dans package-lock.json.
- 20 tests passent : routage multi-client, fallback, permissions, états, verrou, reprise après résultat incertain, authentification, MIME réel et HTTP local.
- Vérification de syntaxe de tous les fichiers src/scripts/test réussie.
- npm pack réussi ; seuls code, manifeste, exemples génériques et documentation entrent dans l’archive. Les tests et fichiers GitHub ne sont pas publiés.
- Les workflows vérifient Node 22.19.0/24 et préparent une publication npm manuelle sur main, après configuration du trusted publisher.

Restent à valider : accès TLS au vrai serveur IMAP, parsing des en-têtes OVH réels, cycle de vie du service dans OpenClaw, livraison WhatsApp et migration/rollback sur Aisa. Aucun test de cette branche n’envoie de mail ou de message réel. Aucune publication npm et aucun déploiement ne sont réalisés par cette préparation.
