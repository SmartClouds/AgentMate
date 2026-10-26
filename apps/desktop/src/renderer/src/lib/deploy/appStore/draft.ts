import {
  type AnyCatalogTemplate,
  type CatalogRender,
  type CatalogSecretSpec,
  checkCatalogSecret,
  generateCatalogSecret,
  generateCatalogSecrets,
  renderCatalogApp,
  validateDomain,
  validateStackName,
} from '@runova/core';
import type { DeployAppParamValue } from '@shared/deployAppStoreTypes';
import { suggestStoreAppName } from './format';

/**
 * The install sheet as it is being filled in: text for every typed field (so a half-typed number
 * stays as typed), the generated passwords, and whether the app goes on a domain. `checkDraft`
 * turns it into what the install sends, with every problem keyed by its field; the main process
 * renders the files again from the same choices.
 */

export interface InstallDraft {
  version: string;
  name: string;
  values: Record<string, string | boolean>;
  secrets: Record<string, string>;
  expose: boolean;
  domain: string;
  /** Ask Let's Encrypt for a certificate once the site is live (its terms accepted). */
  certificate: boolean;
}

export function initialDraft(template: AnyCatalogTemplate, taken: readonly string[]): InstallDraft {
  const defaults = template.parameters.parse({}) as Record<string, unknown>;
  const values: Record<string, string | boolean> = {};
  for (const [key, field] of Object.entries(template.fields)) {
    const value = defaults[key];
    values[key] =
      field.input === 'toggle' ? value === true : value === undefined ? '' : String(value);
  }
  return {
    version: template.defaultVersion,
    name: suggestStoreAppName(template, taken),
    values,
    secrets: generateCatalogSecrets(template.secrets),
    expose: false,
    domain: '',
    certificate: true,
  };
}

/** The draft's values as parameters: numbers for number and port fields, blanks left out. */
export function paramsFromDraft(
  template: AnyCatalogTemplate,
  values: InstallDraft['values'],
): Record<string, DeployAppParamValue> {
  const out: Record<string, DeployAppParamValue> = {};
  for (const [key, field] of Object.entries(template.fields)) {
    const value = values[key];
    if (typeof value === 'boolean') {
      out[key] = value;
    } else if (typeof value === 'string' && value.trim() !== '') {
      const text = value.trim();
      out[key] =
        (field.input === 'number' || field.input === 'port') && /^-?\d+(\.\d+)?$/.test(text)
          ? Number(text)
          : text;
    }
  }
  return out;
}

/** The secrets the template uses with these parameters. */
export function secretsInUse(
  template: AnyCatalogTemplate,
  params: Record<string, unknown>,
): CatalogSecretSpec[] {
  const parsed = template.parameters.safeParse(params);
  const checked = parsed.success ? parsed.data : template.parameters.parse({});
  return template.secrets.filter((spec) => template.secretInUse?.(spec.key, checked) ?? true);
}

/** Where the proxy points when the version goes on a domain, from a render with its defaults. */
export function webOf(
  template: AnyCatalogTemplate,
  version: string,
): { service: string; port: number; published: number } | null {
  const result = renderCatalogApp(template, {
    version,
    secrets: generateCatalogSecrets(template.secrets),
  });
  if (!result.ok || !result.render.web) return null;
  const { web, ports } = result.render;
  const port = ports.find((item) => item.service === web.service && item.target === web.port);
  return port ? { ...web, published: port.published } : null;
}

export function regenerate(spec: CatalogSecretSpec): string {
  return generateCatalogSecret(spec);
}

export interface DraftCheck {
  problems: Record<string, string>;
  params: Record<string, DeployAppParamValue>;
  /** The secrets the install sends: only the ones in use. */
  secrets: Record<string, string>;
  domain: string | null;
  render: CatalogRender | null;
}

export function checkDraft(
  template: AnyCatalogTemplate,
  draft: InstallDraft,
  taken: readonly string[],
): DraftCheck {
  const problems: Record<string, string> = {};
  const params = paramsFromDraft(template, draft.values);

  const name = validateStackName(draft.name);
  if (!name.ok) problems.name = name.reason;
  else if (taken.includes(name.value)) {
    problems.name = `An app called ${name.value} is already on this server.`;
  }

  const parsed = template.parameters.safeParse(params);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const field = String(issue.path[0] ?? 'general');
      problems[field] ??= issue.message;
    }
  }

  const secrets: Record<string, string> = {};
  for (const spec of secretsInUse(template, params)) {
    const value = draft.secrets[spec.key] ?? '';
    const problem = checkCatalogSecret(spec, value);
    if (problem) problems[spec.key] = problem;
    secrets[spec.key] = value;
  }

  let domain: string | null = null;
  if (draft.expose) {
    const checked = validateDomain(draft.domain.trim());
    if (!checked.ok) problems.domain = checked.reason;
    else domain = checked.value;
  }

  let render: CatalogRender | null = null;
  if (Object.keys(problems).length === 0) {
    const result = renderCatalogApp(template, { version: draft.version, params, secrets, domain });
    if (result.ok) render = result.render;
    else problems[result.field ?? 'general'] = result.reason;
  }
  return { problems, params, secrets, domain, render };
}
