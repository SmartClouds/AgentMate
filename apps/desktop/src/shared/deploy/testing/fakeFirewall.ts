import type {
  ExposureInventory,
  FirewallChange,
  FirewallChangePreview,
  FirewallChangeRequest,
  FirewallChangeSetInfo,
  FirewallGuardVerdict,
  FirewallPolicy,
  FirewallPreset,
  FirewallRuleInfo,
  FirewallRuleSpec,
  FirewallStatus,
} from '../protocol/generated/Runova.ServerCore.Contracts';

/**
 * The firewall of a fake core (E13): ufw, on, with SSH, HTTP and HTTPS open, as the DevHost
 * seeds it. Change sets follow the core's rules and its words: a set that would close SSH is
 * refused unless the phrase is typed (and a step-up made), turning the firewall on or off needs a
 * step-up, one change waits for its confirmation at a time, a confirmation over the connection
 * that applied it is refused, and `settle` rolls back whatever ran past its deadline, as the
 * core's systemd timer does.
 */

export const FAKE_SSH_PORT = 22;
export const FAKE_GUARD_PHRASE = `block ssh on port ${FAKE_SSH_PORT}`;
const WINDOW_SECONDS = 60;

/** Who asks: the connection it came over (any object), and whether they stepped up. */
export interface FakeFirewallCaller {
  connection: object;
  steppedUp: boolean;
}

interface Snapshot {
  active: boolean;
  defaultIncoming: FirewallPolicy;
  rules: FirewallRuleInfo[];
}

interface Plan extends Snapshot {
  commands: string[];
  summary: string;
  toggles: boolean;
}

function describe(rule: FirewallRuleSpec): string {
  const port =
    rule.port === undefined ? 'any port' : `${rule.port}${rule.portTo ? `:${rule.portTo}` : ''}`;
  const proto = rule.protocol === 'any' ? '' : `/${rule.protocol}`;
  return `${rule.action} ${port}${proto}${rule.source ? ` from ${rule.source}` : ''}`;
}

function ufwSpec(rule: FirewallRuleSpec): string {
  const words = ['ufw', rule.action];
  if (rule.source) words.push('from', rule.source, 'to', 'any');
  if (rule.port !== undefined) {
    words.push(rule.source ? 'port' : '', `${rule.port}${rule.portTo ? `:${rule.portTo}` : ''}`);
  }
  if (rule.protocol !== 'any') words.push('proto', rule.protocol);
  if (rule.comment) words.push('comment', `'${rule.comment}'`);
  return words.filter(Boolean).join(' ');
}

function allowsSsh(snapshot: Snapshot): boolean {
  if (!snapshot.active || snapshot.defaultIncoming === 'allow') return true;
  return snapshot.rules.some(
    (rule) =>
      (rule.action === 'allow' || rule.action === 'limit') &&
      !rule.source &&
      rule.protocol !== 'udp' &&
      (rule.port === undefined ||
        (rule.port <= FAKE_SSH_PORT && (rule.portTo ?? rule.port) >= FAKE_SSH_PORT)),
  );
}

export class FakeFirewall {
  active = true;
  defaultIncoming: FirewallPolicy = 'deny';
  rules: FirewallRuleInfo[] = [];
  readonly changeSets: FirewallChangeSetInfo[] = [];
  /** The connection that applied each change set, to refuse a confirmation over it. */
  private readonly appliedOver = new Map<string, object>();
  private readonly snapshots = new Map<string, Snapshot>();
  private ruleCount = 0;
  private setCount = 0;

  constructor(
    private readonly now: () => number,
    private readonly rolledBack: (change: FirewallChangeSetInfo) => void = () => undefined,
  ) {
    this.add({ action: 'allow', protocol: 'tcp', port: 22, comment: 'ssh' });
    this.add({ action: 'allow', protocol: 'tcp', port: 80 });
    this.add({ action: 'allow', protocol: 'tcp', port: 443 });
    this.add({ action: 'allow', protocol: 'tcp', port: 5432, source: '10.0.0.0/8' });
  }

  get pending(): FirewallChangeSetInfo | undefined {
    return this.changeSets.find((change) => change.state === 'awaitingConfirmation');
  }

  status(): FirewallStatus {
    this.settle();
    const pending = this.pending;
    return {
      backend: 'ufw',
      installed: true,
      active: this.active,
      defaultIncoming: this.defaultIncoming,
      defaultOutgoing: 'allow',
      ipv6: true,
      rules: this.rules.map((rule) => ({ ...rule })),
      warnings: [],
      ssh: { ports: [FAKE_SSH_PORT] },
      confirmWithinSeconds: WINDOW_SECONDS,
      checkedAtUnixMs: this.now(),
      ...(pending ? { pending: { ...pending } } : {}),
    };
  }

