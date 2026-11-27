// Entrega a foto de perfil. O arquivo fica como anexo no canal de banners (mesmo storage de sempre);
// este endpoint busca o anexo e devolve com cache longo, porque os links do Discord expiram.
const DISCORD_API = "https://discord.com/api/v10";

export default async function handler(req, res) {
  const id = String(req.query?.id || "");
  if (!/^\d{5,25}$/.test(id)) return res.status(404).end();
  try {
    const headers = { Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}` };
    const message = await (await fetch(`${DISCORD_API}/channels/${process.env.DISCORD_CHANNEL_BANNERS}/messages/${id}`, { headers })).json();
    let meta = {};
    try { meta = JSON.parse(message.content); } catch {}
    const file = message.attachments?.[0];
    if (meta.kind !== "avatar" || !file?.url) return res.status(404).end();
    const image = await fetch(file.url);
    if (!image.ok) return res.status(502).end();
    res.setHeader("Content-Type", "image/jpeg");
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    return res.status(200).send(Buffer.from(await image.arrayBuffer()));
  } catch {
    return res.status(502).end();
  }
}
