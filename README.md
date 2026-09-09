# Pique Financeiro

Sistema de gestão financeira da Pique Studio: contas a pagar (calendário + quadro), custos mensais (ferramentas, parcelamentos, folha), clientes, notas fiscais e controle de acesso da equipe.

Stack: HTML/CSS/JS puro (sem build), Firebase Auth (login Google) e Cloud Firestore (dados). Hospedado no GitHub Pages. Roda 100% no plano gratuito (Spark) — **sem precisar do plano Blaze/cartão de crédito**.

## Por que não tem Firebase Storage

O Google passou a exigir o plano Blaze (com cartão cadastrado) até pra usar o Storage dentro da faixa gratuita. Como o Pique Financeiro é só pra duas pessoas, não vale a pena depender disso. Em vez de Storage:

- **Foto de perfil**: é redimensionada no navegador (fica pequena, ~poucos KB) e guardada direto como imagem no seu documento no Firestore.
- **Notas fiscais**: você guarda o arquivo (PDF/foto) onde já guarda hoje — Google Drive, WhatsApp Web, etc. — e cola o link no sistema junto com prestador, descrição e valor. `storage.rules` continua no repositório só como referência, caso um dia decida migrar pro Blaze.

## O que já está pronto

- `index.html` + `app.js` — o app inteiro
- `firestore.rules` — regras de segurança do banco
- `firebase-config.js` — **precisa ser preenchido por você** (placeholders)

## O que falta você fazer (passo a passo)

### 1. Criar o projeto no Firebase

1. Acesse https://console.firebase.google.com e crie um projeto novo (nome sugerido: `pique-financeiro`).
2. **Authentication** → aba "Sign-in method" → habilite **Google**.
3. **Firestore Database** → "Criar banco de dados" → modo produção → região `southamerica-east1` (São Paulo) ou `us-east1`.
4. Em **Configurações do projeto** (ícone de engrenagem) → role até "Seus apps" → clique no ícone `</>` (Web) → registre um app (nome: `pique-financeiro-web`) → **não** marque Firebase Hosting, vamos usar GitHub Pages.
5. Copie o objeto `firebaseConfig` que aparece e cole em `firebase-config.js`, substituindo os `"COLE_AQUI"`.

### 2. Aplicar as regras de segurança

**Firestore Database → Regras** → apague o conteúdo e cole o de `firestore.rules` → Publicar.

### 3. Criar seu próprio acesso (bootstrap)

Como ninguém ainda é administrador, o primeiro acesso é manual:

1. Suba o site (passo 4) e abra o link uma vez, clique em "Entrar com Google" e faça login com sua conta.
2. Vai aparecer a mensagem "conta ainda não tem acesso liberado" — é esperado, ignore por enquanto.
3. No **Firestore Database → Dados**, crie manualmente a coleção `empresas` → documento `pique` → dentro dele, coleção `membros` → documento com o **ID igual ao seu UID**.
   - Pra achar seu UID: **Authentication → Users**, depois do login do passo 1 seu e-mail vai aparecer ali com o UID ao lado.
4. Dentro desse documento, adicione os campos:
   - `email` (string) — seu e-mail
   - `nome` (string) — seu nome
   - `role` (string) — `admin`
5. Recarregue o site logado — agora você entra como administrador.

Esse passo manual é só a primeira vez. Depois disso, você convida qualquer pessoa (inclusive um segundo administrador) direto pela aba **Equipe & Acesso** dentro do próprio app.

### 4. Subir pro GitHub Pages

O repositório já está criado e com o código no ar em `https://github.com/contatogsfilmes-design/pique-financeiro`. Falta ativar o Pages:

No GitHub: **Settings → Pages → Source: Deploy from a branch → Branch: main / (root)**. Em alguns minutos o site fica em `https://contatogsfilmes-design.github.io/pique-financeiro/`.

### 5. Autorizar o domínio no Firebase Auth

**Authentication → Settings → Authorized domains** → adicione `contatogsfilmes-design.github.io`. Sem isso o login com Google é bloqueado nesse domínio.

## Como convidar alguém (ex: Henrique)

Depois de logado como admin, vá em **Equipe & Acesso → Convidar membro**, coloque o e-mail Google da pessoa e o papel (Administrador ou Visualização), e copie o link gerado. A pessoa abre o link, entra com a própria conta Google, e o acesso é liberado automaticamente com o papel escolhido.

- **Administrador**: acesso total (cria, edita, marca como pago, exclui).
- **Visualização**: só consulta — os botões de editar somem e qualquer tentativa de gravar é bloqueada pelas regras do Firestore.

## Estrutura dos dados no Firestore

```
empresas/pique/
  membros/{uid}        — {email, nome, role, fotoURL}
  convites/{token}      — {emailAlvo, role, criadoPor}
  estado/dados           — documento único: {bills, tags, clients, employees, notas, caixaAtual}
```

Tudo (contas, clientes, funcionários, tags, notas fiscais) vive num único documento `estado/dados`, do mesmo jeito que foi feito no QG Finanças — simples e dentro do limite gratuito do Firestore (1MB por documento).

## Limitações desta primeira versão (v1)

- Não foi testada contra um projeto Firebase real ainda — sem o projeto criado eu não tinha como rodar/depurar. Depois que você completar os passos acima, testamos juntos e corrijo o que aparecer.
- O convite fica válido enquanto o documento em `convites/{token}` existir. Revogue pela aba Equipe & Acesso quando a pessoa já tiver entrado, ou se o link vazar.
- Notas fiscais guardam só o link do arquivo, não o arquivo em si (ver seção acima).
- Sem integração com Google Agenda ainda (fica pra depois, como combinado).
- Sem chat de IA (fora do escopo, como pedido).

## Custo

Firebase Spark (grátis): 50 mil leituras/dia, 20 mil escritas/dia. Uso de duas pessoas fica bem abaixo disso — custo esperado: **R$ 0**.
