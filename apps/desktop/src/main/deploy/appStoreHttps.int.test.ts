import { findCatalogTemplate, generateCatalogSecrets, renderCatalogApp } from '@runova/core';
import { afterEach, describe, expect, it } from 'vitest';
import { DeployAppStore } from './appStore/service';
import { CoreHttpClient } from './connection/coreHttp';
import { DeploySites } from './sites/deploySites';
import { buildContextTarball } from './stacks/buildContext';
import { DeployStacks } from './stacks/service';
import { installAndConnect, installDocker, runJob } from './testing/coreSession';
import { pointCoreAtPebble, startPebbleOn } from './testing/pebble';
import {
  skipWhenNoServers,
  startTestServer,
  systemTestsEnabled,
  type TestServer,
  testServerImages,
} from './testing/testServers';

/**
 * E12 AC3 on a real server: WordPress from the App Store on a domain, over HTTPS with a
 * certificate from Pebble. The core is installed with its ACME directories pointed at Pebble,
 * which runs in the server's own network namespace (testing/pebble.ts). Then, as the app does it:
 * Docker and nginx through the core's jobs, the WordPress template installed and deployed
 * through DeployAppStore, the site saved and nginx applied as the install sheet's "put it on a
 * domain" does (E10), and the certificate issued over HTTP-01 through nginx (E11). curl on the
 * server must then get WordPress's setup page over HTTPS, verified against Pebble's root alone.
 * Nightly only: Docker, nginx.org's nginx and the WordPress and MySQL images all come over the
 * network, which takes far longer than the every-push job allows. Needs RUNOVA_SYSTEM_TESTS=1,
 * Docker and `pnpm server-core:publish linux-x64`.
 */

const enabled = systemTestsEnabled();
const IMAGES = testServerImages(['ubuntu-24.04'], ['ubuntu-24.04']);
const DOMAIN = 'blog.runova.test';
const SITE_ID = 'blog';
const TEST_TIMEOUT_MS = 3_600_000;

const servers: TestServer[] = [];
const cleanups: Array<() => void> = [];

afterEach((context) => {
  if (context.task.result?.state === 'fail') {
    // biome-ignore lint/suspicious/noConsole: the CI log is all there is to see where a run stopped
    console.log(servers.map((server) => server.diagnose()).join('\n'));
  }
  for (const cleanup of cleanups.splice(0)) cleanup();
  for (const server of servers.splice(0)) server.stop();
});

describe.skipIf(!enabled)('App Store WordPress over HTTPS on a real server', () => {
  skipWhenNoServers(IMAGES);
  for (const image of IMAGES) {
    it(
      `installs WordPress on ${DOMAIN} with a certificate from Pebble on ${image}`,
      async () => {
        const server = await startTestServer(image);
        servers.push(server);
        pointCoreAtPebble(server);
        const pebble = await startPebbleOn(server);
        cleanups.push(pebble.stop);
        const { hub, transport, sessions, stop } = await installAndConnect(
          server,
          'App Store HTTPS system test',
        );
        cleanups.push(stop);

        await installDocker(hub);
        const links = {
          call: <T>(_serverId: string, work: (h: typeof hub) => Promise<T>) => work(hub),
        };
        const sites = new DeploySites({ links, roles: () => ['owner'] });
        const nginx = await runJob(hub, await sites.install('srv'), 900_000);
        expect(nginx.final?.state, nginx.log.slice(-40).join('\n')).toBe('succeeded');

        // The App Store install: the template rendered here, uploaded and deployed as an app.
        const stacks = new DeployStacks({
          links,
          roles: () => ['owner'],
          http: async (_serverId, work) =>
            work(new CoreHttpClient(transport), await sessions.accessToken('srv')),
          source: {
            project: async () => {
              throw new Error('An App Store install has no project.');
            },
            index: async () => {
              throw new Error('An App Store install has no project.');
            },
            environment: async () => {
              throw new Error('An App Store install has no project.');
            },
          },
          pack: buildContextTarball,
        });
        const store = new DeployAppStore({ stacks });
        const template = findCatalogTemplate('wordpress');
        if (!template) throw new Error('The catalog has no WordPress.');
        const choices = {
          version: template.defaultVersion,
          params: {},
          secrets: generateCatalogSecrets(template.secrets),
          domain: DOMAIN,
        };
        const installed = await store.install({
          serverId: 'srv',
          templateId: template.id,
          name: 'blog',
          ...choices,
        });
        expect(installed.revision.state, installed.revision.error).toBe('ready');
        if (!installed.job) throw new Error('The install started no deploy.');
        const deployed = await runJob(hub, installed.job, 1_500_000);
        expect(deployed.final?.state, deployed.log.slice(-60).join('\n')).toBe('succeeded');

        // "Put it on a domain", as the install sheet does it: the site, nginx, the certificate.
        const rendered = renderCatalogApp(template, choices);
        if (!rendered.ok) throw new Error(rendered.reason);
        const { web, ports } = rendered.render;
        const port = ports.find((p) => p.service === web?.service && p.target === web?.port);
        if (!web || !port) throw new Error('WordPress has no web port.');
        const saved = await sites.saveSite('srv', {
          id: SITE_ID,
          domains: [DOMAIN],
          upstream: {
            kind: 'servicePort',
            service: `blog-${web.service}`,
            port: port.published,
            verifyCertificate: true,
            sendUpstreamHost: false,
          },
          websocket: true,
          gzip: true,
          http2: true,
          redirectToHttps: false,
        });
        expect(saved.site, JSON.stringify(saved.problems)).toBeTruthy();
        const applied = await sites.apply('srv');
        expect(applied.applied, applied.error ?? JSON.stringify(applied.problems)).toBe(true);
        const issued = await runJob(
          hub,
          await sites.issue({
            serverId: 'srv',
            siteId: SITE_ID,
            acceptTermsOfService: true,
            staging: false,
          }),
          600_000,
        );
        expect(issued.final?.state, issued.log.slice(-40).join('\n')).toBe('succeeded');

        // WordPress over HTTPS, trusting Pebble's root and nothing else.
        const root = Buffer.from(pebble.rootPem()).toString('base64');
        server.run(`echo ${root} | base64 -d > /root/pebble-root.pem`);
        const status = server.run(
          `curl -sS --max-time 60 --cacert /root/pebble-root.pem --resolve ${DOMAIN}:443:127.0.0.1 -o /root/page.html -w '%{http_code}' https://${DOMAIN}/wp-admin/install.php`,
        );
        expect(status).toBe('200');
        expect(server.run('cat /root/page.html')).toContain('WordPress');
        const issuer = server.run(
          `echo | openssl s_client -connect 127.0.0.1:443 -servername ${DOMAIN} 2>/dev/null | openssl x509 -noout -issuer`,
        );
        expect(issuer).toContain('Pebble');
      },
      TEST_TIMEOUT_MS,
    );
  }
});