  presets(): FirewallPreset[] {
    const tcp = (port: number): FirewallRuleSpec => ({ action: 'allow', protocol: 'tcp', port });
    return [
      { id: 'ssh', name: 'SSH', description: 'Port 22', rules: [tcp(22)], suggestSource: false },
      { id: 'http', name: 'HTTP', description: 'Port 80', rules: [tcp(80)], suggestSource: false },
      {
        id: 'https',
        name: 'HTTPS',
        description: 'Port 443',
        rules: [tcp(443)],
        suggestSource: false,
      },
      {
        id: 'postgres',
        name: 'PostgreSQL',
        description: 'Port 5432, best kept to your own network',
        rules: [tcp(5432)],
        suggestSource: true,
      },
    ];
  }

  history(limit = 20): FirewallChangeSetInfo[] {
    this.settle();
    return [...this.changeSets]
      .sort((a, b) => b.createdAtUnixMs - a.createdAtUnixMs)
      .slice(0, limit)
      .map((change) => ({ ...change }));
  }

  exposure(): ExposureInventory {
    return {
      sockets: [
        {
          protocol: 'tcp',
          address: '0.0.0.0',
          port: 22,
          scope: 'public',
          firewall: 'open',
          process: 'sshd',
        },
        {
          protocol: 'tcp',
          address: '0.0.0.0',
          port: 3000,
          scope: 'public',
          firewall: 'closed',
          process: 'node',
        },
        {
          protocol: 'tcp',
          address: '127.0.0.1',
          port: 5432,
          scope: 'local',
          firewall: 'notApplicable',
          process: 'postgres',
        },
      ],
      containers: [
        {
          containerId: '3f1c0a9e7b2d',
          containerName: 'shop-db-1',
          image: 'postgres:17',
          protocol: 'tcp',
          hostAddress: '0.0.0.0',
          hostPort: 15432,
          containerPort: 5432,
          scope: 'public',
          firewall: 'bypassed',
        },
      ],
      dockerAvailable: true,
      collectedAtUnixMs: this.now(),
    };
  }

  preview(request: FirewallChangeRequest): FirewallChangePreview {
    this.settle();
    const plan = this.plan(request.changes);
    const guard = this.guard(plan);
    return {
      summary: plan.summary,
      commands: plan.commands,
      notes: [],
      resultingRules: plan.rules,
      resultingActive: plan.active,
      resultingDefaultIncoming: plan.defaultIncoming,
      guard,
      needsStepUp: plan.toggles || guard.blocked,
      confirmWithinSeconds: WINDOW_SECONDS,
    };
  }

  apply(request: FirewallChangeRequest, caller: FakeFirewallCaller): FirewallChangeSetInfo {
    this.settle();
    const waiting = this.pending;
    if (waiting) {
      throw new Error(
        `Another firewall change is waiting for its confirmation ("${waiting.summary}"). Confirm or revert it first.`,
      );
    }
    const plan = this.plan(request.changes);
    const guard = this.guard(plan);
    if (guard.blocked) {
      const typed = request.overrideConfirmation?.trim();
      if (!typed) {
        throw new Error(
          `This change would cut this computer off from SSH. ${guard.reasons.join(' ')} To apply it anyway, type "${FAKE_GUARD_PHRASE}".`,
        );
      }
      if (typed.toLowerCase() !== FAKE_GUARD_PHRASE) {
        throw new Error(
          `That is not the phrase. To apply this change anyway, type "${FAKE_GUARD_PHRASE}".`,
        );
      }
      if (!caller.steppedUp) {
        throw new Error(
          'Applying a change the SSH check refused needs your password again (a step-up).',
        );
      }
    }
    if (plan.toggles && !caller.steppedUp) {
      throw new Error(
        `Turning the firewall ${plan.active ? 'on' : 'off'} needs your password again (a step-up).`,
      );
    }
    if (plan.commands.length === 0) throw new Error('Nothing would change.');
    this.setCount += 1;
    const id = `00000000-0000-4000-9000-${String(this.setCount).padStart(12, '0')}`;
    this.snapshots.set(id, this.snapshot());
    this.appliedOver.set(id, caller.connection);
    this.active = plan.active;
    this.defaultIncoming = plan.defaultIncoming;
    this.rules = plan.rules;
    const change: FirewallChangeSetInfo = {
      id,
      state: 'awaitingConfirmation',
      backend: 'ufw',
      summary: plan.summary,
      commands: plan.commands,
      createdAtUnixMs: this.now(),
      guardOverridden: guard.blocked,
      deadlineUnixMs: this.now() + WINDOW_SECONDS * 1_000,
      requestedBy: 'maria',
      ...(request.sshConnection ? { appliedFrom: request.sshConnection.split(' ')[0] } : {}),
    };
    this.changeSets.push(change);
    return { ...change };
  }

