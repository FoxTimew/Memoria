# ADR 004 — Facteurs et preuve de connexion forte

Statut : accepté — 2026-10-22.

**Décision.** Email vérifié + mot de passe, TOTP et codes de secours ; passkeys multiples nommables/supprimables. Pas de SMS ni OTP email comme second facteur. `session_assurance` enregistre côté serveur la méthode réellement vérifiée et son instant, jamais une déclaration du client. Une passkey avec UV vérifié constitue une connexion forte complète.

**Alternatives.** Déduire la force de `twoFactorEnabled` ; considérer toute session récente comme forte ; exiger TOTP même après une passkey vérifiée.

**Raison.** Posséder un facteur ne prouve pas qu'il a servi pour cette connexion. L'assurance doit aussi distinguer un code de récupération d'une authentification forte fraîche.

**Conséquences.** Owner avec facteur fort vérifié ET session forte récente pour activer l'obligation. En activation, fixer les échéances individuelles des membres existants à maintenant + délai configurable (7 jours par défaut). Les nouvelles adhésions doivent satisfaire la politique avant l'accès au contenu. L'expiration du délai bloque l'accès workspace mais laisse les écrans d'enrôlement/récupération accessibles. Modifier le délai ne prolonge pas silencieusement les échéances existantes.

Création de clé, ajout/modification de webhook, changement de rôle/partage sensible et désactivation/suppression de facteur exigent `verified_at` de moins de 600 secondes par défaut. Un code de secours ouvre une session de récupération limitée à la restauration des facteurs ; il ne permet pas ces actions sensibles. Le dernier facteur ne peut être retiré tant qu'une adhésion impose la connexion forte. Ne pas utiliser « trusted device » pour fabriquer une nouvelle preuve fraîche.

**Point d'intégration vérifié.** Le plugin passkey 1.7.12 expose les hooks `registration.afterVerification` et `authentication.afterVerification`, mais utilise `requireUserVerification: false` dans ses vérificateurs et `preferred` pour les options de connexion. Il faudra imposer `userVerification: required` sur les options rendues, puis rejeter dans les hooks tout résultat cryptographiquement vérifié dont `registrationInfo.userVerified` / `authenticationInfo.userVerified` n'est pas strictement vrai, AVANT création de credential/session. `authenticatorSelection` seul ne suffit pas. Aucune route d'auth n'est activée ici. [Plugin et hooks](https://better-auth.com/docs/plugins/passkey).
