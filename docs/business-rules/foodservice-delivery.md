# Regras de taxa e cobertura de entrega — Chopperia do Gordo

## Fonte e escopo

Esta regra é específica da Chopperia do Gordo e deriva das orientações atuais salvas para o tenant. Ela é persistida em `organizations.settings.foodservice.operation.delivery_policy`, junto das áreas atendidas em `service_areas`. O cálculo é feito no banco durante o checkout. A taxa escrita no texto da Sarah não é fonte de cálculo.

## Regra

- Subtotal até R$ 100,00, inclusive: taxa de R$ 10,00.
- Subtotal acima de R$ 100,00 de segunda a sexta antes das 19:00 em `America/Sao_Paulo`: taxa de R$ 5,00.
- Subtotal acima de R$ 100,00 de segunda a sexta a partir das 19:00: entrega grátis.
- Subtotal acima de R$ 100,00 aos sábados e domingos: entrega grátis.
- Pedido mínimo: R$ 0,00.
- Endereço fora das áreas atendidas ou em bairro bloqueado não recebe uma taxa estimada; o checkout recusa a modalidade entrega. Retirada continua disponível quando habilitada.

## Enforcement

`fn_food_delivery_quote` aplica os limites e a normalização de acentos. `fn_food_checkout` usa a política do tenant resolvido pelo slug e confere produto/disponibilidade/preço no banco antes de finalizar. O tenant precisa salvar `delivery_policy_required=true` junto da política para ativar o cálculo estruturado. Tenants existentes que não usam política estruturada mantêm sua taxa fixa legada. A UI não é autoridade para o valor da taxa. O helper tem execução concedida somente a `service_role`.

## Reversão

A migration 0184 altera funções existentes e não cria colunas/tabelas. Para rollback, restaurar `fn_food_checkout` do baseline da release anterior e remover `fn_food_delivery_quote`; o checkout volta ao comportamento anterior, sem aplicar essas regras de taxa.
