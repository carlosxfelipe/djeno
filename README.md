## Sobre o djeno.ts

**djeno.ts** é uma biblioteca TypeScript para Deno criada para facilitar o uso de templates HTML de forma simples e rápida, inspirada em frameworks como Django e Jinja2.

- Permite uso de templates com `{%}` tags e `{{ }}` variáveis.
- Suporte à tag `{% load static %}` para arquivos estáticos, como no Django.
- Suporta herança de templates, includes, loops e condicionais.
- Ideal para projetos web leves e didáticos com Deno.
- Integração fácil com frameworks como Hono.
- 100% TypeScript, sem dependências externas.


Explore o código em `lib/djeno.ts` para entender e customizar conforme sua necessidade!

## Como rodar o projeto

Para rodar normalmente:

```sh
deno task start
```

### Watch/restart automático (apenas arquivos .ts)

Se quiser que o servidor reinicie automaticamente ao salvar arquivos `.ts`, instale o denon:

```sh
deno install -Af --name denon https://deno.land/x/denon/denon.ts
```

Depois rode:

```sh
deno task dev
```

> ⚠️ O denon faz apenas o watch/restart do servidor para arquivos `.ts`. Você ainda precisa recarregar a página no navegador manualmente (F5) para ver as alterações. Mudanças em arquivos `.html` também exigem reinício manual do servidor.
