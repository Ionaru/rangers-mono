import { getServerSession, getToken } from "#auth";
export default eventHandler(async (event) => {
  const session = await getServerSession(event);
  const token = await getToken({ event });

  const r = await fetch("https://discord.com/api/users/@me/guilds", {
    headers: {
      Authorization: `Bearer ${token?.accessToken}`,
    },
  });
  console.log(r.statusText);
  const guilds = await r.json();

  if (!session) {
    return { status: "unauthenticated!" };
  }
  return {
    status: "authenticated!",
    text: "im protected by an in-endpoint check",
    session,
    token,
    guilds,
  };
});
