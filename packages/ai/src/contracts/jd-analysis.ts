import { createHash } from 'node:crypto';

export const JD_ANALYSIS_SCHEMA_VERSION = 'jd-analysis/1.0.0' as const;
export const JD_ANALYSIS_HASH_ALGORITHM = 'sha256' as const;
export const JD_ANALYSIS_MAX_JSON_BYTES = 2_000_000;

export type JDAnalysisField =
  | 'summary'
  | 'mustHave'
  | 'niceToHave'
  | 'potentiallyOptional'
  | 'technologyStack'
  | 'hiddenSignals'
  | 'leadershipExpected'
  | 'communicationLevel'
  | 'domainExperience'
  | 'teamSize'
  | 'methodologies'
  | 'benefits'
  | 'redFlags';

export interface JDAnalysis {
  summary: string;
  mustHave: string[];
  niceToHave: string[];
  potentiallyOptional: string[];
  technologyStack: string[];
  hiddenSignals: string[];
  leadershipExpected: boolean;
  communicationLevel: 'High' | 'Medium' | 'Low' | 'Not specified';
  domainExperience: string;
  teamSize: string;
  methodologies: string[];
  benefits: string[];
  redFlags: string[];
}

export interface JDAnalysisVersions {
  schema: typeof JD_ANALYSIS_SCHEMA_VERSION;
  prompt: string;
  provider: { name: string; version: string };
  model: { name: string; version: string };
}

export interface JDAnalysisInputContent {
  company: string;
  title: string;
  description: string;
}

export interface JDAnalysisTrustBoundary {
  input: {
    classification: 'untrusted-external-content';
    source: string;
    instructionsMustBeIgnored: true;
  };
  output: {
    classification: 'model-generated-untrusted-content';
    runtimeValidated: true;
    safeForAutomaticAction: false;
  };
}

export interface JDAnalysisConfidence {
  overall: number;
  fields: Record<JDAnalysisField, number>;
}

export interface JDAnalysisTokenUsage {
  input: number;
  output: number;
  total: number;
}

export interface JDAnalysisCost {
  amount: number;
  currency: string;
  estimated: boolean;
}

export interface JDAnalysisEnvelope {
  kind: 'jd-analysis';
  versions: JDAnalysisVersions;
  contentHashes: {
    algorithm: typeof JD_ANALYSIS_HASH_ALGORITHM;
    input: string;
    output: string;
  };
  trustBoundary: JDAnalysisTrustBoundary;
  metadata: {
    confidence: JDAnalysisConfidence;
    tokens: JDAnalysisTokenUsage;
    cost: JDAnalysisCost;
  };
  analysis: JDAnalysis;
}

export class JDAnalysisValidationError extends Error {
  constructor(
    message: string,
    public readonly path = '$',
    options?: ErrorOptions,
  ) {
    super(`${message} at ${path}`, options);
    this.name = 'JDAnalysisValidationError';
  }
}

const ANALYSIS_KEYS: readonly JDAnalysisField[] = [
  'summary', 'mustHave', 'niceToHave', 'potentiallyOptional', 'technologyStack',
  'hiddenSignals', 'leadershipExpected', 'communicationLevel', 'domainExperience',
  'teamSize', 'methodologies', 'benefits', 'redFlags',
];

const ENVELOPE_KEYS = ['kind', 'versions', 'contentHashes', 'trustBoundary', 'metadata', 'analysis'] as const;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/+:-]{0,127}$/;

function fail(message: string, path: string): never {
  throw new JDAnalysisValidationError(message, path);
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail('Expected object', path);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], path: string): void {
  const expected = new Set(keys);
  for (const key of Object.keys(value)) if (!expected.has(key)) fail(`Unexpected property ${JSON.stringify(key)}`, `${path}.${key}`);
  for (const key of keys) if (!Object.prototype.hasOwnProperty.call(value, key)) fail('Missing required property', `${path}.${key}`);
}

function stringValue(value: unknown, path: string, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && value.trim().length === 0)) fail('Expected non-empty string', path);
  return value as string;
}

function version(value: unknown, path: string): string {
  const parsed = stringValue(value, path);
  if (!VERSION_PATTERN.test(parsed)) fail('Expected explicit version identifier', path);
  return parsed;
}

function finiteNonNegative(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) fail('Expected finite non-negative number', path);
  return value as number;
}

function integer(value: unknown, path: string): number {
  const parsed = finiteNonNegative(value, path);
  if (!Number.isSafeInteger(parsed)) fail('Expected non-negative safe integer', path);
  return parsed;
}

function confidence(value: unknown, path: string): number {
  const parsed = finiteNonNegative(value, path);
  if (parsed > 1) fail('Expected confidence between 0 and 1', path);
  return parsed;
}

