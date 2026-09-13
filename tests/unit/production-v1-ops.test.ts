import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '..', '..');
const read = (path: string) => readFileSync(resolve(ROOT, path), 'utf8');

const TUNING: Record<string, string> = {
  FOODSERVICE_SALES_FAST_PATH: 'true',
  AGENT_FAST_CONTEXT_PROFILE: 'true',
  STAGE_CLASSIFIER_FAST_LANE: 'true',
  INBOUND_DEBOUNCE_MS: '0',
  CRM_DRAIN_INTERVAL_MS: '500',
  CRM_DRAIN_IDLE_INTERVAL_MS: '1000',
  QUEUE_POLL_INTERVAL_MS: '250',
  QUEUE_IDLE_POLL_MAX_INTERVAL_MS: '1000',
};

function filesUnder(path: string): string[] {
  const absolute = resolve(ROOT, path);
  return readdirSync(absolute).flatMap((name) => {
    const child = resolve(absolute, name);
    const relative = `${path}/${name}`;
    return statSync(child).isDirectory() ? filesUnder(relative) : [relative];
  });
}

describe('Sarah Production V1 — contrato operacional', () => {
  it('compose oficial contém exatamente o tuning homologado', () => {
    const compose = read('docker-compose.prod.yml');
    for (const [key, value] of Object.entries(TUNING)) {
      expect(compose).toContain(`${key}: "${value}"`);
    }
    expect(compose).not.toMatch(/sarah-(?:rc|latency)/i);
  });

  it('deploy, healthcheck, smoke-test e rollback são versionados e genéricos', () => {
    const scripts = ['deploy.sh', 'healthcheck.sh', 'smoke-test.sh', 'rollback.sh'];
    const uuidLiteral = /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i;

    for (const script of scripts) {
      const path = `scripts/production/${script}`;
      expect(existsSync(resolve(ROOT, path))).toBe(true);
      const source = read(path);
      expect(source).toContain('set -euo pipefail');
      expect(source).not.toMatch(uuidLiteral);
      expect(source).not.toMatch(/sarah-(?:rc|latency)/i);
    }
  });

  it('fontes e testes não carregam nome específico do tenant homologador', () => {
    const roots = ['app', 'lib', 'workers', 'scripts', 'tests'];
    const files = roots.flatMap(filesUnder).filter((path) => /\.(?:ts|tsx|js|mjs|sh)$/.test(path));
    const offenders = files.filter((path) => /tortas\s+do\s+calmon/i.test(read(path)));
    expect(offenders).toEqual([]);
  });

  it('runbooks cobrem onboarding, rollback e retenção sem overlay temporário', () => {
    const release = read('docs/releases/sarah-production-v1.md');
    const onboarding = read('docs/runbooks/new-tenant-sarah-smoke.md');
    const retention = read('docs/runbooks/vps-retention-policy.md');

    expect(release).toContain('contém 26 commits');
    expect(release).toContain('Os 16 commits que formam a mudança homologada');
    expect(release).toContain('fast-forward integral também é proibido');
    expect(onboarding).toContain('inbound=1`, `response_ledger=1`, `outbound=1');
    expect(retention).toContain('Não automatizar `docker system prune -a`');
  });
});
