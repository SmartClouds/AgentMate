import { z } from 'zod';
import { defineCatalogTemplate, identifierParam, portParam } from '../define.js';
import { CATALOG_IMAGES } from '../images.js';
import { fact } from './shared.js';

/** The listener other containers on the app's network use, also the one the broker talks to itself on. */
const INTERNAL_PORT = 19092;
const CLIENT_CONFIG = '/tmp/client.properties';

/**
 * Writes the server's JAAS file and a client config for the health check from the password in the
 * environment, so it never sits in the compose file, then hands over to the image's own start
 * script. The cluster id is drawn once by Kafka and read back from the data volume afterwards.
 */
function startScript(user: string): string {
  const login = 'org.apache.kafka.common.security.plain.PlainLoginModule required';
  return [
    'set -e',
    'umask 077',
    `printf 'KafkaServer {\\n  ${login}\\n  username="${user}" password="%s"\\n  user_${user}="%s";\\n};\\n' "$$KAFKA_SASL_PASSWORD" "$$KAFKA_SASL_PASSWORD" > /tmp/kafka_server_jaas.conf`,
    `printf 'security.protocol=SASL_PLAINTEXT\\nsasl.mechanism=PLAIN\\nsasl.jaas.config=${login} username="${user}" password="%s";\\n' "$$KAFKA_SASL_PASSWORD" > ${CLIENT_CONFIG}`,
    'umask 022',
    'meta=/var/lib/kafka/data/meta.properties',
    `if [ -f "$$meta" ]; then CLUSTER_ID=$$(sed -n 's/^cluster.id=//p' "$$meta"); else CLUSTER_ID=$$(/opt/kafka/bin/kafka-storage.sh random-uuid); fi`,
    'export CLUSTER_ID',
    'unset KAFKA_SASL_PASSWORD',
    'exec /etc/kafka/docker/run',
  ].join('\n');
}

export const kafka = defineCatalogTemplate({
  id: 'kafka',
  name: 'Apache Kafka',
  description: 'An event streaming platform for passing records between services, run as one node.',
  category: 'messaging',
  homepage: 'https://kafka.apache.org',
  versions: [
    {
      id: '4.3',
      label: 'Kafka 4.3 (KRaft, single node)',
      images: { app: CATALOG_IMAGES.kafka43 },
    },
  ],
  defaultVersion: '4.3',
  parameters: z.object({
    port: portParam(9092),
    user: identifierParam('admin'),
  }),
  fields: {
    port: {
      label: 'Port',
      help: 'The port clients connect to. Kafka hands this address back to them, so an SSH tunnel must use the same port on your side.',
      input: 'port',
    },
    user: {
      label: 'User',
      help: 'The account clients sign in with over SASL PLAIN.',
      input: 'text',
    },
  },
  secrets: [{ key: 'KAFKA_SASL_PASSWORD', label: 'Password', kind: 'password', length: 32 }],
  minMemoryMb: 1536,
  firstVisitorSetup: false,
  exposureNote:
    'Kafka speaks its own protocol, not HTTP, so it is not put on a domain. Reach it through an SSH tunnel.',
  acknowledgments: [],
  build: ({ version, params, secret }) => ({
    services: {
      kafka: {
        image: 'app',
        hostname: 'kafka',
        command: ['sh', '-c', startScript(params.user)],
        environment: {
          KAFKA_SASL_PASSWORD: { secret: 'KAFKA_SASL_PASSWORD' },
          KAFKA_NODE_ID: '1',
          KAFKA_PROCESS_ROLES: 'broker,controller',
          KAFKA_LISTENERS: `CLIENT://:9092,INTERNAL://:${INTERNAL_PORT},CONTROLLER://localhost:9093`,
          KAFKA_ADVERTISED_LISTENERS: `CLIENT://127.0.0.1:${params.port},INTERNAL://kafka:${INTERNAL_PORT}`,
          KAFKA_LISTENER_SECURITY_PROTOCOL_MAP:
            'CONTROLLER:PLAINTEXT,CLIENT:SASL_PLAINTEXT,INTERNAL:SASL_PLAINTEXT',
          KAFKA_CONTROLLER_LISTENER_NAMES: 'CONTROLLER',
          KAFKA_CONTROLLER_QUORUM_VOTERS: '1@localhost:9093',
          KAFKA_INTER_BROKER_LISTENER_NAME: 'INTERNAL',
          KAFKA_SASL_ENABLED_MECHANISMS: 'PLAIN',
          KAFKA_SASL_MECHANISM_INTER_BROKER_PROTOCOL: 'PLAIN',
          KAFKA_OPTS: '-Djava.security.auth.login.config=/tmp/kafka_server_jaas.conf',
          KAFKA_LOG_DIRS: '/var/lib/kafka/data',
          // One node holds every copy, so the internal topics cannot ask for more.
          KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR: '1',
          KAFKA_TRANSACTION_STATE_LOG_REPLICATION_FACTOR: '1',
          KAFKA_TRANSACTION_STATE_LOG_MIN_ISR: '1',
          KAFKA_SHARE_COORDINATOR_STATE_TOPIC_REPLICATION_FACTOR: '1',
          KAFKA_SHARE_COORDINATOR_STATE_TOPIC_MIN_ISR: '1',
          KAFKA_GROUP_INITIAL_REBALANCE_DELAY_MS: '0',
        },
        ports: [{ label: 'Kafka', target: 9092, published: params.port }],
        volumes: [{ volume: 'data', target: '/var/lib/kafka/data' }],
        healthcheck: {
          test: [
            'CMD-SHELL',
            `KAFKA_HEAP_OPTS=-Xmx64m /opt/kafka/bin/kafka-broker-api-versions.sh --bootstrap-server localhost:${INTERNAL_PORT} --command-config ${CLIENT_CONFIG} > /dev/null`,
          ],
          interval: '1m',
          timeout: '30s',
          startPeriod: '1m',
        },
        stopGracePeriod: '1m',
      },
    },
    web: null,
    facts: [
      fact('version', 'Version', version.label),
      fact('bootstrap', 'Bootstrap server', `127.0.0.1:${params.port}`),
      fact('internal', 'From containers on its network', `kafka:${INTERNAL_PORT}`),
      fact('security', 'Security', 'SASL_PLAINTEXT with the PLAIN mechanism'),
      fact('user', 'User', params.user),
      fact('password', 'Password', secret('KAFKA_SASL_PASSWORD'), true),
    ],
  }),
});
