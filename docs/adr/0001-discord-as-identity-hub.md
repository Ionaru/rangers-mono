# Discord is the canonical identity and the site's only login

Every Member is anchored to a Discord account; Steam and TeamSpeak identities are linked onto it. The website's only login is Discord OAuth.

## Why

Of the three external namespaces a Member spans (Discord, Steam, TeamSpeak), only Discord has a real modern OAuth2 account system, it is where the unit actually lives (every member already has one), and it is the identity we want to gate roles on. Steam has no roles and TeamSpeak has no account, so neither can anchor the model. The abandoned `rangers-site` already encoded this instinct: its `UserModel` required a Discord id, so a user could not exist without one.

## Considered and rejected

An in-house email/password account with Discord, Steam, and TeamSpeak all as equal connections. Rejected: it adds passwords, resets, and abuse handling for ~100 people with no benefit at this scale. Revisit only if the platform must outlive the Discord server.
