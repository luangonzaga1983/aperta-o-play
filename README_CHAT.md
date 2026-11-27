# Ativar o chat de suporte ao vivo

O chat já está no código. Ele só aparece quando a Vercel tem a variável DISCORD_CHANNEL_SUPORTE.

1. No Discord, crie um canal PRIVADO (ex.: #suporte-chat) e adicione o bot com permissão de
   Ver canal, Ler histórico, Enviar mensagens.
2. Ative o Modo desenvolvedor (Configurações > Avançado), clique com o botão direito no canal e "Copiar ID".
3. Vercel > Settings > Environment Variables: crie DISCORD_CHANNEL_SUPORTE com esse ID (Production).
   Confirme que DISCORD_BOT_TOKEN também existe.
4. Faça um novo deploy (Redeploy). Variáveis novas só valem depois de um deploy.

Usuário: menu > Suporte > "Chat no aplicativo".
Admin: Administração > Chats de suporte (lista de conversas, responde cada pessoa, recebe aviso e som).
Contas com função "support" ou "admin" também atendem.