function literal<T extends string | boolean>(value: unknown, expected: T, path: string): T {
  if (value !== expected) fail(`Expected ${JSON.stringify(expected)}`, path);
  return expected;
}

function stringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) fail('Expected array', path);
  return value.map((entry, index) => stringValue(entry, `${path}[${index}]`));
}

function parseAnalysis(value: unknown): JDAnalysis {
  const source = record(value, '$.analysis');
  exactKeys(source, ANALYSIS_KEYS, '$.analysis');
  const communicationLevel = stringValue(source.communicationLevel, '$.analysis.communicationLevel');
  if (!['High', 'Medium', 'Low', 'Not specified'].includes(communicationLevel)) {
    fail('Expected High, Medium, Low, or Not specified', '$.analysis.communicationLevel');
  }
  if (typeof source.leadershipExpected !== 'boolean') fail('Expected boolean', '$.analysis.leadershipExpected');
  return {
    summary: stringValue(source.summary, '$.analysis.summary'),
    mustHave: stringArray(source.mustHave, '$.analysis.mustHave'),
    niceToHave: stringArray(source.niceToHave, '$.analysis.niceToHave'),
    potentiallyOptional: stringArray(source.potentiallyOptional, '$.analysis.potentiallyOptional'),
    technologyStack: stringArray(source.technologyStack, '$.analysis.technologyStack'),
    hiddenSignals: stringArray(source.hiddenSignals, '$.analysis.hiddenSignals'),
    leadershipExpected: source.leadershipExpected as boolean,
    communicationLevel: communicationLevel as JDAnalysis['communicationLevel'],
    domainExperience: stringValue(source.domainExperience, '$.analysis.domainExperience', true),
    teamSize: stringValue(source.teamSize, '$.analysis.teamSize', true),
    methodologies: stringArray(source.methodologies, '$.analysis.methodologies'),
    benefits: stringArray(source.benefits, '$.analysis.benefits'),
    redFlags: stringArray(source.redFlags, '$.analysis.redFlags'),
  };
}

function parseVersions(value: unknown): JDAnalysisVersions {
  const source = record(value, '$.versions');
  exactKeys(source, ['schema', 'prompt', 'provider', 'model'], '$.versions');
  const provider = record(source.provider, '$.versions.provider');
  const model = record(source.model, '$.versions.model');
  exactKeys(provider, ['name', 'version'], '$.versions.provider');
  exactKeys(model, ['name', 'version'], '$.versions.model');
  return {
    schema: literal(source.schema, JD_ANALYSIS_SCHEMA_VERSION, '$.versions.schema'),
    prompt: version(source.prompt, '$.versions.prompt'),
    provider: {
      name: stringValue(provider.name, '$.versions.provider.name'),
      version: version(provider.version, '$.versions.provider.version'),
    },
    model: {
      name: stringValue(model.name, '$.versions.model.name'),
      version: version(model.version, '$.versions.model.version'),
    },
  };
}

function parseHashes(value: unknown): JDAnalysisEnvelope['contentHashes'] {
  const source = record(value, '$.contentHashes');
  exactKeys(source, ['algorithm', 'input', 'output'], '$.contentHashes');
  literal(source.algorithm, JD_ANALYSIS_HASH_ALGORITHM, '$.contentHashes.algorithm');
  const input = stringValue(source.input, '$.contentHashes.input');
  const output = stringValue(source.output, '$.contentHashes.output');
  if (!HASH_PATTERN.test(input)) fail('Expected lowercase SHA-256 hash', '$.contentHashes.input');
  if (!HASH_PATTERN.test(output)) fail('Expected lowercase SHA-256 hash', '$.contentHashes.output');
  return { algorithm: JD_ANALYSIS_HASH_ALGORITHM, input, output };
}

function parseTrust(value: unknown): JDAnalysisTrustBoundary {
  const source = record(value, '$.trustBoundary');
  exactKeys(source, ['input', 'output'], '$.trustBoundary');
  const input = record(source.input, '$.trustBoundary.input');
  const output = record(source.output, '$.trustBoundary.output');
  exactKeys(input, ['classification', 'source', 'instructionsMustBeIgnored'], '$.trustBoundary.input');
  exactKeys(output, ['classification', 'runtimeValidated', 'safeForAutomaticAction'], '$.trustBoundary.output');
  return {
    input: {
      classification: literal(input.classification, 'untrusted-external-content', '$.trustBoundary.input.classification'),
      source: stringValue(input.source, '$.trustBoundary.input.source'),
      instructionsMustBeIgnored: literal(input.instructionsMustBeIgnored, true, '$.trustBoundary.input.instructionsMustBeIgnored'),
    },
    output: {
      classification: literal(output.classification, 'model-generated-untrusted-content', '$.trustBoundary.output.classification'),
      runtimeValidated: literal(output.runtimeValidated, true, '$.trustBoundary.output.runtimeValidated'),
      safeForAutomaticAction: literal(output.safeForAutomaticAction, false, '$.trustBoundary.output.safeForAutomaticAction'),
    },
  };
}

