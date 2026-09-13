# Política de retenção da VPS

Objetivo: manter capacidade de rollback sem permitir crescimento ilimitado de imagens, cache,
worktrees, logs ou backups. Volumes persistentes nunca entram em limpeza genérica.

## Limites e retenção

| Recurso | Política |
|---|---|
| Imagens da aplicação | Manter versão ativa, versão anterior e até duas releases adicionais |
| Imagens upstream | Manter somente os digests referenciados pelo Compose ativo/anterior |
| Build cache | Limite de 5 GB; remover entradas sem uso há 7 dias |
| Logs Docker | `json-file`, 10 MB por arquivo, 3 arquivos por serviço |
| Journal do host | 14 dias ou 1 GB, o que ocorrer primeiro |
| Worktrees | `main` + no máximo uma branch de release ativa |
| Backups diários | 14 conjuntos; política já aplicada por `backup.sh` |
| Evidências de smoke | 30 dias, sem corpo de mensagem ou PII |

## Rotina semanal segura

```bash
docker system df
docker builder prune --filter until=168h --keep-storage 5GB
docker image prune --filter until=168h
git worktree list
git worktree prune
journalctl --vacuum-time=14d --vacuum-size=1G
```

As podas acima removem cache e imagens não referenciadas. Não automatizar `docker system prune -a`,
`docker volume prune` nem `docker compose down -v`: sessões do WhatsApp, certificados e dados
persistentes dependem de volumes.

## Worktrees

Crie worktree somente para uma release/incident ativo. Depois do merge e da confirmação de que não
há mudanças locais, remova pelo Git (`git worktree remove <caminho>`) e rode `git worktree prune`.
Nunca apague a pasta manualmente, pois o metadado continuaria no repositório principal.

## Alertas de disco

- 70%: aviso e inspeção com `docker system df` e `du`.
- 80%: executar a rotina semanal e revisar backups/logs.
- 90%: bloquear novo deploy/build até recuperar espaço; não apagar volumes para abrir espaço.

Antes de remover uma imagem versionada, confirme que ela não é a ativa nem a referência de rollback
em `.release-state/previous-ref` e que existe no registry. Toda limpeza deve ser registrada com data,
espaço antes/depois e operador.
