# Validation — candidate 0.3.0-experimental.1

- 18 tests locaux passent, sans dépendance aux fichiers internes d’OpenClaw.
- Le collecteur est testé avec un client IMAP simulé et un parseur simulé ; le webhook avec un transport HTTP simulé.
- Les tests couvrent notamment baseline explicite, curseur persistant, verrou exclusif, blocage des renvois incertains, changement UIDVALIDITY, deux clients, fallback, contrôle des expéditeurs et des assertions d’authentification.
- `npm run check` passe.
- Les versions des dépendances ont été relevées dans leurs dépôts upstream ; leur résolution par npm reste à vérifier.
- `npm install --offline` a échoué avec ENOTCACHED pour imapflow. Les accès réseau/écriture demandés n’ont pas été accordés dans cette session.
- Aucun test des dépendances réellement installées, du parseur sur les mails OVH, du chargement OpenClaw ni d’une publication WhatsApp pour cette version.
- Aucun changement au dépôt openclaw-factory ou à l’instance Aisa, aucune publication npm/GitHub.

La candidate est préparée pour poursuivre le développement et les essais, pas validée pour être activée sans contrôle. Le choix entre baseline des nouveaux mails et reprise par import du curseur n’a pas encore été confirmé.
