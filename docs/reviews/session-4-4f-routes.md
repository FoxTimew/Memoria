# Session 4f — inventaire des routes d'authentification

Inventaire fermé des 27 routes de `AuthController`. Le guard global Nest s'exécute sur les contrôleurs ; la façade Better Auth porte explicitement `@Public()` car elle doit recevoir des connexions anonymes. Cette exception ne donne pas accès aux données métier : chaque endpoint applique son contrôle natif et les hooks d'assurance. Les autres contrôleurs sont fermés par défaut. Les health checks sont les seules autres exceptions publiques.

Le scénario A01 de `pnpm test:auth:adversarial` vérifie chaque ligne ci-dessous contre le serveur Nest réel : compteur de cette route préparé à sa limite, réponse 429 avant tout effet. Il vérifie aussi qu'une nouvelle route sans décorateur public renvoie 401. A02 attaque les variantes de chemins et les endpoints natifs non autorisés. Une route ajoutée à la liste sans ligne dans cet inventaire fait échouer A01. La règle générale d'authentification reste 600 requêtes/minute **par couple IP/route sans règle spécifique** ; ce n'est pas un plafond cumulé de toute l'API (ADR 015).

| Route exacte                                 | Quota IP    | Frontière d'accès / preuve complémentaire                                           |
| -------------------------------------------- | ----------- | ----------------------------------------------------------------------------------- |
| `POST /sign-up/email`                        | 100 / 600 s | Anonyme, vérification d'email avant contenu ; auth.e2e                              |
| `POST /sign-in/email`                        | 150 / 60 s  | Mot de passe, file par compte, session limitée si facteur ; strong-auth/rate-limits |
| `POST /sign-out`                             | 600 / 60 s  | Cookie de la session à révoquer, origine ; cache-policy/recovery                    |
| `POST /send-verification-email`              | 150 / 300 s | Anonyme, réponse générique, budget destinataire ; rate-limits                       |
| `GET /verify-email`                          | 600 / 60 s  | Jeton signé, consommation native ; parcours navigateur                              |
| `GET /get-session`                           | 600 / 60 s  | Cookie signé, aucune preuve forte implicite ; strong-auth                           |
| `POST /verify-password`                      | 300 / 60 s  | Session identifiée, mot de passe ; aucune promotion forte                           |
| `GET /security/status`                       | 600 / 60 s  | Session identifiée, état minimal y compris récupération                             |
| `GET /security/cache-policy`                 | 3600 / 60 s | Session identifiée, décisions des seuls workspaces membres                          |
| `POST /security/challenge`                   | 300 / 60 s  | Session identifiée, défi 5 minutes / 5 essais                                       |
| `POST /security/recovery-codes`              | 300 / 60 s  | Preuve forte récente, affichage unique authentifié                                  |
| `POST /two-factor/enable`                    | 300 / 60 s  | Mot de passe récent ou preuve forte récente, exception récupération limitée         |
| `POST /two-factor/verify-totp`               | 300 / 60 s  | Défi lié à la session, anti-rejeu TOTP, cinq essais                                 |
| `POST /two-factor/disable`                   | 300 / 60 s  | Preuve forte récente, mot de passe, maintien de la politique                        |
| `GET /passkey/generate-register-options`     | 300 / 60 s  | Session et autorisation d'enrôler, origine/RP/UV                                    |
| `POST /passkey/verify-registration`          | 300 / 60 s  | Même session, signature, défi, UV ; aucun accès par simple enrôlement               |
| `GET /passkey/generate-authenticate-options` | 300 / 60 s  | Anonyme ou réauthentification liée à l'identité                                     |
| `POST /passkey/verify-authentication`        | 300 / 60 s  | Signature UV, origine/RP, défi à usage unique, facteur non quarantiné               |
| `POST /passkey/delete-passkey`               | 300 / 60 s  | Propriétaire du facteur, preuve récente, maintien politique                         |
| `POST /passkey/update-passkey`               | 300 / 60 s  | Propriétaire du facteur, preuve récente                                             |
| `POST /security/request-password-reset`      | 100 / 600 s | Anonyme, réponse générique, budget email                                            |
| `POST /security/recovery-challenge`          | 300 / 60 s  | Anonyme, défi lié au compte/type, file récupération                                 |
| `POST /security/recover`                     | 300 / 60 s  | Mot de passe + code commun + défi ; session de récupération seulement               |
| `POST /security/operator-recover`            | 300 / 60 s  | Mot de passe + lien opérateur + défi ; session de récupération seulement            |
| `POST /security/recovery-remove-factor`      | 300 / 60 s  | Session de récupération limitée et non expirée                                      |
| `POST /security/recovery-finish`             | 300 / 60 s  | Nouveau facteur vérifié ; session suivante attend encore une preuve forte           |
| `POST /reset-password`                       | 100 / 600 s | Jeton hashé de 30 minutes, changement atomique, révocation générale                 |

Ni les endpoints natifs backup-code/OTP/email de second facteur, ni les mutations d'organisation, clés API, changement de mot de passe ou autres routes du SDK ne sont exposés. Les signatures du SDK interne ne sont pas des routes HTTP publiques. À chaque ajout d'endpoint : ajouter la ligne, son contrôle métier et son attaque spécifique ; A01 ne remplace pas le test d'autorisation de l'endpoint.