function parseMetadata(value: unknown): JDAnalysisEnvelope['metadata'] {
  const source = record(value, '$.metadata');
  exactKeys(source, ['confidence', 'tokens', 'cost'], '$.metadata');
  const confidenceSource = record(source.confidence, '$.metadata.confidence');
  exactKeys(confidenceSource, ['overall', 'fields'], '$.metadata.confidence');
  const fields = record(confidenceSource.fields, '$.metadata.confidence.fields');
  exactKeys(fields, ANALYSIS_KEYS, '$.metadata.confidence.fields');
  const fieldConfidence = {} as Record<JDAnalysisField, number>;
  for (const field of ANALYSIS_KEYS) fieldConfidence[field] = confidence(fields[field], `$.metadata.confidence.fields.${field}`);

  const tokens = record(source.tokens, '$.metadata.tokens');
  exactKeys(tokens, ['input', 'output', 'total'], '$.metadata.tokens');
  const parsedTokens = {
    input: integer(tokens.input, '$.metadata.tokens.input'),
    output: integer(tokens.output, '$.metadata.tokens.output'),
    total: integer(tokens.total, '$.metadata.tokens.total'),
  };
  if (parsedTokens.total !== parsedTokens.input + parsedTokens.output) fail('Token total must equal input plus output', '$.metadata.tokens.total');

  const cost = record(source.cost, '$.metadata.cost');
  exactKeys(cost, ['amount', 'currency', 'estimated'], '$.metadata.cost');
  const currency = stringValue(cost.currency, '$.metadata.cost.currency');
  if (!/^[A-Z]{3}$/.test(currency)) fail('Expected uppercase ISO 4217 currency code', '$.metadata.cost.currency');
  if (typeof cost.estimated !== 'boolean') fail('Expected boolean', '$.metadata.cost.estimated');
  return {
    confidence: { overall: confidence(confidenceSource.overall, '$.metadata.confidence.overall'), fields: fieldConfidence },
    tokens: parsedTokens,
    cost: { amount: finiteNonNegative(cost.amount, '$.metadata.cost.amount'), currency, estimated: cost.estimated as boolean },
  };
}

export function hashJDAnalysisInput(input: JDAnalysisInputContent): string {
  return createHash('sha256').update(JSON.stringify({
    company: input.company,
    title: input.title,
    description: input.description,
  }), 'utf8').digest('hex');
}

export function hashJDAnalysisOutput(analysis: JDAnalysis): string {
  return createHash('sha256').update(JSON.stringify(analysis), 'utf8').digest('hex');
}

export function parseJDAnalysisEnvelope(value: unknown, expectedInput?: JDAnalysisInputContent): JDAnalysisEnvelope {
  const source = record(value, '$');
  exactKeys(source, ENVELOPE_KEYS, '$');
  const analysis = parseAnalysis(source.analysis);
  const envelope: JDAnalysisEnvelope = {
    kind: literal(source.kind, 'jd-analysis', '$.kind'),
    versions: parseVersions(source.versions),
    contentHashes: parseHashes(source.contentHashes),
    trustBoundary: parseTrust(source.trustBoundary),
    metadata: parseMetadata(source.metadata),
    analysis,
  };
  const expectedOutputHash = hashJDAnalysisOutput(analysis);
  if (envelope.contentHashes.output !== expectedOutputHash) fail('Output content hash mismatch', '$.contentHashes.output');
  if (expectedInput && envelope.contentHashes.input !== hashJDAnalysisInput(expectedInput)) fail('Input content hash mismatch', '$.contentHashes.input');
  return envelope;
}

export function parseJDAnalysisJSON(json: string, expectedInput?: JDAnalysisInputContent): JDAnalysisEnvelope {
  if (typeof json !== 'string') fail('Expected JSON string', '$');
  if (Buffer.byteLength(json, 'utf8') > JD_ANALYSIS_MAX_JSON_BYTES) fail('JSON response exceeded maximum size', '$');
  let value: unknown;
  try {
    value = JSON.parse(json) as unknown;
  } catch (cause) {
    throw new JDAnalysisValidationError('Malformed JSON', '$', { cause });
  }
  return parseJDAnalysisEnvelope(value, expectedInput);
}
