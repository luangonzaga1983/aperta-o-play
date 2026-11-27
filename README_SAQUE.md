# Ativar o saque automático (Mercado Pago Payouts)

1. Gere o par de chaves (Linux/macOS/Git Bash):
   openssl genpkey -algorithm ed25519 -out mpprivate.pem
   openssl pkey -in mpprivate.pem -pubout -out mppublic.pem
2. Envie o conteúdo de mppublic.pem para a equipe de Integrações do Mercado Pago e peça a liberação
   de Payouts / Money Out para a conta (docs: mercadopago.com.br/developers/pt/docs/payouts/go-to-production).
3. Coloque no Vercel a variável MP_PAYOUTS_PRIVATE_KEY com o conteúdo de mpprivate.pem
   (troque as quebras de linha por \n, tudo em uma linha). NUNCA compartilhe esse arquivo.
4. A conta precisa ter saldo: o Pix sai do saldo do Mercado Pago.
Sem esses passos, tudo continua funcionando; os saques só ficam "Pendentes" para o admin pagar.
