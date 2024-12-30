import { NuxtAuthHandler } from "#auth";
import DiscordProvider, { DiscordProfile } from "next-auth/providers/discord";
import { OAuthUserConfig } from "next-auth/providers/oauth";

export default NuxtAuthHandler({
  callbacks: {
    jwt: ({ token, account, user }) => {
      if (account && user) {
        token.accessToken = account.access_token;
      }
      return token;
    },
  },
  pages: {
    signIn: "/auth",
    error: "/auth",
  },
  providers: [
    // @ts-expect-error You need to use .default here for it to work during SSR. May be fixed via Vite at some point
    DiscordProvider.default({
      authorization:
        "https://discord.com/oauth2/authorize?scope=identify+guilds.members.read",
      clientId: process.env["AUTH_CLIENT_ID"],
      clientSecret: process.env["AUTH_CLIENT_SECRET"],
    } as OAuthUserConfig<DiscordProfile>),
  ],
  secret: process.env["AUTH_SESSION_SECRET"],
});