  confirm(id: string, caller: FakeFirewallCaller): FirewallChangeSetInfo {
    const change = this.find(id);
    if (change.state === 'awaitingConfirmation' && (change.deadlineUnixMs ?? 0) <= this.now()) {
      this.rollBack(change, 'timer');
      throw new Error(
        `Too late: the rollback timer put the old rules back before this confirmation arrived. Make the change again and confirm it within ${WINDOW_SECONDS} seconds.`,
      );
    }
    if (change.state === 'confirmed') return { ...change };
    if (change.state !== 'awaitingConfirmation') {
      throw new Error(`This change ${words(change)}, so there is nothing to confirm.`);
    }
    if (this.appliedOver.get(id) === caller.connection) {
      throw new Error(
        'This confirmation came over the same SSH connection that made the change, and a firewall change never cuts a connection that is already open. Confirm over a new SSH connection: that shows a new one still gets in.',
      );
    }
    return this.finish(change, { state: 'confirmed' });
  }

  revert(id: string): FirewallChangeSetInfo {
    this.settle();
    const change = this.find(id);
    if (change.state === 'rolledBack') return { ...change };
    if (change.state !== 'awaitingConfirmation') {
      throw new Error(
        `Only a change waiting for its confirmation can be reverted; this one ${words(change)}.`,
      );
    }
    return this.rollBack(change, 'user');
  }

  /** What the systemd timer does: every change past its deadline goes back. */
  settle(): void {
    const pending = this.pending;
    if (pending && (pending.deadlineUnixMs ?? 0) <= this.now()) this.rollBack(pending, 'timer');
  }

  private rollBack(change: FirewallChangeSetInfo, cause: 'timer' | 'user'): FirewallChangeSetInfo {
    const before = this.snapshots.get(change.id);
    if (before) {
      this.active = before.active;
      this.defaultIncoming = before.defaultIncoming;
      this.rules = before.rules;
    }
    const done = this.finish(change, { state: 'rolledBack', rolledBackBy: cause });
    if (cause === 'timer') this.rolledBack(done);
    return done;
  }

  private finish(
    change: FirewallChangeSetInfo,
    fields: Partial<FirewallChangeSetInfo>,
  ): FirewallChangeSetInfo {
    Object.assign(change, fields, { finishedAtUnixMs: this.now() });
    return { ...change };
  }

  private find(id: string): FirewallChangeSetInfo {
    const change = this.changeSets.find((candidate) => candidate.id === id);
    if (!change) throw new Error('There is no such firewall change.');
    return change;
  }

  private snapshot(): Snapshot {
    return {
      active: this.active,
      defaultIncoming: this.defaultIncoming,
      rules: this.rules.map((rule) => ({ ...rule })),
    };
  }

  private add(spec: FirewallRuleSpec): FirewallRuleInfo {
    this.ruleCount += 1;
    const rule: FirewallRuleInfo = {
      ...spec,
      id: `r${this.ruleCount}`,
      families: 'both',
      description: describe(spec),
      editable: true,
      outgoing: false,
    };
    this.rules.push(rule);
    return rule;
  }

  private plan(changes: FirewallChange[]): Plan {
    const plan: Plan = { ...this.snapshot(), commands: [], summary: '', toggles: false };
    const said: string[] = [];
    for (const change of changes) {
      if (change.kind === 'addRule' && change.rule) {
        this.ruleCount += 1;
        plan.rules.push({
          ...change.rule,
          id: `r${this.ruleCount}`,
          families: 'both',
          description: describe(change.rule),
          editable: true,
          outgoing: false,
        });
        plan.commands.push(ufwSpec(change.rule));
        said.push(`add ${describe(change.rule)}`);
      } else if (change.kind === 'removeRule') {
        const rule = plan.rules.find((candidate) => candidate.id === change.ruleId);
        if (!rule) throw new Error('That rule is no longer there. Read the rules again.');
        plan.rules = plan.rules.filter((candidate) => candidate !== rule);
        plan.commands.push(
          ufwSpec(rule)
            .replace(/^ufw /, 'ufw delete ')
            .replace(/ comment .*$/, ''),
        );
        said.push(`remove ${rule.description}`);
      } else if (change.kind === 'setDefaultIncoming' && change.policy) {
        plan.defaultIncoming = change.policy;
        plan.commands.push(`ufw default ${change.policy} incoming`);
        said.push(`incoming ${change.policy} by default`);
      } else if (change.kind === 'enable' || change.kind === 'disable') {
        const on = change.kind === 'enable';
        if (plan.active !== on) {
          plan.active = on;
          plan.toggles = true;
          plan.commands.push(on ? 'ufw --force enable' : 'ufw disable');
          said.push(on ? 'turn the firewall on' : 'turn the firewall off');
        }
      }
    }
    plan.summary = said.join(', ');
    return plan;
  }

  private guard(plan: Plan): FirewallGuardVerdict {
    const checked = [`SSH on port ${FAKE_SSH_PORT}`];
    if (allowsSsh(plan)) return { blocked: false, reasons: [], checked };
    return {
      blocked: true,
      reasons: [`Nothing would let new connections reach SSH on port ${FAKE_SSH_PORT}.`],
      checked,
      confirmationPhrase: FAKE_GUARD_PHRASE,
    };
  }
}

function words(change: FirewallChangeSetInfo): string {
  if (change.state === 'confirmed') return 'was already kept';
  if (change.state === 'rolledBack') return 'was already rolled back';
  return 'failed';
}
